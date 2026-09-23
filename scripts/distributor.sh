#!/usr/bin/env bash
# Run the distributor in the background, every N minutes (default 15).
#
#   scripts/distributor.sh start [minutes]   # start the loop (sends real transactions)
#   scripts/distributor.sh stop
#   scripts/distributor.sh status
#   scripts/distributor.sh logs              # follow the log (Ctrl+C to stop following)
#
# The loop runs until stopped, or until WSL/Windows shuts down. The log and PID file
# live in state/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."
PID_FILE=state/distributor.pid
LOG=state/distributor.log
mkdir -p state

running() { [[ -f $PID_FILE ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-status}" in
  start)
    minutes="${2:-15}"
    if running; then echo "Already running (pid $(cat "$PID_FILE")). Use: $0 stop"; exit 1; fi
    setsid nohup npx tsx src/distribute.ts --execute --loop "$minutes" >>"$LOG" 2>&1 < /dev/null &
    echo $! >"$PID_FILE"
    sleep 2
    if running; then echo "Distributor started (pid $(cat "$PID_FILE")), every $minutes min. Log: $LOG"
    else echo "Distributor failed to start; see $LOG"; tail -n 20 "$LOG"; exit 1; fi
    ;;
  stop)
    if running; then
      pid=$(cat "$PID_FILE")
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
      rm -f "$PID_FILE"
      echo "Distributor stopped."
    else
      rm -f "$PID_FILE"; echo "Distributor is not running."
    fi
    ;;
  status)
    if running; then echo "Running (pid $(cat "$PID_FILE")). Last log lines:"; tail -n 8 "$LOG"
    else echo "Not running."; fi
    ;;
  logs) tail -n 40 -f "$LOG" ;;
  *) echo "usage: $0 start [minutes] | stop | status | logs"; exit 1 ;;
esac
