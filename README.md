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

