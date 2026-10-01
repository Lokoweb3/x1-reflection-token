# Mainnet rollout: Tax Vault

The runbook for moving mainnet onto the Tax Vault and reopening launches. Nothing here is
done until the owner decides to go; every step says who runs it and where. Prepared
30 Sep 2026.

## Status (1 Oct 2026)

Path **B** (unaudited beta) was chosen, with the team key (53fT) as upgrade authority until
the Squads multisig is set up. Done:

- P1–P3: config switches; the full rehearsal on a local copy of mainnet passed
  (`scripts/mainnet-vault-rehearsal.ts`).
- Phase 1: `tax_vault` deployed (sha256 `25e9881f…`, verified against the chain; 4.11 XNT rent).
- Phase 2: mainnet site on the vault (`taxVault.mainnet`, `beta`), publisher `8TAJ…dGkb`; JACK pair removed.
- Phase 3: Test migrated (`4CF2eth…`), first crank pass, list and payouts the same morning;
  the retired distributor paid what it owed and was swept to 53fT.
- The mainnet recovery page is pinned (`bafybeid64cd…`) and served at `/recovery`.

Left: phase 4 (reopen launches), P4/P5 (Squads multisig as upgrade authority), P6 (VM),
the audit.

## Where mainnet was before the rollout

- Site `99tax.vercel.app` (VM services `reflect-mainnet-factory` and
  `reflect-mainnet-factory-distributor`, data in `/opt/x1-reflection-token/mainnet/`).
- **Launches paused** (`factory.launchesPaused`), `lockForeverOnly`, JACK pair offered
  (`quoteTokens`), bonding curve off, Pinata key set.
- One live token, **Test** (`C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz`), on the old
  distributor path: a hot wallet on the server holds its withdraw authority.
  (`mainnet/factory/launches/` also holds two unfinished, hidden launches.)
- `lp_locker` live (`5yPQ…`, sha256 `f25f916e…`, reproduces from source); upgrade
  authority 53fT.
- `tax_vault` **not deployed** on mainnet. Its address will be the same as testnet,
  `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` (program keypair
  `lp-locker/target/deploy/tax_vault-keypair.json`, kept off the repo).

## Decision first

| | Path | Launches reopen |
|---|---|---|
| **A** | Wait for the formal audit of `tax_vault`, then run this plan | weeks |
| **B** | Run this plan now as an **unaudited beta** (clear notice on the site), audit follows | days |

B's case: it removes today's biggest mainnet risk (a server hot wallet holding Test's tax)
and the vault has two independent reviews, the rehearsals and days live on testnet. B's
cost: code that hasn't had a formal audit holds real funds. Either way, book the audit
(`tax_vault` at `e5ea714` or later; see [REVIEW.md](REVIEW.md)).

## Prerequisites (before rollout day)

| # | What | Who | Status |
|---|---|---|---|
| P1 | Allow vault launches on mainnet behind a config switch: `factory.taxVault.mainnet: true` | dev | **done** |
| P2 | "Unaudited beta" notice on the launch form and every vault panel: `factory.taxVault.beta: true` (path B; English and Spanish) | dev | **done** |
| P3 | Mainnet rehearsal on a local validator cloning **mainnet** XDEX, `lp_locker`, USDC.X and its XNT pool (`CAJe…`) and Test's accounts: deploy the mainnet build, migrate Test, full crank cycle with the **USDC.X** creator reward, holder payout, a new launch on the vault | dev | to do |
| P4 | Squads multisig on mainnet (`multisig.mainnet.x1.xyz`), e.g. 2-of-3 (your main wallet, a second device or hardware wallet, a trusted third party); note its **vault address** | owner | to do |
| P5 | Trial one upgrade through a Squads multisig **on testnet** first, so the process is known before it guards mainnet | owner + dev | to do |
| P6 | VM maintenance (4 GB, updates, reboot) done beforehand | owner | to do |
| P7 | Funds: 53fT ≥ **4.3 XNT** on mainnet (has 5.12); a new mainnet publisher key with ~0.1 XNT | owner | 53fT ok |
| P8 | Hide the JACK pair (the vault takes XNT pairs only; a JACK launch would fall back to a server hot wallet) | dev (config) | at rollout |

## Rollout

Each phase ends with a check; stop there if it fails. Launches stay paused until phase 4.

### Phase 1: deploy the program (owner, laptop, the `!` prompt)

1. Dev rebuilds the mainnet binary from source and confirms the hash:
   `cargo-build-sbf --manifest-path programs/tax_vault/Cargo.toml --sbf-out-dir target/vault3-mainnet`
   (no `--features`: mainnet constants, USDC.X reward token). Current source gives
   `25e9881f…`.
2. Deploy (a new program; the program keypair gives it the `D9jt…` address):
   ```
   solana program deploy --program-id lp-locker/target/deploy/tax_vault-keypair.json \
     --upgrade-authority ~/.config/solana/id.json --keypair ~/.config/solana/id.json \
     --url https://rpc.mainnet.x1.xyz lp-locker/target/vault3-mainnet/tax_vault.so
   ```
   Cost: ~**4.11 XNT** kept as the program's rent (the upload buffer's rent is refunded
   into it), plus fees.
3. Check: `solana program dump D9jt… <file> --url https://rpc.mainnet.x1.xyz` and sha256
   equals the build.
4. Move the upgrade authority to the multisig (P4), for `tax_vault` and `lp_locker`:
   ```
   solana program set-upgrade-authority <program> --new-upgrade-authority <squad vault address> \
     --skip-new-upgrade-authority-signer-check --keypair ~/.config/solana/id.json --url https://rpc.mainnet.x1.xyz
   ```
   Check: `solana program show <program>` shows the squad's vault as authority. From now on
   every upgrade goes through Squads.

### Phase 2: turn the vault on in the mainnet site (owner, VM)

1. New publisher key for mainnet (the site's crank signs with it; it can't move tax):
   `sudo -u reflect solana-keygen new --no-bip39-passphrase -o /opt/x1-reflection-token/mainnet/publisher.keypair.json`
   (or the node equivalent if the CLI isn't on the VM), then send it ~0.1 XNT.
2. `sudo -u reflect git pull --ff-only && sudo -u reflect npm install --no-audit --no-fund`
   (always install after a pull: a new dependency missing on the VM stops the sites from
   starting), then in `mainnet/config.json` under `factory`: add
   `"taxVault": { "programId": "D9jt…", "publisherKeypair": "mainnet/publisher.keypair.json", "mainnet": true, "beta": true }`
   (`beta` only for path B); remove `quoteTokens` (P8). Keep `launchesPaused`.
3. `systemctl restart reflect-mainnet-factory`. Check `/api/info` shows the vault and the
   reward token **USDC.X**, and launches still paused.

### Phase 3: move Test onto the vault (owner, VM)

1. Let the mainnet distributor finish a cycle, then stop it between cycles and keep it off:
   `systemctl disable --now reflect-mainnet-factory-distributor` (wait for a quiet log first,
   as done on testnet).
2. Dry run, with the mainnet environment:
   ```
   sudo -u reflect env REFLECT_CONFIG=/opt/x1-reflection-token/mainnet/config.json \
     REFLECT_FACTORY_DIR=/opt/x1-reflection-token/mainnet/factory REFLECT_STATE_DIR=/opt/x1-reflection-token/mainnet/state \
     node node_modules/tsx/dist/cli.mjs scripts/migrate-to-vault.ts C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz
   ```
   It must show the split, lock NFT, publisher and guardian correctly, and a passing
   simulation. Dust owed to holders can be left with `--ignore-owed`.
3. Run it with `--execute`, then `systemctl restart reflect-mainnet-factory`.
4. Check: the mint's withdraw authority is the vault's auth PDA; the vault is v3; the
   crank's passes are OK; the first list is pinned and paid; the creator reward arrives in
   **USDC.X** in Test's lock NFT.
5. Sweep the retired distributor wallet (pays any owed holders first):
   `scripts/sweep-retired-distributor.ts --keypair mainnet/factory/launches/C9P8…/distributor.json --state …/state/distributor-state.json --to <your wallet>` (dry run, then `--execute`).

### Phase 4: reopen launches (owner, VM)

1. Remove `launchesPaused` from `mainnet/config.json`, restart the mainnet site.
2. Do one small real launch yourself first: five steps including "Start the tax vault";
   trade a little; watch a list publish and pay.
3. Announce (with the beta notice if path B).

## Costs

| Item | XNT |
|---|---|
| `tax_vault` program rent (kept) | ~4.11 |
| Deploy and authority-change fees | < 0.05 |
| Mainnet publisher key (crank fees, list publishing) | ~0.1 to start |
| Migration transaction | < 0.01 |
| Squads multisig creation | rent only, a few thousandths |

## Rollback and safety

- **Before phase 3** nothing depends on the vault: remove `taxVault` from the config and
  restart; the program can stay deployed unused.
- **After Test is migrated** its tax belongs to the vault for good (the program has no
  instruction to hand the withdraw authority back). Problems are fixed by upgrading the
  program through the multisig, not by going back to a hot wallet.
- **New launches** can be paused again at any time (`launchesPaused`) without affecting
  existing vault tokens.
- The optional publisher quorum (README, "Publisher quorum") can be turned on for Test or
  later tokens once an independent co-signer is available.

## Go / no-go checklist

- [ ] Decision made (A or B) and audit booked
- [ ] P1–P3 done, the mainnet rehearsal passed, and the built hash recorded
- [ ] Squads multisig created (P4) and a testnet upgrade trial done (P5)
- [ ] VM maintenance done (P6); 53fT ≥ 4.3 XNT (P7)
- [ ] A quiet window; someone watching the logs for an hour after each phase
