# OS Concepts in Play

This project applies the core operating-system concepts taught in class in a practical way. The following summarizes which concepts are applied to which component, and how.

## 1. Mapping Table

| OS Concept | Where Used | Role | Component |
|------------|------------|------|-----------|
| Memory management / cgroups v2 / PSI | Polling `/proc/pressure/memory` to detect system-wide memory pressure | R1 | `daemon/psi_monitor.c` |
| `/proc` filesystem introspection | Collecting metadata of all user processes (`status`, `cmdline`, `oom_score`, `cgroup`) | R2 | `daemon/proc_reader.c` |
| Process creation (`fork` + `execlp`) | The C daemon spawns the Python LLM Helper as a child process | R4 | `daemon/ipc.c` |
| IPC (pipe) | Bidirectional communication (stdin/stdout) between the C daemon and the Python helper | R4 | `daemon/ipc.c` |
| System calls / signals (`kill`, `waitpid`) | `SIGTERM` → wait → `SIGKILL` escalation against the victim process | R4 | `daemon/dispatcher.c` |
| Process lifecycle | Zombie reaping (`waitpid(WNOHANG)`) | R4 | `daemon/dispatcher.c` |
| Cache / replacement policy (bonus) | LRU-inspired decision cache to mitigate LLM latency | R3 / R4 | Week 12+ |

## 2. Role of Each Concept

### 2.1 PSI (Pressure Stall Information)

A resource-pressure metric introduced in Linux kernel 4.20+, integrated with cgroups v2 and exposed at `/proc/pressure/memory`. This project polls the `some avg10` field and triggers the decision loop when memory pressure exceeds the threshold. This is essentially the kernel itself providing an "imminent out-of-memory" signal, and corresponds to the entry point of this system.

### 2.2 The `/proc` Filesystem

A virtual filesystem through which the Linux kernel exposes process information as pseudo-files. The system traverses `/proc` using `opendir(2)` / `readdir(3)`, then parses each PID's subfiles to build the candidate metadata passed to the LLM. A Linux-specific pattern in which rich kernel-side information is accessed via text parsing alone, without system calls.

### 2.3 Process Creation and IPC

The system consists of two processes: a C daemon and a Python LLM Helper. On daemon startup, two `pipe(2)`s are created; after `fork(2)`, the child's stdin/stdout are wired to the pipes via `dup2(2)`, and `execlp(3)` is invoked to run the Python helper. This directly applies the canonical process-creation and IPC patterns taught in the operating-systems course.

### 2.4 Signals and Process Lifecycle

After a victim is decided, `kill(2)` is used to send `SIGTERM`, and the system waits up to 5 seconds for a response. If the process does not terminate normally, the signal is escalated to `SIGKILL`. Zombie states of terminated child processes are reaped asynchronously via `waitpid(WNOHANG)`.

### 2.5 Cache / Replacement Policy

An LLM call takes 1–2 seconds, which is unsuitable for real-time memory-pressure response. To mitigate this, a decision cache that pre-computes decisions when memory usage reaches a certain level will be introduced. Cache invalidation is driven by process creation/exit events. This is structurally identical to OS page caches / LRU replacement.

## 3. Why This Is an Operating-Systems Project

The LLM is merely one component of the system. Everything before and after the decision — detecting memory pressure, collecting candidates, creating processes, IPC, validation, signal dispatch, and zombie reaping — is **implemented in C code that directly handles OS-level system calls and data structures**. The LLM API call is a single line of HTTPS, but the OS mechanisms surrounding that call are the essence of the project.
