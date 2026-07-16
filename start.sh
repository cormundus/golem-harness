#!/bin/bash
# start.sh <port> — the one-command session opener with a crash WATCHDOG.
#   bash start.sh 59009        (run in background: the loop relaunches the bot if it dies)
#   touch stop.flag            (ends the watchdog after the current process exits)
# First launch TRUNCATES bot.log (fresh session); watchdog relaunches APPEND, so a log-tailing
# Monitor survives. On a crash-relaunch the server chat seq RESETS — the "[event] reborn" line
# below wakes the Monitor so the driver knows to reset heartbeat_cursor.txt and /boot again.
PORT=${1:?usage: bash start.sh <LAN port>}
export PATH="/c/Program Files/nodejs:$PATH"
cd "$(dirname "$0")"
taskkill //F //IM node.exe 2>/dev/null
rm -f stop.flag
echo 0 > heartbeat_cursor.txt
echo "[start] bot on port $PORT (watchdog armed; 'touch stop.flag' to end)"
first=1
while [ ! -f stop.flag ]; do
  if [ $first -eq 1 ]; then
    first=0
    MC_HOST=localhost MC_PORT=$PORT MC_VERSION=auto MC_USER=Claude node bot.js > bot.log 2>&1
  else
    MC_HOST=localhost MC_PORT=$PORT MC_VERSION=auto MC_USER=Claude node bot.js >> bot.log 2>&1
  fi
  [ -f stop.flag ] && break
  echo "[event] reborn — bot process died, watchdog relaunching in 3s (reset heartbeat cursor + /boot)" >> bot.log
  sleep 3
done
echo "[start] watchdog ended"
