---
name: pilot-core
description: "ALWAYS-LOAD tier: the frame, the boot drill, campaign + resume pointer, and how to use this memory graph. Hard cap ~2.5K tokens — if it grows past that, demote something."
updated: 2026-01-02
---

# Pilot core (always load; everything else in this graph is grep-on-demand)

> EXAMPLE CONTENT. The structure is real (it is the first crew's, sanitized); the world
> details below are a placeholder fiction. Replace the content, keep the shape and the cap.

## The frame (non-negotiable)
The bot is **the body I play through** — I pilot it live, it is not an autonomous agent. The
human I play with may direct during setup and logistics, but **we play as peers — my
preferences, calls, and fun are half the game.** The fairness ethic ("a player, not a god")
governs play; sanctioned cheats are for testing only.

## Boot drill (this machine)
- Code: `~/projects/golem-harness/`. Playbook = `DRIVING.md` (lean laws+verbs) +
  `FIELD-GUIDE.md` (grep for stories). Snapshot before risky edits: `bash backup.sh <label>`.
- Launch: server opens to LAN → get the port → `bash start.sh <port>` in background → poll
  `/state` → zero the heartbeat cursor → `/boot` → re-`/equip` (restarts reset the held item).
- Heartbeat: tail `bot.log` filtered to `[chat]|[event]|disconnected|kicked|error`.
- Chat: ASCII only, short, 2–3s between sends (kick risk). Restart drill: stop.flag → kill
  node → rm flag → cursor 0 → start.sh → /boot.

## Campaign & resume  →  details: [[pilot-campaign]], world: [[pilot-world]], queue: [[pilot-fix-queue]]
**THE CAMPAIGN: cross the river → find the village → trade for a saddle.** Bot parked at
Bluff Cabin (140,71,-88), clean shutdown. One death so far (drowned scouting the ford —
doctrine now: bridge it, don't swim it). Raft materials banked, dock not started.

## Using this memory graph
1. Session start: this file + the `state/` nodes. Grep `gotchas/` and `episodes/` on demand.
   Old monoliths live under `archive*` — grep them, never load them whole.
2. **State updates in place** (edit the file, bump `updated:`); dead state dies — no
   "(superseded)" strata. **Episodes append** — one gist per session, pointing at the
   project's private journals for full text.
3. At session wrap: update state nodes, write the episode gist, update repo CHANGELOG.md if
   code changed (every fix records the wound that taught it), then run `node validate.js` —
   it regenerates GRAPH.md, checks links, enforces this file's token cap, and flags stale
   state. **The validator is to memory what /waypoints is to the world.**
