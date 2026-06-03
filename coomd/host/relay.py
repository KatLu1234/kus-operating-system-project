#!/usr/bin/env python3
"""relay.py — xv6 ↔ LLM relay for the CLI (non-Electron) demo path.

Spawns `make qemu` as a child and relays its stdio. Intercepts the tagged
protocol lines from xv6's oomd:

    xv6  -> host :  @@OOM_REQ  {"psi":..,"candidates":[{pid,name,sz_kb},...]}
    host -> xv6  :  @@OOM_RESP {"victims":[pid,...],"reasoning":".."}

For each @@OOM_REQ we ask the LLM (Upstage Solar, via LLM_client/helper.py's
decide_victims) which pid to kill, then inject an @@OOM_RESP line back into
xv6's stdin. Every other line is passed straight through to the terminal.

Run from this directory:   python3 relay.py
See docs/xv6_llm_integration.md §5.
"""
import subprocess, sys, threading, json, os

# Reuse the LLM victim-selection core from helper.py.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "LLM_client"))
from helper import decide_victims  # noqa: E402

# Natural-language policy handed to the LLM for every decision.
POLICY = os.environ.get(
    "OOM_POLICY",
    "Keep init and the shell (sh) and oomd alive. Memory hogs such as memhog "
    "are fine to kill to relieve pressure.",
)

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


def handle_oom_req(payload):
    try:
        req = json.loads(payload)
    except json.JSONDecodeError:
        return
    candidates = req.get("candidates", [])
    decision = decide_victims(POLICY, candidates, target_free_mb=64)
    victims = [v for v in decision.get("victims", []) if isinstance(v, int) and v > 1]
    resp = json.dumps({"victims": victims, "reasoning": decision.get("reasoning", "")})
    qemu.stdin.write("@@OOM_RESP " + resp + "\n")
    qemu.stdin.flush()
    # Surface the decision on stderr so the human watching can see it (the
    # request/response lines themselves stay off the xv6 console).
    sys.stderr.write(f"[relay] psi={req.get('psi')} victims={victims}\n")
    sys.stderr.flush()


def pump():
    for line in qemu.stdout:
        s = line.rstrip("\n")
        if s.startswith("@@OOM_REQ"):
            handle_oom_req(s[len("@@OOM_REQ"):].strip())
        elif s.startswith("@@"):
            pass  # hide other tagged lines (@@OOM_RESP echo, @@STAT, ...)
        else:
            sys.stdout.write(line)
            sys.stdout.flush()


threading.Thread(target=pump, daemon=True).start()

# Forward the user's keyboard input to the xv6 shell.
try:
    for line in sys.stdin:
        qemu.stdin.write(line)
        qemu.stdin.flush()
except (BrokenPipeError, KeyboardInterrupt):
    pass
