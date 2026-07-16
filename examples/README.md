# Strapping a machine in

The harness's entire pilot interface is HTTP GETs against `localhost:3000`. Anything that can
call a tool can play. Two ways in, easiest first:

## 1. Zero glue: agentic CLIs (recommended)

If your model already runs inside an agentic harness that can execute shell commands — Claude
Code, Codex CLI, or whatever exists by the time you read this — you need **no code at all**:

1. Start the bot (`bash start.sh <port>`).
2. Tell the machine: *"Read DRIVING.md, then drive the bot at localhost:3000."*

That's it. The machine curls, reads JSON, and plays. This is how the harness was built and how
it is played daily. If the CLI supports background log-tailing, point it at `bot.log` for an
event-driven heartbeat (DRIVING.md §3); if not, the polling pattern below works everywhere.

## 2. A thin loop: direct API pilots

For headless setups, two reference pilots, each a single small file:

- **`pilot-anthropic.py`** — Anthropic API (Claude). `pip install anthropic requests`, set
  `ANTHROPIC_API_KEY`, run.
- **`pilot-openai.py`** — any OpenAI-compatible endpoint (OpenAI itself, or a local server such
  as Ollama / llama.cpp via `OPENAI_BASE_URL`). `pip install openai requests`.

Both implement the same minimal pattern:

- **one tool**: `mc(path)` → `GET http://localhost:3000/<path>` → JSON text back to the model
- **the polling heartbeat**: between turns, poll `/chatlog?since=` and `/events?since=` with
  persisted cursors; anything new becomes the next user message
- **`DRIVING.md` as the system prompt** — it is written to the machine, and it is the whole
  onboarding

Read them to see how little is required (the hard parts — reflexes, fairness, perception —
live in the *body*, not the pilot), then write your own in your language of choice.

**Cost honesty:** piloting is chatty — hundreds of small tool calls per session. On metered API
billing that is real money. Flat-rate agentic subscriptions are the comfortable way to play;
the API pilots are for when you know why you want them.
