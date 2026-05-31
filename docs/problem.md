# Problem Statement

## 1. Background — A Phenomenon Everyone Has Experienced

While working on a laptop, you may have suddenly seen a bunch of Chrome tabs closed, VS Code shut down, or the terminal running your compilation vanish. On phones, it is common for a game to restart from the beginning after switching to another app and returning.

This phenomenon occurs because the operating system **intentionally terminated processes under memory pressure**. The kernel mechanism in Linux responsible for this is the **OOM Killer (Out-Of-Memory Killer)**.

## 2. How the Default OOM Killer Works

The OOM Killer is triggered when the system's available memory falls below a threshold. It computes an `oom_score` for every running process based on factors such as:

- The process's memory usage (`VmRSS`)
- Execution time
- The nice value
- The administrator-tuned `oom_score_adj` adjustment

The process with the highest score becomes the termination target. In other words, by default, **processes that use the most memory are killed first**.

## 3. Limitations of the Default Mechanism

The `oom_score` approach considers only system-level metrics. **User intent is not reflected at all**. As a result, the following situations occur frequently.

**Scenario 1 — During Development**
A user is coding in VS Code (2 GB), with a Chrome window (2.5 GB) in the background. When memory pressure occurs, the OOM Killer may kill the process with the higher `oom_score` — from the user's perspective, the **more important** VS Code.

**Scenario 2 — During a Build**
While a large build (`cargo build`, `npm run build`) causes memory pressure, the OOM Killer may kill the build itself. All progress is lost.

**Scenario 3 — Container Environments**
When multiple Docker containers run simultaneously, a development container critical to the user (`dev-postgres`) and a trivial test container (`random-test`) are evaluated by the same `oom_score`. The user's priority intent is not applied.

Manually adjusting `oom_score_adj` can mitigate this somewhat, but **the user must set numbers for every process in advance**, and must re-set them every time the work context changes (coding → gaming → presentation). In practice, most users do not use this feature.

## 4. Our Approach — Conversational OOM Killer

This project redesigns the OOM victim-selection mechanism as follows.

1. **The user writes priorities in natural language.** They express their intent as a one-paragraph text file (`~/.oom_policy`).
2. **When memory pressure is detected, an LLM recommends victims according to the policy.** A userspace daemon detects pressure via PSI (Pressure Stall Information), collects `/proc` metadata, and forwards them to Upstage Solar Pro 3. The LLM interprets the policy's intent and responds with appropriate victim PIDs.
3. **Safety is guaranteed by deterministic verification.** LLM responses are passed to the signal dispatcher only after a whitelist check (PID 1, systemd, sshd, etc.). The LLM only suggests; the final decision is made by OS-side code.

## 5. Why an LLM Is Necessary

Some cases could be handled by simple grep/regex-based rules. However, an LLM is fundamentally advantageous in the following respects.

- **Semantic matching**: If a user writes "compilers," the system should automatically include `gcc`, `cargo`, `npm`, `make`, `javac`, etc. A rule-based approach requires the user to enumerate every name.

- **Free-form policy**: Flexible expressions such as "Protect what I have open while coding; you can kill music and games" can be input as-is.

- **Contextual aggregation**: The LLM can simultaneously consider multiple signals — `cmdline`, `cgroup`, parent PID — of candidate processes to derive a priority judgment.

## 6. Contributions

This project contributes the following:

- Design and implementation of an OOM victim-selection mechanism based on natural-language policy
- A deterministic Validator layer to ensure the safety of LLM responses
- System integration leveraging core OS concepts such as PSI, `/proc`, signals, and IPC
- Comparative evaluation against the default Linux OOM Killer
- A porting design for xv6-riscv
