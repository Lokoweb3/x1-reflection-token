#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the reflection token, the 99 + Tax
# site and their distributors. Run as root:
#   DOMAIN=launch.example.com bash deploy/setup.sh
# Then copy your secrets over (see deploy/README.md) and start the services.
set -euo pipefail
# Either DOMAIN (this server serves HTTPS itself) or VERCEL_HOST (Vercel serves HTTPS and
# forwards to this server over HTTPS and a secret path; see deploy/README.md). In Vercel mode
# ORIGIN_HOST is this server's own name for that hop (default: <its IP>.sslip.io).
if [[ -z "${DOMAIN:-}" && -z "${VERCEL_HOST:-}" ]]; then
  echo "Set DOMAIN=launch.example.com, or VERCEL_HOST=yourname.vercel.app"; exit 1
fi
# Plain hostnames only: these go into sed expressions and the Caddyfile.
HOST_RE='^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'
for v in DOMAIN VERCEL_HOST ORIGIN_HOST; do
  [[ -z "${!v:-}" || "${!v}" =~ $HOST_RE ]] || { echo "$v=${!v} isn't a hostname like launch.example.com"; exit 1; }
done
APP=/opt/x1-reflection-token
REPO=${REPO:-https://github.com/Lokoweb3/x1-reflection-token.git}

echo "== packages"
apt-get update -y
apt-get install -y curl git ufw gpg rclone debian-keyring debian-archive-keyring apt-transport-https ca-certificates
# Node and Caddy come from their vendors' apt repos. Each repo's signing key is checked
# against a pinned fingerprint before apt trusts it (no piping a script into bash), and apt
# then verifies every package against that key. NODE_VERSION / CADDY_VERSION (e.g. 22.11.0-1nodesource1,
# 2.8.4) pin exact package versions; without them the newest in the pinned repo is installed.
NODESOURCE_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4   # NSolid <nsolid-gpg@nodesource.com>
CADDY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34        # Caddy Web Server <contact@caddyserver.com>
install_key() {   # <url> <expected fingerprint> <keyring file>
  local tmp got n
  tmp=$(mktemp)
  curl -fsSL "$1" -o "$tmp"
  n=$(gpg --show-keys --with-colons "$tmp" | grep -c '^pub:' || true)
  got=$(gpg --show-keys --with-colons "$tmp" | awk -F: '$1=="fpr"{print $10; exit}')
  if [[ $n != 1 || $got != "$2" ]]; then
    echo "Signing key at $1 has fingerprint ${got:-none} ($n keys); expected $2. Refusing to trust it."; rm -f "$tmp"; exit 1
  fi
  gpg --dearmor < "$tmp" > "$3.tmp" && mv "$3.tmp" "$3"
  rm -f "$tmp"
}
if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  install_key https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "$NODESOURCE_FPR" /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  # Prefer NodeSource's nodejs over Ubuntu's older one.
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
  apt-get update -y && apt-get install -y "nodejs${NODE_VERSION:+=$NODE_VERSION}"
fi
if ! command -v caddy >/dev/null; then
  install_key https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_FPR" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y "caddy${CADDY_VERSION:+=$CADDY_VERSION}"
fi

echo "== app user and code"
id reflect >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin reflect
if [[ ! -d $APP/.git ]]; then git clone "$REPO" "$APP"; else git -C "$APP" pull --ff-only; fi
mkdir -p "$APP/state" "$APP/factory"
chown -R reflect:reflect "$APP"
chmod 700 "$APP/state" "$APP/factory"
sudo -u reflect bash -c "cd $APP && npm ci"   # tsx (a dev dependency) runs the services

echo "== services"
cp "$APP"/deploy/systemd/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor

if [[ -n "${DOMAIN:-}" ]]; then
  echo "== HTTPS (Caddy) for $DOMAIN"
  sed "s/__DOMAIN__/$DOMAIN/" "$APP/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
else
  if [[ -z "${ORIGIN_HOST:-}" ]]; then
    IP=$(curl -fsS --max-time 15 https://api.ipify.org || true)
    [[ $IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "Couldn't get this server's IPv4 address from api.ipify.org (got '$IP'); set ORIGIN_HOST"; exit 1; }
    ORIGIN_HOST=$(tr . - <<< "$IP").sslip.io
  fi
  echo "== Caddy backend for Vercel ($VERCEL_HOST), over HTTPS as $ORIGIN_HOST"
  SECRET_FILE=/root/.reflect-vercel-secret
  [[ -s $SECRET_FILE ]] || { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
  echo "$ORIGIN_HOST" > /root/.reflect-origin-host
  SECRET=$(cat "$SECRET_FILE")
  [[ $SECRET =~ ^[A-Za-z0-9]{16,}$ ]] || { echo "$SECRET_FILE should hold 16+ letters and digits"; exit 1; }
  sed -e "s/__SECRET__/$SECRET/" -e "s/__PUBLIC_HOST__/$VERCEL_HOST/" -e "s/__ORIGIN_HOST__/$ORIGIN_HOST/" \
    "$APP/deploy/Caddyfile.vercel.template" > /etc/caddy/Caddyfile
  # The X-Origin-Auth header secret Vercel adds (checked by the Caddyfile). It reaches Caddy
  # through its environment, so it isn't in the Caddyfile; both values match outside a rotation.
  ORIGIN_ENV=/etc/caddy/reflect-origin.env
  if [[ ! -s $ORIGIN_ENV ]]; then
    h=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)
    (umask 077; printf 'REFLECT_ORIGIN_SECRET=%s\nREFLECT_ORIGIN_SECRET_NEXT=%s\n' "$h" "$h" > "$ORIGIN_ENV")
  fi
  mkdir -p /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironmentFile=%s\n' "$ORIGIN_ENV" > /etc/systemd/system/caddy.service.d/reflect-origin.conf
  systemctl daemon-reload
fi
systemctl reload caddy || systemctl restart caddy

echo "== firewall"
# Oracle Cloud's Ubuntu images ship iptables rules that reject everything but SSH, ahead
# of ufw's own rules. Let web traffic through them too (and keep it across reboots).
if [[ -f /etc/iptables/rules.v4 ]] && grep -q "icmp-host-prohibited" /etc/iptables/rules.v4; then
  echo "   (Oracle Cloud image detected: opening 80/443 in its iptables rules)"
  for port in 443 80; do
    iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null \
      || iptables -I INPUT 5 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save
fi
# SKIP_FIREWALL=1 on a server that already runs other things with the firewall off:
# enabling ufw here would cut off their ports. The app itself listens on 127.0.0.1 only.
if [[ "${SKIP_FIREWALL:-}" == 1 ]]; then
  echo "   (skipped: SKIP_FIREWALL=1; only Caddy's ports 80/443 are new on this server)"
else
  ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
fi

echo "== daily encrypted backup (03:15 UTC)"
# The passphrase is the fallback until a public key is set up: see deploy/README.md "Backups"
# (BACKUP_RECIPIENT and BACKUP_REMOTE in /etc/reflect-backup.env).
[[ -s /root/.reflect-backup-pass ]] || { head -c 48 /dev/urandom | base64 > /root/.reflect-backup-pass; chmod 600 /root/.reflect-backup-pass; }
echo "15 3 * * * root $APP/deploy/backup.sh >> /var/log/reflect-backup.log 2>&1" > /etc/cron.d/reflect-backup

HOST=${DOMAIN:-$VERCEL_HOST}
cat <<DONE

Setup done. The services are enabled but NOT started yet. Next:
  1. Stop the distributors on your laptop (never run two copies at once).
  2. Copy config.json, *.keypair.json, state/ and factory/ to $APP (deploy/README.md).
  3. In config.json set factory.publicUrl to https://$HOST and factory.hosts to ["$HOST"].
  4. systemctl start reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor
  5. Save /root/.reflect-backup-pass somewhere safe. Without it the backups can't be decrypted.
DONE
if [[ -z "${DOMAIN:-}" ]]; then
  cat <<VDONE
  6. Vercel front door: on your own machine run
       npx vercel env add REFLECT_ORIGIN_SECRET production   # the REFLECT_ORIGIN_SECRET value in /etc/caddy/reflect-origin.env
       BACKEND=https://$(cat /root/.reflect-origin-host) SECRET=<cat /root/.reflect-vercel-secret> bash deploy/vercel-deploy.sh
     (keep both secrets private; they're what stop people bypassing Vercel).
VDONE
fi
