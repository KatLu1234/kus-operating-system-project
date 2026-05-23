# OS Concepts in Play

본 프로젝트는 운영체제 수업에서 다룬 핵심 개념들을 실질적으로 활용한다.
각 개념이 어느 컴포넌트에 어떻게 적용되었는지 정리한다.

## 1. 매핑 표

| OS 개념 | 어디서 사용 | 담당 | 컴포넌트 |
|---------|------------|------|----------|
| 메모리 관리 / cgroups v2 / PSI | `/proc/pressure/memory` 폴링으로 시스템 메모리 압박 감지 | R1 | `daemon/psi_monitor.c` |
| `/proc` 파일시스템 인트로스펙션 | 모든 사용자 프로세스의 메타데이터 수집 (`status`, `cmdline`, `oom_score`, `cgroup`) | R2 | `daemon/proc_reader.c` |
| 프로세스 생성 (`fork` + `execlp`) | C 데몬이 Python LLM Helper를 자식 프로세스로 띄움 | R4 | `daemon/ipc.c` |
| IPC (pipe) | C 데몬과 Python Helper 간 양방향 통신 (stdin/stdout) | R4 | `daemon/ipc.c` |
| 시스템 콜 / 시그널 (`kill`, `waitpid`) | victim 프로세스에 `SIGTERM` → 대기 → `SIGKILL` 에스컬레이션 | R4 | `daemon/dispatcher.c` |
| 프로세스 수명주기 | 좀비 프로세스 회수 (`waitpid(WNOHANG)`) | R4 | `daemon/dispatcher.c` |
| 캐시 / 교체 정책 (보너스) | LLM latency 회피용 decision cache (LRU-inspired) | R3 / R4 | Week 12+ |

## 2. 각 개념의 역할

### 2.1 PSI (Pressure Stall Information)
리눅스 커널 4.20+에서 도입된 자원 압박 통계 기능. cgroups v2와 통합되어
`/proc/pressure/memory`로 노출된다. 본 프로젝트는 `some avg10` 필드를
폴링하여 메모리 압박이 임계치를 초과할 때 의사결정 루프를 트리거한다.
이는 전통적인 "메모리 부족 임박" 신호를 OS가 직접 제공한 것이며, 본
시스템의 진입점에 해당한다.

### 2.2 `/proc` 파일시스템
리눅스 커널이 프로세스 정보를 가짜 파일 형태로 노출하는 가상 파일시스템.
본 시스템은 `opendir(2)` / `readdir(3)`로 `/proc`를 순회하고, 각 PID의
하위 파일을 파싱하여 LLM에 전달할 후보 메타데이터를 구성한다. 시스템콜
없이 텍스트 파싱만으로 풍부한 커널 정보에 접근하는 리눅스 고유의 패턴.

### 2.3 프로세스 생성과 IPC
본 시스템은 C 데몬과 Python LLM Helper라는 두 프로세스로 구성된다.
데몬 시작 시 `pipe(2)` 두 개를 생성하고, `fork(2)` 후 자식의 stdin/stdout
을 `dup2(2)`로 pipe에 연결한 뒤 `execlp(3)`로 Python 헬퍼를 실행한다.
이는 OS 수업에서 다루는 프로세스 생성·IPC의 정통 패턴을 그대로 활용한다.

### 2.4 시그널과 프로세스 수명주기
Victim 결정 후 `kill(2)`로 `SIGTERM`을 송신하고 5초간 응답을 대기한다.
프로세스가 정상 종료하지 않으면 `SIGKILL`로 에스컬레이션한다. 종료된
자식 프로세스의 좀비 상태는 `waitpid(WNOHANG)`로 비동기 회수한다.

### 2.5 캐시·교체 정책
LLM 호출은 1~2초 가량 소요되어 실시간 메모리 압박 대응에 부적합하다.
이를 완화하기 위해 메모리 사용률이 일정 수준에 도달하면 미리 결정을
계산해두는 decision cache를 도입할 예정이다. 캐시 무효화는 프로세스
생성·종료 이벤트를 기반으로 한다. 이는 OS의 페이지 캐시 / LRU 정책과
구조적으로 동일한 문제이다.

## 3. 본 프로젝트가 OS 프로젝트인 이유

LLM은 본 시스템의 한 부품에 불과하다. 의사결정 직전·직후의 모든 작업
— 메모리 압박 감지, 후보 수집, 프로세스 생성, IPC, 검증, 시그널
디스패치, 좀비 회수 — 는 **운영체제 수준의 시스템 콜과 자료구조를
직접 다루는 C 코드로 구현되었다**. LLM API는 단순 HTTPS 호출 한 줄이지만,
그 호출을 둘러싼 OS 메커니즘이 프로젝트의 본질이다.
