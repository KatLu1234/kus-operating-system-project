# Conversational OOM Killer

운영체제 00분반 · Team 06
Direction B — LLM for OS
LLM Backend: Upstage Solar Pro 3

---

## 1. 팀 구성

| 학번 | 이름 | 역할 |
|------|------|------|
| 2021270017 | 노혁준 (조장) | R5 — 문서 / 평가 / LLM Helper |
| 2022270635 | 백선하 | R4 — 통합 데몬 |
| 2024270639 | 강규현 | R1 — PSI Monitor |
| 2017271134 | 이승원 | R3 — LLM Helper |
| 2023270626 | 이유진 | R2 — /proc Reader |

역할(R1~R5)은 PSI Monitor, /proc Reader, LLM Helper, 통합 데몬, 문서·평가로 구분된다.

---

## 2. 주제 선정 과정

프로젝트 방향(Direction B — LLM for OS)에 따라 각 조원이 주제를 제안하였다.

| 제안자 | 주제 | 요약 |
|--------|------|------|
| 백선하 | LLM 기반 오류 진단 도구 | 한국어로 오류를 설명하면 로그를 분석해 해결 명령을 추천 |
| 강규현 | AI 스피커용 OS | 뮤직 플레이어 탑재, 재생 효율 우선 CPU 스케줄링 |
| 강규현 | 스마트홈 중앙서버 OS | 센서 데이터 기반 환경 자동 조절 |
| 강규현 | LMS 워크스페이스 OS | 파일 구조를 LMS에 맞게 구성, AI 기반 작업 처리 |
| 노혁준 | Conversational OOM Killer | OOM Killer를 자연어 정책 기반으로 재설계 |
| 이승원 | 자연어 기반 커널 파라미터 관리 도구 | 복잡한 커널 명령을 자연어로 처리 |
| 이유진 | 자동 와이파이 트러블슈터 | 네트워크 장애 시 LLM이 원인과 해결책 안내 |

조원 복수 투표 결과 Conversational OOM Killer와 자연어 기반 오류 분석 도구가 동점을 기록하였다. 토론을 거쳐, Conversational OOM Killer가 더 흥미롭고 운영체제 개념을 깊이 다룰 수 있다는 의견이 다수를 이루어 최종 주제로 선정되었다.

---

## 3. 프로젝트 개요

### 3.1 한 줄 요약

리눅스의 OOM Killer를 사용자가 자연어로 작성한 우선순위 정책에 따라 동작하도록 재설계한다.

### 3.2 문제의식

기존 리눅스 OOM Killer는 oom_score라는 숫자 점수만으로 종료 대상 프로세스를 선택한다. 사용자의 의도(예: "VS Code는 절대 죽이지 마")가 전혀 반영되지 않으므로, 작업 중인 중요한 프로세스가 유휴 상태의 백그라운드 프로세스보다 먼저 종료되는 문제가 발생한다.

### 3.3 우리의 접근

사용자가 한 단락 분량의 자연어 정책을 작성하면, 메모리 압박이 감지될 때 LLM이 해당 정책을 해석하여 종료 대상을 추천한다. 안전성은 결정론적 C 코드로 구현된 Validator가 보장한다 (PID 1, systemd 등 핵심 시스템 프로세스 보호).

### 3.4 기술 스택

| 구분 | 기술 |
|------|------|
| 데몬 | C (PSI Monitor, /proc Reader, IPC, Validator, 시그널 처리) |
| LLM 모듈 | Python 3 (Upstage Solar Pro API) |
| IPC | fork + execlp + pipe (C ↔ Python 양방향 통신) |
| 환경 | Linux (Ubuntu, cgroups v2 / PSI) + xv6 (QEMU) |

---

## 4. 구현 및 동작 검증

### 4.1 개요

설계한 파이프라인을 실제로 구현하여 end-to-end 동작을 검증하였다. 가짜 데이터로 시작했던 PSI Monitor와 /proc Reader를 모두 실제 리눅스 데이터 기반으로 전환하였으며, LLM이 자연어 정책을 해석하여 실제 프로세스 중에서 종료 대상을 선정하는 동작이 정상 작동함을 확인하였다.

### 4.2 실제 실행 결과

WSL 환경에서 실제로 실행한 결과는 다음과 같다.

```
$ ./bin/coomd --dry-run

[R4 Main Loop] PSI some_avg10: 16.50% (임계값: 15.00%)
🚨 [ALERT] 메모리 위험 신호 감지 — OOM 처리 시작

[R2] 종료 후보 22개 발견 (/proc 실제 스캔)
  -> PID  210 | unattended-upgr | 22144 kB
  -> PID   42 | systemd-journal | 15616 kB
  -> PID  122 | systemd-resolve | 12672 kB
  -> PID    1 | systemd         | 12336 kB
  ... (총 22개)

[R3 LLM Helper] 사용자 정책 기반 victim 선택 요청...
  🤖 AI 선택: unattended-upgr (PID 210)
  💬 판단 근거: Only unattended-upgr is a non-system process not
     explicitly protected by the policy. It frees 21.6MB. No other
     candidates are eligible per policy/system rules.

  🎯 victim → PID 210 (unattended-upgr)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] SIGTERM 가상 전송
```

22개의 실제 WSL 프로세스 중에서 AI는 시스템 프로세스를 모두 회피하고, 정책에 보호되지 않은 유일한 비시스템 프로세스(unattended-upgr)를 정확히 선택하였다. 판단 근거가 영어 문장으로 생성된 점에서, LLM이 사전 규칙이 아닌 실제 정책 추론을 수행하였음을 확인할 수 있다.

### 4.3 기술적 핵심

C 기반 데몬과 Python LLM 모듈 간의 연동을 fork() + execlp() + pipe() 기반 양방향 IPC로 구현하였다. 운영체제의 프로세스 생성 및 프로세스 간 통신 개념을 직접 적용한 것으로, 본 프로젝트가 단순 LLM API 호출이 아니라 운영체제 수준의 설계를 본질로 함을 보여준다.

### 4.4 xv6 커널 구현 (병행 진행)

리눅스 유저스페이스 구현과 별개로, 동일한 PSI 메커니즘을 xv6 커널 수준에서 직접 구현하였다. kalloc에 sleep/wakeup 기반 메모리 대기 측정을 추가하고, 타이머 인터럽트마다 지수평균으로 PSI 지표를 갱신하며, 락 안전성을 위해 allocproc/kfork에서 락을 일시 해제하는 처리까지 포함하였다. QEMU에서 psitest 실행 시 메모리 압박에 따라 some_avg10이 0%에서 9%까지 실시간 측정되는 것을 확인하였다.

---

## 5. 정책 부합률 평가

### 5.1 평가 목적

본 시스템의 핵심 기능인 *"LLM이 자연어 정책에 근거하여 종료 대상을 정확히 선정하는가"*를 정량적으로 검증하기 위해, 5가지 시나리오에서 총 6회의 의사결정을 측정하였다.

### 5.2 시나리오 설계

| 번호 | 검증 항목 |
|------|----------|
| 1 | 명시적 보호/허용 규칙의 정확한 해석 |
| 2 | 우선순위 기반 선택 및 메모리 목표 달성을 위한 단계적 종료 |
| 3 | 정책에 명시되지 않은 시스템 프로세스의 상식적 보호 |
| 4 | 메모리 목표와 정책 충돌 시 정책 우선 원칙 |
| 5 | 동일 시스템 상태에서 정책 변경에 따른 결정 변화 |

### 5.3 결과 요약

| # | 정책 핵심 | AI 선택 | 부합 |
|---|---------|---------|------|
| 1 | firefox/code 보호, chrome 허용 | chrome | ✅ |
| 2 | music < browser < editor 우선순위 | spotify + chrome | ✅ |
| 3 | 시스템 프로세스 추상적 보호 | chrome (systemd/init/dbus 회피) | ✅ |
| 4 | 모든 후보 절대 보호 | (선택 없음) | ✅ |
| 5a | "Kill chrome" | chrome | ✅ |
| 5b | "Save chrome, kill spotify" | spotify | ✅ |

**총 6회 의사결정 중 6회 정책 부합 — Policy Compliance Rate: 100%**

### 5.4 주요 인사이트

**시나리오 4 — 정책 우선 원칙 (안전성)**
메모리 목표(500MB)와 사용자 정책이 충돌하는 상황에서, 시스템은 메모리 목표 달성보다 사용자 정책 준수를 우선시하여 종료를 거부하였다. 기존 OOM Killer가 무조건적으로 victim을 선택하는 것과 달리, 사용자 의도를 침해하지 않는 안전한 동작을 보였다.

**시나리오 5 — Conversational의 본질**
동일한 시스템 상태(같은 후보, 같은 메모리)에서 정책만 변경하였더니 AI가 정반대의 결정을 도출하였다. "Kill chrome"이면 chrome을, "Save chrome, kill spotify"이면 spotify를 선택하였다. 이는 기존 OOM Killer로는 불가능한 동작이며, 본 프로젝트가 "Conversational"로 명명된 근거가 실제로 구현되었음을 보여준다.

**시나리오 3 — 상식 기반 안전 판단**
정책이 "system processes"라는 추상적 표현만 사용하였음에도, AI는 systemd, init, dbus-daemon을 모두 시스템 프로세스로 인식하여 회피하였다. 단순 규칙 매칭이 아닌 일반 상식 기반 해석 능력을 보여준다.

### 5.5 알려진 한계

평가 과정에서 LLM이 메모리 단위 환산에서 부정확한 응답을 보인 사례가 한 차례 관측되었다 (390.625 MB를 500 MB target보다 크다고 응답). 종료 대상 선택 자체는 정책에 부합하였으므로 정책 부합률에는 영향이 없으나, 향후 결정론적 산술 연산은 결정론적 코드로 보완할 필요가 있다.

---

## 6. 향후 계획

- 평가 시나리오 확장 및 자동화된 회귀 테스트 구축
- stress-ng 기반 실제 메모리 압박 환경에서의 종단 검증
- xv6 PSI 구현의 안정성 개선 (락 안전성, full 지표 검증)
- 리눅스 데몬과 xv6 구현 간의 비교 분석 문서화
