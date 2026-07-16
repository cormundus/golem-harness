# Mindcraft salvage — what we took, kept, deferred, and skipped

Record of the 2026-07-07 "stop reinventing the wheel" pass. We researched the LLM-Minecraft
field, concluded our **piloted-over-curl** harness is the right shape for our goal ("it's about
having *Claude* play" — a bot I pilot in-session, not an autonomous API-loop agent), and decided to
**cannibalize parts from [Mindcraft](https://github.com/kolbytn/mindcraft), not adopt it as a base.**

## Why not just adopt Mindcraft
Mindcraft is a mature, model-agnostic autonomous agent (you give it an API key, it loops and runs
itself). That's a different *product* from ours: it replaces the player (me) with a called API. Our
whole point is a bot a human-operated Claude pilots over the terminal, no API meter. Adopting it would
cost us that ergonomic **and** our two genuinely-novel bits (fairness/anti-x-ray, which even Voyager
calls a *feature*; and the considerate `canDig=false` nav). So: steal, don't marry.

## ✅ TAKEN — built 2026-07-07 (syntax + load-clean; live-test pending a world)
- **Connection hardening** (`mcdata.js` → our `createBot` block): 50ms position-packet throttle
  (prevents anti-cheat kicks from pathfinder movement spam), `PartialReadError` swallow (prevents a
  common protocol-desync crash), `checkTimeoutInterval: 60000`. Pure plumbing — only reorders outbound
  packets, fairness/LOS untouched.
- **`mineflayer-armor-manager`** plugin — auto-equips best armor. No-op on Peaceful.
- **`/eat?food=`** — MANUAL eating (we deliberately did NOT take auto-eat; food is the pilot's job).
  Equips named/most-filling food, consumes, restores prior held item.
- **`/craft` table logistics** — searches 16 blocks and walks to a table (fixes the "table nearby:
  false" bug from range), and if none exists, places one from inventory and **reclaims it after** (tidy-style).
- **Reflex scheduler + `unstuck` + `/reflexes`** — always-on node-process reflex loop (~300ms, zero
  model calls). `reflexes[]` list, `reflexFire()` with an `active` guard, `startReflexes()` in spawn.
  `unstuck` watches ONLY for pathfinder wedging (gated on `isMoving()`, so it never touches slow
  mining); on a >10s stall it opens an adjacent door/gate/trapdoor or breaks the wedge and emits a
  `[reflex]` line the Monitor tails (wakes the pilot). `/reflexes` lists/toggles.

## 🛡️ KEPT OURS (rejected Mindcraft's version)
- **`canDig=false` considerate nav.** Mindcraft's `goToGoal` uses `canDig=true` + expensive dig/place
  costs with a destructive fallback — which never dead-ends but **reintroduces terrain-tunneling** (the
  "crow's path" we objected to). Ours already worked (swam the river, gathered, deposited, zero holes),
  and the reach-problem was solved by `GATHER_MAX_RISE`. So we keep `canDig=false`. The soul stays intact.

## ⏳ DEFERRED — for the survival ramp (slot into the reflex scheduler)
- **Combat/survival reflexes** from `modes.js`: `self_preservation` (water-bucket-on-fire, jump-when-
  drowning, flee-at-low-HP — needs a `bot.on('health')` handler for `lastDamageTime`), `self_defense` &
  `cowardice` (fight vs flee; creeper/phantom kiting) — need `mineflayer-pvp`. `torch_placing` /
  `item_collecting` — cheap MAYBEs.

## 🔮 STILL ON THE MENU (not yet taken; from the recon)
- **In-process reconnect**: take Mindcraft's `parseKickReason()` classifier (retryable vs fatal) and
  build the backoff supervisor they lack (they `process.exit` — the anti-model for a piloted session).
- `goToGoal`'s **dig-progress guard** (abort on unharvestable block); `collectBlock` edge cases
  (safeToBreak + obsidian-near-lava, liquid-source+bucket, mustCollectManually, NoChests-full);
  `smeltItem` fuel-math + 11s no-progress timeout; `placeBlock` recovery (break-in-way, multi-face,
  self-reposition); the **`interrupt_code`** cooperative-cancel across our macros.

## ⏭️ SKIPPED (wrong for a piloted bot)
- **`coder.js` / `!newAction`** — the LLM-writes-and-runs-its-own-code loop. *I'm* the code author.
  (Cherry-pick only its interrupt-injection trick if we ever let a piloting Claude author reflexes live.)
- **Process-exit reconnect** — kills the piloting session; we want in-process. **Villager trading,
  `goToBed`/`stay`** — out of scope.

*Recon source: `kolbytn/mindcraft` `src/agent/{modes,agent,action_manager,connection_handler,coder}.js`
+ `src/agent/library/{skills,world}.js` + `src/utils/mcdata.js`.*
