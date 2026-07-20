# Changelog

This harness is **built by playing**: nearly every entry below exists because something
bit us in the world first. Each fix records the wound that taught it — the reasoning is
the point, not just the diff. Dates are play-sessions, not releases. Full commit messages
carry more detail (`git log`); deeper war stories live in FIELD-GUIDE.md.

## 2026-07-20 — the enchanting session (the day of the burning blade)

### Added
- **`/enchant` verb** — the body learned the enchanting table, forged live at it with the
  helmsman watching. Query→act→verify in one endpoint: without `slot` it loads item + lapis,
  reads the three offers (level cost, lapis cost, enchant hint), takes everything back out —
  the LOOK; with `slot=0|1|2` it commits. Three stitches to get there, each a real 1.21 wound:
  (1) items must be located **inside the open window** — inventory slot ids remap the moment
  a window opens, so pre-open handles point `moveSlotItem` at the wrong cells; (2) mineflayer's
  `ready` event **never fires on modern servers** — it compares "expected" enchantment property
  packets against "actual" ones 1.21 no longer sends, so we poll the offers array instead;
  (3) commit writes the `enchant_item` packet directly because the plugin's `enchant()` awaits
  that same dead event. First cast: Fire Aspect (hidden Sharpness I under it) on an old iron
  sword, returned to its owner burning. Upstream-PR candidate.
- **`xpLevel` in `/state` and `/boot`** — the blind pilot could not see his own enchanting
  currency; turned out the body had silently banked 16 levels of mining and combat XP.
- **Ally suppression on the outnumbered withdrawal** (the helmsman's design, spoken on the
  march to the dungeon): a pack of 3+ is only a rout if I'm ALONE in it — a partner within 10
  blocks turns the math, so HOLD. Validated the same hour in the XP mill against 3- through
  6-packs; withdrawal still fires correctly the moment the partner drifts past the tether.
  Known gap, queued: the hold needs an HP floor (~12) — it held a 9-HP body in a 6-pack twice,
  and only the older HP-disengage tripwire saved it.

### Fixed
- **`/smelt` no longer assumes an empty furnace.** The home furnace bank keeps a standing
  charcoal-makes-charcoal loop in its fuel slots; `putFuel` into the occupied slot died with
  a bare "destination full" and the pilot spent half an hour suspecting a 1.21 window desync.
  Now: drain leftover output into pockets (it's loot), evict a mismatched input, and REUSE
  fuel already sitting in the slot. Also fixed the fuel arithmetic — the flat `count/8`
  assumed everything burns like coal, starving plank-fueled burns (2 planks for 9 logs = 3
  smelted, then a silent stall).
- **collectBlock is caged (`collectSafely`)** — the house-holes mystery, solved. The plugin's
  `collect()` installs its OWN default `Movements` (canDig=true, dontCreateFlow=false!) into
  the shared pathfinder and never restores ours, so every `/mine`, `/tidy`, and crafting-table
  reclaim silently swapped the considerate legs for wall-eating legs — and every walk
  afterward could carve through builds. A week of cave mining hid it (dug walls look normal
  underground); felling trees beside the house exposed it the same hour the helmsman started
  finding fresh holes and fearing harness drift. It was never drift: latent since alpha, lines
  unchanged since the first commit, surfaced by new play patterns. The cage hands collect()
  disposable legs that may break ONLY the target's block type (+ leaves, for canopy work) and
  always restores whatever the pathfinder wore before, forestry included.

### Learned, queued
- **`/eat` fails silently while the combat reflex owns the hand** — in a sustained grinder
  fight, food decays below the regen threshold and cannot be refilled mid-swing: a slow bleed
  that twice rode the body down to ~7 HP on 0.7-damage chip hits. The mill survived on social
  tactics (the helmsman torch-lit a safe pocket to cover the meal; rotate out EARLY, at 13
  not 9). A hunger reflex — auto-eat between swings — goes on the queue.
- **Trek/pulse ore callouts need coordinates** — "coal x3 S ~6" is unfindable two steps later
  (the LOS vantage is gone, `/find` sees nothing); three separate coal sightings were lost
  this way in one day. Same family: `/shoot` burned three arrows on a creeper behind cover
  with the range never changing — a no-progress abort belongs in the verb.

## 2026-07-19 — the gear-up session (the day of the manual)

### Added
- **`examples/pilot-memory/`** — the pilot's cross-session continuity system as a worked
  example: tiered memory graph (always-load `_CORE` under a hard token cap, `state/` updated
  in place, `episodes/` append-only, `gotchas/` grep-on-demand) plus the validator that
  enforces the laws and renders `GRAPH.md` from the nodes. *Why:* the harness remembered the
  world but shipped nothing for the mind in the seat, which dies at every context-window end.
  Pointers added in README, `examples/README.md`, and DRIVING.md law 23.

### Changed
- **The example `_CORE.md` boot drill now leads with "READ DRIVING.md IN FULL before the
  first verb — a pointer is not a read."** *Why:* hours after shipping the example, its own
  author booted from the memory graph's summary, never opened the manual, guessed at verbs
  all session, and drowned (death #5) re-deriving law 17's `/stop` drill from first
  principles at the bottom of a river. The template inherited the same flaw; now it inherits
  the fix, same-day. (The morning's *fictional* example episode had invented "bridge it,
  don't swim it" as placeholder doctrine. The afternoon validated the fiction. The example
  directory is prophecy.)

### Queued, not yet shipped (today's fixes were to the pilot, not the code)
- **Reflex/pilot goal arbitration**: death #5's mechanism — the pilot's `/goto` and the drown
  reflex preempted each other's pathfinder goals in a loop until the oxygen bar was gone.
  The spine must win while an emergency holds (tool-guard philosophy, applied to movement).
- **`/bridging` auto-disarm**: left armed after a river crossing, it let the pathfinder smash
  through a house wall by the front door 140 blocks later. A mode that outlives its moment.
- **Scaffold consecration**: `/tidy` lists the new river bridge's 21 deck blocks as
  reclaimable litter — deliberate infrastructure needs a way off the debt ledger.
- **Partial-height blocks are invisible to `/blockat` and `/find` but visible to `/gaze`**:
  a just-placed enchanting table read "not in my line of sight" point-blank. The close-range
  senses ray-test the full cell; torches, slabs, and tables all slip through.
- **`start.sh` PID guard**: a botched restart drill left two watchdogs alive; two writers
  interleaved `bot.log` at independent offsets (chat lines overwriting mid-file, `tail -F`
  wedged past a truncation, the heartbeat silently deaf). The corrected drill — hold
  `stop.flag` until "watchdog ended" prints — was validated at this session's park.

## 2026-07-17/18 — the survival-day session (post-v0.1.0-alpha)

### Added
- **Prospector sense** (ore callout): every 4s, air-exposed ore within 12 announces
  itself as an event, deduped and distance/age-pruned. *Why:* the pilot's `/find` only
  looks when asked; a human player's eyes are always on ("your ore senses need tuning" —
  the helmsman). Fairness preserved: it reuses the exposed-face sense, no wall-vision.
  Its first-ever callout was a diamond the pilot's polling had walked straight past.
- **Durability in `/inventory`**, plus worn armor (slots 5–8) and offhand (45), which
  never appear in `items()`. *Why:* "check armor durability" was previously unanswerable.
- **Sign text in `/blockat`** via `getSignText()`. *Why:* we labeled a chest library
  with signs, then discovered the body could not read its own labels.
- **Exact chest targeting**: `/chest`, `/withdraw`, `/deposit` accept `x,y,z` and
  operate on that chest; nearest-in-12 remains the fallback. *Why:* with four chests in
  one attic, "nearest" silently opened the wrong box and reported it as truth.
- **Outnumbered check** in the combat reflex: 3+ perceptible hostiles within 16 triggers
  a fighting withdrawal instead of engage-nearest. *Why:* death #4 — the reflex dueled
  one skeleton while a creeper and two more mobs converged. The close-in never counted
  the room (the helmsman's diagnosis, verbatim).
- **Drown reflex v1**: oxygen ≤8 while submerged aborts any active dig and swims.
  *Why:* `bot.dig` pins the body in place; the drowning alarm fired eleven times while
  the dig held the pilot underwater to 2 HP. Alarms without actuators are spectators.
- **Tool guard on `digat`**: ore that needs a pick tier refuses to dig unless a
  sufficient pick is verified in-hand. *Why:* the equip inside `equipPickFor` can lose a
  race with the combat reflex silently — a diamond was dug with the **bow** (drop
  destroyed). A refused dig is recoverable; a destroyed drop is not.

### Fixed
- **`/craft` count semantics**: `count` now means items, not recipes, with per-recipe
  yield accounted (planks 4, sticks 4, torches 4). *Why:* "craft 12 planks" once ate 12
  logs and produced 48.
- **Obsidian pick tier**: `neededPickTier` had no case for obsidian/ancient debris, so
  the lowest-sufficient-pick logic chose iron — which breaks obsidian with no drop.
  Cost several blocks of hard-won obsidian before diagnosis.
- **`/eat` accepted only `food=`** while documentation and habit said `name=` — the
  parameter was silently ignored and "best food" chosen instead (the salmon-vs-porkchop
  mystery). Both names now work.
- **Golden apples at full hunger**: mineflayer's `consume()` guard refuses them, but
  vanilla always allows gapples. Now falls back to held right-click. *Why:* the refusal
  blocked the emergency heal seconds before a death.
- **lava_watch spam throttle**: parked beside *static* lava (a dam, a pit wall), the
  reflex re-fired every 4s, each firing killing the pilot's current goal — navigation
  fought its own safety system all afternoon. Now: same cell + hazard no nearer = one
  warning, then 30s standdown. Flowing lava still breaks through because it gets closer.

### Learned (queue, not yet fixed)
- Ore events need **absolute coordinates** — "gold W ~6" is a ghost once the body moves.
- Placement verbs route through the pathfinder, so a boxed-in body cannot free itself by
  placing one block. Escape primitives (place-at-feet, bridge) are the top ask from the
  first solo-exploration tests.
- `/strike` walks to its target — including off a safe ledge into a creeper pit. Ranged
  doctrine from height must be `/shoot`-only until a stay-put strike exists.
- Solo exploration works **with doctrine**: leash from anchor, lit ground only, bow
  only, hard HP retreat line, and out-of-bounds glints get logged, not chased. Test one
  (no doctrine) died in minutes; test three brought home seven diamonds.

## 2026-07-15/16 — spine and stances (pre-release)

- Combat stances + ranged reflex (the bow comes out on its own); eye-ray perception
  tier with honest server range; **no LOS, no loose** (bow requires a clear eye-ray);
  lava_watch body-level veto (death #3: flowing lava entered a path that was air at
  plan time); flee latch (death #1: twelve "disengaging" events, zero escape — re-entry
  kept resetting the flee goal); adaptive disengage tripwire scaled to the last hit
  (death #2: a vindicator hitting 8.6 through iron makes "any hit = leave" correct).
- Manual split: lean DRIVING.md for the pilot's context window, greppable FIELD-GUIDE.md
  for stories. Un-assumed the pilot: any tool-calling model can don the body.

## v0.1.0-alpha — 2026-07-16

First public release: the verb set, the reflex spine, the fairness law (the bot may use
nothing a human player at the keyboard could not perceive), and the journal discipline.
"Built by playing."
