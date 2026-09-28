# Tax Vault — implementation spec (v1, testnet first)

Design and reasons: the published "Tax Vault" design page. This file is the contract
between the on-chain program (`lp-locker/programs/tax_vault`) and the TypeScript side
(`src/taxvault.ts`, the crank in the server, launch/migration code, site). Both must match
it exactly. If something here is impossible, change this file first and say so.

## Goal

A token's Token-2022 **withdraw-withheld authority** is a program address with no private
key. The program collects the tax and enforces the token's split. Burn, auto-LP and the
creator reward are fully on-chain; the holders' share is paid against a published Merkle
list that can only divide the holders' share. Anyone can run every step (a "crank").

## Scope of v1

- **XNT-paired tokens only** (pool TOKEN/wXNT on XDEX). JACK-paired tokens keep the
  existing hot-wallet distributor for now.
- Creator reward mint: **native XNT (wrapped)** on testnet; the mainnet USDC.X swap path is
  a v2 item (keep the code structured so it can be added: `reward_mint`, `reward_swap_pool`
  are stored but v1 requires `reward_mint == NATIVE_MINT`).

## Constants

| Name | Value |
|---|---|
| `LOCKER_PROGRAM_ID` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` |
| `XDEX_PROGRAM_ID` | testnet `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` · mainnet `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (feature `testnet`) |
| `MAX_IMPACT_BPS` | `300` (a sale moves the price at most 3%) |
| `OUT_TOLERANCE_BPS` | `50` (min out = on-chain expected out × 99.5%) |
| `CRANK_REWARD_BPS` | `100` (1% of the holders' XNT from a `sell`) |
| `CRANK_REWARD_CAP` | `50_000_000` lamports (0.05 XNT) per `sell` |
| `LIST_DELAY_SECS` | `600` (feature `short-windows`: `5`) |
| `MIN_SELL_TOKENS_XNT` | a `sell` whose expected output is under `2_000_000` lamports fails with `TooSmall` |
| `MIN_LP_XNT` | `add_liquidity` needs at least `10_000_000` lamports set aside, else `TooSmall` |
| `CREATOR_BPS` | `1000` (fixed) |
| split limits | `burn_bps ≤ 5000`, `lp_bps ≤ 5000`, `burn_bps + lp_bps ≤ 5500` (holders keep ≥ 35%) |

## PDAs (tax_vault program)

| Account | Seeds | Owner |
|---|---|---|
| `vault` | `["vault", mint]` | tax_vault (state) |
| `auth` | `["auth", mint]` | **System program, never allocated.** It is the token's withdraw-withheld authority, owns the vault's token/wXNT/LP accounts, and holds the XNT buckets as lamports. Signs with `invoke_signed`. |
| `record` | `["paid", vault, wallet]` | tax_vault (per-holder "paid so far") |

## Accounts (Anchor borsh, 8-byte discriminator first; field order is the layout)

```rust
pub struct Vault {
    pub mint: Pubkey,
    pub pool: Pubkey,             // XDEX TOKEN/wXNT pool
    pub creator_nft: Pubkey,      // lp_locker lock NFT of this pool (creator reward vault key)
    pub reward_mint: Pubkey,      // v1: NATIVE_MINT
    pub reward_swap_pool: Pubkey, // v1: Pubkey::default()
    pub publisher: Pubkey,        // may publish rewards lists
    pub guardian: Pubkey,         // may cancel a pending list (the creator)
    pub burn_bps: u16,
    pub lp_bps: u16,
    pub creator_bps: u16,         // 1000
    // token buckets (base units of the tax token, held in auth_token)
    pub pending_tokens: u64,      // reserved; v1 splits inside collect, so always 0 after collect
    pub lp_tokens: u64,           // auto-LP tokens kept as tokens (half of the LP share)
    pub sell_lp: u64,             // tokens to sell for the LP's XNT side
    pub sell_creator: u64,        // tokens to sell for the creator reward
    pub sell_holders: u64,        // tokens to sell for holders
    // XNT buckets (lamports held by auth)
    pub xnt_lp: u64,
    pub xnt_creator: u64,
    pub holders_funded: u64,      // cumulative XNT ever added to the holder pool
    pub holders_paid: u64,        // cumulative XNT ever paid to holders
    // rewards list
    pub list_epoch: u64,
    pub list_root: [u8; 32],
    pub list_total: u64,          // cumulative XNT allocated by the active list
    pub pending_epoch: u64,       // 0 = none pending
    pub pending_root: [u8; 32],
    pub pending_total: u64,
    pub pending_active_at: i64,
    // totals for the site
    pub total_collected: u64,
    pub total_burned: u64,
    pub total_lp_tokens: u64,
    pub total_lp_xnt: u64,
    pub total_creator_xnt: u64,
    pub total_crank_rewards: u64,
    pub created_at: i64,
    pub bump: u8,
    pub auth_bump: u8,
}
pub struct PaidRecord {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub paid: u64,                // cumulative XNT paid to this wallet
    pub bump: u8,
}
```

**Invariant** (checked at the end of every instruction that moves lamports): auth lamports
≥ `xnt_lp + xnt_creator + (holders_funded − holders_paid)` (+ nothing else is promised).

## Merkle list

Leaf = `sha256("99tax-vault" || vault || wallet || cumulative_u64_le)`; nodes are
`sha256(min(a,b) || max(a,b))` (sorted pairs, same as the Holder Pass tree in lp_locker).
Each wallet's `cumulative` is its running total of XNT allocated since the vault started.

## Instructions (Anchor discriminator = sha256("global:<name>")[..8])

Account lists in this exact order (w = writable, s = signer).

1. `init_vault(burn_bps: u16, lp_bps: u16, publisher: Pubkey, guardian: Pubkey)`
   payer(w,s), mint, vault(w, init), auth, pool, lock [lp_locker PDA `["lock", creator_nft]`],
   creator_nft, system_program.
   Checks: mint owned by Token-2022; TransferFeeConfig present; **fee config authority None;
   withdraw-withheld authority == auth**; pool owned by XDEX and its mints are {mint, NATIVE_MINT};
   `lock` is owned by lp_locker, has the right PDA, and records `pool == pool`; split limits.
   Sets `reward_mint = NATIVE_MINT`, `reward_swap_pool = default`, `creator_bps = 1000`.

2. `collect()` — harvest + withdraw + split + burn
   caller(w,s), vault(w), auth(w), mint(w), auth_token(w) [ATA(auth, mint, Token-2022)],
   token_2022_program, associated_token_program, system_program;
   remaining_accounts: token accounts of this mint to harvest (w), may be empty.
   Creates auth_token idempotently (payer caller). Harvests the remaining accounts into the
   mint (permissionless Token-2022 instruction), withdraws the mint's withheld amount to
   auth_token signed by auth, measures `got` (balance delta). Split of `got`:
   `burn = got*burn_bps/1e4`, `lp = got*lp_bps/1e4`, `creator = got*creator_bps/1e4`,
   `holders = got - burn - lp - creator`; `lp_tokens += lp/2`, `sell_lp += lp - lp/2`,
   `sell_creator += creator`, `sell_holders += holders`; burns `burn` from auth_token.
   Emits `Collected`. Fails with `NothingToCollect` if `got == 0`.

3. `sell(max_tokens: u64)`
   caller(w,s), vault(w), auth(w), mint, auth_token(w), auth_wxnt(w) [ATA(auth, NATIVE_MINT, SPL Token)],
   pool(w), amm_config, xdex_authority, token_vault(w), wxnt_vault(w), observation(w),
   xdex_program, token_program, token_2022_program, associated_token_program, system_program.
   Amount = min(max_tokens, sell_lp + sell_creator + sell_holders, impact cap from live
   reserves incl. the 5% transfer fee on the way in). Expected out computed on-chain
   (CPMM with the amm config's trade fee, protocol/fund fees excluded from reserves, like
   `quoteSell` in src/xdex.ts); min out = expected × (1 − OUT_TOLERANCE). XDEX
   `swap_base_input` CPI (account order as `buildSell`), owner = auth (invoke_signed).
   Unwraps auth_wxnt back to lamports (close it; recreate next time). Attribution: the
   tokens are taken from the three sell buckets pro-rata; XNT out goes pro-rata to
   `xnt_lp`, `xnt_creator`, and holders (rounding to holders). Holders' part:
   `reward = min(part*CRANK_REWARD_BPS/1e4, CRANK_REWARD_CAP)` to caller, rest
   `holders_funded += part - reward`. Emits `Sold`.

4. `add_liquidity()`
   caller(w,s), vault(w), auth(w), mint, auth_token(w), auth_wxnt(w), auth_lp(w) [ATA(auth, lp_mint, SPL Token)],
   pool(w), xdex_authority, token_vault(w), wxnt_vault(w), lp_mint(w), xdex_program,
   token_program, token_2022_program, memo_program, associated_token_program, system_program.
   Requires `xnt_lp ≥ MIN_LP_XNT`. Deposits as much of `lp_tokens` + `xnt_lp` as the pool
   ratio allows (transfer fee included, like `quoteDeposit`/`buildDepositAndBurn`), burns
   all LP received, updates buckets and totals; leftovers stay for next time. Emits
   `LiquidityAdded`.

5. `fund_creator()`
   caller(w,s), vault(w), auth(w), auth_wxnt(w), creator_nft, reward_mint [NATIVE_MINT],
   reward_vault(w) [lp_locker `["reward", creator_nft, reward_mint]`],
   reward_tokens(w) [lp_locker `["reward_tokens", reward_vault]`], locker_program,
   token_program, associated_token_program, system_program.
   Wraps `xnt_creator` into auth_wxnt and CPIs lp_locker `deposit_reward(amount)` with
   depositor = auth (invoke_signed). If the reward vault doesn't exist, CPI
   `init_reward_vault` first (payer caller). Emits `CreatorFunded`.

6. `publish_list(root: [u8;32], epoch: u64, total: u64)`
   publisher(s), vault(w).
   Requires signer == publisher, `epoch > max(list_epoch, pending_epoch)`,
   `total ≥ max(list_total, pending_total)`, `total ≤ holders_funded`. Sets the pending list
   with `pending_active_at = now + LIST_DELAY_SECS`. Emits `ListPublished`.

7. `cancel_list()`
   guardian(s), vault(w). Clears a pending list (only before or after its time; once
   activated it can't be cancelled). Emits `ListCancelled`.

8. `pay(cumulative: u64, proof: Vec<[u8;32]>)`
   payer(w,s), vault(w), auth(w), wallet(w), record(w, init_if_needed, payer = payer),
   system_program.
   First, if a pending list exists and `now ≥ pending_active_at`, it becomes the active one.
   Verifies the leaf against the active root, pays `cumulative − record.paid` lamports from
   auth to wallet (invoke_signed), `record.paid = cumulative`, `holders_paid += amount`.
   Fails with `NothingToPay` when nothing is owed. Emits `Paid`.

## Events

`Collected { vault, got, burned }`, `Sold { vault, tokens_in, xnt_out, to_lp, to_creator,
to_holders, crank_reward }`, `LiquidityAdded { vault, tokens, xnt, lp_burned }`,
`CreatorFunded { vault, amount }`, `ListPublished { vault, epoch, root, total, active_at }`,
`ListCancelled { vault, epoch }`, `Paid { vault, wallet, amount, cumulative }`.

## Errors

`BadMint, BadAuthority, BadPool, BadLock, BadSplit, NotPublisher, NotGuardian, StaleEpoch,
TotalDecreased, OverFunded, NoPendingList, BadProof, NothingToCollect, NothingToPay,
TooSmall, Insolvent, MathOverflow, WrongAccount`.

## Off-chain (crank, in the site server)

- For each vault token, every cycle: `collect` (harvest accounts that hold withheld tax, in
  chunks), `sell` until the sell buckets are under the dust limit or the impact cap stops
  it, `add_liquidity` when enough is set aside, `fund_creator` when `xnt_creator > 0`.
- Rewards list: new holders' XNT (`holders_funded − list_total`) is allocated pro-rata to
  eligible holders with today's rules (excluded owners, off-curve owners, minimum holding)
  and added to each wallet's running total (kept in the token's state dir); the list (all
  wallets and totals) is saved publicly (served at `/api/vault/<mint>/list`), then
  `publish_list`. After the delay, `pay` every wallet whose total grew (batched).
- Launches (when `factory.taxVault.programId` is set, testnet): the mint's withdraw
  authority is the vault's `auth` PDA; `init_vault` runs at registration (publisher = the
  crank key, guardian = the creator). Those tokens are skipped by the hot-wallet distributor.
- Migration of an existing token: its distributor key signs Token-2022
  `SetAuthority(WithdrawWithheldTokens → auth)` and `init_vault` in one transaction, after
  a last normal payout cycle.
