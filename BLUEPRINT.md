# BLUEPRINT.md — the manifest driver (design pinned 2026-07-25, built as we play)

The doctrine, settled furnace-side while the vault sand cooked: **design anywhere,
place with honest hands.** The fairness line is where the blocks come from, not where
the thinking happens. A blueprint is thought; the executor is hands. No paste, no
reach beyond a body's reach, no speed beyond body speed — enforced by architecture,
not by pilot discipline.

Two halves:

- **Generators** (off-world, unconstrained): any code that emits a placement manifest.
  First one lives at `tools/vault_blueprint.py` (parametric arch → JSON + optional SVG
  cross-section). Preview is OPT-IN (`preview=1` writes the file) — not every pilot
  has a screen channel; the in-game narration is the universal interface.
- **Executor** (in-world, fairness-bound): `/blueprint?file=` — a JOB that loads a
  manifest, compiles a bill of materials, sorts placements into a buildable order,
  and lays cell by cell: walk within reach → hold material → place → `blockat` verify
  → correct. Narration always on (`layer y78: 42/61, 3 deferred`).

## Decisions locked (2026-07-25, the helmsman's calls)

1. **Scaffolding: allowed, with reclaim** — un-self-supporting cells get scaffold
   blocks on the `/bridging`–`/tidy` ledger, reclaimed at stage end. A manifest is
   never refused for shape, only for supplies.
2. **Narration: always.** The pilot and any watching human see progress in-game.
3. **Preview: optional.** Generators may emit SVG/ASCII; the executor never needs it.
4. **Manifest v1 is a flat JSON list:** `[{x, y, z, block}, ...]`. v2 adds optional
   `face` / `half` / `axis` for oriented blocks. Tiers above (two-cell blocks, surface
   conditions) are incremental; entities and liquids stay live-hands work.

## Executor requirements (each one is a wound already paid for)

- **BOM gate:** compile material counts up front; check pockets + named supply chest;
  refuse honestly or accept `checkpoint=1` (build until dry, park, report).
- **Food floor:** at food ≤6 the loop eats from pockets or aborts honestly (07-25:
  `/walls` starved the body 20→0; long verbs must know bodies eat).
- **Resume by construction:** every cell verifies before placing, so a rerun skips
  already-correct cells (generalizing `/walls`' skipped-count). The manifest IS the
  checkpoint file. Multi-session builds are the point.
- **Sane order:** bottom-up, adjacency-aware, gravity-block support first, defer
  orphans to a retry pass. **Don't entomb the mason** — enclosed volumes build
  inside-out and the body's exit is planned like any other dependency (law 18,
  promoted from discipline to algorithm).
- **Body rules inherited:** pilot lane, reflex overrides, no-progress watchdog
  (07-25's tree wedges: any loop that can't advance in 60s says so and moves on).

## The test ladder (when-we-play schedule)

| Stage | Play milestone | What it proves | Pass looks like |
|-------|----------------|----------------|-----------------|
| 0 ✓ | design pinned | decisions above | this file |
| 1 | finish the wall skin (beach run + 156 panes) | **food-floor fix** on a long verb (code queue 0d first) | food never hits 0 unattended; narration shows the pause-and-eat |
| 2 | **first fire: the gable ends** (160 panes, flat fill, tier-1, low risk) | BOM gate (deliberately start short), resume (deliberate /stop mid-build → rerun → skip-correct), narration cadence | refused when short; rerun places only missing cells; zero misplaced |
| 3 | **THE VAULT** (621 glass, the proof) | centering order (each slice leans on the last), scaffold+reclaim on slice one, multi-session resume (park mid-arch, boot, rerun) | arch completes across ≥2 sessions with no manual cell fixes; tidy ledger zeroed |
| 4 | greenhouse trim / homestead brick house | v2 `face`/`half` fields, oriented placement | stairs face as drawn |
| 5 | ship gate | FIELD-GUIDE section, README, the `.litematic` import question revisited | the helmsman's word |

Stage 2 before stage 3 because the gables are the smallest real manifest that can
fail every interesting way cheaply. The vault is the proof, not the guinea pig.

## Deferred, deliberately

- `.schem`/`.litematic` import ("your Litematica file, laid by honest hands") — the
  README line writes itself, but v1 proves the pattern with our own generators first.
- Entities (frames, paintings, stands), liquids (source-block choreography): live
  hands during a session, not manifest work — revisit only when a real build needs it.
