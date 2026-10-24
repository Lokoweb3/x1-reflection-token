#!/usr/bin/env bash
# Deploy the Vercel front door for the 99 + Tax site. Run on YOUR machine (not the
# server), after `npx vercel login`:
#   BACKEND=https://203-0-113-10.sslip.io SECRET=<from the server> [PROJECT=99tax] bash deploy/vercel-deploy.sh
# Vercel serves https://<project>.vercel.app and forwards every request to
# $BACKEND/$SECRET/... on your server (see deploy/Caddyfile.vercel.template).
# The generated config holds the secret, so it lives in .vercel-site/ (gitignored).
set -euo pipefail
: "${BACKEND:?Set BACKEND, e.g. BACKEND=https://203-0-113-10.sslip.io}"
# The hop from Vercel to the server carries every page and unsigned transaction: plain HTTP
# would let anyone on the path rewrite them before a wallet signs.
[[ $BACKEND == https://* || ${ALLOW_HTTP:-} == 1 ]] || { echo "BACKEND must be https:// (the server's ORIGIN_HOST, see deploy/README.md)"; exit 1; }
: "${SECRET:?Set SECRET (cat /root/.reflect-vercel-secret on the server)}"
PROJECT=${PROJECT:-99tax}
cd "$(dirname "$0")/.."
DIR=${DIR:-.vercel-site}   # a second front door (e.g. testnet) uses its own DIR
mkdir -p "$DIR/public"
: > "$DIR/public/.keep"
cat > "$DIR/vercel.json" <<JSON
{
  "\$schema": "https://openapi.vercel.sh/vercel.json",
  "outputDirectory": "public",
  "rewrites": [
    { "source": "/", "destination": "${BACKEND%/}/${SECRET}/" },
    { "source": "/:path*", "destination": "${BACKEND%/}/${SECRET}/:path*" }
  ]
}
JSON
cd "$DIR"
npx --yes vercel@latest deploy --prod --yes --name "$PROJECT"
echo
echo "Now add the Vercel address to config.json on the server (factory.publicUrl and factory.hosts),"
echo "then: systemctl restart reflect-factory"
