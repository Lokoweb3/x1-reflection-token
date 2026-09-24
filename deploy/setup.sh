#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for the reflection token, the 99 + Tax
# site and their distributors. Run as root:
#   DOMAIN=launch.example.com bash deploy/setup.sh
# Then copy your secrets over (see deploy/README.md) and start the services.
set -euo pipefail
: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=launch.example.com}"
APP=/opt/x1-reflection-token
REPO=${REPO:-https://github.com/Lokoweb3/x1-reflection-token.git}

echo "== packages"
apt-get update -y
apt-get install -y curl git ufw gpg debian-keyring debian-archive-keyring apt-transport-https ca-certificates
if ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
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

echo "== HTTPS (Caddy) for $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/" "$APP/deploy/Caddyfile.template" > /etc/caddy/Caddyfile
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
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

echo "== daily encrypted backup (03:15 UTC)"
[[ -s /root/.reflect-backup-pass ]] || { head -c 48 /dev/urandom | base64 > /root/.reflect-backup-pass; chmod 600 /root/.reflect-backup-pass; }
echo "15 3 * * * root $APP/deploy/backup.sh >> /var/log/reflect-backup.log 2>&1" > /etc/cron.d/reflect-backup

cat <<DONE

Setup done. The services are enabled but NOT started yet. Next:
  1. Stop the distributors on your laptop (never run two copies at once).
  2. Copy config.json, distributor.keypair.json, state/ and factory/ to $APP (deploy/README.md).
  3. In config.json set factory.publicUrl to https://$DOMAIN and factory.hosts to ["$DOMAIN"].
  4. systemctl start reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor
  5. Save /root/.reflect-backup-pass somewhere safe. Without it the backups can't be decrypted.
DONE
