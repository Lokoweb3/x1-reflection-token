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
| `MAX_CANCELS_IN_ROW` | `2` | `2` |

The creator reward is always paid in the network's `REWARD_MINT` (never chosen per token).
The program must refuse a reward mint with a transfer fee.

## Vault layout v2 (append only; old fields and offsets unchanged)

After `last_sell_slot` (offset 472) append:

```rust
pub version: u8,            // 2 (offset 480)
pub cancels_in_row: u8,     // guardian cancels since the last list went live (481)
pub total_reward_out: u64,  // reward tokens ever deposited for the creator (482)
pub reserved: [u8; 62],     // future use (490..552)
```

`Vault` v2 = **552** bytes including the discriminator. `init_vault` creates v2 vaults
directly (version 2, `reward_mint = REWARD_MINT`, `reward_swap_pool = REWARD_POOL`). Every
instruction except `upgrade_vault` requires a v2 vault (`WrongVersion` otherwise).

## New / changed instructions

9. `upgrade_vault()` — anyone
   payer(w,s), vault(w) [480-byte v1 vault, read as raw bytes], system_program.
   Reallocs the vault to 552 bytes (payer pays the extra rent), sets `version = 2`,
   `cancels_in_row = 0`, `total_reward_out = 0`, `reward_mint = REWARD_MINT`,
   `reward_swap_pool = REWARD_POOL`. Fails with `WrongVersion` if already v2. XNT already in
   `xnt_creator` is swapped by the next `fund_creator`. (The creator's older XNT reward
   vault in lp_locker stays claimable as before.)

5. `fund_creator()` (v2) — anyone
   caller(w,s), vault(w), auth(w), auth_wxnt(w), creator_nft, reward_mint, reward_vault(w)
   [lp_locker `["reward", creator_nft, reward_mint]`], reward_tokens(w) [lp_locker
   `["reward_tokens", reward_vault]`], locker_program, token_program, associated_token_program,
   system_program, lock, token_2022_program, **auth_reward(w)** [ATA(auth, reward_mint,
   reward_token_program)], **reward_pool(w)**, **reward_amm_config**, **xdex_authority**,
   **reward_pool_reward_vault(w)**, **reward_pool_wxnt_vault(w)**, **reward_observation(w)**,
   **xdex_program**, **native_mint**, **reward_token_program**.
   Requires `reward_mint == vault.reward_mint` and `reward_pool == vault.reward_swap_pool`.
   Wraps up to `xnt_creator` into auth_wxnt, swaps XNT → reward token on the reward pool
   (XDEX `swap_base_input`, owner = auth; amount capped so the swap moves the price at most
   `REWARD_MAX_IMPACT_BPS`; min out computed on-chain from live reserves × (1 −
   OUT_TOLERANCE)), unwraps any leftover, then CPIs lp_locker `deposit_reward(reward_out)`
   from auth_reward (init the reward vault first if missing, payer caller). Updates
   `xnt_creator -= xnt_in`, `total_creator_xnt += xnt_in`, `total_reward_out += reward_out`.
   Emits `CreatorFunded { vault, xnt_in, reward_out, reward_mint }` (new fields; the v1
   event shape `{ vault, amount }` is replaced).

7. `cancel_list()` (v2)
   Fails with `TooManyCancels` when `cancels_in_row >= MAX_CANCELS_IN_ROW`; otherwise clears
   the pending list and `cancels_in_row += 1`.

Activation (in `pay` and `publish_list`): when a pending list becomes the active one,
`cancels_in_row = 0`.

New errors appended after `OneSellPerSlot`: `WrongVersion`, `TooManyCancels`, `BadRewardMint`.

## Off-chain (v2)

- Crank: run `upgrade_vault` once for any 480-byte vault; `fund_creator` with the v2 account
  list; skip it when the reward swap would output nothing.
- Site: a vault token's creator reward reads the vault's `reward_mint` (XNM on testnet,
  USDC.X on mainnet) for the NFT page, My earnings, tokens list and claims; show the right
  symbol and decimals. Legacy tokens keep reading their own configured reward mint.
- Events: `creator-reward` entries record `xnt` (in) and the reward token amount/symbol.
