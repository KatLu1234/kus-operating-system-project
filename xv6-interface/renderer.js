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

  const serviceGrid = $('service-grid');
  const consoleView = $('console-view');
  const serviceView = $('service-view');
  const btnView     = $('btn-view');
  const centerTitle = $('center-title');
  const cardEls     = {};   // service id -> card element

  const psiSome10   = $('psi-some-10');
  const psiSome60   = $('psi-some-60');
  const psiFull10   = $('psi-full-10');
  const oomLast     = $('oom-last');
  const oomVictims  = $('oom-victims');
  const oomThresh   = $('oom-threshold');
  const coomdState  = $('coomd-state');
  const coomdPid    = $('coomd-pid');
  const oomLog      = $('oom-log');
  const oomEngineEl = $('oom-engine');
  const pyStateEl   = $('py-state');
  const footPy      = $('foot-py');
  const btnEngine   = $('btn-engine');
  const btnTestOom  = $('btn-test-oom');

  const llmMetaEl    = $('llm-meta');
  const footStatus   = $('foot-status');
  const footPid      = $('foot-pid');
  const footCoomd    = $('foot-coomd');
  const footLlm      = $('foot-llm');
  const footElectron = $('foot-electron');

  const btnRestart  = $('btn-restart');
  const btnStop     = $('btn-stop');

  const cmdForm     = $('cmd-form');
  const cmdInput    = $('cmd-input');

  // ── Server commissioning popup ──────────────────────────────
  // Shown on load; collects the server's purpose and ships it to main.js so the
  // LLM gets it with every OOM kill decision.
  const commissionOverlay = $('commission-overlay');
  const commissionInput   = $('commission-input');
  const commissionGo      = $('commission-go');
  const commissionSkip    = $('commission-skip');

  function closeCommission() {
    if (commissionOverlay) commissionOverlay.classList.add('hidden');
    try { stdinInput && stdinInput.focus(); } catch (_) {}
  }
  function submitCommission() {
    const txt = ((commissionInput && commissionInput.value) || '').trim();
    try { window.xv6 && window.xv6.setPurpose && window.xv6.setPurpose(txt); } catch (_) {}
    closeCommission();
  }
  if (commissionGo)   commissionGo.addEventListener('click', submitCommission);
  if (commissionSkip) commissionSkip.addEventListener('click', closeCommission);
  if (commissionInput) {
    // Ctrl/Cmd+Enter submits from the textarea.
    commissionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitCommission(); }
    });
    setTimeout(() => { try { commissionInput.focus(); } catch (_) {} }, 100);
  }
  if (commissionOverlay) {
    commissionOverlay.querySelectorAll('[data-preset]').forEach((b) => {
      b.addEventListener('click', () => {
        if (commissionInput) { commissionInput.value = b.getAttribute('data-preset'); commissionInput.focus(); }
      });
    });
  }

  // ── State ───────────────────────────────────────────────────
  const HISTORY = 90;
  const cpuHist = [];
  const memHist = [];
  const ioHist  = [];
  let startedAt = null;
  let bytesAcc  = 0;
  let bytesLast = 0;
  let memMaxMB  = 64;
  // Stable y-axis ceiling for the legacy host-QEMU memory graph, so its line
  // shows a true fraction instead of hugging the top of the chart.
  const HOST_MEM_MAX_MB = 512;
  let oomEventCount = 0;
  let kstatLive = false;   // true once xv6 statd is feeding kstat:update
  const lastProcByPid = new Map();  // pid -> {pid,name,memKb} last seen alive (resolves victims)
  const killedNames   = new Map();  // service name -> {pid,memKb,at} OOM-killed (card turns red)

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
    drawSparkline(memCanvas, memHist, { min: 0, max: Math.max(memMaxMB, 64) });
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

  // Shared by the in-console input and the always-visible bottom command bar.
  function sendCommand(v) {
    if (!window.xv6) return;
    window.xv6.send(v + '\n');
    appendConsole(v + '\n', 'in');
  }
  stdinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCommand(stdinInput.value);
    stdinInput.value = '';
  });
  if (cmdForm) cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendCommand(cmdInput.value);
    cmdInput.value = '';
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
        if (ev.engine) oomEngineEl.textContent = ev.engine;
        appendOomLog(`decision[${ev.source || '?'}] engine=${ev.engine || '?'} `
          + `psi=${ev.psi ?? '?'} victims=[${(ev.victims || []).join(',')}]`);
        if (ev.reasoning) appendOomLog(`  reason: ${ev.reasoning}`);
        // Mark the decided victims as OOM-killed so their service card turns red.
        // Resolve each pid to its service name via the last statd snapshot; only
        // real, previously-seen processes are marked (skips synthetic test pids).
        if (Array.isArray(ev.victims)) {
          for (const pid of ev.victims) {
            const info = lastProcByPid.get(pid);
            if (info) killedNames.set(info.name, { pid, memKb: info.memKb, at: Date.now() });
          }
        }
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
    if (kstatLive) return;   // xv6 statd owns the PSI fields when it's live
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

  // ── Python helper status (managed by the interface) ─────────
  function renderPyStatus(s) {
    if (!s) return;
    const label = s.state === 'ready'    ? 'ready'
                : s.state === 'missing'  ? 'not found'
                : s.state === 'deciding' ? 'deciding…'
                : s.state === 'ok'       ? 'ready'
                : s.state === 'error'    ? 'error'
                : s.state || '--';
    pyStateEl.textContent = label;
    pyStateEl.className = (s.state === 'missing' || s.state === 'error') ? 'err' : 'ok';
    footPy.textContent = label;
    if (s.engine) {
      oomEngineEl.textContent = s.engine;
      if (btnEngine) btnEngine.textContent = `ENGINE: ${s.engine.toUpperCase()}`;
    }
    if (s.version || s.cmd) appendOomLog(`python ${s.state}${s.cmd ? ` (${s.cmd}` : ''}${s.version ? ` ${s.version})` : s.cmd ? ')' : ''}`);
    if (s.state === 'error' && s.message) appendOomLog(`  python error: ${s.message}`);
  }

  // ── Service dashboard (virtual forms, one card per service type) ─
  // Each card mirrors a real xv6 process the user launches. Its colour reflects
  // the kernel-reported state: gray = not running, green = running, red = killed
  // by the OOM killer. State is refreshed every statd @@STAT report.
  const SERVICES = [
    { id: 'database', label: 'DATABASE', icon: '🗄', mb: 38, form:
      `<div class="vf-line">SELECT * FROM orders LIMIT 3;</div>
       <div class="vf-grid3"><span>#1042</span><span>paid</span><span>$42.00</span>
         <span>#1043</span><span>paid</span><span>$8.50</span>
         <span>#1044</span><span>ship</span><span>$120.0</span></div>
       <div class="vf-foot2">conns 12 · 340 qps</div>` },
    { id: 'server', label: 'WEB SERVER', icon: '🌐', mb: 32, form:
      `<div class="vf-line ok">GET /api/v1/users 200 12ms</div>
       <div class="vf-line ok">POST /api/orders 201 31ms</div>
       <div class="vf-line warn">GET /api/cart 503 --</div>
       <div class="vf-foot2">1.2k rps · p99 38ms</div>` },
    { id: 'security', label: 'SECURITY', icon: '🛡', mb: 30, form:
      `<div class="vf-badges"><span class="vf-tag ok">TLS ✓</span><span class="vf-tag ok">WAF ✓</span></div>
       <div class="vf-line">sessions 318 · mfa 96%</div>
       <div class="vf-line warn">blocked 7 intrusions</div>` },
    { id: 'endpoint', label: 'ENDPOINT', icon: '🔌', mb: 30, form:
      `<div class="vf-line">/api/v1/payments</div>
       <div class="vf-line">/api/v1/users</div>
       <div class="vf-line">/api/v1/inventory</div>
       <div class="vf-foot2">14 routes · healthy</div>` },
    { id: 'cache', label: 'CACHE', icon: '⚡', mb: 42, form:
      `<div class="vf-bar"><i style="width:92%"></i></div>
       <div class="vf-foot2">hit 92% · 2.1M keys</div>` },
    { id: 'logger', label: 'LOGGER', icon: '📝', mb: 26, form:
      `<div class="vf-line dim">12:01:03 INFO request ok</div>
       <div class="vf-line dim">12:01:04 WARN slow query</div>
       <div class="vf-line dim">12:01:05 INFO flush 4k</div>` },
    { id: 'gateway', label: 'GATEWAY', icon: '🚪', mb: 28, form:
      `<div class="vf-line">/* → server</div>
       <div class="vf-line">/auth → security</div>
       <div class="vf-line">/q → messaging</div>
       <div class="vf-foot2">3 upstreams</div>` },
    { id: 'scheduler', label: 'SCHEDULER', icon: '⏱', mb: 28, form:
      `<div class="vf-line">▶ nightly-report 02:00</div>
       <div class="vf-line">▶ cleanup-temp */15</div>
       <div class="vf-foot2">8 jobs queued</div>` },
    { id: 'analytics', label: 'ANALYTICS', icon: '📊', mb: 34, form:
      `<div class="vf-chart"><i style="height:40%"></i><i style="height:70%"></i><i style="height:55%"></i><i style="height:90%"></i><i style="height:65%"></i></div>
       <div class="vf-foot2">3.4M events/min</div>` },
    { id: 'messaging', label: 'MESSAGING', icon: '✉', mb: 32, form:
      `<div class="vf-line">queue: orders depth 1.2k</div>
       <div class="vf-line">queue: emails depth 340</div>
       <div class="vf-foot2">consumers 6</div>` },
  ];

  function setCardState(card, state, info) {
    card.classList.remove('is-offline', 'is-running', 'is-killed', 'is-starting');
    card.classList.add('is-' + state);
    const badge  = card.querySelector('.svc-badge');
    const meta   = card.querySelector('.svc-meta');
    const launch = card.querySelector('.svc-launch');
    const stop   = card.querySelector('.svc-stop');
    if (state === 'running') {
      badge.textContent = 'RUNNING';
      meta.textContent = `pid ${info.pid} · ${(info.memKb / 1024).toFixed(1)} MB`;
      launch.classList.add('hidden'); stop.classList.remove('hidden');
    } else if (state === 'killed') {
      badge.textContent = 'KILLED';
      meta.textContent = info && info.memKb ? `OOM · was ${(info.memKb / 1024).toFixed(1)} MB` : 'OOM killed';
      launch.classList.remove('hidden'); stop.classList.add('hidden');
    } else if (state === 'starting') {
      badge.textContent = 'STARTING…';
      launch.classList.add('hidden'); stop.classList.add('hidden');
    } else {
      badge.textContent = 'OFFLINE';
      // Show the service's typical footprint so its memory weight is visible
      // even before launch (cache ~42 MB vs logger ~26 MB). Sized so ~5 running
      // services exceed xv6's ~127 MB ceiling and trigger the OOM killer.
      meta.textContent = card.dataset.mb ? `idle · ~${card.dataset.mb} MB` : '—';
      launch.classList.remove('hidden'); stop.classList.add('hidden');
    }
  }

  function buildServiceGrid() {
    if (!serviceGrid) return;
    serviceGrid.innerHTML = '';
    for (const s of SERVICES) {
      const card = document.createElement('div');
      card.className = 'svc-card is-offline';
      card.dataset.id = s.id;
      card.dataset.mb = s.mb;
      card.innerHTML =
        `<div class="svc-head"><span class="svc-icon">${s.icon}</span>` +
        `<span class="svc-name">${esc(s.label)}</span>` +
        `<span class="svc-badge">OFFLINE</span></div>` +
        `<div class="svc-form">${s.form}</div>` +
        `<div class="svc-foot"><span class="svc-meta">—</span>` +
        `<span class="svc-actions">` +
        `<button class="svc-launch mini-btn">▶ start</button>` +
        `<button class="svc-stop mini-btn hidden">■ stop</button>` +
        `</span></div>`;
      card.querySelector('.svc-launch').addEventListener('click', () => {
        // Size each launch to a footprint that fits the service type (±15%), so
        // cache/database grab far more RAM than logger/scheduler.
        const mb = Math.max(2, Math.round(s.mb * (0.85 + Math.random() * 0.3)));
        if (window.xv6) window.xv6.send(`${s.id} ${mb} &\n`);
        card.dataset.startAt = String(Date.now());
        setCardState(card, 'starting');
      });
      card.querySelector('.svc-stop').addEventListener('click', () => {
        const pid = card.dataset.pid;
        if (pid && window.xv6) window.xv6.send(`kill ${pid}\n`);
      });
      cardEls[s.id] = card;
      serviceGrid.appendChild(card);
    }
  }

  // Refresh card states from a statd snapshot (called every @@STAT report).
  function updateServiceCards(procs) {
    const live = procs || [];
    const aliveByName = new Map();
    for (const p of live) {
      lastProcByPid.set(p.pid, { pid: p.pid, name: p.name, memKb: p.memKb });
      if (!aliveByName.has(p.name)) aliveByName.set(p.name, p);
    }
    for (const s of SERVICES) {
      const card = cardEls[s.id];
      if (!card) continue;
      const alive = aliveByName.get(s.id);
      if (alive) {
        killedNames.delete(s.id);              // it's back — clear any kill mark
        card.dataset.pid = String(alive.pid);
        setCardState(card, 'running', { pid: alive.pid, memKb: alive.memKb });
      } else if (killedNames.has(s.id)) {
        setCardState(card, 'killed', killedNames.get(s.id));
      } else {
        const startAt = +card.dataset.startAt || 0;
        // keep "starting" briefly so the card doesn't flicker before it appears
        if (!(card.classList.contains('is-starting') && Date.now() - startAt < 6000))
          setCardState(card, 'offline');
      }
    }
  }

  function resetServiceCards() {
    for (const s of SERVICES) {
      const card = cardEls[s.id];
      if (card) { delete card.dataset.startAt; delete card.dataset.pid; setCardState(card, 'offline'); }
    }
  }

  // ── Center view swap (console <-> service dashboard) ─────────
  let dashboardShown = false;
  function showDashboard() {
    if (!serviceView || !consoleView) return;
    dashboardShown = true;
    consoleView.classList.add('hidden');
    serviceView.classList.remove('hidden');
    if (centerTitle) centerTitle.textContent = '// SERVICES — launch & watch OOM';
    if (btnView) btnView.textContent = 'CONSOLE';
  }
  function showConsole() {
    if (!serviceView || !consoleView) return;
    dashboardShown = false;
    serviceView.classList.add('hidden');
    consoleView.classList.remove('hidden');
    if (centerTitle) centerTitle.textContent = '// CONSOLE — make clean && make qemu';
    if (btnView) btnView.textContent = 'DASHBOARD';
  }

  buildServiceGrid();
  if (btnView) btnView.addEventListener('click', () => (dashboardShown ? showConsole() : showDashboard()));

  // ── IPC wiring ──────────────────────────────────────────────
  if (!window.xv6) {
    appendConsole('[error] preload bridge not available — IPC disabled.\n', 'err');
  } else {
    window.xv6.onStart((d) => {
      startedAt = d.startedAt;
      // Reset graph + process state for a fresh boot so nothing carries over.
      kstatLive = false;
      memMaxMB = 64;
      cpuHist.length = 0; memHist.length = 0; ioHist.length = 0;
      lastProcByPid.clear(); killedNames.clear();
      resetServiceCards();
      showConsole();   // back to the boot console until the new boot succeeds
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
        showDashboard();   // boot succeeded — swap the main panel to the dashboard
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

    // xv6 internal kernel status (statd → main.js relay). This is the primary
    // source for the CPU / MEMORY / PROCS / PSI widgets and the process table.
    window.xv6.onKstat((k) => {
      kstatLive = true;
      pushHistory(cpuHist, k.cpuPct);
      cpuValueEl.textContent = k.cpuPct.toFixed(1) + '%';

      pushHistory(memHist, k.memUsedMB);
      memMaxMB = k.memTotalMB || memMaxMB;
      memValueEl.textContent =
        `${k.memUsedMB.toFixed(1)} / ${k.memTotalMB.toFixed(0)} MB (${k.memPct.toFixed(0)}%)`;

      procsEl.textContent = `${k.procCount} (run ${k.running}/ready ${k.runnable})`;

      psiSome10.textContent = k.psiSome + '%';
      psiSome60.textContent = (k.psiSome60 ?? 0) + '%';
      psiFull10.textContent = k.psiFull + '%';

      updateServiceCards(k.procs);
      redraw();
    });

    // Host QEMU-process usage (legacy / debug). Only used until xv6 statd is
    // running; once kstat:update arrives it owns these widgets.
    window.xv6.onMetrics(({ cpu, memory, alive }) => {
      if (kstatLive) return;   // xv6 statd owns these widgets once it's live
      pushHistory(cpuHist, cpu);
      const memMB = memory / 1024 / 1024;
      pushHistory(memHist, memMB);
      // Stable ceiling (not a self-following 1.2× ratchet) so the host graph
      // doesn't sit pinned at the top; only grows if RSS truly exceeds it.
      memMaxMB = Math.max(HOST_MEM_MAX_MB, memMB * 1.1);
      cpuValueEl.textContent = cpu.toFixed(1) + '% (host)';
      memValueEl.textContent = memMB.toFixed(1) + ' MB (host)';
      procsEl.textContent    = String(alive);
    });

    window.xv6.onOomEvent(renderOomEvent);
    window.xv6.onOomPressure(renderPressure);
    window.xv6.onPyStatus(renderPyStatus);
    window.xv6.onCoomdStatus(renderCoomdStatus);
    window.xv6.onCoomdStdout((s) => appendCoomdRaw(s, 'out'));
    window.xv6.onCoomdStderr((s) => appendCoomdRaw(s, 'err'));

    // Engine toggle: cycle the OOM decision engine the interface uses.
    const ENGINES = ['python', 'llm'];
    btnEngine.addEventListener('click', async () => {
      const cur = (oomEngineEl.textContent || 'python').toLowerCase();
      const next = ENGINES[(ENGINES.indexOf(cur) + 1) % ENGINES.length] || 'python';
      const applied = await window.xv6.setEngine(next);
      oomEngineEl.textContent = applied;
      btnEngine.textContent = `ENGINE: ${applied.toUpperCase()}`;
      appendOomLog(`engine -> ${applied}`);
    });

    // Manual end-to-end test of the decision path (no pressure needed).
    btnTestOom.addEventListener('click', async () => {
      appendOomLog('running TEST LLM decision…');
      try { await window.xv6.testOom(); } catch (e) { appendOomLog(`test failed: ${e.message}`); }
    });

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
