# OOM 킬러 동작 실패(메모리 데드락) 진단 및 해결

> 작성일: 2026-06-04
> 대상: xv6-riscv 커널 + `oomd`(유저스페이스) + Electron 인터페이스 + `coomd`

## 1. 증상

서비스를 충분히 띄워 메모리를 초과 요청하면, **OOM 킬러가 victim을 죽이기 전에
xv6가 "터진 것처럼" 멈춰버린다.** 대시보드는 갱신을 멈추고, 셸은 명령에 반응하지
않는다. 사용자 표현: *"oom killer 가 작동하기 전에 xv6가 터져서 그런지 oom killer
가 작동되지 않음."*

## 2. 진단 결론 (요약)

**xv6는 실제로 패닉(커널 크래시)하지 않는다.** 전 구간에서 `panic`/트랩 메시지가
0건이고, PSI는 59%까지 매끄럽게 오르며 `@@STAT`도 계속 나온다. "터진 것처럼 보이는"
것의 정체는 **메모리 데드락(완전 동결)** 이며, 원인은 3겹이다.

| # | 원인 | 성격 |
|---|------|------|
| 1 | 메모리 고갈 시 `kalloc`이 무한 대기 → 전체 할당 데드락 | 근본 |
| 2 | OOM 제어 메시지(`@@OOM_REQ`)가 공유 콘솔에서 깨짐 | 직접 |
| 3 | OOM 응답(`@@OOM_RESP`)을 셸이 가로챔 | 보조 |
| — | **커널 차원의 OOM 안전망 부재** | 구조적 |

## 3. 상세 진단

### 3.1 메모리 고갈 시 커널이 데드락에 빠진다 (근본)

이 변형 xv6의 PSI 메커니즘은 `kalloc`에서 free 페이지가 없으면 호출 프로세스를
**재운다**(`sleep(&kmem)`):

```c
// kernel/kalloc.c  (kalloc 내부)
if (!r && p) {
  ...
  while (!r) {
    sleep(&kmem, &kmem.lock);   // kfree 가 깨워줄 때까지 대기
    r = kmem.freelist;
    if (p->killed) { release(&kmem.lock); return 0; }
  }
  ...
}
```

free가 0이 되면:

- 메모리를 풀어줄 수 있는 건 **OOM 킬러가 victim을 죽이는 것**뿐인데,
- 새 할당을 시도하는 **모든** 프로세스(셸의 `fork`, 새 명령 실행, 페이지 터치)가
  전부 `kalloc`에서 잠들어 버린다.

**증거** — 메모리 고갈 직후의 `@@STAT` 스냅샷:

```json
{"pid":13,"st":1,"name":"","sz_kb":0,"cpu":0,"stall":0}   // security: fork/exec 중 정지
{"pid":4,"st":2,"name":"sh","sz_kb":20,"cpu":0,"stall":0} // sh: 자식 페이지 할당 중 SLEEPING
```

`pid 13`은 `st:1`(USED)에 이름조차 못 얻은 상태로 영구 정지 — fork/exec 도중
`kalloc`에서 잠들었다. 부모인 `sh`(pid 4)도 `fork`의 `uvmcopy`(자식 페이지 복사)
중 `&kmem`에서 잠들어, 이후 `ls` 같은 명령이 실행조차 안 된다 → "죽은 것처럼" 보임.

### 3.2 OOM 제어 메시지가 콘솔에서 산산조각 난다 (직접 원인)

`oomd`는 압박을 감지해 `@@OOM_REQ`를 **분명히 내보낸다.** 그러나 `statd`(~5Hz)와
`oomd`가 **같은 UART 콘솔에 동시 출력**해서 글자 단위로 섞인다:

```
실제 캡처:  @@STAT {"@u@OpOtMi_REmQe {"":102,...
            └── "@@STAT {" + "@@OOM_REQ {" 가 글자별로 인터리브
```

`printf`는 호출당 락(`pr.lock`)을 잡지만, `statd`는 한 줄을 **여러 번의 printf**
(헤더 + 프로세스마다 + 꼬리)로 찍기 때문에 그 사이로 `oomd`의 출력이 끼어든다.

**결과**: 호스트(인터페이스/relay)가 깨진 `@@OOM_REQ`를 JSON 파싱하지 못함 →
`@@OOM_RESP`를 안 줌 → kill이 일어나지 않음.

측정값(헤드리스 재현): `@@STAT` 39줄 중 6줄 손상, 일회성 `@@OOM_REQ`는 손상 시 치명적.

### 3.3 응답이 와도 oomd 대신 셸이 가로챌 수 있다 (보조)

`oomd`는 `@@OOM_RESP`를 콘솔 **stdin**에서 읽는데, `sh`도 같은 stdin을 읽는다.
깨끗한 `@@OOM_RESP`를 주입한 테스트에서도 free_pg가 0 → 1709로 **부분만 회복**하고
다시 멈췄다 — 응답 일부를 셸이 소비한 것으로 보인다.

### 3.4 종합

> OOM 킬러가 **유저스페이스 + 호스트 왕복**(oomd → 호스트 → LLM(수 초) → oomd)에
> 의존하는데, 그 제어선이 (a) 공유 콘솔에서 깨지고, (b) 셸과 stdin을 다투며,
> (c) LLM 지연이 큰 사이, 메모리는 이미 0이라 커널이 데드락에 빠진다. **커널 차원의
> 안전망이 없어** 왕복이 한 번이라도 실패하면 영구 동결된다.

## 4. 해결: 커널 차원 OOM 안전망 (last-resort)

호스트/LLM/콘솔 상태와 무관하게 **시스템이 절대 동결되지 않도록** 커널에 최후수단
OOM 킬러를 추가했다. LLM 기반 `oomd`는 "똑똑한 선택"을 계속 담당하고, 커널은
그것이 제때 동작하지 못할 때만 개입하는 **2층 구조**다.

### 4.1 동작 원리

```
메모리 고갈(free=0) + 프로세스 stall 발생
        │
        ▼  (유예 ~3초: LLM/호스트 OOM 경로에 먼저 기회를 줌)
  3초 안에 oomd/호스트가 victim을 죽여 메모리를 풀었나?
        │ 예 → 카운터 리셋, 커널 개입 안 함 (LLM이 처리)
        │ 아니오
        ▼
  커널이 가장 큰 유저 프로세스를 kill (init/sh/statd/oomd 보호)
        │
        ▼
  victim 종료 → 메모리 회수 → 잠든 할당자들이 깨어남 → 동결 해소
```

### 4.2 변경 파일

| 파일 | 변경 |
|------|------|
| `kernel/kalloc.c` | `kmemexhausted()` 추가 — freelist 비었는지 O(1) 확인 (매 틱 호출용) |
| `kernel/proc.c` | `oom_kill()` 추가 + `update_psi()`에 유예 카운터 로직 |
| `kernel/defs.h` | `kmemexhausted`, `oom_kill` 선언 |
| `xv6-interface/main.js` | `[kernel-oom]` 콘솔 줄 파싱 → 대시보드 카드 빨강 처리 |

### 4.3 핵심 코드

**고갈 여부 O(1) 확인** (`kernel/kalloc.c`):

```c
int
kmemexhausted(void)
{
  int empty;
  acquire(&kmem.lock);
  empty = (kmem.freelist == 0);
  release(&kmem.lock);
  return empty;
}
```

**최후수단 킬러** (`kernel/proc.c`) — 가장 큰 유저 프로세스를 죽이고, 깨워서 종료:

```c
#define OOM_GRACE_TICKS 30   // ~3초 (10틱≈1초). LLM/호스트에 먼저 기회를 줌.

static int
oom_protected(struct proc *p)
{
  if (p->pid <= 1)                        return 1;  // init
  if (strncmp(p->name, "sh",    16) == 0) return 1;  // 셸
  if (strncmp(p->name, "statd", 16) == 0) return 1;  // 상태 보고
  if (strncmp(p->name, "oomd",  16) == 0) return 1;  // 유저 OOM 오케스트레이터
  return 0;
}

int
oom_kill(void)
{
  struct proc *victim = 0;
  uint64 best = 0;
  for (struct proc *p = proc; p < &proc[NPROC]; p++) {
    acquire(&p->lock);
    if ((p->state == RUNNING || p->state == RUNNABLE || p->state == SLEEPING) &&
        !p->killed && !oom_protected(p) && p->sz > best) {
      best = p->sz; victim = p;
    }
    release(&p->lock);
  }
  if (!victim) return 0;

  int vpid = 0; char vname[16];
  acquire(&victim->lock);
  if (victim->state != UNUSED && victim->state != ZOMBIE &&
      !victim->killed && !oom_protected(victim)) {
    victim->killed = 1;
    if (victim->state == SLEEPING) victim->state = RUNNABLE; // 깨워서 종료시킴
    vpid = victim->pid;
    safestrcpy(vname, victim->name, sizeof(vname));
  }
  release(&victim->lock);

  if (vpid) {
    wakeup(&kmem);   // 다른 잠든 할당자들도 깨움
    printf("[kernel-oom] out of memory: killed pid %d (%s, %d KB)\n",
           vpid, vname, (int)(best / 1024));
  }
  return vpid;
}
```

**유예 로직** (`update_psi()` 끝, 매 틱 cpu0에서 실행):

```c
// stall 발생 + free=0 이 유예시간 내내 지속되면 커널이 개입.
// 그 전에 압박이 풀리면(=LLM oomd가 처리) 카운터 리셋 → 커널 무개입.
static int oom_grace = 0;
if (stalled > 0 && kmemexhausted()) {
  if (++oom_grace >= OOM_GRACE_TICKS) { oom_grace = 0; oom_kill(); }
} else {
  oom_grace = 0;
}
```

> 안전성 메모: `oom_kill()`은 스핀락만 사용하고(sleep 없음) 호출 시점에 어떤 락도
> 잡고 있지 않으므로 타이머 인터럽트 컨텍스트(`clockintr → update_psi`)에서 호출해도
> 안전하다. `kmemexhausted()`는 freelist 길이를 순회하지 않아 매 틱 호출에 적합하다.

### 4.4 대시보드 연동 (`xv6-interface/main.js`)

커널 kill도 UI에 보이도록 콘솔 줄을 파싱해 victim 카드를 빨강 처리한다:

```js
// [kernel-oom] out of memory: killed pid 6 (database, 40976 KB)
m = line.match(/\[kernel-oom\].*killed pid (\d+) \(([^,]+),/);
if (m) {
  send('oom:event', { kind: 'decision', source: 'kernel-oom', engine: 'kernel',
                      victims: [Number(m[1])],
                      reasoning: `kernel last-resort OOM kill of ${m[2]} (largest process)`,
                      timestamp: Date.now() });
}
```

## 5. 검증 (헤드리스 QEMU, 릴레이/LLM 없이 메모리 고갈)

서비스 4개(각 40MB ≈ 160MB > 127MB 천장)를 띄워 메모리를 고갈시킨 뒤 관찰:

| 항목 | 수정 전 | 수정 후 |
|------|---------|---------|
| 커널 OOM 발동 | 없음 | ✅ `killed pid 6 (database, 40976 KB)` (최대) |
| 셸 생존(동결) | 동결됨 | ✅ `echo SHELL_ALIVE` 정상 출력 |
| 메모리 회복 | 0에서 멈춤 | ✅ free_pg 0 → **32521** (완전 회복) |
| 커널 패닉 | 없음(동결) | 0건 |

## 6. 튜닝 포인트 & 남은 한계

- **유예 시간**: `kernel/proc.c`의 `OOM_GRACE_TICKS`(현재 30 ≈ 3초). LLM에 더
  여유를 주려면 늘리고, 더 빨리 구조하려면 줄인다.
- **정책 우선순위**: 커널 안전망은 **policy를 모른다** — 항상 "가장 큰" 프로세스를
  죽인다. 이는 LLM 경로가 제때 응답하지 못했을 때만 발동하므로, 그 순간엔
  "liveness > policy"가 맞다. 정책 기반 선택은 LLM `oomd`의 몫.
- **남은 한계(미해결)**: §3.2 콘솔 출력 인터리브로 인한 `@@OOM_REQ` 손상은 이번
  변경에서 직접 고치지 않았다. 커널 안전망이 동결을 막으므로 데모는 안전하지만,
  LLM 경로의 신뢰성까지 높이려면 별도의 "메시지 무결성 수정"(태그 줄을 단일
  write로 원자 출력 / OOM 요청 동안 statd 일시정지 / `@@OOM_RESP` 전용 입력 경로
  분리)이 필요하다.

## 7. 관련 선행 수정 (같은 디버깅 흐름)

이 데드락에 도달하기까지 같은 세션에서 함께 해결한 항목:

- **서비스 10종이 `fs.img`에 누락** — `xv6-riscv/Makefile`의 `UPROGS`에 services +
  `oomgen` 추가(누락 시 `exec database failed` → 부하 생성 자체 불가).
- **서비스 메모리 가중치 재조정** — `renderer.js`/`service.h`에서 "~5개 띄우면 압박"
  이 되도록 평균 ~32MB로 조정.
- **statd/oomd 자동 실행을 init으로 이관** — `user/init.c`가 부팅 시 직접 실행하여
  호스트 stdin 주입 의존성과 청크 경계 누락 버그 제거.
