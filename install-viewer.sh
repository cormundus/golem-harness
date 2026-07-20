#!/usr/bin/env bash
# install-viewer.sh — installs the rebuilt prismarine-viewer bundles for MC 1.21.5+.
#
# WHY: the published prismarine-viewer ships browser bundles whose baked-in
# minecraft-data predates MC 1.21.5. Against newer servers, block-state ids shift
# and the camera lies (wrong textures everywhere). These rebuilt bundles carry
# modern minecraft-data + a synthesized 1.21.11 atlas, plus a fix for the upstream
# stairs-never-render bug (prismarine-viewer#427).
#
# 07-20: they also carry a MODERNIZED ENTITY LAYER — the registry regenerated from
# Mojang/bedrock-samples (130 mobs: allay, warden, camel, sniffer, breeze, frog, ...,
# fixed vex/evoker/horse-family), texture pins bumped 1.16.4 → 1.21.1, a neutral
# fallback box instead of magenta, and chest/banner stand-ins in blocksStates.
# Regenerate the registry: tools/entity-registry/convert.js; stand-ins:
# tools/blockstates-standins.js.
#
# If your server is 1.21.4 or older you do NOT need this — the stock viewer is fine.
#
# Run AFTER `npm install` (which wipes node_modules patches):
#   bash install-viewer.sh
set -euo pipefail
cd "$(dirname "$0")"

TARBALL="release-assets/viewer-1.21.11-bundles.tar.gz"
DEST="node_modules/prismarine-viewer"

if [ ! -d "$DEST" ]; then
  echo "!! $DEST not found — run npm install first." >&2
  exit 1
fi

if [ ! -f "$TARBALL" ]; then
  # fallback: fetch from the GitHub Release if the vendored tarball is absent
  URL="${VIEWER_BUNDLE_URL:-}"
  if [ -z "$URL" ]; then
    echo "!! $TARBALL not found and VIEWER_BUNDLE_URL not set." >&2
    echo "   Download viewer-1.21.11-bundles.tar.gz from the project's GitHub Releases" >&2
    echo "   into release-assets/ and re-run." >&2
    exit 1
  fi
  mkdir -p release-assets
  echo "fetching viewer bundles from $URL ..."
  curl -L -o "$TARBALL" "$URL"
fi

TMP="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP"

# keep the originals the first time through
[ -f "$DEST/public/index.js.stock" ]  || cp "$DEST/public/index.js"  "$DEST/public/index.js.stock"
[ -f "$DEST/public/worker.js.stock" ] || cp "$DEST/public/worker.js" "$DEST/public/worker.js.stock"

cp "$TMP/public/index.js"  "$DEST/public/index.js"
cp "$TMP/public/worker.js" "$DEST/public/worker.js"
cp -r "$TMP/public/textures/."     "$DEST/public/textures/"
cp -r "$TMP/public/blocksStates/." "$DEST/public/blocksStates/"
cp "$TMP/version.js" "$DEST/viewer/lib/version.js"
# entity-layer sources (07-20 modernization) — keep node_modules sources in sync with
# the bundles so a future scratch rebuild starts from what is actually deployed
if [ -d "$TMP/viewer-lib-src" ]; then
  cp "$TMP/viewer-lib-src/entities.js"   "$DEST/viewer/lib/entities.js"
  cp "$TMP/viewer-lib-src/entities.json" "$DEST/viewer/lib/entity/entities.json"
  cp "$TMP/viewer-lib-src/index.js"      "$DEST/lib/index.js"
fi
rm -rf "$TMP"

echo "viewer bundles installed — the camera tells the truth on 1.21.11."
echo "(stock bundles kept as *.stock; restore them by copying back if needed)"
