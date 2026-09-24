# Deploying to a VPS

Runs everything on one small always-on server instead of a laptop:

| Service | What it does | Reachable at |
|---|---|---|
| `reflect-factory` | 99 + Tax site: landing page, launch app, Distribute now | `https://<your domain>` (through Caddy) |
| `reflect-distributor` | RFLT's cycle every 30 min | – |
| `reflect-factory-distributor` | every launched token's cycle every 30 min | – |
| `reflect-dashboard` | your private RFLT dashboard | `127.0.0.1:8123` on the server only (SSH tunnel) |

systemd restarts them if they crash and starts them on boot. Logs: `journalctl -u reflect-distributor -f`.

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
