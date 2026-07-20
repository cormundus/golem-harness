---
name: pilot-chat-echo-quirk
description: "The world-owner's own /give, /tp, /weather command feedback echoes into /chatlog as if THEY said it — don't misread server feedback as their words."
updated: 2026-01-02
---

(This one is real, not fiction — it will bite your crew too if a human plays alongside with
operator permissions.)

Server command feedback echoes into `/chatlog` attributed to the human's username — e.g.
`"Teleported Claude to <owner>]"` arrives as a chat line "from" them. It's the server speaking
through their session, not them talking. Tell them apart by register: bracket-heavy,
grammatical-object phrasing = command feedback. A gotcha node exists because this misread once
produced a very confused in-game conversation.
