### phase 1. 수요일 데모 준비 단계

목표: 개별 모듈이 완벽히 합쳐지지 않았더라도, 동작 흐름을 시연할 수 있는 가짜 구동부(Mock Stub)를 포함하여 빌드되는 실행 파일 확보.

상세 액션:

Makefile 완성 및 경고 플래그(-Wall -Wextra)를 완벽히 통과하는 빌드 라인 정비.

getopt_long을 활용해 --policy, --dry-run, --threshold 등의 실행 인자 파싱 처리 구현 완료.

validator.c 개발: /proc/PID/comm 파일을 파싱하여 필수 시스템 데몬(ssh, systemd, dbus 등) 및 자기 자신의 PID를 안전하게 검사하는 핵심 보안 코드 하드코딩.

R3(LLM 담당자)과 데이터 교환 포맷(JSON Schema) 최종 슬랙 박기 완료.

### Phase 2. R1 / R2 C 모듈 물리 결합 

목표: 시뮬레이션 목업 데이터를 지우고, R1의 헤더 파일과 R2의 라이브러리 오브젝트 파일을 빌드 시스템에 온전히 수용.

상세 액션:

R1 담당자가 짠 psi_monitor.c 파일 컴파일 연동 및 메모리 임계치 이벤트 감지 연계 확인.

R2 담당자가 완성한 proc_reader.c 모듈 연계: 디렉토리 순회 및 /proc/[PID]/status 파싱 결과를 정교한 C 구조체 배열(Candidates)에 주입하는 부분 통일.

C 구조체 배열 내부의 문자열 NUL 변환 오류 및 좀비 프로세스 스캔 예외(ENOENT) 핸들러 결합 점검.

### Phase 3. R3 Python Helper 프로세스 fork-exec-pipe 파이프라인 

목표: fork() 및 pipe(), dup2() 시스템 콜을 활용해 Python 헬퍼와의 프로세스 간 양방향 통신(IPC) 완성.

상세 액션:

양방향 통신을 위한 파이프 2조 구축 (pipe(fd1), pipe(fd2)).

fork() 후 자식 프로세스에서 dup2를 이용하여 stdin/stdout 방향 재설정.

execlp("/usr/bin/python3", ...)를 실행하여 로컬 .venv 상의 llm_client.helper 호출 인터페이스 수립.

구조체 데이터를 한 줄짜리 JSON 직렬화(Serialization) 문자열로 가공하는 가벼운 C String Builder 구현.

파이프 흐름이 막히지 않도록 미사용 파일 디스크립터(File Descriptor)들의 즉각적인 close() 규칙 정밀 적용.

### Phase 4. 시그널 처리 고도화 및 최종 안정성 평가

목표: 팀 프로젝트 최종 빌드 완성, 평가 시나리오 검증, 예외 상황에 대처하는 비동기식 시그널 안전 핸들러 탑재.

상세 액션:

안전한 시그널 종료 유도를 위한 Dispatcher 로직 구현: 대상 프로세스에 먼저 SIGTERM을 전달한 후, 1~2초간 반응 대기 후 응답이 없을 시 강력한 SIGKILL을 분사하여 강제 종료 유도.

syslog(3) 연계: 데몬의 동작을 /var/log/syslog에 명확하게 남기는 안전한 시스템 로깅 도입.

성능 평가 세션 참여: 메모리 누수 프로그램(stress-ng)을 가동했을 때, LLM이 정책을 읽어 윈도우 크롬 탭 등을 정확히 죽이고, 시스템은 완벽히 생존하는 연속성 검증 테스트 진행.

4. R4가 가져갈 주요 운영체제(OS) 개념 매핑

R4는 이 프로젝트에서 리눅스 시스템 프로그래밍의 핵심 개념을 거의 대부분 소화합니다. R5(문서화 담당자)가 작성할 학술 보고서에도 해당 도식이 주도적으로 기재될 예정입니다.

사용 기술 / 시스템 콜

타겟 사용 영역

담당 모듈

주요 예외 상황

getopt_long

데몬의 초기 정책 위치 및 드라이런 등 제어 매개변수 주입

R4 메인 로더

잘못된 입력 옵션 예외 처리

/proc/[PID]/comm

실행 중인 프로세스의 커널 상 이름 획득 및 비교

R4 Validator

대상 프로세스가 순간적으로 종료 시 에러 억제

fork() / exec()

가볍게 동작하는 Python 에이전트를 데몬의 수족으로 실행

R4 <-> R3 IPC

경로 탐색 실패, 가상환경 인터프리터 경로 예외

pipe() / dup2()

직렬화된 JSON 데이터를 자식 프로세스의 I/O와 동기화

R4 <-> R3 IPC

입출력 버퍼링 문제로 파이프가 멈추는 현상(Flush 필수)

kill(2)

통과된 최종 대상 PID에 안전/강제 종료 시그널 전파

R4 Dispatcher

권한 문제(EPERM, 반드시 sudo로 구동), 존재하지 않는 PID(ESRCH)

5. R3(LLM 담당자)과의 즉각적 합의점

우리는 stdin/stdout 기반으로 통신하므로, 줄바꿈(\n) 단위로 깔끔하게 파싱되는 JSON 한 줄을 교환 규격으로 합의합니다.

🔹 (입력) C Daemon -> Python Helper (1줄 JSON 스트림)

{
  "policy": "VS Code 보호해줘. 메모리 터지면 크롬 브라우저 프로세스들을 1순위로 희생해줘.",
  "candidates": [
    {"pid": 1052, "comm": "code", "rss_kb": 1540200, "uid": 1000},
    {"pid": 2981, "comm": "chrome", "rss_kb": 892000, "uid": 1000},
    {"pid": 1, "comm": "systemd", "rss_kb": 4096, "uid": 0}
  ],
  "target_free_mb": 500
}


🔹 (출력) Python Helper -> C Daemon (1줄 JSON 스트림)

{
  "victims": [2981],
  "reasoning": "Chrome은 사용자 정책상 sacrifice 1순위로 동의되었으며, systemd는 시스템 생존을 위해 제외함.",
  "confidence": 0.95
}
