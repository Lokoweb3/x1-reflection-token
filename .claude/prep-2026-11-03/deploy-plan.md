# Deployment and rollback plan: not executed

Prepared 3 Nov 2026. **Nothing here has been run on the server, and I can't read the server myself.** The arb bot isn't stopped, restarted or modified by any step.

## Known state
| Item | Value | Source |
|---|---|---|
| GitHub `main` | `5f8234d` | Verified |
| Local `main` | `dd221f2`, 5 merges behind | Verified |
| This checkout | `dc947ea`, `limit-buy-range`, 22 changed paths. The arb bot runs from here | Verified |
| **Server commit and working tree** | **Unknown**; last recorded update 26 Oct | Step 0 answers it |
| Server `package-lock.json` | Had a local edit on 26 Oct, which may block a pull | Note from 26 Oct; recheck |
| Backup crank (GitHub Actions) | Runs from `main` on a schedule, so merges reach it at once. No `CRANK_RPC`, so testnet | Check run on `5f8234d`; variable last checked 2 Nov |

## Server state read over SSH, 3 Nov 2026
- Commit `8b82844` (#20, 27 Oct), on `main`, 38 commits and 6 merges behind `5f8234d`: #21, #22, #27, #25, #24, #28.
- Working tree: `package-lock.json` has 15 lines deleted, and there are untracked `config.json.*` backups.
- Node v24.20.0. No leftover `--telegram-*` or `--pinata-jwt` flags in env files, units or cron.
- **No arb unit is installed on the server, and no arb process runs there.**
- TEST's record file: pool `6FszF7uw…` and `lockNft` `BsR6qa86…` match the vault on-chain. So the binding check's crank won't stop TEST's sales.
- `reflect-factory-distributor` was already failed. `config.json` and `launchesPaused` not read.
- Installed units differing from the repo at the server's commit: dashboard, distributor, factory-distributor, factory. Their `10-no-mainnet.conf` drop-ins and any edits must survive Stage 3.

## Step 0: read-only capture (owner runs; changes nothing)
```bash
ssh root@64.225.61.191 'cd /opt/x1-reflection-token; R="sudo -u reflect git"
$R rev-parse HEAD; $R log -1 --format="%h %cI %s"; $R status --short; $R diff --stat; $R ls-remote origin refs/heads/main
node -v; systemctl list-units "reflect-*" --all --no-pager
grep -nE -- "--telegram-(token|chat)|--pinata-jwt" /etc/reflect-*.env /etc/systemd/system/reflect-*.service /etc/cron.d/* 2>/dev/null | cut -d: -f1,2
for f in /etc/systemd/system/reflect-*.service; do diff -q "$f" "deploy/systemd/$(basename $f)" 2>&1; done
python3 - <<PY
import json
r=json.load(open("mainnet/factory/launches/C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz/launch.json"))
print({k:r.get(k) for k in ("pool","lockNft","taxVault","registeredAt","vaultProgram")})
c=json.load(open("mainnet/config.json")); print("launchesPaused",c.get("factory",{}).get("launchesPaused"),"quorum set","quorum" in c.get("factory",{}).get("taxVault",{}))
PY'
```
The `grep` prints only file and line, and the Python prints only named non-secret fields.
**TEST's pool must read `6FszF7uwrujG8vdmxUCyLLAoQMRCUNgoWuebhuzZ6sVn` and its `lockNft` `BsR6qa86A1yaN6RXD8vQrLVXDrtdu4ek1eq82Aadjdqf`.** If the pool differs, stop: the binding fix would stop TEST's sales.

## What a deployment introduces
Exact file list: `git diff --name-status <server sha> <target sha>`, once step 0 gives the SHA. Relative to local `main` `dd221f2`:

| Change | Size | Affects |
|---|---|---|
| #22 docs and hygiene (`b43a23d`) | 10 files | Arb scanner and engine, `src/pools.ts`, `src/xdex.ts`, Node 22 `engines`, `@types/node`, lockfile |
| #27 server (`5acdeb3`) | 24 files | `src/factory/*` (11), server, `config.ts`, `locker-tx`: caching, pin cleanup, launch records saved once on-chain |
| #25 arb (`02431c1`) | 28 files | Arb engine and send paths: only a bot restart loads them. `--max-fees-day` defaults to 0.5 |
| #24 ops (`f4d5ccc`) | 33 files | 9 systemd units, setup, backup, Caddy templates, `vercel-deploy.sh`, secret flags removed |
| #28 lp-locker and curve (`5f8234d`) | 35 files | Program source (**not deployed by a pull**), curve fallback, server, pages |
| #29 follow-ups, if merged | 21 files | Curve fallback, `limits.ts`, Caddy templates, arb engine, launch journals |
| Launch records fix, if merged | 5 files | `launch.ts`, server comment |
| Vault binding, if merged | 12+ files | Crank stop rules, registration, `scripts/crank.ts`, new checker |

**No database or on-chain migrations, and no program upgrades.** Program source changes in #28 stay blocked on the upgrade authority move, and a pull doesn't deploy them.

**Excluded:** `usage-dashboard`, `audit-reference-corpus`, `quorum-action-tool`, `audit-fallback-race-dagpb`, `audit-cosigner-scan`, #26, #23.

## Stages
Each stage has its own approval. Take a target SHA from the merged `main`, never "latest".

### Stage 1: code to the mainnet site only
Affected: `reflect-mainnet-factory`, which is the site **and TEST's crank**. Its restart pauses the crank briefly. Do it just after a list goes live.
1. Run step 0. Save the output, especially the old SHA.
2. If `package-lock.json` has a local edit, read it, save it to `/root/`, and decide; a fast-forward may refuse otherwise.
3. Remove any secret flags step 0 found, moving them into env files.
4. `sudo -u reflect git fetch origin && sudo -u reflect git merge --ff-only <target sha>`. **No `git pull`, no `setup.sh`.**
5. `sudo -u reflect npm ci`, because the lockfile changes.
6. `systemctl restart reflect-mainnet-factory`. **Only this unit.**

### Stage 2: testnet and supporting services, one at a time
Only if running, and only once Stage 1 holds for a day: `reflect-factory`, `reflect-dashboard`, `reflect-gap-monitor`, distributors. **Skip `reflect-arb-bot` and `reflect-arb-scan`.**

### Stage 3: hardened units
#24's unit changes, separately, because they can hide paths a service needs. Follow #24's steps B and rollback, **without its arb lines**, and leave the arb units' files alone.

### Stage 4: Caddy origin secret: optional, separate
#24 step C, plus #29's template fill by hand. `caddy validate` has never been run on these templates. Fix the observe template first.

### Not included
Arb bot restart and `--max-fees-day`: your decision. The uncommitted arb work in this checkout needs reconciling first.

## Health checks after each restart
- `systemctl is-active <unit>`, and `journalctl -u <unit> -n 50` with no restart loop.
- `curl -sf https://99tax.vercel.app/api/info` and `/api/tokens` return, listing TEST.
- `journalctl -u reflect-mainnet-factory | grep -E "VAULT NOT ON ITS LAUNCH|NOT SELLING|launch journal"`: the first two must be absent for TEST.
- One full crank pass (about 60 s) with no error. Over the next hours, the vault's on-chain activity and new lists continue.
- `launchesPaused` still set.

## Rollback
1. Before Stage 1: `sudo -u reflect git branch pre-deploy-<date> <old sha>`. To roll back: `sudo -u reflect git checkout pre-deploy-<date>`, then `sudo -u reflect npm ci`, then `systemctl restart reflect-mainnet-factory`.
2. Unit files: restore from `/root/unit-backup-<date>/`, `daemon-reload`, `reset-failed`, restart.
3. Data: new `step.json` files are safe under old code, from reading. Old code would resume its less safe journal cleanup, so don't stay rolled back for long.
4. **Stop and roll back if:** a restart loop, TEST logs `NOT SELLING`, lists stop, or `/api/tokens` loses TEST.

## Unverified
Server SHA and tree, installed units, whether arb runs on the server at all, `launchesPaused`, TEST's real record file, and whether `npm ci` succeeds there.

## Update, 3 Nov 2026, about 5:00 AM ET: #26 is in main
`main` is `276476f`. It includes #26 (`tax_vault` fixes), whose site code expects a program that isn't deployed. **Unless the owner decides otherwise, deploy the server at `5cb0e40`**, which has #29, #30, #31 and #32 without #26. Program upgrades stay blocked until the Squads move.

## Decision, 3 Nov 2026 (owner)
#26 stays merged in `main`. **The server deploys at `5cb0e40`.** Don't run a plain `git pull` on the server. Check whether this still holds before any later deploy, since main keeps moving.
