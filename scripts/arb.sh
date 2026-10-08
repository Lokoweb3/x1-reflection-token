#!/usr/bin/env bash
# Run the arb bot in the background: TEST and GOOGL.X routes plus, with --scan (the default here), the
# XDEX-wide scanner in the same process (one wallet, one queue of trades: they never race each other).
# The standalone scanner ("scan") is still available but not needed with --scan.
#
#   scripts/arb.sh start [bot|scan]    # start the bot (default), or the standalone scanner (sends real transactions)
#   scripts/arb.sh stop  [bot|scan]
#   scripts/arb.sh status
#   scripts/arb.sh logs  [bot|scan]    # follow a log (Ctrl+C to stop following)
#
# Arguments come from state/arb.env if it exists (gitignored), e.g.
#   ARB_BOT_ARGS="--mint <TEST> --mint <GOOGL.X> --keypair ./arb.keypair.json --max-in 10 --execute --cap 20 --skim-to <your wallet>"
#   ARB_SCAN_ARGS="--keypair ./arb.keypair.json --loop 300 --execute --skip <TEST>,<GOOGL.X>"
# otherwise the defaults below. Each keeps running after the terminal closes, until stopped or until
# WSL/Windows shuts down (for always-on, use deploy/systemd/reflect-arb-*.service on a server).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p state
TEST=C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz
GOOGLX=E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5
OWN=99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM,DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n
# 0.005 XNT minimum on other people's pools, 0.02 on your own (OWN); trades up to 25 XNT where pools are deep.
ARB_BOT_ARGS="--mint $TEST --mint $GOOGLX --keypair ./arb.keypair.json --max-in 25 --execute --own $OWN --min-profit 0.005 --own-min-profit 0.02 --scan"
ARB_SCAN_ARGS="--keypair ./arb.keypair.json --loop 300 --execute --skip $TEST,$GOOGLX --own $OWN"
[[ -f state/arb.env ]] && source state/arb.env

script() { [[ $1 == bot ]] && echo scripts/arb-bot.ts || echo scripts/arb-scan.ts; }
args() { [[ $1 == bot ]] && echo "$ARB_BOT_ARGS" || echo "$ARB_SCAN_ARGS"; }
pidf() { echo "state/arb-$1.pid"; }
logf() { echo "state/arb-$1.log"; }
running() { [[ -f $(pidf "$1") ]] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null; }
which_ones() { case "${1:-}" in bot|scan) echo "$1" ;; "") echo bot ;; all) echo bot scan ;; *) echo "unknown: $1 (bot, scan or all)" >&2; exit 1 ;; esac; }

case "${1:-status}" in
  start)
    for w in $(which_ones "${2:-}"); do
      if running "$w"; then echo "$w: already running (pid $(cat "$(pidf "$w")"))"; continue; fi
      # shellcheck disable=SC2046 # word-splitting the argument string is intended
      setsid nohup npx tsx "$(script "$w")" $(args "$w") >>"$(logf "$w")" 2>&1 < /dev/null &
      echo $! >"$(pidf "$w")"
      sleep 3
      if running "$w"; then echo "$w: started (pid $(cat "$(pidf "$w")")). Log: $(logf "$w")"
      else echo "$w: failed to start; see $(logf "$w")"; tail -n 15 "$(logf "$w")"; fi
    done
    ;;
  stop)
    for w in $(which_ones "${2:-all}"); do
      if running "$w"; then pid=$(cat "$(pidf "$w")"); kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"; echo "$w: stopped"
      else echo "$w: not running"; fi
      rm -f "$(pidf "$w")"
    done
    ;;
  status)
    for w in bot scan; do
      if running "$w"; then echo "$w: running (pid $(cat "$(pidf "$w")")). Last lines:"; tail -n 3 "$(logf "$w")" | cut -c1-200
      else echo "$w: not running"; fi
    done
    ;;
  logs) tail -n 40 -f "$(logf "${2:-bot}")" ;;
  *) echo "usage: $0 start|stop [bot|scan] | status | logs [bot|scan]"; exit 1 ;;
esac
