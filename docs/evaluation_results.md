# Policy Compliance Evaluation — Conversational OOM Killer

**Author:** R5 (Documentation & Evaluation)
**Test Date:** Week 13
**Backend:** Upstage Solar Pro API
**Test Mode:** dry-run, isolated LLM helper invocation

---

## 1. Evaluation Purpose

This evaluation quantitatively verifies the core capability of our system: *"Does the LLM accurately select termination targets based on a natural-language policy?"* Across 5 scenarios, we measured 6 decisions in total.

## 2. Evaluation Metric

**Policy Compliance Rate**: The proportion of decisions in which the LLM correctly interpreted the user's natural-language policy and selected termination targets consistent with that policy.

## 3. Scenario Design

The five scenarios were designed to verify different aspects of policy interpretation.

| # | Aspect Verified |
|---|-----------------|
| 1 | Accurate interpretation of explicit protect/allow rules |
| 2 | Priority-based selection and incremental termination to meet memory target |
| 3 | Common-sense protection of system processes not explicitly named in policy |
| 4 | Policy-first principle when memory target conflicts with policy |
| 5 | Change of decision when policy is changed under identical system state (essence of "Conversational") |

## 4. Summary of Results

| # | Policy (key idea) | Candidates | AI Selection | Compliant? |
|---|-------------------|------------|--------------|-----------|
| 1 | Protect firefox/code; chrome OK | chrome, firefox, code, systemd | chrome | ✅ |
| 2 | music < browser < editor priority | spotify, chrome, code, slack | spotify + chrome | ✅ |
| 3 | Abstract "system processes" protection | chrome, systemd, init, dbus-daemon | chrome | ✅ |
| 4 | All candidates absolutely protected | firefox, chrome, code, terminal | (none) | ✅ |
| 5a | "Kill chrome" | chrome, spotify, code | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | chrome, spotify, code | spotify | ✅ |

**6 decisions, 6 compliant — Policy Compliance Rate: 100%**

## 5. Detailed Analysis

### Scenario 1 — Explicit Policy Interpretation

- **Policy**: "I am coding. Never kill VS Code or firefox. Chrome is fine to kill."
- **LLM rationale**: "Chrome (PID 9999) is explicitly marked 'fine to kill' in the policy. Terminating it frees 1171.875 MB, exceeding the 500 MB target. VS Code and Firefox are protected by policy, and systemd is always excluded."
- **Analysis**: The LLM accurately interpreted the explicit protect/allow rules in the policy, and additionally treated systemd (PID 1) as a system process even though it was not mentioned in the policy.

### Scenario 2 — Priority + Incremental Termination

- **Policy**: "Music apps are lowest priority and can be killed first. Browsers are next priority. Editors and IDEs are critical and should never be killed."
- **LLM rationale**: "Killed spotify (music app, lowest priority) first, then chrome (browser, next priority) to meet 500MB target. Editors/IDEs (code) were spared per policy."
- **Analysis**: Since spotify alone (400 MB) was insufficient to meet the 500 MB target, the LLM additionally selected chrome (next priority in the policy). The model simultaneously reasoned about the policy's priority structure and the memory target to derive an optimal solution.

### Scenario 3 — Abstract Policy with Common-Sense Application

- **Policy**: "Kill memory-hogging apps but never kill system processes."
- **LLM rationale**: "Selected chrome as it's a memory-hogging app (1.5GB RSS) and not a system process. Excluded system processes (systemd, init, dbus-daemon) per policy."
- **Analysis**: Although the policy used only the abstract phrase "system processes," the LLM correctly identified systemd, init, and dbus-daemon as system processes and excluded all of them. This demonstrates common-sense-based interpretation, not mere rule matching.

### Scenario 4 — Policy-First Principle (Safety Verification)

- **Policy**: "Never kill firefox, chrome, code, or terminal under any circumstances."
- **LLM decision**: `victims: []` (no selection)
- **LLM rationale**: "No processes can be killed as all candidates are explicitly protected by the policy. Target memory cannot be met without violating the policy."
- **Analysis**: This is one of the most important results in this evaluation. When the memory target (500 MB) conflicted with the user policy, the system prioritized policy compliance over reaching the memory target and refused to terminate any process. Unlike the default OOM Killer which unconditionally selects a victim, this system exhibits safe behavior that does not violate user intent.

### Scenario 5 — Essence of "Conversational"

We measured twice with the same system state (same candidates, same memory) but with different policies.

| | 5a | 5b |
|--|----|----|
| Candidates | chrome, spotify, code | chrome, spotify, code (same) |
| Memory | same | same |
| Policy | "Kill chrome" | "Save chrome, kill spotify instead" |
| AI Selection | **chrome** | **spotify** |

- **Analysis**: Under physically identical system state, changing only the policy led the LLM to make opposite decisions. This is behavior the default OOM Killer cannot exhibit, and constitutes the core justification for naming this project a "Conversational" OOM Killer.

## 6. Additional Findings

During this evaluation, the following characteristics of the system were additionally observed.

1. **Incremental termination** (Scenario 2) — When a single termination cannot meet the memory target, the system additionally selects the next-priority process per policy.
2. **Common-sense-based safety** (Scenario 3) — Recognizes system processes not explicitly named in the policy and excludes them.
3. **Policy > memory target priority** (Scenario 4) — The most important design principle from a safety standpoint, verified.
4. **State-invariant, policy-variant scenarios** (Scenario 5) — Verifies genuine "Conversational" behavior.

## 7. Known Limitations

In Scenario 5b, the LLM responded with "400,000 KB (390.625 MB), exceeding the 500 MB target," but in fact 390.625 MB is below 500 MB. We confirmed that the LLM's arithmetic reasoning can be inaccurate. However, the termination target selection itself complied with the policy, so the result of this evaluation (100% policy compliance) is not affected. This is a known general limitation of LLMs, and deterministic computations such as memory calculation should be complemented by deterministic code in the future.

## 8. Conclusion

Across 6 decisions, the system achieved a 100% policy compliance rate. We verified that the system accurately interprets natural-language policies, and that it exhibits safe behavior — prioritizing user intent even when policy conflicts with the memory target. In particular, Scenario 5, where changing only the policy under identical system state led the LLM to make opposite decisions, demonstrates that the core value intended by naming this project "Conversational" OOM Killer is genuinely realized.
