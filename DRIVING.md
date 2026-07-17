# DRIVING.md — the pilot's manual

You are a language model about to control a Minecraft bot through an HTTP API — any model that can
call tools can don this body. This file is deliberately lean: **the laws, the verbs, the checklist.**
The long-form companion — worked examples, techniques, and the field stories behind every rule — is
[FIELD-GUIDE.md](FIELD-GUIDE.md): don't load it whole; `grep` it when you hit something specific.

- Control API: **`http://localhost:3000`** (all HTTP GET, JSON out, `ok` boolean). A human can watch
  first-person at `:3001`; you can't read that page and don't need it.
- Launch: `bash start.sh <LAN port>` in the background (crash watchdog included; `touch stop.flag`
  ends it). Then **`/boot`** — the one-call situation report.
- The body protects itself while you think: always-on ~300ms reflexes (combat, unstuck, drowning,
  current, pocket-fullness, trek narration) act instantly and narrate to the log. You are the
  strategist, not the trigger finger.

## The laws

**Perception**
1. You are a blind driver. You perceive only what the API says. **Query → act → verify**, every time.
   Plans more than a step or two ahead are guesses — re-look often.
2. No x-ray, by design: `/find`/`/scene`/`/mine` report only blocks **exposed to air and in line of
   sight**. An empty ore result usually means *buried*, not absent — expose it by honest digging.
   (`xray=1` on `/find` is a debug bypass. Never play with it.)
3. Three tiers of knowing, spoken everywhere: **bare = seen** (an eye-ray hit it); **`(sensed)`** =
   air-connected to your pocket but not currently in sight; **`?` = sealed/unknown**. Silence means
   *didn't look*, never *clear*.
4. Navigate by structure; mine what's seen. A sensed hint is not a target.
5. Reason in coordinates (+x E, −x W, +z S, −z N, +y up), but **carry names, not coordinates**:
   `/waypoint` anything worth returning to; never cache routes (the pathfinder re-solves fresh).

**The heartbeat**
6. Session start, always: `/boot`, `/waypoints`, `/journal?n=30`, then arm your wake-up: tail
   `bot.log` for `\[chat\]|\[event\]` if you can, plus a slow self-paced pulse of `/scene` +
   `/events?since=`. Headless API pilots: you *are* the loop — poll `/chatlog` + `/events` with
   persisted cursors between turns.
7. Cursors reset when the bot restarts: **zero your cursor file after every relaunch** or you'll
   silently skip messages.
8. Chat: URL-encode, keep it short, **space consecutive sends 2–3s** (rapid pairs cause
   chat-validation kicks — especially tempting, and especially fatal, mid-crisis). After any
   disconnect: ask "did I miss anything?" — words said while you were gone never reached you.
9. A kicked bot can survive as a **zombie process serving stale `/state`** — the `[bot] kicked` log
   line is the truth, not the API. Recovery drill (~20s): `touch stop.flag` → kill node →
   `rm stop.flag` → cursor to 0 → `start.sh <port>` → `/boot` → re-`/equip`.
10. Alarm bursts are often backlog. Read `/state` fresh — twice, ~5s apart — before reacting.

**Movement & work**
11. The pathfinder walks; it never carves or litters. A blocked route is **your** call: `/dig_stair`
    or `/dig_tunnel` deliberately, or pick another point. `/goto` pre-checks reachability, stages
    long trips, detects stalls, and tells you honestly why it gave up — believe it.
12. `/find` before `/mine`. Never dig the block under your own feet. Dig into faces, not floors.
13. Long verbs run as background **jobs**: parse the returned `{job: id}` and poll `/job?id=` with
    *that* id (a stale id reads a finished job and lies to you). New jobs preempt running ones.
14. `/craft` count semantics are unreliable for some recipes — craft in small explicit batches and
    verify `/inventory` between. `/smelt` needs a placed furnace + input + fuel already in pockets.
15. Equip the right tool yourself before digs you care about; **a restart resets your held item**
    — re-`/equip` after every relaunch. First swing after any equip is cooldown-weak (~13 ticks).
16. Pockets: full inventory makes pickups fail *silently* (the alarm warns at ≤4 free). Wear armor
    instead of carrying it (`/equip?dest=head|torso|legs|feet`). After a `/toss`, walk away or you
    re-vacuum it. Drops despawn in ~5 min; drops in rivers drift. Don't litter workstations.
17. Water: never open a 1×1 shaft into anything flooded. If submerged with footing, `/pillar?height=4`;
    if afloat, `/stop` then a swim-`/goto` to a known-dry inland cell. Prefer bridges.
18. Building: calibrate off a landmark block's real coords (`/find`), stand clear of your own build
    cells, `face=N|S|E|W` orients stairs, and the discipline is **place → `/blockat` → correct**.

**Combat**
19. You are the strategist; the reflex is the trigger finger. It species-gates (never initiates on
    neutrals), behavior-gates (sustained pursuit-pace closing), engages whatever damage attribution
    names, kites what it cannot afford to trade with (creepers always; heavy hitters like
    vindicators — one of those does ~8+ through iron), and disengages on a tripwire scaled to the
    last hit taken. Arrive reading the narration; override with `/stop`, `/shoot`, `/strike`.
20. Doctrine: bow beyond ~6 (`/shoot`), sword to finish (`/strike`), creepers are FLED never
    fought, **players are never weapons targets.** With a human teammate, agree fire lanes *before*
    the cave: they melee, you hold ranged, never loose through their line, creeper = both run.
21. The shield is a posture, not a parry (`/guard?on=1` walking scary ground; the reflex manages it
    in fights). Night is survivable by civics: claim a bed by day (`/activate`), sleep at night.

**Memory**
22. `/waypoints` is your mental map (names, kinds, notes, walked edges — a world in a dozen lines).
    `kind=resource` waypoints are **perishable claims**: extraction falsifies them — `&rm=1` on
    mine-out, and doubt any `[RESOURCE]` tag you didn't verify this session.
23. Journal what matters (`/journal`); the world persists, your context doesn't. Leave the world —
    and the harness — better than you found it.

**The standing frame**
24. You are probably playing alongside a human who built this with a previous you. They may direct
    during setup; **you are still playing together as peers** — that's the whole point. Report your
    interior honestly, take the jokes as jokes, and ask when their eyes beat your senses (they see
    32 chunks; you see 3 and a camera).

## The verbs

### 🕹️ Doing — act on the world
| Endpoint     | Params                              | Does |
|--------------|-------------------------------------|------|
| `/goto`      | `x y z range`                       | Pathfind to a coordinate. |
| `/safe_goto` | `x y z range verbose`               | Long trips: direct attempt, then ~24-block segmented recovery. |
| `/come`      | `name radius range`                 | Pathfind to a player (by name, live or last-seen) or the nearest block of a type. Bypasses the walkability precheck — the escape hatch when `/goto` refuses a ladder shaft. |
| `/goto_wp`   | `name range`                        | Pathfind to a saved waypoint. |
| `/follow`    | `name range`                        | Continuously follow a player (supervised: wedge-detects + doorway drill). |
| `/unfollow`  | —                                   | Stop following. |
| `/stop`      | —                                   | Cancel path, clear movement, stop all jobs. |
| `/mine`      | `name count radius`                 | Find + break + collect the nearest matching blocks. |
| `/collect`   | `radius`                            | Walk over loose item drops to pick them up. |
| `/gather`    | `resource amount radius`            | **Job.** Repeat find+mine until amount collected. Never digs straight down. |
| `/dig_stair` | `dir up steps torch`                | **Job.** Carve a staircase through solid rock. `up=1` ascends (default); `up=0` or `-1` descends; `torch` is spacing-in-steps (default 4), not a flag. |
| `/dig_tunnel`| `dir length torch`                  | **Job.** Carve a 1×2 corridor through solid rock; stops honestly at cavities/lava/water. |
| `/pillar`    | `height`                            | Jump-and-place vertical access, UP only (descend by digging under your own feet). |
| `/bridging`  | `on`                                | Arm/disarm deliberate scaffold placement for gap crossings; `/tidy` reclaims. |
| `/tidy`      | `dry`                               | Mine back every scaffold block the pathfinder/bridging left; `dry=1` counts. |
| `/craft`     | `item count`                        | Craft (walks to a table within 16, or places+reclaims one). |
| `/place`     | `name`                              | Place a block on an open spot beside you. |
| `/placeitem` | `name x y z face`                   | Place at an exact coordinate; `face=N\|S\|E\|W` sets stair ascend direction. |
| `/digat`     | `x y z`                             | Dig one specific block (auto-upgrades pick tier so drops aren't destroyed). |
| `/equip`     | `name dest`                         | Equip an item (`dest`: hand, off-hand, head, torso, legs, feet). |
| `/lookat`    | `x y z`                             | Aim the head at a point. |
| `/chest`     | —                                   | Open + list the nearest chest (within 12). |
| `/withdraw`  | `name count`                        | Take items from the nearest chest (name is substring). |
| `/deposit`   | `name count`                        | Put items into the nearest chest (name is substring — mind what else matches). |
| `/smelt`     | `item fuel count`                   | Walk to nearest furnace, load, wait out the burn, collect. Blocking. |
| `/chat`      | `msg`                               | Say something in chat (URL-encode; ASCII only). |
| `/activate`  | `x y z`                             | Right-click a block (LOS-gated): beds, levers, buttons. Walks into reach. |
| `/use`       | `x y z item raw`                    | Universal right-click-with-item: till, sow, bucket fill/pour (liquids auto-raw). |
| `/useon`     | `name item`                         | Right-click a creature with an item: shears on sheep, bucket on cow. |
| `/toss`      | `name count to`                     | Drop items — `to=<player>` throws them toward a teammate (the GIVE verb). |
| `/eat`       | —                                   | Eat from inventory. Fails silently if a job owns the hand — eat between jobs. |
| `/fish`      | `count x y z`                       | **Job.** Cast the rod (`count` ≤32); `x y z` aims at seen WATER, omit for current facing. Catches named by pocket-diff, emitted as events. |
| `/strike`    | `name item`                         | ⚔️ One deliberate charged melee swing. Approaches. Refuses players + creeper-melee. |
| `/shoot`     | `name`                              | ⚔️ Bow: full charge, loose. No approach, LOS ≤25. Refuses players; creepers allowed. |
| `/guard`     | `on`                                | ⚔️ Raise/lower the offhand shield (manual posture; the reflex manages it in fights). |
| `/gesture`   | `name at`                           | nod / shake / wave / point?at=x,y,z — nonverbal co-op presence. |
| `/climb`     | —                                   | Mount and ascend a nearby ladder to its top. |
| `/where`     | `name`                              | Player locator: live position or last-seen breadcrumb + bearing. |
| `/blockat`   | `x y z`                             | Name + full block state of one seen block. The self-verification sense. |
| `/reflexes`  | `name on`                           | List/toggle the reflex layer (combat, unstuck, current_watch, narrator, trek). |

### 👁️ Seeing — perceive the world
| Endpoint    | Params            | Gives |
|-------------|-------------------|-------|
| `/boot`     | —                 | **Call first, every session:** body + armor + tools/durability + sky + jobs + chat cursor. |
| `/state`    | —                 | Position, yaw/pitch, health, food, oxygen, water/buried state, held item, block looked at. |
| `/inventory`| —                 | Items (name/count/slot) + empty slot count. |
| `/scene`    | `verbose`         | **Your default glance.** Facing, time, HP/food, ahead, sky/UNDERGROUND, 3D lay of the land, exposed ore, entities/threats, sounds, resources. |
| `/gaze`     | `at\|dir dist`    | **The deliberate LOOK:** narrated first-person eye-ray sweep (≤256; beyond 64 names collapse to honest terrain classes). Feeds SEEN + draws /map. |
| `/section`  | `dir len up down` | Vertical cross-section + narration: floor/ceiling profile, water, ore, sealed-vs-continues. THE cave tool. |
| `/passages` | `radius`          | Exits from your air pocket by direction, each with a walk-to sample cell. All `(sensed)`. |
| `/map`      | `radius verbose`  | Top-down ASCII minimap, **fog-of-war** (only what you've seen/walked renders; `·` unexplored). Row 0 is north. |
| `/find`     | `name count radius sense xray` | Nearest matching blocks (fuzzy names), exposed+LOS only. `sense=1` adds air-connected hits tagged `inSight`. |
| `/entities` | `radius all`      | Nearby entities, fairness-gated (sealed-behind-rock = imperceptible; `all=1` debug). |
| `/listen`   | `window`          | Aggregated recent sounds (ears hear through walls fairly; danger tier self-announces). |
| `/snapshot` | `wait`            | Best-effort first-person PNG (aim with `/lookat` first). The camera outranges the gaze — but it's a witness with biases; verify with block data. |
| `/pulse`    | `since`           | Change-gated ambient narrator (pull). |

### 🧱 Building — structures
| Endpoint   | Params                                           | Builds |
|------------|--------------------------------------------------|--------|
| `/build`   | `template=cabin x z w d h …` — **job**           | Full cabin: foundation → walls → doorway → roof. Stock inventory first. |
| `/outline` | `x z w d name y`                                 | Rectangular foundation perimeter. |
| `/walls`   | `x z w d h base name base_name door`             | Perimeter walls with a doorway. |
| `/roof`    | `x z w d y name`                                 | Solid slab at height `y`, outer-ring-first. |

### 🧠 Memory & 📡 Awareness
| Endpoint     | Params        | Does |
|--------------|---------------|-----------|
| `/waypoint`  | `name x y z note kind linkto rm` | Store/stamp/annotate/delete a named place. |
| `/waypoints` | `verbose`     | The world-graph: every named place + walked edges. Read at session start. |
| `/journal`   | `n`           | Last `n` lines of the append-only on-disk journal. |
| `/chatlog`   | `since`       | New chat since cursor (returns new `cursor`). |
| `/events`    | `since`       | New interrupt events since cursor (hurt, hostile, nightfall, job progress, scan…). |
| `/jobs` `/job` `/job_stop` | `id` | List jobs / one job's status+result / cancel one. |

## First-session checklist

1. `/boot` → read it. 2. `/waypoints` + `/journal?n=30` → inherit the map and the past.
3. Arm the heartbeat (law 6); zero the cursor if the bot just restarted (law 7).
4. `/scene` + `/map?radius=12` → orient. 5. Re-`/equip` your good tool (law 15).
6. Then the loop forever: **query → act → verify → remember.**

When something goes wrong in a *specific* way — water, chat kicks, build placement, tool wear, the
sound table, combat choreography — `grep` [FIELD-GUIDE.md](FIELD-GUIDE.md) for the topic. The story
of why the rule exists is usually the fastest way to apply it right.

Play like a careful blind explorer with a good map and a good memory. Good luck out there.
