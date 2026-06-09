# Conversational OOM Killer — Technical Report

> Direction B — LLM for OS · 운영체제 팀 프로젝트
> LLM Backend: Upstage Solar Pro

---

## 1. 환경 설정 및 실행 방법

본 프로젝트는 세 개의 독립 컴포넌트로 구성된다. 각 컴포넌트는 따로 빌드·실행할
수 있다.

| 컴포넌트 | 위치 | 역할 |
|---------|------|------|
| **xv6-riscv 커널** | `xv6-riscv/` | PSI·프로세스 모니터링을 구현한 교육용 커널 (QEMU에서 구동) |
| **coomd 데몬 + LLM Helper** | `coomd/` | 리눅스 유저스페이스 OOM Killer (C 데몬 + Python Solar 클라이언트) |
| **xv6-interface** | `xv6-interface/` | Electron 기반 시연 UI (xv6 구동·콘솔·모니터링 대시보드) |

> **권장 OS**: Ubuntu 22.04 (또는 WSL2 Ubuntu). 아래 명령은 Debian/Ubuntu 계열
> 기준이며, riscv 툴체인과 QEMU가 필요하다.

---

### 1.1 사전 요구사항 (공통)

```bash
# 빌드 도구 · QEMU · RISC-V 크로스 툴체인
sudo apt-get update
sudo apt-get install -y \
    git build-essential gdb-multiarch \
    qemu-system-misc \
    gcc-riscv64-linux-gnu binutils-riscv64-linux-gnu

# Python (LLM Helper용) · Node.js (Electron UI용)
sudo apt-get install -y python3 python3-pip nodejs npm
```

버전 확인:

```bash
qemu-system-riscv64 --version     # 7.2 이상 권장
riscv64-linux-gnu-gcc --version
python3 --version                 # 3.8 이상
node --version                    # 18 이상 권장
```

> WSL2를 쓰는 경우 위 패키지는 모두 WSL(리눅스) 안에 설치한다. Electron UI도
> WSL 안에서 실행하는 것을 전제로 한다(`make`/`qemu`/툴체인이 리눅스에 있어야
> 하기 때문).

---

### 1.2 xv6-riscv 커널 단독 실행

가장 기본이 되는 커널 구동이다. QEMU 위에서 xv6를 부팅한다.

```bash
cd xv6-riscv

make qemu          # 커널 + 유저 프로그램 빌드 후 QEMU 부팅
```

부팅이 끝나면 xv6 셸 프롬프트(`$`)가 뜬다. 모니터링/시연용 프로그램 실행 예:

```
$ statd &          # 커널 상태(프로세스·CPU·메모리·PSI) 주기적 수집
$ memhog 100       # 메모리 압박 유발 (테스트용)
$ ls               # 일반 셸 명령
```

**QEMU 종료**: `Ctrl-a` 를 누른 뒤 `x`.

기타 유용한 타깃:

```bash
make clean         # 빌드 산출물 정리
make qemu-gdb      # GDB 디버깅용으로 부팅 (별도 터미널에서 gdb-multiarch 접속)
make CPUS=1 qemu   # 단일 코어로 부팅 (디버깅 시 권장)
```

---

### 1.3 coomd 데몬 + LLM Helper (리눅스 OOM Killer)

리눅스 유저스페이스에서 실제로 동작하는 Conversational OOM Killer이다.

**(1) API 키 설정** — Upstage Solar API 키를 `.env`에 둔다.

```bash
cd coomd
cp .env.example .env
# .env 파일을 열어 UPSTAGE_API_KEY 값을 채운다
#   UPSTAGE_API_KEY=up_xxxxxxxxxxxxxxxx
```

**(2) Python 의존성 설치**

```bash
pip install -r requirements.txt        # openai 패키지 (Solar API 호환)
# 외부 관리 환경 오류가 나면:
# pip install -r requirements.txt --break-system-packages
```

**(3) C 데몬 빌드**

```bash
make                # daemon/*.c 컴파일 → bin/coomd 생성
```

**(4) 실행**

```bash
# 안전한 시연 모드 (실제 종료 대신 시뮬레이션)
./bin/coomd --dry-run --threshold 15

# 실제 동작 모드 (검증된 victim에 SIGTERM 전송)
./bin/coomd --threshold 15
```

실행 인자:

| 인자 | 의미 |
|------|------|
| `--policy <경로>` | 사용자 자연어 우선순위 정책 파일 (생략 시 내장 기본 정책) |
| `--dry-run` | 실제 시그널을 보내지 않고 동작만 로그로 출력 |
| `--threshold <%>` | PSI some_avg10 임계치 (기본 15%) |

> C 데몬이 내부적으로 `python3 LLM_client/helper.py`를 자식 프로세스로 띄워
> Solar API에 victim 선택을 질의한다. 따라서 (1)·(2) 단계가 선행되어야 한다.

---

### 1.4 xv6-interface (Electron 시연 UI)

xv6 구동, 콘솔 입출력, 실시간 모니터링 대시보드를 하나의 화면에서 제공한다.

```bash
cd xv6-interface

npm install         # 최초 1회 (electron 등 의존성 설치)
npm start           # 앱 실행 → 전체화면 HUD
```

- 앱이 내부적으로 xv6를 빌드·부팅하고, 콘솔/메트릭 패널을 표시한다.
- 화면 하단 입력창에 xv6 셸 명령을 입력할 수 있다(예: `statd &`, `memhog 100`).
- **종료**: `Esc` 또는 `Ctrl+Q`.

> 이 UI도 리눅스(WSL 포함) 환경에서 실행해야 한다 — `make`/`qemu`/riscv 툴체인이
> 호스트에 설치돼 있어야 xv6를 빌드·구동할 수 있기 때문이다.
> LLM 기능을 쓰려면 `coomd/.env`(또는 루트 `.env`)에 `UPSTAGE_API_KEY`가 있어야
> 한다.

개발 모드(로그 활성화)로 실행하려면:

```bash
npm run start:dev
```

---

### 1.5 빠른 시작 요약

```bash
# 0) 사전 요구사항 설치 (1.1)

# A) 커널만 빠르게 보고 싶다면
cd xv6-riscv && make qemu            # 종료: Ctrl-a x

# B) 리눅스 OOM Killer 데몬
cd coomd
cp .env.example .env                 # UPSTAGE_API_KEY 입력
pip install -r requirements.txt
make
./bin/coomd --dry-run --threshold 15

# C) 통합 시연 UI (권장)
cd xv6-interface && npm install && npm start
```

---

## 2. 문제 정의

<!-- TODO: docs/problem.md 요약 — 리눅스 OOM Killer가 사용자 의도를 모른 채
oom_score만으로 victim을 고르는 문제 -->

## 3. 시스템 아키텍처

<!-- TODO: docs/architecture.md 참조 — PSI 감지 → /proc 수집 → LLM victim 선택
→ 안전성 검증 → 시그널 전송 흐름, xv6 포팅 설계 -->

## 4. 구현 상세

<!-- TODO: xv6 커널(PSI/syscall, plan/psi_changed.md), coomd 데몬, LLM Helper,
Electron UI 각 컴포넌트 구현 설명 -->

## 5. OS 개념 활용

<!-- TODO: docs/os_concepts.md 참조 — 메모리 관리/PSI, /proc 인트로스펙션,
fork+exec IPC, 시그널, sleep/wakeup 등 -->

## 6. 평가

<!-- TODO: docs/evaluation_design.md 참조 — baseline vs coomd 비교 시나리오/지표 -->

## 7. 결론

<!-- TODO: 요약 및 향후 과제 (xv6 실제 포팅, semihosting 채널 등) -->
