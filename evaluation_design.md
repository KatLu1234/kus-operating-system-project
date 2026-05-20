# Evaluation Design

이 시스템이 기본 Linux OOM Killer 대비 사용자 의도를 얼마나 더 잘 반영
하는지 검증하기 위한 평가 설계를 정리한다. 실제 측정과 데이터 수집은
나중에 수행한다.

## 1. 평가 목표

다음 세 가지 질문에 답한다.

1. **정책 부합률**: 우리 시스템은 사용자 정책을 위반하지 않고 victim을
   선택하는가?
2. **시스템 회복성**: 메모리 압박이 발생했을 때, 시스템이 충분한 메모리를
   회복하는가? 회복 시간은 기본 OOM 대비 얼마나 차이 나는가?
3. **결정 안정성**: 동일한 입력에 대해 LLM은 일관된 결정을 내리는가?

## 2. 비교 대상

- **Baseline**: 기본 Linux OOM Killer (`vm.overcommit_memory` 기본값, 
  `oom_score`에 따라 동작)
- **Treatment**: 본 프로젝트의 `coomd` 데몬 (PSI + LLM + Validator)

두 시스템은 동일한 부하 시나리오 하에서 별도 VM에서 실행된다.

## 3. 부하 시나리오 (3개)

각 시나리오는 Python 스크립트로 재현 가능하게 작성한다.

### 시나리오 A — 점진적 메모리 누수
한 프로세스가 일정 주기로 메모리를 누적 할당한다. 가장 흔한 OOM 발생
패턴.

```python
# eval/scenarios/gradual_leak.py
import time
blocks = []
while True:
    blocks.append(bytearray(100 * 1024 * 1024))  # 100MB
    time.sleep(2)
```

**측정 목적**: 점진적 압박 상황에서 누가 victim으로 선정되는지.
기본 OOM은 누수 프로세스 자신을 죽일 가능성이 높지만, 사용자가 다른
프로세스를 보호 대상으로 명시한 경우의 동작을 비교.

### 시나리오 B — 갑작스러운 큰 할당
배경 프로세스들이 안정적으로 실행 중인 상태에서, 한 프로세스가 한 번에
큰 메모리를 요청.

```python
# eval/scenarios/sudden_alloc.py
import sys
size_mb = int(sys.argv[1])  # 예: 4000
buf = bytearray(size_mb * 1024 * 1024)
input("Press Enter to release...")
```

**측정 목적**: PSI가 빠르게 트리거되는지, LLM latency 동안 시스템이
어떻게 반응하는지.

### 시나리오 C — 다수 프로세스 동시 부하
여러 개의 중간 크기 프로세스가 동시에 메모리를 사용. 가상 환경의 빌드
서버나 다중 컨테이너 호스트를 모사.

```python
# eval/scenarios/multi_process.py
# 10개의 자식 프로세스를 fork하여 각각 300MB 사용
```

**측정 목적**: 후보가 많을 때 LLM의 정책 해석 정확도. 특히 `cmdline`
패턴 매칭(예: "browser tabs", "dev-* containers")이 잘 동작하는지.

## 4. 평가 지표

### 4.1 정책 부합률 (Policy Compliance Rate)
victim으로 선택된 프로세스 중 사용자 정책 위반이 **없는** 비율.
- 측정 방법: 각 시나리오에서 미리 라벨링한 "보호 대상" 프로세스가
  죽었는지 확인
- 표현: 백분율 (`100 × (1 - 위반_횟수 / 총_시도)`)

### 4.2 회복 시간 (Recovery Time)
PSI 임계치 초과 시점부터 메모리 압박이 정상 수준으로 돌아오는 데
걸린 시간.
- 측정 방법: PSI `some avg10`이 임계치 미만으로 떨어진 시점까지의
  경과 시간
- 단위: 초

### 4.3 결정 latency
PSI 이벤트 발생부터 첫 시그널 디스패치까지 걸린 시간.
- 분해: PSI 감지 → `/proc` 스캔 → IPC 송신 → LLM 응답 → Validator
  → 시그널 전송
- 단위: 밀리초

### 4.4 결정 일관성 (Decision Consistency)
동일한 후보 리스트·동일 정책에 대해 LLM이 동일한 victim을 반환하는
비율. `temperature=0`을 사용함에도 LLM의 비결정성이 남는지 검증.
- 측정 방법: 각 시나리오를 10회 반복하여 victim 일치 비율 계산

## 5. 실험 환경

- **VM**: VirtualBox 또는 multipass, Ubuntu 22.04, RAM 4 GB, swap 비활성화
- **반복 횟수**: 각 시나리오 × 각 시스템(baseline/treatment) × 10회
- **사용자 정책 (예시)**:
- **로깅**: 각 실행마다 PSI 시계열, `/proc` 스냅샷, victim PID, 회복
  시간을 JSON 로그로 저장

## 6. 가설

- **H1**: 본 시스템의 정책 부합률은 기본 OOM Killer 대비 유의미하게 높다
  (≥ 80% vs. ~50%).
- **H2**: 본 시스템의 회복 시간은 기본 OOM 대비 LLM latency만큼 (1~2초)
  더 길지만, 대규모 작업 손실을 막아 사용자 효용은 더 높다.
- **H3**: `temperature=0` 설정으로 결정 일관성은 ≥ 95% 달성한다.

## 7. 한계 (Week 13 보고서에 명시)

- 평가가 VM 환경에 한정되어 실제 데스크탑/서버 환경과 차이 가능
- 사용자 정책 종류가 한정적 (1~3개)
- LLM API의 외부 의존성으로 인한 재현성 한계
