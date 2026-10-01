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
| `MAX_IMPACT_BPS` | `300`; the effective cap is `min(300, tax_bps / 2)` (a sale moves the price at most 3% and at most half the token's tax, see `sell`) |
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
| `auth` | `["auth", mint]` | **System program, never allocated.** It is the token's withdraw-withheld authority, owns the vault's token/wXNT/LP accounts, and holds the XNT buckets as lamports plus a rent-exempt reserve for a 0-byte account (`Rent::minimum_balance(0)`, 890,880 lamports), funded by `init_vault`'s payer. Signs with `invoke_signed`. |
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
    pub last_sell_slot: u64,      // slot of the last `sell` (one sale per slot)
}
pub struct PaidRecord {
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub paid: u64,                // cumulative XNT paid to this wallet
    pub bump: u8,
}
```

Sizes (8-byte discriminator included): `Vault` = **480** bytes, `PaidRecord` = **81** bytes.
`Vault` offsets: mint 8, pool 40, creator_nft 72, reward_mint 104, reward_swap_pool 136,
publisher 168, guardian 200, burn_bps 232, lp_bps 234, creator_bps 236, pending_tokens 238,
lp_tokens 246, sell_lp 254, sell_creator 262, sell_holders 270, xnt_lp 278, xnt_creator 286,
holders_funded 294, holders_paid 302, list_epoch 310, list_root 318, list_total 350,
pending_epoch 358, pending_root 366, pending_total 398, pending_active_at 406,
total_collected 414, total_burned 422, total_lp_tokens 430, total_lp_xnt 438,
total_creator_xnt 446, total_crank_rewards 454, created_at 462, bump 470, auth_bump 471,
last_sell_slot 472. `PaidRecord`: vault 8, wallet 40, paid 72, bump 80.

**Invariant** (checked at the end of every instruction that moves lamports): auth lamports
≥ `xnt_lp + xnt_creator + (holders_funded − holders_paid)` + `Rent::minimum_balance(0)`
(nothing else is promised; the reserve keeps auth rent-exempt so a payout can never leave it
rent-paying). Also `holders_paid ≤ list_total ≤ holders_funded`, and auth_token's balance ≥
`pending_tokens + lp_tokens + sell_lp + sell_creator + sell_holders`.

## Merkle list

Leaf = `sha256("99tax-vault" || vault || wallet || cumulative_u64_le)`; nodes are
`sha256(min(a,b) || max(a,b))` (sorted pairs, same as the Holder Pass tree in lp_locker).
Each wallet's `cumulative` is its running total of XNT allocated since the vault started.
An odd node at the end of a level is carried up unchanged.

Test vector (checked by the Rust unit test and scripts/local-vault-test.ts):
vault = 32 bytes of `0x01`, wallet A = 32 bytes of `0x02` with cumulative `1_000_000_000`,
wallet B = 32 bytes of `0x03` with cumulative `5`.
- leaf A = `f1df94e69dc2ad0365865c9eaeb81deac6bfbc98a2e5abe33decf1128b63e821`
- leaf B = `b5435ce16439596a11ef089ff9711a91493463e941f8a646a52fa2c3834ce969`
- root(A, B) = `1992f5473e12ba77f8b909f1cb3272b5492544fc3e37ea7a5d7c3776290bda6a`

## Instructions (Anchor discriminator = sha256("global:<name>")[..8])

Account lists in this exact order (w = writable, s = signer).

1. `init_vault(burn_bps: u16, lp_bps: u16, publisher: Pubkey, guardian: Pubkey)`
   payer(w,s), mint, vault(w, init), auth(w), pool, lock [lp_locker PDA `["lock", creator_nft]`],
   creator_nft, system_program, instructions [sysvar `Sysvar1nstructions1111111111111111111111111`].
   Checks: mint owned by Token-2022; only the TransferFeeConfig / MetadataPointer /
   TokenMetadata extensions; no freeze authority; TransferFeeConfig present with fee
   1..9999 bps and `maximum_fee == u64::MAX` (older and newer fee) — else `BadMint`;
   **fee config authority None; withdraw-withheld authority == auth** — else `BadAuthority`;
   pool owned by XDEX (layout/discriminator), its mints are {mint (Token-2022), NATIVE_MINT
   (SPL Token)} — else `BadPool`; `lock` is owned by lp_locker, has the right PDA, records
   `nft_mint == creator_nft` and `pool == pool` — else `BadLock`; split limits (`BadSplit`).
   **Who may create it** (else `BadAuthority`): `payer` is the mint's TokenMetadata update
   authority (the creator), **or** an earlier top-level instruction of the same transaction
   is Token-2022 `SetAuthority(WithheldWithdraw, new = auth)` on this mint (atomic hand-over,
   e.g. a migration signed by the old distributor key). Without this anyone could front-run
   a new launch's `init_vault` with their own publisher/guardian.
   Tops auth up to `Rent::minimum_balance(0)` from payer if it holds less.
   Sets `reward_mint = NATIVE_MINT`, `reward_swap_pool = default`, `creator_bps = 1000`.

2. `collect()` — harvest + withdraw + split + burn
   caller(w,s), vault(w), auth(w), mint(w), auth_token(w) [ATA(auth, mint, Token-2022)],
   token_2022_program, associated_token_program, system_program;
   remaining_accounts: token accounts of this mint to harvest (w), may be empty (Token-2022
   skips, with a log, any account it can't harvest).
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
   xdex_program, token_program, token_2022_program, associated_token_program, system_program,
   native_mint [NATIVE_MINT].
   amm_config / observation / vaults must be the pool's (`WrongAccount`); pool swaps not paused.
   **One sale per slot**: fails with `OneSellPerSlot` if `slot ≤ last_sell_slot` (the crank
   waits a slot between sells), so several capped sales can't be sandwiched in one
   transaction. Amount = min(max_tokens, sell_lp + sell_creator + sell_holders, impact cap
   from live reserves incl. the transfer fee on the way in), where the impact cap uses
   `min(MAX_IMPACT_BPS, tax_bps / 2)`: a sandwich costs the attacker about twice the tax on
   their own size while the vault loses about twice its sale's relative size, so keeping the
   sale's impact under the tax makes a sandwich unprofitable (5% tax → 2.5% cap). Cap in
   base units: `net = reserve_in*cap_bps/(1e4-cap_bps)`, `gross = net*1e4/(1e4-tax_bps)`. Expected out computed on-chain
   (CPMM with the amm config's trade fee, protocol/fund fees excluded from reserves, like
   `quoteSell` in src/xdex.ts); min out = expected × (1 − OUT_TOLERANCE). XDEX
   `swap_base_input` CPI (account order as `buildSell`), owner = auth (invoke_signed).
   `xnt_out` = auth_wxnt's balance delta (must be ≥ min out). auth_wxnt is created
   idempotently with **caller** as payer and closed into auth; auth then refunds the caller
   exactly the rent it paid (0 if the account already existed).
   Unwraps auth_wxnt back to lamports (close it; recreate next time). Attribution: the
   tokens are taken from the three sell buckets pro-rata; XNT out goes pro-rata to
   `xnt_lp`, `xnt_creator`, and holders (rounding to holders). Holders' part:
   `reward = min(part*CRANK_REWARD_BPS/1e4, CRANK_REWARD_CAP)` to caller, rest
   `holders_funded += part - reward`. Emits `Sold`.

4. `add_liquidity()`
   caller(w,s), vault(w), auth(w), mint, auth_token(w), auth_wxnt(w), auth_lp(w) [ATA(auth, lp_mint, SPL Token)],
   pool(w), xdex_authority, token_vault(w), wxnt_vault(w), lp_mint(w), xdex_program,
   token_program, token_2022_program, memo_program, associated_token_program, system_program,
   native_mint [NATIVE_MINT].
   (memo_program is address-checked but unused: XDEX `deposit` takes no memo account.)
   auth_wxnt and auth_lp are created with caller as payer, closed into auth, and the caller's
   rent refunded. Requires `xnt_lp ≥ MIN_LP_XNT`. Deposits as much of `lp_tokens` + `xnt_lp` as the pool
   ratio allows (transfer fee included, like `quoteDeposit`/`buildDepositAndBurn`), burns
   all LP received, updates buckets and totals; leftovers stay for next time. Emits
   `LiquidityAdded`.

5. `fund_creator()`
   caller(w,s), vault(w), auth(w), auth_wxnt(w), creator_nft, reward_mint [NATIVE_MINT],
   reward_vault(w) [lp_locker `["reward", creator_nft, reward_mint]`],
   reward_tokens(w) [lp_locker `["reward_tokens", reward_vault]`], locker_program,
   token_program, associated_token_program, system_program,
   lock [lp_locker `["lock", creator_nft]`], token_2022_program.
   (lock and token_2022_program are needed by lp_locker `init_reward_vault`.) The three
   lp_locker PDAs are checked. Fails with `TooSmall` if `xnt_creator == 0`. auth_wxnt rent
   (caller) is refunded; the reward vault's rent (first call only) is the caller's.
   Wraps `xnt_creator` into auth_wxnt and CPIs lp_locker `deposit_reward(amount)` with
   depositor = auth (invoke_signed). If the reward vault doesn't exist, CPI
   `init_reward_vault` first (payer caller). Emits `CreatorFunded`.

6. `publish_list(root: [u8;32], epoch: u64, total: u64)`
   publisher(s), vault(w).
   First, if a pending list exists and `now ≥ pending_active_at`, it becomes the active one
   (same as in `pay`). A pending list that isn't due yet is replaced by the new one.
   Requires signer == publisher, `epoch > max(list_epoch, pending_epoch)`,
   `total ≥ max(list_total, pending_total)`, `total ≤ holders_funded`. Sets the pending list
   with `pending_active_at = now + LIST_DELAY_SECS`. Emits `ListPublished`.

7. `cancel_list()`
   guardian(s), vault(w). Clears the pending list, whether or not its time has passed, as
   long as nothing (a `pay` or `publish_list`) has activated it yet; an active list can't be
   cancelled. `NoPendingList` if there is none. Emits `ListCancelled`.

8. `pay(cumulative: u64, proof: Vec<[u8;32]>)`
   payer(w,s), vault(w), auth(w), wallet(w), record(w, init_if_needed, payer = payer),
   system_program.
   First, if a pending list exists and `now ≥ pending_active_at`, it becomes the active one.
   Verifies the leaf against the active root (`BadProof`, also when no list is active yet),
   pays `cumulative − record.paid` lamports from auth to wallet (invoke_signed),
   `record.paid = cumulative`, `holders_paid += amount`. Fails with `NothingToPay` when
   nothing is owed, with `OverFunded` if `holders_paid + amount` would exceed `list_total`
   (a list whose leaves add up to more than its total can't pay more than its total), and
   with `WrongAccount` if wallet == auth. `pay` data: `cumulative: u64`, then `proof` as Borsh
   `Vec<[u8;32]>` (u32 LE length + 32 bytes each). The wallet must end rent-exempt: paying
   less than 890,880 lamports to a wallet with 0 lamports fails (allocate at least that).
   Emits `Paid`.

## Events

`Collected { vault, got, burned }`, `Sold { vault, tokens_in, xnt_out, to_lp, to_creator,
to_holders, crank_reward }`, `LiquidityAdded { vault, tokens, xnt, lp_burned }`,
`CreatorFunded { vault, amount }`, `ListPublished { vault, epoch, root, total, active_at }`,
`ListCancelled { vault, epoch }`, `Paid { vault, wallet, amount, cumulative }`.

## Errors

`BadMint, BadAuthority, BadPool, BadLock, BadSplit, NotPublisher, NotGuardian, StaleEpoch,
TotalDecreased, OverFunded, NoPendingList, BadProof, NothingToCollect, NothingToPay,
TooSmall, Insolvent, MathOverflow, WrongAccount, OneSellPerSlot` (Anchor codes 6000..6018 in
this order).

## Off-chain (crank, in the site server)

- For each vault token, every cycle: `collect` (harvest accounts that hold withheld tax, in
  chunks), `sell` until the sell buckets are under the dust limit or the impact cap stops
  it (one `sell` per transaction, and wait for the next slot between sells, else
  `OneSellPerSlot`), `add_liquidity` when enough is set aside, `fund_creator` when
  `xnt_creator > 0`.
- Rewards list: new holders' XNT (`holders_funded − list_total`) is allocated pro-rata to
  eligible holders with today's rules (excluded owners, off-curve owners, minimum holding)
  and added to each wallet's running total (kept in the token's state dir); the list (all
  wallets and totals) is saved publicly (served at `/api/vault/<mint>/list`), then
  `publish_list`. After the delay, `pay` every wallet whose total grew (batched).
- Launches (when `factory.taxVault.programId` is set, testnet): `init_vault` must be signed
  by the creator (the mint's metadata update authority) or be atomic with the hand-over of
  the withdraw authority (see `init_vault`). Either (a) the mint's withdraw authority is the
  vault's `auth` PDA from the start and the **creator's wallet signs `init_vault`** (e.g. in
  the lock step, or a 4th step), or (b) the mint starts with the per-token distributor key
  as withdraw authority (as today) and registration sends `SetAuthority(WithheldWithdraw →
  auth)` + `init_vault` in one transaction signed by that key (same as a migration).
  publisher = the crank key, guardian = the creator. Those tokens are skipped by the
  hot-wallet distributor. The mint must have no maximum transfer fee (`u64::MAX`, as the
  factory does) and no freeze authority.
- Migration of an existing token: its distributor key signs Token-2022
  `SetAuthority(WithdrawWithheldTokens → auth)` and `init_vault` in one transaction, after
  a last normal payout cycle.

## Changes from the first draft (made while implementing the program)

1. `Vault` gains `last_sell_slot: u64` at the end (size 472 → **480** bytes incl. the
   discriminator); new error `OneSellPerSlot` (6018) at the end of the list.
2. `init_vault`: `auth` is writable; new last account `instructions` (sysvar); creator
   signature or atomic hand-over required; mint must also have only the fee/metadata
   extensions, no freeze authority and an uncapped fee; payer funds auth's rent reserve.
3. The invariant includes auth's rent-exempt reserve (`Rent::minimum_balance(0)`).
4. `sell` and `add_liquidity`: new last account `native_mint` (XDEX needs both mints, and
   creating the wXNT account needs the mint). Impact cap `min(300, tax_bps/2)`; one sale
   per slot. Temporary token accounts are paid by the caller and refunded by auth.
5. `fund_creator`: new last accounts `lock`, `token_2022_program` (for `init_reward_vault`).
6. `publish_list` activates a due pending list first; `cancel_list` works on any pending
   list not yet activated.
7. `pay`: payouts in all never exceed `list_total` (`OverFunded`); no active list →
   `BadProof`; wallet ≠ auth.

---

# v2 (testnet first): creator rewards in the network's reward token, guardian limit, vault upgrade

Everything above stays unless changed here. v2 is an upgrade of the same program
(`D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW`); existing vaults (CUP on testnet) are
upgraded in place by `upgrade_vault`.

## New constants (per network, feature `testnet`)

| Name | Testnet | Mainnet |
|---|---|---|
| `REWARD_MINT` | XNM `AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ` (Token-2022, 9 dp, no transfer fee) | USDC.X `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` (Token-2022, 6 dp) |
| `REWARD_POOL` | XNM/XNT `6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA` | USDC.X/XNT `CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR` |
| `REWARD_MAX_IMPACT_BPS` | `300` | `300` |
| effective reward-swap impact cap | `min(300, trade_fee_rate / 200)` bps = **15** (fee 3000 millionths) | **14** (fee 2800) |
| `MAX_CANCELS_IN_ROW` | `2` | `2` |

The creator reward is always paid in the network's `REWARD_MINT` (never chosen per token).
The program must refuse a reward mint with a transfer fee.

## Vault layout v2 (append only; old fields and offsets unchanged)

After `last_sell_slot` (offset 472) append:

```rust
pub version: u8,            // 2 (offset 480)
pub cancels_in_row: u8,     // guardian cancels since the last list went live (481)
pub total_reward_out: u64,  // reward tokens ever deposited for the creator (482)
pub last_reward_slot: u64,  // slot of the last reward swap in fund_creator (490)
pub reserved: [u8; 54],     // future use, zero (498..552)
```

`Vault` v2 = **552** bytes including the discriminator. `init_vault` creates v2 vaults
directly (version 2, `reward_mint = REWARD_MINT`, `reward_swap_pool = REWARD_POOL`). Every
instruction except `upgrade_vault` requires a v2 vault (`WrongVersion` otherwise: the
program's vault deserializer refuses an account shorter than 552 bytes or whose byte 480
isn't 2, before any other check).

## New / changed instructions

9. `upgrade_vault()` — anyone
   payer(w,s), vault(w) [480-byte v1 vault, read as raw bytes], system_program.
   Reallocs the vault to 552 bytes (payer pays the extra rent), sets `version = 2`,
   `cancels_in_row = 0`, `total_reward_out = 0`, `last_reward_slot = 0`, `reserved = 0`,
   `reward_mint = REWARD_MINT`, `reward_swap_pool = REWARD_POOL`; every other byte of the
   first 480 is kept. Fails with `WrongVersion` if the account isn't exactly 480 bytes
   (already v2), and with `WrongAccount` if it isn't this program's vault (owner, the
   `Vault` discriminator, and `["vault", mint]` with its stored bump at offset 470). XNT
   already in `xnt_creator` is swapped by the next `fund_creator`. (The creator's older XNT
   reward vault in lp_locker stays claimable as before.)
   Data: the 8-byte discriminator only.

5. `fund_creator()` (v2) — anyone
   caller(w,s), vault(w), auth(w), auth_wxnt(w), creator_nft, reward_mint, reward_vault(w)
   [lp_locker `["reward", creator_nft, reward_mint]`], reward_tokens(w) [lp_locker
   `["reward_tokens", reward_vault]`], locker_program, token_program, associated_token_program,
   system_program, lock, token_2022_program, **auth_reward(w)** [ATA(auth, reward_mint,
   reward_token_program)], **reward_pool(w)**, **reward_amm_config**, **xdex_authority**,
   **reward_pool_reward_vault(w)**, **reward_pool_wxnt_vault(w)**, **reward_observation(w)**,
   **xdex_program**, **native_mint**, **reward_token_program**.
   (24 metas; `reward_token_program` is Token-2022 on both networks, so the transaction has
   23 distinct accounts + ComputeBudget: 945 bytes with one signer.)
   `auth_wxnt` is now ATA(auth, NATIVE_MINT, SPL Token) (in v1 it was keyed by the reward
   mint, which was wXNT). Checks, in this order:
   - **one reward swap per slot**: `OneSellPerSlot` if `slot ≤ last_reward_slot` (so several
     capped swaps can't be sandwiched in one transaction; the crank waits a slot between
     `fund_creator` calls);
   - `TooSmall` if `xnt_creator == 0`;
   - `reward_mint == vault.reward_mint` (else `BadRewardMint`), `reward_pool ==
     vault.reward_swap_pool` (else `WrongAccount`), the three lp_locker PDAs and `auth_reward`
     (else `WrongAccount`);
   - the reward mint is owned by `reward_token_program` (SPL Token or Token-2022) and has
     only MetadataPointer / TokenMetadata / group extensions — **no transfer fee**, hook,
     permanent delegate, pause, etc. (else `BadRewardMint`);
   - the pool is XDEX `{reward_mint (reward_token_program), NATIVE_MINT (SPL Token)}` with
     swaps open (else `BadPool`); its amm config, observation and both vaults (else
     `WrongAccount`).
   Amount: `xnt_in = min(xnt_creator, cap)` with the impact cap
   `min(REWARD_MAX_IMPACT_BPS, trade_fee_rate / 200)` bps (half the pool's trade fee:
   a sandwich pays the fee twice on the attacker's size and gains about twice the swap's
   relative size, so staying under the fee makes it unprofitable; with no transfer tax on
   this pair, a 3% cap alone would not), `cap = reserve_xnt*bps/(1e4-bps)` from live reserves
   net of protocol/fund fees. Expected out = CPMM with the config's trade fee (like `sell`);
   min out = expected × (1 − OUT_TOLERANCE). `TooSmall` if `xnt_in == 0` or `min_out == 0`.
   Creates auth_wxnt and auth_reward (payer caller), wraps `xnt_in`, swaps (XDEX
   `swap_base_input`, owner = auth; input auth_wxnt, output auth_reward), requires the output
   ≥ min out, closes auth_wxnt into auth, CPIs lp_locker `deposit_reward(held)` from
   auth_reward where `held` = auth_reward's whole balance (the swap output, plus anything
   someone sent to that account earlier, so it can always be closed), checks lp_locker's
   reward token account grew by exactly `held` (`BadRewardMint`), closes auth_reward into
   auth and refunds the caller both accounts' rent (init the reward vault first if missing,
   payer caller; that rent is not refunded). Updates `xnt_creator -= xnt_in`,
   `total_creator_xnt += xnt_in`, `total_reward_out += held`, `last_reward_slot = slot`.
   Emits `CreatorFunded { vault, xnt_in, reward_out, reward_mint }` with `reward_out = held`
   (new fields; the v1 event shape `{ vault, amount }` is replaced).
   Compute: ~150–160k CU, ~175–195k CU when it also creates the reward vault (varies with
   PDA bump searches) — set a compute-unit limit of ≥ 250k; the default 200k is too tight.

7. `cancel_list()` (v2)
   Checks `NotGuardian`, then `NoPendingList`, then fails with `TooManyCancels` when
   `cancels_in_row >= MAX_CANCELS_IN_ROW`; otherwise clears the pending list and
   `cancels_in_row += 1`.

Activation (in `pay` and `publish_list`): when a pending list becomes the active one,
`cancels_in_row = 0`.

New errors appended after `OneSellPerSlot`: `WrongVersion`, `TooManyCancels`, `BadRewardMint`.

## Off-chain (v2)

- Crank: run `upgrade_vault` once for any 480-byte vault; `fund_creator` with the v2 account
  list; skip it when the reward swap would output nothing. It may take several calls (one
  per slot) when `xnt_creator` is above the impact cap; the rest stays in `xnt_creator`.
- Deploying v2 over the live v1 program: the v2 .so (~569 KB) is larger than the v1
  program data (519,416 bytes), so run `solana program extend <program> <extra bytes>`
  before `solana program deploy`.
- Site: a vault token's creator reward reads the vault's `reward_mint` (XNM on testnet,
  USDC.X on mainnet) for the NFT page, My earnings, tokens list and claims; show the right
  symbol and decimals. Legacy tokens keep reading their own configured reward mint.
- Events: `creator-reward` entries record `xnt` (in) and the reward token amount/symbol.

## Changes from the first v2 draft (made while implementing the program)

1. Layout: `last_reward_slot: u64` at offset 490 (one reward swap per slot, error
   `OneSellPerSlot`); `reserved` shrinks to 54 bytes (498..552). Size stays 552.
2. Reward-swap impact cap is `min(REWARD_MAX_IMPACT_BPS, trade_fee_rate / 200)` bps (15 on
   testnet, 14 on mainnet), not a flat 3%: the XNT → reward swap has no transfer tax to
   make a sandwich unprofitable, only the pool's trade fee.
3. `fund_creator` deposits auth_reward's whole balance (`reward_out` = that), check order
   and error codes as listed above; `auth_wxnt` is ATA(auth, NATIVE_MINT).
4. `upgrade_vault`: `WrongAccount` for an account that isn't this program's vault.

# v3 (testnet first): keeps working if the operator disappears

Everything above stays unless changed here. v3 is an upgrade of the same program; v1 and
v2 vaults are upgraded in place by `upgrade_vault`.

**Goal.** Every flow must keep working with the 99 + Tax operator (its server, its site
and its publisher key) gone for good:

- collect, sell, burn, add liquidity, creator reward and paying an existing list are
  already permissionless (any `caller`, who earns the crank reward where one applies);
- the rewards list files must be retrievable without the site (IPFS, address on-chain);
- **(A)** the guardian (creator) may appoint a new publisher, but only after the publisher
  has been silent for `APPOINT_AFTER_SECS`, so a stolen creator key can't take over while
  the operator is alive;
- **(C)** after `FALLBACK_AFTER_SECS` without a published list, anyone can keep paying
  holders from the last active list, scaled up to everything funded so far.

## New constants

| Name | Value | `short-windows` feature (tests only) |
|---|---|---|
| `APPOINT_AFTER_SECS` | `7 * 86_400` | `15` |
| `FALLBACK_AFTER_SECS` | `30 * 86_400` | `30` |
| `VAULT_VERSION` | `3` | |
| `VAULT_V3_LEN` | `640` | |

## Vault layout v3

Offsets 0..498 are unchanged from v2 (version byte at 480 becomes `3`). The v2 `reserved`
bytes are reused and the account grows to **640** bytes:

```rust
pub version: u8,                 // 3 (offset 480)
pub cancels_in_row: u8,          // (481)
pub total_reward_out: u64,       // (482)
pub last_reward_slot: u64,       // (490)
pub last_publish_at: i64,        // unix time of the last publish_list (498)
pub list_cid: [u8; 33],          // IPFS address of the active list file (506)
pub pending_cid: [u8; 33],       // IPFS address of the pending list file (539)
pub fallback_paid: u64,          // XNT paid by pay_fallback, ever (572)
pub reserved: [u8; 60],          // zero (580..640)
```

A CID field is `[codec, sha256 digest (32)]`: codec `0x55` (raw) or `0x70` (dag-pb), i.e.
the CIDv1 `0x01 codec 0x12 0x20 digest`; all zero = no file. The program stores it and
never interprets it.

`init_vault` creates v3 vaults directly with `last_publish_at = now` (so the clocks start at
creation). Every instruction except `upgrade_vault` requires a v3 vault (`WrongVersion`).

## Changed / new instructions

1. **`upgrade_vault`** (anyone, payer pays the extra rent): accepts a 480-byte (v1) or
   552-byte (v2) vault and makes it v3 in one call: a v1 vault first gets the v2 rewrite
   (reward mint/pool, cleared counters); then resize to 640, bytes 498..640 zeroed,
   `version = 3`, `last_publish_at = now` (an upgraded vault gets the full windows from
   the upgrade). Refuses anything else (`WrongVersion` / `WrongAccount` as in v2).
2. **`publish_list(root, epoch, total, cid: [u8; 33])`**: as v2 plus stores `pending_cid =
   cid` and `last_publish_at = now`. New check (in `check_publish`): `total >=
   holders_paid` (`TotalDecreased`), since v3 payments can exceed `list_total` while in
   fallback.
3. **Activation** (`activate_if_due`, wherever v2 calls it): also `list_cid = pending_cid`
   and clears `pending_cid`. **`cancel_list`** also clears `pending_cid` (and does not
   touch `last_publish_at`).
4. **`set_publisher(new_publisher)`**, signer = current `publisher`: immediate key
   rotation by the operator. Emits `PublisherChanged { vault, old, new, by_guardian: false }`.
5. **`appoint_publisher(new_publisher)`**, signer = `guardian`: allowed only when `now >=
   last_publish_at + APPOINT_AFTER_SECS` (else `PublisherActive`). Sets `publisher`,
   emits `PublisherChanged { .., by_guardian: true }`. It does not reset
   `last_publish_at` (the new publisher resets it by publishing).
6. **`pay_fallback(cumulative, proof)`**: same accounts as `pay` (anyone is `caller`, pays
   the PaidRecord rent). Requires, after `activate_if_due`: `list_epoch > 0`, no pending
   list, and `now >= last_publish_at + FALLBACK_AFTER_SECS` (else `FallbackNotActive`).
   Verifies `(wallet, cumulative)` against the **active** `list_root` (`BadProof`), then:

   ```
   entitled = floor(cumulative * holders_funded / list_total)   // u128 maths
   require entitled > record.paid                               // NothingToPay
   amount = entitled - record.paid
   require holders_paid + amount <= holders_funded              // OverFunded
   pay amount; record.paid = entitled; holders_paid += amount; fallback_paid += amount
   ```
   The last list's shares are scaled up to everything funded, so the XNT keeps reaching
   the same wallets in the same proportions as more tax arrives. Emits
   `FallbackPaid { vault, wallet, amount, entitled }`; `check_solvent` after.
7. `pay` (the normal path) is unchanged and still allowed in fallback (it pays at most
   `cumulative`, which is <= `entitled`).

Leaving fallback: any `publish_list` resets `last_publish_at`, so fallback ends as soon
as a publisher (the old one or an appointed one) publishes. That list's `cumulative`
values must include what each wallet was already paid (`>= record.paid`), and its
`total >= holders_paid`.

New errors appended after `BadRewardMint`: `PublisherActive`, `FallbackNotActive`.

## Off-chain (v3)

- **List files on IPFS.** Before `publish_list`, the crank pins the list file (the same
  JSON as `/api/vault/<mint>/list`: `{ version, mint, vault, epoch, root, total,
  entries: [[wallet, cumulative], ...] }`, entries sorted by wallet) to IPFS through
  Pinata (`factory.pinataJwt`), and passes its CID. No pin, no publish (retry next
  pass). The site shows the CID and a gateway link.
- **Lists after a fallback.** The list builder starts each wallet from
  `max(previous cumulative, on-chain paid)` before adding the new allocation, so a new
  list never pays anyone less than they already got and `total >= holders_paid`.
- **Crank.** Upgrades v1/v2 vaults to v3; in fallback, runs `pay_fallback` for wallets
  with something owed (dust rules as for `pay`).
- **"Run the vault" button** on each vault token's page: any visitor's wallet signs the
  permissionless steps that are due (collect, sell, add liquidity, creator reward, pay /
  pay_fallback) and earns the crank rewards. The site only builds the transactions.
- **Creator controls** (NFT / launch page, guardian wallet only): "Appoint a new
  publisher" once allowed, with the date it becomes allowed shown before that.
- **Status** on the token page: publisher, last list published, when appointing becomes
  possible, when fallback starts, and "Fallback active: paying from the last list".
- **Standalone crank** `scripts/crank.ts`: needs only an RPC and a wallet (no site, no
  config.json): cranks one mint or every vault of the program, reads list files from IPFS
  via the on-chain CID, runs pay / pay_fallback; with `--publisher <keypair>` it also
  builds and publishes lists (what an appointed publisher runs).

### Off-chain (v3) as implemented

The shared steps live in `src/vault-crank.ts` (used by the site's crank in
`src/factory/vault.ts`, the "Run the vault" routes and `scripts/crank.ts`).

- **List file bytes.** The pinned file is `JSON.stringify({ version: 1, mint, vault, epoch,
  root, total, entries, rules })` with `entries` sorted by wallet (`listFileText`); amounts
  are decimal strings. `rules` carries the token's payout rules in base units (`minHarvest`,
  `minPayout`, `minCycle`, `minHolding`, `excludeOwners`, `excludeOffCurve`) so another
  publisher applies the same eligibility (the burn addresses, the vault's auth PDA and
  XDEX's pool authority are always excluded). `/api/vault/<mint>/list` keeps its own shape
  and adds `cid` / `cidUrl`. A fetched file is used only if it is for this vault and its
  entries give the on-chain root (and, for a raw-codec CID, its bytes hash to the digest).
- **CIDs** are written as CIDv1 base32 (`b…`); `cidToBytes` also accepts CIDv0 (`Qm…`,
  dag-pb). The Pinata upload API and gateway can be overridden (`factory.pinataApiUrl` /
  `PINATA_API_URL`, `factory.ipfsGateway` / `IPFS_GATEWAY`).
- **List builder.** Each wallet starts at `max(previous cumulative, PaidRecord.paid)` over
  every PaidRecord of the vault (one `getProgramAccounts`); the new XNT is `holders_funded −
  Σ start`, allocated pro-rata; if rounding (or a list rebuilt from paid records because the
  previous file is unreadable) leaves the total under `max(list_total, pending_total,
  holders_paid)`, the difference goes to the largest share. A publisher publishes when the
  new XNT is at least `minCycle`, or in fallback (any list ends it).
- **Clock margins.** The crank treats fallback as active 15 s after `last_publish_at +
  FALLBACK_AFTER_SECS` (the chain clock lags). `TAX_VAULT_SHORT_WINDOWS=1` makes the
  client use the `short-windows` build's 15 s / 30 s.
- **Site crank.** It publishes only while `publisher` is its own key; a list it doesn't have
  (another publisher's) is read from IPFS by the on-chain CID. No Pinata key: no new lists.
- **Routes.** `POST /api/vault/<mint>/crank-tx {caller}` returns the due steps as unsigned
  transactions in order (`upgrade` alone if the vault isn't v3; else `collect` of the
  accounts that fit one transaction, one `sell`, `add_liquidity`, `fund_creator`, then
  `pay` / `pay_fallback` for up to 4 wallets, existing PaidRecords first), with the sale's
  estimated crank reward, the network fees and the new records' rent; only the first is
  simulated (the rest count on it). `POST /api/vault/<mint>/crank-result {signatures}`
  reads those transactions back (only events logged by the tax_vault program itself count)
  and adds them to the token's event log. `POST /api/vault/<mint>/appoint-tx {guardian,
  newPublisher}` refuses a wallet that isn't the guardian or a request before
  `last_publish_at + APPOINT_AFTER_SECS`.

## Changes from the first v3 draft (made while implementing the program)

No behaviour changes; these pin down details the draft left open.

1. `pay_fallback` uses the exact `pay` account list (payer(w,s), vault(w), auth(w),
   wallet(w), record(w), system_program) and the same data (`cumulative: u64`, Borsh
   `Vec<[u8;32]>` proof). Check order: `WrongAccount` (wallet == auth), then
   `FallbackNotActive` (after `activate_if_due`: `list_epoch == 0`, a pending list, or
   `now < last_publish_at + FALLBACK_AFTER_SECS`), `BadProof`, `NothingToPay`, `OverFunded`.
   A list with `list_total == 0` entitles nobody (`NothingToPay`); an entitlement that
   doesn't fit a u64 (a leaf far above the list total) fails with `MathOverflow`.
2. The v1 invariant `holders_paid ≤ list_total` no longer holds once `pay_fallback` has
   paid (`fallback_paid > 0`); `holders_paid ≤ holders_funded` and `list_total ≤
   holders_funded` always hold. A normal `pay` checks `holders_paid + amount ≤ list_total`
   as before, so in fallback it mostly fails with `NothingToPay`/`OverFunded`.
3. `appoint_publisher` checks `NotGuardian` before `PublisherActive`; `set_publisher`
   fails with `NotPublisher`. Neither touches `last_publish_at`; `cancel_list` doesn't either.
4. `upgrade_vault`: a 552-byte account whose byte 480 isn't 2, or any other length
   (640 = already v3), fails with `WrongVersion`; the `WrongAccount` checks are as in v2.
5. Error codes: `PublisherActive` = 6022, `FallbackNotActive` = 6023.
6. Deploying v3 over the live v2 program: the v3 .so is 590,376 bytes vs 568,896 bytes of
   program data, so `solana program extend <program> 21480` first.

# Publisher quorum (Squads, no program change)

Everything above stays. This removes the single publisher key (review findings A and B in
docs/REVIEW.md) **without changing the program**: the vault's `publisher` becomes a Squads
v4 vault PDA, so `publish_list` only runs when a quorum of independent keys signed off on
the list. Squads executes an approved vault transaction with that PDA as the signer, so
`publish_list` and `set_publisher` work unchanged.

## Setup

| | |
|---|---|
| Squads v4 program | testnet `DDL3Xp6ie85DXgiPkXJ7abUyS2tGv4CGEod2DeQXQ941` · mainnet `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` (official). The client passes the id explicitly everywhere (`@sqds/multisig`, `programId`). |
| publisher | the multisig's vault PDA, index 0 (`["multisig", multisig, "vault", 0u8]`) |
| members | the site's crank key (Initiate, Vote, Execute); an independent **co-signer** (Vote, Execute); optionally a cold **backup** (Initiate, Vote, Execute) |
| threshold | 2 |
| config authority | none (autonomous: adding/removing members or changing the threshold needs the multisig itself) |
| time lock | 0 |
| rent collector | the site's key (closing finished proposals returns their rent to it) |

`scripts/setup-publisher-quorum.ts` creates the multisig (dry run by default) and, with
`--execute` and the current publisher's key, sends `set_publisher(vault PDA)` for the given
mints. The site finds the multisig in `factory.taxVault.quorum: { multisig, programId? }`.
A vault whose publisher is a plain key keeps today's behaviour exactly.

## Lists carry their inputs

The pinned list file (`listFileText`) keeps every field it had (`parseListFile` and
`scripts/crank.ts` read old and new files alike) and adds `inputs`:

```
inputs: {
  slot,            // slot the balances were read at
  holdersFunded,   // the vault's holders_funded the pot was taken from
  floor,           // max(list_total, pending_total, holders_paid) when built
  pot,             // XNT split pro-rata: holdersFunded - sum(start)
  prev,            // { epoch, root, cid } of the list it builds on, or null (first list)
  paid,            // [wallet, paid] for PaidRecords above the previous list's amount (usually none; after a fallback)
  balances,        // [wallet, balance] of every eligible wallet used, sorted by wallet
}
```

**Deterministic allocation** (`composeList` over `allocate`): `start(w) = max(prev(w),
paid(w))`; `share(w) = floor(pot * balance(w) / sum(balances))`; `cumulative(w) = start(w)
+ share(w)`; if the sum is under `floor`, the difference goes to the largest share (ties:
the smaller wallet address); zero entries are dropped. Anyone holding the file, the previous
file and the chain can recompute it.

## Site crank (publisher is a Squads vault whose members include the site key)

1. Build and pin the list exactly as today (no pin, no proposal).
2. One transaction: `vault_transaction_create` (message: the single `publish_list`, payer =
   the vault PDA), `proposal_create`, `proposal_approve` by the site key. `vault-list.json`
   `next.proposal` records `{ multisig, index, status }`; history event `proposed`.
3. Each pass: read the proposal. **Approved** (threshold met): execute it (`vault_transaction_execute`,
   the site pays the fee); the list is then pending on-chain as before (`published`).
   **Executed** (by the co-signer): the same. **Rejected / Cancelled**, or **rejected by any
   other member** (a single rejection is final for the site: it adds its own rejection so the
   proposal closes), or **stale** (the vault's epoch reached the list's, or its total no
   longer fits `check_publish`): history `rejected` / `dropped`, `next` cleared, a new list is
   built next pass. Rent of finished proposals is reclaimed with
   `vault_transaction_accounts_close`.
4. Payouts are unchanged (anyone can `pay`), except that the site doesn't `pay_fallback` while
   its proposal waits (that could pay a wallet past the proposed totals, which the co-signer
   refuses).
5. Execution races: the co-signer may execute first; the site reads the proposal back rather
   than interpreting the error (Squads' and tax_vault's Anchor error codes overlap).

Found while rehearsing, applies to plain-key publishers too: a list that allocates nothing new
(one that ends a fallback after `pay_fallback` already paid everything funded) owes nobody
anything, so no `pay` activates it and the crank used to wait on it forever. When a due
pending list owes nobody anything, the crank now builds the next list on it (`publish_list`
activates the due list first; `inputs.prev` names it).

## Co-signer (`scripts/cosigner.ts`, shared checks in `src/list-verify.ts`)

Runs anywhere with its own key and an RPC. For every Active proposal of the multisig it
hasn't voted on:

- the vault transaction must be **exactly one** instruction: `publish_list` of the
  configured `tax_vault` program, accounts `[the multisig's vault PDA (signer), a vault
  account of that program whose publisher is that PDA]`; vault index 0, no ephemeral
  signers, no lookup tables, no other account keys;
- the list file is fetched by the instruction's CID; a raw-codec CID must hash to the
  bytes; the entries must give the instruction's root; file `epoch`/`total`/`vault` equal the
  instruction's;
- **totals**: `total == sum(entries)`, `total <= holders_funded`, `total >= max(list_total,
  pending_total, holders_paid)`, `epoch > max(list_epoch, pending_epoch)`; a pending list
  that isn't due yet is refused (the site never replaces one);
- **nobody loses**: every wallet of the previous list (the on-chain active list, fetched by
  its CID and checked against its root; `inputs.prev` must name it) keeps at least its
  cumulative, and every wallet at least its on-chain PaidRecord;
- **allocation**: recomputed from `inputs` with the pinned rules must equal the entries
  exactly; `inputs.pot == inputs.holdersFunded - sum(start)`, `inputs.holdersFunded <=
  holders_funded`; `inputs.floor` between `list_total` and today's `max(list_total,
  pending_total, holders_paid)`; `inputs.paid` never above today's PaidRecord;
- **eligibility**: no stated balance for an excluded wallet (the rules' owners, burn
  addresses, the vault's auth PDA, XDEX's pool authority, the publisher PDA), for an
  off-curve owner when the rules exclude them, or under `minHolding`; no excluded wallet's
  cumulative grows; the eligibility rules equal the previous list's (a change needs
  `--allow-rule-change`);
- **balances vs chain**: the stated balances are compared with today's eligible balances;
  a wallet that moved more than the tolerance (default 5% and at least `minHolding`) is
  flagged; more than 10% of the stated weight moved fails;
- **flags** (reported, not a failure unless `--strict`): moved wallets, a wallet new to the
  list getting more than 25% of the pot, an old snapshot, a CID that can't be hash-checked
  (dag-pb).

Pass: approve (and execute once the threshold is met); optionally pin the same bytes to
its own IPFS provider (second copy). Fail: reject with the reason as the vote's memo, log it
and post it to `--webhook`. It executes only proposals it approved.

## What this changes and what it doesn't

- A stolen or malicious site key alone can't publish: every list needs the co-signer's
  (or the backup's) approval. It can't rotate the publisher either (`set_publisher` would
  need a vault transaction the co-signer refuses).
- A rejected proposal never reaches `publish_list`, so it doesn't touch `last_publish_at`:
  **an operator that only proposes bad lists no longer keeps recovery closed** (finding A).
  Once 7 days pass without a published list, the guardian can appoint as before.
- Per-wallet entitlements across lists are checked by the co-signer before a list can go
  live (finding B), off-chain: the guarantee holds as long as 2 of the members are honest.
- The program is unchanged; the guardian's cancel, the delay, the fallback and appointing
  work as before. The guardian can still appoint a plain key after 7 days of silence (the
  quorum then ends for that vault).

# Payout token (v4)

A launch can pay its holders in another token instead of XNT. The choice is made once, at
creation (`init_vault_payout`), and never changes. Vaults created before (or with
`init_vault`) pay XNT exactly as before; no upgrade step is needed.

## Layout (inside the v3 reserved bytes; the account stays 640 bytes)

| Offset | Field | Meaning |
|---|---|---|
| 580 | `payout_pool: Pubkey` | The payout token's XDEX pool against wXNT; all zero = XNT payouts |
| 612 | `xnt_holders: u64` | Holders' XNT not yet swapped into the payout token |
| 620 | `reserved: [u8; 20]` | Zero |

With a payout token, `holders_funded`, `holders_paid`, list totals, `fallback_paid` and every
`PaidRecord.paid` are in the payout token's base units.

## Instructions

* `init_vault_payout(burn_bps, lp_bps, publisher, guardian)`: `init_vault`'s accounts plus
  `payout_mint`, `payout_pool`, `payout_token_program`. The payout mint must be an SPL Token or
  Token-2022 mint with **no freeze authority** and only metadata / group extensions (no transfer
  fee, hook, permanent delegate or pause), and differ from the tax token and wXNT. The pool must
  be an XDEX pool of exactly that mint against wXNT, with swaps open. It is stored for good:
  every holders' swap goes through it, so nobody can route the swap through a thin pool.
* `sell`: in a payout-token vault the holders' XNT goes to `xnt_holders` (not `holders_funded`).
* `fund_holders`: swaps up to `xnt_holders` into the payout token on the payout pool, capped
  like the reward swap (`reward_impact_bps`, one swap per slot shared with `fund_creator`), and
  keeps the output in auth's payout-token account (opened once; its rent comes out of
  `xnt_holders`). `holders_funded += out`. Event `HoldersFunded { vault, xnt_in, payout_out, payout_mint }`.
* `pay_token` / `pay_fallback_token`: the same proofs and bookkeeping as `pay` /
  `pay_fallback`; the amount moves from auth's payout account to the wallet's (opened if needed,
  paid by `payer`) with `transfer_checked`, and the wallet must receive exactly that amount.
* `pay` / `pay_fallback` refuse a payout-token vault (`PaysInToken`); the token versions refuse
  an XNT vault (`PaysInXnt`). New errors: `PaysInToken`, `PaysInXnt`, `BadPayoutMint`, `BadPayoutPool`.

## Invariants

* Lamports: auth holds `xnt_lp + xnt_creator + (XNT vault ? holders_funded − holders_paid : xnt_holders)` plus its reserve.
* Payout tokens (checked after `fund_holders` and every token payment): auth's payout account
  holds at least `holders_funded − holders_paid`.

## Off-chain

* The site offers the choice only with `factory.taxVault.payoutTokens: true` (the program must
  be v4) and checks the token before step 1 (`/api/payout-token`): its pool against XNT (XDEX's
  standard pool for it, or the one XDEX's API lists), the same mint rules, and at least
  `factory.taxVault.payoutMinPoolXnt` (default 10) XNT in the pool.
* The crank adds `fund_holders` after `fund_creator`, pays with the token instructions, and
  converts the XNT minimums (`minCycle`, `minPayout`) into payout units at the pool's spot price.
* The site's stats stay in XNT: each token payout is also logged at the vault's average swap
  price (`holders-swap` entries), alongside the token amounts.
* Rehearsal: `scripts/payout-token-rehearsal.ts`.
