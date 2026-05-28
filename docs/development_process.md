# Development Process Document

> Conversational OOM Killer 팀 프로젝트 개발 과정 기록
> Direction B — LLM for OS

---

## 1. 팀 구성

| 학번 | 이름 | 역할 |
|---|---|---|
| 2021270017 | 노혁준 (조장) | R5 — 문서 / 평가 / LLM Helper |
| 2022270635 | 백선하 | R4 — 통합 데몬 |
| 2024270639 | 강규현 | R1 — PSI Monitor |
| 2017271134 | 이승원 | R3 — LLM Helper |
| 2023270626 | 이유진 | R2 — `/proc` Reader |

역할(R1~R5)은 **PSI Monitor, /proc Reader, LLM Helper, 통합 데몬, 문서·평가**로 구분된다.

---

## 2. 주제 선정 과정

프로젝트 방향(Direction B — LLM for OS)에 따라, 각 조원이 다음과 같이 주제를 제안하였다.

| 제안자 | 주제 | 요약 |
|---|---|---|
| 백선하 | LLM 기반 오류 진단 도구 | 한국어로 오류를 설명하면 로그를 분석해 해결 명령을 추천. (질문 → OS 정보 수집 → LLM 분석 → 안전성 검사 → 해결책 제공) |
| 강규현 | AI 스피커용 OS | 뮤직 플레이어 탑재, 재생 효율을 우선하는 CPU 스케줄링, AI에게 재생/정지/목록 생성 요청 |
| 강규현 | 스마트홈 중앙서버 OS | 센서로 온도 등을 수집해 습도·온도·조명을 최적 환경으로 유지하는 OS |
| 강규현 | LMS 워크스페이스 OS | 파일 구조를 LMS에 맞게 구성하고, 출석·과제 제출 등을 AI로 처리하는 OS |
| 노혁준 | **Conversational OOM Killer** | 리눅스 OOM Killer를 사용자가 자연어로 작성한 우선순위 정책에 따라 동작하도록 재설계 |
| 이승원 | 자연어 기반 커널 파라미터 관리 도구 | 복잡한 커널 파라미터 변경 명령을 자연어로 처리 |
| 이유진 | 자동 와이파이 트러블슈터 | 인터넷 장애 시 LLM이 네트워크 상태를 점검해 원인과 해결책을 안내 |

조원 복수 투표를 진행한 결과, **Conversational OOM Killer**와 **자연어 기반 오류 분석 도구**가 동점을 기록하였다. 이후 토론을 거쳐, Conversational OOM Killer가 더 흥미롭고 운영체제 개념을 깊이 다룰 수 있다는 의견이 다수를 이루어 최종 주제로 선정하였다.

---

## 3. 프로젝트 개요

### 한 줄 요약
리눅스의 OOM Killer를 사용자가 자연어로 작성한 우선순위 정책에 따라 동작하도록 재설계한다.

### 문제의식
기존 리눅스 OOM Killer는 `oom_score`라는 숫자 점수만으로 종료 대상(victim) 프로세스를 선택한다. 사용자의 의도(예: "VS Code는 절대 죽이지 마")가 전혀 반영되지 않으므로, 작업 중인 중요한 프로세스가 유휴 상태의 백그라운드 프로세스보다 먼저 종료되는 문제가 발생한다.

### 우리의 접근
사용자가 한 단락 분량의 자연어 정책을 작성하면, 메모리 압박이 감지될 때 LLM이 해당 정책을 해석하여 종료 대상을 추천한다. 안전성은 결정론적 C 코드로 구현된 Validator가 보장한다 (PID 1, systemd 등 핵심 시스템 프로세스 보호).

### 기술 스택

| 구분 | 기술 |
|---|---|
| daemon | C (PSI 모니터, `/proc` 리더, IPC, Validator, 시그널 처리) |
| LLM 모듈 | Python 3 (Upstage Solar Pro API) |
| IPC | `fork` + `execlp` + `pipe` (C ↔ Python 양방향 통신) |
| 환경 | Linux (Ubuntu, cgroups v2 / PSI) |

---

## 4. 최소 동작 프로토타입 (End-to-End LLM 통합)

### 개요
설계한 파이프라인을 실제로 구현하여 end-to-end 동작을 검증하였다. 핵심 기능인 "LLM이 자연어 정책을 해석하여 종료 대상을 선택하는" 동작이 Upstage Solar Pro API 기반으로 정상 작동함을 확인하였다.

### 검증 시나리오 (Mock 데이터 기반)

**입력 — 사용자 정책 (자연어):**
```
I am coding. Never kill firefox. Chrome tabs are fine to kill first.
```

**시스템 동작:**
1. 메모리 압박 감지 시 종료 후보 프로세스 수집 (chrome, firefox, systemd)
2. 후보 목록과 사용자 정책을 LLM에 전달
3. LLM이 정책에 근거하여 종료 대상 선정

### 실제 실행 결과

```
$ ./bin/coomd --dry-run
[R4 Main Loop] PSI some_avg10: 16.50% (임계값: 15.00%)
🚨 [ALERT] 메모리 위험 신호 감지 — OOM 처리 시작
[R2] 종료 후보 3개 발견
  -> PID 9999 | chrome  | 1245000 kB
  -> PID 8888 | firefox |  512000 kB
  -> PID    1 | systemd |    4096 kB
[R3 LLM Helper] 사용자 정책 기반 victim 선택 요청...
  🤖 AI 선택: chrome (PID 9999)
  💬 판단 근거: Selected chrome as it's marked 'fine to kill
     first' and frees 1215 MB, exceeding the 500 MB target.
     Avoided killing firefox and systemd per policy.
  🎯 victim → PID 9999 (chrome)
     🛡️ [VALIDATOR] PASS
     ⚡ [DRY-RUN] SIGTERM 가상 전송
```

> ⚠️ **본 검증은 mock 데이터를 사용한 End-to-End 흐름 검증이다.**
> PSI 값과 후보 프로세스(PID 9999, 8888)는 더미이며, 실제 `/proc` 연동은 Week 12에서 진행한다.

위 결과에서 보듯, AI는 실제로 사용자 정책을 해석하여 chrome을 선택하고 firefox와 systemd는 회피하였다. 판단 근거가 영어 문장으로 생성된 점에서, 사전에 정해진 규칙이 아니라 LLM이 실제로 정책을 추론하여 응답하였음을 확인할 수 있다.

### LLM 판단 결과

| 프로세스 | 판단 | 근거 |
|---|---|---|
| chrome | 선택 | 정책상 종료 허용, 메모리 목표 달성 |
| firefox | 보호 | "never kill" 정책 반영 |
| systemd | 회피 | 시스템 프로세스 |

종료 대상이 단순 메모리 크기가 아닌 사용자 의도에 근거하여 선정됨을 확인하였다. 선정된 대상은 Validator의 화이트리스트 검증을 추가로 통과한 후 처리된다.

### 기술적 핵심
C 기반 데몬과 Python LLM 모듈 간의 연동을 `fork()` + `execlp()` + `pipe()` 기반 양방향 IPC로 구현하였다. 이는 운영체제의 프로세스 생성 및 프로세스 간 통신 개념을 직접 적용한 것으로, 본 프로젝트가 단순 LLM API 호출이 아니라 운영체제 수준의 설계를 본질로 함을 보여준다.

---

## 5. 컴포넌트 현황

| 컴포넌트 | 상태 | 비고 |
|---|---|---|
| Main Daemon (C) | ✅ 완료 | 메인 루프, 옵션 파싱, 로깅 |
| Validator (C) | ✅ 완료 | PID 1, systemd 등 시스템 프로세스 보호 |
| LLM Helper (Python) | ✅ 완료 | Solar Pro API 실연동, 정책 기반 선택 |
| C ↔ Python IPC | ✅ 완료 | `fork` + `execlp` + `pipe` 양방향 통신 |
| PSI Monitor (C) | 🟡 진행 중 | 현재 고정값, 실제 `/proc` 연동 예정 |
| `/proc` Reader (C) | 🟡 진행 중 | 현재 더미 후보, 실제 `/proc` 파싱 예정 |

---

## 6. 향후 계획

| 주차 | 마일스톤 | 담당 |
|---|---|---|
| W12 | PSI Monitor 실제 `/proc/pressure/memory` 연동 | R1 |
| W12 | `/proc` Reader 실제 `/proc/[pid]/*` 파싱 | R2 |
| W12 | 평가 지표 정의 (정책 부합률, 회복 시간, 결정 일관성) | R5 |
| W13 | stress-ng 활용 실제 메모리 압박 환경 검증 | R5 |
| W13 | Baseline (기본 OOM) vs `coomd` 비교 측정 | R5 |
| W14 | 최종 발표 (영어) | 전원 |

### 평가 지표 정의 (계획)

| 지표 | 계산식 |
|---|---|
| 정책 부합률 | `(정책에 부합하는 victim 선택 횟수) / (총 OOM 이벤트)` × 100% |
| 회복 시간 | `PSI ≥ 15% 진입 시각 ~ PSI < 10% 복귀 시각` |
| 결정 일관성 | `같은 후보군 10회 반복 시 같은 victim 선택 비율` |
| 결정 지연 | `PSI 감지 → SIGTERM 송신`까지의 시간 |

목표: 정책 부합률 ≥ 80% (Baseline 약 50% 대비).
