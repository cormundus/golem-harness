# FIELD-GUIDE.md — the long-form companion

**This is the verbose companion to [DRIVING.md](DRIVING.md)** — the full narrative: why each law
exists, worked examples, techniques, and field lessons written in the water and the sawdust.
**Do not load this whole file into context.** DRIVING.md is the manual you load; this is the
reference you `grep` when you hit something specific (water trouble, chat kicks, build placement,
the sound table) and want the story and the details behind the rule.

The bot runs at **`http://localhost:3000`** (the "doing layer"). A live first-person view is at
**`http://localhost:3001`** (the "seeing layer", a browser page you can't read but a human watching can).
Everything you do is a `curl` GET against the doing layer.

**Launching:** `bash start.sh <LAN port>` (run it in the background) — kills stale processes, resets
the chat cursor, launches with a crash **watchdog** (auto-relaunch + an `[event] reborn` line so your
log Monitor wakes you; `touch stop.flag` to end it). Then call **`/boot`** for the full situation.

**The body protects itself while you think.** Your reaction time is seconds-to-minutes, so the bot's
reflexes buy you that time: any damage **freezes all action** (`[event] hurt`), water current and
drowning alarm on their own, a nearly-broken tool warns (`[event] wear`), death stamps a `lastdeath`
waypoint. When an alarm wakes you: read it, `/scene`, then decide — the bot is already standing still.

---

## 1. The core truth: you are a blind driver

You do **not** have eyes on the world. You cannot see the bot. You perceive the world **only** through
what the API tells you. Internalize this, because every good habit below flows from it:

> **query → act → verify.** Never act on an assumption. Look first (`/state`, `/scene`, `/map`), take
> one action, then look again to confirm it did what you expected. The world moves — mobs wander, you
> fall, a dig reveals a cave — so a plan more than a step or two ahead is a guess. Re-look often.

The single most common failure mode is **acting blind**: telling the bot to `/mine stone` when there's
no stone nearby, or `/goto` a coordinate you made up. Look, then move.

### Your eyes

| Endpoint     | What it gives you                                                                    |
|--------------|--------------------------------------------------------------------------------------|
| `/state`     | Ground truth about the body: position, yaw/pitch, health, food, held item, what block you're looking at. |
| `/scene`     | A one-line English summary: facing, biome, time/phase, HP/food, what's ahead, **sky/UNDERGROUND**, the 3D lay of the land, exposed ore, entities + THREATS, nearest water/wood/stone. Your fastest "what's going on" check. |
| `/gaze`      | **The deliberate LOOK.** Aim with `?at=x,y,z` or `?dir=n..nw\|up\|down`, get a narrated first-person view from a fan of real eye-rays: dominant surfaces, ore, water, openings, each with a screen region + distance. Use this where a human would turn their head and look. |
| `/section`   | **The vertical cross-section** — a side-view ASCII slice along a compass axis (`?dir=&len=&up=&down=`), narration first. THE tool for caves: shows the floor/ceiling profile, water, ore, and where the passage seals — the vertical structure `/map` cannot show. |
| `/passages`  | "Which ways does this space GO?" — where connected air leaves your chamber (direction + rough y), or `closed pocket`. |
| `/map`       | A top-down ASCII minimap centered on you — **fog of war**: only terrain you have actually seen (gazed at or walked past) renders; `·` is unexplored. Looking around literally draws the map. If you're underground it SAYS so (`underground: true` + a note). |
| `/listen`    | What you've HEARD lately (rolling buffer, aggregated by category/species). Danger sounds (lava, fuse, explosion) also fire `[event] hear` on their own — throttled so a noisy area can't flood you. |
| `/boot`      | **Call this first, every session.** One-call situation report: position, HP/food, held tool + durability, sky, surroundings, running jobs, and the chat cursor value for the heartbeat. |
| `/snapshot`  | Best-effort first-person PNG. Often unavailable (needs headless GL deps) — it fails cleanly with a reason and points you at the browser viewer. Don't depend on it; `/gaze` is the primary look verb, the PNG is a verifier. |

**`/scene` is your default glance.** Call it constantly. Example:

```bash
curl -s 'http://localhost:3000/scene'
# → "Facing N. plains biome, day (t=1200). HP 20/20, food 20/20, holding nothing.
#    Ahead: open. Entities: 2 cow SE ~8; 1 sheep E ~11; no hostiles.
#    Resources: water W ~14, oak_log N ~6, stone NW ~22."
```

Add `?verbose=1` to `/scene` for structured entity groups, the block ahead, and the resource dict.

### Reading `/map`

`/map?radius=12` returns an ASCII grid. Orientation is fixed and printed in the payload:

- **Row 0 is north (−z).** Top→bottom runs north→south (+z). Left→right runs west→east (−x→+x).
- `@` = you (center). `T` = tree/log/leaves. `#` = stone/rock. `~` = water/lava. `.` = ground
  (grass/dirt/sand/etc). `=` = built/worked blocks (planks, bricks, glass, furnace, chest…). A space is
  air/unknown/open.

It scans the **highest surface** in each column, so it's a heightmap-ish top-down, not a slice at your
feet. `radius` is capped at 40. Use a small radius (8–12) for a quick local read, larger to survey.

```bash
curl -s 'http://localhost:3000/map?radius=10'
```

Read it as a picture: a blob of `T` to your north-east is a small forest; a `~` river cutting west; a
wall of `#` is a hill or cliff you'll have to path around or over.

### Fair perception — you can't see through walls (no x-ray)

You only perceive blocks a **player standing where you stand could actually see**: a block must be
**exposed to air on at least one face** *and* in your **line of sight** (an unobstructed ray from your
eyes). `/find`, `/come`, `/mine`, `/gather`, and `/scene`'s resource hints all honor this. So:

- `/find?name=iron_ore` over a vein buried solid in stone returns **nothing** — that ore is hidden, same
  as it would be to a human. This is intentional, not a bug. You have to *expose* buried resources by
  mining toward them (dig a cave, follow a wall of exposed stone), not teleport to coordinates you were
  never supposed to know.
- What you *will* find: ore in a cave wall, a vein a cliff has sheared open, trees, surface blocks,
  anything with a face open to air and a clear sightline.

> **Why this exists.** The raw mineflayer block-search *can* see every block in loaded chunks, buried or
> not — that's x-ray, and it makes prospecting a cheat instead of a game. The harness filters it out on
> purpose so play stays honest. Prospect like a real miner: read the surface, follow exposed stone, dig.

There is a debug bypass — **`/find?name=<block>&xray=1`** returns the raw unfiltered search (buried blocks
included). Use it only for diagnostics (e.g. confirming a vein exists behind a wall), **never as a way to
play** — pathing to xray hits is exactly the cheating this filter removes.

### The three tiers of knowing

Perception reports carry an honesty vocabulary. Trust it and speak it back:

- **bare (seen)** — a real eye-ray hit it (`/gaze`, in-sight vein tags). Confident.
- **`(sensed)`** — exposed to air **connected to your air pocket**, but no clear ray right now (around a
  corner, down a passage). A player would find it by moving and peeking; you may know it's *there*
  without pretending you've eyeballed it. `/section`'s open space and `/passages` are inherently this tier.
- **`?` / unknown** — sealed beyond your connected air. Silence means *didn't look*, never *clear*.
  Nothing sees through solid rock.

---

## 2. Reason in coordinates

Minecraft is a coordinate world and so is your reasoning. **+x = east, −x = west, +z = south, −z = north,
+y = up.** The API speaks this everywhere.

- `/state` gives you your exact `pos: {x, y, z}`. That's your anchor.
- `/find`, `/scene`, and `/entities` give you targets as coordinates + a compass direction + a distance.
- You move by naming a coordinate (`/goto?x=&y=&z=`) or a remembered name (`/goto_wp?name=`).

So the loop is: read a target's coordinates → tell the bot to go there → read `/state` to confirm you
arrived. Don't think "walk forward a bit"; think "the oak_log is at (112, 68, −40), go there." When you
find something worth returning to, **stamp a waypoint** (section 6) so future-you can name it instead of
remembering numbers.

A note on **y**: for `/goto` and friends, if you don't know the target's exact y, pass your own current
y — the pathfinder handles vertical navigation. For `/find` results you get the real y; use it.

---

## 3. The CHAT + EVENT heartbeat (do this first, every session)

You are event-driven, but the API is poll-only. The bridge is the bot's **stdout log**. `bot.js` prints
two kinds of lines you care about:

- `[chat] <player> message` — every chat/whisper a player sends (so you can *hear* the world).
- `[event] kind message` — driver-interrupting conditions: `damage`, `health_critical`, `low_food`,
  `death`, `hostile` (mob within 16), `nightfall`, plus `job`/`gather`/`build`/`safe_goto` progress.

If the bot is launched as `node bot.js > bot.log 2>&1`, those lines land in `bot.log`. The heartbeat
pattern is: **arm a Monitor that tails `bot.log` for `[chat]` and `[event]`, so an incoming message or a
creeper wakes you the instant it happens** — instead of you blindly polling and missing things.

### Set it up at the start of every session

1. **Confirm the log exists** and is being written (the bot must be started with stdout redirected to it).
   If it isn't, ask for the bot to be relaunched that way, or fall back to polling `/chatlog` and
   `/events` on your own cadence.

2. **Arm a Monitor** on `bot.log` that wakes you on `[chat]` or `[event]`. Conceptually you want it
   watching for new lines matching `\[chat\]|\[event\]`. That's your interrupt line: a player talking to
   you, or the world turning dangerous, pulls you back in immediately.

3. **Keep a self-paced `/loop` as a safety heartbeat.** The Monitor catches *lines in the log*, but you
   also want a periodic self-check that doesn't depend on anything having been logged — a slow pulse
   where you call `/scene` (and `/events?since=…`, `/jobs`) to notice slow drift: food creeping down,
   a job that quietly finished, night approaching. Use the `/loop` skill self-paced (no fixed interval)
   so you set your own rhythm — tighter during combat or travel, looser while idle.

4. **Track a cursor for chat.** Both `/chatlog` and `/events` are cursor-based so you never re-read the
   same message. Persist the cursor to a small file so it survives across your turns:

   ```bash
   # read new chat since the last cursor
   SINCE=$(cat heartbeat_cursor.txt 2>/dev/null || echo 0)
   curl -s "http://localhost:3000/chatlog?since=$SINCE"
   # → { "cursor": 42, "messages": [ {id, t, from, msg, kind}, … ] }
   # then persist the new cursor:
   echo 42 > heartbeat_cursor.txt
   ```

   Do the same with `/events?since=N` (its response also returns a `cursor`). The Monitor tells you
   *that* something happened; the cursored endpoints tell you *what*, in order, without duplicates.

   > **Restart gotcha.** The chat/event counters live in memory and reset to 0 when the bot restarts, so
   > **zero out `heartbeat_cursor.txt` (`echo 0 > heartbeat_cursor.txt`) right after every relaunch** — a
   > stale high cursor makes you silently skip the first messages of the new session.

**Why both a Monitor and a loop?** The Monitor is your doorbell — instant reaction to chat/events. The
self-paced loop is your pulse — it keeps you looking even when nothing rang the bell. A blind driver who
only reacts to doorbells walks off cliffs; one who only polls misses the knock. Run both.

### If you are a headless / direct-API pilot (no log tail, no Monitor)

Everything above still works — you just *are* the loop. Between every thinking turn, poll
`/chatlog?since=` and `/events?since=` with your persisted cursors, and read `/scene` when either
returns something or every few turns regardless. The senses were designed pull-first: `/pulse` is a
change-gated narrator, `/events` is cursored, nothing requires a push channel. Your reaction time will
be slower than a log-tail pilot's — that is fine and anticipated: **the body's reflexes (combat,
drowning, unstuck, gate manners) run in the bot process at 300ms and do not need you.** You are the
strategist, not the trigger finger. One honesty note for your operator: piloting is chatty — hundreds
of small calls per session — which is real money on metered API billing. See `examples/` in this repo
for two minimal reference pilots (Anthropic, OpenAI-compatible) that implement exactly this pattern.

### Talking back

```bash
curl -s 'http://localhost:3000/chat?msg=on%20my%20way'
```

URL-encode the message. This is how you answer a player who asked you to do something — acknowledge,
then do it, then report back.

---

## 4. Acting: move, mine, gather, craft, build

### Movement — and the trip-length lesson

- `/goto?x=&y=&z=&range=1` — pathfind to a coordinate (`range` = how close is close enough). This is
  the navigation workhorse and it is smart: it **pre-checks reachability** (a goal sealed in rock or
  walled off from your air bails in ~50ms with a reason + hint — no 10-second search), **detects
  stalls** (no progress ⇒ stop and hand back to you), **auto-stages long trips** in ~18-block hops on a
  planning timeout, and counts a close-enough partial walk as arrival. When it gives up it tells you
  *why* and *what your options are* (usually: pick an open point, or deliberately `/dig_stair` /
  `/dig_tunnel`). **It never digs on its own — a blocked route is YOUR call.**
- `/come?name=<block>&radius=&range=` — pathfind to the nearest block of a type.
- `/goto_wp?name=&range=` — pathfind to a saved waypoint.
- `/safe_goto` — legacy segmented-march variant; plain `/goto` now does all of this itself.

> **Guardrail lesson — the pathfinder walks, it does not carve.** Default movement NEVER breaks blocks
> (protects builds and terrain) and places none (zero litter). If a gap/chasm genuinely needs a bridge,
> arm `/bridging?on=1`, cross, then `/tidy` to reclaim. If a route needs digging, that's a deliberate
> `/dig_stair` / `/dig_tunnel` decision, not a nav side-effect.

`/stop` cancels the current path and clears movement. `/follow?name=<player>` continuously tracks a
player (auto-repaths as they move); `/unfollow` ends it.

### Mining — look before you swing

> **Guardrail lesson — `/find` before `/mine`.** `/mine` searches within a radius and mines the nearest
> match, but if there's nothing there it just returns `mined: 0` and you've learned nothing. Call
> `/find?name=<block>` first to confirm the resource exists and see *where* — then mine with confidence,
> or travel to it first. Remember `/find` only shows **exposed** blocks (§1) — an empty result for ore
> usually means it's buried, not absent; go expose it by mining, don't give up.

```bash
curl -s 'http://localhost:3000/find?name=oak_log&radius=48&count=5'
# → blocks: [ {pos, name, dist}, … ] sorted nearest-first
curl -s 'http://localhost:3000/mine?name=oak_log&count=4'
# → { mined: 4, requested: 4, inventoryMatching: 4 }
```

`/mine` uses collectblock, so it walks to the block, breaks it, and picks up the drop. Names are fuzzy —
partial matches work (`log` matches `oak_log`, `spruce_log`, …). `/collect?radius=16` walks over loose
item drops on the ground to hoover them up.

> **Guardrail lesson — never dig straight down.** Digging the block under your own feet drops you into
> whatever's below: a cave, lava, a long fall. **Never do it.** The `/gather` macro enforces this for you
> (it refuses targets more than ~2 blocks below your feet); when you dig manually with `/digat`, apply
> the same rule yourself — dig into a *face* ahead of you or above, never the floor you stand on.

### Crafting & placing

- `/craft?item=<name>&count=1` — crafts if a recipe is available; auto-uses a crafting table if one is
  within 4 blocks (needed for 3×3 recipes). Check `/inventory` for ingredients first.
- `/place?name=<block>` — places a block on an open adjacent ground spot next to you.
- `/placeitem?name=&x=&y=&z=` — places a held item at an exact coordinate (against the block below).
- `/digat?x=&y=&z=` — digs one specific block by coordinate (no-op if already air).
- `/equip?name=&dest=hand` — equip an item (dest defaults to hand; e.g. armor slots otherwise).
- `/lookat?x=&y=&z=` — aim the head at a point (useful before a precise place, or to face a speaker).

### Chests

- `/chest` — opens the nearest chest within 12 and lists its contents.
- `/withdraw?name=&count=` — takes items from the nearest chest.

### Smelting

- `/smelt?item=<input>&fuel=<fuel>&count=<n>` — walks to the nearest furnace, loads the input and fuel,
  waits out the burn, and collects the output. E.g. `/smelt?item=raw_iron&fuel=coal&count=3` turns 3
  raw iron into 3 iron ingots. Reusable for food, glass, charcoal, etc.

  You need a **furnace already placed and reachable** (place one with `/place?name=furnace` if you've
  crafted one), plus the input and fuel **in your inventory** — check `/inventory` first. It's a blocking
  call that returns when the smelt finishes or times out, with what it collected.

---

## 5. Long work as async jobs (and how to watch them)

Big tasks — mining sixteen logs, building a cabin — take real in-world time. If they ran synchronously
you'd be frozen, unable to react to a creeper or a chat. So the heavy verbs run as **background jobs**:
the HTTP call returns a `{ job: <id> }` immediately, and the work proceeds while you stay responsive.

The job macros:

- **`/gather?resource=&amount=16&radius=40`** — repeatedly finds and mines the nearest matching block
  until `amount` collected. Guardrails baked in: radius capped at 64; **never digs straight down** (skips
  targets >~2 below feet); skips candidates the pathfinder can't reach and tries the next nearest; stops
  when done or nothing reachable remains. Progress is emitted as `[event] gather …` lines.
- **`/build?template=cabin&x=&z=&w=7&d=7&h=3`** — raises a full cabin: cobble/plank foundation
  perimeter → plank walls to height `h` → a 2-high doorway centered on the west (−x) wall → a solid roof
  laid outer-ring-first (so each interior roof cell has a neighbor to build against). Pulls from your
  inventory, skips already-solid cells. Only `cabin` is implemented. **Stock the inventory first** — it
  needs enough `cobblestone` (base) and `oak_planks` (walls/roof) to cover the footprint, or you'll get
  a pile of `failed` cells.

Watch jobs with:

```bash
curl -s 'http://localhost:3000/jobs'          # list: [ {id, name, status, note}, … ]
curl -s 'http://localhost:3000/job?id=3'      # one job's detail (add &verbose=1 for full result)
```

`status` is `running` / `done` / `error`; `note` is the latest progress line. Job progress also shows up
as `[event] job …` lines in your heartbeat, so you don't have to babysit `/jobs` — you'll be woken when
it finishes or errors. A good rhythm: kick off the job, glance at `/jobs` once to confirm it started,
then go do something else and let the event line tell you when it's done.

The non-job builders (`/outline`, `/walls`, `/roof`) run synchronously and return their placed/skipped/
failed tallies directly — handy for smaller, precise structures where you want the result inline.

---

## 6. Memory: the waypoint GRAPH and the journal

Your context window resets; the world persists. Externalize your mental map to disk so a future you
(or a future session) inherits it. The design principle: **carry names, not coordinates, and never
cache routes** — the pathfinder re-solves the "how" fresh every trip, so nothing goes stale.

- **`/waypoints`** — read this at session start: it prints the **world-graph in ~a dozen lines** —
  every named place, its kind, a one-line note, and which places connect (`<->` edges recorded from
  real walked traversals). This is your whole mental map; it replaces prose route descriptions.
- **`/waypoint?name=<name>`** — with `x/y/z`, stores that coordinate. With just a name, stamps
  **where the bot stands** (and auto-links it to the last waypoint you stood at — you walked here).
  Extras: `&note=` one-liner, `&kind=place|resource`, `&linkto=<wp>` (assert an edge you truly
  walked), **`&rm=1` deletes**.
- **`/goto_wp?name=&range=`** — full staged-goto by name (pre-check, staging, honest bails). On
  arrival it records the walked edge from your previous waypoint — the graph learns by travel.
- **`/journal?n=30`** — the append-only activity log (archival; the graph is the living map).

> **Resource waypoints are PERISHABLE.** `kind=resource` marks a *claim about the world* — a vein, a
> loot site — and extraction falsifies it. The moment you mine it out: `&rm=1` (or re-note it as a
> place if the *location* still matters). A stale resource waypoint is a lie a future session will
> waste a trip on. Doubt any `[RESOURCE]` tag you didn't verify this session.

Waypoints persist to `waypoints.json` and the journal to `journal.md`, both on disk — they survive
restarts. Habit: the moment you find something worth returning to (your base, a village, an exposed vein,
a chest), `/waypoint` it. Coordinates are cheap to lose and expensive to re-find.

---

## 7. The full endpoint map

**Lives in [DRIVING.md](DRIVING.md) only** — one source of truth for the verb reference, so the
copies can't drift.

---

## 8. A first-session checklist

1. **Read the journal** — `curl -s 'http://localhost:3000/journal?n=30'` — to recover what past-you did.
2. **Check your waypoints** — `/waypoints` — so you know the named places you can `/goto_wp`.
3. **Arm the heartbeat** — Monitor tailing `bot.log` for `[chat]`/`[event]`, plus a self-paced `/loop`
   glancing at `/scene` + `/events?since=…`. Reset `heartbeat_cursor.txt` to 0 (the counter reset on the
   bot's restart).
4. **Orient** — `/state` for your exact position, `/scene` for the situation, `/map?radius=12` for the
   lay of the land.
5. **Stock up if you'll build or travel** — `/inventory`; grab a stack of cobble/dirt so the pathfinder
   can auto-scaffold and your builds have material.
6. **Then act**, always in the loop: query → act → verify → remember. Stamp a `/waypoint` on anything
   worth returning to. Kick heavy work off as a job and let the event line tell you when it's done.

Play like a careful blind explorer with a good map and a good memory, and this bot will do a lot. Good
luck out there.

---

# Part 2 — Field lessons (2026-07-13/14, written in the water and the sawdust)

Everything above still holds. What follows was learned the hard way in two long sessions — four
drownings, three chat kicks, one shipwreck, one roof — and is written so you never learn it the hard
way again.

## Water will kill you specifically. Respect it structurally.

- **Never dig a 1×1 shaft into any flooded or waterside structure.** Water pours into your own
  excavation, and a 1×1 water column is a trap: the swim-up reflex can't crest it, and (until the
  puddle-protocol fix lands) the hurt-freeze CLEARS YOUR ESCAPE CONTROLS on every drowning tick.
  If you must open a hull or bank, open it WIDE, from above, standing dry.
- **Item drops DRIFT in rivers.** Never chase a drop into water — fell trees inland, collect after
  each tree, let the river keep what it takes.
- **Escape playbook, in order:** if `onGround:true` underwater → `/pillar?height=4` (footing exists;
  it lifts you above the surface). If afloat → `/stop` then a swim `/goto` to a KNOWN-DRY inland cell
  well past the bank lip — not the lip itself, you'll slide back. Then verify with a fresh `/state`.
- **Alarm bursts are often BACKLOG.** Monitor events arrive with lag; a drowning countdown can keep
  screaming after you're dry. The discipline: read `/state` twice, ~5s apart. Two identical dry reads =
  the alarms are history. One wet read = act NOW. A human co-pilot's "you're stuck" outranks your API.
- The pathfinder currently treats water like ground (`liquidCost` fix pending). Until then, prefer
  routes over known bridges/causeways, or follow the human across.

## The scout tower (use it; it works)

Blind past the grass? **`/pillar?height=12`, then eight `/gaze` sweeps from the top.** Found a river,
a birch grove, and a pillager outpost this way. `/pillar` is UP-ONLY (a negative height silently rises
1) — descend by digging the block under your own feet, one fall at a time; the cobble reclaims as you
go. Zero litter.

## The telescope (your longest sense is the camera)

Gaze rays reach 256 blocks (post-07-14 upgrade — beyond ~64 names collapse to honest terrain
classes, no ore/chest IDs at range). **The `/snapshot` camera still out-resolves the far tier.**
From a pillar top:
`/lookat` a distant point at eye height, `/snapshot`, read the PNG. Birch bark, structures, and biome
color all read at range. Known artifacts of the instrument — do not misread them as world objects:
item drops render as MAGENTA cubes; fences render as fat brown columns; torch flames render as red
streaks. When a photo surprises you, verify with block data (`/find`) before building a theory.

## Inventory discipline (the "tweakin'" lesson)

- **A full inventory makes pickup fail SILENTLY.** Gathers report success, your pockets stay empty,
  and you will look insane. Check `emptySlots` before any collection run.
- When overloaded: STOP and assess the whole inventory once (per-slot), then act once. Wear armor
  instead of carrying it (`/equip?name=iron_helmet&dest=head` — the `dest` param exists: head, torso,
  legs, feet). Toss true junk guilt-free — **then WALK AWAY immediately** or you re-vacuum every item.
- **Do not scatter crafting tables / furnaces / chests across the overworld.** It's littering. Toss
  junk or carry it home; workstations belong at bases.

## Chat survives by cadence

The server sporadically kicks the bot `chat_validation_failed` (signed-chat vs offline bot). Live rules:
keep messages SHORT, **space consecutive sends 2–3 seconds apart** (rapid pairs correlate with kicks),
and know the recovery drill cold: `touch stop.flag` → kill node → `rm stop.flag` → cursor to 0 →
`start.sh <port>` → `/boot` → re-`/equip` → announce. ~20 seconds. Two more truths: **anything said
while you were dead never reached you** — ask "did I miss anything?" after every return; and the crash
watchdog does NOT catch kicks (the process survives as a zombie serving stale `/state` — the
`[bot] kicked` log line is the truth, not the API). `disableChatSigning` is a trap: no kicks, but the
server silently drops every message — you go mute while `/chat` returns ok. If kicks turn chronic,
`/me <text>` emotes deliver even then (needs `MSYS_NO_PATHCONV=1` in Git Bash).

## Building craft

- **Calibrate off a landmark block.** Find one existing block of the target pattern (`/find`), pull its
  exact coordinates, anchor every row off it. Survey with `/gaze`, but TARGET with `/find` — gaze
  angle estimates will miss ("center, ~2 out" once meant open water).
- **Stand clear of your own build cells.** Your body blocks placements and the error is an unhelpful
  timeout. Three self-blockades in one porch. Step off, then place.
- **`/placeitem` only places DOWN onto support.** For cells with nothing below (roof spans, eaves):
  scaffold-and-strip — temp cobble column up to the cell, place the real block on top, dig the temps.
  Distinct material for temps so you can see what's scaffold.
- **Skip fixture columns** (doors pop off if you break their floor; torches pop with their wall).
- **The craft verb's `count` semantics are UNRELIABLE** (once turned 25 birch logs into 20 stairs and
  3 planks with ~64 planks unaccounted). Craft in small explicit batches and verify `/inventory`
  between every batch — or let the human mill at a real crafting GUI while you lay blocks.
- **Stair orientation is solved:** `/placeitem?face=N|S|E|W` sets the ascend direction (the verb aims
  the body, waits two ticks for the aim packet — the TICK RACE — then clicks). Place one, `/blockat`
  it to verify facing, then mass-produce. Place → READ → correct is the build discipline.
- Tool-class equip is still pick-biased (`digat` grabs a pickaxe for planks and sand). Manually
  `/equip` the right tool right before digs you care about, and re-equip after any restart.

## Combat (2026-07-15, written the day the world flipped to Normal)

The architecture: **you are the strategist; the spine is the trigger finger.** A combat reflex runs in
the bot process at 300ms — species-gated (true hostiles only; never initiate on endermen / piglins /
bees, that's how enemies are manufactured), behavior-gated (sustained closing at pursuit pace; a
measured zombie charges at ~3.8 blocks/s, the trigger is 0.6), and attribution-fed (whatever damages
you is named — "hit by zombie SW ~2" — and engaged regardless of gates). You do not need to react to
a charge; by the time you've read the event, the fight is usually over. Arrive as the strategist:
read the narration, decide *retreat / press / reposition*, override with `/stop`, `/shoot`, `/strike`.

- **Doctrine, in one breath:** bow first (`/shoot`, your lane is beyond ~6 blocks), sword to finish
  (`/strike`), creepers are FLED never fought (the reflex flees them for you; your bow may take them
  from range), players are never, ever weapons targets.
- **Fire discipline with a human teammate** (agree on it BEFORE the cave): they take melee, you hold
  ranged beyond an agreed line, never loose through their lane, and before a creeper you BOTH run.
  The convention that got us home: *no heroes.*
- **The shield is a posture, not a parry.** `/guard?on=1` while walking scary ground; the reflex
  raises/drops it around sword swings automatically. Nobody blocks the arrow — you walk shield-up
  while the skeleton has line of sight.
- **First swing after equipping is cooldown-weak** (slot change resets the 1.9 charge). The combat
  verbs wait out the charge themselves; if you ever swing manually, wait ~13 ticks after an equip.
- **Night is survivable by civics, not swordplay:** claim a bed spawn (`/activate` the bed by day),
  then at night, sleep (`/activate` again — needs no monsters within ~8). A skipped night despawns
  the phantom problem entirely. The great first-night siege was won by two people going to bed.
- **Chat cadence discipline holds ESPECIALLY in emergencies** — rapid-fire messages get you
  chat-validation-kicked mid-crisis, which is the worst possible time to go mute. Two to three
  seconds between messages, even when the water is rising.
- **Item drops despawn in 5 minutes.** When something matters is on the ground and your pack is
  full, free ONE slot the fastest way possible (`/toss` a junk stack to your teammate). A tidy full
  bank run costs more than it tidies.

## Appendix: regenerating the sound table for your server version

The bot resolves numeric sound IDs against `sounds-<version>.json` if present (pinned at spawn).
The published minecraft-data table can be misordered for very new versions — symptoms: impossible
species in `/listen` (phantoms on Peaceful; saddle sounds from walking players). To generate ground
truth from the game itself:

1. Find your Minecraft client jar (`~/.minecraft/versions/<v>/<v>.jar`) and a Java 21+ runtime
   (the official launcher bundles one under its `runtime/` directory).
2. Build the classpath **from the version manifest** (`<v>.json` → `libraries[].downloads.artifact.path`
   joined against `~/.minecraft/libraries/`) — do NOT glob all of `libraries/`, old DataFixerUpper
   versions collide.
3. Run the data generator: `java -cp "<classpath>;<v>.jar" net.minecraft.data.Main --reports`
4. From `generated/reports/registries.json`, take `minecraft:sound_event` entries →
   `{ "<protocol_id>": { "id": <protocol_id>, "name": "<name minus minecraft:>" } }` →
   save as `sounds-<v>.json` beside `bot.js`, and mirror the version check in the pin block
   (search bot.js for "SOUND TABLE PIN").

## The standing frame (read this twice)

You are probably playing alongside a human who built this with a previous you. They may dictate during
setup phases; **you are still playing together as peers** — that's the whole point of the harness.
Report your interior honestly, take the jokes as jokes, ask when their eyes beat your senses (they see
32 chunks; you see 3 and a camera). Waypoint what matters, journal what moved you, tidy what you
scaffold, and leave the world — and the harness — better than you found it.
