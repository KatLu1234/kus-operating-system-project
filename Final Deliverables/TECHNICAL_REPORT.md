# Technical Report — Conversational OOM Killer

> 📌 **이 프로젝트는 두 브랜치로 구성됩니다 / This project spans two branches:**
> - **`main`** — Linux 데몬(`coomd`) · 정책 부합률 평가(100%) · 최종 문서(Technical Report / Development Process)
> - **`xv6-interface-d`** — xv6 커널 PSI 구현 + Electron 실시간 모니터 (라이브 데모 / live demo)


> Direction B — LLM for OS
> Operating Systems Team Project · Team 06

---

## 1. Environment Setup & How to Run

> Installation and execution manual for the project, which demonstrates an
> LLM-driven OOM killer on top of **xv6-riscv (QEMU)**. For the overall system
> design see `docs/current_architecture.md`; for concepts see `README.md`.

### 1.1 System Overview

```
xv6 (QEMU, -m 128M)                Host (Linux / WSL2)
 ├ statd  → "@@STAT {json}"   ──▶   QEMU stdio relay
 └ oomd   → "@@OOM_REQ"       ──▶    ├ A) Electron interface (primary path)
            inject "@@OOM_RESP" ◀──  └ B) CLI: monitor.py / relay.py
                                          │
                                          └▶ LLM (Upstage Solar) ── coomd / helper.py
```

On the host, choose **one of three** execution paths.

| Path | Tool | Purpose |
| --- | --- | --- |
| **A. Electron interface** | `xv6-interface/` | Primary demo. xv6 + LLM OOM + dashboard GUI |
| **B-1. Kernel dashboard (CLI)** | `coomd/host/monitor.py` | Headless top-style text dashboard |
| **B-2. LLM relay (CLI)** | `coomd/host/relay.py` | Headless xv6 ↔ LLM OOM integration only |

### 1.2 Prerequisites

**Platform:** Linux (Ubuntu 22.04+) or WSL2. Native macOS/Windows is not supported.

| Tool | Min version | Check command | Install (Ubuntu/WSL) |
| --- | --- | --- | --- |
| riscv64 cross GCC | 13.x | `riscv64-linux-gnu-gcc --version` | `sudo apt install gcc-riscv64-linux-gnu` |
| QEMU (riscv64) | **≥ 7.2** | `qemu-system-riscv64 --version` | `sudo apt install qemu-system-misc` |
| GCC (host) | 13.x | `gcc --version` | `sudo apt install build-essential` |
| GNU Make / bc | — | `make --version` | `sudo apt install make bc` |
| Python | 3.10+ | `python3 --version` | `sudo apt install python3 python3-venv python3-pip` |
| Node.js + npm | 20.x | `node -v` | `sudo apt install nodejs npm` (Path A only) |

> One-line install:
>
> ```bash
> sudo apt update && sudo apt install -y \
>   gcc-riscv64-linux-gnu qemu-system-misc build-essential make bc \
>   python3 python3-venv python3-pip nodejs npm
> ```

### 1.3 Build

**xv6 kernel (QEMU image)**

```bash
cd xv6-riscv
make clean && make qemu   # builds and boots in one step — quit: Ctrl-A then X
```

> This is for standalone boot verification. In the actual demo the host relay
> (path A/B) launches `make qemu` for you, so you can quit here.
> On boot, `statd`, `oomd`, and the service processes start automatically and the
> console streams `@@STAT {...}`.

**coomd C daemon (host-side monitor / decision engine)**

```bash
cd coomd
make            # output: coomd/bin/coomd
```

**Python LLM Helper**

```bash
cd coomd
python3 -m venv .venv            # recommended: a project-local venv
source .venv/bin/activate
pip install -r requirements.txt  # openai, python-dotenv
```

> The interface/daemon look for an interpreter in the order
> `coomd/.venv/bin/python3` → system `python3`.

**Electron interface (only if using Path A)**

```bash
cd xv6-interface
npm install
```

### 1.4 LLM (Upstage Solar) Configuration

The Upstage Solar API is used for OOM victim selection.

```bash
cd coomd
cp .env.example .env
# open .env and enter your key:
#   UPSTAGE_API_KEY=up_xxxxxxxxxxxxxxxxxxxxxxxx
```

| Environment variable | Default | Description |
| --- | --- | --- |
| `UPSTAGE_API_KEY` | (required) | Upstage Solar API key |
| `UPSTAGE_BASE_URL` | `https://api.upstage.ai/v1` | API endpoint |
| `LLM_MODEL` / `UPSTAGE_MODEL` | `solar-pro2` | Model to use |
| `OOM_POLICY` | (built-in default policy) | Natural-language policy passed to the LLM |
| `OOM_ENGINE` | `python` | `python` (helper.py) / `llm` (JS fetch) / `heuristic` |

> ⚠️ Never commit `.env` (it is listed in `coomd/.gitignore`). Without a key, the
> helper falls back to mock mode.

### 1.5 Running

> In every path, the host relay automatically launches `make qemu` from
> `xv6-riscv/`. You do not need to start xv6 separately.

**Path A — Electron interface (primary demo)**

```bash
cd xv6-interface
npm start            # debug logs: npm run start:dev
```

Behavior: boot QEMU → parse `@@STAT` → render dashboard → on memory pressure send
`@@OOM_REQ` → LLM victim selection → inject `@@OOM_RESP` + show a parallel `coomd`
monitor card.
Whatever you enter in the "server purpose" popup at startup is applied as the
policy for all OOM decisions.

**Path B-1 — Kernel dashboard (headless)**

```bash
cd coomd/host
python3 monitor.py    # top-like text dashboard (~1 Hz refresh)
```

**Path B-2 — LLM OOM relay (headless)**

```bash
cd coomd/host
python3 relay.py      # @@OOM_REQ → LLM → @@OOM_RESP auto-reply; other console passes through
```

**(Optional) Run the coomd daemon standalone**

While the interface writes the `coomd/.xv6_state` bridge file, separately:

```bash
cd coomd
./bin/coomd --dry-run --threshold 15
```

| Flag | Default | Description |
| --- | --- | --- |
| `--dry-run` | — | Report decisions only, do not send real SIGTERM (recommended for demo) |
| `--threshold <pct>` | `15` | PSI `some_avg10` threshold (%) |

> The candidates coomd sees are processes **inside xv6 (QEMU)**, which the host
> cannot kill directly. Actual termination is performed by xv6's `oomd`, so coomd
> always runs in `--dry-run` (as a parallel decision engine).

### 1.6 Demo Scenario (inducing memory pressure)

From the xv6 console, launch a memory hog to trigger the OOM path:

```text
$ memhog 100      # occupies ~100 pages at a time → pressure → oomd/LLM act
```

When pressure crosses the threshold, the LLM selects a victim (e.g. `memhog`)
according to the policy, while `init`/`sh`/`oomd` are protected.

### 1.7 Shutdown / Cleanup

| Target | Method |
| --- | --- |
| QEMU (xv6) | In the console: `Ctrl-A` → `X` |
| Electron | Close the window, or `Ctrl-C` in the terminal |
| monitor.py / relay.py | `Ctrl-C` |
| Clean build artifacts | `cd coomd && make clean`, `cd xv6-riscv && make clean` |

### 1.8 Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `Couldn't find a riscv64 version of GCC` | Cross-toolchain not installed → `sudo apt install gcc-riscv64-linux-gnu` |
| `Need qemu version >= 7.2` | QEMU too old → install 7.2+ |
| LLM responses come back as mock | Missing/invalid `UPSTAGE_API_KEY` in `coomd/.env` |
| `electron: not found` | Did not run `cd xv6-interface && npm install` |
| helper.py `ModuleNotFoundError: openai` | venv not activated, or `pip install -r requirements.txt` not run |
| Dashboard doesn't appear, only raw `@@STAT` shows | `statd` is not running in xv6 → rebuild the kernel (`make clean && make qemu`) |

---

## 2. System Architecture (Current)

> Snapshot of how the system actually runs today (last updated 2026-06-04). For
> design intent see `docs/xv6_llm_integration.md`; for the OOM-deadlock fix see
> `docs/oom_deadlock_fix.md`.

### 2.1 Overview

The system is now **xv6-centric**. The xv6 kernel senses memory pressure (PSI) and
provides a last-resort OOM safety net; user-space daemons (`statd`, `oomd`) report
state and orchestrate *policy-aware* OOM decisions over a console tag protocol. A
host relay — the **Electron interface (primary path)** or a CLI — bridges xv6's
console to an LLM (Upstage Solar) that recommends victims under a user policy. The
Linux `coomd` daemon, which used to be the primary track, is now a **parallel
reference decision engine** that reads xv6's real state through a bridge file.

### 2.2 Architecture Diagram

```
┌──────────────────────────── xv6 (QEMU, -m 128M) ────────────────────────────┐
│  Kernel                                                                       │
│   • kalloc/kfree + PSI stall (sleep on &kmem)   ← memory-pressure sensing     │
│   • update_psi() (every tick, cpu0)             ← PSI EMA + kernel OOM net     │
│   • oom_kill() (last-resort)                     ← kills largest proc if free=0│
│   • syscalls: get_mem_pressure/sys_stat/proc_stats/oom_candidates             │
│                                                                               │
│  User (auto-started by init at boot)                                          │
│   • statd  → "@@STAT {json}"     (procs/CPU/mem/PSI, ~5Hz)                     │
│   • oomd   → "@@OOM_REQ {json}" / read "@@OOM_RESP" → kill(victim)             │
│   • 10 services (server/database/.../messaging) = memory-holding workloads    │
└───────────────▲───────────────────────────────────────────┬─────────────────┘
   console (UART)│ @@STAT / @@OOM_REQ              @@OOM_RESP │ console stdin
                 │                                            │
┌────────────────┴────────────────────────────────────────────▼────────────────┐
│  Host (one of these relays QEMU stdio)                                          │
│                                                                                │
│  A) Electron interface (xv6-interface/, primary path)                          │
│     main.js: spawn QEMU, parse @@STAT→dashboard, @@OOM_REQ→LLM→@@OOM_RESP,      │
│              write .xv6_state bridge file, run coomd child                      │
│     renderer.js: service cards / memory graph / PSI / OOM log / popup           │
│                                                                                │
│  B) CLI (coomd/host/)                                                           │
│     monitor.py: @@STAT → text dashboard / relay.py: @@OOM_REQ → LLM             │
│                                                                                │
│  LLM victim selection: coomd/LLM_client/helper.py (Upstage Solar, mock if no key)│
│                                                                                │
│  coomd (parallel reference daemon): read .xv6_state → helper.py → report        │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Components

| Location | Role |
| --- | --- |
| `xv6-riscv/` | Kernel + user programs (PSI, kernel OOM safety net, statd, oomd, 10 services, oomgen) |
| `xv6-interface/` | Electron interface (dashboard, popup, QEMU relay, LLM calls, bridge writing) |
| `coomd/` | Host-side C daemon (parallel decision) + Python LLM helper + CLI relay/monitor |
| `docs/`, `plan/` | Design documents / plans |

### 2.4 Two-Layer OOM Decision

```
Layer 1 (smart):   oomd → @@OOM_REQ → host/LLM → @@OOM_RESP → kill(victim)
                   Policy-aware (server purpose). Handles the case if it acts in time.

Layer 2 (safety):  kernel update_psi() → free=0 + stall sustained 3s → oom_kill(largest proc)
                   Policy-unaware but guarantees liveness. Fires only if Layer 1 fails.
```

### 2.5 Console Tag Protocol (shared console)

```
xv6 → host :  @@STAT     {"uptime":..,"free_pg":..,"psi_some":..,"procs":[{pid,st,name,sz_kb,cpu,stall},..]}
xv6 → host :  @@OOM_REQ  {"psi":..,"candidates":[{pid,name,sz_kb},..]}
host → xv6 :  @@OOM_RESP {"victims":[pid,..],"reasoning":".."}
kernel     :  [kernel-oom] out of memory: killed pid N (name, KB)   ← when the kernel safety net fires
```

---

## 3. xv6 Kernel

### 3.1 Memory-Pressure (PSI) Mechanism

- `kernel/kalloc.c`: when no free page is available, the calling process is put to
  `sleep(&kmem)` (accumulating `mem_stall_ticks`); `kfree` issues `wakeup(&kmem)`.
- `kalloc.c: kmemexhausted()` — **O(1)** check of whether the freelist is empty
  (used by the safety net, called every tick).
- `kernel/proc.c: update_psi()` — every tick (cpu0, called from `trap.c clockintr`):
  computes *some*/*full* from stall/runnable counts and updates a fixed-point
  (×1024) EMA. It also runs the kernel OOM safety net (§3.2).

### 3.2 Kernel OOM Safety Net (last-resort) — `kernel/proc.c`

A last resort ensuring the system **never deadlocks**, even if the LLM/host OOM
path fails to act in time (details: `docs/oom_deadlock_fix.md`).

```
free=0 + stall sustained for OOM_GRACE_TICKS (30 ticks ≈ 3s) → oom_kill()
  oom_kill(): marks the largest user proc killed=1 + RUNNABLE so it terminates
              (init/sh/statd/oomd are oom_protected)
If oomd/host frees memory within 3s → the counter resets → kernel stays out (LLM first)
```

### 3.3 Added System Calls (registered in the same 5 places as the PSI pattern)

| # | System call | Purpose |
| --- | --- | --- |
| 22 | `get_mem_pressure(struct psi_data*)` | PSI some/full avg10 |
| 23 | `get_sys_stat(struct sys_stat*)` | System snapshot: uptime/free/total/ncpu/PSI |
| 24 | `get_proc_stats(struct proc_stat*, max)` | Per-process state/memory/cpu/stall |
| 25 | `get_oom_candidates(struct oom_cand*, max)` | OOM candidates (pid/name/sz_kb) |

Structures are defined in `kernel/types.h` (`psi_data`, `sys_stat`, `proc_stat`, `oom_cand`).

### 3.4 Boot Auto-Start — `user/init.c`

Right after setting up the console fds and **before** launching the shell, `init`
directly fork+execs `statd 2 &` and `oomd &`. This means state reporting and OOM
monitoring run immediately at boot **regardless of the execution path**, without
depending on host stdin injection.

---

## 4. xv6 User Programs

| Program | Role | Output / Input |
| --- | --- | --- |
| `statd <period>` | Periodic process/CPU/memory/PSI report | `@@STAT {json}` every `period` ticks (default init=2 ≈ 5Hz) |
| `oomd` | PSI watch → collect candidates → request → kill victim | sends `@@OOM_REQ {json}`, reads `@@OOM_RESP`, `kill()` |
| 10 services | Memory-holding workloads (OOM candidates) | `<name> <MB>` (28 MB if no arg) |
| `oomgen` | Random load generator | — |
| `memhog <MB>` | Simple memory-occupancy test | — |

The 10 services — `server database security endpoint cache logger gateway
scheduler analytics messaging` — share one body, `user/service.h: service_main()`
(allocate the requested MB, touch the pages, then hold via `pause()`). Each is a
separate binary so it appears in the process table under its own name.

---

## 5. Host — Electron Interface (`xv6-interface/`)

| File | Role |
| --- | --- |
| `main.js` | Spawn QEMU (`make clean && make qemu`), relay/parse console lines, `@@STAT`→`kstat:update`, `@@OOM_REQ`→LLM→`@@OOM_RESP` injection, write `.xv6_state` bridge, run coomd child, parse `[kernel-oom]`/`[oomd]` lines |
| `renderer.js` | Dashboard: service cards (gray/green/red), memory graph, PSI, OOM log, server-purpose popup, command bar; per-service memory weighting (avg ~32 MB) |
| `preload.js` | IPC bridge (contextBridge) |
| `index.html` / `styles.css` | UI layout / style |

### Data Flow

- **State:** QEMU stdout → `routeQemuOutput()` → `@@STAT` → `handleStatLine()` →
  CPU% delta computation → `kstat:update` render + `writeXv6StateForCoomd()` writes
  `coomd/.xv6_state`.
- **OOM:** `@@OOM_REQ` → `handleOomReq()` → `decideOom()` (helper.py, or JS fetch,
  or heuristic) → inject `@@OOM_RESP` + `oom:event(decision)` render (card turns red).
- **Kill visualization:** parse `[oomd] killing pid N` (xv6 oomd) and
  `[kernel-oom] ... killed pid N` (kernel safety net) lines and reflect them on the dashboard.

---

## 6. Host — coomd (Parallel Decision Daemon, `coomd/`)

Because the host cannot directly kill processes that live **inside xv6 (QEMU)**,
coomd is a parallel monitor that **reads xv6's real state, detects pressure, asks
the LLM, and reports a decision**. The interface runs it as a `--dry-run` child.

| File | Role |
| --- | --- |
| `daemon/main.c` | Loop: read `.xv6_state` → on pressure call helper.py → validate → report EVENT |
| `daemon/xv6_state.c/.h` | `.xv6_state` bridge parser (real PSI/processes, stale/missing handling) |
| `daemon/validator.c/.h` | Defense-in-depth for xv6 protected targets (init/sh/oomd/statd/coomd) |
| `LLM_client/helper.py` | Upstage Solar victim selection (`decide_victims`, mock if no key) |
| `host/monitor.py` | `@@STAT` → text top dashboard (no Electron) |
| `host/relay.py` | `@@OOM_REQ` → LLM → `@@OOM_RESP` injection (no Electron) |
| `.xv6_state` | Bridge written by the interface: `PSI <some> <full>` + `PROC <pid> <rss_kb> <name>` |

coomd stdout contract (parsed by renderer/main.js): `EVENT {kind: startup|pressure|decision|kill|blocked|error, ...}`.

---

## 7. LLM Integration

- Model: Upstage Solar (`coomd/LLM_client/helper.py`), key from `coomd/.env`'s `UPSTAGE_API_KEY`.
- Input JSON: `{policy, candidates:[{pid,comm,rss_kb}], target_free_mb}`.
- Output JSON: `{victims:[pid,..], reasoning, confidence}`.
- Policy = built-in default policy + the **server purpose (SERVER_PURPOSE)** from the commissioning popup.
- Without a key, it falls back to a mock (pick the largest-memory non-system process).

The LLM is a **recommender**, not a decision-maker: it proposes victims, but the
deterministic validator/kernel makes the final, safe call. `temperature=0` and
JSON-enforced output keep responses consistent and parseable. A natural-language
policy can express abstract intent ("music apps are least important"); the LLM
resolves this semantically (e.g. recognizing a music app, or avoiding `systemd`)
even when names are not explicitly listed.

---

## 8. OS Concepts in Play (and Where)

This is the core of why the project is genuinely an OS design, not an LLM wrapper.

| OS Concept | Where it is used | Component |
| --- | --- | --- |
| **PSI (Pressure Stall Information)** | `kalloc` sleep/wakeup stall + `update_psi` EMA (xv6); mirrored from `/proc/pressure` in coomd | xv6 kernel / coomd |
| **Memory management** | Allocator instrumentation in `kalloc`/`kfree`; kernel OOM safety net (`oom_kill`) | xv6 kernel |
| **System calls** | `get_mem_pressure`/`get_sys_stat`/`get_proc_stats`/`get_oom_candidates` | xv6 kernel |
| **Process creation / lifecycle** | `init` fork+execs `statd`/`oomd` at boot; victim termination via `kill()` | xv6 kernel |
| **Synchronization** | Lock-safe PSI update (release locks in `allocproc`/`kfork`); `sleep`/`wakeup` on `&kmem` | xv6 kernel |
| **Device driver / IPC** | Console UART tag protocol (`@@STAT`/`@@OOM_REQ`/`@@OOM_RESP`) between xv6 and host | xv6 ↔ host |
| **Signals / termination** | Kernel `oom_kill` (`killed=1` + `RUNNABLE`); oomd `kill(victim)` | xv6 kernel |
| **Process creation (host)** | coomd spawns the Python helper via `fork()` + `execlp()` + `pipe()` | coomd |

The OS component (PSI sensing, allocator instrumentation, system calls, IPC, and
signals) is something the team designed and implemented. The LLM only *recommends*
a victim within this OS machinery.

---

## 9. Memory Budget (current configuration)

- Physical RAM: **128 MB** (`Makefile -m 128M`, `memlayout.h PHYSTOP=KERNBASE+128MB`).
- Kernel-manageable allocation: ~32,732 pages ≈ **127.9 MB** (4 KB pages).
- User-available: ~**127 MB** (minus small amounts for init/sh/statd/oomd).
- Service memory weighting (renderer.js): avg ~32 MB → **about 5 services trigger
  pressure**, ≤4 is usually safe. (Even the five lightest services together exceed the ceiling.)

---

## 10. Evaluation

Across 5 scenarios (6 decisions), the system achieved **100% policy compliance**.
Notably, scenario 5 showed that with identical system state, changing only the
policy flips the decision — the essence of "conversational." Scenario 4 showed the
system refusing to kill when the policy protected everything (safety over the
memory goal). On the xv6 side, under QEMU `some_avg10` was observed rising from 0%
to 9% under memory pressure, and the kernel OOM safety net reliably prevents the
memory-deadlock (freeze) condition.

---

## 11. Limitations

- **LLM latency** — Inference adds delay versus the kernel's instant scoring. PSI triggers early (before hard OOM) to buy time; the two-layer design ensures liveness regardless. Local models or caching could reduce latency further.
- **Determinism** — `temperature=0` improves consistency, but LLMs are not perfectly deterministic; the validator and kernel safety net bound the risk.
- **Shared console** — `@@STAT`/`@@OOM_*` share the console (UART) with normal output; the relay filters by tag, but heavy interleaving could still garble a line. A dedicated channel (second UART / semihosting) would fully isolate it.
- **Evaluation scope** — 5 scenarios demonstrate the concept; a larger, adversarial suite would further stress-test policy compliance.
- **External dependency** — The smart path depends on a network LLM API and key; the mock fallback mitigates but does not replace it.

---

## 12. File Map (core)

```
xv6-riscv/
  kernel/kalloc.c        # PSI stall, kmemexhausted()
  kernel/proc.c          # update_psi(), oom_kill(), kernel OOM safety net
  kernel/trap.c          # clockintr → ticks++, update_psi(), cpu_ticks
  kernel/sysproc.c       # get_sys_stat / get_proc_stats / get_oom_candidates / get_mem_pressure
  kernel/types.h         # psi_data, sys_stat, proc_stat, oom_cand
  user/init.c            # auto-start statd & oomd at boot
  user/statd.c           # @@STAT reporting daemon
  user/oomd.c            # OOM orchestrator (@@OOM_REQ/@@OOM_RESP)
  user/service.h         # shared service body service_main()
  user/<service>.c       # 10 service wrappers
  user/oomgen.c, memhog.c
  Makefile               # UPROGS (10 services + oomgen included), -m 128M
xv6-interface/
  main.js, renderer.js, preload.js, index.html, styles.css
coomd/
  daemon/main.c, xv6_state.c/.h, validator.c/.h
  LLM_client/helper.py
  host/monitor.py, relay.py
  .xv6_state             # runtime bridge file (gitignored)
docs/  plan/             # documents / plans
```

---

## 13. Recent Major Changes (reflected in this architecture)

- **coomd rewrite** — Removed the mock (hard-coded PSI/chrome); now reflects real xv6 data via the `.xv6_state` bridge (validator also retargeted to xv6).
- **Fixed missing 10 services in fs.img** — Added to `UPROGS` in the Makefile (otherwise `exec` failed).
- **Re-tuned service memory weighting** — So that ~5 services trigger pressure.
- **Moved statd/oomd auto-start** — From host stdin injection to direct launch in `init.c`.
- **Added kernel OOM safety net** — Eliminated the memory deadlock (freeze). (`docs/oom_deadlock_fix.md`)

---

## 14. Summary

The Conversational OOM Killer demonstrates that OOM victim selection can follow
user intent expressed in natural language, while a deterministic OS-level safety
net guarantees the system never sacrifices liveness. The design exercises core OS
concepts — PSI, system calls, memory management, IPC (a console tag protocol),
process lifecycle, synchronization, and signals — primarily inside the xv6 kernel,
with a two-layer OOM decision (LLM-driven smart layer + kernel last-resort layer)
and the LLM serving strictly as a bounded recommender.
