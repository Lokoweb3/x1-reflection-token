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
#
# A run either leaves an archive it has checked or exits non-zero and leaves none.
set -euo pipefail
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/reflect-backup.env}
# shellcheck disable=SC1090
if [[ -r $BACKUP_ENV_FILE ]]; then . "$BACKUP_ENV_FILE"; fi
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
work=$(mktemp -d)   # names only, never contents
lister=""
cleanup() { [[ -z $lister ]] || kill "$lister" 2>/dev/null || true; rm -rf "$tmp" "$work"; }
trap cleanup EXIT
# Every key file in the app folder (distributor, faucet, the vault crank/publisher, the curve
# crank: whatever the configs point at), config, state and launches, finished or pending
# (factory/pending-launches holds distributor keys); mainnet/ holds the mainnet site's config,
# launches and keys (when that site runs here).
shopt -s nullglob
items=(config.json state factory)
for f in "$APP"/*.keypair.json "$APP"/*-keypair.json; do items+=("$(basename "$f")"); done
[[ -d $APP/mainnet ]] && items+=(mainnet)
# A backup with no keys in it would still be a valid, encrypted, non-empty file. Refuse it.
missing=""
for need in config.json state factory; do [[ -e $APP/$need ]] || missing+=" $need"; done
if [[ -d $APP/mainnet && ! -e $APP/mainnet/config.json ]]; then missing+=" mainnet/config.json"; fi
if [[ -n $missing ]]; then echo "Not backing up: $APP has no$missing"; exit 1; fi
keys=$(cd "$APP" && find "${items[@]}" -type f \( -name '*keypair.json' -o -name 'distributor.json' \) | wc -l)
if [[ $keys == 0 ]]; then echo "Not backing up: no key files under $APP (is this the right folder, or are they links?)"; exit 1; fi
# tar exits 1 if a file changed or vanished while it was read, which happens all the time here
# (lock files and journals of running services): the archive is good, so that's only a warning.
# Anything worse stops the run. tar's messages go to the log (cron appends stderr to
# /var/log/reflect-backup.log).
archive() {
  local rc=0
  tar -C "$APP" -czf - "${items[@]}" || rc=$?
  if [[ $rc == 1 ]]; then echo "WARNING: some files changed while being read (see tar's messages above); the rest of the backup is fine" >&2; return 0; fi
  return "$rc"
}
# Written to a temp file and renamed only when tar and gpg succeed (pipefail) and the checks below
# pass, so a failed run never leaves a truncated archive that looks like a backup. The stream is
# also listed on its way to gpg: this proves a complete gzip/tar, and gives the names to check,
# even when this server can't decrypt its own backups.
mkfifo "$work/stream"
tar -tzf - < "$work/stream" > "$work/names" &
lister=$!
archive | tee "$work/stream" | gpg --batch --yes --cipher-algo AES256 "${encrypt[@]}" -o "$tmp"
wait "$lister" || { lister=""; echo "The archive stream isn't a readable tar.gz"; exit 1; }
lister=""
for need in config.json state/ factory/; do
  grep -qxF "$need" "$work/names" || { echo "Backup has no $need"; exit 1; }
done
grep -Eq '(keypair\.json|/distributor\.json)$' "$work/names" || { echo "Backup has no key files"; exit 1; }
count=$(wc -l < "$work/names")
# Check what was written: a non-empty OpenPGP message for the expected key (or passphrase).
[[ -s $tmp ]] || { echo "Backup is empty"; exit 1; }
packets=$(gpg --batch --list-packets --pinentry-mode cancel "$tmp" 2>&1 </dev/null || true)
if [[ -n $RECIPIENT ]]; then
  keyids=$(gpg --batch --with-colons --list-keys "$RECIPIENT" | awk -F: '$1=="pub"||$1=="sub"{print $5}')
  grep -i 'pubkey enc packet' <<< "$packets" | grep -qiF -f <(printf '%s\n' "$keyids") \
    || { echo "Backup isn't encrypted to $RECIPIENT"; exit 1; }
else
  grep -qi 'symkey enc packet' <<< "$packets" || { echo "Backup isn't a passphrase-encrypted OpenPGP file"; exit 1; }
  # With the passphrase here the whole way back can be tried: decrypt to a pipe, nothing on disk.
  back=$(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASS" -d "$tmp" | tar -tzf - | wc -l)
  [[ $back == "$count" ]] || { echo "Decrypting the backup gave $back entries, not $count"; exit 1; }
fi
chmod 600 "$tmp" && mv "$tmp" "$out"
# Keep the newest 30.
# shellcheck disable=SC2012
ls -1t "$DEST"/reflect-*.tar.gz.gpg | tail -n +31 | xargs -r rm -f
echo "Backup written: $out ($count entries, $keys key files)"
# Off the server: a backup on the same disk is lost with the server.
if [[ -n $REMOTE ]]; then
  rclone copy "$out" "$REMOTE"
  echo "Copied to $REMOTE"
else
  echo "WARNING: no BACKUP_REMOTE; this backup is only on this server"
fi
