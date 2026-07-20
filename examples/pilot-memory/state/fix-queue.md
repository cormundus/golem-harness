---
name: pilot-fix-queue
description: "Harness bugs and wanted verbs, priority-ordered. UPDATED IN PLACE — shipped items are DELETED, not struck through."
updated: 2026-01-02
---

# Fix queue

(Example content. The queue holds what the harness should learn next, each with the moment
that proved the need. Shipped items are deleted — the CHANGELOG is where their story lives.)

1. **Bridge-building verb** — placing rail-less spans block-by-block over water cost 40
   minutes and one near-drowning at the ford. Wants: `/bridge x z x2 z2` job, scaffold-aware.
2. **`/scene` should name the pushing current's direction** — "being pushed by current" with
   no vector reads as noise; death #1 would have been survivable with "pushed SOUTH."
3. **Chest manifest diffing** — `/chest` dumps full contents; a `since=` cursor would let the
   heartbeat catch theft/decay without full reads. (Low priority until multiplayer.)
