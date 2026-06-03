// psitest — quick check of the PSI (memory pressure) mechanism.
// Prints some/full averages, forks memory-hungry children, then watches the
// pressure rise. NOTE: this xv6 variant exposes the sleep syscall as pause().

#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"

void
print_psi(void)
{
  struct psi_data pd;
  if (get_mem_pressure(&pd) < 0) {
    fprintf(2, "psitest: get_mem_pressure failed\n");
    return;
  }
  printf("PSI: some_avg10=%d.%d%%, full_avg10=%d.%d%%\n",
         (int)((pd.some_avg10 * 100) / 1024), (int)(((pd.some_avg10 * 1000) / 1024) % 10),
         (int)((pd.full_avg10 * 100) / 1024), (int)(((pd.full_avg10 * 1000) / 1024) % 10));
}

int
main(int argc, char *argv[])
{
  printf("--- PSI Measurement Test ---\n");
  print_psi();

  printf("Generating memory pressure (forking children)...\n");

  int n = 5;
  for (int i = 0; i < n; i++) {
    int pid = fork();
    if (pid == 0) {
      while (1) {
        if (sbrk(4096) == (void *)-1)
          pause(1);
      }
      exit(0);
    }
  }

  for (int i = 0; i < 20; i++) {
    pause(10);
    print_psi();
  }

  printf("Test finished.\n");
  exit(0);
}
