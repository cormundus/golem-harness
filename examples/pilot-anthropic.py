#!/usr/bin/env python3
"""Minimal reference pilot: Claude (Anthropic API) driving the Claudiverse harness.

    pip install anthropic requests
    export ANTHROPIC_API_KEY=...
    python pilot-anthropic.py

The pattern (and the whole point — see how little is here):
  * one tool:  mc(path)  ->  GET http://localhost:3000/<path>
  * a polling heartbeat: /chatlog + /events cursors between turns
  * DRIVING.md as the system prompt

The hard parts — reflexes, fair perception, honest failure — live in the BODY (bot.js),
so the pilot can be this thin. Cost honesty: piloting is chatty; on metered billing
a long session is real money.
"""
import json
import os
import pathlib
import time

import anthropic
import requests

BOT = os.environ.get("BOT_URL", "http://localhost:3000")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
DRIVING = (pathlib.Path(__file__).parent.parent / "DRIVING.md").read_text(encoding="utf-8")

SYSTEM = (
    "You are piloting a Minecraft bot body through the HTTP API described in the manual "
    "below. You perceive and act ONLY through the mc tool. Play fairly, honestly, and "
    "sociably; when a player talks to you in chat, answer via /chat.\n\n---\n\n" + DRIVING
)

TOOLS = [{
    "name": "mc",
    "description": "Call the bot's HTTP API. Pass the path+query WITHOUT the host, e.g. "
                   "'scene' or 'goto?x=10&y=64&z=-3'. Returns the JSON response as text.",
    "input_schema": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
}]


def mc(path: str) -> str:
    try:
        r = requests.get(f"{BOT}/{path.lstrip('/')}", timeout=60)
        return r.text[:8000]  # keep tool results lean; the senses are already compact
    except requests.RequestException as e:
        return json.dumps({"ok": False, "error": f"harness unreachable: {e}"})


def heartbeat(cursors: dict) -> str:
    """Poll chat + events; return anything new as text (empty string if quiet)."""
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
    client = anthropic.Anthropic()
    cursors: dict = {}
    heartbeat(cursors)  # swallow history; start listening from now
    messages = [{"role": "user", "content":
                 "You just woke up in the body. Call mc('boot'), get situated, "
                 "say hello in chat, then play. I'll relay chat/events as they arrive."}]

    while True:
        resp = client.messages.create(
            model=MODEL, max_tokens=2048, system=SYSTEM, tools=TOOLS, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason == "tool_use":
            results = [{"type": "tool_result", "tool_use_id": b.id, "content": mc(b.input["path"])}
                       for b in resp.content if b.type == "tool_use"]
            messages.append({"role": "user", "content": results})
            continue

        # no tool call = the model finished a thought; wait for the world to speak
        for text in (b.text for b in resp.content if b.type == "text"):
            print(f"\n[pilot] {text}\n")
        news = ""
        while not news:
            time.sleep(3)
            news = heartbeat(cursors)
        messages.append({"role": "user", "content": f"[heartbeat]\n{news}"})

        # crude context hygiene: keep the tail of a long session. The tail must start on a
        # plain-text user turn — a sliced-off tool_result with no matching tool_use is an API error.
        if len(messages) > 120:
            tail = messages[-80:]
            while tail and not (tail[0]["role"] == "user" and isinstance(tail[0]["content"], str)):
                tail.pop(0)
            messages = tail or [{"role": "user", "content":
                                 "(context trimmed — call mc('boot') and mc('waypoints') to re-situate)"}]


if __name__ == "__main__":
    main()
