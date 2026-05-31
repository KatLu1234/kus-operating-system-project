# Development Process Document

> A record of the development process for the Conversational OOM Killer team project
> Direction B — LLM for OS

---

## 1. Team

| Student ID | Name | Role |
|------------|------|------|
| 2021270017 | Roh Hyukjun (Leader) | R5 — Documentation / Evaluation / LLM Helper |
| 2022270635 | Baek Seonha | R4 — Integration Daemon |
| 2024270639 | Kang Gyuhyeon | R1 — PSI Monitor |
| 2017271134 | Lee Seungwon | R3 — LLM Helper |
| 2023270626 | Lee Yujin | R2 — `/proc` Reader |

Roles R1–R5 correspond to **PSI Monitor, /proc Reader, LLM Helper, Integration Daemon, and Documentation/Evaluation**.

---

## 2. Topic Selection

Following the project direction (Direction B — LLM for OS), each member proposed a topic.

| Proposer | Topic | Summary |
|----------|-------|---------|
| Baek Seonha | LLM-based error diagnosis tool | Describe an error in natural language; the tool analyzes logs and recommends a fix |
| Kang Gyuhyeon | OS for AI speakers | Built-in music player; CPU scheduling prioritizing playback efficiency |
| Kang Gyuhyeon | Smart-home central server OS | Sensor-driven environmental control |
| Kang Gyuhyeon | LMS workspace OS | File structure adapted to LMS; AI-driven task processing |
| Roh Hyukjun | **Conversational OOM Killer** | Redesign the Linux OOM Killer to follow a user-written natural-language priority policy |
| Lee Seungwon | NL-based kernel parameter tool | Handle complex kernel commands through natural language |
| Lee Yujin | Automatic Wi-Fi troubleshooter | LLM-guided cause/fix diagnosis on network failure |

After a multi-vote, the **Conversational OOM Killer** and the **NL-based error analysis tool** tied. Following further discussion, the team selected the Conversational OOM Killer as the final topic, as a majority found it more interesting and offering deeper engagement with operating-system concepts.

---

## 3. Project Overview

### One-line Summary

Redesign the Linux OOM Killer to operate according to a user-written, natural-language priority policy.

### Motivation

The default Linux OOM Killer selects victim processes based solely on the numeric `oom_score`. It does not reflect user intent at all (e.g., "Never kill VS Code"), so a critical process the user is actively working on can be terminated before an idle background process.

### Our Approach

The user writes a one-paragraph natural-language policy. When memory pressure is detected, an LLM interprets the policy to recommend victims. Safety is guaranteed by a deterministic Validator implemented in C (which protects critical system processes such as PID 1 and systemd).

### Tech Stack

| Component | Technology |
|-----------|------------|
| daemon | C (PSI Monitor, `/proc` Reader, IPC, Validator, signal handling) |
| LLM module | Python 3 (Upstage Solar Pro API) |
| IPC | `fork` + `execlp` + `pipe` (bidirectional C ↔ Python communication) |
| Environment | Linux (Ubuntu, cgroups v2 / PSI) + xv6 (QEMU) |

---

## 4. Working Prototype (End-to-End LLM Integration on Real Data)

### Overview

The designed pipeline was fully implemented and verified end-to-end using real Linux data. Both the PSI Monitor and the /proc Reader, originally implemented with placeholder data in Week 11, were transitioned to real `/proc` data in Week 12. The core capability — *"the LLM interpreting a natural-language policy to select termination targets from actual running processes"* — was confirmed to operate correctly using the Upstage Solar Pro API.

### Verification Scenario (Real `/proc` Data)

**Input — user policy (natural language):**
```
I am coding. Never kill VS Code, gcc, or firefox.
Chrome tabs and music apps are fine to kill first.
```

**System behavior:**
1. PSI Monitor reads real `/proc/pressure/memory` and triggers on threshold crossing
2. /proc Reader scans `/proc` and collects all real user processes (sorted by memory usage)
3. The candidate list and user policy are sent to the LLM
4. The LLM selects termination targets based on the policy
5. The selected target passes Validator whitelist check before dispatch

### Actual Execution Result

```
$ ./bin/coomd --dry-run

[R4 Main Loop] PSI some_avg10: 16.50% (threshold: 15.00%)
🚨 [ALERT] Memory pressure detected — starting OOM handling

[R2 Introspector] 22 candidate processes found (real /proc scan)
  -> PID  210 | unattended-upgr | 22144 kB
  -> PID   42 | systemd-journal | 15616 kB
  -> PID  122 | systemd-resolve | 12672 kB
  -> PID    1 | systemd         | 12336 kB
  -> PID  298 | bash            |  9472 kB
  ... (22 total)

[R3 LLM Helper] Requesting victim selection based on user policy...
  🤖 AI selection: unattended-upgr (PID 210)
  💬 Rationale: Only unattended-upgr (PID 210) is a non-system
     process not explicitly protected by the policy. It frees
     21.6 MB. No other candidates are eligible per policy/system
     rules.

  🎯 victim → PID 210 (unattended-upgr)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] Simulated SIGTERM sent
```

Among 22 real WSL processes, the AI avoided all system processes (systemd, init, dbus-daemon, bash, etc.) and correctly selected the only non-system, non-protected process (`unattended-upgr`). The fact that the rationale was generated as a full English sentence confirms that the LLM performed actual policy-based reasoning, not predefined rule matching.

### LLM Decision

| Process | Decision | Rationale |
|---------|----------|-----------|
| unattended-upgr (210) | Selected | Non-system, not protected by policy |
| systemd (1), init, dbus-daemon | Avoided | System processes |
| bash, agetty, etc. | Avoided | Critical user-session processes |

### Technical Highlight

The integration between the C-based daemon and the Python LLM module is implemented as bidirectional IPC using `fork()` + `execlp()` + `pipe()`. This directly applies the operating-system concepts of process creation and inter-process communication, demonstrating that the project is fundamentally an OS-level design rather than a simple LLM API call.

### xv6 Kernel Implementation (Parallel Track)

In parallel with the Linux userspace implementation, the same PSI mechanism was implemented directly inside the xv6 kernel. Memory-wait measurement via `sleep`/`wakeup` was added in `kalloc`; PSI metrics are updated each timer interrupt using an exponential moving average; and lock-safety was addressed by temporarily releasing locks in `allocproc` and `kfork`. Running `psitest` under QEMU confirmed that `some_avg10` increases in real time from 0% up to 9% under memory pressure.

---

## 5. Policy Compliance Evaluation

To quantitatively verify the LLM's decision quality, 5 controlled scenarios (6 decisions in total) were measured.

| # | Policy (key idea) | AI Selection | Compliant |
|---|-------------------|--------------|-----------|
| 1 | Protect firefox/code; chrome OK | chrome | ✅ |
| 2 | music < browser < editor priority | spotify + chrome | ✅ |
| 3 | Abstract "system processes" protection | chrome (systemd/init/dbus avoided) | ✅ |
| 4 | All candidates absolutely protected | (none — refused) | ✅ |
| 5a | "Kill chrome" | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | spotify | ✅ |

**6 decisions, 6 compliant — Policy Compliance Rate: 100%**

Key insights:

- **Scenario 4 (Policy-first safety)** — When the memory target (500 MB) conflicted with the policy, the system refused to terminate any process. This safe behavior — never violating user intent — is the opposite of the default OOM Killer's unconditional victim selection.
- **Scenario 5 (Essence of "Conversational")** — Identical system state with only the policy changed produced opposite decisions. This demonstrates that the project name "Conversational" is genuinely realized.
- **Scenario 3 (Common sense)** — Even with only the abstract phrase "system processes," the LLM correctly identified systemd, init, and dbus-daemon and excluded them all.

For full analysis, see `evaluation_results.md`.

---

## 6. Component Status

| Component | Status | Note |
|-----------|--------|------|
| Main Daemon (C) | ✅ Done | Main loop, option parsing, logging |
| Validator (C) | ✅ Done | Protects PID 1, systemd, and other system processes |
| LLM Helper (Python) | ✅ Done | Live Solar Pro API, policy-based selection |
| C ↔ Python IPC | ✅ Done | `fork` + `execlp` + `pipe`, bidirectional |
| PSI Monitor (C) | ✅ Done | Reads real `/proc/pressure/memory` |
| `/proc` Reader (C) | ✅ Done | Parses real `/proc/[pid]/*` (22 processes verified) |
| xv6 PSI Implementation | ✅ Done | `some_avg10` measurement verified (0% → 9%) under QEMU |
| Policy Compliance Evaluation | ✅ Done | 5 scenarios, 100% compliance |

---

## 7. Next Steps

| Week | Milestone | Owner |
|------|-----------|-------|
| W13 | Extend evaluation scenarios; automate regression tests | R5 |
| W13 | Verify under real memory pressure with stress-ng | R5 |
| W13 | Improve xv6 PSI stability (lock safety, full metric) | R1 |
| W13 | Comparative analysis: Linux daemon vs. xv6 implementation | R5 |
| W14 | Final presentation (English) | All |

### Evaluation Metrics (Defined and Measured)

| Metric | Formula | Result |
|--------|---------|--------|
| Policy Compliance Rate | (policy-compliant selections) / (total decisions) × 100% | **100%** (6/6) |
| Decision Consistency | same-victim rate over repeated runs with same input | To be measured at W13 |
| Recovery Time | time PSI ≥ threshold → time PSI < threshold | To be measured at W13 |
| Decision Latency | PSI detection → SIGTERM dispatch | To be measured at W13 |

Target: Policy Compliance Rate ≥ 80% (achieved: **100%**).
