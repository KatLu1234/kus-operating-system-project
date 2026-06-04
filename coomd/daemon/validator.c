// validator.c — last-line safety net on the LLM's victim choice.
//
// The old version read this Linux host's /proc/<pid>/comm and protected
// Linux daemons (systemd, sshd, dbus). That was wrong: the candidates are
// xv6 processes living inside QEMU, so there is no matching /proc entry here.
//
// This version validates against the xv6 process name we already carry in the
// candidate (bridged out of the kernel), and protects the processes that keep
// the xv6 demo alive: init, the shell, and our own monitor/orchestrator
// programs.

#include "validator.h"

#include <string.h>

// xv6 processes that must never be killed, regardless of what the LLM picks.
static const char *PROTECTED_NAMES[] = {
    "init",         // pid 1 — the xv6 init process
    "sh",           // the interactive shell
    "oomd",         // the in-kernel OOM orchestrator (does the real killing)
    "statd",        // the status reporter feeding our bridge file
    "coomd",        // this daemon's xv6-side namesake, if present
    NULL,
};

bool
validator_ok(int pid, const char *name)
{
    // init (and any impossibly-low pid) is always off-limits.
    if (pid <= 1)
        return false;

    if (name) {
        for (int i = 0; PROTECTED_NAMES[i] != NULL; i++) {
            if (strcmp(name, PROTECTED_NAMES[i]) == 0)
                return false;
        }
    }

    return true;
}
