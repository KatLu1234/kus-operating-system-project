#ifndef VALIDATOR_H
#define VALIDATOR_H

#include <stdbool.h>

// Defence-in-depth safety check on an LLM-chosen victim, applied on top of
// whatever the LLM decided. Returns true if (pid, name) is safe to kill.
//
// Because the candidates live inside xv6 (not on this Linux host), the check
// is name- and pid-based using the bridged xv6 process info — NOT /proc.
bool validator_ok(int pid, const char *name);

#endif /* VALIDATOR_H */
