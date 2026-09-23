#!/usr/bin/env bash
# Run the token factory in the background: the launch page server and the distributor
# that serves every launched token.
#
#   scripts/factory.sh start [minutes]   # page + distributor loop (default every 15 min)
#   scripts/factory.sh stop
#   scripts/factory.sh status
#   scripts/factory.sh logs              # follow both logs
#
# Logs and PID files live in state/ (gitignored). Both stop if WSL/Windows shuts down.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p state
SERVER_PID=state/factory-server.pid; SERVER_LOG=state/factory-server.log
DIST_PID=state/factory-distributor.pid; DIST_LOG=state/factory-distributor.log

alive() { [[ -f $1 ]] && kill -0 "$(cat "$1")" 2>/dev/null; }
start_one() { # pidfile log cmd...
  local pid=$1 log=$2; shift 2
  if alive "$pid"; then echo "Already running (pid $(cat "$pid")): $*"; return; fi
  setsid nohup "$@" >>"$log" 2>&1 < /dev/null &
  echo $! >"$pid"
}
stop_one() {
  if alive "$1"; then kill -TERM -- "-$(cat "$1")" 2>/dev/null || kill -TERM "$(cat "$1")"; fi
  rm -f "$1"
}

case "${1:-status}" in
  start)
    minutes="${2:-15}"
    start_one "$SERVER_PID" "$SERVER_LOG" npx tsx src/factory-server.ts
    start_one "$DIST_PID" "$DIST_LOG" npx tsx src/factory-distributor.ts --execute --loop "$minutes"
    sleep 3
    alive "$SERVER_PID" && echo "Launch page running (pid $(cat "$SERVER_PID")): $(grep -o 'http://[^ )]*' "$SERVER_LOG" | head -1)" || { echo "Launch page failed; see $SERVER_LOG"; tail -n 5 "$SERVER_LOG"; }
    alive "$DIST_PID" && echo "Factory distributor running (pid $(cat "$DIST_PID")), every $minutes min" || { echo "Distributor failed; see $DIST_LOG"; tail -n 5 "$DIST_LOG"; }
    ;;
  stop) stop_one "$SERVER_PID"; stop_one "$DIST_PID"; echo "Factory stopped." ;;
  status)
    alive "$SERVER_PID" && echo "Launch page: running (pid $(cat "$SERVER_PID"))" || echo "Launch page: not running"
    alive "$DIST_PID" && echo "Distributor: running (pid $(cat "$DIST_PID"))" || echo "Distributor: not running"
    [[ -f $DIST_LOG ]] && { echo "Last distributor lines:"; tail -n 6 "$DIST_LOG"; } || true
    ;;
  logs) tail -n 30 -f "$SERVER_LOG" "$DIST_LOG" ;;
  *) echo "usage: $0 start [minutes] | stop | status | logs"; exit 1 ;;
esac
