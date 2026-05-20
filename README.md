# kus-operating-system-project

# Conversational OOM Killer

> An LLM-guided replacement for Linux's OOM killer, driven by a user-written natural-language priority policy.

**Direction:** B - LLM for OS
**Course:** Operating Systems · Team Project (Weeks 9–14)
**LLM Backend:** Upstage Solar Pro 3

---

## 📝 Summary

Linux's OOM killer picks victims by a numeric `oom_score` that ignores user intent. Your active VS Code can be killed before a backgrounded Chrome window, because the kernel has no idea what you actually care about.

**Conversational OOM Killer** replaces that mechanism with a userspace daemon driven by a one-paragraph, user-written priority policy. On memory pressure (detected via PSI), the daemon collects `/proc` process metadata, asks Upstage Solar Pro 3 to pick victims under the user's policy, validates the response against a hard-coded safety ruleset (never PID 1, systemd, sshd, or the daemon itself), and dispatches `SIGTERM` → `SIGKILL`.

**Example policy** (`~/.oom_policy`):

> *"I'm doing development work. Never kill VS Code, gcc, cargo, or npm. Browser tabs are low priority — kill those first. Spotify is fine to terminate. Protect any Docker container whose name starts with `dev-`."*

---

## 🏗 Architecture

![Architecture](docs/architecture.png)

The system consists of two processes:

- **Main Daemon (`coomd`)** — C, runs as root. Handles PSI monitoring, `/proc` introspection, IPC, validation, and signal dispatch.
- **LLM Helper** — Python child process. Spawned by the daemon via `fork`+`execlp`. Communicates over `pipe`s with line-delimited JSON. Calls the Solar API.

See [docs/02_architecture.md](docs/02_architecture.md) for component-level details and data flow.

---

## 🧠 OS Concepts in Play

| Concept | Where it appears | Owner |
|---------|------------------|-------|
| Memory management / cgroups v2 / PSI | `/proc/pressure/memory` polling triggers the decision loop | R1 |
| `/proc` filesystem introspection | Process metadata collection (`status`, `cmdline`, `oom_score`) | R2 |
| Process creation (`fork` + `execlp`) | C daemon spawns Python LLM helper | R4 |
| IPC via pipe | Bidirectional JSON over stdin/stdout | R4 |
| Signals & process lifecycle | `SIGTERM` → wait → `SIGKILL` escalation, zombie reaping with `waitpid` | R4 |
| Cache replacement policy (bonus) | Decision cache (LRU-inspired) to mitigate LLM latency | Week 12+ |

See [docs/03_os_concepts.md](docs/03_os_concepts.md) for the full mapping with file paths.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| OS | Ubuntu 22.04 / 24.04 (cgroups v2 + PSI required) |
| Daemon | C (PSI monitor, `/proc` reader, IPC, validator, dispatcher) |
| LLM client | Python 3.11 (Solar API via OpenAI-compatible SDK) |
| IPC | Unix pipes between C daemon ↔ Python helper |
| LLM | Upstage Solar Pro 3 |
| Evaluation | Python (`pandas`, `matplotlib`), `stress-ng` for synthetic load |
| Dev environment | VirtualBox / multipass / UTM (host execution forbidden) |

---

## ⚙️ Setup

### 0. Prerequisites — VM only

> ⚠️ **This project sends real signals to real processes. Always run inside a VM.**
> A hard-coded whitelist (PID 1, systemd, sshd, the daemon itself) is enforced before any signal dispatch, but mistakes happen during development.

- Ubuntu 22.04 or 24.04 inside VirtualBox / multipass / UTM
- 2 GB RAM minimum (4 GB recommended for load testing)
- Verify PSI is available:
  ```bash
  cat /proc/pressure/memory
  # If the file exists, PSI is enabled.
  # Otherwise, add psi=1 to GRUB_CMDLINE_LINUX_DEFAULT in /etc/default/grub,
  # then run update-grub and reboot.
  ```

### 1. Install dependencies

```bash
sudo apt update
sudo apt install -y build-essential libcurl4-openssl-dev python3.11 python3.11-venv stress-ng
```

### 2. Clone and build

```bash
git clone <this-repo-url>
cd conversational-oom-killer

# Python helper venv
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# C daemon
make
```

### 3. Get a Solar API key

- **Team key:** distributed by the instructor; received by the team representative.
- **Personal key:** apply at <https://www.upstage.ai/events/ai-initiative-2025-ko>.
- **API docs:** <https://console.upstage.ai/docs>

### 4. Configure environment variables

```bash
cp .env.example .env
# Edit .env and fill in UPSTAGE_API_KEY
```

> 🚨 **Never commit `.env`.** It is gitignored. If you accidentally push a key, rotate it immediately.

### 5. Write your priority policy

```bash
cat > ~/.oom_policy <<'EOF'
I'm doing development work. Never kill VS Code, gcc, cargo, or npm.
Browser tabs are low priority — kill those first.
Spotify and music apps are fine to terminate.
Protect any Docker container whose name starts with "dev-".
EOF
```

---

## 🚀 How to Run

### Dry-run mode (recommended for first run)

```bash
sudo ./bin/coomd --policy ~/.oom_policy --dry-run
```

Prints victim decisions to stderr without dispatching signals. Use this until you trust the validator.

### Live mode

```bash
sudo ./bin/coomd --policy ~/.oom_policy
```

The daemon runs in the foreground. Logs go to `/var/log/coomd.log`.

### Trigger a test scenario

In a second terminal inside the same VM:

```bash
# Gradual memory leak
python3 eval/scenarios/gradual_leak.py

# Sudden large allocation
python3 eval/scenarios/sudden_alloc.py 4000  # 4 GB
```

### Baseline comparison

```bash
sudo eval/run_comparison.sh
# Runs the same scenario under (a) stock Linux OOM and (b) coomd,
# then prints which processes survived in each mode.
```

---

## 📊 Demo

_Coming Week 11._

Planned demo: side-by-side comparison of stock Linux OOM killing VS Code vs. `coomd` honoring the user policy and killing browser tabs instead.

---

## 📚 Documentation

| Document | Content |
|----------|---------|
| [Problem Statement](docs/01_problem.md) | Why this project exists |
| [Architecture](docs/02_architecture.md) | Component overview and data flow |
| [OS Concepts](docs/03_os_concepts.md) | OS concept → code mapping |
| [Evaluation Design](docs/04_evaluation_design.md) | How we measure success |
| [xv6 Porting Design](docs/05_xv6_porting.md) | Sketch of porting to xv6-riscv |

---

## 🗓 Project Status

- ✅ Week 9 — Team formed, direction picked, repository initialized
- 🟡 Week 10 — Problem statement, architecture sketch, OS concept mapping (in progress)
- ⬜ Week 11 — Minimal working prototype (LLM call works end-to-end, OS components stubbed)
- ⬜ Week 12 — Integrated prototype + evaluation metrics defined
- ⬜ Week 13 — Evaluation results + presentation dry-run
- ⬜ Week 14 — Final presentation (English)

---

## 📁 Repository Layout

```
.
├── README.md
├── .gitignore
├── .env.example
├── requirements.txt
├── Makefile
├── bin/
│   └── coomd                       Compiled daemon binary
├── daemon/                         C source
│   ├── main.c                      Entry point, main loop
│   ├── psi_monitor.c               /proc/pressure/memory polling (R1)
│   ├── proc_reader.c               /proc/[pid]/* parsing (R2)
│   ├── ipc.c                       Pipe-based IPC to Python helper (R4)
│   ├── validator.c                 Hard-coded safety ruleset (R4)
│   └── dispatcher.c                Signal dispatch (R4)
├── llm_client/                     Python helper
│   ├── helper.py                   stdin/stdout JSON loop (R3)
│   ├── solar.py                    Solar API client (R3)
│   └── prompts.py                  System & user prompt templates (R3)
├── policy/
│   └── whitelist.h                 Protected PIDs / commands
├── eval/
│   ├── scenarios/                  Synthetic load scripts (R5)
│   └── run_comparison.sh           Baseline vs. coomd harness (R5)
└── docs/                           (R5)
    ├── 01_problem.md
    ├── 02_architecture.md
    ├── 03_os_concepts.md
    ├── 04_evaluation_design.md
    ├── 05_xv6_porting.md
    ├── architecture.png
    └── architecture.excalidraw
```

---

## 👥 Team

| Name | Role | Component |
|------|------|-----------|
| [ Name ] | R1 | PSI monitor (C) |
| [ Name ] | R2 | `/proc` introspector (C) |
| [ Name ] | R3 | LLM helper (Python) + prompts |
| [ Name ] | R4 | Integration daemon + validator (C) |
| [ Name ] | R5 | Evaluation + documentation + xv6 design |

---

## 🙏 Acknowledgments

- LLM backend: [Upstage Solar Pro 3](https://console.upstage.ai/docs)
- Development tool: Claude Code (1-month team license)
- Course materials: [xv6-riscv](https://github.com/mit-pdos/xv6-riscv)

---

## 📜 License

MIT (subject to team decision before public release).
