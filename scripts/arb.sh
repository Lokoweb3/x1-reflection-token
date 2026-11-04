#!/usr/bin/env bash
# Run the arb bot in the background: TEST and GOOGL.X routes plus, with --scan (the default here), the
# XDEX-wide scanner in the same process (one wallet, one queue of trades: they never race each other).
# The standalone scanner ("scan") is still available but not needed with --scan.
#
#   scripts/arb.sh start [bot|scan]    # start the bot (default), or the standalone scanner (sends real transactions)
#   scripts/arb.sh stop  [bot|scan]
#   scripts/arb.sh status
#   scripts/arb.sh logs  [bot|scan]    # follow a log (Ctrl+C to stop following)
#   scripts/arb.sh fast  on|off|status # the bot's speed settings (ARB_FAST_ARGS) on or off, and restart it
#   scripts/arb.sh lane  on|off|status # the fast lane (ARB_LANE_ARGS, e.g. GOOGL.X routes only) on or off, and restart it
#
# Arguments come from state/arb.env if it exists (gitignored), e.g.
#   ARB_BOT_ARGS="--mint <TEST> --mint <GOOGL.X> --keypair ./arb.keypair.json --max-in 10 --execute --cap 20 --skim-to <your wallet>"
#   ARB_SCAN_ARGS="--keypair ./arb.keypair.json --loop 300 --execute --skip <TEST>,<GOOGL.X>"
# otherwise the defaults below. ARB_FAST_ARGS (also from state/arb.env, e.g. "--fast --priority-share 15") are
# added to the bot's arguments unless state/arb-fast.off exists: "fast off" creates it and restarts the bot
# on the plain settings, "fast on" removes it and restarts. Each keeps running after the terminal closes, until stopped or until
# WSL/Windows shuts down (for always-on, use deploy/systemd/reflect-arb-*.service on a server, or on
# WSL scripts/arb-watchdog.sh, which restarts the bot unless it was stopped here).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p state
TEST=C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz
GOOGLX=E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5
OWN=99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM,DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n
# 0.005 XNT minimum on other people's pools, 0.02 on your own (OWN); trades up to 25 XNT where pools are deep.
ARB_BOT_ARGS="--mint $TEST --mint $GOOGLX --keypair ./arb.keypair.json --max-in 25 --execute --own $OWN --min-profit 0.005 --own-min-profit 0.02 --scan"
ARB_SCAN_ARGS="--keypair ./arb.keypair.json --loop 300 --execute --skip $TEST,$GOOGLX --own $OWN"
ARB_FAST_ARGS=""
ARB_LANE_ARGS=""
[[ -f state/arb.env ]] && source state/arb.env
[[ -n $ARB_FAST_ARGS && ! -f state/arb-fast.off ]] && ARB_BOT_ARGS="$ARB_BOT_ARGS $ARB_FAST_ARGS"
[[ -n $ARB_LANE_ARGS && ! -f state/arb-lane.off ]] && ARB_BOT_ARGS="$ARB_BOT_ARGS $ARB_LANE_ARGS"

script() { [[ $1 == bot ]] && echo scripts/arb-bot.ts || echo scripts/arb-scan.ts; }
args() { [[ $1 == bot ]] && echo "$ARB_BOT_ARGS" || echo "$ARB_SCAN_ARGS"; }
pidf() { echo "state/arb-$1.pid"; }
logf() { echo "state/arb-$1.log"; }
running() { [[ -f $(pidf "$1") ]] && kill -0 "$(cat "$(pidf "$1")")" 2>/dev/null; }
which_ones() { case "${1:-}" in bot|scan) echo "$1" ;; "") echo bot ;; all) echo bot scan ;; *) echo "unknown: $1 (bot, scan or all)" >&2; exit 1 ;; esac; }

case "${1:-status}" in
  start)
    for w in $(which_ones "${2:-}"); do
      rm -f "state/arb-$w.stopped"
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
      touch "state/arb-$w.stopped" # tells scripts/arb-watchdog.sh not to restart it
    done
    ;;
  status)
    for w in bot scan; do
      if running "$w"; then echo "$w: running (pid $(cat "$(pidf "$w")")). Last lines:"; tail -n 3 "$(logf "$w")" | cut -c1-200
      else echo "$w: not running"; fi
    done
    ;;
  logs) tail -n 40 -f "$(logf "${2:-bot}")" ;;
  fast)
    case "${2:-status}" in
      on) rm -f state/arb-fast.off ;;
      off) touch state/arb-fast.off ;;
      status) ;;
      *) echo "usage: $0 fast on|off|status"; exit 1 ;;
    esac
    if [[ -z $ARB_FAST_ARGS ]]; then echo "fast: no ARB_FAST_ARGS in state/arb.env (nothing to turn on or off)"
    elif [[ -f state/arb-fast.off ]]; then echo "fast: OFF (would add: $ARB_FAST_ARGS)"
    else echo "fast: ON ($ARB_FAST_ARGS)"; fi
    if [[ ${2:-status} != status ]]; then "$0" stop bot; "$0" start bot; fi
    ;;
  lane)
    case "${2:-status}" in
      on) rm -f state/arb-lane.off ;;
      off) touch state/arb-lane.off ;;
      status) ;;
      *) echo "usage: $0 lane on|off|status"; exit 1 ;;
    esac
    if [[ -z $ARB_LANE_ARGS ]]; then echo "lane: no ARB_LANE_ARGS in state/arb.env (nothing to turn on or off)"
    elif [[ -f state/arb-lane.off ]]; then echo "lane: OFF (would add: $ARB_LANE_ARGS)"
    else echo "lane: ON ($ARB_LANE_ARGS)"; fi
    if [[ ${2:-status} != status ]]; then "$0" stop bot; "$0" start bot; fi
    ;;
  *) echo "usage: $0 start|stop [bot|scan] | status | logs [bot|scan] | fast on|off|status | lane on|off|status"; exit 1 ;;
esac
