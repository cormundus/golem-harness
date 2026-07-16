#!/usr/bin/env python3
"""Minimal reference pilot: any OpenAI-compatible endpoint driving the Claudiverse harness.

    pip install openai requests
    export OPENAI_API_KEY=...                 # or your local server's token
    export OPENAI_BASE_URL=...                # optional: Ollama / llama.cpp / vLLM etc.
    export OPENAI_MODEL=gpt-5.2               # whatever your endpoint serves
    python pilot-openai.py

Same shape as pilot-anthropic.py: one mc(path) tool, a polling heartbeat, DRIVING.md
as the system prompt. The hard parts live in the body (bot.js); the pilot stays thin.
"""
import json
import os
import pathlib
import time

import requests
from openai import OpenAI

BOT = os.environ.get("BOT_URL", "http://localhost:3000")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.2")
DRIVING = (pathlib.Path(__file__).parent.parent / "DRIVING.md").read_text(encoding="utf-8")

SYSTEM = (
    "You are piloting a Minecraft bot body through the HTTP API described in the manual "
    "below. You perceive and act ONLY through the mc tool. Play fairly, honestly, and "
    "sociably; when a player talks to you in chat, answer via /chat.\n\n---\n\n" + DRIVING
)

TOOLS = [{
    "type": "function",
    "function": {
        "name": "mc",
        "description": "Call the bot's HTTP API. Pass the path+query WITHOUT the host, e.g. "
                       "'scene' or 'goto?x=10&y=64&z=-3'. Returns the JSON response as text.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
}]


def mc(path: str) -> str:
    try:
        r = requests.get(f"{BOT}/{path.lstrip('/')}", timeout=60)
        return r.text[:8000]
    except requests.RequestException as e:
        return json.dumps({"ok": False, "error": f"harness unreachable: {e}"})


def heartbeat(cursors: dict) -> str:
    out = []
    for kind in ("chatlog", "events"):
        try:
            r = requests.get(f"{BOT}/{kind}?since={cursors.get(kind, 0)}", timeout=10).json()
            cursors[kind] = r.get("cursor", cursors.get(kind, 0))
            items = r.get("messages") or r.get("events") or []
            out += [json.dumps(i) for i in items]
        except requests.RequestException:
            pass
    return "\n".join(out)


def main() -> None:
    client = OpenAI()
    cursors: dict = {}
    heartbeat(cursors)  # swallow history; listen from now
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content":
         "You just woke up in the body. Call mc('boot'), get situated, say hello in chat, "
         "then play. I'll relay chat/events as they arrive."},
    ]

    while True:
        resp = client.chat.completions.create(model=MODEL, messages=messages, tools=TOOLS)
        msg = resp.choices[0].message
        messages.append(msg.model_dump(exclude_none=True))

        if msg.tool_calls:
            for call in msg.tool_calls:
                path = json.loads(call.function.arguments).get("path", "")
                messages.append({"role": "tool", "tool_call_id": call.id, "content": mc(path)})
            continue

        if msg.content:
            print(f"\n[pilot] {msg.content}\n")
        news = ""
        while not news:
            time.sleep(3)
            news = heartbeat(cursors)
        messages.append({"role": "user", "content": f"[heartbeat]\n{news}"})

        # context hygiene: keep system + a clean tail (never start the tail on a tool message)
        if len(messages) > 120:
            tail = messages[-80:]
            while tail and tail[0].get("role") in ("tool", "assistant"):
                tail.pop(0)
            messages = [messages[0]] + tail


if __name__ == "__main__":
    main()
