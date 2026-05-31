# Conversational OOM Killer

Operating Systems, Section 00 · Team 06
Direction B — LLM for OS
LLM Backend: Upstage Solar Pro 3

---

## 1. Team

| Student ID | Name | Role |
|------------|------|------|
| 2021270017 | Roh Hyukjun (Leader) | R5 — Documentation / Evaluation / LLM Helper |
| 2022270635 | Baek Seonha | R4 — Integration Daemon |
| 2024270639 | Kang Gyuhyeon | R1 — PSI Monitor |
| 2017271134 | Lee Seungwon | R3 — LLM Helper |
| 2023270626 | Lee Yujin | R2 — /proc Reader |

Roles R1–R5 correspond to PSI Monitor, /proc Reader, LLM Helper, Integration Daemon, and Documentation/Evaluation.

---

## 2. Topic Selection

Following the project direction (Direction B — LLM for OS), each member proposed a topic.

| Proposer | Topic | Summary |
|----------|-------|---------|
| Baek Seonha | LLM-based error diagnosis tool | Describe an error in natural language; the tool analyzes logs and recommends a fix |
| Kang Gyuhyeon | OS for AI speakers | Built-in music player; CPU scheduling prioritizing playback efficiency |
| Kang Gyuhyeon | Smart-home central server OS | Sensor-driven environmental control |
| Kang Gyuhyeon | LMS workspace OS | File structure adapted to LMS; AI-driven task processing |
| Roh Hyukjun | Conversational OOM Killer | Redesign Linux OOM Killer to follow a user-written natural-language policy |
| Lee Seungwon | NL-based kernel parameter tool | Handle complex kernel commands through natural language |
| Lee Yujin | Automatic Wi-Fi troubleshooter | LLM-guided cause/fix diagnosis on network failure |

After a multi-vote, the **Conversational OOM Killer** and the **NL-based error analysis tool** tied. Following further discussion, the team selected the Conversational OOM Killer as the final topic, as a majority found it more interesting and offering deeper engagement with operating-system concepts.

---

## 3. Project Overview

### 3.1 One-line summary

Redesign the Linux OOM Killer to operate according to a user-written, natural-language priority policy.

### 3.2 Motivation

The default Linux OOM Killer selects victim processes based solely on a numeric `oom_score`. It does not reflect user intent at all (e.g., "Never kill VS Code"), so a critical process the user is actively working on can be terminated before an idle background process.

### 3.3 Our Approach

The user writes a one-paragraph natural-language policy. When memory pressure is detected, an LLM interprets this policy to recommend victims. Safety is guaranteed by a deterministic Validator implemented in C, which protects critical system processes such as PID 1 and systemd.

### 3.4 Tech Stack

| Component | Technology |
|-----------|------------|
| Daemon | C (PSI Monitor, /proc Reader, IPC, Validator, signal handling) |
| LLM Module | Python 3 (Upstage Solar Pro API) |
| IPC | fork + execlp + pipe (bidirectional C ↔ Python communication) |
| Environment | Linux (Ubuntu, cgroups v2 / PSI) + xv6 (QEMU) |

---

## 4. Implementation and Verification

### 4.1 Overview

The designed pipeline was implemented and verified end-to-end. Both the PSI Monitor and the /proc Reader, originally implemented with placeholder data, were transitioned to use real Linux data. The core capability — *the LLM interpreting a natural-language policy to select termination targets from real processes* — was confirmed to operate correctly.

### 4.2 Actual Execution Result

The following is the actual output of running the system in dry-run mode under WSL.

```
$ ./bin/coomd --dry-run

[R4 Main Loop] PSI some_avg10: 16.50% (threshold: 15.00%)
🚨 [ALERT] Memory pressure detected — starting OOM handling

[R2] 22 candidate processes found (real /proc scan)
  -> PID  210 | unattended-upgr | 22144 kB
  -> PID   42 | systemd-journal | 15616 kB
  -> PID  122 | systemd-resolve | 12672 kB
  -> PID    1 | systemd         | 12336 kB
  ... (22 in total)

[R3 LLM Helper] Requesting victim selection based on user policy...
  🤖 AI selection: unattended-upgr (PID 210)
  💬 Rationale: Only unattended-upgr is a non-system process not
     explicitly protected by the policy. It frees 21.6MB. No other
     candidates are eligible per policy/system rules.

  🎯 victim → PID 210 (unattended-upgr)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] Simulated SIGTERM sent
```

Among 22 real WSL processes, the AI avoided all system processes and correctly selected the only non-system process unprotected by the policy (unattended-upgr). The fact that the rationale was generated as an English sentence confirms that the LLM performed actual policy-based reasoning rather than following predefined rules.

### 4.3 Technical Highlight

The integration between the C-based daemon and the Python LLM module is implemented as bidirectional IPC using `fork()` + `execlp()` + `pipe()`. This directly applies the operating-system concepts of process creation and inter-process communication, demonstrating that the project is fundamentally an OS-level design rather than a simple LLM API call.

### 4.4 xv6 Kernel Implementation (Parallel Track)

In parallel with the Linux userspace implementation, the same PSI mechanism was implemented directly inside the xv6 kernel. Memory-wait measurement via `sleep`/`wakeup` was added in `kalloc`; PSI metrics are updated each timer interrupt using an exponential moving average; and lock-safety was addressed by temporarily releasing locks in `allocproc` and `kfork`. Running `psitest` under QEMU confirmed that `some_avg10` increases in real time from 0% up to 9% under memory pressure.

---

## 5. Policy Compliance Evaluation

### 5.1 Evaluation Purpose

To quantitatively verify the core capability — *"Does the LLM accurately select termination targets based on the natural-language policy?"* — we measured 6 decisions across 5 scenarios.

### 5.2 Scenario Design

| # | Aspect Verified |
|---|-----------------|
| 1 | Accurate interpretation of explicit protect/allow rules |
| 2 | Priority-based selection and incremental termination to meet memory target |
| 3 | Common-sense protection of system processes not explicitly named in policy |
| 4 | Policy-first principle when memory target conflicts with policy |
| 5 | Change of decision when policy is changed under identical system state |

### 5.3 Summary of Results

| # | Policy (key idea) | AI Selection | Compliant |
|---|-------------------|--------------|-----------|
| 1 | Protect firefox/code; chrome OK | chrome | ✅ |
| 2 | music < browser < editor priority | spotify + chrome | ✅ |
| 3 | Abstract "system processes" protection | chrome (systemd/init/dbus avoided) | ✅ |
| 4 | All candidates absolutely protected | (none) | ✅ |
| 5a | "Kill chrome" | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | spotify | ✅ |

**6 decisions, 6 compliant — Policy Compliance Rate: 100%**

### 5.4 Key Insights

**Scenario 4 — Policy-first principle (safety)**
When the memory target (500 MB) conflicted with the user policy, the system prioritized policy compliance over reaching the memory target and refused to terminate any process. Unlike the default OOM Killer which unconditionally selects a victim, the system exhibited safe behavior that does not violate user intent.

**Scenario 5 — Essence of "Conversational"**
Under physically identical system state (same candidates, same memory), changing only the policy led the AI to make opposite decisions: selecting chrome for "Kill chrome," and spotify for "Save chrome, kill spotify." This behavior cannot be exhibited by the default OOM Killer, and constitutes the realization of the value implied by the project name "Conversational."

**Scenario 3 — Common-sense-based safety**
Although the policy used only the abstract phrase "system processes," the AI correctly identified systemd, init, and dbus-daemon as system processes and excluded all of them. This demonstrates interpretation based on general knowledge rather than mere rule matching.

### 5.5 Known Limitations

During evaluation, the LLM exhibited inaccuracy in unit conversion once (reporting 390.625 MB as exceeding a 500 MB target). The termination target selection itself complied with the policy, so the policy compliance rate is not affected. Deterministic arithmetic should be complemented by deterministic code in the future.

---

## 6. Next Steps

- Extend evaluation scenarios and build an automated regression test
- End-to-end verification under real memory pressure with `stress-ng`
- Improve stability of the xv6 PSI implementation (lock safety, full metric verification)
- Document comparative analysis between the Linux daemon and the xv6 implementation
