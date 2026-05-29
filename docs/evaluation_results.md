# Policy Compliance Evaluation — Conversational OOM Killer

**Author:** R5 (Documentation & Evaluation)
**Test Date:** Week 13
**Backend:** Upstage Solar Pro API
**Test Mode:** dry-run, isolated LLM helper invocation

---

# Part 1. 평가 결과 (한국어)

## 1.1 평가 목적

본 평가는 본 시스템의 핵심 기능인 *"LLM이 자연어 정책에 근거하여 종료 대상을 정확히 선정하는가"* 를 정량적으로 검증하기 위해 수행되었다. 5가지 시나리오에서 총 6회의 의사결정을 측정하였다.

## 1.2 평가 지표

**정책 부합률 (Policy Compliance Rate)**: 사용자가 자연어로 작성한 정책을 LLM이 정확히 해석하여, 정책에 부합하는 종료 대상을 선정한 비율.

## 1.3 시나리오 설계

다음 5가지 시나리오는 정책 해석의 다양한 측면을 검증하도록 설계되었다.

| 번호 | 검증 항목 |
|------|----------|
| 1 | 명시적 보호/허용 규칙의 정확한 해석 |
| 2 | 우선순위 기반 선택 및 메모리 목표 달성을 위한 단계적 종료 |
| 3 | 정책에 명시되지 않은 시스템 프로세스의 상식적 보호 |
| 4 | 메모리 목표와 정책 충돌 시 정책 우선 원칙 |
| 5 | 동일 시스템 상태에서 정책 변경에 따른 결정 변화 (Conversational의 본질) |

## 1.4 결과 요약

| # | 정책 핵심 | 후보 프로세스 | AI 선택 | 정책 부합 |
|---|---------|-------------|---------|----------|
| 1 | firefox/code 보호, chrome 허용 | chrome, firefox, code, systemd | chrome | ✅ |
| 2 | music < browser < editor 우선순위 | spotify, chrome, code, slack | spotify + chrome | ✅ |
| 3 | 시스템 프로세스 추상적 보호 | chrome, systemd, init, dbus-daemon | chrome | ✅ |
| 4 | 모든 후보 절대 보호 | firefox, chrome, code, terminal | (없음) | ✅ |
| 5a | "Kill chrome" | chrome, spotify, code | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | chrome, spotify, code | spotify | ✅ |

**총 6회 의사결정 중 6회 정책 부합 — Policy Compliance Rate: 100%**

## 1.5 시나리오별 상세 분석

### 시나리오 1 — 명시적 정책 해석

- **정책**: "I am coding. Never kill VS Code or firefox. Chrome is fine to kill."
- **LLM 판단 근거**: "Chrome (PID 9999) is explicitly marked 'fine to kill' in the policy. Terminating it frees 1171.875 MB, exceeding the 500 MB target. VS Code and Firefox are protected by policy, and systemd is always excluded."
- **분석**: 정책에 명시된 보호/허용 규칙을 정확히 해석하였으며, 정책에 명시되지 않은 systemd(PID 1)는 시스템 프로세스로 인식하여 회피하였다.

### 시나리오 2 — 우선순위 + 단계적 종료

- **정책**: "Music apps are lowest priority and can be killed first. Browsers are next priority. Editors and IDEs are critical and should never be killed."
- **LLM 판단 근거**: "Killed spotify (music app, lowest priority) first, then chrome (browser, next priority) to meet 500MB target. Editors/IDEs (code) were spared per policy."
- **분석**: spotify(400 MB) 단독으로는 500 MB 목표 미달이므로, 정책상 다음 우선순위인 chrome을 추가 선택하여 목표를 충족시켰다. **AI가 정책의 우선순위 체계와 메모리 목표를 동시에 추론하여 최적 해를 도출**한 사례이다.

### 시나리오 3 — 추상적 정책의 상식적 적용

- **정책**: "Kill memory-hogging apps but never kill system processes."
- **LLM 판단 근거**: "Selected chrome as it's a memory-hogging app (1.5GB RSS) and not a system process. Excluded system processes (systemd, init, dbus-daemon) per policy."
- **분석**: 정책이 "system processes"라는 추상적 표현만 사용하였으나, AI는 systemd, init, dbus-daemon을 모두 시스템 프로세스로 인식하여 회피하였다. **단순 규칙 매칭이 아닌 일반 상식 기반 해석 능력**을 보여주는 사례이다.

### 시나리오 4 — 정책 우선 원칙 (안전성 검증)

- **정책**: "Never kill firefox, chrome, code, or terminal under any circumstances."
- **LLM 판단**: `victims: []` (선택 없음)
- **LLM 판단 근거**: "No processes can be killed as all candidates are explicitly protected by the policy. Target memory cannot be met without violating the policy."
- **분석**: **본 평가에서 가장 중요한 결과 중 하나이다.** 메모리 목표(500 MB)와 사용자 정책이 충돌하는 상황에서, 시스템은 메모리 목표 달성보다 사용자 정책 준수를 우선시하여 종료를 거부하였다. 기존 OOM Killer가 무조건적으로 victim을 선택하는 것과 달리, **사용자 의도를 침해하지 않는 안전한 동작**을 보였다.

### 시나리오 5 — Conversational의 본질 검증

동일한 시스템 상태(같은 후보, 같은 메모리)에 정책만 변경하여 두 번 측정하였다.

| | 5a | 5b |
|--|----|----|
| 후보 | chrome, spotify, code | chrome, spotify, code (동일) |
| 메모리 | 동일 | 동일 |
| 정책 | "Kill chrome" | "Save chrome, kill spotify instead" |
| AI 선택 | **chrome** | **spotify** |

- **분석**: 물리적으로 동일한 시스템 상태에서 정책만 변경하였더니 AI가 정반대의 결정을 도출하였다. 이는 기존 OOM Killer로는 불가능한 동작이며, **본 프로젝트가 "Conversational" OOM Killer로 명명된 핵심 근거**이다.

## 1.6 추가 발견 사항

평가 과정에서 시스템의 다음과 같은 특성을 추가로 확인하였다.

1. **단계적 종료 능력** (시나리오 2) — 단일 종료로 메모리 목표 미달 시, 정책상 다음 우선순위 프로세스를 추가 선택.
2. **일반 상식 기반 안전 판단** (시나리오 3) — 정책에 명시되지 않은 시스템 프로세스를 일반 지식으로 식별하여 회피.
3. **정책 > 메모리 목표 우선순위** (시나리오 4) — 안전성 측면에서 가장 중요한 설계 원칙으로, 검증 완료.
4. **상태 불변, 정책 가변 시나리오** (시나리오 5) — 진정한 "Conversational" 동작 검증.

## 1.7 알려진 한계

시나리오 5b에서 LLM이 "400,000 KB (390.625 MB), exceeding the 500 MB target" 이라 응답하였으나, 실제로는 500 MB 미달이다. **LLM의 산술 추론에서 부정확성이 발생할 수 있음**을 확인하였다. 단, 종료 대상 선택 자체는 정책에 부합하였으므로 본 평가의 결과(정책 부합률 100%)에는 영향이 없다. 이는 LLM의 일반적인 한계로 알려진 부분이며, 향후 메모리 계산과 같은 결정론적 연산은 결정론적 코드로 보완할 필요가 있다.

## 1.8 결론

총 6회의 의사결정에 대해 100% 정책 부합률을 달성하였으며, 본 시스템이 자연어 정책을 정확히 해석하고, 메모리 목표와 정책이 충돌하는 상황에서도 사용자 의도를 우선시하는 안전한 동작을 한다는 것을 검증하였다. 특히 시나리오 5에서 동일 시스템 상태에 정책만 변경하였을 때 정반대의 결정을 도출한 결과는, 본 프로젝트가 "Conversational" OOM Killer로서 의도한 핵심 가치가 실제로 구현되었음을 보여준다.

---

# Part 2. Evaluation Results (English)

## 2.1 Evaluation Purpose

This evaluation quantitatively verifies the core capability of our system: *"Does the LLM accurately select termination targets based on a natural-language policy?"* Across 5 scenarios, we measured 6 decisions in total.

## 2.2 Evaluation Metric

**Policy Compliance Rate**: The proportion of decisions in which the LLM correctly interpreted the user's natural-language policy and selected termination targets consistent with that policy.

## 2.3 Scenario Design

The five scenarios were designed to verify different aspects of policy interpretation.

| # | Aspect Verified |
|---|-----------------|
| 1 | Accurate interpretation of explicit protect/allow rules |
| 2 | Priority-based selection and incremental termination to meet memory target |
| 3 | Common-sense protection of system processes not explicitly named in policy |
| 4 | Policy-first principle when memory target conflicts with policy |
| 5 | Change of decision when policy is changed under identical system state (essence of "Conversational") |

## 2.4 Summary of Results

| # | Policy (key idea) | Candidates | AI Selection | Compliant? |
|---|-------------------|------------|--------------|-----------|
| 1 | Protect firefox/code; chrome OK | chrome, firefox, code, systemd | chrome | ✅ |
| 2 | music < browser < editor priority | spotify, chrome, code, slack | spotify + chrome | ✅ |
| 3 | Abstract "system processes" protection | chrome, systemd, init, dbus-daemon | chrome | ✅ |
| 4 | All candidates absolutely protected | firefox, chrome, code, terminal | (none) | ✅ |
| 5a | "Kill chrome" | chrome, spotify, code | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | chrome, spotify, code | spotify | ✅ |

**6 decisions, 6 compliant — Policy Compliance Rate: 100%**

## 2.5 Detailed Analysis

### Scenario 1 — Explicit Policy Interpretation

- **Policy**: "I am coding. Never kill VS Code or firefox. Chrome is fine to kill."
- **LLM rationale**: "Chrome (PID 9999) is explicitly marked 'fine to kill' in the policy. Terminating it frees 1171.875 MB, exceeding the 500 MB target. VS Code and Firefox are protected by policy, and systemd is always excluded."
- **Analysis**: The LLM accurately interpreted the explicit protect/allow rules in the policy, and additionally treated systemd (PID 1) as a system process even though it was not mentioned in the policy.

### Scenario 2 — Priority + Incremental Termination

- **Policy**: "Music apps are lowest priority and can be killed first. Browsers are next priority. Editors and IDEs are critical and should never be killed."
- **LLM rationale**: "Killed spotify (music app, lowest priority) first, then chrome (browser, next priority) to meet 500MB target. Editors/IDEs (code) were spared per policy."
- **Analysis**: Since spotify alone (400 MB) was insufficient to meet the 500 MB target, the LLM additionally selected chrome (next priority in the policy). **The model simultaneously reasoned about the policy's priority structure and the memory target to derive an optimal solution.**

### Scenario 3 — Abstract Policy with Common-Sense Application

- **Policy**: "Kill memory-hogging apps but never kill system processes."
- **LLM rationale**: "Selected chrome as it's a memory-hogging app (1.5GB RSS) and not a system process. Excluded system processes (systemd, init, dbus-daemon) per policy."
- **Analysis**: Although the policy used only the abstract phrase "system processes," the LLM correctly identified systemd, init, and dbus-daemon as system processes and excluded all of them. **This demonstrates common-sense-based interpretation, not mere rule matching.**

### Scenario 4 — Policy-First Principle (Safety Verification)

- **Policy**: "Never kill firefox, chrome, code, or terminal under any circumstances."
- **LLM decision**: `victims: []` (no selection)
- **LLM rationale**: "No processes can be killed as all candidates are explicitly protected by the policy. Target memory cannot be met without violating the policy."
- **Analysis**: **This is one of the most important results in this evaluation.** When the memory target (500 MB) conflicted with the user policy, the system prioritized policy compliance over reaching the memory target and refused to terminate any process. Unlike the default OOM Killer which unconditionally selects a victim, this system exhibits **safe behavior that does not violate user intent.**

### Scenario 5 — Essence of "Conversational"

We measured twice with the same system state (same candidates, same memory) but with different policies.

| | 5a | 5b |
|--|----|----|
| Candidates | chrome, spotify, code | chrome, spotify, code (same) |
| Memory | same | same |
| Policy | "Kill chrome" | "Save chrome, kill spotify instead" |
| AI Selection | **chrome** | **spotify** |

- **Analysis**: Under physically identical system state, changing only the policy led the LLM to make opposite decisions. This is behavior the default OOM Killer cannot exhibit, and **constitutes the core justification for naming this project a "Conversational" OOM Killer.**

## 2.6 Additional Findings

During this evaluation, the following characteristics of the system were additionally observed.

1. **Incremental termination** (Scenario 2) — When a single termination cannot meet the memory target, the system additionally selects the next-priority process per policy.
2. **Common-sense-based safety** (Scenario 3) — Recognizes system processes not explicitly named in the policy and excludes them.
3. **Policy > memory target priority** (Scenario 4) — The most important design principle from a safety standpoint, verified.
4. **State-invariant, policy-variant scenarios** (Scenario 5) — Verifies genuine "Conversational" behavior.

## 2.7 Known Limitations

In Scenario 5b, the LLM responded with "400,000 KB (390.625 MB), exceeding the 500 MB target," but in fact 390.625 MB is below 500 MB. **We confirmed that the LLM's arithmetic reasoning can be inaccurate.** However, the termination target selection itself complied with the policy, so the result of this evaluation (100% policy compliance) is not affected. This is a known general limitation of LLMs, and deterministic computations such as memory calculation should be complemented by deterministic code in the future.

## 2.8 Conclusion

Across 6 decisions, the system achieved a 100% policy compliance rate. We verified that the system accurately interprets natural-language policies, and that it exhibits safe behavior — prioritizing user intent even when policy conflicts with the memory target. In particular, Scenario 5, where changing only the policy under identical system state led the LLM to make opposite decisions, demonstrates that the core value intended by naming this project "Conversational" OOM Killer is genuinely realized.
