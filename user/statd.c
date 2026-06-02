// statd — periodically samples kernel status and prints it as a single
// tagged JSON line ("@@STAT {json}\n"). The host relay (Electron main.js or
// monitor.py) filters these lines off the console and renders a dashboard.
//
// See docs/xv6_kernel_monitor.md and docs/xv6_electron_monitor.md.

#include "kernel/types.h"
#include "user/user.h"

#define MAXP 64

int
main(int argc, char *argv[])
{
  int period = argc > 1 ? atoi(argv[1]) : 10;   // ticks between samples (~1s)
  struct sys_stat sys;
  struct proc_stat ps[MAXP];

  for(;;){
    if(get_sys_stat(&sys) < 0){
      printf("@@STAT_ERR sys\n");
      sleep(period);
      continue;
    }
    int n = get_proc_stats(ps, MAXP);

    // One snapshot = "@@STAT " prefix + a single-line JSON object + '\n'.
    printf("@@STAT {\"uptime\":%d,\"free_pg\":%d,\"total_pg\":%d,\"ncpu\":%d,"
           "\"running\":%d,\"runnable\":%d,\"psi_some\":%d,\"psi_full\":%d,\"procs\":[",
           (int)sys.uptime_ticks, (int)sys.free_pages, (int)sys.total_pages,
           sys.ncpu, sys.running, sys.runnable, sys.psi_some, sys.psi_full);
    for(int i = 0; i < n; i++)
      printf("%s{\"pid\":%d,\"st\":%d,\"name\":\"%s\",\"sz_kb\":%d,\"cpu\":%d,\"stall\":%d}",
             i ? "," : "", ps[i].pid, ps[i].state, ps[i].name,
             (int)ps[i].sz_kb, (int)ps[i].cpu_ticks, (int)ps[i].stall_ticks);
    printf("]}\n");

    sleep(period);
  }
}
