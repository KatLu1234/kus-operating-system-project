(() => {
  const $ = (id) => document.getElementById(id);

  // ── Elements ────────────────────────────────────────────────
  const clockEl     = $('clock');
  const uptimeEl    = $('stat-uptime');
  const stateEl     = $('stat-state');
  const procsEl     = $('stat-procs');

  const cpuValueEl  = $('cpu-value');
  const memValueEl  = $('mem-value');
  const ioValueEl   = $('io-value');

  const cpuCanvas   = $('cpu-graph');
  const memCanvas   = $('mem-graph');
  const ioCanvas    = $('io-graph');

  const consoleEl   = $('console');
  const stdinForm   = $('stdin-form');
  const stdinInput  = $('stdin-input');

  const procCmd     = $('proc-cmd');
  const procCwd     = $('proc-cwd');
  const procPid     = $('proc-pid');
  const procStarted = $('proc-started');
  const procExit    = $('proc-exit');

  const psiSome10   = $('psi-some-10');
  const psiSome60   = $('psi-some-60');
  const psiFull10   = $('psi-full-10');
  const oomLast     = $('oom-last');
  const oomVictims  = $('oom-victims');
  const oomThresh   = $('oom-threshold');
  const coomdState  = $('coomd-state');
  const coomdPid    = $('coomd-pid');
  const oomLog      = $('oom-log');

  const llmMetaEl    = $('llm-meta');
  const footStatus   = $('foot-status');
  const footPid      = $('foot-pid');
  const footCoomd    = $('foot-coomd');
  const footLlm      = $('foot-llm');
  const footElectron = $('foot-electron');

  const btnRestart  = $('btn-restart');
  const btnStop     = $('btn-stop');

  // ── State ───────────────────────────────────────────────────
  const HISTORY = 90;
  const cpuHist = [];
  const memHist = [];
  const ioHist  = [];
  let startedAt = null;
  let bytesAcc  = 0;
  let bytesLast = 0;
  let memMaxMB  = 64;
  let oomEventCount = 0;

  // ── Utils ───────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const fmtDuration = (ms) => {
    const u = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(u / 3600))}:${pad(Math.floor((u % 3600) / 60))}:${pad(u % 60)}`;
  };
  const esc = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pushHistory = (arr, v) => { arr.push(v); if (arr.length > HISTORY) arr.shift(); };

  function drawSparkline(canvas, data, opts = {}) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = cssW, h = cssH;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(31, 122, 58, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();
    if (!data.length) return;

    const mn = opts.min != null ? opts.min : Math.min(...data);
    const mx = opts.max != null ? opts.max : Math.max(...data, mn + 1);
    const range = Math.max(1e-6, mx - mn);
    const stepX = w / Math.max(1, HISTORY - 1);
    const offset = HISTORY - data.length;

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i + offset) * stepX;
      const y = h - ((v - mn) / range) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#33ff66';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const lastX = (data.length - 1 + offset) * stepX;
    ctx.lineTo(lastX, h);
    ctx.lineTo(offset * stepX, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(51, 255, 102, 0.12)';
    ctx.fill();
  }

  function redraw() {
    drawSparkline(cpuCanvas, cpuHist, { min: 0, max: 100 });
    drawSparkline(memCanvas, memHist, { min: 0, max: Math.max(memMaxMB, ...memHist, 64) });
    drawSparkline(ioCanvas,  ioHist,  { min: 0 });
  }

  function tick() {
    const now = new Date();
    clockEl.textContent = fmtClock(now);
    if (startedAt) uptimeEl.textContent = fmtDuration(Date.now() - startedAt);
    const bytes = bytesAcc - bytesLast;
    bytesLast = bytesAcc;
    pushHistory(ioHist, bytes);
    ioValueEl.textContent = bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB/s' : bytes + ' B/s';
    redraw();
  }
  setInterval(tick, 1000);
  tick();

  // ── Console ─────────────────────────────────────────────────
  function appendConsole(s, kind) {
    bytesAcc += s.length;
    const cls = kind === 'err' ? 'err' : kind === 'in' ? 'in' : 'out';
    const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 20;
    consoleEl.insertAdjacentHTML('beforeend', `<span class="${cls}">${esc(s)}</span>`);
    while (consoleEl.childNodes.length > 4000) consoleEl.removeChild(consoleEl.firstChild);
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  stdinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = stdinInput.value;
    stdinInput.value = '';
    if (!window.xv6) return;
    window.xv6.send(v + '\n');
    appendConsole(v + '\n', 'in');
  });

  // ── OOM log ─────────────────────────────────────────────────
  function appendOomLog(line) {
    if (oomEventCount === 0) oomLog.textContent = '';
    oomEventCount++;
    const stamp = fmtClock(new Date());
    oomLog.textContent += `[${stamp}] ${line}\n`;
    while (oomLog.textContent.length > 8000) {
      oomLog.textContent = oomLog.textContent.slice(-8000);
    }
    oomLog.scrollTop = oomLog.scrollHeight;
  }

  function renderOomEvent(ev) {
    switch (ev.kind) {
      case 'startup':
        oomThresh.textContent = ev.threshold != null ? Number(ev.threshold).toFixed(1) + '%' : '--';
        appendOomLog(`coomd startup threshold=${ev.threshold} dry_run=${ev.dry_run}`);
        break;
      case 'decision':
        oomLast.textContent = fmtClock(new Date(ev.timestamp || Date.now()));
        oomVictims.textContent = Array.isArray(ev.victims) && ev.victims.length
          ? ev.victims.join(', ') : '0';
        appendOomLog(`decision victims=[${(ev.victims || []).join(',')}]`);
        if (ev.reasoning) appendOomLog(`  reason: ${ev.reasoning}`);
        break;
      case 'kill':
        appendOomLog(`kill pid=${ev.pid} comm=${ev.comm || '?'} signal=${ev.signal || 'SIGTERM'}${ev.dry_run ? ' [dry-run]' : ''}`);
        break;
      case 'blocked':
        appendOomLog(`blocked pid=${ev.pid} comm=${ev.comm || '?'} (validator)`);
        break;
      case 'error':
        appendOomLog(`error[${ev.stage || '?'}]: ${ev.message || 'unknown'}`);
        break;
      default:
        appendOomLog(JSON.stringify(ev));
    }
  }

  function renderPressure(p) {
    if (!p) return;
    if (p.threshold != null) oomThresh.textContent = Number(p.threshold).toFixed(1) + '%';
    if (p.some) {
      if (p.some.avg10 != null) psiSome10.textContent = Number(p.some.avg10).toFixed(2);
      if (p.some.avg60 != null) psiSome60.textContent = Number(p.some.avg60).toFixed(2);
    }
    if (p.full && p.full.avg10 != null) psiFull10.textContent = Number(p.full.avg10).toFixed(2);
  }

  function renderCoomdStatus(s) {
    if (!s) return;
    coomdState.textContent = s.state || '--';
    coomdPid.textContent = s.pid != null ? String(s.pid) : '--';
    footCoomd.textContent = s.state === 'running' ? `pid ${s.pid}`
      : s.state === 'exited' ? `exit ${s.code ?? s.signal ?? '?'}`
      : s.state || '--';
    appendOomLog(`coomd ${s.state}${s.pid ? ` pid=${s.pid}` : ''}${s.bin ? ` bin=${s.bin}` : ''}${s.code != null ? ` code=${s.code}` : ''}${s.signal ? ` signal=${s.signal}` : ''}`);
  }

  function appendCoomdRaw(s, kind) {
    // Coomd's human-readable lines (printf in Korean, etc.) are appended to
    // the OOM log alongside the structured events so the user sees full context.
    const cls = kind === 'err' ? 'err' : 'out';
    const lines = s.split('\n');
    for (const line of lines) {
      if (!line) continue;
      appendOomLog(`${cls === 'err' ? '! ' : '  '}${line}`);
    }
  }

  // ── IPC wiring ──────────────────────────────────────────────
  if (!window.xv6) {
    appendConsole('[error] preload bridge not available — IPC disabled.\n', 'err');
  } else {
    window.xv6.onStart((d) => {
      startedAt = d.startedAt;
      procCmd.textContent     = d.cmd;
      procCwd.textContent     = d.cwd;
      procCwd.title           = d.cwd;
      procPid.textContent     = d.pid;
      procStarted.textContent = fmtClock(new Date(d.startedAt));
      procExit.textContent    = '--';
      footPid.textContent     = d.pid;
      stateEl.textContent     = 'BOOTING';
      stateEl.className       = 'ok';
      footStatus.textContent  = 'BOOTING';
      appendConsole(`> ${d.cmd}\n> cwd: ${d.cwd}\n> pid: ${d.pid}\n\n`, 'out');
    });

    window.xv6.onStdout((s) => {
      appendConsole(s, 'out');
      if (stateEl.textContent === 'BOOTING' && /(\$ |init: starting sh|xv6 kernel is booting)/.test(s)) {
        stateEl.textContent = 'RUNNING';
        footStatus.textContent = 'RUNNING';
      }
    });
    window.xv6.onStderr((s) => appendConsole(s, 'err'));

    window.xv6.onExit(({ code, signal }) => {
      procExit.textContent   = signal ? `signal ${signal}` : `code ${code}`;
      stateEl.textContent    = 'STOPPED';
      stateEl.className      = '';
      footStatus.textContent = 'STOPPED';
      appendConsole(`\n[exit] code=${code} signal=${signal}\n`, 'err');
    });

    window.xv6.onMetrics(({ cpu, memory, alive }) => {
      pushHistory(cpuHist, cpu);
      const memMB = memory / 1024 / 1024;
      pushHistory(memHist, memMB);
      memMaxMB = Math.max(memMaxMB, memMB * 1.2);
      cpuValueEl.textContent = cpu.toFixed(1) + '%';
      memValueEl.textContent = memMB.toFixed(1) + ' MB';
      procsEl.textContent    = String(alive);
    });

    window.xv6.onOomEvent(renderOomEvent);
    window.xv6.onOomPressure(renderPressure);
    window.xv6.onCoomdStatus(renderCoomdStatus);
    window.xv6.onCoomdStdout((s) => appendCoomdRaw(s, 'out'));
    window.xv6.onCoomdStderr((s) => appendCoomdRaw(s, 'err'));

    btnRestart.addEventListener('click', () => {
      consoleEl.innerHTML = '';
      cpuHist.length = 0; memHist.length = 0; ioHist.length = 0;
      bytesAcc = 0; bytesLast = 0;
      oomEventCount = 0;
      oomLog.textContent = '(no OOM events yet)';
      oomLast.textContent = '--';
      oomVictims.textContent = '0';
      psiSome10.textContent = '--';
      psiSome60.textContent = '--';
      psiFull10.textContent = '--';
      window.xv6.restart();
    });
    btnStop.addEventListener('click', () => window.xv6.stop());

    window.xv6.llmStatus().then((s) => {
      if (s && s.ready) {
        footLlm.textContent = s.model;
        llmMetaEl.textContent = `${s.model} · ready`;
        llmMetaEl.classList.add('ok');
      } else {
        footLlm.textContent = 'NO KEY';
        llmMetaEl.textContent = 'no UPSTAGE_API_KEY';
        llmMetaEl.classList.add('err');
      }
    });
  }

  footElectron.textContent = (navigator.userAgent.match(/Electron\/([\d.]+)/) || [, 'n/a'])[1];
  window.addEventListener('resize', redraw);
})();
