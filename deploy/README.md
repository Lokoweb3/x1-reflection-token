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
`reflect-mainnet-factory-distributor` (mainnet's "Test" is on a distributor until the vault
is on mainnet).

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
   `DOMAIN=`). Caddy then serves plain HTTP on port 80, only under a random secret path
   saved in `/root/.reflect-vercel-secret`; everything else gets a 404. Keep port 80 open
   in the firewall (DigitalOcean: Networking → Firewalls, or the droplet's own ufw).
2. On your machine: `npx vercel login`, then
   `BACKEND=http://<server IP> SECRET=<that secret> PROJECT=<project> bash deploy/vercel-deploy.sh`.
   The generated config (with the secret) stays in `.vercel-site/`, which git ignores.
3. In the server's `config.json`: `factory.publicUrl` = `https://<project>.vercel.app`,
   `factory.hosts` = `["<project>.vercel.app"]`, then `systemctl restart reflect-factory`.

Note: Vercel's free Hobby plan is for non-commercial use; a launchpad that charges fees
may need the Pro plan under their terms.

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
- **Vercel mode:** the secret path in `/root/.reflect-vercel-secret` is what keeps the
  server from being called directly. Never commit the generated `vercel.json`; if the
  secret leaks, make a new one and re-run `deploy/vercel-deploy.sh`.
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

`deploy/backup.sh` runs daily at 03:15 UTC and writes an AES-256 encrypted archive of
`config.json`, `distributor.keypair.json`, `state/` and `factory/` to
`/var/backups/reflect` (keeps 30). **Copy `/root/.reflect-backup-pass` somewhere safe**
(a password manager). Without it the backups can't be decrypted. Also copy the
archives off the server (the script shows an `rclone` example).

`factory/` holds every launched token's distributor key. If it is lost, those tokens
stop paying out and their collected tax can't be withdrawn.

## Updating

```bash
cd /opt/x1-reflection-token
sudo -u reflect git pull --ff-only && sudo -u reflect npm ci
systemctl restart reflect-factory reflect-dashboard reflect-distributor reflect-factory-distributor
```

Distributors hold their lock only during a cycle and every transaction is journaled
before it's sent, so restarting mid-cycle is safe: the next cycle reconciles it.
