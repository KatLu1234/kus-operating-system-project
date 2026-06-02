typedef unsigned int   uint;
typedef unsigned short ushort;
typedef unsigned char  uchar;

typedef unsigned char uint8;
typedef unsigned short uint16;
typedef unsigned int  uint32;
typedef unsigned long uint64;

typedef uint64 pde_t;

struct psi_data {
  uint64 some_avg10;
  uint64 full_avg10;
};

// System-wide kernel status snapshot (statd / kernel monitor).
struct sys_stat {
  uint64 uptime_ticks;
  uint64 free_pages;
  uint64 total_pages;
  int    ncpu;
  int    running;          // number of RUNNING procs
  int    runnable;         // number of RUNNABLE procs
  int    psi_some;         // some_avg10 as integer percent (0..100)
  int    psi_full;         // full_avg10 as integer percent (0..100)
};

// Per-process status snapshot (statd / kernel monitor).
struct proc_stat {
  int    pid;
  int    state;            // 1=USED 2=SLEEPING 3=RUNNABLE 4=RUNNING 5=ZOMBIE
  char   name[16];
  uint64 sz_kb;            // process memory size (KiB)
  uint64 cpu_ticks;        // accumulated CPU ticks
  uint64 stall_ticks;      // accumulated memory stall ticks
};

// One OOM-kill candidate exported to user space (oomd / LLM integration).
struct oom_cand {
  int    pid;
  char   name[16];
  uint64 sz_kb;            // process memory size (KiB)
};
