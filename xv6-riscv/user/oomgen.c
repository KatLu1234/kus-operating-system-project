// oomgen — randomized memory-pressure load generator for the OOM demo.
//
// Spawns randomly-chosen "service" processes (server, database, security,
// endpoint, ...), each holding a random amount of memory, and keeps spawning
// until the kernel reports a memory shortage (PSI some-pressure rises, or free
// RAM drops below a safety floor). Then it stops; the services it spawned stay
// alive (reparented to init) so oomd can decide which to kill via the LLM.
//
//   $ oomd &
//   $ oomgen
//
// NOTE: this xv6 variant exposes the sleep syscall as pause().

#include "kernel/types.h"
#include "kernel/param.h"
#include "user/user.h"

// The ~10 service types we randomly launch. Each is its own binary so it shows
// up under its own name in the process table.
static char *SERVICES[] = {
    "server", "database",  "security",  "endpoint",  "cache",
    "logger", "gateway",   "scheduler", "analytics", "messaging",
};
#define NSERV (sizeof(SERVICES) / sizeof(SERVICES[0]))

#define TRIGGER_PCT   6      // stop once PSI some-pressure reaches this percent
#define FREE_FLOOR_KB 1024   // ...or once free RAM falls below this (safety)
#define MIN_MB        4
#define MAX_MB        12

// Tiny linear-congruential PRNG (xv6 has no rand()).
static uint seed;
static uint
rnd(void)
{
  seed = seed * 1103515245 + 12345;
  return (seed >> 16) & 0x7fff;
}

// Write an unsigned int as decimal into buf; returns buf.
static char *
utoa(uint v, char *buf)
{
  char tmp[16];
  int i = 0;
  if (v == 0)
    tmp[i++] = '0';
  while (v) {
    tmp[i++] = '0' + (v % 10);
    v /= 10;
  }
  int j = 0;
  while (i)
    buf[j++] = tmp[--i];
  buf[j] = '\0';
  return buf;
}

int
main(void)
{
  struct psi_data psi;
  struct sys_stat st;
  char mbstr[16];
  int spawned = 0;

  seed = (uint)uptime() ^ (uint)getpid() ^ 0x9e3779b9;

  printf("[oomgen] generating random services until memory shortage...\n");

  for (;;) {
    if (get_sys_stat(&st) == 0 && get_mem_pressure(&psi) == 0) {
      int some_pct = (int)(psi.some_avg10 * 100 / 1024);
      int free_kb = (int)(st.free_pages * 4);   // page = 4 KB
      if (some_pct >= TRIGGER_PCT || free_kb < FREE_FLOOR_KB) {
        printf("[oomgen] memory shortage detected: spawned=%d free=%dKB psi_some=%d%%\n",
               spawned, free_kb, some_pct);
        break;
      }
    }

    char *name = SERVICES[rnd() % NSERV];
    int mb = MIN_MB + (int)(rnd() % (MAX_MB - MIN_MB + 1));

    int pid = fork();
    if (pid < 0) {
      printf("[oomgen] fork failed (out of process slots) — stopping\n");
      break;
    }
    if (pid == 0) {
      char *av[] = {name, utoa((uint)mb, mbstr), 0};
      exec(name, av);
      printf("[oomgen] exec %s failed\n", name);
      exit(1);
    }

    spawned++;
    printf("[oomgen] +%s %dMB (pid %d)\n", name, mb, pid);
    pause(10);   // ~1s: let the child touch its pages before the next spawn
  }

  // Leave the services running (reparented to init) for oomd to act on.
  exit(0);
}
