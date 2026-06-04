const { app, BrowserWindow, ipcMain, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const pidusage = require('pidusage');
const pidtree = require('pidtree');

const PROJECT_ROOT = path.resolve(__dirname, '..');
// xv6 now lives in its own subdirectory (a fresh xv6-riscv checkout). `make
// qemu` must run there. Fall back to PROJECT_ROOT if that dir is absent.
const XV6_DIR      = fs.existsSync(path.join(PROJECT_ROOT, 'xv6-riscv', 'Makefile'))
  ? path.join(PROJECT_ROOT, 'xv6-riscv')
  : PROJECT_ROOT;
const COOMD_DIR    = path.join(PROJECT_ROOT, 'coomd');
const COOMD_BIN    = path.join(COOMD_DIR, 'bin', 'coomd');
// Bridge file: the interface writes the live xv6 state here (parsed from
// statd's @@STAT stream) so the coomd Linux daemon reflects REAL xv6
// processes + PSI instead of its old hard-coded chrome/firefox mock.
const COOMD_STATE_FILE = path.join(COOMD_DIR, '.xv6_state');

// Python LLM helper (R3). The interface runs this per OOM decision via a
// fork-exec-pipe, exactly like the coomd C daemon does, so the interface is
// the single orchestrator of both xv6 and the Python side.
const HELPER_PY    = path.join(COOMD_DIR, 'LLM_client', 'helper.py');
// Candidate interpreters, in priority order. A project venv wins if present.
const PYTHON_VENVS = [
  path.join(COOMD_DIR, '.venv', 'bin', 'python3'),
  path.join(PROJECT_ROOT, '.venv', 'bin', 'python3'),
];
const PYTHON_FALLBACKS = ['python3', 'python'];

// Natural-language policy handed to the Python helper for OOM decisions.
const OOM_POLICY = process.env.OOM_POLICY ||
  'Keep init, the shell (sh) and oomd alive. Memory hogs such as memhog are ' +
  'fine to kill to relieve pressure.';

// Operator-provided server purpose, captured by the commissioning popup at
// startup and folded into every LLM OOM decision (both engines). Empty until set.
let serverPurpose = process.env.SERVER_PURPOSE || '';

// The effective policy text: base policy + the operator's stated server purpose.
function policyWithPurpose() {
  return serverPurpose
    ? `${OOM_POLICY}\nThe operator described this server's purpose as: "${serverPurpose}". ` +
      'Honor that purpose: protect processes essential to it and prefer killing ones that are not.'
    : OOM_POLICY;
}

// OOM decision engine: 'python' (helper.py) → fall back to 'llm' (JS fetch) →
// heuristic. 'llm' skips Python; 'auto' is an alias for 'python'.
let oomEngine = (process.env.OOM_ENGINE || 'python').toLowerCase();

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

// xv6 kernel-monitor (statd) line buffering + CPU% delta state.
let qemuLineBuf = '';
let prevStat = null;          // previous @@STAT sample, for CPU% deltas
let oomBusy = false;          // guard so we answer one @@OOM_REQ at a time
let pythonCmd = null;         // resolved interpreter path (or null if missing)

const PG_KB = 4;              // xv6 page = 4 KiB

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
    cwd: XV6_DIR,
    shell: '/bin/bash',
    // Become a process-group leader so we can signal the whole tree (make -> qemu).
    detached: true,
  });

  send('qemu:start', {
    pid: qemu.pid,
    cwd: XV6_DIR,
    cmd: BOOT_CMD,
    startedAt,
  });

  qemuLineBuf = '';
  prevStat = null;
  qemu.stdout.on('data', (b) => {
    const s = b.toString('utf8');
    appendTail(s);
    routeQemuOutput(s);
  });
  qemu.stderr.on('data', (b) => {
    const s = b.toString('utf8');
    appendTail(s);
    send('qemu:stderr', s);
  });

  qemu.on('exit', (code, signal) => {
    send('qemu:exit', { code, signal });
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    // Remove the stale xv6 bridge file so coomd stops reporting dead state.
    try { fs.unlinkSync(COOMD_STATE_FILE); } catch (_) {}
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

  // NOTE: statd & oomd are no longer injected from here. xv6's init now launches
  // them automatically at boot (user/init.c), so kernel status reporting and the
  // OOM watcher are guaranteed to run regardless of console-injection timing.
  // The interface just parses the @@STAT / @@OOM_REQ lines they emit.
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
// xv6 kernel monitor — main.js *is* the relay (docs/xv6_electron_monitor.md)
//   - line-buffer qemu stdout so we can intercept tagged lines whole
//   - "@@STAT {json}"  -> parse + CPU% delta -> IPC 'kstat:update' (hidden from console)
//   - "@@OOM_REQ {json}" -> ask the LLM -> inject "@@OOM_RESP {json}" into xv6 stdin
//   - every other line -> forwarded to the console as before
// ─────────────────────────────────────────────────────────────

function stateName(st) {
  return ({ 1: 'USED', 2: 'SLEEP', 3: 'READY', 4: 'RUN', 5: 'ZOMBIE' }[st]) || '?';
}

// Auto-start the kernel monitors once the shell is up, so the interface always
// receives real xv6 metrics (statd → @@STAT, meaningful memory graph) and OOM
// decisions are driven automatically (oomd → @@OOM_REQ) without the user having
// to type the commands. Injected through the shell; both survive sh restarts as
// init-reparented background processes. Only the Electron interface does this,
// so CLI / relay.py paths stay free of @@STAT.
// Surface xv6 oomd's own console lines as structured events so the dashboard
// THRESHOLD field and the OOM event log reflect the real in-kernel watcher.
function parseOomdLine(line) {
  let m = line.match(/\[oomd\] started \(threshold=(\d+)%\)/);
  if (m) {
    send('oom:event', { kind: 'startup', threshold: Number(m[1]), dry_run: false,
                        source: 'xv6-oomd', timestamp: Date.now() });
    return;
  }
  m = line.match(/\[oomd\] killing pid (\d+)/);
  if (m) {
    send('oom:event', { kind: 'kill', pid: Number(m[1]), signal: 'kill',
                        source: 'xv6-oomd', timestamp: Date.now() });
    return;
  }
  // Kernel OOM safety net (kalloc deadlock guard). Format:
  //   [kernel-oom] out of memory: killed pid 6 (database, 40976 KB)
  // Surface it as a decision so the matching service card turns red, even though
  // no host/LLM round-trip happened.
  m = line.match(/\[kernel-oom\].*killed pid (\d+) \(([^,]+),/);
  if (m) {
    const pid = Number(m[1]);
    send('oom:event', { kind: 'decision', source: 'kernel-oom', engine: 'kernel',
                        victims: [pid], reasoning: `kernel last-resort OOM kill of ${m[2]} (largest process)`,
                        timestamp: Date.now() });
  }
}

function routeQemuOutput(chunk) {
  qemuLineBuf += chunk;
  let nl;
  while ((nl = qemuLineBuf.indexOf('\n')) >= 0) {
    const line = qemuLineBuf.slice(0, nl);
    qemuLineBuf = qemuLineBuf.slice(nl + 1);
    if (line.startsWith('@@STAT')) {
      handleStatLine(line.slice('@@STAT'.length).trim());   // never reaches the console
    } else if (line.startsWith('@@OOM_REQ')) {
      handleOomReq(line.slice('@@OOM_REQ'.length).trim());
    } else if (line.startsWith('@@')) {
      /* other tags (e.g. @@OOM_RESP echo, @@STAT_ERR) are hidden from console */
    } else {
      send('qemu:stdout', line + '\n');                     // ordinary console line
      parseOomdLine(line);
    }
  }
  // A newline-less tail (the shell prompt "$ ") must show immediately, but if it
  // begins with '@' it may be a tag still being assembled — keep it buffered.
  if (qemuLineBuf.length && !qemuLineBuf.startsWith('@')) {
    send('qemu:stdout', qemuLineBuf);
    qemuLineBuf = '';
  }
}

function handleStatLine(json) {
  let o;
  try { o = JSON.parse(json); } catch (_) { return; }   // drop torn lines

  // CPU% = (cpu_ticks_now - cpu_ticks_prev) / ((uptime delta) * ncpu) * 100
  const dUp = prevStat ? Math.max(1, o.uptime - prevStat.uptime) : 1;
  const prevCpu = {};
  if (prevStat) for (const p of prevStat.procs) prevCpu[p.pid] = p.cpu;

  let totalDelta = 0;
  const procs = (o.procs || []).map((p) => {
    const dCpu = prevStat ? (p.cpu - (prevCpu[p.pid] ?? p.cpu)) : 0;
    totalDelta += Math.max(0, dCpu);
    const cpuPct = prevStat ? (100 * dCpu) / (dUp * o.ncpu) : 0;
    return {
      pid: p.pid,
      name: p.name,
      state: stateName(p.st),
      memKb: p.sz_kb,
      cpuPct: Math.max(0, cpuPct),
      stall: p.stall,
    };
  });

  const usedPg = o.total_pg - o.free_pg;
  const payload = {
    uptimeTicks: o.uptime,
    ncpu: o.ncpu,
    cpuPct: prevStat ? (100 * totalDelta) / (dUp * o.ncpu) : 0,
    memUsedMB: (usedPg * PG_KB) / 1024,
    memTotalMB: (o.total_pg * PG_KB) / 1024,
    memPct: o.total_pg ? (100 * usedPg) / o.total_pg : 0,
    running: o.running,
    runnable: o.runnable,
    psiSome: o.psi_some,
    psiSome60: o.psi_some60 ?? 0,
    psiFull: o.psi_full,
    procCount: procs.length,
    procs: procs.sort((a, b) => b.cpuPct - a.cpuPct),
  };

  prevStat = o;
  send('kstat:update', payload);

  // Bridge the real xv6 state to the coomd daemon (replaces its mock stubs).
  writeXv6StateForCoomd(o.psi_some | 0, o.psi_full | 0, procs);
}

// Export the live xv6 snapshot to the coomd bridge file. coomd reads this each
// loop: a "PSI <some> <full>" line plus one "PROC <pid> <rss_kb> <name>" line
// per process. Written atomically (temp + rename) so coomd never sees a torn
// file. Best-effort — a write failure must not disrupt the dashboard.
function writeXv6StateForCoomd(psiSome, psiFull, procs) {
  try {
    let txt = `PSI ${psiSome} ${psiFull}\n`;
    for (const p of procs) {
      txt += `PROC ${p.pid} ${p.memKb | 0} ${p.name}\n`;
    }
    const tmp = COOMD_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, txt);
    fs.renameSync(tmp, COOMD_STATE_FILE);
  } catch (_) { /* coomd bridge is best-effort */ }
}

// xv6 -> host OOM request: ask the LLM which candidate to kill, inject reply.
async function handleOomReq(json) {
  let req;
  try { req = JSON.parse(json); } catch (_) { return; }
  if (oomBusy) return;            // ignore overlapping requests
  oomBusy = true;

  let victims = [];
  let reasoning = '';
  let engine = 'fallback';
  try {
    const decision = await decideOom(req);
    victims = Array.isArray(decision.victims) ? decision.victims : [];
    reasoning = decision.reasoning || '';
    engine = decision.engine || engine;
  } catch (e) {
    reasoning = `decision failed: ${e.message}`;
  }

  // Never let init(1) be chosen.
  victims = victims.filter((v) => Number.isInteger(v) && v > 1);

  send('oom:event', { kind: 'decision', source: 'xv6', engine, victims, reasoning,
                      psi: req.psi, candCount: (req.candidates || []).length,
                      timestamp: Date.now() });

  writeStdin('@@OOM_RESP ' + JSON.stringify({ victims, reasoning }) + '\n');
  oomBusy = false;
}

// Unified decision path the interface orchestrates:
//   engine 'python' → run helper.py (R3) → on failure fall back to JS fetch;
//   engine 'llm'    → JS fetch directly.
// Both end in the heuristic fallback inside decideOomVictims if no API key.
async function decideOom(req) {
  if (oomEngine === 'python' || oomEngine === 'auto') {
    try {
      const d = await decideViaPython(req);
      return { ...d, engine: 'python' };
    } catch (e) {
      send('py:status', { state: 'error', message: e.message });
      send('coomd:stderr', `[python helper] ${e.message} — falling back to JS LLM\n`);
    }
  }
  const d = await decideOomVictims(req);
  return { ...d, engine: 'llm' };
}

// ─────────────────────────────────────────────────────────────
// Python LLM helper — managed by the interface (fork-exec-pipe per decision)
// ─────────────────────────────────────────────────────────────

// Resolve a usable python interpreter once and cache it.
function resolvePython() {
  if (pythonCmd) return pythonCmd;
  for (const v of PYTHON_VENVS) {
    if (fs.existsSync(v)) { pythonCmd = v; return v; }
  }
  // Fall back to whatever's on PATH; spawn() will surface ENOENT if absent.
  pythonCmd = PYTHON_FALLBACKS[0];
  return pythonCmd;
}

// Spawn helper.py, write the request JSON line to stdin, read the victims
// JSON line from stdout. Maps xv6 candidate fields (name/sz_kb) onto the
// helper's Linux-style schema (comm/rss_kb) so both Solar and mock modes work.
function decideViaPython(req) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(HELPER_PY)) return reject(new Error('helper.py not found'));
    const py = resolvePython();
    const candidates = (req.candidates || []).map((c) => ({
      pid: c.pid, comm: c.name, rss_kb: c.sz_kb, name: c.name, sz_kb: c.sz_kb,
    }));
    const payload = JSON.stringify({
      policy: policyWithPurpose(), server_purpose: serverPurpose,
      candidates, target_free_mb: 64, psi: req.psi,
    });

    let child;
    try {
      child = spawn(py, [HELPER_PY], {
        cwd: path.dirname(HELPER_PY),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },  // robust across host locales
      });
    } catch (e) {
      return reject(e);
    }
    send('py:status', { state: 'deciding', pid: child.pid, cmd: py });

    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 30000);

    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastLine);
        send('py:status', { state: 'ok', code, reasoning: parsed.reasoning });
        resolve(parsed);
      } catch (_) {
        reject(new Error(`helper exited ${code}: ${(err || out).slice(0, 200)}`));
      }
    });

    try { child.stdin.write(payload + '\n'); child.stdin.end(); }
    catch (e) { clearTimeout(timer); reject(e); }
  });
}

// Probe for a working interpreter (used at startup and by the UI).
function checkPython() {
  return new Promise((resolve) => {
    const py = resolvePython();
    let child;
    try { child = spawn(py, ['--version'], { env: { ...process.env } }); }
    catch (_) { return resolve({ found: false, cmd: py }); }
    let ver = '';
    child.stdout.on('data', (b) => { ver += b.toString('utf8'); });
    child.stderr.on('data', (b) => { ver += b.toString('utf8'); });
    child.on('error', () => resolve({ found: false, cmd: py }));
    child.on('exit', (code) =>
      resolve({ found: code === 0, cmd: py, version: ver.trim(), helper: fs.existsSync(HELPER_PY) }));
  });
}

// Non-streaming Solar call that returns {victims:[pid...], reasoning}.
// Falls back to the largest non-protected candidate if no key / on error.
async function decideOomVictims(req) {
  const candidates = req.candidates || [];
  const fallback = () => {
    const safe = candidates
      .filter((c) => c.pid > 1 && !/^(init|sh|oomd)$/.test(c.name || ''))
      .sort((a, b) => (b.sz_kb || 0) - (a.sz_kb || 0));
    return {
      victims: safe.length ? [safe[0].pid] : [],
      reasoning: '[fallback] largest non-protected process (no LLM).',
    };
  };

  const apiKey = process.env.UPSTAGE_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') return fallback();

  const system = [
    'You are an OOM victim selector for the xv6 teaching OS running in QEMU.',
    'You receive a memory-pressure value and a list of candidate processes',
    '(pid, name, sz_kb). Choose which pid(s) to kill to relieve pressure.',
    'RULES: never select pid<=1, "init", "sh", or "oomd". Prefer the memory hogs.',
    serverPurpose
      ? `The operator described this server's purpose as: "${serverPurpose}". ` +
        'Honor it: protect processes essential to that purpose and prefer killing ones that are not.'
      : '',
    'Respond with ONLY a JSON object: {"victims":[pid,...],"reasoning":"short"}.',
  ].filter(Boolean).join('\n');
  const user = JSON.stringify({ psi: req.psi, server_purpose: serverPurpose, candidates });

  const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) return fallback();
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.victims) || !parsed.victims.length) return fallback();
    return parsed;
  } catch (_) {
    return fallback();
  }
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
    // Tell coomd where to read the live xv6 state bridge file.
    env: { ...process.env, COOMD_XV6_STATE: COOMD_STATE_FILE },
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
ipcMain.handle('oom:setPurpose', (_e, text) => {
  serverPurpose = String(text || '').slice(0, 600).trim();
  // Surface it in the OOM event log so the operator sees it was registered.
  if (serverPurpose) {
    send('oom:event', { kind: 'decision', source: 'operator', engine: 'policy',
                        victims: [], reasoning: `server purpose set: ${serverPurpose}`,
                        timestamp: Date.now() });
  }
  return serverPurpose;
});
ipcMain.handle('llm:chat',     (e, { messages }) => streamChat(messages || [], e.sender));
ipcMain.handle('llm:status',   () => ({
  ready: !!process.env.UPSTAGE_API_KEY && process.env.UPSTAGE_API_KEY !== 'your_api_key_here',
  model: LLM_MODEL,
  baseUrl: LLM_BASE_URL,
}));

// Python helper orchestration (the interface owns the Python side).
ipcMain.handle('py:check',     () => checkPython());
ipcMain.handle('oom:engine',   (_e, engine) => {
  if (['python', 'llm', 'auto'].includes(engine)) oomEngine = engine;
  return oomEngine;
});
// Run a synthetic decision through the current engine so the user can verify
// the whole xv6→helper.py→victim path from the UI without waiting for pressure.
ipcMain.handle('oom:test',     async () => {
  const req = { psi: 42, candidates: [
    { pid: 1, name: 'init',   sz_kb: 12 },
    { pid: 2, name: 'sh',     sz_kb: 16 },
    { pid: 9, name: 'memhog', sz_kb: 81920 },
  ] };
  const d = await decideOom(req).catch((e) => ({ victims: [], reasoning: e.message, engine: 'error' }));
  send('oom:event', { kind: 'decision', source: 'test', engine: d.engine,
                      victims: (d.victims || []).filter((v) => v > 1),
                      reasoning: d.reasoning, psi: req.psi,
                      candCount: req.candidates.length, timestamp: Date.now() });
  return d;
});

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
    // Probe the Python side the interface manages, and report its readiness.
    checkPython().then((info) => {
      send('py:status', {
        state: info.found && info.helper ? 'ready' : 'missing',
        cmd: info.cmd, version: info.version, helper: info.helper, engine: oomEngine,
      });
    });
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
