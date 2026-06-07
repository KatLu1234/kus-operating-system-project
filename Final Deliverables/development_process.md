# Development Process Document

> A record of the development process for the Conversational OOM Killer team project
> Direction B — LLM for OS

---

## 1. Team

| Student ID | Name | Role |
|------------|------|------|
| 2021270017 | Roh Hyukjun (Leader) | R5 — Documentation / Integration / Evaluation |
| 2022270635 | Baek Seonha | R4 — Integration Daemon (coomd) |
| 2024270639 | Kang Gyuhyeon | R1 — PSI Monitor / xv6 |
| 2017271134 | Lee Seungwon | R3 — LLM Helper / Presenter |
| 2023270626 | Lee Yujin | R2 — `/proc` Reader |

Roles R1–R5 correspond to **PSI Monitor, /proc Reader, LLM Helper, Integration Daemon, and Documentation/Evaluation**.

---

## 2. Topic Selection (Planning)

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
| Kernel | xv6-riscv (in-kernel PSI mechanism, QEMU) |
| Environment | Linux (Ubuntu, cgroups v2 / PSI) + xv6 (QEMU) |

---

## 4. Schedule — Weekly Progress per Role

> The timeline below is reconstructed from the actual commit history of the team
> GitHub repository (github.com/KatLu1234/kus-operating-system-project).

| Week | Period | Progress | Lead |
|------|--------|----------|------|
| W9 | ~Apr 30 – May 8 | Team formed, direction chosen, repository initialized, environment setup | R1 (Kang) |
| W10 | May 19–20 | PSI plan; R4 daemon `main.c` core loop with mock stubs; architecture & problem-statement drafts; `os_concepts.md`; psi branch merged | R1, R4, R5 |
| W11 | May 21–25 | Docs organized into `docs/`; problem/evaluation/xv6-porting docs; **`helper.py` + Solar API**; **C↔Python connected via fork+exec+pipe (R3+R4 integration)**; API key secured (`.env` ignored) | R5, R4 |
| W12 | May 28–29 | **Real `/proc` Reader + JSON sanitization (R2)** — placeholders replaced with real process data; **policy-compliance evaluation: 5 scenarios, 100%** | R2, R5 |
| W13 | May 31 | Mock removed, real-data results integrated; all docs translated to English; README cleaned; backups removed; policy-compliance evaluation finalized | R5 |
| W14 | June | xv6 PSI kernel mechanism + QEMU measurement; xv6 real-time monitoring interface (Electron); English slides & script; final deliverables | R1, R5, All |

### Per-role contribution summary

| Role | Member | Key contributions |
|------|--------|-------------------|
| R1 | Kang Gyuhyeon | Repo setup, PSI plan & implementation, xv6 in-kernel PSI mechanism, Electron monitoring interface |
| R2 | Lee Yujin | `/proc` Reader — real process metadata collection |
| R3 | Lee Seungwon | LLM Helper design, presentation |
| R4 | Baek Seonha | Integration daemon (coomd) core loop, Validator |
| R5 | Roh Hyukjun (Leader) | Documentation, C↔Python IPC integration, evaluation (5 scenarios, 100%), English translation, presentation materials |

---

## 5. Meeting Notes & Key Decisions

> In place of fixed periodic minutes, the team recorded the major decisions made
> during development. Coordination was primarily commit- and message-based.

| When | Decision | Rationale |
|------|----------|-----------|
| Kick-off | Final topic = Conversational OOM Killer | Tied vote, resolved by discussion — deepest engagement with OS concepts |
| Design | Split roles R1–R5 (PSI / proc / LLM / integration / docs) | Enable parallel, component-wise development |
| Design | LLM only *recommends*; final decision by C Validator | Guarantee system safety even if the LLM errs |
| Integration | Connect C↔Python via fork+exec+pipe | Apply real OS mechanisms (IPC), not a bare API call |
| Evaluation | Run evaluation in dry-run mode | Verify policy compliance without risk of killing real processes |
| Scope | Implement both userspace (coomd) and kernel (xv6) | Demonstrate OS concepts at the kernel level as well |

---

## 6. Execution — Working Prototype (End-to-End on Real Data)

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

### Technical Highlight

The integration between the C-based daemon and the Python LLM module is implemented as bidirectional IPC using `fork()` + `execlp()` + `pipe()`. This directly applies the operating-system concepts of process creation and inter-process communication, demonstrating that the project is fundamentally an OS-level design rather than a simple LLM API call.

### Two Implementations — Linux userspace + xv6 kernel

The project was realized at two levels:

- **Linux userspace (coomd)** — the daemon runs on real `/proc` data with the real Solar Pro LLM, making real-time decisions. This is the track used for the quantitative policy-compliance evaluation (Section 7).
- **xv6 kernel** — the same PSI mechanism was implemented directly inside the xv6 kernel. Memory-wait measurement via `sleep`/`wakeup` was added in `kalloc`; PSI metrics are updated each timer interrupt using an exponential moving average; lock-safety was addressed by temporarily releasing locks in `allocproc` and `kfork`. Running `psitest` under QEMU confirmed that `some_avg10` increases in real time from 0% up to 9% under memory pressure. A real-time monitoring interface (Electron) visualizes services, memory usage, and OOM events, and serves as the live demo.

---

## 7. Policy Compliance Evaluation

To quantitatively verify the LLM's decision quality, 5 controlled scenarios (6 decisions in total) were measured on the Linux `coomd` track.

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

### Evaluation Metric

| Metric | Formula | Result |
|--------|---------|--------|
| Policy Compliance Rate | (policy-compliant selections) / (total decisions) × 100% | **100%** (6/6) |

Target: Policy Compliance Rate ≥ 80% (achieved: **100%**).

Policy compliance was chosen as the primary metric because it directly measures the core claim of the project — that victim selection follows user intent. Additional metrics such as decision consistency, recovery time, and decision latency were considered in the evaluation design and remain as future work.

---

## 8. Component Status

| Component | Status | Note |
|-----------|--------|------|
| Main Daemon (C) | ✅ Done | Main loop, option parsing, logging |
| Validator (C) | ✅ Done | Protects PID 1, systemd, and other system processes |
| LLM Helper (Python) | ✅ Done | Live Solar Pro API, policy-based selection |
| C ↔ Python IPC | ✅ Done | `fork` + `execlp` + `pipe`, bidirectional |
| PSI Monitor (C) | ✅ Done | Reads real `/proc/pressure/memory` |
| `/proc` Reader (C) | ✅ Done | Parses real `/proc/[pid]/*` (22 processes verified) |
| xv6 PSI Implementation | ✅ Done | `some_avg10` measurement verified (0% → 9%) under QEMU |
| xv6 Monitoring Interface | ✅ Done | Electron dashboard — services, memory graph, OOM log |
| Policy Compliance Evaluation | ✅ Done | 5 scenarios, 100% compliance |

---

## 9. Issues Encountered & How They Were Resolved

### Issue 1 — API key security incident
- **Situation**: Early on, the `.env` file (API key) was at risk of being committed to version control.
- **Resolution**: Added `.env` to `.gitignore`, removed it from the repo (`Delete .env`), shared only `.env.example`, and reissued the key.

### Issue 2 — LLM falling back to mock under sudo
- **Situation**: Running the daemon with `sudo` executed `helper.py` as root, which could not find the `openai` library installed under the user account, so it silently fell back to mock (fake) responses.
- **Cause**: `pip install --break-system-packages` installed the library to the user account only; root could not locate it.
- **Resolution**: Since the dry-run stage uses placeholder candidates, we ran without `sudo` to confirm the real Solar AI behavior. (For the actual-kill stage, the library is installed separately for root.)

### Issue 3 — JSON parsing / sanitization
- **Situation**: Format mismatches occurred when passing LLM-response JSON and `/proc` data across the C↔Python boundary.
- **Resolution**: Added JSON sanitization in `helper.py` and hardened the C-side parser (R2 integration commit).

### Issue 4 — Confusing mock vs. real behavior
- **Situation**: Right after integration, the system ran in mock mode, producing size-based rather than policy-based selection.
- **Resolution**: Traced the cause (sudo / key path), verified that the real Solar Pro API reads the natural-language policy and selects the victim, and made the mock indicator explicit to avoid confusion.

### Issue 5 — xv6 PSI lock safety
- **Situation**: The initial xv6 PSI implementation hit lock-safety issues when updating metrics inside allocation paths.
- **Resolution**: Temporarily released locks in `allocproc` and `kfork` while updating PSI; verified stable `some_avg10` measurement (0% → 9%) under QEMU with `psitest`.

---

## 10. Retrospective

- **What went well**: Component-wise role division enabled parallel development. The fork+exec+pipe integration and the 100% policy-compliance evaluation were completed end-to-end, and the system was extended to both userspace and the kernel.
- **What could improve**: A formal meeting/record cadence was lacking early on, so progress sharing was largely commit-driven. A larger and more adversarial evaluation suite would further stress-test robustness.
- **What we learned**: Integrating an LLM into an OS makes the importance of safety mechanisms (Validator + dry-run) concrete. The essence is not a simple API call but the design of OS mechanisms — processes, IPC, and signals.
