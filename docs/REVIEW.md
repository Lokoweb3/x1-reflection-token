# Reviewer guide

A starting point for reviewing 99 + Tax: what's in scope, what's deployed where (and how
to check that the chain runs this source), how to run the tests, the trust assumptions,
and the places most worth a careful look. State as of 30 Sep 2026.

## Scope

| Program | Source | Lines | Job |
|---|---|---|---|
| `tax_vault` | `lp-locker/programs/tax_vault/src/lib.rs` | ~2,600 | Holds each token's transfer tax (its withdraw-withheld authority is a PDA of this program) and runs the cycle: collect, burn, sell, add liquidity, creator reward, Merkle-list payouts, fallback payouts, publisher rotation. Spec: [tax-vault-spec.md](tax-vault-spec.md) (v1, v2, v3 sections plus "changes from the draft" notes). |
| `bonding_curve` | `lp-locker/programs/bonding_curve/src/lib.rs` | ~1,400 | Curve launches: buys and sells on a constant-product curve, graduation into an XDEX pool, LP locked through `lp_locker`, delivery of buyers' tokens. Spec: [bonding-curve-spec.md](bonding-curve-spec.md). |
| `lp_locker` | `lp-locker/programs/lp_locker/src/lib.rs` | ~1,200 | Locks a pool's LP behind a 1-of-1 NFT (forever or timed), lets the NFT holder collect trading fees, and holds the creator reward's 7-day vesting vaults. |

Off-chain (TypeScript, `src/`): the site and its crank. The pieces that decide money:
`src/vault-crank.ts` (every crank step, the list builder, "Run the vault now"),
`src/factory/vault.ts` (the site's crank loop, IPFS pinning, views), `src/taxvault.ts`
(account layouts, instruction encoders, Merkle tree), `scripts/crank.ts` (the standalone
crank anyone can run).

## Deployed programs

All upgradeable; upgrade authority `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` (one key).
Hashes are sha256 of `solana program dump`, taken 30 Sep 2026.

| Network | Program | Address | Bytes | sha256 | From today's source? |
|---|---|---|---|---|---|
| testnet | `tax_vault` v3 | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` | 590,376 | `4d334f40a99974d515169a9d43bb5d6f9705c50c7c5763973638d28293605ea5` | yes (`--features testnet`) |
| testnet | `bonding_curve` | `CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY` | 478,808 | `b9c0eb9c5da4a9bf91b3c5bb766765b498a651f80f08d4c0f64afce750eeff85` | yes (`--features testnet`) |
| testnet | `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` | 474,704 | `d1749193963f6560c6428b8697917511d1e1dff0b94028fff3c36379bb6776f4` | no: an earlier revision (before Holder Passes were added to the source) |
| mainnet | `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` | 554,776 | `f25f916e5bc82687533b81b5eeefdc99b9834b7e5256d3af2380a57c5859074b` | yes (no features) |

`tax_vault` and `bonding_curve` are not on mainnet. XDEX (the DEX all three call):
testnet `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`, mainnet
`sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`.

### Reproduce a build and compare it with the chain

Builds use `cargo-build-sbf` from the Solana/Agave **3.1.15** release (the output is
byte-identical run to run on the same toolchain):

```bash
cd lp-locker
cargo-build-sbf --manifest-path programs/tax_vault/Cargo.toml --features testnet --sbf-out-dir /tmp/tv
cargo-build-sbf --manifest-path programs/bonding_curve/Cargo.toml --features testnet --sbf-out-dir /tmp/bc
cargo-build-sbf --manifest-path programs/lp_locker/Cargo.toml --sbf-out-dir /tmp/lpm          # mainnet
sha256sum /tmp/tv/tax_vault.so /tmp/bc/bonding_curve.so /tmp/lpm/lp_locker.so

solana program dump D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW /tmp/tv-chain.so --url https://rpc.testnet.x1.xyz
sha256sum /tmp/tv-chain.so    # same hash as the local build
```

The `testnet` feature switches network constants (XDEX program and fee tier, reward token
XNM/USDC.X and its pool). `short-windows` shortens time windows for local tests only and
is never deployed.

## Tests

```bash
cd lp-locker && cargo test -p tax_vault && cargo test -p bonding_curve && cargo test -p lp_locker
cd .. && npm install && npx tsc --noEmit -p . && npm test      # 87 TypeScript tests
```

End-to-end scripts run against a **local validator** that clones the real testnet XDEX,
`lp_locker` and pool accounts (each script's header has the exact validator command; use
the 3.x `solana-test-validator`, as 2.1 rejects `program extend`):

| Script | What it proves |
|---|---|
| `scripts/local-vault-v3-test.ts` | v3 program alone: v1/v2 → v3 upgrades, CIDs, `set_publisher` / `appoint_publisher` timing and refusals, `pay_fallback` amounts, attack cases |
| `scripts/vault-v3-rehearsal.ts` | The "operator dies" drill with the real site: stop the site, a stranger's wallet pays from IPFS, fallback, appointed publisher |
| `scripts/local-curve-targets-test.ts` | Curve program upgrade under a part-bought old curve, 500 and 10,000 XNT curves, graduation and delivery |
| `scripts/curve-vault-rehearsal.ts` | A curve token end to end on the Tax Vault, through the site |
| `scripts/local-vault-test.ts`, `scripts/local-vault-v2-test.ts` | v1 and v2 behaviour and upgrades |

## Trust assumptions

Be explicit about these when reviewing; none of them is hidden from users (the site shows
the "for now" upgradeability note and each vault's publisher).

1. **Program upgrades: one key.** `53fT…` can replace any of the three programs. Until it
   moves to a multisig (Squads v4 is deployed on X1) or the programs are made immutable,
   every guarantee below holds only as long as that key is safe.
2. **Who gets paid is decided off-chain.** The publisher key (the site's, `GSNq…` on
   testnet) computes each wallet's cumulative share and publishes a Merkle root plus an
   IPFS file. The program enforces: the list total can't exceed what was set aside for
   holders, can't go below what was already allocated or paid, each wallet is paid at most
   its leaf, never twice; a 10-minute delay lets the guardian (the token's creator) cancel,
   at most 2 times in a row. It can **not** check that the split between holders is fair.
3. **Operator loss.** After 7 days without a published list the guardian may appoint a new
   publisher; after 30 days anyone can pay from the last list scaled to everything funded
   (`pay_fallback`). The creator-appointed publisher is trusted like the original.
4. **External programs.** XDEX (upgradeable by its team) for swaps, deposits and pool
   reads; Token-2022; Squads if used. A breaking XDEX change would stop sales and
   auto-liquidity (payouts of XNT already in a vault still work).
5. **Mainnet today** runs its one token ("Test") on the older distributor path: a hot
   wallet on the server holds that token's withdraw authority. New mainnet launches are
   paused until the vault is audited and deployed there.

## Worth a careful look

`tax_vault`
- **Solvency.** `check_solvent` (auth lamports ≥ every promised bucket + rent) and
  `check_tokens` after every instruction that moves value; `promised()`.
- **Sales.** Impact cap `min(300 bps, tax_bps / 2)`, one sale per slot, `min_out`
  tolerance, the pro-rata `proceeds` split and the crank reward (1% of the holders' part,
  capped at 0.05 XNT). Sandwich reasoning is in the comment on `impact_bps`.
- **Liquidity.** `deposit_for` (transfer-fee-aware sizing), LP burned.
- **Creator reward.** `fund_creator`: reward-mint checks (`reward_mint_ok`: no transfer fee,
  hooks or freeze-like extensions), impact cap `min(300, trade_fee_rate / 200)` bps, that
  the whole output lands in the lock NFT's vault.
- **Lists.** `check_publish` (epoch, totals vs active/pending/funded/paid), activation,
  `cancel_list` limit, `pay` and `pay_fallback` maths (`floor(cumulative × funded /
  list_total)`, u128), `PaidRecord` handling.
- **Authority paths.** `init_vault` (signer must be the mint's metadata update authority or
  the same transaction must hand over the withdraw authority), `set_publisher`,
  `appoint_publisher` timing, `upgrade_vault` (480/552 → 640 bytes, which bytes are kept).

`bonding_curve`
- `create_curve(supply_whole, target_whole)` with `TARGETS_XNT_WHOLE`; `graduate_pool`
  now seeds the curve's own stored `target_xnt` (older curves keep 20 XNT).
- Known rounding: with the largest target and the smallest supply a full curve can raise
  up to ~143 lamports less than the target; the graduation deposit covers it and the pool
  still gets exactly the target.
- Anti-snipe (first 2 minutes: max 1% of supply per buy), creator can't buy, delivery.

`lp_locker`
- `lock` / `lock_timed` / `unlock`, fee collection without touching the principal, the
  reward vault's vesting and claim rules, NFT checks (freezable mints refused).

Questions, or anything that doesn't match the specs: open an issue on the repository.

## Review log

### 2026-09-30: independent review by Theo (Cyberdyne), commit ce38a49

No critical or high findings. Build hashes of all three deployed programs reproduced from
source; Rust and TypeScript tests and `scripts/local-vault-v3-test.ts` passed. Findings and
what was done:

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | "Run the vault now" gave `fund_creator` a 240k compute limit; the spec asks for >= 250k (up to ~195k measured when the reward vault is created) | Medium (reported), reliability only | **Fixed**: 260k (`src/vault-crank.ts`, the visitor plan). The site's own crank already asked for 300k and fits it to measured use. |
| 2 | If the active list's file is unreadable, a new list restarts every wallet from what it was paid on-chain, so amounts allocated but not yet paid are lost to their wallets (they go back into the pot and are re-split over current holders; only rounding dust goes to the largest share) | Low | **Fixed**: the site crank now takes the running totals from its local copy when it matches the on-chain root, else from IPFS (checked against the root), and **refuses to publish** without one (`factory.taxVault.allowListRebuild` overrides). `scripts/crank.ts --publisher` refuses the same way unless `--allow-rebuild`. |
| 3 | `MAX_CANCELS_IN_ROW = 2`: a compromised publisher can wait out the guardian's two cancels | Info | **Accepted for now, open for the audit.** The limit exists so a hostile creator can't stall payouts forever (the fallback only starts after 30 days without a *published* list). Raising it or letting cancels recharge moves power from the publisher to the creator rather than removing it. The planned fix is removing the single publisher key: a multisig publisher and/or an M-of-N publisher quorum, plus verifiable lists with a watchdog that alerts the guardian during the cancel window. |

Also noted by the reviewer, unchanged: testnet `lp_locker` is an older revision than the
source (documented above); the trust assumptions listed above (single upgrade key,
off-chain lists, mainnet hot wallet) remain the main risks.

**Post-review verification (Theo, 30 Sep 2026).** Re-checked on `e5ea714`: fixes 1 and 2
present as described, #3 acknowledged; `npx tsc` clean, `npm test` 87/87. Also ran
`scripts/local-curve-targets-test.ts` (27/27: in-place upgrade under a live part-bought
curve, refused targets, the old 20 XNT curve and a new 500 XNT curve graduating exactly with
the pool opening at the curve's last price, 10,000 XNT pricing), and reproduced all three
deployed hashes with cargo-build-sbf **3.1.14** as well as 3.1.15. The fixes are off-chain
only, so the deployed programs and their hashes are unchanged.

**Audit scope:** review the fixed tree, **`e5ea714`** or later (it contains `ce38a49` plus
the review fixes `5302391` and the README update), and pin cargo-build-sbf 3.1.15 for the
exact hash check.
