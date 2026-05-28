# PSI 메커니즘 구현 변경 사항 기록

## Phase 1: PCB 확장 (`kernel/proc.h`)
- **`struct proc` 수정**: 프로세스의 메모리 대기 시간을 추적하기 위해 다음 필드를 추가하였습니다.
    - `uint64 mem_stall_ticks`: 누적 메모리 대기 시간 (Ticks).
    - `uint64 last_stall_start`: 마지막 메모리 대기 시작 시점 (Ticks).

## Phase 2: 스톨 시간 측정 및 대기 메커니즘 (`kernel/kalloc.c`)
- **`kalloc()` 함수 수정**:
    - 가용 메모리가 없을 경우(`freelist == 0`), 현재 프로세스(`myproc()`)가 존재한다면 대기 모드로 진입합니다.
    - 대기 시작 시점(`last_stall_start`)을 기록하고 `sleep(&kmem, &kmem.lock)`을 호출하여 메모리가 확보될 때까지 잠듭니다.
    - 메모리를 할당받아 깨어난 후, 대기한 시간(`ticks - last_stall_start`)을 `mem_stall_ticks`에 누적합니다.
- **`kfree()` 함수 수정**:
    - 메모리 페이지가 반환될 때 `wakeup(&kmem)`을 호출하여 메모리를 기다리며 잠들어 있는 프로세스들을 깨웁니다.

## Phase 3: 지표 계산 로직 (`kernel/proc.c`, `kernel/trap.c`, `kernel/defs.h`)
- **전역 PSI 통계 변수 추가 (`kernel/proc.c`)**:
    - `some_avg10`, `full_avg10`: 최근 10초간의 메모리 압박 지수를 저장하는 변수입니다. 고정 소수점(Fixed-point, scale=1024) 방식을 사용합니다.
    - `psi_lock`: PSI 통계 변수에 안전하게 접근하기 위한 스핀락을 추가하였습니다.
- **시스템 상태 판별 함수 `update_psi()` 구현 (`kernel/proc.c`)**:
    - 모든 프로세스를 순회하며 현재 시스템이 `SOME` 또는 `FULL` 스톨 상태인지 판별합니다.
    - **SOME**: 최소 한 명의 프로세스가 메모리 대기 중인 상태.
    - **FULL**: 메모리 대기 중인 프로세스가 있고, 실행 가능(`RUNNABLE`/`RUNNING`)한 프로세스가 없는 상태.
    - **지수 평균 적용**: $\tau(n+1) = \alpha \cdot t(n) + (1-\alpha) \cdot \tau(n)$ 공식을 사용하여 10초 평균을 갱신합니다. (가중치 $\alpha$는 약 1/100 적용)
- **타이머 인터럽트 연동 (`kernel/trap.c`)**:
    - 매 타이머 틱마다 실행되는 `clockintr()` 함수에서 CPU 0번이 `update_psi()`를 호출하도록 하여 주기적으로 지표를 갱신합니다.
- **전역 선언 (`kernel/defs.h`)**:
    - `update_psi()` 함수와 PSI 통계 변수들을 다른 커널 파일에서도 참조할 수 있도록 선언을 추가하였습니다.

## Phase 4: 사용자 모드 인터페이스 (`kernel/sysproc.c`, `kernel/syscall.c`, `user/user.h` 등)
- **공용 데이터 구조체 추가 (`kernel/types.h`)**:
    - `struct psi_data`: 사용자 공간으로 전달될 PSI 통계 데이터를 담는 구조체를 정의하였습니다.
- **시스템 콜 구현 (`kernel/sysproc.c`)**:
    - `sys_get_mem_pressure()`: 커널 내의 PSI 데이터를 `psi_data` 구조체에 복사하여 사용자 공간의 주소로 전달하는 시스템 콜을 구현하였습니다.
- **시스템 콜 등록 (`kernel/syscall.h`, `kernel/syscall.c`)**:
    - `SYS_get_mem_pressure` 번호를 할당하고 시스템 콜 테이블에 등록하였습니다.
- **사용자 인터페이스 제공 (`user/user.h`, `user/usys.pl`)**:
    - 사용자 프로그램에서 `get_mem_pressure(struct psi_data*)` 함수를 호출할 수 있도록 헤더와 스텁(stub)을 추가하였습니다.

## Phase 5: 안정성 개선 및 락(Lock) 안전성 확보 (`kernel/proc.c`)
- **`panic: acquire` 해결**:
    - `kalloc()`이 메모리 부족 시 `sleep()`을 호출하게 됨에 따라, 락을 보유한 채로 `kalloc()`을 호출하면 `update_psi()` 실행 시 재귀적 락 획득(Recursive Lock Acquisition) 패닉이 발생할 수 있는 문제를 확인하였습니다.
- **`allocproc()` 수정**:
    - 프로세스 할당 중 `kalloc()` 및 `proc_pagetable()`을 호출하기 전, 보유 중인 `p->lock`을 일시적으로 해제하여 `kalloc()` 내부에서 안전하게 `sleep()`할 수 있도록 하였습니다. 작업 완료 후 다시 락을 획득하여 함수 규약을 준수합니다.
- **`kfork()` 수정**:
    - 자식 프로세스의 메모리를 복사하는 `uvmcopy()` 호출 전, `np->lock`을 해제하였습니다. `uvmcopy()` 내부에서 호출되는 `kalloc()`이 대기 상태에 들어갔을 때, 타이머 인터럽트가 동일한 락을 획득하려다 발생하는 패닉을 방지합니다.
