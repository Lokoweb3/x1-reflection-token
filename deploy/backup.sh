#!/usr/bin/env bash
# Encrypted backup of everything that can't be recreated: distributor keys, the
# factory's per-token keys and state, and payout journals. Run daily from cron.
#   deploy/backup.sh            (settings: /etc/reflect-backup.env, see deploy/README.md "Backups")
#
#   BACKUP_RECIPIENT  fingerprint of the public key to encrypt to (imported with gpg --import as
#                     root). The private key stays off this server, so a taken-over server
#                     can't read old backups. Without it: the passphrase in BACKUP_PASSFILE.
#   BACKUP_REMOTE     rclone destination for an off-box copy, e.g. b2:reflect-backups
#   BACKUP_DIR, BACKUP_PASSFILE  local folder (/var/backups/reflect) and passphrase file
set -euo pipefail
# shellcheck disable=SC1091
[[ -r /etc/reflect-backup.env ]] && . /etc/reflect-backup.env
APP=${APP:-/opt/x1-reflection-token}
DEST=${BACKUP_DIR:-/var/backups/reflect}
PASS=${BACKUP_PASSFILE:-/root/.reflect-backup-pass}
RECIPIENT=${BACKUP_RECIPIENT:-}
REMOTE=${BACKUP_REMOTE:-}
if [[ -n $RECIPIENT ]]; then
  gpg --batch --list-keys "$RECIPIENT" >/dev/null 2>&1 || { echo "BACKUP_RECIPIENT $RECIPIENT isn't in root's keyring (gpg --import <public key>)"; exit 1; }
  encrypt=(--encrypt --recipient "$RECIPIENT" --trust-model always)
else
  [[ -s $PASS ]] || { echo "Missing passphrase file $PASS (put a long random passphrase in it, chmod 600), or set BACKUP_RECIPIENT"; exit 1; }
  echo "WARNING: no BACKUP_RECIPIENT; encrypting with the passphrase kept on this server (see deploy/README.md)"
  encrypt=(--pinentry-mode loopback --passphrase-file "$PASS" --symmetric)
fi
mkdir -p "$DEST" && chmod 700 "$DEST"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$DEST/reflect-$stamp.tar.gz.gpg"
tmp="$out.tmp"
trap 'rm -f "$tmp"' EXIT
# Every key file in the app folder (distributor, faucet, the vault crank/publisher, the curve
# crank: whatever the configs point at), config, state and launches; mainnet/ holds the mainnet
# site's config, launches and keys (when that site runs here).
shopt -s nullglob
items=(config.json state factory)
for f in "$APP"/*.keypair.json; do items+=("$(basename "$f")"); done
[[ -d $APP/mainnet ]] && items+=(mainnet)
# Written to a temp file and renamed only when both tar and gpg succeed (pipefail), so a
# failed run never leaves a truncated archive that looks like a backup. tar's errors go to
# the log (cron appends stderr to /var/log/reflect-backup.log).
tar -C "$APP" -czf - "${items[@]}" \
  | gpg --batch --yes --cipher-algo AES256 "${encrypt[@]}" -o "$tmp"
# Check what was written: a non-empty OpenPGP message for the expected key (or passphrase).
[[ -s $tmp ]] || { echo "Backup is empty"; exit 1; }
packets=$(gpg --batch --list-packets --pinentry-mode cancel "$tmp" 2>&1 </dev/null || true)
if [[ -n $RECIPIENT ]]; then
  keyids=$(gpg --batch --with-colons --list-keys "$RECIPIENT" | awk -F: '$1=="pub"||$1=="sub"{print $5}')
  grep -i 'pubkey enc packet' <<< "$packets" | grep -qiF -f <(printf '%s\n' "$keyids") \
    || { echo "Backup isn't encrypted to $RECIPIENT"; exit 1; }
else
  grep -qi 'symkey enc packet' <<< "$packets" || { echo "Backup isn't a passphrase-encrypted OpenPGP file"; exit 1; }
fi
chmod 600 "$tmp" && mv "$tmp" "$out"
trap - EXIT
# Keep the newest 30.
# shellcheck disable=SC2012
ls -1t "$DEST"/reflect-*.tar.gz.gpg | tail -n +31 | xargs -r rm -f
echo "Backup written: $out"
# Off the server: a backup on the same disk is lost with the server.
if [[ -n $REMOTE ]]; then
  rclone copy "$out" "$REMOTE" && echo "Copied to $REMOTE"
else
  echo "WARNING: no BACKUP_REMOTE; this backup is only on this server"
fi
