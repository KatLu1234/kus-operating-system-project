#include "kernel/types.h"
#include "kernel/stat.h"
#include "user/user.h"

void
print_psi()
{
  struct psi_data pd;
  if(get_mem_pressure(&pd) < 0) {
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
  for(int i = 0; i < n; i++) {
    int pid = fork();
    if(pid == 0) {
      while(1) {
        if(sbrk(4096) == (void*)-1) {
          // Busy loop if no sleep
          for(volatile int k = 0; k < 1000000; k++);
        }
      }
      exit(0);
    }
  }

  for(int i = 0; i < 20; i++) {
    // Busy loop as a substitute for sleep
    for(volatile int k = 0; k < 5000000; k++);
    print_psi();
  }

  printf("Test finished.\n");
  exit(0);
}
