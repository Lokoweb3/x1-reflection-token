#!/usr/bin/env bash
# The X-Origin-Auth gate on the Vercel backend: see deploy/README.md "Moving a live front door
# onto the header secret". Run as root on the server.
#
#   origin-gate.sh provision         create the secrets and Caddy's systemd drop-in; Caddy keeps
#                                    its current config, so nothing is enforced by this
#   origin-gate.sh render <enforce|observe> <path secret> <public host> <origin host>
#                                    print a one-front-door config (to a file you then check)
#   origin-gate.sh apply <file>      refuse a bad secret or config, else install <file> and reload;
#                                    a failed reload puts the old file back
#   origin-gate.sh verify <enforce|observe>
#                                    env ORIGIN_URL=https://<origin host>/<path secret>
#                                    FRONT_DOOR=https://<project>.vercel.app: check what each kind
#                                    of request gets; exit 1 on any surprise. Once per front door.
#   origin-gate.sh check-env         both secrets are set and well-formed (Caddy's unit runs this)
set -euo pipefail
. "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/setup-lib.sh"

# probe <url> [header value]: prints "<status> <seen>". The URL and secret go to curl through a
# config on a file descriptor, so neither shows in ps. Empty status when nothing answered.
probe() {
  local head
  head=$(curl -sS -o /dev/null -D - --max-time 20 \
    -K <(printf 'url = "%s"\n' "$1"; [[ -z ${2:-} ]] || printf 'header = "X-Origin-Auth: %s"\n' "$2")) \
    || { echo "000 no"; return 0; }
  awk 'BEGIN{c="000"; s="no"}
       /^HTTP\//{c=$2; s="no"}
       tolower($1)=="x-origin-auth-seen:"{s="yes"}
       END{print c, s}' <<< "${head//$'\r'/}"
}

verify() {
  local mode=${1:-} fail=0
  [[ $mode == enforce || $mode == observe ]] || { echo "verify <enforce|observe>" >&2; exit 2; }
  : "${ORIGIN_URL:?Set ORIGIN_URL=https://<origin host>/<path secret>}" "${FRONT_DOOR:?Set FRONT_DOOR=https://<project>.vercel.app}"
  origin_check_file
  local REFLECT_ORIGIN_SECRET REFLECT_ORIGIN_SECRET_NEXT
  set -a; . "$ORIGIN_ENV"; set +a
  local base=${ORIGIN_URL%/} host_root
  host_root=$(sed -E 's#^(https?://[^/]+).*#\1#' <<< "$base")
  # check <what> <url> <header> <expected status: 404 or ok> <expected seen: yes|no>
  check() {
    local got code seen status=pass
    got=$(probe "$2" "$3"); code=${got% *}; seen=${got#* }
    if [[ $4 == 404 && $code != 404 ]]; then status=FAIL; fi
    if [[ $4 == ok && ! $code =~ ^[23] ]]; then status=FAIL; fi
    [[ $seen == "$5" ]] || status=FAIL
    [[ $status == pass ]] || fail=1
    printf '%-4s  %-42s status %s (want %s), X-Origin-Auth-Seen %s (want %s)\n' "$status" "$1" "$code" "$4" "$seen" "$5"
  }
  local no_header_status=404
  [[ $mode == observe ]] && no_header_status=ok
  local seen_when_authed=no
  [[ $mode == observe ]] && seen_when_authed=yes
  check "origin, no header"              "$base/" ""                            "$no_header_status" no
  check "origin, wrong header"           "$base/" "not-the-secret"              "$no_header_status" no
  check "origin, REFLECT_ORIGIN_SECRET"  "$base/" "$REFLECT_ORIGIN_SECRET"      ok "$seen_when_authed"
  check "origin, REFLECT_ORIGIN_SECRET_NEXT" "$base/" "$REFLECT_ORIGIN_SECRET_NEXT" ok "$seen_when_authed"
  check "origin, header but no path secret" "$host_root/" "$REFLECT_ORIGIN_SECRET" 404 no
  check "front door"                     "${FRONT_DOOR%/}/" ""                  ok "$seen_when_authed"
  if [[ $fail == 0 ]]; then echo "All as expected for $mode."; else echo "Something isn't as expected for $mode: don't go on to the next step." >&2; fi
  return "$fail"
}

case ${1:-} in
  check-env) origin_check_env ;;
  provision)
    mkdir -p "$(dirname "$ORIGIN_ENV")"
    origin_ensure_env_file
    # The config as it was before any of this, to go back to.
    if [[ -f $CADDYFILE && ! -e $CADDYFILE.pre-origin-auth ]]; then cp -p "$CADDYFILE" "$CADDYFILE.pre-origin-auth"; chmod 600 "$CADDYFILE.pre-origin-auth"; fi
    origin_write_dropin
    echo "Secrets in $ORIGIN_ENV, drop-in at $CADDY_DROPIN. Caddy hasn't been reloaded and enforces nothing new."
    ;;
  render) shift; [[ $# == 4 ]] || { echo "render <enforce|observe> <path secret> <public host> <origin host>" >&2; exit 2; }; render_vercel_caddyfile "$@" ;;
  apply) [[ -f ${2:-} ]] || { echo "apply <file>" >&2; exit 2; }; caddyfile_install "$2" ;;
  verify) shift; verify "$@" ;;
  *) sed -n '2,16p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
esac
