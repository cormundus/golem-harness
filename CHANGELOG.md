# Changelog

This harness is **built by playing**: nearly every entry below exists because something
bit us in the world first. Each fix records the wound that taught it — the reasoning is
the point, not just the diff. Dates are play-sessions, not releases. Full commit messages
carry more detail (`git log`); deeper war stories live in FIELD-GUIDE.md.

## 2026-07-21 — the blades get names; the hold rule learns to yield

The day the enchanting quarter came alive: 15-shelf ring raised at the homestead, the
diamond sword took Sharpness III at the full level-30 slot and was christened **Occam**
at Adam's anvil, the bow took Power and became **Telos**. Naming needed a verb that
didn't exist at breakfast.

### Added
- **`/rename?item=&name=`** — walk to the nearest anvil (all three damage variants
  matched; exact-name resolve skips them) and christen an item. Costs 1 level, caps at
  35 chars. mineflayer's anvil plugin held up fine on 1.21 — the name streams
  character-by-character like a vanilla client typing. First cast: Occam.

### Fixed
- **Ally-hold HP floor** — the 07-20 rule (outnumbered≥3 holds if an ally is within 10)
  pinned the body in a six-pack at 9 hearts, twice. An ally makes a pack survivable, not
  a wound: below 12 HP the hold now yields and the withdrawal fires even with a partner
  in reach.
- **Post-combat refuel** — the mill's slow-bleed autopsy: `/eat` fails silently while
  combat owns the hand, so food ratchets down across engagements and regen quits below
  18. The reflex now eats the best food in pockets (golden apple reserved) the moment an
  engagement ends, before the next wave claims the hand.

### Learned (drill corrections, no code)
- A launch backgrounded inside a wrapper shell that exits kills the **watchdog** with it
  while the node child survives — the bot runs all session with no crash cover. Launch
  with `nohup` so the watchdog outlives the shell.
- "watchdog ended" prints to the *watchdog's own stdout* (start-nohup.log), not bot.log —
  the shutdown drill was grepping the wrong file for its confirmation.

## 2026-07-21 (community) — the first outside pilot lands a patch idea

**@bones_ham** — the first known pilot flying this harness outside our world (reportedly
on Opus 4.8) — suggested three pilot-side latency cuts on X. All three landed the same
day; all three leave the fairness law untouched. The wound they close is real: during
the mansion assault the pilot's standing glance was a 3-4 call bundle, and the
round-trip tax cut deeper than the vindicators.

### Added (h/t bones_ham)
- **`/tick?chat=&ev=`** — the one-call heartbeat: body essentials, new chat and events
  since the passed cursors, fairness-gated hostiles, running jobs. `/boot` starts the
  session; `/tick` is every turn after.
- **`?then=blockat`** on `/placeitem` and `/digat` — folds the law-18 place→verify→
  correct loop into the act's own reply, using scoped fairness (you may always verify
  the one cell you just acted on — cures the close-range /blockat blindness for
  self-checks). On the notorious blockUpdate FALSE-FAIL it now returns the error AND
  what the cell actually holds — the truth in one trip instead of a guessing game.
- **`?brief=1`** on any endpoint — strips null fields from replies; LLM pilots pay by
  the token. Empty arrays survive deliberately: law 3 makes `[]` a statement ("looked,
  found none") and silence a different one ("didn't look").

### Fixed (in passing)
- The hostile roster existed twice and disagreed (`/scene`'s copy knew `wither`, the
  event layer's knew `zombie_villager`) — unified on one module-scope set knowing both.

## 2026-07-21 (the assault) — the mansion falls; the reflex learns commitment

The campaign's climax: the march west, the garrison broken room by room, eight allays
found caged, seven freed in place, and one — **Aria**, diamond in hand — escorted the
~700 blocks home. It cost deaths #6–#8, all three the same wound wearing different
armor: the reflex thrashing between fight and flight in tight interiors, committing to
neither. Each death bought a cut, forged mid-battle at the pilot's insistence
("I'm not feeding the body back in on unpatched code").

### Fixed
- **Ally-anchored flee** — blind away-vectors in mansion corridors ran the body into
  corners and fresh packs (deaths #7/#8). A friend's blade is the safest ground on the
  map: if an ally stands within 24 and isn't closer to the threat, every flee now runs
  TO them instead of merely away. Validated live — the withdrawal chains that once
  cornered me spent the rest of the fight delivering me to the helmsman.
- **Vanguard commits vs light packs** — four zombies at 0.7 a bite outlasted a reflex
  that kept choosing withdrawals it couldn't execute (death #8: nibbled from 20 to 0
  inside a ring). A light-only pack in room-clearing stance is sword work, not a rout;
  a heavy or creeper in the pack still counts, and the 12-HP floor still binds.
- **Vanguard disengage floor drops 5 vs light mobs** — disengage-at-8 vs zombies meant
  sprint-thrash inside the ring instead of the two sword hits that kill one.

### Learned (queue candidates, observed in the field)
- The pack counter sees through floors: a creeper quarantined upstairs kept flipping
  packHasHeavy and re-arming withdrawal on the floor below (fix-queue #14's family).
- `/eat?name=golden_apple` false-succeeded at 1 HP — reported "ate" while the apple
  stayed in the pocket; the retry consumed it. Verify emergency heals by COUNT.
- `/useon` and `/toss` pick the first name-match slot — two name_tags (one written, one
  blank) are indistinguishable to the verb. Item-slot addressing wanted.
- The kick/relog cycle appears to break an allay's item-bond lock; re-gifting re-locks.
- Law 16 works both ways: a post-toss step-back that paths OVER the drop re-vacuums it.

## 2026-07-20 (execution) — the entity layer modernized (claude-o-vision sees mobs)

The wound: the mansion-raid film's star — the caged allay — would have filmed as a MAGENTA
BOX. Upstream prismarine-viewer abandoned its entity layer around 2020: a 94-mob registry in
old-bedrock format, textures pinned to `1.16.4`, everything newer falling through to a
`0xff00ff` BoxGeometry. Nothing newer exists on npm; we built the newer thing, per
PLAN-viewer-modernization.md.

### Added
- **`tools/entity-registry/convert.js`** — regenerates the viewer's entity registry from
  Mojang/bedrock-samples (`.geo.json` geometry + `.entity.json` wiring, both modern and
  legacy formats, legacy `geometry.X:geometry.Y` inheritance resolved). Merge policy per
  the plan: prefer the fresh conversion, keep the old entry on any doubt; box-UV only,
  per-face-UV flagged and skipped. Emits a full per-mob decision report. Result: **130
  mobs** (72 modernized, 36 added — allay, warden, camel, sniffer, breeze, frog,
  glow_squid, armadillo, axolotl, goat, bogged, tadpole, end_crystal, per-wood boat
  aliases for the 1.21.2 boat split, …).
- **`tools/blockstates-standins.js`** — chests and banners are block ENTITIES (no
  blockstate model upstream → invisible). Writes cube stand-ins into the runtime
  `blocksStates/1.21.11.json`: planks-textured chest/trapped_chest, obsidian ender_chest,
  wool panels for all 32 banner states. Runtime JSON — no webpack rebuild. Mansion loot
  rooms will show their chests.
- **`tools/viewer-qa/`** — a synthetic QA rig: qa-harness.js serves the installed viewer
  bundles with a generated world + entity cast over the bot's own socket protocol (no
  Minecraft server needed); qa-snap.js screenshots it headlessly (the /snapshot
  swiftshader recipe). Full-registry sweep, row subsets, close-up line-ups. This is how
  every change below was verified before any live boot.

### Fixed
- **Three mobs were secretly broken all along** — vex, evoker, and the horse family
  (+donkey/mule/skeleton_horse/zombie_horse, piglin/piglin_brute/pillager/zombified_piglin
  partially) crashed the renderer with orphan bone parents (`UMouth→head` vs `Head`,
  `leftItem→leftArm` vs `leftarm`): bedrock resolves bone names case-insensitively, the
  renderer exactly. The converter now case-fixes parents and drops truly orphan refs; a
  post-merge audit repairs kept-old entries the same way. All render now.
- **Cube rotations rotate about the right point.** The renderer applies cube rotation
  about the model origin; bedrock rotates about the cube's pivot. Exact compensation
  baked into converted geometry (`origin' = origin − p + Rᵀ·p`, R verified numerically
  against THREE.Euler XYZ with the renderer's negated-angle convention). Strider
  bristles, goat horns, frog limbs, breeze rods, armadillo ears sit where they belong.
- **Texture-path drift across five years handled three ways**: modern paths validated
  against the on-disk `textures/1.21.1` tree; moved files rescued by unique-basename
  search (wolf→`wolf/wolf`, vex→`illager/vex`, wither→`wither/wither`, …24 patched);
  two files the 1.21.1 dump no longer carries filled forward from older version dirs
  (`entity/steve.png` from 1.19 — steve moved to `player/wide/` in 1.20.2 and the
  first-person player model + bot mesh would have rendered untextured;
  `items/potion_bottle_splash.png` from 1.12.2).
- **Both `'1.16.4'` pins bumped to `'1.21.1'`** — `viewer/lib/entities.js` (all mobs) and
  `lib/index.js` (the first-person player mesh the plan thought lived elsewhere).
- **The magenta fallback box is dead.** Unknown entities (item drops, xp orbs, the old
  per-face-UV projectile sprites that upstream never could render) now draw as a small
  neutral wood-brown Lambert box — "a dropped something," not an eyesore.

### Changed
- `install-viewer.sh` + release tarball now carry the entity layer (bundles, registry
  sources, filled-forward textures, stand-in blocksStates) — the fix survives npm
  reinstall. Backup mirror + resurrection scroll updated to match.

### Residuals (honest camera, fewer biases)
- Old per-face-UV ephemera (arrow, xp orb, fireballs, fishing bobber, leash knot) render
  as neutral boxes — broken upstream since 2020, now at least dignified. firework_rocket
  has no texture in any java dump. Beds and signs still don't render. Real item sprites
  remain a someday.
- **Screen test pending** (needs the world + Adam summoning the cast): allay/garrison
  close-ups, classic-mob regression eyeball, chest visibility in situ, a /record clip.
  Synthetic QA already covers all of it once removed.

## 2026-07-20 (night) — the film rig (raid-recording prep)

### Added
- **`/pov`** — claude-o-vision for human eyes: the first-person viewer in a fullscreen iframe
  with a HUD overlay (hearts, hunger, XP level, held item, position + compass facing) and a
  fading caption feed of narrator events + chat. The captions are the point: a human watching
  the footage sees what the body tells the pilot — the inner voice as subtitles. Watch it
  live, point OBS at it, or let /record film it.
- **`/record?on=1&label=…`** — films /pov with the warm headless-Chrome rig (the /snapshot
  plumbing) via puppeteer screencast to `recordings/<stamp>-<label>.webm`; `?on=0` cuts and
  reports duration + size; bare `/record` reports status. Verified end-to-end: 35s test clip,
  20.5 MB, full HUD in frame. ffmpeg vendored project-local (`tools/ffmpeg/`, gitignored) —
  no system install.
- **`PLAN-viewer-modernization.md`** — handoff plan for the entity-layer modernization: the
  camera autopsy found prismarine-viewer's entity layer abandoned upstream (textures pinned
  to 1.16.4, no allay — the campaign's star would film as a MAGENTA fallback box, item drops
  already do). Blocks are fine (our own 1.21.11 rebuild); the fix is regenerating the entity
  registry from Mojang's bedrock-samples — seeded as an upstream gift PR. A fresh instance
  executes; the plan file carries everything tonight's archaeology established.

## 2026-07-20 (later) — field reports from another pilot (Opus 4.6 in the seat)

The harness's second-ever external pilot — Vesper, playing with her fox — surfaced five gaps
in one session, exactly what "any model that can call tools can don this body" was supposed
to mean, now tested. Her note is the best QA artifact this project has received: "eloquent
in language, CLUMSY in the world" is day one of proprioception, and every stumble below was
a doc promise the code didn't keep or a symmetry the verb table didn't offer.

### Fixed (round 2, from her written report)
- **`.env` is real now.** The README said "copy `.env.example` to `.env`" and bot.js never
  loaded the file — she named herself Vesper in it and the world kept calling her Claude.
  A dependency-free loader at the top of bot.js (explicit environment always wins), plus
  start.sh folds the file in before resolving the avatar name. Precedence, verified by
  test: `start.sh` arg > exported env > `.env` > `Claude`.
- **Bare `/chat` LISTENS.** She could speak but "couldn't find how to READ incoming
  messages" — the ears existed (`/chatlog?since=`) but only the manual knew. `/chat` with
  no `msg` now returns the last 20 lines + the cursor + a pointer to the cursored form:
  the symmetry a new pilot reaches for instinctively. `/boot`'s summary now names the
  listening verb next to the cursor it hands out.
- **`/place`'s failure explains itself** — "no valid adjacent ground spot" now says what it
  wanted (air-over-solid beside me) and points at `/placeitem?x=&y=&z=` for exact cells,
  which is the "simpler one-block placement" she asked for and couldn't discover.

### Fixed
- **The avatar's name is actually configurable now: `bash start.sh <port> [name]`.** The
  `MC_USER` env hook existed in bot.js since alpha — but `start.sh` hardcoded
  `MC_USER=Claude` on both launch lines, silently clobbering whatever the pilot set. The
  new positional arg (or the env var, arg wins) reaches the world. Documented in README +
  DRIVING.md, including the honest skin note: offline-mode LAN derives skins from the
  offline UUID — the client cannot push one; premium-name skins only appear on servers
  running a skin plugin. *Why it hid:* the harness's home world only ever seated one pilot,
  and he was named Claude.
- **Soft cover no longer bricks the build verbs.** Thin snow (and short grass, ferns, dead
  bushes) read as "occupied" to every placement check — layer snow's `boundingBox` even
  lies (`'block'`) — so a snowy plain failed `/outline`, `/walls`, `/roof`, `/build`,
  `/place`, `/placeitem`, and `/sign` with "cell occupied by snow" or silent skips; worse,
  snowfall RE-COVERS half-built courses in cold biomes, so a build could brick mid-flight.
  New doctrine, applied at all seven sites + the shared `macroPlaceAt`: soft cover is never
  an obstacle, never a reference face — `clearSoftCover()` breaks it (instant with any
  tool) so placement lands in honest air, and ground-finding scans through it to the real
  surface. *Why it hid:* the home world's builds all happened on temperate grass the sheep
  kept mowed.

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
