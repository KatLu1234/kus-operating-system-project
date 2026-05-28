const { app, BrowserWindow, ipcMain, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const pidusage = require('pidusage');
const pidtree = require('pidtree');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const COOMD_DIR    = path.join(PROJECT_ROOT, 'coomd');
const COOMD_BIN    = path.join(COOMD_DIR, 'bin', 'coomd');

// Assumes the Electron app is launched from inside WSL (Linux), where
// make / qemu-system-riscv64 / riscv toolchain are installed.
const BOOT_CMD = 'make clean && make qemu';

// coomd flags. Dry-run is safer for demo since the daemon would otherwise
// send real SIGTERMs to whatever pidlist it computed.
const COOMD_ARGS = ['--dry-run', '--threshold', '15'];

// LLM (Upstage Solar) configuration. Loaded from coomd/.env (or process env).
loadDotEnv(path.join(PROJECT_ROOT, 'coomd', '.env'));
loadDotEnv(path.join(PROJECT_ROOT, '.env'));
const LLM_BASE_URL = process.env.UPSTAGE_BASE_URL || 'https://api.upstage.ai/v1';
const LLM_MODEL    = process.env.LLM_MODEL || process.env.UPSTAGE_MODEL || 'solar-pro2';

let mainWin = null;
let qemu = null;
let coomd = null;
let coomdLineBuf = '';
let metricsTimer = null;
let startedAt = null;

// Rolling tail of qemu's combined output, used as LLM context.
const TAIL_MAX = 16384;
let consoleTail = '';

function appendTail(s) {
  consoleTail += s;
  if (consoleTail.length > TAIL_MAX) consoleTail = consoleTail.slice(-TAIL_MAX);
}

function loadDotEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch (_) { /* missing file is fine */ }
}

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, payload);
  }
}

async function sampleMetrics(rootPid) {
  let pids = [rootPid];
  try {
    const kids = await pidtree(rootPid);
    if (kids && kids.length) pids = [rootPid, ...kids];
  } catch (_) {}
  try {
    const stats = await pidusage(pids);
    let cpu = 0;
    let mem = 0;
    let alive = 0;
    for (const k of Object.keys(stats)) {
      const s = stats[k];
      if (!s) continue;
      cpu += s.cpu || 0;
      mem += s.memory || 0;
      alive++;
    }
    return { cpu, memory: mem, alive };
  } catch (_) {
    return null;
  }
}

function startQemu() {
  if (qemu) return;
  startedAt = Date.now();

  qemu = spawn(BOOT_CMD, {
    cwd: PROJECT_ROOT,
    shell: '/bin/bash',
    // Become a process-group leader so we can signal the whole tree (make -> qemu).
    detached: true,
  });

  send('qemu:start', {
    pid: qemu.pid,
    cwd: PROJECT_ROOT,
    cmd: BOOT_CMD,
    startedAt,
  });

  qemu.stdout.on('data', (b) => {
    const s = b.toString('utf8');
    appendTail(s);
    send('qemu:stdout', s);
  });
  qemu.stderr.on('data', (b) => {
    const s = b.toString('utf8');
    appendTail(s);
    send('qemu:stderr', s);
  });

  qemu.on('exit', (code, signal) => {
    send('qemu:exit', { code, signal });
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    qemu = null;
  });

  qemu.on('error', (err) => {
    send('qemu:stderr', `\n[spawn error] ${err.message}\n`);
  });

  metricsTimer = setInterval(async () => {
    if (!qemu) return;
    const m = await sampleMetrics(qemu.pid);
    if (m) send('qemu:metrics', { ...m, timestamp: Date.now() });
  }, 1000);
}

function stopQemu() {
  if (!qemu) return;
  const pid = qemu.pid;
  const killGroup = (sig) => {
    try { process.kill(-pid, sig); } catch (_) {
      try { process.kill(pid, sig); } catch (_) {}
    }
  };
  killGroup('SIGTERM');
  setTimeout(() => { if (qemu && qemu.pid === pid) killGroup('SIGKILL'); }, 2000);
}

function writeStdin(text) {
  if (!qemu || !qemu.stdin || qemu.stdin.destroyed) return false;
  try { qemu.stdin.write(text); return true; } catch (_) { return false; }
}

// ─────────────────────────────────────────────────────────────
// coomd — conversational OOM killer daemon
//   - build with `make` in coomd/
//   - spawn ./bin/coomd --dry-run --threshold 15
//   - parse `EVENT {json}` lines into oom:event / oom:pressure
//   - other stdout/stderr is forwarded as coomd:stdout / coomd:stderr
// ─────────────────────────────────────────────────────────────

function buildCoomd() {
  return new Promise((resolve) => {
    const p = spawn('make', [], { cwd: COOMD_DIR, shell: '/bin/bash' });
    p.stdout.on('data', (b) => send('coomd:stdout', b.toString('utf8')));
    p.stderr.on('data', (b) => send('coomd:stderr', b.toString('utf8')));
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', (err) => {
      send('coomd:stderr', `[make error] ${err.message}\n`);
      resolve(false);
    });
  });
}

function handleCoomdLine(line) {
  if (line.startsWith('EVENT ')) {
    const raw = line.slice(6).trim();
    try {
      const ev = JSON.parse(raw);
      if (ev.kind === 'pressure') {
        send('oom:pressure', {
          some: { avg10: ev.some_avg10, avg60: ev.some_avg60 },
          full: { avg10: ev.full_avg10 },
          threshold: ev.threshold,
          pressured: ev.pressured,
        });
      } else {
        send('oom:event', { ...ev, timestamp: Date.now() });
      }
      return;
    } catch (e) {
      send('coomd:stderr', `[bad EVENT json] ${raw}\n`);
    }
  }
  if (line.length) send('coomd:stdout', line + '\n');
}

function onCoomdData(chunk) {
  coomdLineBuf += chunk;
  let nl;
  while ((nl = coomdLineBuf.indexOf('\n')) >= 0) {
    const line = coomdLineBuf.slice(0, nl);
    coomdLineBuf = coomdLineBuf.slice(nl + 1);
    handleCoomdLine(line);
  }
}

async function startCoomd() {
  if (coomd) return;
  send('coomd:status', { state: 'building' });
  const built = await buildCoomd();
  if (!built) { send('coomd:status', { state: 'build-failed' }); return; }
  if (!fs.existsSync(COOMD_BIN)) {
    send('coomd:status', { state: 'missing-binary', bin: COOMD_BIN });
    return;
  }

  coomdLineBuf = '';
  coomd = spawn(COOMD_BIN, COOMD_ARGS, {
    cwd: COOMD_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  send('coomd:status', { state: 'running', pid: coomd.pid, args: COOMD_ARGS });

  coomd.stdout.on('data', (b) => onCoomdData(b.toString('utf8')));
  coomd.stderr.on('data', (b) => send('coomd:stderr', b.toString('utf8')));
  coomd.on('exit', (code, signal) => {
    send('coomd:status', { state: 'exited', code, signal });
    coomd = null;
  });
  coomd.on('error', (err) => send('coomd:stderr', `[spawn error] ${err.message}\n`));
}

function stopCoomd() {
  if (!coomd) return;
  const pid = coomd.pid;
  const killGroup = (sig) => {
    try { process.kill(-pid, sig); } catch (_) {
      try { process.kill(pid, sig); } catch (_) {}
    }
  };
  killGroup('SIGTERM');
  setTimeout(() => { if (coomd && coomd.pid === pid) killGroup('SIGKILL'); }, 2000);
}

// ─────────────────────────────────────────────────────────────
// LLM (Upstage Solar) — streaming chat completions over fetch SSE
// ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return [
    'You are an assistant embedded in an interface for the xv6-riscv teaching operating system.',
    'xv6 is currently running inside QEMU. The user sees the same console you see below.',
    'Be concise. When you suggest a shell command to run inside xv6, put each command on its own line prefixed with "$ " so the UI can render a "run" chip for it.',
    'Do not invent commands xv6 does not support. xv6 has a small busybox-like shell (ls, cat, echo, mkdir, rm, wc, grep, ln, sh, kill, usertests, etc.).',
    '',
    '=== Recent xv6 console output (most recent tail) ===',
    consoleTail || '(no output yet)',
    '=== End of console output ===',
  ].join('\n');
}

async function streamChat(messages, sender) {
  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    sender.send('llm:error', { message: 'UPSTAGE_API_KEY is not set. Put it in coomd/.env or export it before launching.' });
    return;
  }

  const body = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
    stream: true,
    temperature: 0.3,
  };

  let resp;
  try {
    resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    sender.send('llm:error', { message: `network: ${e.message}` });
    return;
  }

  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => '');
    sender.send('llm:error', { message: `Solar ${resp.status}: ${t.slice(0, 240)}` });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { sender.send('llm:done', {}); return; }
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) sender.send('llm:chunk', delta);
        } catch (_) { /* ignore malformed SSE line */ }
      }
    }
    sender.send('llm:done', {});
  } catch (e) {
    sender.send('llm:error', { message: `stream: ${e.message}` });
  }
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────

ipcMain.handle('qemu:restart', () => {
  stopCoomd();
  stopQemu();
  setTimeout(() => { startQemu(); startCoomd(); }, 500);
});
ipcMain.handle('qemu:stop',    () => { stopCoomd(); stopQemu(); });
ipcMain.handle('coomd:restart', () => { stopCoomd(); setTimeout(startCoomd, 500); });
ipcMain.handle('coomd:stop',    () => stopCoomd());
ipcMain.handle('xv6:stdin',    (_e, text) => writeStdin(text));
ipcMain.handle('llm:chat',     (e, { messages }) => streamChat(messages || [], e.sender));
ipcMain.handle('llm:status',   () => ({
  ready: !!process.env.UPSTAGE_API_KEY && process.env.UPSTAGE_API_KEY !== 'your_api_key_here',
  model: LLM_MODEL,
  baseUrl: LLM_BASE_URL,
}));

// ─────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────

function createWindow() {
  mainWin = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  mainWin.setMenuBarVisibility(false);

  mainWin.once('ready-to-show', () => {
    mainWin.setFullScreen(true);
    mainWin.show();
    mainWin.focus();
    startQemu();
    startCoomd();
  });

  mainWin.on('closed', () => {
    stopCoomd();
    stopQemu();
    mainWin = null;
  });

  mainWin.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('Escape', () => app.quit());
  globalShortcut.register('CommandOrControl+Q', () => app.quit());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopCoomd();
  stopQemu();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopCoomd();
  stopQemu();
});
