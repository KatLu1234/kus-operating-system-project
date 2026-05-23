#!/usr/bin/env python3
"""
helper.py — Conversational OOM Killer의 LLM Helper (R3)

역할:
  C 데몬(coomd)이 이 스크립트를 자식 프로세스로 띄우고,
  stdin(표준 입력)으로 "후보 프로세스 목록 + 사용자 정책"을 JSON으로 보낸다.
  이 스크립트는 그 정보를 Upstage Solar API에 전달해서
  "어떤 프로세스를 죽일지(victim)"를 추천받고,
  결과를 stdout(표준 출력)으로 JSON 한 줄로 돌려준다.

사용법:
  echo '{...JSON...}' | python3 helper.py
  (C 데몬은 pipe로 이 입출력을 주고받는다)

입력 형식 (stdin, JSON 한 줄):
  {
    "policy": "I'm coding. Never kill VS Code. Browser tabs are fine to kill.",
    "candidates": [
      {"pid": 9999, "comm": "chrome", "cmdline": "/usr/bin/chrome", "rss_kb": 1245000, "uid": 1000, "ppid": 2000},
      ...
    ],
    "target_free_mb": 500
  }

출력 형식 (stdout, JSON 한 줄):
  {"victims": [9999], "reasoning": "...", "confidence": 0.9}
"""

import sys
import os
import json

# .env 파일에서 API 키를 자동으로 읽어온다.
# (python-dotenv가 설치돼 있으면 사용, 없으면 그냥 환경변수에서 읽음)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ──────────────────────────────────────────────────────────
# 설정
# ──────────────────────────────────────────────────────────
API_KEY = os.environ.get("UPSTAGE_API_KEY")  # .env 또는 환경변수에서 읽음
BASE_URL = "https://api.upstage.ai/v1"
MODEL = "solar-pro"   # ← 모델이 안 맞으면 이 한 줄만 바꾸세요 (예: "solar-pro2")


# ──────────────────────────────────────────────────────────
# (1) 시스템 프롬프트 — AI에게 "너의 역할은 이거다"라고 설명
# ──────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are an OOM (Out-Of-Memory) victim selector for a Linux system.

You are given:
1. A user's natural-language priority policy.
2. A list of candidate processes (with pid, comm, cmdline, rss_kb).
3. A target amount of memory to free (target_free_mb).

Your job: choose which process PIDs to terminate so that the system frees
enough memory, while strictly respecting the user's policy.

RULES:
- NEVER select PID 1, systemd, sshd, dbus-daemon, or any obvious system process.
- Honor the user policy. If the policy says "never kill X", do not select X.
- Prefer killing processes the user marked as low-priority or "fine to kill".
- Free enough memory to meet target_free_mb when possible.

You MUST respond with ONLY a JSON object, no other text:
{"victims": [pid, ...], "reasoning": "short explanation", "confidence": 0.0~1.0}
"""


# ──────────────────────────────────────────────────────────
# (2) 진짜 Solar API를 호출하는 함수
# ──────────────────────────────────────────────────────────
def ask_solar(policy, candidates, target_free_mb):
    """Solar API에 물어봐서 victim 결정을 받아온다."""
    from openai import OpenAI  # Solar는 OpenAI SDK와 호환됨

    client = OpenAI(api_key=API_KEY, base_url=BASE_URL)

    # AI에게 보낼 사용자 메시지 구성
    user_message = json.dumps({
        "policy": policy,
        "candidates": candidates,
        "target_free_mb": target_free_mb,
    }, ensure_ascii=False)

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0,  # 같은 입력엔 같은 답 (재현성)
        response_format={"type": "json_object"},  # JSON으로만 답하도록 강제
    )

    content = response.choices[0].message.content
    return json.loads(content)


# ──────────────────────────────────────────────────────────
# (3) API 키가 없을 때 쓰는 가짜(mock) 함수
#     — 키 없이도 흐름을 테스트할 수 있게 해줌
#     — 정책 텍스트에 프로세스 이름이 들어있으면 그걸 보호/타겟으로 판단
# ──────────────────────────────────────────────────────────
def ask_mock(policy, candidates, target_free_mb):
    """API 키가 없을 때 쓰는 가짜(mock) LLM.

    주의: 이건 진짜 LLM이 아니라 '흐름 확인용' 임시 로직이다.
    정책의 의미를 진짜로 이해하지는 못하고, 단순히
    '시스템 프로세스를 뺀 나머지 중 메모리를 가장 많이 쓰는 것'을 고른다.
    실제 정책 기반 선택은 API 키를 넣으면 Solar가 제대로 해준다.
    """
    always_safe = ("systemd", "init", "sshd", "dbus-daemon")
    victims = []

    for c in candidates:
        pid = c.get("pid")
        name = c.get("comm", "").lower()
        # 시스템 프로세스는 무조건 제외
        if name in always_safe or pid == 1:
            continue
        victims.append((c.get("rss_kb", 0), pid))

    # 메모리 많이 쓰는 순으로 정렬, 가장 큰 1개 선택
    victims.sort(reverse=True)
    chosen = [pid for _, pid in victims[:1]]

    return {
        "victims": chosen,
        "reasoning": "[MOCK MODE — 가짜 응답] API 키가 없어 정책을 해석하지 못함. "
                     "시스템 프로세스를 제외하고 메모리를 가장 많이 쓰는 프로세스를 선택함. "
                     "실제 정책 기반 선택은 UPSTAGE_API_KEY를 .env에 넣으면 동작함.",
        "confidence": 0.3,
    }


# ──────────────────────────────────────────────────────────
# (4) 메인 — stdin으로 받고, 처리하고, stdout으로 돌려줌
# ──────────────────────────────────────────────────────────
def main():
    # stdin에서 한 줄(JSON) 읽기
    raw = sys.stdin.readline()
    if not raw.strip():
        print(json.dumps({"victims": [], "reasoning": "empty input", "confidence": 0.0}))
        return

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"victims": [], "reasoning": f"invalid JSON: {e}", "confidence": 0.0}))
        return

    policy = data.get("policy", "")
    candidates = data.get("candidates", [])
    target_free_mb = data.get("target_free_mb", 500)

    # 키가 있으면 진짜 Solar 호출, 없으면 mock으로 폴백
    try:
        if API_KEY:
            result = ask_solar(policy, candidates, target_free_mb)
        else:
            result = ask_mock(policy, candidates, target_free_mb)
    except Exception as e:
        # 진짜 호출이 실패해도 시스템이 안 멈추게 mock으로 폴백
        result = ask_mock(policy, candidates, target_free_mb)
        result["reasoning"] = f"[FALLBACK] Solar 호출 실패({e}), mock 사용. " + result.get("reasoning", "")

    # 결과를 stdout으로 JSON 한 줄 출력 (C 데몬이 이걸 읽음)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
