# xv6 ↔ LLM 실제 연결 구현 가이드

> `docs/xv6_porting.md`가 "이런 구조가 될 것이다"라는 **설계 스케치**라면,
> 이 문서는 **실제로 동작하게 만드는 단계별 구현 가이드**다.
> 통신 채널은 **콘솔 UART + 태그 프로토콜** 방식을 사용한다.

---

## 0. 출발점 — 이미 구현되어 있는 것

팀의 xv6에는 `plan/psi_changed.md` 기준으로 **PSI 메커니즘이 이미 실제로
구현되어 있다**. 이 가이드는 그것을 재발명하지 않고 그 위에 LLM 연결만 얹는다.

이미 있는 것:

| 구성요소 | 위치 | 상태 |
|---------|------|------|
| 메모리 스톨 추적 (`mem_stall_ticks`) | `kernel/proc.h` | ✅ 구현됨 |
| `kalloc`/`kfree` sleep·wakeup | `kernel/kalloc.c` | ✅ 구현됨 |
| PSI 지수평균 (`update_psi`, `some_avg10`) | `kernel/proc.c`, `trap.c` | ✅ 구현됨 |
| `get_mem_pressure()` 시스템콜 | `kernel/sysproc.c` 등 | ✅ 구현됨 |
| `kill(pid)` 시스템콜 | xv6 기본 | ✅ 기존 제공 |

아직 없는 것 (이 가이드가 채우는 부분):

1. **후보 수집 인터페이스** — proc 테이블을 유저스페이스로 노출하는 시스템콜
2. **xv6 ↔ 호스트 통신 채널** — 콘솔 UART + 태그 프로토콜
3. **유저스페이스 오케스트레이터** — `user/oomd.c` (감시 → 요청 → 종료)
4. **호스트 릴레이 래퍼** — QEMU stdio ↔ 기존 `helper.py`(Solar API) 연결

---

## 1. 핵심 설계 결정 — 왜 "유저스페이스 + 콘솔 UART"인가

LLM 연결을 **커널이 아니라 xv6 유저 프로그램(`oomd`)에서** 오케스트레이션한다.
이유:

- xv6 유저 프로그램은 `printf`로 콘솔(=UART)에 쓰고 `read(0, ...)`로 콘솔에서
  읽을 수 있다. 즉 **별도 UART 드라이버를 새로 짜지 않아도** 통신 채널이 이미 있다.
- `kalloc.c`/`uart.c` 같은 민감한 커널 경로를 추가로 건드리지 않아 위험이 낮다.
- 커널 변경은 "후보 수집 시스템콜 1개"로 끝난다. 나머지는 전부 유저스페이스/호스트.

콘솔은 결국 UART(`0x10000000`)이고, QEMU는 `-nographic`으로 이 UART를 호스트
stdio에 연결한다(현재 `Makefile`의 `QEMUOPTS`가 그렇게 되어 있다). 따라서
**호스트에서 QEMU의 stdin/stdout을 가로채는 래퍼**를 두면 그게 곧 통신 채널이 된다.

### 태그 프로토콜

콘솔에는 부팅 로그·셸 출력 등 일반 트래픽이 섞인다. 그래서 데이터 라인에만
고유 접두사를 붙여 호스트 래퍼가 구분하게 한다.

```
xv6 → host :  @@OOM_REQ {"psi":16.5,"candidates":[{"pid":4,"name":"hog","sz_kb":40960}, ...]}
host → xv6 :  @@OOM_RESP {"victims":[4],"reasoning":"..."}
```

- `@@OOM_REQ`로 시작하는 줄 → 래퍼가 가로채 LLM에 전달, 콘솔에는 안 보여줌
- `@@OOM_RESP`로 시작하는 줄 → 래퍼가 xv6 stdin에 주입, `oomd`가 읽음
- 그 외 모든 줄 → 평소처럼 터미널에 통과

---

## 2. 전체 데이터 흐름

```
[xv6 유저공간: oomd]                       [호스트: relay.py]
  get_mem_pressure(&psi)                    (QEMU를 자식으로 감싸 stdio 중계)
   │ psi.some_avg10 > THRESHOLD ?
   ▼ yes
  get_oom_candidates(buf, MAX)   ← 신규 시스템콜 (proc 테이블 순회)
   │
  printf("@@OOM_REQ {json}\n")  ──► stdout에서 @@OOM_REQ 라인 감지
   │                                   └► helper.py 호출 (Upstage Solar API)
  read(0, line)  ◄── @@OOM_RESP 주입 ◄──── victim 결정 JSON
   │
  validate(victim)  (init/sh/oomd 보호)
   │
  kill(victim_pid)   ← xv6 기본 시스템콜
   ▼
  sleep(threshold 주기) 후 반복
```

설계의 OS 개념 매핑:

| 개념 | 위치 | 활용 |
|------|------|------|
| 물리 메모리 관리 / PSI | `kalloc.c`, `update_psi` | 압박 감지(이미 구현) |
| 프로세스 테이블 | `proc.c` `proc[NPROC]` | 후보 수집 소스 |
| 시스템콜 추가 | `syscall.c`/`sysproc.c` | 후보 수집 인터페이스 |
| 디바이스 드라이버 | `uart.c`(콘솔) | 호스트 통신 채널 |
| 프로세스 종료 | `proc.c` `kill()` | victim 종료 |
| IPC(파이프/리다이렉션) | 호스트 래퍼 | QEMU stdio 중계 |

---

## 3. 커널 측 구현 — 후보 수집 시스템콜 (단 하나)

`get_mem_pressure`를 추가했던 것과 **완전히 동일한 패턴**으로 진행한다.

### 3.1 공용 구조체 (`kernel/types.h`)

```c
// 유저공간으로 전달할 후보 1개의 메타데이터
struct oom_cand {
  int pid;
  char name[16];
  uint64 sz_kb;     // 프로세스 메모리 크기 (p->sz / 1024)
};
```

### 3.2 커널 구현 (`kernel/sysproc.c`)

```c
extern struct proc proc[];   // proc.c 의 전역 테이블

// argaddr 로 받은 유저 버퍼에 후보들을 채워 개수를 반환
uint64
sys_get_oom_candidates(void)
{
  uint64 uaddr;     // 유저 버퍼 주소
  int max;          // 최대 개수
  argaddr(0, &uaddr);
  argint(1, &max);

  struct oom_cand c;
  int n = 0;
  for(struct proc *p = proc; p < &proc[NPROC] && n < max; p++){
    acquire(&p->lock);
    if(p->state == UNUSED || p->state == ZOMBIE){
      release(&p->lock);
      continue;
    }
    c.pid    = p->pid;
    c.sz_kb  = p->sz / 1024;
    safestrcpy(c.name, p->name, sizeof(c.name));
    release(&p->lock);

    // 커널 → 유저 복사 (struct 한 칸씩)
    if(copyout(myproc()->pagetable,
               uaddr + n * sizeof(struct oom_cand),
               (char*)&c, sizeof(c)) < 0)
      return -1;
    n++;
  }
  return n;
}
```

> 주의: `p->lock`을 잡은 채로 `copyout`(페이지폴트 유발 가능)을 하면 안 된다.
> 위처럼 락 구간 안에서는 로컬 `c`에만 복사하고, 락을 푼 뒤 `copyout`한다.

### 3.3 등록 (PSI 때와 동일한 5곳)

- `kernel/syscall.h` — `#define SYS_get_oom_candidates 25` (다음 빈 번호)
- `kernel/syscall.c` — `extern uint64 sys_get_oom_candidates(void);` + `[SYS_get_oom_candidates] sys_get_oom_candidates,`
- `user/user.h` — `int get_oom_candidates(struct oom_cand*, int);` (그리고 `struct oom_cand;` 전방 선언 또는 types 포함)
- `user/usys.pl` — `entry("get_oom_candidates");`

`kill`은 xv6에 이미 있으므로 추가 작업 없음.

---

## 4. 유저스페이스 오케스트레이터 — `user/oomd.c`

```c
#include "kernel/types.h"
#include "kernel/param.h"
#include "user/user.h"

#define THRESHOLD   10      // some_avg10 임계치 (정수 %, 구현 스케일에 맞춰 조정)
#define MAX_CAND    16
#define LINEMAX     2048

// @@OOM_RESP 라인에서 첫 victim pid 하나만 뽑는 아주 단순한 파서
static int parse_victim(char *line){
  char *v = strchr(line, '[');
  if(!v) return -1;
  v++;
  while(*v && (*v < '0' || *v > '9')) v++;
  if(*v < '0' || *v > '9') return -1;
  return atoi(v);
}

// init(1), 셸, 자기 자신은 절대 죽이지 않는다 (커널 측 안전망과 별개의 유저 검증)
static int is_protected(int pid){
  return pid <= 1 || pid == getpid();
}

int main(void){
  struct psi_data psi;            // get_mem_pressure 가 채우는 구조체
  struct oom_cand cand[MAX_CAND];
  char line[LINEMAX];

  printf("[oomd] started (threshold=%d%%)\n", THRESHOLD);

  for(;;){
    get_mem_pressure(&psi);

    if(psi.some_avg10 > THRESHOLD){
      int n = get_oom_candidates(cand, MAX_CAND);

      // 1) 요청 송신: @@OOM_REQ {json}
      printf("@@OOM_REQ {\"psi\":%d,\"candidates\":[", psi.some_avg10);
      for(int i = 0; i < n; i++)
        printf("%s{\"pid\":%d,\"name\":\"%s\",\"sz_kb\":%d}",
               i ? "," : "", cand[i].pid, cand[i].name, (int)cand[i].sz_kb);
      printf("]}\n");

      // 2) 응답 수신: @@OOM_RESP 로 시작하는 줄을 만날 때까지 한 줄씩 read
      for(;;){
        int k = 0; char ch;
        while(k < LINEMAX-1 && read(0, &ch, 1) == 1 && ch != '\n')
          line[k++] = ch;
        line[k] = '\0';
        if(strcmp(line, "") == 0) continue;
        if(strncmp(line, "@@OOM_RESP", 10) == 0) break;
      }

      // 3) victim 종료
      int victim = parse_victim(line);
      if(victim > 0 && !is_protected(victim)){
        printf("[oomd] killing pid %d\n", victim);
        kill(victim);
      }
    }
    sleep(50);   // 약 5초 (틱 단위) 대기 후 반복
  }
}
```

`user/Makefile`(혹은 루트 `Makefile`의 `UPROGS`)에 `$U/_oomd\` 추가.

> `psi_data`/`get_mem_pressure`는 팀이 이미 만든 것이므로 그대로 사용한다.
> `some_avg10`이 고정소수점(scale 1024)이면 비교식만 거기에 맞춰 바꾼다.

---

## 5. 호스트 측 릴레이 — `coomd/host/relay.py`

QEMU를 자식 프로세스로 띄우고 stdout/stdin을 중계한다. `@@OOM_REQ`만
가로채 기존 `helper.py`(Solar API)로 보내고, 결과를 `@@OOM_RESP`로 주입한다.

```python
#!/usr/bin/env python3
import subprocess, sys, threading, json, os

# 기존 LLM_client/helper.py 의 victim 선택 로직을 재사용
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "LLM_client"))
from helper import decide_victims   # helper.py 에서 함수로 노출해두면 재사용 편함

POLICY = "I am running a build. Keep sh and init. Memory hogs are fine to kill."

# xv6 (= 프로젝트 루트의 make qemu) 를 자식으로 실행
qemu = subprocess.Popen(
    ["make", "qemu"], cwd="..",
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    bufsize=1, universal_newlines=True,
)

def pump():
    for line in qemu.stdout:
        s = line.rstrip("\n")
        if s.startswith("@@OOM_REQ"):
            req = json.loads(s[len("@@OOM_REQ"):].strip())
            victims = decide_victims(POLICY, req["candidates"])   # → Solar API
            resp = json.dumps({"victims": victims})
            qemu.stdin.write("@@OOM_RESP " + resp + "\n")
            qemu.stdin.flush()
        else:
            sys.stdout.write(line)      # 일반 콘솔 출력은 그대로 통과
            sys.stdout.flush()

threading.Thread(target=pump, daemon=True).start()

# 사용자 키보드 입력을 xv6 셸로 전달
for line in sys.stdin:
    qemu.stdin.write(line)
    qemu.stdin.flush()
```

> `helper.py`는 현재 stdin/stdout JSON 루프 형태인데, victim 선택 코어를
> `decide_victims(policy, candidates) -> [pid,...]` 함수로 빼두면 `relay.py`와
> 기존 파이프 모드 양쪽에서 재사용할 수 있다. (소폭 리팩터링)

---

## 6. 빌드 · 실행 · 검증

### 6.1 빌드

```bash
# 루트에서
make qemu            # 커널 + 유저프로그램(oomd 포함) 빌드 & QEMU 실행 (수동 확인용)
```

### 6.2 LLM 연결 실행

```bash
cd coomd/host
export UPSTAGE_API_KEY=...          # coomd/.env 에 두고 helper 가 읽어도 됨
python3 relay.py                    # QEMU를 감싸 실행
```

xv6 셸이 뜨면:

```
$ oomd &                            # 오케스트레이터를 백그라운드로
$ <메모리를 많이 쓰는 테스트 프로그램 실행>   # 압박 유발 (아래 6.3)
```

### 6.3 압박 유발용 테스트 프로그램 (`user/memhog.c`)

```c
#include "kernel/types.h"
#include "user/user.h"
int main(int argc, char *argv[]){
  int mb = argc > 1 ? atoi(argv[1]) : 32;
  for(int i = 0; i < mb; i++){
    char *p = sbrk(1024*1024);      // 1MB씩 증가
    for(int j = 0; j < 1024*1024; j += 4096) p[j] = 1;  // 실제 터치
  }
  printf("memhog: allocated %d MB, sleeping\n", mb);
  sleep(1000);
  return 0;
}
```

`memhog 100`처럼 큰 값을 주면 `some_avg10`이 임계치를 넘고, `oomd`가 후보를
모아 `@@OOM_REQ`를 내보낸다. `relay.py`가 Solar에 물어보고 `@@OOM_RESP`로
victim을 돌려주면 `oomd`가 `kill`한다.

### 6.4 검증 체크리스트

- [ ] **에코 먼저**: `oomd`가 `@@OOM_REQ`를 출력하고 `relay.py`가 더미
      `@@OOM_RESP {"victims":[<memhog pid>]}`를 (LLM 없이) 돌려줘서
      `kill`까지 가는 왕복을 먼저 확인한다. **이게 되면 연결은 끝난 것.**
- [ ] 그 다음 `relay.py`의 더미 응답을 `decide_victims`(실제 Solar 호출)로 교체
- [ ] init(pid 1)·sh·oomd 가 후보로 와도 절대 안 죽는지 확인 (유저 검증 + 정책)
- [ ] victim 종료 후 `get_mem_pressure`의 `some_avg10`이 실제로 내려가는지 확인

---

## 7. 단계적 진행 순서 (강력 추천)

복잡한 걸 한 번에 하지 말고 **왕복부터** 증명한다.

1. **에코 프로토타입**: `oomd`가 `@@PING` 출력 → `relay.py`가 `@@PONG` 주입 →
   `oomd`가 받아 출력. UART 왕복만 검증. (README의 "Week 13 보너스"가 이것)
2. `@@PING`을 실제 후보 JSON(`get_oom_candidates`)으로 교체.
3. `relay.py`의 응답을 더미 → `helper.py`(Solar) 로 교체.
4. `kalloc`/PSI(이미 구현) 트리거 + `kill`로 실제 종료까지 연결.

각 단계가 독립적으로 검증 가능하므로, 어디서 막혀도 원인이 명확하다.

---

## 8. 한계와 주의점

- **콘솔 공유**: `oomd`가 콘솔로 데이터를 주고받는 동안 일반 셸 출력과 섞인다.
  태그로 구분하지만, 데모 시에는 `oomd`를 전용으로 돌리는 게 깔끔하다.
- **단순 파서**: 예제의 JSON 파서는 데모용이다. 필드 순서·escape에 취약하므로
  실제로는 최소한의 토큰 단위 파싱으로 보강한다.
- **고정소수점**: `some_avg10`이 scale=1024 고정소수점이면 임계치 비교와 출력에서
  스케일을 일관되게 처리해야 한다.
- **락 안전성**: 후보 수집 시 `p->lock` 보유 중 `copyout` 금지(§3.2 주의 참고).
- **보안**: 평문 통신·임의 PID kill 신뢰는 학술 시연 한정. 실제 시스템엔 부적합.
- **대안 채널**: 콘솔 공유가 거슬리면 RISC-V semihosting(`-semihosting-config`)으로
  호스트 파일 교환을 쓸 수 있다. 커널 로직(후보수집·kill)은 동일하고 통신부만 바뀐다.

---

## 9. 변경 파일 요약

| 파일 | 변경 | 비고 |
|------|------|------|
| `kernel/types.h` | `struct oom_cand` 추가 | 신규 |
| `kernel/sysproc.c` | `sys_get_oom_candidates` 구현 | 신규 |
| `kernel/syscall.h` / `syscall.c` | 시스템콜 번호·테이블 등록 | PSI와 동일 패턴 |
| `user/user.h` / `user/usys.pl` | 유저 스텁 추가 | PSI와 동일 패턴 |
| `user/oomd.c` | 오케스트레이터 | 신규 |
| `user/memhog.c` | 압박 유발 테스트 | 신규(선택) |
| `user/Makefile`(or `UPROGS`) | `_oomd`, `_memhog` 등록 | |
| `coomd/host/relay.py` | QEMU stdio 릴레이 | 신규 |
| `coomd/LLM_client/helper.py` | `decide_victims()` 함수화 | 소폭 리팩터 |

커널 변경은 **시스템콜 1개**가 전부다. 나머지는 유저스페이스와 호스트 측이며,
PSI·kill·sleep/wakeup 등 핵심 메커니즘은 이미 구현된 것을 재사용한다.
