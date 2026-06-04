// init: The initial user-level program

#include "kernel/types.h"
#include "kernel/stat.h"
#include "kernel/spinlock.h"
#include "kernel/sleeplock.h"
#include "kernel/fs.h"
#include "kernel/file.h"
#include "user/user.h"
#include "kernel/fcntl.h"

char *argv[] = {"sh", 0};

// Kernel-status monitors launched automatically at boot (before the shell), so
// process/CPU/memory/PSI reporting and the OOM watcher are ALWAYS running and
// updating periodically — independent of any host injecting shell commands.
//   statd <period-ticks>  -> prints "@@STAT {json}" every <period> ticks
//   oomd                  -> watches PSI and drives OOM decisions
char *statd_argv[] = {"statd", "2", 0};   // ~5 Hz status updates
char *oomd_argv[]  = {"oomd", 0};

// fork+exec a program in the background (init does not wait for it; its main
// wait() loop reaps it if it ever exits). Inherits init's console fds 0/1/2.
static void
spawn_bg(char *path, char **av)
{
  int pid = fork();
  if (pid < 0) {
    printf("init: fork %s failed\n", path);
    return;
  }
  if (pid == 0) {
    exec(path, av);
    printf("init: exec %s failed\n", path);
    exit(1);
  }
}

int
main(void)
{
  int pid, wpid;

  if (open("console", O_RDWR) < 0) {
    mknod("console", CONSOLE, 0);
    open("console", O_RDWR);
  }
  dup(0); // stdout
  dup(0); // stderr

  // Bring the kernel monitors up once, at boot, before the first shell.
  spawn_bg("statd", statd_argv);
  spawn_bg("oomd", oomd_argv);

  for (;;) {
    printf("init: starting sh\n");
    pid = fork();
    if (pid < 0) {
      printf("init: fork failed\n");
      exit(1);
    }
    if (pid == 0) {
      exec("sh", argv);
      printf("init: exec sh failed\n");
      exit(1);
    }

    for (;;) {
      // this call to wait() returns if the shell exits,
      // or if a parentless process exits.
      wpid = wait((int *)0);
      if (wpid == pid) {
        // the shell exited; restart it.
        break;
      } else if (wpid < 0) {
        printf("init: wait returned an error\n");
        exit(1);
      } else {
        // it was a parentless process; do nothing.
      }
    }
  }
}
