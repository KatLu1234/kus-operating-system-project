# Conversational OOM Killer

> An LLM-guided replacement for Linux's OOM killer, driven by a user-written natural-language priority policy.

**Direction:** B — LLM for OS
**Course:** Operating Systems · Team Project (Weeks 9–14)
**LLM Backend:** Upstage Solar Pro

---

## 📝 Summary

Linux's OOM killer picks victims by a numeric `oom_score` that ignores user intent. Your active VS Code can be killed before a backgrounded Chrome window, because the kernel has no idea what you actually care about.

**Conversational OOM Killer (`coomd`)** replaces that mechanism with a userspace daemon driven by a one-paragraph, user-written priority policy. On memory pressure (detected via PSI), the daemon collects `/proc` process metadata, asks Upstage Solar Pro to pick victims under the user's policy, validates the response against a hard-coded safety ruleset (never PID 1, systemd, sshd, or the daemon itself), and dispatches `SIGTERM` → `SIGKILL`.

---

## 🗓 Project Status

- ✅ Week 9 — Team formed, direction picked, repository initialized
- ✅ Week 10 — Problem statement, architecture sketch, OS concept mapping
- ✅ Week 11 — End-to-end LLM integration working (mock PSI / dummy candidates)
- 🟡 Week 12 — Real `/proc` integration + evaluation metrics (in progress)
- ⬜ Week 13 — Evaluation results + presentation dry-run
- ⬜ Week 14 — Final presentation (English)

---

## 👥 Team

| 학번 | 이름 | 역할 | 컴포넌트 |
|---|---|---|---|
| 2021270017 | 노혁준 (조장) | R5 | 문서 / 평가 / LLM Helper |
| 2022270635 | 백선하 | R4 | 통합 데몬 (C) |
| 2024270639 | 강규현 | R1 | PSI Monitor (C) |
| 2017271134 | 이승원 | R3 | LLM Helper (Python) |
| 2023270626 | 이유진 | R2 | `/proc` Reader (C) |

---

## 🧩 Component Status

| Component | Language | Status | Notes |
|---|---|---|---|
| Main Daemon | C | ✅ Done | 메인 루프, 옵션 파싱, 로깅 |
| Validator | C | ✅ Done | PID 1, systemd 등 화이트리스트 보호 |
| LLM Helper | Python | ✅ Done | Solar Pro API 실연동 + mock fallback |
| C ↔ Python IPC | C | ✅ Done | `fork()` + `execlp()` + `pipe()` 양방향 |
| PSI Monitor | C | 🟡 In progress | 현재 고정값, 실제 `/proc/pressure/memory` 연동 예정 |
| `/proc` Reader | C | 🟡 In progress | 현재 더미 후보, 실제 `/proc/[pid]/*` 파싱 예정 |

---

## 📁 Repository Layout

```
.
├── README.md
├── LICENSE
├── Makefile                        xv6-riscv build
├── test-xv6.py                     xv6 QEMU automation
├── .gitignore, .editorconfig, .dir-locals.el, .gdbinit.tmpl-riscv
│
├── coomd/                          🔥 핵심: 대화형 OOM 킬러 데몬 (Linux)
│   ├── Makefile                    gcc -Wall -Wextra -O2 -g
│   ├── daemon/                     C source
│   │   ├── main.c                  Entry, main loop, IPC, signal dispatch (R4)
│   │   ├── validator.c / .h        Hard-coded safety ruleset (R4)
│   │   ├── psi_monitor.h           Header — implementation pending (R1)
│   │   └── proc_reader.h           Header — implementation pending (R2)
│   └── LLM_client/
│       └── helper.py               stdin/stdout JSON loop + Solar API (R3)
│
├── docs/                           📚 설계 문서 (R5)
│   ├── PROJECT.md                  수업 안내 (원문)
│   ├── problem.md                  문제 정의
│   ├── architecture.md             7개 컴포넌트 상세
│   ├── architecture.png            아키텍처 다이어그램
│   ├── os_concepts.md              OS 개념 매핑 표
│   ├── evaluation_design.md        평가 방법론
│   └── xv6_porting.md              xv6-riscv 포팅 설계 (이론)
│
├── plan/                           진행 메모
│   ├── psi.md
│   └── r4_development_plan.md
│
├── kernel/                         xv6-riscv 커널 (45 files)
└── user/                           xv6 유저 프로그램 (25 files)
```

---

## 🚀 Quick Start

### 1) 빌드

```bash
cd coomd
make
```

산출물: `coomd/bin/coomd`

### 2) 환경 변수 (Solar API 사용 시)

```bash
export UPSTAGE_API_KEY="your_api_key_here"
```

> API 키가 없으면 `helper.py`가 자동으로 mock 모드로 fallback 합니다.

### 3) 정책 파일 작성

`~/.oom_policy` 또는 임의 경로에 자연어로 정책을 작성합니다.

```text
I am coding. Never kill firefox. Chrome tabs are fine to kill first.
```

### 4) 실행 (dry-run 권장)

```bash
./bin/coomd --dry-run --policy ~/.oom_policy
```

---

## 🎯 Demo

```
$ ./bin/coomd --dry-run
[R4 Main Loop] PSI some_avg10: 16.50% (임계값: 15.00%)
🚨 [ALERT] 메모리 위험 신호 감지 — OOM 처리 시작
[R2] 종료 후보 3개 발견
  -> PID 9999 | chrome  | 1245000 kB
  -> PID 8888 | firefox |  512000 kB
  -> PID    1 | systemd |    4096 kB
[R3 LLM Helper] 사용자 정책 기반 victim 선택 요청...
  🤖 AI 선택: chrome (PID 9999)
  💬 판단 근거: Selected chrome as it's marked 'fine to kill
     first' and frees 1215 MB, exceeding the 500 MB target.
     Avoided killing firefox and systemd per policy.
  🎯 victim → PID 9999 (chrome)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] SIGTERM 가상 전송
```

> **주의:** 현재 PSI 값과 후보 프로세스는 mock 데이터입니다. Week 12에서 실제 `/proc` 연동으로 전환 예정.

---

## 🧠 OS Concepts in Play

| OS 개념 | 어디서 | 담당 |
|---|---|---|
| cgroups v2 / PSI | `/proc/pressure/memory` 폴링 | R1 |
| `/proc` 파일시스템 | 프로세스 메타데이터 수집 | R2 |
| `fork` + `execlp` | C가 Python helper 자식 띄움 | R4 |
| pipe IPC | stdin/stdout JSON | R4 |
| `kill` / `waitpid` | SIGTERM → 5s → SIGKILL | R4 |
| 좀비 회수 | `waitpid(WNOHANG)` | R4 |

자세한 내용은 [`docs/os_concepts.md`](docs/os_concepts.md) 참조.

---

## 📚 Documentation

| 문서 | 내용 |
|---|---|
| [`docs/problem.md`](docs/problem.md) | 기존 OOM Killer의 한계와 우리의 접근 |
| [`docs/architecture.md`](docs/architecture.md) | 7개 컴포넌트 상세 설계 |
| [`docs/os_concepts.md`](docs/os_concepts.md) | OS 수업 개념 매핑 |
| [`docs/evaluation_design.md`](docs/evaluation_design.md) | Baseline vs `coomd` 평가 방법론 |
| [`docs/xv6_porting.md`](docs/xv6_porting.md) | xv6-riscv 포팅 설계 (이론) |
| [`docs/PROJECT.md`](docs/PROJECT.md) | 수업 안내 원문 |

---

## 🛠 Tech Stack

| 구분 | 기술 |
|---|---|
| Daemon | C11, GCC, `-Wall -Wextra -O2 -g` |
| LLM 모듈 | Python 3, OpenAI SDK (Solar API 호환) |
| LLM 백엔드 | Upstage Solar Pro (`temperature=0`, JSON 강제) |
| IPC | `fork()` + `execlp()` + `pipe()` + `dup2()` |
| 환경 | Linux (Ubuntu 22.04+, kernel 4.20+ for PSI, cgroups v2) |

---

## 📜 License

See [LICENSE](LICENSE).
