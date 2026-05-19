
# [구현 가이드] xv6 PSI 및 OOM 감지 시스템 수정을 위한 주요 파일 및 함수

본 문서는 xv6의 기존 구조를 확장하여 리눅스의 PSI와 유사한 자원 압박 모니터링 기능을 커널 레벨에서 구현하기 위한 기술적 참조 모델입니다.

## 1. 커널 핵심 데이터 구조 및 관리 (`kernel/`)

### `kernel/proc.h`
*   **수정 대상:** `struct proc` (프로세스 제어 블록, PCB).
*   **추가 필드:**
    *   `uint64 mem_stall_ticks`: 프로세스가 메모리 할당을 기다리며 멈춰 있었던 총 시간(틱 단위).
    *   `uint64 last_stall_start`: 가장 최근에 메모리 대기가 시작된 시점의 타임스탬프.
    *   `int is_stalled`: 현재 프로세스가 메모리 압박으로 인해 대기 상태인지 나타내는 플래그.

### `kernel/proc.c`
*   **수정 함수:**
    *   `allocproc()`: 새로운 프로세스 생성 시 추가된 PSI 관련 필드들을 초기화합니다.
    *   `scheduler()`: 프로세스 상태 변화를 모니터링하여 `RUNNING`에서 `SLEEPING`으로 전환될 때의 원인을 파악하는 로직을 추가할 수 있습니다.

### `kernel/kalloc.c`
*   **수정 함수:** `kalloc()`.
*   **수정 내용:** 
    *   메모리 할당 요청 시 가용 페이지가 없는 경우를 감지합니다.
    *   할당 실패 시 현재 프로세스의 `is_stalled` 플래그를 세팅하고 `last_stall_start`를 기록하여 **스톨(Stall) 시작**을 알립니다.
    *   메모리가 확보되어 할당에 성공하면 대기 시간을 계산하여 `mem_stall_ticks`에 합산합니다.

## 2. 지표 계산 및 시스템 인터럽트 (`kernel/`)

### `kernel/trap.c`
*   **수정 함수:** `usertrap()`, `kerneltrap()`.
*   **수정 내용:** 
    *   **타이머 인터럽트**가 발생할 때마다 커널이 시스템 전체의 메모리 압박 상태를 체크하도록 합니다.
    *   매 틱마다 실행 중인 모든 프로세스를 순회하며 `is_stalled` 상태인 프로세스 비율을 계산합니다.
    *   **지수 평균(Exponential Averaging)** 공식($\tau(n+1) = \alpha \cdot t(n) + (1-\alpha) \cdot \tau(n)$)을 적용하여 `avg10`, `avg60` 등의 수치를 갱신합니다.

### `kernel/psi.c` (신규 파일 생성 권장)
*   **신규 함수:** 
    *   `update_psi_stats()`: 타이머 인터럽트에서 호출되어 실제 PSI 수치를 계산하는 핵심 로직.
    *   `get_psi_data()`: 계산된 지표 정보를 구조체 형태로 반환하는 함수.

## 3. 시스템 콜 인터페이스 (`kernel/` & `user/`)

### `kernel/syscall.h` & `kernel/syscall.c`
*   **수정 내용:** 새로운 시스템 콜 번호(예: `SYS_get_mem_pressure`)를 정의하고 시스템 콜 테이블에 등록합니다.

### `kernel/sysproc.c`
*   **신규 함수:** `sys_get_mem_pressure()`
*   **수정 내용:** 사용자 공간에서 요청한 버퍼에 커널이 계산한 PSI 통계 데이터를 안전하게 복사(`copyout`)해주는 함수를 구현합니다.

### `user/user.h` & `user/usys.pl`
*   **수정 내용:** 사용자 프로그램이 새로운 시스템 콜을 호출할 수 있도록 인터페이스 정의 및 스텁 코드를 추가합니다.

## 4. OOM 감지 및 대응 로직 (`kernel/`)

### `kernel/defs.h`
*   **수정 내용:** 새로 추가된 PSI 및 OOM 관련 함수들의 프로토타입을 선언하여 커널 전역에서 참조할 수 있게 합니다.
