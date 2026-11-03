# Deploying to a VPS

Runs everything on one small always-on server instead of a laptop:

| Service | What it does | Reachable at |
|---|---|---|
| `reflect-factory` | 99 + Tax site: landing page, launch app, Distribute now, and the **Tax Vault crank** for every vault token | `https://<your domain>` (through Caddy) |
| `reflect-distributor` | the main config's token (RFLT) cycle every 30 min, while it's on a distributor | – |
| `reflect-factory-distributor` | every launched token that isn't on the Tax Vault, a cycle every 15–30 min | – |
| `reflect-dashboard` | your private RFLT dashboard | `127.0.0.1:8123` on the server only (SSH tunnel) |

systemd restarts them if they crash and starts them on boot. Logs: `journalctl -u reflect-distributor -f`.

**Tax Vault tokens don't need a distributor.** Their tax is held by the `tax_vault` program
and cranked by the site. When every token on a network is on the vault (testnet today:
CUP, RFLT, every launch and curve token), stop both distributors and keep them from
starting on boot: `systemctl disable --now reflect-distributor reflect-factory-distributor`
(`systemctl enable --now …` brings one back, e.g. for a token that isn't on the vault). The
live server also runs mainnet as `reflect-mainnet-factory` and
`reflect-mainnet-factory-distributor` (mainnet's "Test" has been on the Tax Vault since 1 Oct
2026, so the mainnet distributor only matters for a token that isn't on the vault; see
[docs/MAINNET-ROLLOUT.md](../docs/MAINNET-ROLLOUT.md) for the rollout's status).

**Fees on X1:** X1 charges for the compute units a transaction *requests* (about 0.01 XNT
per million), so every transaction here is simulated first and asks only for what it uses
plus 20% (`fitComputeLimit` in `src/tx.ts`).

## 1. Server and domain

- A VPS with Ubuntu 24.04, 1 vCPU / 1–2 GB RAM is plenty (about $5–10/month).
- Point your domain (e.g. `launch.example.com`) at the server's IP with an `A` record.
- SSH in as root (or use `sudo -i`).

### Free option: Oracle Cloud "Always Free"

1. Sign up at oracle.com/cloud/free. The **home region can't be changed later**; if the
   free ARM servers are "out of capacity" there, you'll have to retry later.
2. **Upgrade the account to Pay As You Go** (Billing → Upgrade). Always Free resources
   stay free, and Oracle stops reclaiming "idle" free servers, which a low-CPU app like
   this would otherwise count as.
3. Compute → Instances → Create instance:
   - Image: **Canonical Ubuntu 24.04**. Shape: **Ampere VM.Standard.A1.Flex**, 1 OCPU /
     6 GB RAM (Always Free eligible).
   - Networking: keep "assign a public IPv4 address". SSH keys: paste your public key
     (`cat ~/.ssh/id_ed25519.pub`; create one with `ssh-keygen -t ed25519` if needed).
4. Open web ports in Oracle's network firewall: the instance's subnet → Security list →
   Add ingress rules: source `0.0.0.0/0`, TCP, destination ports `80` and `443`.
   (`setup.sh` opens them on the server itself; Oracle images block them by default.)
5. SSH in as `ubuntu` (`ssh ubuntu@<public IP>`), run `sudo -i`, and continue below.

### Option: Vercel as the front door (free HTTPS address)

Vercel serves `https://<project>.vercel.app` and forwards every request to your server;
the app, distributors and keys stay on the server (Vercel can't run them).

1. On the server: `VERCEL_HOST=<project>.vercel.app bash deploy/setup.sh` (instead of
   `DOMAIN=`). Caddy then serves HTTPS as the server's own name, `ORIGIN_HOST` (default
   `<IP with dashes>.sslip.io`, a public DNS name that resolves to the IP; set
   `ORIGIN_HOST=origin.example.com` to use your own domain's `A` record instead), only under
   a random secret path saved in `/root/.reflect-vercel-secret`, and only for requests carrying
   the `X-Origin-Auth` header secret from `/etc/caddy/reflect-origin.env` (Caddy reads it from
   its environment through `/etc/systemd/system/caddy.service.d/reflect-origin.conf`);
   everything else gets a 404.
   Port 80 only answers certificate challenges. Keep 80 and 443 open in the firewall
   (DigitalOcean: Networking → Firewalls, or the droplet's own ufw).
2. On your machine: `npx vercel login`, then
   `BACKEND=https://<ORIGIN_HOST> SECRET=<that secret> PROJECT=<project> bash deploy/vercel-deploy.sh`,
   which creates the project and links `.vercel-site/` to it. Pages are a 404 until the next
   step: `cd .vercel-site && npx vercel env add REFLECT_ORIGIN_SECRET production` (the
   `REFLECT_ORIGIN_SECRET` value from `/etc/caddy/reflect-origin.env`; Vercel adds it to every
   forwarded request, so it's never in `vercel.json`), `cd ..`, and run the same `vercel-deploy.sh`
   command again (a new value only reaches a new deployment).
   The hop from Vercel to the server is HTTPS too: over plain HTTP anyone on the path could
   rewrite pages or the transactions a wallet signs (the script refuses an `http://` backend).
   The generated config (with the secret) stays in `.vercel-site/`, which git ignores.
3. In the server's `config.json`: `factory.publicUrl` = `https://<project>.vercel.app`,
   `factory.hosts` = `["<project>.vercel.app"]`, then `systemctl restart reflect-factory`.

Note: Vercel's free Hobby plan is for non-commercial use; a launchpad that charges fees
may need the Pro plan under their terms.

These steps are for a **new** server, which enforces the header from the start. `setup.sh`
refuses to overwrite a Caddyfile that already serves a site (`CADDYFILE_OVERWRITE=1` to override).

### Moving a live front door onto the header secret

A server already live on the path secret alone must not get the enforcing config first: until
Vercel sends the header, every request would be a 404. So the order is: secrets, a config that
only reports, Vercel, a check, and only then enforcement. No step takes the site down, and each
can be undone on its own. Do it on a quiet moment, with the Vercel CLI logged in on your machine.
`deploy/origin-gate.sh` is run as root on the server, from `/opt/x1-reflection-token`.

1. **Secrets, nothing enforced.** `deploy/origin-gate.sh provision`. This creates
   `/etc/caddy/reflect-origin.env` and Caddy's drop-in (the secrets from the env file; a check of
   them before each start and reload; no `--environ`, which would print them to the journal) and
   saves today's config as `/etc/caddy/Caddyfile.pre-origin-auth`. Caddy keeps running as it is.
   Then `systemctl reload caddy`: same config, but it proves the drop-in's check runs as Caddy's
   user. If that fails, the old config is still serving; fix it before going on, because a Caddy
   restart with the same fault would stay down. (`rm` the drop-in and `systemctl daemon-reload` undoes it.)
2. **Observe.** Write the observe config and apply it:
   - One front door: `deploy/origin-gate.sh render observe "$(cat /root/.reflect-vercel-secret)"
     <project>.vercel.app "$(cat /root/.reflect-origin-host)" > /root/Caddyfile.observe`.
   - More than one (the live server has mainnet and testnet), or a Caddyfile changed by hand: copy
     `/etc/caddy/Caddyfile` to `/root/Caddyfile.observe` and change it by hand, keeping every site's
     own host, path secret and port. For each front door, next to its path matcher, add the
     `@authed` matcher and `header @authed X-Origin-Auth-Seen ok` line from
     `deploy/Caddyfile.vercel.observe.template` (with a different matcher name per front door if
     two share a site block), and in its `reverse_proxy` add `header_up -X-Origin-Auth` and
     `header_up X-Forwarded-For {http.request.header.X-Forwarded-For}`, and before that
     `reverse_proxy` the `@noVisitor` matcher and `request_header @noVisitor ...` line from the
     template (a request without the address then counts as whoever connected). Remove the global
     `trusted_proxies 0.0.0.0/0 ::/0` block.

   Then `deploy/origin-gate.sh apply /root/Caddyfile.observe` (it stops on a bad secret, or if
   `caddy validate` refuses the file, before anything changes). Check the site still loads.
3. **Check Caddy sees the header.** For each front door, `ORIGIN_URL=https://<origin host>/<path secret>
   FRONT_DOOR=https://<project>.vercel.app deploy/origin-gate.sh verify observe`. The "front door"
   line fails at this point (Vercel isn't sending it yet); every "origin" line must pass.
4. **Vercel, each front door.** On your machine, with that door's `DIR` and `PROJECT`:
   `cd <DIR> && npx vercel env add REFLECT_ORIGIN_SECRET production && cd ..`, then
   `BACKEND=https://<origin host> SECRET=<its path secret> PROJECT=<project> DIR=<DIR> bash deploy/vercel-deploy.sh`.
   The site keeps working whether or not the header arrives.
5. **Check each door really sends it.** Step 3's command again: now every line must pass,
   including "front door". Also load the site in a browser and try a read through it. **Don't go on
   until this passes for every front door.** If only the "front door" line fails, the value on
   Vercel or the deployment is wrong; fix it and repeat step 4. The site is still up meanwhile.
6. **Enforce.** Write the enforcing config: `render enforce` as in step 2, or by hand, from your
   observe config: per front door, make the path matcher carry the two `header X-Origin-Auth` lines
   as in `deploy/Caddyfile.vercel.template`, and remove the `@authed` matcher and the
   `X-Origin-Auth-Seen` line. Then `deploy/origin-gate.sh apply /root/Caddyfile.enforce`.
7. **Check enforcement.** For each door, `... deploy/origin-gate.sh verify enforce`: the origin
   without the right header must be a 404, the front door must still work. Keep a browser on the
   site for a few minutes.

**Rollback.** At any step, `deploy/origin-gate.sh apply /root/Caddyfile.observe` goes back to
observing (the site works with or without the header), or
`deploy/origin-gate.sh apply /etc/caddy/Caddyfile.pre-origin-auth` to the config from before. Each
is one reload, with no Vercel change needed: a header Caddy doesn't check does no harm. A bad
Vercel deployment: `npx vercel rollback` in that door's `DIR`. Only once enforcement has held for a
while, delete `/root/Caddyfile.observe` and `/etc/caddy/Caddyfile.pre-origin-auth`: observe
mode lets the path secret alone through, so it isn't a place to stay.

After enforcement, a Vercel deployment on a project without `REFLECT_ORIGIN_SECRET` is a 404 on
every page: run `verify enforce` after anything that touches a front door.

An unset or malformed secret (under 32 letters and digits) never serves requests on a default:
`apply` and each reload refuse it and Caddy keeps its running config; a Caddy start refuses it,
so Caddy stays down. Fix `/etc/caddy/reflect-origin.env` and `systemctl start caddy`.

## 2. Install

```bash
git clone https://github.com/Lokoweb3/x1-reflection-token.git /opt/x1-reflection-token
DOMAIN=launch.example.com bash /opt/x1-reflection-token/deploy/setup.sh
```

This installs Node 22 and Caddy, creates a locked-down `reflect` user, installs the
app, the four services (enabled but not started), HTTPS for your domain, a firewall
(SSH, 80, 443 only) and a daily encrypted backup.

## 3. Move your secrets (and stop the laptop first)

**Never run two copies of a distributor at once.** Both would pay out from separate
journals. On the laptop:

```bash
cd ~/X1_PROJECTS/REFLECTION_TOKEN
npm run distributor:stop && npm run factory:stop
```

Then copy the files that can't be recreated (from the laptop):

```bash
cd ~/X1_PROJECTS/REFLECTION_TOKEN
scp config.json distributor.keypair.json faucet.keypair.json root@SERVER:/opt/x1-reflection-token/
scp -r state factory root@SERVER:/opt/x1-reflection-token/
```

On the server:

```bash
cd /opt/x1-reflection-token
chown -R reflect:reflect config.json distributor.keypair.json faucet.keypair.json state factory
chmod 600 config.json distributor.keypair.json faucet.keypair.json && chmod 700 state factory
```

Edit `config.json` on the server:
- `factory.publicUrl`: `"https://launch.example.com"`
- `factory.hosts`: `["launch.example.com"]`

Your creator/deployer key (`~/.config/solana/id.json`) is **not** needed on the server.
Keep it on your own machine; you only need it for admin actions and deploys.

## 4. Start

```bash
systemctl start reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor
systemctl status reflect-* --no-pager
```

Open `https://launch.example.com`. To see your private dashboard from your laptop:

```bash
ssh -L 8123:127.0.0.1:8123 root@SERVER    # then open http://127.0.0.1:8123
```

## Pool gap monitor (optional)

`scripts/gap-monitor.ts` watches every XDEX pool holding a token (TEST/JACK, TEST/USDC.X, ...)
against its main XNT pool and alerts when a round trip between them would pay after every fee
and the token's transfer tax (twice). With a 5% tax that takes a gap of about 10.5%, so most of
the time it only logs. It is read-only: no keys, never trades.

```bash
cp deploy/systemd/reflect-gap-monitor.service /etc/systemd/system/ && systemctl daemon-reload
# Optional: where alerts go (both Telegram values are needed; or GAP_ARGS="--webhook https://...")
printf 'TELEGRAM_BOT_TOKEN=...\nTELEGRAM_CHAT_ID=...\n' > /etc/reflect-gap-monitor.env && chmod 600 /etc/reflect-gap-monitor.env
systemctl enable --now reflect-gap-monitor
journalctl -u reflect-gap-monitor -f     # one line a minute: each pool's gap and what a round trip would return
```

Run it by hand anywhere with `npx tsx scripts/gap-monitor.ts --mint <mint> --once` (see the
file's header for `--min-profit`, `--gap`, `--remind`, `--webhook`).

## Security checklist

The server never holds users' keys, but it builds the transactions they sign, so a
taken-over server could hand them a draining transaction. Keep it locked down:

- **SSH key-only.** Once your key login works, set `PasswordAuthentication no` and
  `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`, then `systemctl restart ssh`.
  Test in a second terminal before closing the first.
- **Firewall:** only 22, 80 and 443 open (`setup.sh` does this). The app itself listens
  on 127.0.0.1 only.
- **Vercel mode:** the secret path in `/root/.reflect-vercel-secret` and the `X-Origin-Auth`
  header secret are what keep the server from being called directly; both only travel over
  HTTPS. Vercel's outgoing addresses are a shared, changing pool it doesn't publish, so Caddy
  can't trust "Vercel's IPs"; it passes on the visitor address Vercel sets (`X-Forwarded-For`)
  only for requests that carry the header secret. Never commit the generated `vercel.json`; if
  the path secret leaks, make a new one and re-run `deploy/vercel-deploy.sh`.
- **Rotating the header secret** (yearly, when someone with access leaves, or if it leaks), with
  no downtime, as root on the server:
  1. `new=$(head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 48)`, set
     `REFLECT_ORIGIN_SECRET_NEXT=$new` in `/etc/caddy/reflect-origin.env`, `systemctl reload caddy`.
     Caddy now accepts the old and the new value.
  2. On your machine, for each Vercel project, in its `DIR`: `npx vercel env rm REFLECT_ORIGIN_SECRET production`,
     `npx vercel env add REFLECT_ORIGIN_SECRET production` (the new value), and redeploy
     (`deploy/vercel-deploy.sh`, with that project's `DIR`/`PROJECT`) so it takes effect.
  3. Check the site loads, then set `REFLECT_ORIGIN_SECRET=$new` too and `systemctl reload caddy`:
     the old value stops working.
  Check: `ORIGIN_URL=... FRONT_DOOR=... deploy/origin-gate.sh verify enforce` (see above).
- **Faucet captcha:** create a free Cloudflare Turnstile widget (dash.cloudflare.com →
  Turnstile, add your domain) and put its keys in `config.json` as
  `factory.turnstile: { "siteKey": "...", "secret": "..." }` (or `TURNSTILE_SECRET` in the
  environment). Without it the faucet relies on per-wallet, per-IP and daily limits only.
- **Hot wallets small:** keep only what's needed in the faucet and distributor wallets.
  The Pinata key only needs Files: Write.
- Built in: per-address and site-wide request limits (429 when exceeded), `/api/send`
  only relays transactions for this site's programs, and security headers (CSP,
  `frame-ancestors 'none'`) on every page.

## 5. Backups

`deploy/backup.sh` runs daily at 03:15 UTC and writes an encrypted archive of
`config.json`, every `*.keypair.json` and `*-keypair.json`, `state/`, `factory/` (with
`factory/pending-launches/`) and `mainnet/` to `/var/backups/reflect` (keeps 30), then copies it
off the server. It stops without an archive if the config, the folders or every key file are
missing. It writes to a temp file, keeps only an archive that tar and gpg both finished, reads the
archive stream back to check it's a complete tar.gz with those contents, and checks it is
encrypted as expected (with the passphrase fallback it also decrypts it). A file changing while
it's read is only a warning. Messages land in `/var/log/reflect-backup.log`; **nothing alerts on a
failed run**, so look there now and then (`grep -c 'Backup written' /var/log/reflect-backup.log`,
and `ls -lt /var/backups/reflect | head`).

With a public key, only you can test that a backup really decrypts: every so often, on your own
machine, `gpg -d <newest> | tar -tzf - | grep -c distributor.json`, using the copy from off the
server. Not in the archive, and to be set up again after a total loss: the files in `/etc` (the
`reflect-*.env` settings and alert tokens, `caddy/reflect-origin.env`) and the path secret in `/root`.

Settings live in `/etc/reflect-backup.env` (root-only):

- **Encrypt to a public key** (recommended): the server can then write backups but not read
  them. On your own machine: `gpg --quick-gen-key "reflect backups" rsa4096 encr never`, keep
  the private key safe (`gpg --export-secret-keys --armor` into a password manager), and copy
  `gpg --export --armor "reflect backups"` to the server. There, as root: `gpg --import <file>`,
  then `BACKUP_RECIPIENT=<its fingerprint>` in `/etc/reflect-backup.env`. Restore on your
  machine: `gpg -d reflect-<stamp>.tar.gz.gpg | tar -xzf -`.
  Without `BACKUP_RECIPIENT` the script falls back to the passphrase in
  `/root/.reflect-backup-pass` (and warns); then **copy that file somewhere safe**, as the
  backups can't be decrypted without it.
- **Off the server:** `BACKUP_REMOTE=<rclone remote>:<folder>` (after `rclone config` as root);
  the run fails if the copy fails. Without it the script warns that the backup is only local.

`factory/` holds every launched token's distributor key. If it is lost, those tokens
stop paying out and their collected tax can't be withdrawn.

## Updating

```bash
cd /opt/x1-reflection-token
sudo -u reflect git pull --ff-only && sudo -u reflect npm ci
systemctl restart reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor
```

On the live server, also restart whichever of `reflect-mainnet-factory`,
`reflect-mainnet-factory-distributor`, `reflect-arb-bot`, `reflect-arb-scan` and
`reflect-gap-monitor` are running. A changed unit file takes effect only after
`cp deploy/systemd/<unit>.service /etc/systemd/system/ && systemctl daemon-reload` and a restart.
The Telegram token and Pinata key are environment-only: a `--telegram-token`, `--telegram-chat` or
`--pinata-jwt` left in `/etc/reflect-*.env` or `state/arb.env` makes that program exit with a usage
error, so take them out first (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `PINATA_JWT`).

Distributors hold their lock only during a cycle and every transaction is journaled
before it's sent, so restarting mid-cycle is safe: the next cycle reconciles it.
