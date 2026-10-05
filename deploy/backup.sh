#!/usr/bin/env bash
# Encrypted backup of everything that can't be recreated: distributor keys, the
# factory's per-token keys and state, and payout journals. Run daily from cron.
#   BACKUP_PASSFILE=/root/.reflect-backup-pass deploy/backup.sh
set -euo pipefail
APP=/opt/x1-reflection-token
DEST=${BACKUP_DIR:-/var/backups/reflect}
PASS=${BACKUP_PASSFILE:-/root/.reflect-backup-pass}
[[ -s $PASS ]] || { echo "Missing passphrase file $PASS (put a long random passphrase in it, chmod 600)"; exit 1; }
mkdir -p "$DEST" && chmod 700 "$DEST"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
# Every key file in the app folder (distributor, faucet, the vault crank/publisher, the curve
# crank: whatever the configs point at), config, state and launches; mainnet/ holds the mainnet
# site's config, launches and keys (when that site runs here).
shopt -s nullglob
items=(config.json state factory)
for f in "$APP"/*.keypair.json; do items+=("$(basename "$f")"); done
[[ -d $APP/mainnet ]] && items+=(mainnet)
tar -C "$APP" -czf - "${items[@]}" 2>/dev/null \
  | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASS" --symmetric --cipher-algo AES256 \
    -o "$DEST/reflect-$stamp.tar.gz.gpg"
chmod 600 "$DEST/reflect-$stamp.tar.gz.gpg"
# Keep the newest 30.
ls -1t "$DEST"/reflect-*.tar.gz.gpg | tail -n +31 | xargs -r rm -f
echo "Backup written: $DEST/reflect-$stamp.tar.gz.gpg"
# Copy it off the server too (recommended), e.g. with rclone:
#   rclone copy "$DEST/reflect-$stamp.tar.gz.gpg" remote:reflect-backups
