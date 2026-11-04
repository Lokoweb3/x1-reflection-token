#!/usr/bin/env bash
# Run by the owner, with `! bash .claude/prep-2026-11-03/move-tokens-to-server.sh`. Agents can't reach the server.
# Copies the three tokens moved out of ~/.bashrc to a root-only file on the server, checks them by name
# and by hash, then shreds the local copy. Prints no values. Restarts nothing.
set -euo pipefail
SRC="$HOME/.config/x1-secrets/moved-from-bashrc.env"
HOST=root@64.225.61.191
DEST=/etc/reflect-tokens.env
[ -s "$SRC" ] || { echo "nothing at $SRC"; exit 1; }
ssh "$HOST" "test ! -e $DEST" || { echo "$DEST already exists on the server: not overwriting"; exit 1; }
ssh "$HOST" "umask 077; cat > $DEST" < "$SRC"
local_sum=$(sha256sum < "$SRC" | cut -d' ' -f1)
remote_sum=$(ssh "$HOST" "sha256sum < $DEST | cut -d' ' -f1")
[ "$local_sum" = "$remote_sum" ] || { echo "hash differs: keeping the local copy"; exit 1; }
ssh "$HOST" "stat -c '%a %U %n' $DEST; cut -d= -f1 $DEST | tr '\n' ' '; echo"
read -r -p "Names and mode look right? Shred the local copy? [y/N] " yes
[ "$yes" = y ] && shred -u "$SRC" && rmdir "$(dirname "$SRC")" 2>/dev/null; [ -e "$SRC" ] && echo "local copy kept: $SRC" || echo "local copy shredded"
echo "Nothing reads $DEST yet. Attach it per service: EnvironmentFile=$DEST in a drop-in, then restart that service in your own window."
