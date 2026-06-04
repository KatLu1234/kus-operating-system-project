#ifndef SERVICE_H
#define SERVICE_H

// Shared body for the test "service" workloads (server, database, security,
// endpoint, ...). Each service is its own tiny binary that just calls
// service_main(), so it shows up under its own name in the xv6 process table.
//
//   argv[1] = megabytes of memory to hold (default 6).
//
// The service allocates that much memory and touches every page so the kernel
// actually backs it with physical RAM (counted by the kernel monitor / PSI),
// then idles holding the memory until oomd (or the user) kills it.
//
// NOTE: this xv6 variant exposes the sleep syscall as pause().

#include "kernel/types.h"
#include "user/user.h"

#define SERVICE_PGSIZE 4096

static int
service_main(int argc, char **argv)
{
  int mb = argc > 1 ? atoi(argv[1]) : 28;   // ~5 default-size services exhaust RAM
  if (mb < 1)
    mb = 1;
  uint64 bytes = (uint64)mb * 1024 * 1024;

  char *buf = malloc((uint)bytes);
  if (buf == 0) {
    // Stay alive even on failure so we remain a visible OOM candidate.
    printf("%s: could not allocate %d MB\n", argv[0], mb);
  } else {
    // Touch one byte per page so the pages are really resident.
    for (uint64 i = 0; i < bytes; i += SERVICE_PGSIZE)
      buf[i] = (char)(i + 1);
  }

  // Hold the memory; idle until killed.
  for (;;)
    pause(100);
  return 0;
}

#endif /* SERVICE_H */
