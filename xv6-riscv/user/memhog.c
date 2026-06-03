// memhog — allocates and touches N MiB to create real memory pressure, then
// sleeps so it stays alive as an OOM candidate. Used to demo statd / oomd.
//
// See docs/xv6_llm_integration.md §6.3.
// NOTE: this xv6 variant exposes the sleep syscall as pause().

#include "kernel/types.h"
#include "user/user.h"

int
main(int argc, char *argv[])
{
  int mb = argc > 1 ? atoi(argv[1]) : 32;

  for (int i = 0; i < mb; i++) {
    char *p = sbrk(1024 * 1024);          // grow by 1 MiB
    if (p == (char *)-1) {
      printf("memhog: out of memory after %d MB\n", i);
      break;
    }
    for (int j = 0; j < 1024 * 1024; j += 4096)
      p[j] = 1;                           // touch each page so it's backed
  }

  printf("memhog: allocated %d MB, sleeping\n", mb);
  pause(1000);
  return 0;
}
