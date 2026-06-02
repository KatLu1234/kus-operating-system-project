# xv6 커널 상태 모니터 (statd) — 시연용 실시간 대시보드

> 시연 도중 유저가 **현재 커널 상태**(프로세스 리스트 · CPU 사용량 · 메모리
> 사용량)를 한눈에 보게 하되, 원시 데이터 메시지(`@@STAT ...`)는 콘솔에
> **노출하지 않는다.**
>
> 방식: **A(relay 필터) + statd 단독 실행** — 데이터는 태그로 흘려보내고
> relay가 콘솔에서 걸러낸 뒤, **정리된 뷰어**로 유저에게 보여준다.

관련 문서: `docs/xv6_llm_integration.md`(채널·relay 기본 구조)

---

## 1. 설계 개요

두 가지를 동시에 만족시킨다.

1. **숨김** — `statd`가 출력하는 `@@STAT` 원시 줄은 relay가 가로채 콘솔에
   안 보여준다(접근법 A). 유저의 raw 콘솔은 깨끗하게 유지된다.
2. **노출** — relay가 그 데이터를 파싱해 **별도의 정리된 화면**(top 비슷한
   대시보드)으로 렌더링한다. 유저는 이 깔끔한 뷰만 본다.

```
[xv6: statd]                  [QEMU]        [호스트: monitor.py]
주기적 수집(syscall)
 printf("@@STAT {json}\n") ──UART──► stdout ─┬─ @@STAT 줄 → 파싱 → 정리된 대시보드(유저가 봄)
                                             └─ 일반 줄  → 그대로 통과(콘솔)
```

핵심: 유저가 보는 것은 (a) 평소 콘솔 + (b) 정리된 대시보드뿐.
`@@STAT` 원문은 어디에도 안 뜬다.

> 인터리빙 방지를 위해 시연 중 `statd`는 **단독으로** 돌린다(인터랙티브 셸과
> 콘솔 출력을 동시에 쓰지 않음).

---

## 2. 유저에게 보여줄 커널 상태 정의

| 항목 | 내용 | 커널에서 얻는 법 |
|------|------|----------------|
| **프로세스 리스트** | PID, 이름, 상태, 메모리, CPU시간 | `proc[]` 순회 (신규 syscall) |
| **CPU 사용량** | 전체 CPU 사용률 %, per-proc CPU % | per-proc `cpu_ticks` 누적(신규) + 델타 |
| **메모리 사용량** | 사용/전체(MB), 사용률 % | free page 수 + 전체 page 수(신규 syscall) |
| **스케줄러 부하** | RUNNING/RUNNABLE 개수(런큐) | proc 상태 집계 |
| **메모리 압박(PSI)** | `some_avg10`, `full_avg10` | `get_mem_pressure()` (이미 구현) |
| **업타임** | 부팅 후 틱 | `uptime()` (기존) |

CPU 사용량과 메모리 사용량은 xv6에 기본 통계가 없으므로 **카운터를 추가**해서
만든다. 아래 §3에서 구현한다.

---

## 3. 커널 측 구현

### 3.1 per-process CPU 시간 누적 (`kernel/proc.h`, `kernel/trap.c`)

`struct proc`에 필드 추가 (`kernel/proc.h`):

```c
  uint64 cpu_ticks;      // 이 프로세스가 CPU에서 실행된 누적 틱
```

`allocproc()`에서 0으로 초기화. 그리고 타이머 인터럽트마다, 각 CPU에서 현재
실행 중인 프로세스의 카운터를 올린다 (`kernel/trap.c`의 `clockintr()` 또는
타이머 처리부):

```c
// clockintr() 안, 틱 증가 직후
struct proc *p = myproc();
if(p && p->state == RUNNING)
  p->cpu_ticks++;          // 이 CPU에서 돌던 프로세스에 1틱 적립
```

> 멀티코어(`CPUS>1`)면 각 CPU가 자기 `myproc()`에 적립하므로 자연히 코어별로
> 합산된다. `ticks` 전역 증가는 기존처럼 CPU 0만 담당하게 둔다.

전체 CPU 사용률은 "최근 구간에서 적립된 cpu_ticks 합 ÷ (경과 틱 × CPU 수)"로
**호스트 뷰어가 델타로 계산**한다(§6.2). 커널은 누적값만 제공하면 된다.

### 3.2 메모리 사용량 — free/total page (`kernel/kalloc.c`)

freelist 길이를 세는 함수를 추가한다(이미 PSI 작업에서 카운터가 있으면 그것을
재사용).

```c
// kalloc.c
uint64
kfreepages(void)
{
  struct run *r;
  uint64 n = 0;
  acquire(&kmem.lock);
  for(r = kmem.freelist; r; r = r->next) n++;
  release(&kmem.lock);
  return n;                 // free page 개수 (page = 4096B)
}
```

전체 page 수는 `(PHYSTOP - end) / PGSIZE`로 계산 가능. 간단히 부팅 직후
`kfreepages()` 값을 전체로 캐싱해두고 사용해도 된다.

### 3.3 시스템 통계 구조체 (`kernel/types.h`)

```c
struct sys_stat {
  uint64 uptime_ticks;
  uint64 free_pages;
  uint64 total_pages;
  int    ncpu;
  int    running;          // RUNNING 개수
  int    runnable;         // RUNNABLE 개수
  int    psi_some;         // some_avg10 (정수 % 로 환산해 담기)
  int    psi_full;         // full_avg10
};

struct proc_stat {
  int    pid;
  int    state;            // 1=USED 2=SLEEPING 3=RUNNABLE 4=RUNNING 5=ZOMBIE
  char   name[16];
  uint64 sz_kb;            // 메모리 크기
  uint64 cpu_ticks;        // 누적 CPU 틱
  uint64 stall_ticks;      // mem_stall_ticks
};
```

### 3.4 시스템콜 두 개 (`kernel/sysproc.c`)

`get_mem_pressure`를 추가했던 것과 **동일한 패턴**.

```c
extern struct proc proc[];
extern int some_avg10, full_avg10;   // proc.c 의 PSI 통계 (스케일 주의)
extern uint64 kfreepages(void);

// (1) 시스템 전역 통계
uint64
sys_get_sys_stat(void)
{
  uint64 uaddr; argaddr(0, &uaddr);
  struct sys_stat st;
  memset(&st, 0, sizeof(st));

  st.free_pages  = kfreepages();
  st.total_pages = (PHYSTOP - PGROUNDUP((uint64)end)) / PGSIZE;
  st.ncpu        = NCPU;
  st.uptime_ticks = ticks;            // ticks 접근 시 tickslock 보호 권장

  for(struct proc *p = proc; p < &proc[NPROC]; p++){
    acquire(&p->lock);
    if(p->state == RUNNING)  st.running++;
    if(p->state == RUNNABLE) st.runnable++;
    release(&p->lock);
  }
  acquire(&psi_lock);                  // PSI 통계 락 (팀 구현 기준)
  st.psi_some = some_avg10 / 1024 * 100; // 고정소수점 → % (스케일에 맞게 조정)
  st.psi_full = full_avg10 / 1024 * 100;
  release(&psi_lock);

  if(copyout(myproc()->pagetable, uaddr, (char*)&st, sizeof(st)) < 0)
    return -1;
  return 0;
}

// (2) 프로세스 스냅샷 (개수 반환)
uint64
sys_get_proc_stats(void)
{
  uint64 uaddr; int max;
  argaddr(0, &uaddr); argint(1, &max);

  struct proc_stat s; int n = 0;
  for(struct proc *p = proc; p < &proc[NPROC] && n < max; p++){
    acquire(&p->lock);
    if(p->state == UNUSED){ release(&p->lock); continue; }
    s.pid = p->pid; s.state = p->state;
    s.sz_kb = p->sz / 1024;
    s.cpu_ticks = p->cpu_ticks;
    s.stall_ticks = p->mem_stall_ticks;
    safestrcpy(s.name, p->name, sizeof(s.name));
    release(&p->lock);                 // 락 푼 뒤 copyout (중요)
    if(copyout(myproc()->pagetable,
               uaddr + n*sizeof(s), (char*)&s, sizeof(s)) < 0)
      return -1;
    n++;
  }
  return n;
}
```

### 3.5 등록 (PSI 때와 동일한 5곳)

- `kernel/syscall.h` — `SYS_get_sys_stat`, `SYS_get_proc_stats` 번호 추가
- `kernel/syscall.c` — `extern` 선언 + `syscalls[]` 테이블 등록
- `user/user.h` — `int get_sys_stat(struct sys_stat*); int get_proc_stats(struct proc_stat*, int);`
- `user/usys.pl` — `entry("get_sys_stat");`, `entry("get_proc_stats");`

> `psi_lock` / `some_avg10` 등의 정확한 이름·스케일은 팀의 `plan/psi_changed.md`
> 구현에 맞춰 조정한다. (고정소수점 scale=1024 가정)

---

## 4. `user/statd.c` — 주기적 수집·출력

```c
#include "kernel/types.h"
#include "user/user.h"

#define MAXP 64

int main(int argc, char *argv[]){
  int period = argc > 1 ? atoi(argv[1]) : 10;   // 틱 단위 (대략 1초 권장)
  struct sys_stat sys;
  struct proc_stat ps[MAXP];

  for(;;){
    if(get_sys_stat(&sys) < 0){ printf("@@STAT_ERR sys\n"); sleep(period); continue; }
    int n = get_proc_stats(ps, MAXP);

    // 한 줄 JSON 으로 출력 (반드시 한 줄, \n 으로 종료)
    printf("@@STAT {\"uptime\":%d,\"free_pg\":%d,\"total_pg\":%d,\"ncpu\":%d,"
           "\"running\":%d,\"runnable\":%d,\"psi_some\":%d,\"psi_full\":%d,\"procs\":[",
           (int)sys.uptime_ticks, (int)sys.free_pages, (int)sys.total_pages,
           sys.ncpu, sys.running, sys.runnable, sys.psi_some, sys.psi_full);
    for(int i=0;i<n;i++)
      printf("%s{\"pid\":%d,\"st\":%d,\"name\":\"%s\",\"sz_kb\":%d,\"cpu\":%d,\"stall\":%d}",
             i?",":"", ps[i].pid, ps[i].state, ps[i].name,
             (int)ps[i].sz_kb, (int)ps[i].cpu_ticks, (int)ps[i].stall_ticks);
    printf("]}\n");

    sleep(period);
  }
}
```

루트 `Makefile`의 `UPROGS`에 `$U/_statd\` 추가.

---

## 5. 출력 포맷 (`@@STAT` 스펙)

- 한 스냅샷 = `@@STAT ` 접두사 + **JSON 한 줄** + `\n`
- 줄 안에 개행 금지(줄 단위 파싱이 깨짐). 접두사로 일반 콘솔 트래픽과 구분.
- 상태 코드: `1=USED 2=SLEEPING 3=RUNNABLE 4=RUNNING 5=ZOMBIE`

예:
```
@@STAT {"uptime":512,"free_pg":28160,"total_pg":32480,"ncpu":3,"running":1,"runnable":2,"psi_some":18,"psi_full":3,"procs":[{"pid":1,"st":2,"name":"init","sz_kb":12,"cpu":4,"stall":0},{"pid":3,"st":4,"name":"memhog","sz_kb":81920,"cpu":210,"stall":47}]}
```

---

## 6. 호스트 측 — 숨김(A) + 정리된 뷰어

`coomd/host/monitor.py` 하나가 (1) `@@STAT`를 콘솔에서 걸러내고(A),
(2) 파싱해 깔끔한 대시보드로 보여준다.

### 6.1 코드

```python
#!/usr/bin/env python3
import subprocess, sys, threading, json, os

STATE = {1:"USED",2:"SLEEP",3:"READY",4:"RUN",5:"ZOMBIE"}
PGKB = 4                       # page = 4KB

qemu = subprocess.Popen(
    ["make", "qemu"], cwd="../..",
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    bufsize=1, universal_newlines=True,
)

prev = {}   # pid -> (cpu_ticks) 직전 표본 (CPU% 델타용)
prev_uptime = [0]

def render(o):
    os.system("clear")
    up = o["uptime"]; d_up = max(1, up - prev_uptime[0])
    used_pg = o["total_pg"] - o["free_pg"]
    mem_pct = 100.0 * used_pg / o["total_pg"]
    print("="*64)
    print(f" xv6 KERNEL STATUS    uptime={up} ticks    cpus={o['ncpu']}")
    print("="*64)
    print(f" MEM  : {used_pg*PGKB//1024} / {o['total_pg']*PGKB//1024} MB "
          f"({mem_pct:4.1f}%)   free={o['free_pg']*PGKB//1024}MB")
    print(f" SCHED: running={o['running']}  ready={o['runnable']}  "
          f"(runqueue load)")
    print(f" PSI  : some={o['psi_some']}%  full={o['psi_full']}%")
    print("-"*64)
    print(f" {'PID':>4} {'NAME':<12} {'STATE':<7} {'MEM(KB)':>9} {'CPU%':>6}")
    print("-"*64)
    # CPU% = (이번 cpu_ticks - 직전) / (경과 틱 * ncpu)
    for p in sorted(o["procs"], key=lambda x: -x["cpu"]):
        d_cpu = p["cpu"] - prev.get(p["pid"], p["cpu"])
        cpu_pct = 100.0 * d_cpu / (d_up * o["ncpu"])
        print(f" {p['pid']:>4} {p['name']:<12} {STATE.get(p['st'],'?'):<7} "
              f"{p['sz_kb']:>9} {cpu_pct:>5.1f}")
    # 표본 갱신
    prev.clear(); prev.update({p["pid"]: p["cpu"] for p in o["procs"]})
    prev_uptime[0] = up

def pump():
    for line in qemu.stdout:
        s = line.rstrip("\n")
        if s.startswith("@@STAT"):              # ← 콘솔엔 안 보냄 (숨김)
            try: render(json.loads(s[len("@@STAT"):].strip()))
            except json.JSONDecodeError: pass
        elif s.startswith("@@"):                # 다른 태그도 숨김
            pass
        else:
            sys.stdout.write(line); sys.stdout.flush()   # 일반 콘솔만 통과

threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    qemu.stdin.write(line); qemu.stdin.flush()
```

### 6.2 CPU 사용량 계산

커널은 **누적 `cpu_ticks`**만 준다. 뷰어가 두 표본의 차이로 비율을 만든다:

```
CPU%(proc) = (cpu_ticks_now - cpu_ticks_prev) / ((uptime_now - uptime_prev) * ncpu) * 100
```

전체 CPU 사용률이 필요하면 모든 proc의 `Δcpu_ticks` 합을 같은 분모로 나누면 된다.

---

## 7. 빌드 · 실행 · 시연 절차

```bash
# 1) 빌드 확인 (statd 포함)
make qemu        # 수동 확인용 — 끝나면 ctrl-a x 로 종료

# 2) 시연: 모니터 래퍼로 실행
cd coomd/host
python3 monitor.py
```

xv6 셸이 뜨면(별도 콘솔 영역), 시연 흐름:

```
$ statd &          # 상태 수집 시작 (백그라운드) — 화면엔 @@STAT 안 보임
$ memhog 100       # 메모리 압박 유발 (user/memhog.c, 다른 문서 참조)
```

- 유저 화면에는 **정리된 대시보드**가 ~1초마다 갱신되며 프로세스 리스트,
  CPU%, 메모리 사용률, PSI, 런큐가 보인다.
- `@@STAT` 원시 줄은 **절대 노출되지 않는다**(monitor.py가 걸러냄).
- `memhog` 실행 시 메모리 사용률↑, PSI some↑, 해당 프로세스 CPU%·MEM↑가
  실시간으로 보여 시연 효과가 크다.

> 인터리빙을 피하려면 시연 중 콘솔에 다른 출력이 섞이지 않게 `statd`를 단독
> 운용한다(`statd &` 후 불필요한 명령 자제). 완전 분리가 필요하면
> `docs/xv6_llm_integration.md` §8의 semihosting 대안을 쓴다.

---

## 8. 변경 파일 요약

| 파일 | 변경 | 비고 |
|------|------|------|
| `kernel/proc.h` | `cpu_ticks` 필드 추가 | 신규 |
| `kernel/proc.c` | `allocproc`에서 0 초기화 | |
| `kernel/trap.c` | `clockintr`에서 RUNNING proc에 틱 적립 | |
| `kernel/kalloc.c` | `kfreepages()` 추가 | free page 카운트 |
| `kernel/types.h` | `sys_stat`, `proc_stat` 구조체 | 신규 |
| `kernel/sysproc.c` | `sys_get_sys_stat`, `sys_get_proc_stats` | 신규 |
| `kernel/syscall.h`/`syscall.c` | 시스템콜 등록 | PSI와 동일 패턴 |
| `user/user.h`/`usys.pl` | 유저 스텁 | PSI와 동일 패턴 |
| `user/statd.c` | 수집·출력 데몬 | 신규 |
| `Makefile` (`UPROGS`) | `_statd` 등록 | |
| `coomd/host/monitor.py` | 숨김 필터 + 대시보드 | 신규 |

커널 추가는 시스템콜 2개 + 틱 적립 한 줄 + free page 카운터가 전부이고,
나머지는 유저/호스트 측이다. PSI·kill·sleep/wakeup 등 핵심 메커니즘은 이미
구현된 것을 재사용한다.

---

## 9. 주의점

- **버퍼링**: `statd`는 줄 단위 `printf`, monitor.py는 `bufsize=1`이어야 실시간.
- **고정소수점**: `some_avg10`이 scale=1024면 % 환산을 일관되게(커널 또는 뷰어
  한쪽에서만) 처리한다.
- **락 안전성**: proc 스냅샷 시 `p->lock` 보유 중 `copyout` 금지(§3.4 주석).
  `ticks`/PSI 통계는 각자의 락으로 보호.
- **인터리빙**: 한 콘솔 공유의 원리적 한계. 시연 중 `statd` 단독 운용으로 회피,
  완벽한 분리는 semihosting/2nd UART.
- **CPU% 첫 표본**: 직전 표본이 없는 첫 줄은 0%로 표시(델타 불가). 정상.
