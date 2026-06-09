# 환경 설정 & 실행 가이드 (SETUP)

> LLM 기반 OOM 킬러를 **xv6-riscv(QEMU)** 위에서 시연하는 프로젝트의 설치·실행 매뉴얼.
> 시스템 전체 구조는 [`docs/current_architecture.md`](docs/current_architecture.md), 개념 설명은 [`README.md`](README.md) 참조.

---

## 1. 시스템 구성 요약

```
xv6 (QEMU, -m 128M)                호스트 (Linux / WSL2)
 ├ statd  → "@@STAT {json}"   ──▶   QEMU stdio 중계자
 └ oomd   → "@@OOM_REQ"       ──▶    ├ A) Electron 인터페이스 (주 경로)
            "@@OOM_RESP" 주입  ◀──    └ B) CLI: monitor.py / relay.py
                                          │
                                          └▶ LLM (Upstage Solar) ── coomd / helper.py
```

호스트에서 **셋 중 하나**의 실행 경로를 선택합니다.

| 경로 | 도구 | 용도 |
| --- | --- | --- |
| **A. Electron 인터페이스** | `xv6-interface/` | 주 데모. xv6 + LLM OOM + 대시보드 GUI |
| **B-1. 커널 대시보드(CLI)** | `coomd/host/monitor.py` | GUI 없이 top 형태 텍스트 대시보드 |
| **B-2. LLM 릴레이(CLI)** | `coomd/host/relay.py` | GUI 없이 xv6 ↔ LLM OOM 연동만 |

---

## 2. 사전 요구사항 (의존성)

**플랫폼:** Linux (Ubuntu 22.04+) 또는 WSL2. macOS/Windows 네이티브는 미지원.

| 도구 | 최소 버전 | 확인 명령 | 설치 (Ubuntu/WSL) |
| --- | --- | --- | --- |
| riscv64 크로스 GCC | 13.x | `riscv64-linux-gnu-gcc --version` | `sudo apt install gcc-riscv64-linux-gnu` |
| QEMU (riscv64) | **≥ 7.2** | `qemu-system-riscv64 --version` | `sudo apt install qemu-system-misc` |
| GCC (호스트) | 13.x | `gcc --version` | `sudo apt install build-essential` |
| GNU Make / bc | — | `make --version` | `sudo apt install make bc` |
| Python | 3.10+ | `python3 --version` | `sudo apt install python3 python3-venv python3-pip` |
| Node.js + npm | 20.x | `node -v` | `sudo apt install nodejs npm` (경로 A만 필요) |

> 한 줄 설치:
>
> ```bash
> sudo apt update && sudo apt install -y \
>   gcc-riscv64-linux-gnu qemu-system-misc build-essential make bc \
>   python3 python3-venv python3-pip nodejs npm
> ```

---

## 3. 빌드

### 3-1. xv6 커널 (QEMU 이미지)

```bash
cd xv6-riscv
make clean && make qemu   # 빌드 후 바로 부팅까지 됨 — 종료: Ctrl-A 그다음 X
```

> 단독 부팅 확인용입니다. 실제 데모에서는 호스트 중계자(경로 A/B)가 `make qemu`를 대신 띄우므로 여기서 종료해도 됩니다.
> 부팅되면 `statd`, `oomd`, 서비스 프로세스들이 자동 실행되고 콘솔에 `@@STAT {...}` 스트림이 흐릅니다.

### 3-2. coomd C 데몬 (호스트 측 모니터/판단기)

```bash
cd coomd
make            # 산출물: coomd/bin/coomd
```

### 3-3. Python LLM Helper

```bash
cd coomd
python3 -m venv .venv            # 권장: 프로젝트 전용 venv
source .venv/bin/activate
pip install -r requirements.txt  # openai, python-dotenv
```

> 인터페이스/데몬은 `coomd/.venv/bin/python3` → 시스템 `python3` 순으로 인터프리터를 찾습니다.

### 3-4. Electron 인터페이스 (경로 A를 쓸 때만)

```bash
cd xv6-interface
npm install
```

---

## 4. LLM(Upstage Solar) 설정

OOM victim 선택에 Upstage Solar API를 사용합니다.

```bash
cd coomd
cp .env.example .env
# .env 를 열어 본인 키 입력:
#   UPSTAGE_API_KEY=up_xxxxxxxxxxxxxxxxxxxxxxxx
```

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `UPSTAGE_API_KEY` | (필수) | Upstage Solar API 키 |
| `UPSTAGE_BASE_URL` | `https://api.upstage.ai/v1` | API 엔드포인트 |
| `LLM_MODEL` / `UPSTAGE_MODEL` | `solar-pro2` | 사용할 모델 |
| `OOM_POLICY` | (코드 기본 정책) | LLM에 전달할 자연어 정책 |
| `OOM_ENGINE` | `python` | `python`(helper.py) / `llm`(JS fetch) / `heuristic` |

> ⚠️ `.env`는 **절대 커밋 금지** (`coomd/.gitignore`에 포함). 키가 없으면 helper가 mock 모드로 fallback 합니다.

---

## 5. 실행

> 어떤 경로든 호스트 중계자가 `xv6-riscv/`에서 `make qemu`를 자동으로 띄웁니다. xv6를 따로 실행해 둘 필요 없습니다.

### 경로 A — Electron 인터페이스 (주 데모)

```bash
cd xv6-interface
npm start            # 디버그 로그: npm run start:dev
```

동작: QEMU 부팅 → `@@STAT` 파싱 → 대시보드 렌더 → 메모리 압박 시 `@@OOM_REQ` → LLM victim 선택 → `@@OOM_RESP` 주입 + `coomd` 병렬 모니터 카드 표시.
시작 시 "서버 용도" 팝업에 입력한 내용이 모든 OOM 판단에 정책으로 반영됩니다.

### 경로 B-1 — 커널 대시보드 (GUI 없이)

```bash
cd coomd/host
python3 monitor.py    # top 유사 텍스트 대시보드 (~1Hz 갱신)
```

### 경로 B-2 — LLM OOM 릴레이 (GUI 없이)

```bash
cd coomd/host
python3 relay.py      # @@OOM_REQ → LLM → @@OOM_RESP 자동 응답, 그 외 콘솔 통과
```

### (선택) coomd 데몬 단독 실행

인터페이스가 `coomd/.xv6_state` 브리지 파일을 쓰는 동안 별도로:

```bash
cd coomd
./bin/coomd --dry-run --threshold 15
```

| 플래그 | 기본값 | 설명 |
| --- | --- | --- |
| `--dry-run` | — | 실제 SIGTERM 안 보내고 판단만 보고 (데모 권장) |
| `--threshold <pct>` | `15` | PSI some_avg10 임계값(%) |

> coomd가 보는 후보는 **xv6(QEMU) 내부** 프로세스라 호스트에서 직접 kill할 수 없습니다. 실제 종료는 xv6의 `oomd`가 수행하므로 coomd는 항상 `--dry-run`(병렬 판단기)으로 돕니다.

---

## 6. 데모 시나리오 (메모리 압박 유발)

xv6 콘솔에서 메모리 호그를 띄워 OOM 경로를 트리거합니다:

```text
$ memhog 100      # 약 100 페이지씩 점유하며 압박 발생 → oomd/LLM 작동
```

압박이 임계값을 넘으면 LLM이 정책에 따라 victim(예: `memhog`)을 선택하고, `init`/`sh`/`oomd`는 보호됩니다.

---

## 7. 종료 / 정리

| 대상 | 방법 |
| --- | --- |
| QEMU(xv6) | 콘솔에서 `Ctrl-A` → `X` |
| Electron | 창 닫기 또는 터미널 `Ctrl-C` |
| monitor.py / relay.py | `Ctrl-C` |
| 빌드 산출물 정리 | `cd coomd && make clean`, `cd xv6-riscv && make clean` |

---

## 8. 트러블슈팅

| 증상 | 원인 / 해결 |
| --- | --- |
| `Couldn't find a riscv64 version of GCC` | 크로스 툴체인 미설치 → `sudo apt install gcc-riscv64-linux-gnu` |
| `Need qemu version >= 7.2` | QEMU 구버전 → 7.2+ 설치 |
| LLM 응답이 mock으로 나옴 | `coomd/.env`의 `UPSTAGE_API_KEY` 누락/오류 |
| `electron: not found` | `cd xv6-interface && npm install` 안 함 |
| helper.py `ModuleNotFoundError: openai` | venv 미활성 또는 `pip install -r requirements.txt` 안 함 |
| 대시보드가 안 뜨고 `@@STAT` 원문만 보임 | xv6에서 `statd`가 안 돌고 있음 → 커널 재빌드(`make clean && make qemu`) |
