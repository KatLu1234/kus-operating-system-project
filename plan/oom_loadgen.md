# [계획서] 랜덤 메모리 부하 생성기(oomgen) + 서버 용도 기반 LLM OOM 결정

## 1. 개요
실제 서버 환경처럼 **여러 종류의 메모리 소비 프로세스**(서버, 데이터베이스, 보안
모듈, 엔드포인트 모듈 등)를 띄워 놓고, **메모리 부족(PSI)이 감지될 때까지 랜덤으로
프로세스를 계속 생성**한다. 그리고 인터페이스 시작 시 **서버의 용도를 팝업으로 입력**
받아, OOM kill을 LLM으로 결정할 때 그 용도를 **함께 전송**하여 정책 기반 판단을
하게 한다.

이는 기존 메커니즘(`statd` 모니터, `oomd` OOM 오케스트레이터, `@@OOM_REQ`/
`@@OOM_RESP` LLM 연동)을 그대로 재사용하며, 두 가지를 추가한다.
1. **부하 생성기**(xv6 user space)
2. **서버 용도 팝업 + LLM 프롬프트 주입**(Electron 인터페이스)

## 2. 구성 요소

### 2.1 시험용 서비스 프로세스 10종 (`user/*.c` + `user/service.h`)
실제 서버 스택을 흉내 낸 10개의 서비스 바이너리. 각각 독립 바이너리라 **프로세스
테이블에 자기 이름으로** 표시된다.

| 바이너리 | 의미 |
|---------|------|
| `server` | 프런트 웹/애플리케이션 서버 |
| `database` | 데이터베이스 엔진 |
| `security` | 보안 모듈 |
| `endpoint` | 엔드포인트 모듈 |
| `cache` | 캐시 계층 |
| `logger` | 로깅 데몬 |
| `gateway` | API 게이트웨이 |
| `scheduler` | 잡 스케줄러 |
| `analytics` | 분석 워커 |
| `messaging` | 메시지 큐 |

공통 본체는 `user/service.h`의 `service_main()` 하나로 구현한다.
- `argv[1]` = 점유할 메모리(MB)
- `malloc` 후 **모든 페이지를 touch**하여 물리 메모리를 실제로 소비(커널 모니터/PSI에
  반영됨)
- 죽기 전까지 메모리를 쥔 채 `pause()`로 대기

### 2.2 랜덤 부하 생성기 (`user/oomgen.c`)
- xv6에 `rand()`가 없으므로 **LCG PRNG**를 `uptime()`로 시드
- 루프: `get_sys_stat`/`get_mem_pressure`로 상태 확인 →
  - **PSI some-pressure가 임계치 이상**이거나 free RAM이 안전 바닥 밑이면 **중단**
  - 아니면 10종 중 **랜덤 서비스**를 **랜덤 크기(4~12MB)**로 `fork`+`exec`
- 메모리 부족이 감지되면 멈추고, 띄운 서비스들은 **init에 reparent되어 계속 생존**
  → `oomd`가 LLM 판단으로 희생자를 고르도록 남겨둔다
- 실행: `$ oomd &` 후 `$ oomgen`

### 2.3 서버 용도 팝업 (`index.html` / `styles.css` / `renderer.js`)
- 앱 기동 시 **중앙 모달**(터미널풍, 글로우 그린 테두리)로 "이 서버의 용도"를 입력
  받음. 프리셋 버튼 + 자유 입력 + INITIALIZE/skip
- 입력값은 `preload`의 `setPurpose` 브리지를 통해 메인 프로세스로 전달·저장

### 2.4 LLM 프롬프트에 용도 주입 (`main.js`)
- 저장된 `serverPurpose`를 OOM 결정 경로 **양쪽 모두**에 주입:
  - Python helper 경로: `policy`에 용도 문장 결합 + `server_purpose` 필드 추가
  - JS fetch(Solar) 경로: system 프롬프트에 용도 규칙 + user JSON에 `server_purpose`
- 따라서 `@@OOM_REQ` → 결정 시 LLM이 **서버 용도에 맞춰** 보호/희생을 판단

## 3. 동작 흐름
```
[인터페이스 기동] ─팝업─► 서버 용도 입력 ─setPurpose─► main.js(serverPurpose 저장)
        │
[xv6] $ statd &   (자동 주입됨)        → 대시보드에 실제 메모리/PSI
      $ oomd &                         → PSI 감시
      $ oomgen                         → 랜덤 서비스 생성(메모리↑)
        │
메모리 부족 → PSI some↑ → oomd가 @@OOM_REQ(후보 목록) 전송
        │
main.js: 후보 + [서버 용도] → LLM → victim 결정 → @@OOM_RESP
        │
oomd: 검증 후 kill(victim) → 메모리 회복 → PSI 하강
```

## 4. 변경/추가 파일
| 파일 | 내용 |
|------|------|
| `xv6-riscv/user/service.h` | 서비스 공통 본체(메모리 점유) — 신규 |
| `xv6-riscv/user/{server,database,security,endpoint,cache,logger,gateway,scheduler,analytics,messaging}.c` | 서비스 10종 래퍼 — 신규 |
| `xv6-riscv/user/oomgen.c` | 랜덤 부하 생성기 — 신규 |
| `xv6-riscv/Makefile` | `UPROGS`에 11개 등록 |
| `xv6-interface/index.html` | 서버 용도 팝업 마크업 |
| `xv6-interface/styles.css` | 팝업 스타일 |
| `xv6-interface/preload.js` | `setPurpose` 브리지 |
| `xv6-interface/main.js` | `serverPurpose` 저장 + LLM 프롬프트 주입 |
| `xv6-interface/renderer.js` | 팝업 로직 |

## 5. 설계상 유의점
- **OOM 감지 기준**: PSI는 EMA라 지연이 있으므로, oomgen은 PSI 임계치와 free-page
  바닥을 함께 본다. 실제 stall(=`kalloc` 잠듦)이 발생해야 PSI가 오르고 `oomd`(10%)가
  발화한다.
- **보호 대상**: `oomd`/validator가 init·sh·oomd 등을 보호. 서버 용도 문장으로
  "database/security는 보호" 같은 의미를 주면 LLM이 우선 반영.
- **프로세스 슬롯**: `NPROC=64` 한도. oomgen은 `fork` 실패 시 즉시 중단.
- **이름 표시**: 서비스를 개별 바이너리로 둔 이유는 `exec`가 proc 이름을 파일명으로
  설정하기 때문(대시보드 가독성).