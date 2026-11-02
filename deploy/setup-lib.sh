# Shared by deploy/setup.sh and deploy/origin-gate.sh (sourced, not run). Paths can be overridden
# so test/origin-gate.test.ts and test/setup-lib.test.ts can run all of this on throwaway folders.
ORIGIN_ENV=${ORIGIN_ENV:-/etc/caddy/reflect-origin.env}
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
CADDY_DROPIN=${CADDY_DROPIN:-/etc/systemd/system/caddy.service.d/reflect-origin.conf}
DEPLOY_DIR=${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}

# Letters and digits only: this text lands inside the Caddyfile before Caddy tokenizes it, and in a
# header matcher a * is a wildcard, so anything else could change what the config means.
origin_secret_ok() { [[ ${1:-} =~ ^[A-Za-z0-9]{32,}$ ]]; }

# Both header secrets, from the environment. Run before Caddy starts or reloads.
origin_check_env() {
  local v bad=0
  for v in REFLECT_ORIGIN_SECRET REFLECT_ORIGIN_SECRET_NEXT; do
    if ! origin_secret_ok "${!v:-}"; then
      if [[ -z ${!v:-} ]]; then echo "$v is unset" >&2; else echo "$v isn't 32+ letters and digits" >&2; fi
      bad=1
    fi
  done
  return "$bad"
}

# Reads $ORIGIN_ENV into this subshell's environment and checks it.
origin_check_file() (
  [[ -r $ORIGIN_ENV ]] || { echo "Can't read $ORIGIN_ENV" >&2; exit 1; }
  unset REFLECT_ORIGIN_SECRET REFLECT_ORIGIN_SECRET_NEXT
  set -a; . "$ORIGIN_ENV"; set +a
  origin_check_env || { echo "Fix $ORIGIN_ENV: see deploy/README.md" >&2; exit 1; }
)

# Creates the secrets once; an existing file is kept (and must be valid).
origin_ensure_env_file() {
  if [[ ! -s $ORIGIN_ENV ]]; then
    local h
    h=$(head -c 48 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9' | cut -c1-48)
    origin_secret_ok "$h" || { echo "Couldn't generate a header secret" >&2; return 1; }
    (umask 077; printf 'REFLECT_ORIGIN_SECRET=%s\nREFLECT_ORIGIN_SECRET_NEXT=%s\n' "$h" "$h" > "$ORIGIN_ENV")
  fi
  origin_check_file
}

# Caddy's unit gets the secrets from the env file and checks them before starting or reloading.
# The vendor unit runs `caddy run --environ`, which prints every variable, these secrets included,
# to the journal: the override drops that flag. A missing env file stops the unit from starting.
origin_write_dropin() {
  local caddy_bin=${CADDY_BIN:-/usr/bin/caddy}
  mkdir -p "$(dirname "$CADDY_DROPIN")"
  cat > "$CADDY_DROPIN" <<UNIT
[Service]
EnvironmentFile=$ORIGIN_ENV
ExecStartPre=$DEPLOY_DIR/origin-gate.sh check-env
ExecStart=
ExecStart=$caddy_bin run --config $CADDYFILE
ExecReload=
ExecReload=$DEPLOY_DIR/origin-gate.sh check-env
ExecReload=$caddy_bin reload --config $CADDYFILE --force
UNIT
  systemctl daemon-reload
}

# render_vercel_caddyfile <enforce|observe> <path secret> <public host> <origin host>: to stdout.
# The /g matters: the path matcher has the secret twice on one line.
render_vercel_caddyfile() {
  local template
  case $1 in
    enforce) template=$DEPLOY_DIR/Caddyfile.vercel.template ;;
    observe) template=$DEPLOY_DIR/Caddyfile.vercel.observe.template ;;
    *) echo "Mode must be enforce or observe, not '$1'" >&2; return 1 ;;
  esac
  sed -e "s/__SECRET__/$2/g" -e "s/__PUBLIC_HOST__/$3/g" -e "s/__ORIGIN_HOST__/$4/g" "$template"
}

# True for a Caddyfile that serves something (the vendor's default only has a commented-out example).
caddyfile_is_live() { [[ -f $1 ]] && grep -Eq '^[[:space:]]*(reverse_proxy|@[A-Za-z_]+)' "$1"; }

# Refuses a config that still has a placeholder or the old published fallback, then asks Caddy.
# Caddy resolves {$...} while parsing, so it needs the secrets in its environment here too.
caddyfile_validate() (
  if grep -nE '^[^#]*(__[A-Z_]+__|origin-secret-unset|\{\$REFLECT_ORIGIN_SECRET[A-Z_]*:)' "$1" >&2; then
    echo "$1 has a placeholder or a default value for a secret: refusing it" >&2; exit 1
  fi
  # A config that names a secret needs the env file; the DOMAIN template names none.
  if [[ -e $ORIGIN_ENV ]] || grep -q 'REFLECT_ORIGIN_SECRET' "$1"; then
    origin_check_file || exit 1
    set -a; . "$ORIGIN_ENV"; set +a
  fi
  caddy validate --adapter caddyfile --config "$1"
)

# Validates <candidate>, installs it as $CADDYFILE and reloads Caddy. If the reload fails the old
# file goes back: Caddy keeps serving the config it already has either way.
caddyfile_install() {
  local candidate=$1 backup="" tmp
  caddyfile_validate "$candidate" || { echo "Not installed: $CADDYFILE is unchanged" >&2; return 1; }
  if [[ -f $CADDYFILE ]]; then
    backup="$CADDYFILE.bak-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    cp -p "$CADDYFILE" "$backup" && chmod 600 "$backup"
  fi
  tmp=$CADDYFILE.new-$$
  cp "$candidate" "$tmp"
  # It holds the path secret: readable by Caddy, not by the app's user.
  if [[ $(id -u) == 0 ]] && id caddy >/dev/null 2>&1; then chown root:caddy "$tmp" && chmod 640 "$tmp"; else chmod 600 "$tmp"; fi
  mv "$tmp" "$CADDYFILE"
  if systemctl is-active --quiet caddy; then
    if ! systemctl reload caddy; then
      echo "Caddy refused the reload: putting the old file back. It's still serving its previous config." >&2
      if [[ -n $backup ]]; then cp -p "$backup" "$CADDYFILE"; if [[ $(id -u) == 0 ]] && id caddy >/dev/null 2>&1; then chown root:caddy "$CADDYFILE" && chmod 640 "$CADDYFILE"; fi; fi
      return 1
    fi
  else
    systemctl restart caddy
  fi
  [[ -z $backup ]] || echo "Previous config kept as $backup"
}

# Installs <package> at the operator's exact version, or stops. <add repo function> runs only if
# something needs installing. A pin is never ignored because some other version is already there.
# ensure_package_pin <package> <version> <add repo function>
ensure_package_pin() {
  local pkg=$1 pin=$2 add_repo=$3 cur
  [[ $pin =~ ^[A-Za-z0-9.+~:-]+$ ]] || { echo "Version '$pin' for $pkg isn't a package version" >&2; return 1; }
  cur=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)
  if [[ $cur == "$pin" ]]; then echo "   $pkg is already at the pinned $pin"; return 0; fi
  echo "   $pkg: installed ${cur:-nothing}, pinned $pin: installing the pinned version"
  "$add_repo" && apt-get update -y
  # Downgrades too: the operator asked for this exact version.
  apt-get install -y --allow-downgrades "$pkg=$pin" \
    || { echo "Couldn't install $pkg=$pin. Check the exact version with: apt-cache madison $pkg" >&2; return 1; }
  cur=$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || true)
  [[ $cur == "$pin" ]] || { echo "$pkg is at '${cur:-nothing}' after installing the pinned $pin" >&2; return 1; }
}

# The services need Node 22 or newer. Pinned: exactly that version; not pinned: only if it's missing or older.
# ensure_node <add repo function>
ensure_node() {
  if [[ -n ${NODE_VERSION:-} ]]; then
    local major=${NODE_VERSION#*:}; major=${major%%.*}
    [[ $major =~ ^[0-9]+$ && $major -ge 22 ]] || { echo "NODE_VERSION=$NODE_VERSION: the services need Node 22 or newer" >&2; return 1; }
    ensure_package_pin nodejs "$NODE_VERSION" "$1"
  elif ! command -v node >/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
    "$1" && apt-get update -y && apt-get install -y nodejs
  fi
}

# ensure_caddy <add repo function>
ensure_caddy() {
  if [[ -n ${CADDY_VERSION:-} ]]; then
    ensure_package_pin caddy "$CADDY_VERSION" "$1"
  elif ! command -v caddy >/dev/null; then
    "$1" && apt-get update -y && apt-get install -y caddy
  fi
}
