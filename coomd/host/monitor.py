#!/usr/bin/env python3
"""monitor.py — xv6 kernel-status dashboard for the CLI (non-Electron) path.

Spawns `make qemu`, hides statd's raw `@@STAT {json}` lines from the console,
and renders a clean top-like dashboard (process list, CPU%, memory%, PSI,
runqueue) that refreshes ~1/s. Ordinary console traffic passes through.

Run from this directory:   python3 monitor.py
Inside xv6:                $ statd &   then   $ memhog 100
See docs/xv6_kernel_monitor.md §6.
"""
import subprocess, sys, threading, json, os

STATE = {1: "USED", 2: "SLEEP", 3: "READY", 4: "RUN", 5: "ZOMBIE"}
PG_KB = 4   # xv6 page = 4 KiB

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# xv6 lives in its own checkout dir; fall back to the repo root if absent.
XV6_DIR = os.path.join(PROJECT_ROOT, "xv6-riscv")
if not os.path.exists(os.path.join(XV6_DIR, "Makefile")):
    XV6_DIR = PROJECT_ROOT

qemu = subprocess.Popen(
    ["make", "qemu"], cwd=XV6_DIR,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    bufsize=1, universal_newlines=True,
)

prev = {}            # pid -> cpu_ticks of previous sample (for CPU% delta)
prev_uptime = [0]


def render(o):
    os.system("clear")
    up = o["uptime"]
    d_up = max(1, up - prev_uptime[0])
    used_pg = o["total_pg"] - o["free_pg"]
    mem_pct = 100.0 * used_pg / o["total_pg"] if o["total_pg"] else 0.0
    print("=" * 64)
    print(f" xv6 KERNEL STATUS    uptime={up} ticks    cpus={o['ncpu']}")
    print("=" * 64)
    print(f" MEM  : {used_pg * PG_KB // 1024} / {o['total_pg'] * PG_KB // 1024} MB "
          f"({mem_pct:4.1f}%)   free={o['free_pg'] * PG_KB // 1024}MB")
    print(f" SCHED: running={o['running']}  ready={o['runnable']}  (runqueue load)")
    print(f" PSI  : some={o['psi_some']}%  full={o['psi_full']}%")
    print("-" * 64)
    print(f" {'PID':>4} {'NAME':<12} {'STATE':<7} {'MEM(KB)':>9} {'CPU%':>6}")
    print("-" * 64)
    for p in sorted(o["procs"], key=lambda x: -x["cpu"]):
        d_cpu = p["cpu"] - prev.get(p["pid"], p["cpu"])
        cpu_pct = 100.0 * d_cpu / (d_up * o["ncpu"])
        print(f" {p['pid']:>4} {p['name']:<12} {STATE.get(p['st'], '?'):<7} "
              f"{p['sz_kb']:>9} {cpu_pct:>5.1f}")
    prev.clear()
    prev.update({p["pid"]: p["cpu"] for p in o["procs"]})
    prev_uptime[0] = up


def pump():
    for line in qemu.stdout:
        s = line.rstrip("\n")
        if s.startswith("@@STAT"):
            try:
                render(json.loads(s[len("@@STAT"):].strip()))
            except json.JSONDecodeError:
                pass
        elif s.startswith("@@"):
            pass
        else:
            sys.stdout.write(line)
            sys.stdout.flush()


threading.Thread(target=pump, daemon=True).start()

try:
    for line in sys.stdin:
        qemu.stdin.write(line)
        qemu.stdin.flush()
except (BrokenPipeError, KeyboardInterrupt):
    pass
