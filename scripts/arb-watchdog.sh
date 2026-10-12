#!/usr/bin/env bash
# Keep the arb bot running on a WSL machine: every 2 minutes, start it unless it's running or was
# stopped on purpose (scripts/arb.sh stop leaves state/arb-bot.stopped; scripts/arb.sh start clears it).
# Runs in the foreground, so the wsl.exe that launched it keeps WSL up. Launched at Windows logon by
# arb-autostart.vbs in the Windows Startup folder, which relaunches it if WSL shuts down.
set -uo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[[ -s $NVM_DIR/nvm.sh ]] && . "$NVM_DIR/nvm.sh"
while true; do
  if [[ ! -f state/arb-bot.stopped ]] && ! scripts/arb.sh status | grep -q '^bot: running'; then
    echo "$(date '+%F %T %Z') watchdog: bot not running, starting it"
    scripts/arb.sh start bot
  fi
  sleep 120
done >>state/arb-watchdog.log 2>&1
