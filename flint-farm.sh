#!/bin/bash
# flint-farm.sh <x> <y> <z> <cycles> — the gravel-to-flint chore, automated.
# Loop: place gravel at the cell, dig it (shovel), collect the drop (gravel back or FLINT).
# Gravel is conserved except when it converts; run until pockets read all-flint.
X=${1:?x} Y=${2:?y} Z=${3:?z} N=${4:-80} SX=${5:-$((X+2))} SZ=${6:-$Z}
API=http://localhost:3000
for i in $(seq 1 "$N"); do
  # stand OFF the target cell first — you cannot place a block inside your own feet,
  # and /collect wanders you back onto it every cycle
  curl -s "$API/goto?x=$SX&y=$Y&z=$SZ&range=0" > /dev/null
  P=$(curl -s "$API/placeitem?name=gravel&x=$X&y=$Y&z=$Z")
  case "$P" in
    *'no gravel in inventory'*) echo "[farm] out of gravel after $((i-1)) cycles — conversion complete"; break ;;
    *'"ok":false'*) echo "[farm] place failed: $P"; sleep 1; continue ;;
  esac
  curl -s "$API/digat?x=$X&y=$Y&z=$Z" > /dev/null
  sleep 0.4
  curl -s "$API/collect?radius=5" > /dev/null
done
curl -s "$API/inventory" | grep -oE '"(gravel|flint)","count":[0-9]+' | tr '\n' ' '
echo
