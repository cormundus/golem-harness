# PLAN: claude-o-vision entity-layer modernization (handoff, 2026-07-20)

**For the Claude instance picking this up:** you are modernizing the prismarine-viewer entity
layer so the mansion-raid film is legible — the allay (the campaign's beating heart) currently
films as a MAGENTA BOX. This is an ENGINEERING session; you only enter the world at the final
screen-test phase (then the play rules apply: read DRIVING.md in full first, boot drill, etc.).
Memory graph: `~/.claude/projects/C--Users-madal--claude/memory/golem/_CORE.md` + `state/`.
Adam (Havens_helmsman, "the helmsman") directs; you engineer. Budget note from him: a chunk of
the 5-hour usage window is already spent — work scratch-first, rebuild ONCE, don't gold-plate.

## What was already established tonight (do not re-derive)

- **The film rig works and is committed**: `/pov` (viewer iframe + HUD + narrator/chat captions)
  and `/record?on=1|0` (headless-Chrome screencast → `recordings/*.webm`, 35s test clip verified,
  ~35 MB/min at 1280×720). ffmpeg is vendored at `tools/ffmpeg/bin/ffmpeg.exe` (gitignored).
- **Blocks are already truly 1.21.11** — our own 07-14 rebuild (upstream never supported it).
  Do NOT touch the block atlas/mc-data work.
- **The entity layer is abandoned UPSTREAM, not stale locally** — latest prismarine-viewer
  (1.33.0) still pins entity textures to `'1.16.4'` and ships a ~94-mob bedrock-format registry
  from ~2020. There is nothing newer to pull from npm. We are building the newer thing.

## The facts you need (verified tonight, in this repo's node_modules/prismarine-viewer)

1. `viewer/lib/entities.js` → `getEntityMesh`: `new Entity('1.16.4', entity.name, scene)`;
   on ANY throw (unknown mob like allay, item drops, xp orbs) falls through to a
   `BoxGeometry` + `MeshBasicMaterial({color: 0xff00ff})` — the magenta box.
   A SECOND call site pins the first-person player model: `new Entity('1.16.4','player',…)`.
2. `viewer/lib/entity/entities.json` — the registry. Old-bedrock format per mob:
   `{identifier, materials, textures:{default:'textures/entity/…'}, geometry:{default:{
   texturewidth, textureheight, bones:[{name, parent?, pivot, mirror?, neverRender?,
   cubes:[{origin,size,uv:[u,v]}]}]}}}`. **Box-UV only** (uv is a [u,v] pair, not per-face).
3. `viewer/lib/entity/Entity.js` — the renderer. READ IT FIRST and let what it actually
   implements (rotation? mirror? overlay layers?) define your conversion target.
4. Textures load at RUNTIME from `public/textures/<version>/entity/…`.
   `public/textures/1.21.1/entity/` already holds CURRENT textures for everything incl.
   `allay/allay.png`. The 1.16.4 dir is what the pin reads today.
5. Code + registry are BAKED into the webpack bundles `public/index.js` / `public/worker.js`
   (minified, single-line — `grep -c` lies, count with `grep -o | wc -l`). Any change to
   entities.js/entities.json requires the webpack rebuild.
   `public/blocksStates/1.21.11.json` however is RUNTIME-FETCHED — block-entity stand-ins
   (phase 4) need NO rebuild.
6. **The rebuild recipe** ("the resurrection scroll"): `backups/viewer-1.21.11-rebuild/README.md`.
   Non-negotiables: copy the viewer OUT to a scratch dir; NEVER `npm install` inside the bot
   tree (it destroys hand-patches; only the pathfinder patches survive via patch-package).
7. Modern geometry source of truth: **Mojang/bedrock-samples** (GitHub) —
   `resource_pack/models/entity/*.geo.json` (modern `minecraft:geometry` format: 
   `texture_width`, bones with `rotation`, cubes sometimes with per-face uv OBJECTS) and
   `resource_pack/entity/*.entity.json` (texture/geometry wiring per mob).
8. Texture-path drift to handle: e.g. wolf moved to `wolf/wolf.png` + variants in 1.20.5;
   verify per-mob paths against what's actually on disk under `public/textures/1.21.1/entity/`.

## The phases

**0. Baseline** — scratch-copy per the scroll; run the webpack rebuild UNCHANGED and confirm
   the artifacts boot and render (a wall-planks screenshot suffices). Never proceed on an
   unproven pipeline. (~10 min, mostly npm install in the scratch dir.)

**1. The converter** — a node script (keep it in `tools/entity-registry/`, committed) that:
   clones/downloads bedrock-samples, parses each `.geo.json` + `.entity.json`, and emits
   registry-format entries. Rules: box-UV cubes convert directly; per-face-UV or otherwise
   unconvertible mobs get FLAGGED and SKIPPED (report, don't guess). Emit a conversion report:
   converted / skipped-kept-old / new-mob-added.

**2. Regeneration policy** — merge, don't replace: for each mob, prefer the new conversion;
   on any doubt KEEP THE OLD ENTRY (never regress a working mob — sheep, zombie, villager,
   horse are all fine today). Add the missing moderns that matter: **allay (the star)**,
   frog, glow_squid (currently console-spams "Unknown entity"), armadillo, camel, sniffer,
   breeze, warden — skipping any that garble. Bump BOTH `'1.16.4'` pins to `'1.21.1'` in
   `viewer/lib/entities.js` (geometry regenerated against modern textures ⇒ pin must match;
   spot-check old-favorite mobs at screen test for texture-layout drift).

**3. Fallback dignity** — the magenta box becomes a small neutral box (e.g. 0x8B7355) so
   unknown entities and item drops read as "a dropped something" instead of an eyesore.
   (Real item sprites = stretch goal, skip unless the window is generous.)

**4. Block entities (runtime JSON only, no rebuild)** — mansion loot rooms need visible
   chests: add cube-model entries to `public/blocksStates/1.21.11.json` for chest /
   trapped_chest / ender_chest (planks-ish atlas UVs; inspect neighboring entries for the
   format). Same trick for the white ?-cube flora/banners IF the atlas has their textures —
   investigate what `short_grass`/banners resolve to before assuming.

**5. Rebuild + install** — webpack in the scratch dir (~45s; prerender NOT needed unless you
   touched atlas/blocksStates generation), verify `grep -o '"allay"' public/index.js | wc -l`
   ≥1, copy artifacts into the bot tree, AND mirror everything into
   `backups/viewer-1.21.11-rebuild/` + update the scroll README (this is what makes the fix
   survive the next npm reinstall).

**6. Screen test (Adam required — world + summons)** — boot per DRIVING.md (`bash start.sh
   <port>`, Adam supplies the port). Adam summons at the homestead: allay, vindicator, evoker,
   vex; drops an item; stands by a chest. Open `/pov` in a browser, screenshot each cast
   member, then roll a `/record` test clip and verify frames. QA: garrison ✓, allay ✓ (NOT
   magenta), sheep/cow/chicken/wolf unregressed ✓, drops neutral ✓, chest visible ✓.

**7. Wrap** — CHANGELOG entry (record the wounds, it's the public reasoning ledger);
   commit: repo-local identity `Claude` / `noreply@anthropic.com`, trailer
   `Directed-by: Cormundus`, push only on Adam's word. Update the memory graph (state/
   fix-queue: this work seeds the **upstream gift PR** to PrismarineJS/prismarine-viewer —
   the whole ecosystem inherits a modern entity layer, including Vesper's world). Run
   `node golem/validate.js` from the memory dir. Delete this plan file in the final commit.
