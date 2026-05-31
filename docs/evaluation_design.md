# Evaluation Design

This document outlines the evaluation design used to verify how much better this system reflects user intent compared to the default Linux OOM Killer. Actual measurement and data collection are conducted separately.

## 1. Evaluation Goals

We answer the following three questions.

1. **Policy Compliance Rate**: Does our system select victims without violating the user policy?
2. **System Recovery**: When memory pressure occurs, does the system recover sufficient memory? How much does recovery time differ from the default OOM Killer?
3. **Decision Stability**: Does the LLM produce consistent decisions for identical inputs?

## 2. Comparison Targets

- **Baseline**: The default Linux OOM Killer (default `vm.overcommit_memory`, victim selection by `oom_score`).
- **Treatment**: Our `coomd` daemon (PSI + LLM + Validator).

The two systems are executed in separate VMs under identical load scenarios.

## 3. Load Scenarios (3 Total)

Each scenario is written as a reproducible Python script.

### Scenario A — Gradual Memory Leak

A single process accumulates memory at a regular interval. The most common OOM pattern.

```python
# eval/scenarios/gradual_leak.py
import time
blocks = []
while True:
    blocks.append(bytearray(100 * 1024 * 1024))  # 100MB
    time.sleep(2)
```

**Purpose**: Observe who is chosen as victim under gradually increasing pressure. The default OOM is likely to kill the leaking process itself, but we compare behavior when the user explicitly protects another process.

### Scenario B — Sudden Large Allocation

While background processes run stably, one process requests a large memory block at once.

```python
# eval/scenarios/sudden_alloc.py
import sys
size_mb = int(sys.argv[1])  # e.g., 4000
buf = bytearray(size_mb * 1024 * 1024)
input("Press Enter to release...")
```

**Purpose**: Verify whether PSI triggers quickly, and observe system reaction during LLM latency.

### Scenario C — Multiple Concurrent Processes

Multiple medium-sized processes use memory simultaneously, modeling a build server or multi-container host.

```python
# eval/scenarios/multi_process.py
# Fork 10 child processes, each using 300MB
```

**Purpose**: Measure LLM policy-interpretation accuracy when there are many candidates, especially whether `cmdline` pattern matching (e.g., "browser tabs", "dev-* containers") works correctly.

## 4. Evaluation Metrics

### 4.1 Policy Compliance Rate

Proportion of selected victims that do **not** violate the user policy.
- Method: For each scenario, check whether pre-labeled "protected" processes were killed.
- Form: percentage (`100 × (1 − violations / total)`).

### 4.2 Recovery Time

Elapsed time from when PSI exceeds the threshold until memory pressure returns to normal levels.
- Method: Time until PSI `some avg10` falls below the threshold.
- Unit: seconds.

### 4.3 Decision Latency

Elapsed time from a PSI event to the first signal dispatch.
- Breakdown: PSI detection → `/proc` scan → IPC send → LLM response → Validator → signal send.
- Unit: milliseconds.

### 4.4 Decision Consistency

Proportion of identical victim selections when the LLM is given the same candidate list and policy. Verifies whether residual non-determinism remains despite `temperature=0`.
- Method: Repeat each scenario 10 times and compute the agreement rate.

## 5. Experimental Environment

- **VM**: VirtualBox or multipass, Ubuntu 22.04, RAM 4 GB, swap disabled.
- **Repetitions**: Each scenario × each system (baseline/treatment) × 10 runs.
- **Sample user policy**:
- **Logging**: Each run stores PSI time series, `/proc` snapshots, victim PIDs, and recovery times as JSON logs.

## 6. Hypotheses

- **H1**: Our system's policy compliance rate is significantly higher than the default OOM Killer (≥ 80% vs. ~50%).
- **H2**: Our system's recovery time is longer than the default OOM Killer by the LLM latency (1–2 seconds), but user utility is higher due to avoidance of large work-loss events.
- **H3**: With `temperature=0`, decision consistency reaches ≥ 95%.

## 7. Limitations (To be stated in Week 13 report)

- Evaluation is limited to VM environments; differences from real desktop/server environments may exist.
- The variety of user policies tested is limited (1–3 cases).
- Reliance on an external LLM API limits reproducibility.
