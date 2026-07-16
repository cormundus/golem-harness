#!/usr/bin/env bash
# Snapshot this project to a timestamped folder next to it.
# Usage:  bash backup.sh [label]        e.g.  bash backup.sh los-fix
# Excludes node_modules (huge + regenerable via `npm install`) and transient logs.
# Restore = copy a snapshot's contents back over the project folder, then `npm install`.

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SRC")/mineflayer-bot-backups"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
LABEL=""
[ -n "$1" ] && LABEL="_$1"
DEST="$ROOT/${STAMP}${LABEL}"

mkdir -p "$DEST"
cd "$SRC" || exit 1
tar --exclude=./node_modules --exclude=./.git --exclude=./bot.log \
    --exclude=./smoke.log -cf - . | ( cd "$DEST" && tar -xf - )

echo "backed up -> $DEST"
echo "size: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
echo "files: $(find "$DEST" -type f | wc -l)"
