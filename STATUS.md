# xv6 OOM Interface — 사용 방법 & 진행 상황

LLM 기반 OOM(Out-Of-Memory) 킬러를 xv6-riscv 커널 위에서 시연하는 프로젝트.
xv6 안에서 메모리 압박(PSI)을 감지하고, 호스트(Electron 인터페이스)가 LLM에게
"어떤 프로세스를 죽일지"를 서버 용도와 함께 물어 victim을 선택·종료한다.

> 최종 업데이트: 2026-06-04

---

## 1. 구성 요소

| 위치 | 역할 |
|------|------|
| `xv6-riscv/` | 커널 + 유저 프로그램 (PSI, statd, oomd, 서비스 10종, oomgen) |
| `xv6-interface/` | Electron 인터페이스 (대시보드, 팝업, LLM 호출 relay) |
| `coomd/` | 리눅스 측 C 데몬(참고 구현) + Python LLM 헬퍼 + CLI relay/monitor |
| `docs/`, `plan/` | 설계 문서 / 계획서 |

---

## 2. 사전 준비 (WSL2 / Linux)

```bash
# RISC-V 툴체인 + QEMU
sudo apt install gcc-riscv64-linux-gnu qemu-system-misc

# Node.js (Electron 인터페이스용)
node --version    # v18+ 권장

# LLM 키 (없으면 mock 모드로 동작)
cp coomd/.env.example coomd/.env   # UPSTAGE_API_KEY 입력
```

---

## 3. 실행 방법 (Electron 인터페이스)

```bash
cd xv6-interface
npm install        # 최초 1회
npm start
```

1. **SERVER COMMISSIONING 팝업**이 뜬다 → 이 서버의 용도를 입력 (프리셋 클릭 가능)
   → `▶ INITIALIZE SERVER`
2. 인터페이스가 자동으로 `make clean && make qemu`를 실행해 xv6를 빌드·부팅한다.
3. 부팅 성공 시 메인 패널이 **콘솔 → 서비스 대시보드**로 전환된다.
   (우상단 `DASHBOARD`/`CONSOLE` 버튼으로 수동 전환 가능)
4. `statd`(상태 보고)와 `oomd`(OOM 감시)는 **xv6의 `init`이 부팅 시 직접 자동 실행**한다
   (`user/init.c`). 호스트의 stdin 주입에 의존하지 않으므로, 어떤 실행 경로(인터페이스 /
   `make qemu` / relay.py)에서도 부팅 즉시 프로세스·CPU·메모리·PSI 보고가 시작된다.

### 프로세스(서비스) 실행 — 유저가 직접
- 각 서비스 카드의 `▶ start` 버튼, 또는
- 하단 **커맨드 입력창**에 직접 입력:

```
database 24 &      # <서비스이름> <메모리MB> &
cache 28 &
analytics 20 &
```

서비스 10종: `server database security endpoint cache logger gateway scheduler analytics messaging`
(메모리 비중은 타입별로 다름 — cache/database 큼, logger/scheduler 작음)

### 카드 색상 = 커널이 보고한 실제 상태
- **회색(OFFLINE)** — 미실행
- **초록(RUNNING)** — 실행 중 (pid·실제 점유 메모리 표시)
- **빨강(KILLED)** — OOM 킬러가 종료함

### OOM 유발
서비스를 충분히 띄워 메모리를 **초과 요청**(합계가 ~128MB 초과)하면 stall이 발생 →
PSI 상승 → oomd가 감지 → LLM이 서버 용도를 근거로 victim 선택 → 종료(카드 빨강).
빠르게 보려면 무거운 서비스 여러 개를 연속 실행하거나, 콘솔에서 `oomgen` 실행.

---

## 4. CLI 대안 (Electron 없이)

```bash
# A. 그냥 xv6만
cd xv6-riscv && make qemu
#   xv6 셸에서:  statd 2 &   그리고   database 24 &   ...

# B. 텍스트 대시보드 (호스트 Python)
cd coomd/host && python3 monitor.py     # @@STAT를 top 형태로 렌더

# C. LLM OOM relay (xv6 ↔ Solar)
cd coomd/host && python3 relay.py
```

xv6 셸 주요 명령:
```
statd 2 &          # 상태 보고 데몬 (2틱≈0.2초 주기)
oomd &             # OOM 감시 데몬 (PSI 임계 10%)
<service> <MB> &   # 서비스 실행 (예: database 24 &)
oomgen             # 랜덤 부하 자동 생성 (메모리 부족까지)
kill <pid>         # 프로세스 종료
```

---

## 5. 진행 상황 (완료)

### xv6 커널/유저
- [x] 빌드 복구 — 누락된 `mkfs/mkfs.c` 복원, `strncmp` 추가
- [x] **PSI 메커니즘** — `kalloc` stall 감지, some/full avg10 EMA, **avg60(60초창)** 추가
- [x] **statd** — 메모리(free/total page)·프로세스(이름/메모리/cpu_ticks/stall)·CPU·PSI를
      `@@STAT {json}`으로 주기 보고. **실측 검증 완료** (수치 정확)
- [x] **oomd** — PSI 감시 → `@@OOM_REQ` 송신 → `@@OOM_RESP` 수신 → `kill`
- [x] **서비스 10종 + service.h** — 타입별 메모리 비중으로 실제 RAM 점유
- [x] **oomgen** — 랜덤 부하 생성기 (메모리 부족 감지까지)

### 인터페이스 (Electron)
- [x] 서버 용도 **팝업**(영문) → LLM 프롬프트에 용도 주입 (Python/JS 양쪽 경로)
- [x] 부팅 성공 시 **콘솔→대시보드** 전환
- [x] **서비스 카드** (가상 폼 + 회색/초록/빨강 상태), 우측 **메모리 그래프**, 하단 **커맨드 입력창**
- [x] `statd`/`oomd` **자동 실행**, statd 빠른 주기(~5Hz)로 즉각 갱신
- [x] OOM victim → 카드 빨강 처리, oomd 콘솔 줄 파싱(threshold/kill)
- [x] 메모리 그래프 축 안정화(천장 붙음 현상 수정)

### coomd / Python
- [x] 리눅스 coomd를 **실제 xv6 상태**로 구동(mock chrome/firefox 제거, 브리지 파일)
- [x] 전체 영문화 (main.c / helper.py / validator)
- [x] `monitor.py` 파싱 검증 완료 (필드명·계산 정확)

### 검증 (헤드리스 QEMU + 정적 분석)
- [x] xv6의 메모리/프로세스/CPU/PSI 출력 정확성 실측
- [x] main.js·monitor.py의 `@@STAT` 파싱 정확성
- [x] psi_some60이 압박 시 0→64% 단조 상승 (정수 EMA 절삭 버그 수정: scale 1e6)

---

## 6. ✅ 해결된 문제 (대시보드가 실제 xv6 상태를 반영하지 않음)

### 증상
서비스를 띄워도 **카드가 초록(RUNNING)으로 바뀌지 않고 회색(OFFLINE)에 머물거나**,
애초에 xv6 부팅/프로세스 실행 자체가 진행되지 않아 대시보드가 빈/미실행 상태로 보임.

### 근본 원인 (확정)
- **xv6 자체는 정상**: 헤드리스 QEMU에서 `statd 2 &` + `database 24 &` 등을 실행하면
  `@@STAT`에 올바른 이름·메모리·상태로 보고됨 (재검증 완료). 데이터 경로·카드 매칭 정상.
- **진짜 원인은 Electron 기동 경로**였다: `startQemu()`가 `ready-to-show` 이벤트에서만
  호출됐는데, **WSLg에서 GPU 초기화 오류(`Exiting GPU process ...`)로 창이 그려지지 않으면
  `ready-to-show`가 발화하지 않아 xv6 부팅 자체가 시작되지 않았다.** → 대시보드 영구 공백.

### 적용한 수정 (`xv6-interface/main.js`)
1. **GPU 비활성화(소프트웨어 렌더링 강제)** — 모듈 상단에서 `app.disableHardwareAcceleration()`
   + `--disable-gpu --disable-gpu-compositing --no-sandbox` 스위치 설정(앱 `ready` 이전).
   `XV6_KEEP_GPU=1`로 opt-out 가능. → WSLg GPU 크래시 제거.
2. **부팅 트리거 다중화** — 부팅 시퀀스를 `bootOnce()`(1회 가드)로 묶고
   `ready-to-show` / `did-finish-load` / 4초 타임아웃 **셋 중 먼저 발화하는 것**으로 호출.
   창 표시도 동일하게 보강(`revealWindow()`). → 어떤 환경이든 xv6가 반드시 부팅됨.
3. **모니터 자동기동 견고화** — `statd`/`oomd` 자동 실행 트리거를 단일 라인이 아니라
   누적 콘솔 스트림(`consoleTail`)에서 `init: starting sh` / `$ ` 프롬프트로 판정.
   청크 분할로 라인이 쪼개져도 누락되지 않음.

### 검증
- WSL에서 `npm start` → `bootOnce` 발화 → `make qemu` → `qemu-system-riscv64` 부팅 확인.
- coomd 브리지 파일(`coomd/.xv6_state`)에 `statd`·`oomd` 포함 실제 프로세스가 기록됨
  → `@@STAT` 파싱·`kstat:update` 경로가 대시보드까지 흐름을 확인. GPU 크래시 0건.

---

## 7. 주요 파일

```
xv6-riscv/
  kernel/proc.c, kalloc.c, trap.c   # PSI, cpu_ticks, stall
  kernel/sysproc.c, types.h         # get_sys_stat / get_proc_stats / psi_data
  user/statd.c                      # @@STAT 보고 데몬
  user/oomd.c                       # OOM 오케스트레이터
  user/service.h, <service>.c       # 서비스 10종 본체/래퍼
  user/oomgen.c                     # 랜덤 부하 생성기
xv6-interface/
  main.js        # QEMU spawn, @@STAT/@@OOM relay, statd/oomd 자동주입, LLM 호출
  renderer.js    # 대시보드/카드/그래프/팝업/커맨드바
  index.html, styles.css
coomd/
  daemon/main.c           # 데몬 루프: 브리지 읽기 → 압박 감지 → LLM → 검증/보고
  daemon/xv6_state.c/.h   # .xv6_state 브리지 파일 파서 (실제 xv6 PSI·프로세스)
  daemon/validator.c/.h   # xv6 보호 대상(init/sh/oomd/statd/coomd) 방어 심층
  LLM_client/helper.py    # Upstage Solar victim 선택 (키 없으면 mock)
  host/monitor.py, relay.py
```