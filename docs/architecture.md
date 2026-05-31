# Architecture

## Overview

The Conversational OOM Killer is a daemon running in Linux userspace. It detects memory pressure via PSI (Pressure Stall Information), and asks an LLM to select victim processes according to a user-written natural-language policy.

## Overall Structure

![Architecture](./architecture.png)

The system consists of two processes.

- **Main Daemon (`coomd`)**: A C daemon running with root privileges. Responsible for PSI monitoring, `/proc` introspection, IPC, victim validation, and signal dispatch.
- **LLM Helper**: A Python child process. The main daemon spawns it via `fork` + `exec`, and communicates with it bidirectionally over a `pipe` using JSON. It calls the Solar API to obtain victim recommendations.

## Components

### 1. PSI Monitor (R1, C)

Polls `/proc/pressure/memory` every second. When the `some avg10` value exceeds the threshold (default 15.0%), a `pressure_event` is raised and delivered to the Main Loop.

### 2. /proc Reader (R2, C)

On a pressure event, collects metadata of all user processes. For each PID, parses `/proc/[pid]/status` (VmRSS, Uid, PPid), `cmdline`, `oom_score`, and `cgroup`. Kernel threads are filtered out by the `PPid == 2` condition.

### 3. Main Loop (R4, C)

Receives PSI events and orchestrates candidate collection, IPC invocation, validation, and dispatch. The orchestrator of the system.

### 4. IPC (R4, C)

Handles communication with the Python LLM Helper. On daemon startup, the helper is spawned via `fork` + `execlp`, and two pipes (parent→child, child→parent) form a bidirectional channel. The protocol is line-delimited JSON.

### 5. LLM Helper (R3, Python)

Runs as a separate process using only stdin/stdout. Receives candidate JSON and user-policy text, combines them with a system prompt, and forwards them to Upstage Solar Pro 3. Outputs the response as a one-line JSON. Uses the OpenAI SDK–compatible interface with `temperature=0` and `response_format=json_object` to enforce deterministic responses.

### 6. Validator (R4, C)

Checks LLM-recommended PIDs against a whitelist. Unconditionally rejects PID 1, systemd, sshd, dbus-daemon, and the daemon itself. A safety boundary that does not trust the LLM response blindly.

### 7. Signal Dispatcher (R4, C)

Sends `SIGTERM` to the approved PID and waits up to 5 seconds; if the process does not terminate, escalates to `SIGKILL`. Zombies are reaped via `waitpid(WNOHANG)`.

## Data Flow

A single cycle proceeds in the following order.

1. `coomd` starts, loads `~/.oom_policy` into memory, and spawns the LLM Helper via `fork` + `exec`.
2. The PSI Monitor detects that `some_avg10` exceeds the threshold and invokes a callback.
3. The Main Loop calls the /proc Reader to produce a candidate list (JSON).
4. IPC sends the candidate JSON plus the policy text to the LLM Helper via the pipe.
5. The LLM Helper calls the Solar API and returns a victim JSON.
6. The Validator performs whitelist checks.
7. The Signal Dispatcher: SIGTERM → wait → SIGKILL.

## Design Choices

### C Daemon + Python Helper Separation

PSI, `/proc`, and signal handling revolve around system calls, which makes C a natural fit. LLM API calls, on the other hand, involve HTTPS, JSON, and SDK dependencies — much more concise in Python. To leverage the strengths of both languages, the processes are separated and communicate over a pipe. This separation itself is a natural application of OS concepts (process creation, IPC).

### Placing the Validator Outside the LLM

To prevent the LLM from recommending an invalid PID (e.g., PID 1), safety verification is performed in deterministic C code. The LLM proposes; the OS decides.

### Deterministic LLM Responses

`temperature=0` and forced JSON output guarantee the same response for the same input. Essential for debugging, reproducibility, and reliable evaluation.
