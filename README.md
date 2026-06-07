# Conversational OOM Killer

> 📌 **이 프로젝트는 두 브랜치로 구성됩니다 / This project spans two branches:**
> - **`main`** — Linux 데몬(`coomd`) · 정책 부합률 평가(100%) · 최종 문서(Technical Report / Development Process)
> - **`xv6-interface-d`** — xv6 커널 PSI 구현 + Electron 실시간 모니터 (라이브 데모 / live demo)


> An LLM-guided replacement for Linux's OOM killer, driven by a user-written natural-language priority policy.

**Direction:** B — LLM for OS
**Course:** Operating Systems · Team Project (Weeks 9–14)
**LLM Backend:** Upstage Solar Pro

---

## 📝 Summary

Linux's OOM killer picks victims by a numeric `oom_score` that ignores user intent. Your active VS Code can be killed before a backgrounded Chrome window, because the kernel has no idea what you actually care about.

**Conversational OOM Killer** replaces that mechanism with a system driven by a one-paragraph, user-written priority policy. On memory pressure (detected via PSI), it collects process metadata, asks Upstage Solar Pro to pick victims under the user's policy, validates the response against a hard-coded safety ruleset (never PID 1, systemd, sshd, or the daemon itself), and dispatches `SIGTERM` → `SIGKILL`.

The project is realized at **two levels**: a Linux userspace daemon (`coomd`) used for quantitative evaluation, and an **xv6 kernel** implementation with a real-time monitoring interface used for the live demo.

---

## 🗓 Project Status

- ✅ Week 9 — Team formed, direction picked, repository initialized
- ✅ Week 10 — Problem statement, architecture sketch, OS concept mapping
- ✅ Week 11 — End-to-end LLM integration working (C ↔ Python via fork+exec+pipe)
- ✅ Week 12 — Real `/proc` integration + policy-compliance evaluation (100%)
- ✅ Week 13 — Results integrated, all docs translated to English, repo cleaned
- ✅ Week 14 — xv6 kernel PSI + Electron monitor; final presentation (English)

---

## 👥 Team

| Student ID | Name | Role | Component |
|---|---|---|---|
| 2021270017 | Roh Hyukjun (Leader) | R5 | Documentation / Integration / Evaluation |
| 2022270635 | Baek Seonha | R4 | Integration Daemon (C) |
| 2024270639 | Kang Gyuhyeon | R1 | PSI Monitor (C) / xv6 |
| 2017271134 | Lee Seungwon | R3 | LLM Helper (Python) / Presenter |
| 2023270626 | Lee Yujin | R2 | `/proc` Reader (C) |

---

## 🧩 Component Status

| Component | Language | Status | Notes |
|---|---|---|---|
| Main Daemon | C | ✅ Done | Main loop, option parsing, logging |
| Validator | C | ✅ Done | Whitelist protection (PID 1, systemd, etc.) |
| LLM Helper | Python | ✅ Done | Live Solar Pro API + mock fallback |
| C ↔ Python IPC | C | ✅ Done | `fork()` + `execlp()` + `pipe()`, bidirectional |
| PSI Monitor | C | ✅ Done | Reads real `/proc/pressure/memory` |
| `/proc` Reader | C | ✅ Done | Parses real `/proc/[pid]/*` (22 processes verified) |
| xv6 PSI (kernel) | C | ✅ Done | `some_avg10` measured 0% → 9% under QEMU |
| xv6 Monitor (Electron) | JS | ✅ Done | Real-time dashboard — services, memory, OOM log |
| Policy Compliance Evaluation | — | ✅ Done | 5 scenarios, **100%** compliance |

---

## 📁 Repository Layout

```
.
├── README.md
├── LICENSE
├── Makefile                        xv6-riscv build
│
├── coomd/                          🔥 Core: Conversational OOM daemon (Linux)
│   ├── Makefile                    gcc -Wall -Wextra -O2 -g
│   ├── daemon/                     C source
│   │   ├── main.c                  Entry, main loop, IPC, signal dispatch (R4)
│   │   ├── validator.c / .h        Hard-coded safety ruleset (R4)
│   │   ├── psi_monitor.*           Real /proc/pressure/memory reader (R1)
│   │   └── proc_reader.*           Real /proc/[pid] parser (R2)
│   └── LLM_client/
│       └── helper.py               stdin/stdout JSON loop + Solar API (R3)
│
├── xv6-interface/                  🖥 xv6 real-time monitor (Electron) (R1)
│   ├── main.js                     QEMU spawn + console relay + LLM bridge
│   ├── renderer.js / index.html    Dashboard UI
│   └── styles.css
│
├── xv6-riscv/                      xv6-riscv kernel + user (in-kernel PSI)
│
├── docs/                           📚 Design & report documents (R5)
│   ├── PROJECT.md                  Course brief
│   ├── problem.md                  Problem definition
│   ├── architecture.md / .png      Component architecture + diagram
│   ├── os_concepts.md              OS concept mapping
│   ├── evaluation_design.md        Evaluation methodology
│   ├── evaluation_results.md       Evaluation results (100%)
│   ├── development_process.md      Development process document
│   ├── xv6_kernel_monitor.md       xv6 kernel monitoring design
│   ├── xv6_electron_monitor.md     Electron interface design
│   ├── xv6_llm_integration.md      xv6 ↔ LLM integration
│   └── xv6_porting.md              xv6-riscv porting design
│
└── plan/                           Planning notes
```

---

## 🚀 Quick Start

### A) Linux userspace daemon (`coomd`)

**1) Build**

```bash
cd coomd
make
```

Output: `coomd/bin/coomd`

**2) Environment variable (for live Solar API)**

```bash
export UPSTAGE_API_KEY="your_api_key_here"
```

> Without an API key, `helper.py` automatically falls back to mock mode.

**3) Write a policy** (`~/.oom_policy` or any path)

```text
I am coding. Never kill firefox. Chrome tabs are fine to kill first.
```

**4) Run (dry-run recommended)**

```bash
./bin/coomd --dry-run --policy ~/.oom_policy
```

### B) xv6 kernel monitor (Electron demo)

```bash
cd xv6-interface
npm install
npm start
```

Requires a RISC-V toolchain (`gcc-riscv64-linux-gnu`) and `qemu-system-riscv64`. On launch, set the server purpose (natural-language policy) in the popup; run services to drive memory toward an OOM event and watch the dashboard.

---

## 🎯 Demo (Linux `coomd`, real `/proc` data)

```
$ ./bin/coomd --dry-run

[R4 Main Loop] PSI some_avg10: 16.50% (threshold: 15.00%)
🚨 [ALERT] Memory pressure detected — starting OOM handling

[R2 Introspector] 22 candidate processes found (real /proc scan)
  -> PID  210 | unattended-upgr | 22144 kB
  -> PID   42 | systemd-journal | 15616 kB
  -> PID    1 | systemd         | 12336 kB
  ... (22 total)

[R3 LLM Helper] Requesting victim selection based on user policy...
  🤖 AI selection: unattended-upgr (PID 210)
  💬 Rationale: Only unattended-upgr is a non-system process not
     protected by the policy. No other candidates are eligible.

  🎯 victim → PID 210 (unattended-upgr)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] Simulated SIGTERM sent
```

Among 22 real processes, the AI avoided all system processes and selected the only non-system, non-protected one — driven by user intent, not memory size.

---

## 🧠 OS Concepts in Play

| OS Concept | Where | Owner |
|---|---|---|
| cgroups v2 / PSI | `/proc/pressure/memory` polling (Linux) + in-kernel PSI (xv6) | R1 |
| `/proc` filesystem | Process metadata collection | R2 |
| `fork` + `execlp` | C spawns the Python helper as a child | R4 |
| pipe IPC | stdin/stdout JSON between C and Python | R4 |
| `kill` / signals | SIGTERM → 5s → SIGKILL | R4 |
| Zombie reaping | `waitpid(WNOHANG)` | R4 |

See [`docs/os_concepts.md`](docs/os_concepts.md) for details.

---

## 📚 Documentation

| Document | Contents |
|---|---|
| [`docs/problem.md`](docs/problem.md) | Limitations of the default OOM Killer and our approach |
| [`docs/architecture.md`](docs/architecture.md) | Component architecture |
| [`docs/os_concepts.md`](docs/os_concepts.md) | OS concept mapping |
| [`docs/evaluation_design.md`](docs/evaluation_design.md) | Baseline vs `coomd` evaluation methodology |
| [`docs/evaluation_results.md`](docs/evaluation_results.md) | Evaluation results (100% policy compliance) |
| [`docs/development_process.md`](docs/development_process.md) | Planning → execution → retrospective |
| [`docs/PROJECT.md`](docs/PROJECT.md) | Course brief |

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Daemon | C11, GCC, `-Wall -Wextra -O2 -g` |
| LLM module | Python 3, OpenAI SDK (Solar API compatible) |
| LLM backend | Upstage Solar Pro (`temperature=0`, JSON-enforced) |
| IPC | `fork()` + `execlp()` + `pipe()` + `dup2()` |
| Kernel | xv6-riscv (in-kernel PSI), QEMU |
| Interface | Electron (real-time xv6 monitor) |
| Environment | Linux (Ubuntu 22.04+, kernel 4.20+ for PSI, cgroups v2) |

---

## 📜 License

See [LICENSE](LICENSE).
