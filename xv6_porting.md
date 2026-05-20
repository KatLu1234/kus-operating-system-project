# Porting to xv6-riscv: Design Sketch

다음 섹션은 동일한 메커니즘을 **수업에서 사용한 xv6-riscv 커널**로 포팅한다면 어떤 구조가
될지에 대한 디자인 스케치를 제시한다. 실제 포팅 구현은 본 프로젝트의
범위를 벗어나지만, 시스템의 일반화 가능성을 검증하기 위한 사고 실험으로
가치가 있다.

## 1. 포팅이 필요한 이유와 한계

xv6-riscv는 네트워크 스택과 TLS 라이브러리를 포함하지 않으므로, **xv6
내부에서 직접 Solar API를 호출하는 것은 불가능**하다. 따라서 포팅 디자인은
다음 두 부분으로 나뉜다.

- **xv6 커널 측**: 메모리 압박 감지, 후보 수집, victim 시그널 전송
- **호스트 측 (QEMU 외부)**: LLM API 호출을 담당하는 Python 헬퍼
- **두 측의 통신**: QEMU 가상 시리얼 포트(`uart.c`)를 채널로 활용

이는 리눅스 구현의 "C 데몬 ↔ Python 헬퍼" 분리 구조를 그대로 이어받는다.

## 2. 메모리 압박 감지 — `kalloc.c` 훅

xv6에는 PSI에 해당하는 기능이 없으므로, **`kalloc()` 호출 시점**에서
직접 free page 수를 검사하는 방식으로 대체한다.

`kernel/kalloc.c`에 다음 로직을 추가한다.

```c
// kalloc.c에 추가
static int free_pages_count = 0;     // 현재 free 페이지 수
static int oom_threshold = 64;       // 임계치 (페이지 단위)
extern void notify_oom_pressure(void); // 새 함수

void *
kalloc(void)
{
  // ... 기존 할당 로직 ...

  if (free_pages_count < oom_threshold) {
    notify_oom_pressure();  // 호스트 헬퍼에 알림
  }
  return ptr;
}
```

`free_pages_count`는 freelist 길이를 카운트하여 유지한다.

## 3. 새 시스템콜 — 사용자 공간 헬퍼와의 연결

xv6의 시스템콜 추가 패턴(수업에서 다룬 그대로)을 활용하여 두 개의
시스템콜을 추가한다.

| 시스템콜 | 역할 |
|---------|------|
| `sys_get_oom_candidates(buf, max)` | proc 테이블 순회 후 후보 메타데이터 반환 |
| `sys_kill_victim(pid)` | 검증된 PID에 시그널 전송 (`proc.c`의 `kill()` 활용) |

추가 위치는 수업에서 다룬 패턴 그대로:

- `kernel/syscall.h` — `SYS_get_oom_candidates`, `SYS_kill_victim` 번호 등록
- `kernel/syscall.c` — `syscalls[]` 배열에 함수 포인터 추가
- `kernel/sysproc.c` — 실제 구현 (`sys_get_oom_candidates`, `sys_kill_victim`)
- `user/user.h` — 유저 공간 프로토타입 선언
- `user/usys.pl` — 유저-커널 trap 진입점

## 4. 호스트와의 통신 — UART 채널

QEMU는 xv6의 가상 시리얼 포트를 호스트의 stdio로 연결할 수 있다. 이를
이용해 다음과 같은 통신 구조를 만든다.
[xv6 kernel]                                [Host (QEMU 외부)]
│                                            │
│  candidates JSON via UART  ───────►       │
│  (kernel/uart.c의 uartputc 사용)           │
│                                       Python LLM Helper
│                                       (Solar API 호출)
│                                            │
│  ◄───── decision JSON via UART            │
│       (kernel/uart.c의 uartgetc 사용)      │
▼
sys_kill_victim(pid) 호출

xv6 커널 측의 의사코드:

```c
void notify_oom_pressure(void) {
    char buf[CAND_BUF_SIZE];
    int n = collect_candidates(buf, sizeof(buf));
    uart_write(buf, n);                  // 후보 송신
    sleep(&uart_response_channel, &lock); // 응답 대기
    int victim_pid = parse_decision(uart_buf);
    kill(victim_pid);                     // proc.c의 기존 함수 활용
}
```

## 5. 응답 대기 메커니즘 — `sleep` / `wakeup`

LLM 호출은 1~2초 가량 소요된다. 리눅스 구현에서는 pipe의 blocking read
가 자연스럽게 해결해주지만, xv6는 명시적인 `sleep()` / `wakeup()` 패턴을
사용해야 한다.

- UART 응답 대기는 `sleep(&channel, &lock)`로 블록
- UART 인터럽트 핸들러(`uartintr`)에서 응답 도착 시 `wakeup(&channel)`
- 이는 xv6에서 디스크 I/O 등에 이미 사용되는 동일한 패턴

## 6. 본 디자인이 활용하는 xv6 / OS 개념

| 개념 | xv6에서의 위치 | 본 디자인의 활용 |
|------|---------------|----------------|
| 물리 메모리 관리 | `kalloc.c` | OOM 트리거의 시작점 |
| 프로세스 테이블 | `proc.c` | 후보 수집의 소스 |
| 시스템콜 추가 | `syscall.c`, `sysproc.c` | 사용자 공간 헬퍼와의 인터페이스 |
| 디바이스 드라이버 | `uart.c` | 호스트와의 통신 채널 |
| `sleep`/`wakeup` | `proc.c` | 비동기 응답 대기 |
| 시그널/프로세스 종료 | `proc.c`의 `kill()` | victim 종료 |

## 7. 미니 프로토타입 가능성 (Week 13 보너스)

시간 여유가 있다면 Week 13에 다음 정도의 미니 프로토타입을 시연할 수
있다.

- xv6에 echo 시스템콜 1개 추가 (`sys_echo_to_host`)
- 호스트 측 Python 스크립트와 UART로 왕복 통신
- 본 디자인의 통신 구조가 실제로 동작함을 입증

전체 포팅은 본 프로젝트 범위 밖이지만, 이 미니 프로토타입은 디자인의
타당성을 검증하는 핵심 부분이다.

## 8. 디자인의 한계

- xv6는 페이지 단위 정밀 통계가 없어 임계치를 free page 수로만 판단
- UART는 본질적으로 느린 채널이며, 직렬화·역직렬화 오버헤드 존재
- 평문 통신으로 보안상 취약 (실제 시스템에는 부적합, 학술적 시연 목적)
- xv6는 단일 사용자 OS이므로 "사용자별 정책" 개념이 약함
