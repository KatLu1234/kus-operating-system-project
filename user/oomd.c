// oomd — userspace OOM orchestrator for xv6.
//
//   watch PSI  ->  if pressured, collect candidates  ->  ask the host/LLM
//   ("@@OOM_REQ {json}")  ->  read the host's reply ("@@OOM_RESP {json}")  ->
//   validate  ->  kill(victim).
//
// The host relay (Electron main.js or coomd/host/relay.py) intercepts the
// @@OOM_REQ line, asks the LLM (Upstage Solar) which PID to kill, and injects
// an @@OOM_RESP line back into our stdin.
//
// See docs/xv6_llm_integration.md.

#include "kernel/types.h"
#include "kernel/param.h"
#include "user/user.h"

#define THRESHOLD   10      // some-pressure threshold in percent (0..100)
#define MAX_CAND    16
#define LINEMAX     2048

// PSI is fixed-point (value * 1024). Convert some_avg10 to an integer percent.
static int
psi_some_pct(struct psi_data *pd)
{
  return (int)(pd->some_avg10 * 100 / 1024);
}

// Pull the first integer found inside the "victims":[ ... ] array.
static int
parse_victim(char *line)
{
  char *v = strchr(line, '[');
  if(!v) return -1;
  v++;
  while(*v && (*v < '0' || *v > '9')) v++;
  if(*v < '0' || *v > '9') return -1;
  return atoi(v);
}

// Never kill init(1), the shell, or ourselves (defence-in-depth alongside the
// host policy). The shell's pid isn't fixed, so we also refuse "sh" by name
// when collecting candidates below.
static int
is_protected(int pid)
{
  return pid <= 1 || pid == getpid();
}

int
main(void)
{
  struct psi_data psi;
  struct oom_cand cand[MAX_CAND];
  char line[LINEMAX];

  printf("[oomd] started (threshold=%d%%)\n", THRESHOLD);

  for(;;){
    if(get_mem_pressure(&psi) < 0){
      sleep(50);
      continue;
    }

    if(psi_some_pct(&psi) > THRESHOLD){
      int n = get_oom_candidates(cand, MAX_CAND);

      // 1) emit the request line
      printf("@@OOM_REQ {\"psi\":%d,\"candidates\":[", psi_some_pct(&psi));
      for(int i = 0; i < n; i++)
        printf("%s{\"pid\":%d,\"name\":\"%s\",\"sz_kb\":%d}",
               i ? "," : "", cand[i].pid, cand[i].name, (int)cand[i].sz_kb);
      printf("]}\n");

      // 2) read lines until we see the @@OOM_RESP reply
      for(;;){
        int k = 0; char ch;
        while(k < LINEMAX-1 && read(0, &ch, 1) == 1 && ch != '\n')
          line[k++] = ch;
        line[k] = '\0';
        if(line[0] == '\0') continue;
        if(strncmp(line, "@@OOM_RESP", 10) == 0) break;
      }

      // 3) kill the chosen victim (if any, and if allowed)
      int victim = parse_victim(line);
      if(victim > 0 && !is_protected(victim)){
        printf("[oomd] killing pid %d\n", victim);
        kill(victim);
      }
    }

    sleep(50);   // ~5s between checks
  }
}
