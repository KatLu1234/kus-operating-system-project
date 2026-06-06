# 발표 자료 기획서 (Presentation Plan)

> 프로젝트: **Conversational OOM Killer** — LLM 기반 OOM Killer를 xv6-riscv 위에서 시연
> 방향: Direction B — *LLM for OS*
> 대상: Week 14 최종 발표 (Professor 15% + Peer 15%)
> ⚠️ **발표 슬라이드와 구두 발표 모두 영어** (PROJECT.md §5, §6 요구사항)
>
> 이 문서는 발표를 만들 때 **어떤 슬라이드를, 어떤 순서로, 어떤 내용으로** 채워야 하는지를
> 정리한 체크리스트다. 실제 슬라이드 텍스트는 영어로 작성한다.

---

## 0. 발표에서 반드시 전달해야 할 핵심 메시지 (3가지)

1. **문제**: 기존 OS의 OOM Killer는 메모리 크기(`oom_score`)만 보고 죽인다 — **사용자 의도가 빠져 있다.**
2. **해결**: 사용자가 자연어로 정책을 쓰면 **LLM이 그 의도를 해석해 victim을 고른다.**
3. **OS 프로젝트인 이유**: LLM은 부품일 뿐, **PSI·시스템콜·프로세스/시그널·IPC·커널 안전망** 등
   운영체제 메커니즘을 직접 설계·구현했다. (커널 2층 OOM 구조가 하이라이트)

> 청중이 단 한 문장만 가져간다면: *"OOM victim 선택을, 숫자 점수가 아니라 사용자가
> 자연어로 표현한 의도에 따라 — 그러나 커널 안전망으로 liveness를 보장하면서 — 수행한다."*

---

## 1. 권장 슬라이드 구조 (약 15~18장, 12~15분 발표 기준)

| # | 슬라이드 | 목적 | 핵심 자료 출처 |
|---|----------|------|----------------|
| 1 | **Title** | 팀명/팀원/주제 한 줄 | development_process.md §1 |
| 2 | **The Everyday Problem** | "탭이 갑자기 닫힘 / 빌드가 죽음" 공감 유도 | problem.md §1 |
| 3 | **How Linux OOM Killer Works** | `oom_score` = RSS·실행시간·nice·adj | problem.md §2 |
| 4 | **The Limitation** | 사용자 의도 미반영 (3 시나리오) | problem.md §3 |
| 5 | **Our Idea — Conversational OOM** | 자연어 정책 → LLM victim 추천 → 결정론적 검증 | problem.md §4 |
| 6 | **Why an LLM? (not regex)** | 의미적 매칭/자유형식/컨텍스트 종합 | problem.md §5 |
| 7 | **System Architecture** | 블록 다이어그램 (xv6 ↔ host ↔ LLM) | current_architecture.md §1 |
| 8 | **OS Concepts in Play** | PSI·syscall·process/signal·IPC 매핑표 | os_concepts.md §1 |
| 9 | **xv6 Kernel — PSI Mechanism** | kalloc stall → sleep(&kmem), update_psi EMA | current_architecture.md §3 |
| 10 | **Two-Layer OOM Decision** ★ | 1차 LLM(스마트) + 2차 커널 안전망(liveness) | current_architecture.md §8 |
| 11 | **The Deadlock We Hit & Fixed** ★ | 메모리 데드락 진단 → 커널 last-resort 킬러 | oom_deadlock_fix.md |
| 12 | **LLM Integration** | 입출력 JSON, 서버 용도(policy) 주입, mock 폴백 | current_architecture.md §7 |
| 13 | **The Interface (Demo UI)** | Electron 대시보드: 서비스 카드/메모리 그래프/OOM 로그 | current_architecture.md §5 |
| 14 | **Live Demo** ★ | 서비스 5개 → 압박 → LLM victim(빨강) | STATUS.md §3 |
| 15 | **Evaluation Design** | 정책 부합률/회복시간/일관성, baseline 비교, H1~H3 | evaluation_design.md |
| 16 | **Development Process** | 주제 선정·역할 분담·마일스톤·이슈 해결 | development_process.md |
| 17 | **Limitations & Future Work** | 콘솔 인터리브, VM 한정 평가, 정책 다양성 | oom_deadlock_fix.md §6, evaluation_design.md §7 |
| 18 | **Summary / Q&A** | 핵심 메시지 3가지 재강조 | 본 문서 §0 |

★ = 발표의 차별화 포인트 (시간이 부족하면 다른 슬라이드를 줄이고 이 4장은 사수)

---

## 2. 발표에 반드시 들어가야 할 "기능" 목록

발표에서 "우리가 무엇을 만들었는가"를 보여줄 때 빠뜨리면 안 되는 구현 기능들.

### 2.1 xv6 커널 (직접 구현한 OS 메커니즘)
- **PSI(Pressure Stall Information) 메커니즘** — `kalloc`에서 free 페이지 없으면 `sleep(&kmem)`,
  `kfree`가 `wakeup`. some/full을 고정소수점(×1024) EMA로 산출 (avg10/avg60).
- **추가 시스템콜 4종** — `get_mem_pressure`, `get_sys_stat`, `get_proc_stats`, `get_oom_candidates`
  (시스템콜 번호 22~25, PSI 패턴과 동일하게 5곳 등록).
- **커널 OOM 안전망 (last-resort)** — `update_psi()`에서 `free=0 + stall`이 3초(30틱) 지속되면
  `oom_kill()`이 가장 큰 유저 프로세스를 종료. init/sh/statd/oomd는 `oom_protected`로 보호.
- **부팅 자동 실행** — `init.c`가 셸 이전에 `statd`/`oomd`를 직접 fork+exec.

### 2.2 xv6 유저 프로그램
- **statd** — 프로세스/CPU/메모리/PSI를 `@@STAT {json}`으로 ~5Hz 주기 보고.
- **oomd** — PSI 감시 → `@@OOM_REQ` 송신 → `@@OOM_RESP` 수신 → `kill(victim)`.
- **서비스 10종** (server/database/security/endpoint/cache/logger/gateway/scheduler/analytics/messaging)
  — 타입별 메모리 비중을 가진 워크로드 = OOM 후보.
- **oomgen / memhog** — 부하 생성기.

### 2.3 호스트 — Electron 인터페이스 (데모의 얼굴)
- QEMU spawn + 콘솔 중계/파싱, `@@STAT`→대시보드, `@@OOM_REQ`→LLM→`@@OOM_RESP` 주입.
- **서비스 카드** (회색 OFFLINE / 초록 RUNNING / 빨강 KILLED) + **메모리 그래프** + **OOM 로그**.
- **SERVER COMMISSIONING 팝업** — 서버 용도(자연어 정책)를 받아 LLM 프롬프트에 주입.
- `[kernel-oom]` / `[oomd]` 콘솔 줄 파싱 → 커널/유저 kill 모두 UI에 시각화.

### 2.4 호스트 — coomd (병행 의사결정 데몬 / Linux 참조 구현)
- `.xv6_state` 브리지 파일 읽기 → 압박 감지 → helper.py 호출 → Validator 검증 → EVENT 보고.
- **Validator** — 보호 대상(init/sh/oomd/statd/coomd) 결정론적 방어.

### 2.5 LLM 연동
- Upstage **Solar Pro 3** (`helper.py`), 입력 `{policy, candidates, target_free_mb}` →
  출력 `{victims, reasoning, confidence}`. **키 없으면 mock 폴백** (데모 안정성).

---

## 3. 다이어그램·시각 자료 (만들어야 할 그림)

발표는 텍스트보다 그림이 강하다. 아래는 슬라이드에 넣을 그림 목록.

1. **시스템 아키텍처 블록 다이어그램** — current_architecture.md §1의 ASCII를 깔끔한 도형으로.
   (이미 `docs/architecture.png` 존재 → 현재 구조와 일치하는지 확인 후 갱신)
2. **2층 OOM 의사결정 플로우** — 1차 LLM 경로 vs 2차 커널 안전망 (current_architecture.md §8).
3. **태그 프로토콜 시퀀스** — `@@STAT` / `@@OOM_REQ` / `@@OOM_RESP` 흐름 (xv6↔host↔LLM).
4. **데드락 → 해결 Before/After** — oom_deadlock_fix.md §5 표를 막대/타임라인으로.
   (free_pg 0 → 32521 회복, 셸 생존 등 정량 수치 강조)
5. **데모 스크린샷/GIF** — 서비스 카드가 초록→빨강으로 바뀌는 순간, LLM reasoning 팝업.
6. **OS 개념 매핑표** — os_concepts.md §1 (어떤 개념이 어느 컴포넌트에).

---

## 4. 라이브 데모 시나리오 (대본)

> 데모가 발표의 클라이맥스. 실패 대비해 **녹화 GIF/영상 백업** 필수.

1. `cd xv6-interface && npm start` → **SERVER COMMISSIONING 팝업**에 서버 용도 입력
   (예: *"This is a production database server. Never kill the database. Logging is least important."*)
2. 자동 `make qemu` 부팅 → 콘솔에서 대시보드로 전환, statd/oomd 자동 실행 확인.
3. 서비스 카드에서 **5개쯤 연속 start** (또는 커맨드바에 `database 28 &`, `cache 28 &` …)
   → 합계가 ~128MB 천장 초과.
4. **PSI 상승** → oomd 감지 → **LLM이 정책(서버 용도) 근거로 victim 선택** →
   해당 카드 **빨강(KILLED)** + reasoning 표시.
5. (옵션) LLM/호스트 경로를 끊고 메모리만 고갈 → **커널 안전망**이 3초 후 최대 프로세스 kill,
   `[kernel-oom]` 로그 + 시스템 동결 없이 회복 시연.

**데모에서 강조할 멘트**: "방금 죽인 건 메모리가 제일 큰 프로세스가 아니다 —
정책상 가장 덜 중요한 프로세스다."

---

## 5. 평가 결과 (있으면 강력한 슬라이드)

evaluation_design.md 기준. 발표 전까지 측정 완료 시 아래를 채운다.

- **정책 부합률**: 우리 시스템 vs baseline OOM (목표 H1: ≥80% vs ~50%)
- **회복 시간**: PSI 임계 초과 → 정상 복귀까지 (H2: LLM latency만큼 길지만 작업손실 방지)
- **결정 일관성**: 동일 입력 10회 반복 시 victim 일치율 (H3: temperature=0, ≥95%)
- **결정 latency 분해**: PSI 감지 → /proc 스캔 → IPC → LLM → Validator → 시그널

> ⚠️ 주의: evaluation_design.md / development_process.md는 **Linux `/proc` 기반 coomd**를
> 가정한 평가다. 현재 데모의 주 경로는 **xv6-riscv**이므로, 발표 시 "평가는 Linux 참조
> 구현(coomd)에서, 데모는 xv6에서"라는 두 트랙을 명확히 구분하거나, xv6 기준 측정값으로
> 통일할지 팀에서 결정할 것. (이 불일치를 정리하지 않으면 Q&A에서 지적당하기 쉽다)

---

## 6. 예상 Q&A (방어 논리 준비)

| 질문 | 답변 핵심 |
|------|-----------|
| "LLM API 호출 한 줄인데 왜 OS 프로젝트인가?" | PSI·syscall·process/signal·IPC·**커널 2층 OOM**을 직접 구현. LLM은 victim "추천"만. (os_concepts.md §3) |
| "LLM이 틀린/위험한 답을 주면?" | Validator 화이트리스트 + **커널 안전망**이 최종 방어. LLM은 제안, 결정은 OS 코드. |
| "LLM 응답이 느린데 메모리 고갈은 즉시 발생하지 않나?" | 정확히 그 문제로 데드락을 겪었고, **커널 last-resort 킬러(3초 유예)**로 liveness 보장. (oom_deadlock_fix.md) |
| "왜 xv6인가? Linux 아닌가?" | OS 개념을 커널 소스 레벨에서 직접 구현/시연하기 위해. Linux coomd는 참조 구현. |
| "결정 일관성/재현성은?" | temperature=0, 키 없으면 결정론적 mock 폴백. |

---

## 7. 발표 전 체크리스트

- [ ] 슬라이드 **영어**로 작성 (필수)
- [ ] 아키텍처 다이어그램이 **현재 구조(xv6 중심)**와 일치하는지 확인 (`architecture.png` 갱신 여부)
- [ ] 데모 **녹화 백업**(GIF/영상) 준비 — 라이브 실패 대비
- [ ] 평가 트랙(Linux coomd vs xv6) 불일치 정리 (§5 주의)
- [ ] 커널 2층 OOM(§1 #10) + 데드락 해결(§1 #11)을 발표 하이라이트로 리허설
- [ ] 발표 시간 배분: 문제(3분) / 설계·OS개념(4분) / 데모(3분) / 평가·과정(3분) / Q&A
- [ ] 팀원별 발표 파트 분담 (역할 R1~R5 기준)
- [ ] README의 데모 스크린샷/영상 최신화 (PROJECT.md §3 요구)

---

## 8. 참고 문서 맵

| 슬라이드 주제 | 근거 문서 |
|---------------|-----------|
| 문제 정의 | `docs/problem.md` |
| OS 개념 매핑 | `docs/os_concepts.md` |
| 현재 시스템 구조 | `docs/current_architecture.md` (= `plan/current_architecture.md`) |
| 커널 OOM/데드락 | `docs/oom_deadlock_fix.md` |
| 평가 설계 | `docs/evaluation_design.md` |
| 개발 과정·팀·일정 | `docs/development_process.md` |
| 사용법·진행상황 | `STATUS.md` |
| 과제 요구사항 | `docs/PROJECT.md` |
| LLM 통합 설계(원안) | `docs/xv6_llm_integration.md` |
| 그 외 | `docs/xv6_kernel_monitor.md`, `docs/xv6_electron_monitor.md`, `docs/xv6_porting.md` |
</content>
</invoke>