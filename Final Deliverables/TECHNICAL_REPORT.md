# Technical Report — Conversational OOM Killer

> Direction B — LLM for OS
> Operating Systems Team Project · Team 06

---

## 1. System Architecture

### 1.1 Overview

The Conversational OOM Killer replaces the Linux kernel's score-based victim selection with a pipeline driven by a user-written natural-language policy. An LLM *recommends* a victim; a deterministic C validator makes the *final, safe* decision.

The system is implemented at **two levels**:
- **Linux userspace** (`coomd`) — the primary track, used for quantitative evaluation.
- **xv6 kernel** — the same PSI mechanism implemented in-kernel, with an Electron monitoring interface used for the live demo.

### 1.2 Block Diagram (Linux `coomd`)

```
            ┌──────────────────────────────────────────────────────┐
            │                    coomd daemon (C)                   │
            │                                                       │
  /proc/    │   ┌──────────────┐      ┌───────────────────────┐     │
 pressure/ ─┼─► │ PSI Monitor  │      │   Main Loop (R4)      │     │
  memory    │   │   (R1)       │ ───► │  - orchestration      │     │
            │   └──────────────┘      │  - validation         │     │
            │                         │  - signal dispatch    │     │
  /proc/    │   ┌──────────────┐      │                       │     │
 [pid]/* ──┼─► │ /proc Reader  │ ───► │   ┌───────────────┐   │     │
            │   │   (R2)       │      │   │  Validator(R4)│   │     │
            │   └──────────────┘      │   │  whitelist    │   │     │
            │                         │   └───────────────┘   │     │
            │                         └───────────┬───────────┘     │
            │                              fork+exec+pipe (IPC)      │
            │                                     │                  │
            │                         ┌───────────▼───────────┐     │
            │                         │   LLM Helper (R3,Py)   │     │
            │                         │   Solar Pro API        │     │
            │                         └───────────┬───────────┘     │
            └─────────────────────────────────────┼─────────────────┘
                                                   │
                                          SIGTERM → SIGKILL
                                                   ▼
                                          victim process
```

**Flow:** PSI Monitor detects memory pressure → /proc Reader collects real process candidates → Main Loop sends {policy, candidates} to the LLM Helper over a pipe → LLM returns a victim as JSON → Validator checks it against a whitelist → Main Loop dispatches signals.

### 1.3 Components

| # | Component | Owner | Language | Responsibility |
|---|-----------|-------|----------|----------------|
| 1 | PSI Monitor | R1 | C | Polls `/proc/pressure/memory`; triggers on threshold crossing |
| 2 | /proc Reader | R2 | C | Scans `/proc`, collects process metadata (comm, RSS, uid) |
| 3 | Main Loop | R4 | C | Orchestrates the full cycle |
| 4 | IPC | R4 | C | `fork` + `execlp` + `pipe` to the Python helper |
| 5 | LLM Helper | R3 | Python | Calls Upstage Solar Pro, returns victim as JSON |
| 6 | Validator | R4 | C | Hard-coded whitelist protecting system processes |
| 7 | Signal Dispatcher | R4 | C | `SIGTERM` → grace period → `SIGKILL`; reaps zombies |

---

## 2. Tech Stack

| Layer | Technology |
|-------|------------|
| Daemon | C11, GCC (`-Wall -Wextra -O2 -g`) |
| LLM module | Python 3, OpenAI-compatible SDK |
| LLM backend | Upstage Solar Pro (`temperature=0`, JSON-enforced output) |
| IPC | `fork()` + `execlp()` + `pipe()` + `dup2()` |
| Kernel | xv6-riscv (in-kernel PSI), QEMU |
| Interface | Electron (real-time xv6 monitor) |
| Environment | Linux (Ubuntu 22.04+, kernel 4.20+ for PSI, cgroups v2) |

---

## 3. OS Concepts in Play (and Where)

This is the core of why the project is genuinely an OS design, not an LLM wrapper.

| OS Concept | Where it is used | Component |
|------------|------------------|-----------|
| **PSI (Pressure Stall Information)** | Reads `/proc/pressure/memory` (Linux); implemented in `kalloc` with EMA (xv6) | PSI Monitor / xv6 kernel |
| **`/proc` virtual filesystem** | Collects process metadata and pressure metrics | /proc Reader |
| **Process creation** | `fork()` + `execlp()` to spawn the Python helper as a child | IPC (R4) |
| **Inter-process communication (IPC)** | Two `pipe()`s carry JSON between C and Python | IPC (R4) |
| **Signals** | `SIGTERM` then `SIGKILL` to terminate the victim | Signal Dispatcher |
| **Process lifecycle / zombie reaping** | `waitpid(WNOHANG)` reaps the helper | Signal Dispatcher |
| **Memory management** | The OOM situation itself; xv6 PSI added to the allocator | xv6 kernel |
| **Synchronization** | Lock release in `allocproc` / `kfork` for safe PSI update (xv6) | xv6 kernel |

The OS component (PSI sensing, process/IPC/signals, kernel allocator instrumentation) is something the team designed and implemented. The LLM only *recommends* a victim within this OS machinery.

---

## 4. How the LLM Is Integrated

### 4.1 Role of the LLM

The LLM is a **recommender**, not a decision-maker. It reads the user's natural-language policy and the candidate list, and proposes which process(es) to terminate. It never directly kills anything — the C code does, only after validation.

### 4.2 Interface

- **Input (C → Python, JSON):** `{ policy, candidates[], target_free_mb }`
  - `candidates[]` = real `/proc` data: `{ pid, comm, rss_kb }`
- **Output (Python → C, JSON):** `{ victims[], reasoning, confidence }`

### 4.3 Determinism & safety

- `temperature = 0` and JSON-enforced output → consistent, parseable responses.
- If no API key is present, `helper.py` falls back to a deterministic mock so the pipeline still runs.
- Every LLM suggestion passes through the **Validator** (Section 5.2) before any signal is sent.

### 4.4 Why an LLM (not regex / rules)

A natural-language policy can express abstract intent ("music apps are least important"). The LLM resolves this semantically — e.g., recognizing that `spotify` is a music app, or that `systemd` is a system process to avoid, even when not explicitly named.

---

## 5. Key Implementation Details

### 5.1 C ↔ Python IPC

The daemon spawns the helper with `fork()` + `execlp()` and wires two `pipe()`s via `dup2()` for bidirectional JSON. This is the central OS mechanism of the project: the helper runs as a real child process, not an in-process library call.

### 5.2 Validator (safety gate)

A hard-coded whitelist protects critical processes (PID 1, `systemd`, `sshd`, and the daemon itself). Even if the LLM returns a protected PID, the Validator rejects it. This guarantees liveness regardless of LLM error.

### 5.3 Real `/proc` integration

Originally prototyped with placeholder data, the PSI Monitor and /proc Reader were transitioned to real kernel data. A verification run scanned **22 real processes** and the LLM correctly avoided all system processes, selecting the only non-system, non-protected candidate.

### 5.4 xv6 kernel PSI

The same PSI idea was implemented in the xv6 kernel: memory-wait measurement via `sleep`/`wakeup` in `kalloc`, PSI metrics updated each timer tick using an exponential moving average, and lock-safety handled by temporarily releasing locks in `allocproc`/`kfork`. Under QEMU, `some_avg10` was observed rising from 0% to 9% under memory pressure. An Electron dashboard visualizes services, memory, and OOM events.

### 5.5 Evaluation result

Across 5 scenarios (6 decisions), the system achieved **100% policy compliance**. Notably, scenario 5 showed that with identical system state, changing only the policy flips the decision — the essence of "conversational." Scenario 4 showed the system refusing to kill when the policy protected everything (safety over the memory goal).

---

## 6. Limitations

- **LLM latency** — Inference adds delay versus the kernel's instant scoring. PSI triggers early (before hard OOM) to buy time; local models or caching could reduce this further.
- **Determinism** — `temperature=0` improves consistency, but LLMs are not perfectly deterministic; the Validator bounds the risk.
- **xv6 robustness** — The core PSI path works (0→9% measured); `full_avg10` and edge-case stability under heavy load remain to be hardened.
- **Evaluation scope** — 5 scenarios demonstrate the concept; a larger, adversarial suite would further stress-test policy compliance.
- **External dependency** — The userspace track depends on a network LLM API and key; the mock fallback mitigates but does not replace it.

---

## 7. Summary

The Conversational OOM Killer demonstrates that OOM victim selection can follow user intent expressed in natural language, while a deterministic OS-level safety net guarantees the system never sacrifices liveness. The design exercises core OS concepts — PSI, `/proc`, process creation, IPC, and signals — at both the Linux userspace and xv6 kernel levels, with the LLM serving strictly as a bounded recommender.
