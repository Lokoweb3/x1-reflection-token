# PR draft: not opened

**Title:** A tax vault must sit on its launch's pool and lock
**Branch:** `audit-vault-binding` at `86c6a61`
**Base:** `main`. Doesn't depend on #29. Trial merge of #29, then the launch records fix, then this: no conflicts, 454/454 tests, `tsc` clean (rerun 3 Nov at merged tree `079cad6`).

## Why
`checkVault` compared mint, roles, split and payout, but not `v.pool` or `v.creatorNft`. A creator could open a thin second pool, lock 1 raw LP, send their own `init_vault`, and still be listed, and the crank sold tax through that pool. Reproduced on real XDEX cloned from testnet: about 50.7x under the launch pool's price, 3 of 3 runs. Net attacker profit isn't shown.

## What changes
- Registration requires the launch's pool, and a lock on that pool that qualifies alone. `buildVaultStep` picks the qualifying lock and refuses before anything is signed.
- `registerCurve` refuses a bad existing vault.
- The crank compares vault and record each pass. **Pool differs:** no collect, sell, add_liquidity or new holder rounds; holder funding, lists and pays continue. **NFT differs:** stops `fund_creator` only. **Field missing from the record:** continues, with a note.
- `scripts/crank.ts` holds a vault to the launch pool PDA; `--allow-other-pool` overrides.
- New read-only `scripts/check-vault-bindings.ts`, with `--mint` for one yes-or-no answer.

## Evidence
- Fresh clone at 86c6a61: 423/423 TS tests, `tsc` clean.
- Real XDEX on a local validator: 6 of 6 (agent's run).
- Codex second pass: no blocker, Medium FIXED within site and crank scope, approve for merge, not production clearance. It read the code and ran no tests.
- TEST, 3 Nov, read-only: `YES`, pool `6FszF7uw…` and NFT `BsR6qa86…` match. Record taken from the public `/api/tokens`, not the server file. See the deployment plan.

## Limits
- `sell` is permissionless and a vault's pool is fixed, so anyone can still sell a bad vault's tax directly. Needs a program change.
- `/recovery` and the pinned IPFS pages are unchanged until rebuilt and re-pinned.
- A creator with only a small lock is refused, and the site has no way to lock the rest.
- The curve path and holder-pass payments ran against a stand-in RPC only.

## Before deploy
Read TEST's record on the server (plan, step 0). If its pool differs from the vault, this stops TEST's sales.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
