#!/bin/bash
# start.sh <port> [name] — the one-command session opener with a crash WATCHDOG.
#   bash start.sh 59009            (run in background: the loop relaunches the bot if it dies)
#   bash start.sh 59009 Sonnet     (name the in-game avatar — any model can don the body)
#   MC_USER=Sonnet bash start.sh 59009   (env form works too; the arg wins if both given)
#   touch stop.flag                (ends the watchdog after the current process exits)
# NB on skins: offline-mode LAN servers derive the skin from the offline UUID (default
# Steve/Alex family) — the CLIENT cannot push a custom skin. Naming after a premium account
# only shows that account's skin on servers running a skin plugin (e.g. SkinsRestorer).
# First launch TRUNCATES bot.log (fresh session); watchdog relaunches APPEND, so a log-tailing
# Monitor survives. On a crash-relaunch the server chat seq RESETS — the "[event] reborn" line
# below wakes the Monitor so the driver knows to reset heartbeat_cursor.txt and /boot again.
PORT=${1:?usage: bash start.sh <LAN port> [name]}
export PATH="/c/Program Files/nodejs:$PATH"
cd "$(dirname "$0")"
# honor .env here too (bot.js loads it, but env set by this script would override the file —
# so fold the file in FIRST; precedence: arg > exported env > .env > Claude)
PRE_MC_USER=$MC_USER
if [ -f .env ]; then set -a; . ./.env; set +a; fi
NAME=${2:-${PRE_MC_USER:-${MC_USER:-Claude}}}
taskkill //F //IM node.exe 2>/dev/null
rm -f stop.flag
echo 0 > heartbeat_cursor.txt
echo "[start] bot '$NAME' on port $PORT (watchdog armed; 'touch stop.flag' to end)"
first=1
while [ ! -f stop.flag ]; do
  if [ $first -eq 1 ]; then
    first=0
    MC_HOST=localhost MC_PORT=$PORT MC_VERSION=auto MC_USER=$NAME node bot.js > bot.log 2>&1
  else
    MC_HOST=localhost MC_PORT=$PORT MC_VERSION=auto MC_USER=$NAME node bot.js >> bot.log 2>&1
  fi
  [ -f stop.flag ] && break
  echo "[event] reborn — bot process died, watchdog relaunching in 3s (reset heartbeat cursor + /boot)" >> bot.log
  sleep 3
done
echo "[start] watchdog ended"
