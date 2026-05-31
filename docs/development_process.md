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
| Baek Seonha | LLM-based error diagnosis tool | Describe an error in natural language; the tool analyzes logs and recommends a fix (query → collect OS info → LLM analysis → safety check → solution) |
| Kang Gyuhyeon | OS for AI speakers | Built-in music player; CPU scheduling prioritizing playback efficiency; AI-driven play/stop/playlist generation |
| Kang Gyuhyeon | Smart-home central server OS | An OS that reads sensor data and optimizes humidity, temperature, and lighting |
| Kang Gyuhyeon | LMS workspace OS | An OS that structures files for an LMS and handles attendance, assignment submission, etc. via AI |
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
| Environment | Linux (Ubuntu, cgroups v2 / PSI) |

---

## 4. Minimal Working Prototype (End-to-End LLM Integration)

### Overview

The designed pipeline was implemented and verified end-to-end. The core capability — *"the LLM interpreting a natural-language policy to select termination targets"* — was confirmed to operate correctly using the Upstage Solar Pro API.

### Verification Scenario (Mock-Data-Based)

**Input — user policy (natural language):**
```
I am coding. Never kill firefox. Chrome tabs are fine to kill first.
```

**System behavior:**
1. On memory pressure, collect candidate processes (chrome, firefox, systemd)
2. Send candidate list and user policy to the LLM
3. The LLM selects termination targets based on the policy

### Actual Execution Result

```
$ ./bin/coomd --dry-run
[R4 Main Loop] PSI some_avg10: 16.50% (threshold: 15.00%)
🚨 [ALERT] Memory pressure detected — starting OOM handling
[R2] 3 candidate processes found
  -> PID 9999 | chrome  | 1245000 kB
  -> PID 8888 | firefox |  512000 kB
  -> PID    1 | systemd |    4096 kB
[R3 LLM Helper] Requesting victim selection based on user policy...
  🤖 AI selection: chrome (PID 9999)
  💬 Rationale: Selected chrome as it's marked 'fine to kill
     first' and frees 1215 MB, exceeding the 500 MB target.
     Avoided killing firefox and systemd per policy.
  🎯 victim → PID 9999 (chrome)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] Simulated SIGTERM sent
```

> ⚠️ **This verification used mock data to verify the end-to-end flow.**
> PSI values and candidate processes (PIDs 9999, 8888) are dummies; real `/proc` integration was completed in Week 12.

As shown above, the AI interpreted the user policy and correctly selected chrome while protecting firefox and systemd. The fact that the rationale was generated as a full English sentence confirms that the LLM performed actual policy-based reasoning rather than following predefined rules.

### LLM Decision

| Process | Decision | Rationale |
|---------|----------|-----------|
| chrome | Selected | Permitted by policy; meets memory target |
| firefox | Protected | Honors the "never kill" rule |
| systemd | Avoided | System process |

The termination target was selected based on user intent rather than memory size alone. The selected target additionally passes the Validator's whitelist check before being processed.

### Technical Highlight

The integration between the C-based daemon and the Python LLM module is implemented as bidirectional IPC using `fork()` + `execlp()` + `pipe()`. This directly applies the operating-system concepts of process creation and inter-process communication, demonstrating that the project is fundamentally an OS-level design rather than a simple LLM API call.

---

## 5. Component Status

| Component | Status | Note |
|-----------|--------|------|
| Main Daemon (C) | ✅ Done | Main loop, option parsing, logging |
| Validator (C) | ✅ Done | Protects PID 1, systemd, and other system processes |
| LLM Helper (Python) | ✅ Done | Live Solar Pro API, policy-based selection |
| C ↔ Python IPC | ✅ Done | `fork` + `execlp` + `pipe`, bidirectional |
| PSI Monitor (C) | ✅ Done | Now reads real `/proc/pressure/memory` |
| `/proc` Reader (C) | ✅ Done | Now parses real `/proc/[pid]/*` |

---

## 6. Next Steps

| Week | Milestone | Owner |
|------|-----------|-------|
| W12 | Real `/proc/pressure/memory` integration in PSI Monitor | R1 |
| W12 | Real `/proc/[pid]/*` parsing in /proc Reader | R2 |
| W12 | Define evaluation metrics (policy compliance, recovery time, decision consistency) | R5 |
| W13 | Verify under real memory pressure with stress-ng | R5 |
| W13 | Baseline (default OOM) vs `coomd` comparative measurement | R5 |
| W14 | Final presentation (English) | All |

### Evaluation Metrics (Plan)

| Metric | Formula |
|--------|---------|
| Policy Compliance Rate | `(policy-compliant victim selections) / (total OOM events)` × 100% |
| Recovery Time | `time PSI ≥ 15% — time PSI < 10% returns` |
| Decision Consistency | `same-victim rate over 10 repetitions with same candidate set` |
| Decision Latency | `time from PSI detection to SIGTERM dispatch` |

Target: Policy Compliance Rate ≥ 80% (vs. ~50% for baseline).
