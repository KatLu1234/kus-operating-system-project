# 현재 시스템 구조 (Current Architecture)

> 최종 업데이트: 2026-06-04
> LLM 기반 OOM 킬러를 xv6-riscv 위에서 시연하는 프로젝트의 **현재 동작 구조** 스냅샷.
> (설계 의도는 `docs/xv6_llm_integration.md`, OOM 데드락 해결은 `docs/oom_deadlock_fix.md` 참조)

---

## 1. 한눈에 보기

```
┌──────────────────────────── xv6 (QEMU, -m 128M) ────────────────────────────┐
│  커널                                                                         │
│   • kalloc/kfree + PSI stall(sleep&kmem)      ← 메모리 압박 감지              │
│   • update_psi() (매 틱, cpu0)                 ← PSI EMA + 커널 OOM 안전망     │
│   • oom_kill() (last-resort)                   ← free=0 지속 시 최대 proc kill │
│   • syscalls: get_mem_pressure/sys_stat/proc_stats/oom_candidates            │
│                                                                              │
│  유저 (init 이 부팅 시 자동 실행)                                            │
│   • statd  → "@@STAT {json}"   (프로세스/CPU/메모리/PSI, ~5Hz)                │
│   • oomd   → "@@OOM_REQ {json}" / read "@@OOM_RESP" → kill(victim)            │
│   • service 10종 (server/database/.../messaging) = 메모리 보유 워크로드       │
└───────────────▲───────────────────────────────────────────┬─────────────────┘
       콘솔(UART)│ @@STAT / @@OOM_REQ                @@OOM_RESP │ 콘솔 stdin
                 │                                            │
┌────────────────┴────────────────────────────────────────────▼────────────────┐
│  호스트 (둘 중 하나가 QEMU stdio 를 중계)                                       │
│                                                                               │
│  A) Electron 인터페이스 (xv6-interface/, 주 경로)                              │
│     main.js: QEMU spawn, @@STAT 파싱→대시보드, @@OOM_REQ→LLM→@@OOM_RESP 주입,   │
│              .xv6_state 브리지 파일 기록, coomd 자식 실행                       │
│     renderer.js: 서비스 카드/메모리 그래프/PSI/OOM 로그/팝업                    │
│                                                                               │
│  B) CLI (coomd/host/)                                                          │
│     monitor.py: @@STAT → 텍스트 대시보드 / relay.py: @@OOM_REQ → LLM           │
│                                                                               │
│  LLM victim 선택: coomd/LLM_client/helper.py (Upstage Solar, 키 없으면 mock)    │
│                                                                               │
│  coomd (참고 병행 데몬): .xv6_state 읽어 압박 감지 → helper.py → 결정 보고      │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 구성 요소

| 위치 | 역할 |
|------|------|
| `xv6-riscv/` | 커널 + 유저 프로그램 (PSI, 커널 OOM 안전망, statd, oomd, 서비스 10종, oomgen) |
| `xv6-interface/` | Electron 인터페이스 (대시보드, 팝업, QEMU 중계, LLM 호출, 브리지 기록) |
| `coomd/` | 호스트 측 C 데몬(병행 의사결정) + Python LLM 헬퍼 + CLI relay/monitor |
| `docs/`, `plan/` | 설계 문서 / 계획서 |

---

## 3. xv6 커널

### 3.1 메모리 압박(PSI) 메커니즘
- `kernel/kalloc.c`: free 페이지가 없으면 호출 프로세스를 `sleep(&kmem)` 으로 재우고
  (`mem_stall_ticks` 누적), `kfree` 가 `wakeup(&kmem)` 으로 깨운다.
- `kalloc.c: kmemexhausted()` — freelist 비었는지 **O(1)** 확인 (안전망용, 매 틱 호출).
- `kernel/proc.c: update_psi()` — 매 틱(cpu0, `trap.c clockintr`에서 호출):
  - stall/runnable 개수로 some/full 산출, 고정소수점(×1024) EMA 갱신.
  - **커널 OOM 안전망 로직**(아래 3.2)도 여기서 수행.

### 3.2 커널 OOM 안전망 (last-resort) — `kernel/proc.c`
LLM/호스트 OOM 경로가 제때 동작하지 못해도 **시스템이 절대 데드락에 빠지지 않도록**
하는 최후수단. (상세: `docs/oom_deadlock_fix.md`)

```
free=0 + stall 발생이 OOM_GRACE_TICKS(30틱≈3초) 지속 → oom_kill()
  oom_kill(): 가장 큰 유저 proc 을 killed=1 + RUNNABLE 로 만들어 종료시킴
              (init/sh/statd/oomd 는 oom_protected 로 보호)
3초 안에 oomd/호스트가 메모리를 풀면 카운터 리셋 → 커널 무개입 (LLM 우선)
```

### 3.3 추가 시스템콜 (PSI 패턴과 동일하게 5곳 등록)
| 번호 | 시스템콜 | 용도 |
|------|----------|------|
| 22 | `get_mem_pressure(struct psi_data*)` | PSI some/full avg10 |
| 23 | `get_sys_stat(struct sys_stat*)` | uptime/free/total/ncpu/PSI 등 시스템 스냅샷 |
| 24 | `get_proc_stats(struct proc_stat*, max)` | 프로세스별 상태/메모리/cpu/stall |
| 25 | `get_oom_candidates(struct oom_cand*, max)` | OOM 후보 (pid/name/sz_kb) |

구조체는 `kernel/types.h` 에 정의 (`psi_data`, `sys_stat`, `proc_stat`, `oom_cand`).

### 3.4 부팅 자동 실행 — `kernel/... user/init.c`
`init` 이 콘솔 fd 설정 직후, 셸을 띄우기 **전에** `statd 2 &` 와 `oomd &` 를
직접 fork+exec 한다. → 호스트 stdin 주입에 의존하지 않고 **어떤 실행 경로에서도**
부팅 즉시 상태 보고 + OOM 감시가 돌아간다.

---

## 4. xv6 유저 프로그램

| 프로그램 | 역할 | 출력/입력 |
|----------|------|-----------|
| `statd <period>` | 프로세스/CPU/메모리/PSI 주기 보고 | `@@STAT {json}` (period 틱마다, 기본 init=2≈5Hz) |
| `oomd` | PSI 감시 → 후보 수집 → 요청 → victim 종료 | `@@OOM_REQ {json}` 송신, `@@OOM_RESP` 수신, `kill()` |
| service 10종 | 메모리 보유 워크로드 (OOM 후보) | `<name> <MB>` (인자 없으면 28MB) |
| `oomgen` | 랜덤 부하 생성기 | — |
| `memhog <MB>` | 단순 메모리 점유 테스트 | — |

서비스 10종: `server database security endpoint cache logger gateway scheduler
analytics messaging` — 공통 본체 `user/service.h: service_main()`(인자 MB만큼 할당 후
페이지 터치, 이후 `pause()`로 점유 유지). 각자 별도 바이너리라 프로세스 테이블에
고유 이름으로 보인다.

### 태그 프로토콜 (콘솔 공유)
```
xv6 → host :  @@STAT     {"uptime":..,"free_pg":..,"psi_some":..,"procs":[{pid,st,name,sz_kb,cpu,stall},..]}
xv6 → host :  @@OOM_REQ  {"psi":..,"candidates":[{pid,name,sz_kb},..]}
host → xv6 :  @@OOM_RESP {"victims":[pid,..],"reasoning":".."}
kernel     :  [kernel-oom] out of memory: killed pid N (name, KB)   ← 커널 안전망 발동 시
```

---

## 5. 호스트 — Electron 인터페이스 (`xv6-interface/`)

| 파일 | 역할 |
|------|------|
| `main.js` | QEMU spawn(`make clean && make qemu`), 콘솔 라인 중계/파싱, @@STAT→`kstat:update`, @@OOM_REQ→LLM→@@OOM_RESP 주입, `.xv6_state` 브리지 기록, coomd 자식 실행, `[kernel-oom]`/`[oomd]` 줄 파싱 |
| `renderer.js` | 대시보드: 서비스 카드(회색/초록/빨강), 메모리 그래프, PSI, OOM 로그, 서버 용도 팝업, 커맨드바. 서비스별 메모리 가중치(평균 ~32MB) |
| `preload.js` | IPC 브리지 (contextBridge) |
| `index.html` / `styles.css` | UI 레이아웃/스타일 |

### 데이터 흐름
- **상태**: QEMU stdout → `routeQemuOutput()` → `@@STAT` → `handleStatLine()` →
  CPU% 델타 계산 → `kstat:update` 렌더 + `writeXv6StateForCoomd()` 로
  `coomd/.xv6_state` 기록.
- **OOM**: `@@OOM_REQ` → `handleOomReq()` → `decideOom()`(helper.py 또는 JS fetch
  또는 휴리스틱) → `@@OOM_RESP` 주입 + `oom:event(decision)` 렌더(카드 빨강).
- **kill 가시화**: `[oomd] killing pid N`(xv6 oomd), `[kernel-oom] ... killed pid N`
  (커널 안전망) 줄을 파싱해 대시보드에 반영.

---

## 6. 호스트 — coomd (병행 의사결정 데몬, `coomd/`)

xv6 프로세스를 직접 kill 할 수 없으므로(QEMU 안), **실제 xv6 상태를 읽어 압박을 감지하고
LLM 판단을 받아 결정을 보고**하는 병행 모니터. 인터페이스가 `--dry-run` 으로 자식 실행.

| 파일 | 역할 |
|------|------|
| `daemon/main.c` | 루프: `.xv6_state` 읽기 → 압박 시 helper.py 호출 → 검증 → EVENT 보고 |
| `daemon/xv6_state.c/.h` | `.xv6_state` 브리지 파서 (실제 PSI·프로세스, stale/부재 처리) |
| `daemon/validator.c/.h` | xv6 보호 대상(init/sh/oomd/statd/coomd) 방어 심층 |
| `LLM_client/helper.py` | Upstage Solar victim 선택 (`decide_victims`, 키 없으면 mock) |
| `host/monitor.py` | `@@STAT` → 텍스트 top 대시보드 (Electron 없이) |
| `host/relay.py` | `@@OOM_REQ` → LLM → `@@OOM_RESP` 주입 (Electron 없이) |
| `.xv6_state` | 인터페이스가 쓰는 브리지: `PSI <some> <full>` + `PROC <pid> <rss_kb> <name>` |

coomd stdout 계약(renderer/main.js 가 파싱): `EVENT {kind: startup|pressure|decision|kill|blocked|error, ...}`.

---

## 7. LLM 연동

- 모델: Upstage Solar (`coomd/LLM_client/helper.py`), `coomd/.env` 의 `UPSTAGE_API_KEY`.
- 입력 JSON: `{policy, candidates:[{pid,comm,rss_kb}], target_free_mb}`.
- 출력 JSON: `{victims:[pid,..], reasoning, confidence}`.
- 정책 = 기본 정책 + 커미셔닝 팝업의 **서버 용도(SERVER_PURPOSE)**.
- 키가 없으면 mock(시스템 제외 후 최대 메모리 프로세스 선택)으로 폴백.

---

## 8. OOM 의사결정 계층 (2-Layer)

```
1차 (스마트):  oomd → @@OOM_REQ → 호스트/LLM → @@OOM_RESP → kill(victim)
               정책(서버 용도)을 반영한 선택. 유예시간 안에 동작하면 이쪽이 처리.

2차 (안전망):  커널 update_psi() → free=0 + stall 3초 지속 → oom_kill(최대 proc)
               정책은 모르지만 liveness 보장. 1차가 실패할 때만 발동.
```

---

## 9. 메모리 예산 (현재 설정)

- 물리 RAM: **128 MB** (`Makefile -m 128M`, `memlayout.h PHYSTOP=KERNBASE+128MB`).
- 커널 관리 할당 가능: ~32,732 페이지 ≈ **127.9 MB** (페이지 4KB).
- 유저 가용: ~**127 MB** (init/sh/statd/oomd 소량 제외).
- 서비스 메모리 가중치(renderer.js): 평균 ~32MB → **서비스 약 5개면 압박 발생**,
  4개 이하는 보통 안전. (가장 가벼운 5개 합도 천장 초과하도록 설정)

---

## 10. 파일 맵 (핵심)

```
xv6-riscv/
  kernel/kalloc.c        # PSI stall, kmemexhausted()
  kernel/proc.c          # update_psi(), oom_kill(), 커널 OOM 안전망
  kernel/trap.c          # clockintr → ticks++, update_psi(), cpu_ticks
  kernel/sysproc.c       # get_sys_stat / get_proc_stats / get_oom_candidates / get_mem_pressure
  kernel/types.h         # psi_data, sys_stat, proc_stat, oom_cand
  user/init.c            # 부팅 시 statd & oomd 자동 실행
  user/statd.c           # @@STAT 보고 데몬
  user/oomd.c            # OOM 오케스트레이터 (@@OOM_REQ/@@OOM_RESP)
  user/service.h         # 서비스 공통 본체 service_main()
  user/<service>.c       # 서비스 10종 래퍼
  user/oomgen.c, memhog.c
  Makefile               # UPROGS (서비스 10종 + oomgen 포함), -m 128M
xv6-interface/
  main.js, renderer.js, preload.js, index.html, styles.css
coomd/
  daemon/main.c, xv6_state.c/.h, validator.c/.h
  LLM_client/helper.py
  host/monitor.py, relay.py
  .xv6_state             # 런타임 브리지 파일 (gitignore)
docs/  plan/             # 문서 / 계획
```

---

## 11. 실행 방법 (요약)

```bash
# A) Electron 인터페이스 (주 경로)
cd xv6-interface && npm install && npm start
#   → 서버 용도 팝업 입력 → 자동으로 make qemu 부팅 → init 이 statd/oomd 자동 실행
#   → 서비스 카드 5개쯤 ▶ start → 압박 → OOM victim(빨강)

# B) CLI
cd xv6-riscv && make qemu          # init 이 statd/oomd 자동 실행 (@@STAT 콘솔 출력)
cd coomd/host && python3 monitor.py   # 텍스트 대시보드
cd coomd/host && python3 relay.py     # LLM OOM relay
```

---

## 12. 최근 주요 변경 (이 구조에 반영됨)

- **coomd 재작성** — mock(하드코딩 PSI/chrome) 제거, `.xv6_state` 브리지로 실제 xv6
  데이터 반영. (validator 도 xv6 대상으로 교체)
- **서비스 10종 fs.img 누락 수정** — Makefile `UPROGS` 에 추가(누락 시 `exec` 실패).
- **서비스 메모리 가중치 재조정** — ~5개로 압박 발생하도록.
- **statd/oomd 자동 실행 이관** — 인터페이스 stdin 주입 → `init.c` 직접 실행.
- **커널 OOM 안전망 추가** — 메모리 데드락(동결) 제거. (`docs/oom_deadlock_fix.md`)
```
