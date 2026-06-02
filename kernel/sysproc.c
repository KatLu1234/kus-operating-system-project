#include "types.h"
#include "riscv.h"
#include "defs.h"
#include "param.h"
#include "memlayout.h"
#include "spinlock.h"
#include "proc.h"
#include "vm.h"

uint64
sys_exit(void)
{
  int n;
  argint(0, &n);
  kexit(n);
  return 0;  // not reached
}

uint64
sys_getpid(void)
{
  return myproc()->pid;
}

uint64
sys_fork(void)
{
  return kfork();
}

uint64
sys_wait(void)
{
  uint64 p;
  argaddr(0, &p);
  return kwait(p);
}

uint64
sys_sbrk(void)
{
  uint64 addr;
  int t;
  int n;

  argint(0, &n);
  argint(1, &t);
  addr = myproc()->sz;

  if(t == SBRK_EAGER || n < 0) {
    if(growproc(n) < 0) {
      return -1;
    }
  } else {
    // Lazily allocate memory for this process: increase its memory
    // size but don't allocate memory. If the processes uses the
    // memory, vmfault() will allocate it.
    if(addr + n < addr)
      return -1;
    if(addr + n > TRAPFRAME)
      return -1;
    myproc()->sz += n;
  }
  return addr;
}

uint64
sys_pause(void)
{
  int n;
  uint ticks0;

  argint(0, &n);
  if(n < 0)
    n = 0;
  acquire(&tickslock);
  ticks0 = ticks;
  while(ticks - ticks0 < n){
    if(killed(myproc())){
      release(&tickslock);
      return -1;
    }
    sleep(&ticks, &tickslock);
  }
  release(&tickslock);
  return 0;
}

uint64
sys_kill(void)
{
  int pid;

  argint(0, &pid);
  return kkill(pid);
}

// return how many clock tick interrupts have occurred
// since start.
uint64
sys_uptime(void)
{
  uint xticks;

  acquire(&tickslock);
  xticks = ticks;
  release(&tickslock);
  return xticks;
}

uint64
sys_get_mem_pressure(void)
{
  uint64 addr;
  struct psi_data pd;

  argaddr(0, &addr);
  get_psi_stats(&pd);

  if(either_copyout(1, addr, &pd, sizeof(pd)) < 0)
    return -1;

  return 0;
}

extern struct proc proc[];          // process table (proc.c)
extern uint64 kfreepages(void);     // kalloc.c
extern uint64 ktotalpages(void);    // kalloc.c
extern int    ncpu_online;          // main.c — CPUs actually online

// System-wide kernel status: memory, runqueue and PSI.
// arg0: user pointer to a struct sys_stat. Returns 0 on success, -1 on error.
uint64
sys_get_sys_stat(void)
{
  uint64 uaddr;
  struct sys_stat st;
  struct psi_data pd;

  argaddr(0, &uaddr);
  memset(&st, 0, sizeof(st));

  st.free_pages  = kfreepages();
  st.total_pages = ktotalpages();
  st.ncpu        = ncpu_online ? ncpu_online : NCPU;

  acquire(&tickslock);
  st.uptime_ticks = ticks;
  release(&tickslock);

  for(struct proc *p = proc; p < &proc[NPROC]; p++){
    acquire(&p->lock);
    if(p->state == RUNNING)  st.running++;
    if(p->state == RUNNABLE) st.runnable++;
    release(&p->lock);
  }

  // PSI fixed-point (scale 1024) -> integer percent.
  get_psi_stats(&pd);
  st.psi_some = (int)(pd.some_avg10 * 100 / 1024);
  st.psi_full = (int)(pd.full_avg10 * 100 / 1024);

  if(either_copyout(1, uaddr, &st, sizeof(st)) < 0)
    return -1;
  return 0;
}

// Per-process snapshot. arg0: user array of struct proc_stat, arg1: max count.
// Returns the number of entries written.
uint64
sys_get_proc_stats(void)
{
  uint64 uaddr;
  int max;
  struct proc_stat s;
  int n = 0;

  argaddr(0, &uaddr);
  argint(1, &max);

  for(struct proc *p = proc; p < &proc[NPROC] && n < max; p++){
    acquire(&p->lock);
    if(p->state == UNUSED){ release(&p->lock); continue; }
    s.pid         = p->pid;
    s.state       = p->state;
    s.sz_kb       = p->sz / 1024;
    s.cpu_ticks   = p->cpu_ticks;
    s.stall_ticks = p->mem_stall_ticks;
    safestrcpy(s.name, p->name, sizeof(s.name));
    release(&p->lock);                 // unlock before copyout (may fault)

    if(either_copyout(1, uaddr + n * sizeof(s), &s, sizeof(s)) < 0)
      return -1;
    n++;
  }
  return n;
}

// OOM-kill candidates: live, killable processes (excludes UNUSED/ZOMBIE).
// arg0: user array of struct oom_cand, arg1: max count. Returns count written.
uint64
sys_get_oom_candidates(void)
{
  uint64 uaddr;
  int max;
  struct oom_cand c;
  int n = 0;

  argaddr(0, &uaddr);
  argint(1, &max);

  for(struct proc *p = proc; p < &proc[NPROC] && n < max; p++){
    acquire(&p->lock);
    if(p->state == UNUSED || p->state == ZOMBIE){
      release(&p->lock);
      continue;
    }
    c.pid   = p->pid;
    c.sz_kb = p->sz / 1024;
    safestrcpy(c.name, p->name, sizeof(c.name));
    release(&p->lock);                 // unlock before copyout (may fault)

    if(either_copyout(1, uaddr + n * sizeof(c), &c, sizeof(c)) < 0)
      return -1;
    n++;
  }
  return n;
}
