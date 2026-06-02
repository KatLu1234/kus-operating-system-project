# xv6 커널 모니터 — Electron(`xv6-interface`) 적용판

> `docs/xv6_kernel_monitor.md`의 **A + statd 전략**을, Python relay(`monitor.py`)
> 대신 **Electron 메인 프로세스(`main.js`)가 수행**하도록 재적용한다.
>
> 즉 `main.js`가 곧 relay다: QEMU stdout에서 `@@STAT` 줄을 **걸러내(숨김)**,
> 파싱해 진짜 xv6 커널 상태(프로세스 리스트·CPU%·메모리%·PSI)를 IPC로 렌더러에
> 보내고, HUD 패널에 그린다.
>
> **커널 측(statd, `get_sys_stat`/`get_proc_stats` 시스템콜, `cpu_ticks` 누적)은
> `docs/xv6_kernel_monitor.md`에 정의된 그대로 사용**한다. 이 문서는 호스트
> (Electron) 측만 다룬다.

관련 문서: `docs/xv6_kernel_monitor.md`(커널/statd), `docs/xv6_llm_integration.md`(채널 원리)

---

## 1. 현재 앱 구조와 바꿀 점

현재 `xv6-interface`는 이렇게 동작한다.

| 구성 | 현재 | 적용 후 |
|------|------|---------|
| xv6 실행 | `main.js`가 `make clean && make qemu` spawn | 그대로 |
| 콘솔 출력 | `qemu.stdout` raw chunk를 `qemu:stdout`으로 **그대로** 전달 | **라인 버퍼 + `@@STAT` 필터** 후 전달 |
| 메트릭 | `pidusage(qemu.pid)` = **호스트 QEMU 프로세스**의 CPU/메모리 | `@@STAT` 파싱 = **xv6 내부** 프로세스/CPU/메모리/PSI |
| PSI | coomd(Linux)의 `EVENT` 줄에서 | xv6 statd의 `@@STAT`에서 (실제 커널 PSI) |

두 가지 핵심 변경:

1. **콘솔 누출 차단** — 지금은 chunk를 라인 구분 없이 그대로 보내므로
   `@@STAT {...}`가 콘솔에 그대로 뜬다. 라인 단위로 끊어 태그 줄을 걸러야 한다.
2. **메트릭 소스 교체** — 호스트 프로세스 사용량 대신 xv6 내부 상태를 보여준다.
   (호스트 메트릭은 디버그용으로 남겨도 되지만 라벨을 구분한다.)

---

## 2. 데이터 흐름 (Electron 버전)

```
[xv6: statd]              [QEMU: make qemu]        [Electron main.js = relay]      [renderer.js HUD]
주기적 수집(syscall)
 printf("@@STAT {json}\n")──UART──► child stdout ──► qemuLineBuf 라인 분해
                                                     ├ "@@STAT " 줄 → 파싱+CPU%델타 → IPC 'kstat:update' ─► 대시보드 갱신
                                                     └ 그 외 줄      → IPC 'qemu:stdout'              ─► 콘솔(유저가 봄)
```

`@@STAT` 원문은 콘솔로 안 가고, 파싱된 구조화 데이터만 `kstat:update`로 흐른다.

---

## 3. `main.js` 변경

### 3.1 라인 버퍼링 + `@@STAT` 필터

현재 핸들러:

```js
qemu.stdout.on('data', (b) => {
  const s = b.toString('utf8');
  appendTail(s);
  send('qemu:stdout', s);     // ← 라인 구분 없이 그대로: @@STAT 누출됨
});
```

이걸 라인 버퍼 방식으로 교체한다. 파일 상단 상태 변수 근처에 추가:

```js
let qemuLineBuf = '';
let prevStat = null;          // 직전 @@STAT 표본 (CPU% 델타용)
```

핸들러 교체:

```js
qemu.stdout.on('data', (b) => {
  const s = b.toString('utf8');
  appendTail(s);
  routeQemuOutput(s);
});
```

라우팅 함수 (라인 단위로 끊어 태그만 가로채고 나머지는 콘솔로):

```js
function routeQemuOutput(chunk) {
  qemuLineBuf += chunk;
  let nl;
  while ((nl = qemuLineBuf.indexOf('\n')) >= 0) {
    const line = qemuLineBuf.slice(0, nl);
    qemuLineBuf = qemuLineBuf.slice(nl + 1);
    if (line.startsWith('@@STAT')) {
      handleStatLine(line.slice('@@STAT'.length).trim());   // 콘솔로 안 보냄
    } else if (line.startsWith('@@')) {
      /* 다른 태그(@@OOM 등)도 콘솔에서 숨김 — 필요시 별도 처리 */
    } else {
      send('qemu:stdout', line + '\n');                     // 일반 줄만 콘솔로
    }
  }
  // 개행 없는 꼬리(셸 프롬프트 "$ " 등)는 콘솔에 바로 보여야 한다.
  // 단, '@@'로 시작하면 태그가 완성될 수 있으니 버퍼에 둔다.
  if (qemuLineBuf.length && !qemuLineBuf.startsWith('@')) {
    send('qemu:stdout', qemuLineBuf);
    qemuLineBuf = '';
  }
}
```

> 마지막 블록이 중요하다. `$ ` 같은 프롬프트는 개행이 없어 버퍼에 남는데,
> `@`로 시작하지 않으면 즉시 콘솔로 흘려보내야 프롬프트가 보인다. `@@STAT`는
> 항상 `\n`으로 끝나므로(statd가 그렇게 출력) 버퍼에 잠깐 남아도 다음 청크에서
> 완성되어 걸러진다.

### 3.2 `@@STAT` 파서 + CPU% 델타 → `kstat:update`

```js
const PG_KB = 4;   // page = 4KB

function handleStatLine(json) {
  let o;
  try { o = JSON.parse(json); } catch (_) { return; }   // 깨진 줄 무시

  // CPU% = (이번 cpu_ticks - 직전) / ((uptime차) * ncpu) * 100
  const dUp = prevStat ? Math.max(1, o.uptime - prevStat.uptime) : 1;
  const prevCpu = {};
  if (prevStat) for (const p of prevStat.procs) prevCpu[p.pid] = p.cpu;

  let totalDelta = 0;
  const procs = o.procs.map((p) => {
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
    memPct: (100 * usedPg) / o.total_pg,
    running: o.running,
    runnable: o.runnable,
    psiSome: o.psi_some,
    psiFull: o.psi_full,
    procCount: procs.length,
    procs: procs.sort((a, b) => b.cpuPct - a.cpuPct),
  };

  prevStat = o;
  send('kstat:update', payload);
}

function stateName(st) {
  return ({ 1: 'USED', 2: 'SLEEP', 3: 'READY', 4: 'RUN', 5: 'ZOMBIE' }[st]) || '?';
}
```

### 3.3 호스트 메트릭 정리 (선택)

`sampleMetrics`/`pidusage` 기반 `qemu:metrics`는 **호스트 QEMU 프로세스** 사용량이라
xv6 내부와 다르다. 두 가지 선택:

- **권장**: `qemu:metrics`는 그대로 두되 렌더러에서 안 쓰거나 "HOST"로 라벨링.
  HUD의 CPU/MEM/PROCS는 `kstat:update`(xv6 내부)로 채운다.
- 또는 `metricsTimer`를 제거해 호스트 샘플링을 끈다.

---

## 4. `preload.js` 변경

`xv6` 브리지에 한 줄 추가한다.

```js
contextBridge.exposeInMainWorld('xv6', {
  // ... 기존 ...
  onMetrics: (cb) => ipcRenderer.on('qemu:metrics', (_, d) => cb(d)),  // 호스트(레거시)
  onKstat:   (cb) => ipcRenderer.on('kstat:update', (_, d) => cb(d)),  // ★ xv6 내부 상태
  // ... 기존 ...
});
```

---

## 5. `renderer.js` 변경

### 5.1 기존 HUD 요소에 xv6 상태 매핑

기존 메트릭 그래프/값(`cpu-value`, `mem-value`, `stat-procs`, `cpu-graph`,
`mem-graph`)과 PSI 필드(`psi-some-10`, `psi-full-10`)를 그대로 재사용한다.
`onMetrics`(호스트) 대신 `onKstat`(xv6)로 연결:

```js
window.xv6.onKstat((k) => {
  // CPU
  pushHistory(cpuHist, k.cpuPct);
  cpuValueEl.textContent = k.cpuPct.toFixed(1) + '%';

  // MEMORY (xv6 물리 메모리 사용량)
  pushHistory(memHist, k.memUsedMB);
  memMaxMB = k.memTotalMB;                       // 그래프 상한 = 전체 메모리
  memValueEl.textContent =
    `${k.memUsedMB.toFixed(1)} / ${k.memTotalMB.toFixed(0)} MB (${k.memPct.toFixed(0)}%)`;

  // 프로세스 수 / 런큐
  procsEl.textContent = `${k.procCount} (run ${k.running}/ready ${k.runnable})`;

  // PSI (실제 커널 PSI)
  psiSome10.textContent = k.psiSome + '%';
  psiFull10.textContent = k.psiFull + '%';

  // 프로세스 테이블 (아래 5.2)
  renderProcTable(k.procs);

  redraw();
});
```

> `memMaxMB`는 기존엔 호스트 기준으로 늘어났는데, 이제 xv6 전체 메모리(128MB
> 기준 page 환산)로 고정하면 사용률 그래프가 직관적이다. `redraw()`의
> `drawSparkline(memCanvas, memHist, { max: ... })` 상한도 `memMaxMB`를 쓰면 된다.

### 5.2 프로세스 테이블 추가

HUD에 프로세스 목록 영역이 없으므로 가벼운 표를 하나 만든다.
`index.html`의 오른쪽 패널(`panel-right`) 안 `EVENTS` 위 등에 추가:

```html
<div class="subhead">PROCESSES</div>
<pre class="proc-table" id="proc-table">(no data)</pre>
```

`renderer.js`에 렌더 함수:

```js
const procTable = document.getElementById('proc-table');

function renderProcTable(procs) {
  if (!procs || !procs.length) { procTable.textContent = '(no data)'; return; }
  const head = ` PID  NAME           STATE   MEM(KB)  CPU%`;
  const rows = procs.slice(0, 12).map((p) =>
    ` ${String(p.pid).padStart(3)}  ${p.name.padEnd(13).slice(0,13)} ` +
    `${p.state.padEnd(6)} ${String(p.memKb).padStart(8)} ${p.cpuPct.toFixed(1).padStart(5)}`
  );
  procTable.textContent = [head, ...rows].join('\n');
}
```

(스타일은 기존 `.oom-log`와 동일한 모노스페이스 계열을 `styles.css`에 복사하면 된다.)

### 5.3 PSI 출처 정리

현재 `psi-some-10` 등은 coomd `oom:pressure`로 채워진다. 이제 xv6 statd가 실제
커널 PSI를 주므로, **xv6 단독 시연에서는 `onKstat`이 채우게** 두고, Linux coomd
경로를 쓸 때만 `oom:pressure`가 채우게 한다. 둘을 동시에 쓰면 마지막 갱신이
이긴다(혼선 주의). 시연 모드에 따라 한쪽만 활성화하는 걸 권장.

---

## 6. (선택) 기존 coomd / LLM 경로와의 관계

- `coomd`(Linux 데몬)와 `EVENT {json}` 파싱 경로는 **그대로 유지**된다.
  xv6 statd 경로(`@@STAT`)와 독립이므로 충돌하지 않는다.
- 향후 xv6 OOM 결정까지 연결하려면, `@@OOM_REQ`(xv6→호스트) 줄을 `main.js`에서
  가로채 `streamChat`(이미 구현된 Solar 호출)로 victim을 결정하고 `@@OOM_RESP`를
  `writeStdin`으로 주입하면 된다. (`docs/xv6_llm_integration.md` §2 흐름을
  Electron으로 옮긴 형태. `routeQemuOutput`의 `@@` 분기에 추가.)

---

## 7. 빌드 · 실행 · 시연

```bash
# 1) xv6 측: statd 포함 빌드 (커널 변경은 xv6_kernel_monitor.md 참조)
#    Electron이 'make clean && make qemu'를 직접 실행하므로 별도 빌드 불필요

# 2) Electron 앱 실행 (WSL/Linux, riscv 툴체인·qemu 설치 전제)
cd xv6-interface
npm install        # 최초 1회
npm start
```

시연 흐름(앱의 콘솔 입력창에서):

```
$ statd &          # 상태 수집 시작 — @@STAT 는 콘솔에 안 뜸
$ memhog 100       # 메모리 압박 유발
```

- 왼쪽 패널 CPU/MEMORY 그래프, PROCS, 오른쪽 PSI/프로세스 테이블이 ~1초마다
  **xv6 내부 실제 값**으로 갱신된다.
- 콘솔 패널에는 `@@STAT` 원문이 **보이지 않는다**(main.js가 필터링).
- `memhog` 실행 시 MEMORY 사용률↑, PSI some↑, 해당 프로세스 행의 CPU%·MEM↑가
  실시간으로 보여 시연 효과가 크다.

---

## 8. 변경 파일 요약

| 파일 | 변경 | 비고 |
|------|------|------|
| `xv6-interface/main.js` | `routeQemuOutput`(라인버퍼+필터), `handleStatLine`(파서+CPU%델타), `kstat:update` emit | 핵심 |
| `xv6-interface/preload.js` | `onKstat` 브리지 추가 | 1줄 |
| `xv6-interface/renderer.js` | `onKstat` 핸들러, `renderProcTable`, PSI/메트릭 소스 교체 | |
| `xv6-interface/index.html` | `#proc-table` 영역 추가 | |
| `xv6-interface/styles.css` | `.proc-table` 스타일(선택) | |
| (커널) `user/statd.c`, syscalls 등 | `docs/xv6_kernel_monitor.md` 그대로 | 이 문서 범위 밖 |

호스트 측 핵심 작업은 **`main.js`에 라인 필터 + 파서**를 넣는 것 하나로 수렴한다.
나머지는 그 결과를 렌더러에 그리는 배선이다.

---

## 9. 주의점

- **누출 방지의 핵심은 라인 버퍼링**이다. 현재처럼 raw chunk를 그대로 보내면
  `@@STAT`가 콘솔에 뜬다. 반드시 `\n` 단위로 끊어 태그를 걸러야 한다.
- **개행 없는 꼬리**(프롬프트 `$ `)는 `@`로 시작하지 않을 때 즉시 콘솔로 보내야
  프롬프트가 멈추지 않는다(§3.1 마지막 블록).
- **CPU% 첫 표본**은 직전값이 없어 0%다(델타 불가). 정상.
- **인터리빙**: xv6 `printf`는 프로세스 간 원자적이지 않다. 시연 중 `statd`를
  단독 운용하고, 파서의 `try/catch`로 깨진 줄을 버린다.
- **PSI 중복 소스**: `onKstat`(xv6)와 `oom:pressure`(Linux coomd)가 같은 PSI
  필드를 갱신하므로, 시연 모드별로 한쪽만 활성화한다.
- **고정소수점**: statd가 PSI를 정수 %로 환산해 보내도록 맞추면(커널 측) 렌더러는
  그대로 표시만 하면 된다.
- **보안/CSP**: `index.html`의 CSP는 `script-src 'self'`이다. 외부 스크립트를
  추가하지 말고 기존 구조 내에서 구현한다.
