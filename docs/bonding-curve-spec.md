# Bonding curve — implementation spec (testnet first)

The design and the reasons behind it: see the published design page. This file is the
contract between the on-chain program (`lp-locker/programs/bonding_curve`) and the
TypeScript client/server (`src/curve.ts`, `src/factory-server.ts`, `src/curve.html`).
Both sides must match it exactly. If something here turns out to be impossible, change
this file first and say so.

## Decisions (fixed)

- Tokens are **created at graduation**. During the curve, balances live in per-buyer
  `Position` accounts; no tokens exist, so no transfer tax applies on the curve.
- The token is created up front with its Token-2022 transfer fee (the creator's tax,
  100–1000 bps, config authority **None**, withdraw-withheld authority = the Tax Vault's
  `auth` PDA when the site runs the vault, else the token's distributor wallet; see
  [Tax authority](#tax-authority-and-the-creators-start-step)), metadata pointer +
  metadata, **mint authority = the curve's `auth` PDA**, freeze authority None, supply 0,
  9 decimals.
- 80% of the supply is sold on the curve; the rest seeds the XDEX pool at graduation.
- Graduation target: **chosen by the creator per curve** from 500 (the site's default),
  1,000, 3,000, 5,000 or 10,000 XNT (the `testnet` build also takes 10 and 20 XNT, so a
  curve can be graduated with faucet XNT); that XNT goes into the pool. It is stored in the
  curve (`target_xnt`). Curves created before targets were selectable (the first
  testnet program, fixed 20 XNT) keep their stored 20 XNT through the upgrade: buying,
  graduation and delivery read the target from the account.
- Fee: **1% of the XNT** on every curve buy and sell, to `FEE_RECEIVER`.
- The creator's own wallet may not buy on its curve (`buyer != creator`; the `testnet`
  build allows it). That doesn't stop a creator buying from other wallets, so the site
  must not say "the creator can't buy": what holds every wallet, the creator's others
  included, is the early-buy limit (no single wallet above 1% of the supply in the first
  2 minutes).
- Early-buy limit: for the first 120 s after creation, one wallet's position may hold at
  most 1% of the supply (counted across all its buys), all buyers together may take at
  most 10% (`EARLY_TOTAL_BPS`), and a transaction may carry only one buy, sent directly to
  the program (instructions sysvar; not through another program). It slows sniping; it
  can't stop someone using many wallets across transactions.
- The token's tax must go to a tax vault: its `withdraw_withheld_authority` is the auth PDA
  (`["auth", mint]`) of a program in `VAULT_PROGRAMS` (D9jt; on testnet also the passes
  trial Aqt57), and its `maximum_fee` is u64::MAX (no cap). No creator's wallet can take it.
- `create_curve` checks the XDEX fee tier graduation will use exists and accepts new pools.
- Refund: a curve left Complete for `REFUND_AFTER_SECS` (7 days) because its XDEX pool
  can't be created opens to `refund` (anyone may send it, per position): the owner gets
  their pro-rata share of `raised_xnt` plus the position's deposit, and after the last one
  the rest of `auth` goes to the creator and the curve account is closed (rent to the
  creator). No tokens are minted.
- Graduation is permissionless (two instructions, which clients send in **one
  transaction**, so the pool never exists without its lock); the caller of the second step
  gets 0.01 XNT. `graduate_pool` refuses to run unless `lp_locker` is executable.
- Lock fallback: a curve left PoolCreated for `LOCK_AFTER_SECS` (7 days) because
  `graduate_lock` keeps failing (lp_locker gone or changed) opens to `graduate_burn`
  (anyone): all of auth's LP is burned, so the liquidity is still locked forever but there
  is no lock NFT, and the curve goes on to Graduated so buyers get their tokens. Such a
  token has no fee NFT, no creator reward and can't start a Tax Vault (`init_vault` needs an
  lp_locker lock); its tax stays withheld. It's the last resort, for when the alternative is
  buyers never getting their tokens.
- A creator may `close_curve` a Trading curve with `tokens_sold == 0`: with no positions it
  closes now (graduation deposit and rent back to the creator); positions emptied by
  selling still hold their token-account deposits, so it moves to Refunding instead and the
  last `refund` (deposit only, no XNT was raised) closes it. A closed curve's mint (supply
  0, mint authority still `auth`) can be given a new curve by its creator.
- After graduation, anyone can `deliver` a buyer's tokens (the site's crank does all of
  them). When the last position is delivered, the mint authority is set to None.
- The LP is locked **forever** through the existing `lp_locker` (`lock`), no locker change.
  The lock NFT is transferred to the creator; its metadata update authority is the creator.

## Constants (Rust `pub const`, TS mirror in `src/curve.ts`)

| Name | Value |
|---|---|
| `LOCKER_PROGRAM_ID` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` |
| `XDEX_PROGRAM_ID` | testnet `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` · mainnet `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (feature `testnet`, as in lp_locker) |
| `XDEX_AMM_CONFIG` | testnet `3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY` · mainnet `2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c` |
| `XDEX_CREATE_POOL_FEE` | testnet `DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS` · mainnet `SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1` |
| `FEE_RECEIVER` | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` |
| `FEE_BPS` | `100` |
| `CURVE_BPS` | `8000` |
| `TARGETS_XNT_WHOLE` | `[500, 1_000, 3_000, 5_000, 10_000]` whole XNT, the graduation targets `create_curve` accepts (same with or without feature `testnet`). Replaces the old fixed `TARGET_XNT` (20 XNT), which older curves still hold in `target_xnt` |
| `GRADUATION_DEPOSIT` | `300_000_000` lamports, paid by the creator in `create_curve`; covers XDEX's pool fee, rents and the reward; the rest is refunded to the creator when the curve finishes |
| `GRADUATE_REWARD` | `10_000_000` lamports |
| `SNIPE_WINDOW_SECS` | `120` (feature `short-windows`: `5`, for local tests only) |
| `SNIPE_MAX_BPS` | `100` (of total supply, per wallet's position, during the early window) |
| `EARLY_TOTAL_BPS` | `1000` (of total supply, all buyers together, during the early window) |
| `REFUND_AFTER_SECS` | `604800` (7 days in Complete before refunds open; feature `short-windows`: `10`) |
| `LOCK_AFTER_SECS` | `604800` (7 days in PoolCreated before `graduate_burn` opens; feature `short-windows`: `10`) |
| `STATUS_REFUNDING` | `5` (after Finished in number, but never graduated) |
| `DECIMALS` | `9` |
| supply (whole tokens) | `1_000` ..= `10_000_000_000` (u64 base units must not overflow) |

## PDAs (curve program)

| Account | Seeds | Owner |
|---|---|---|
| `curve` | `["curve", mint]` | bonding_curve (state) |
| `auth` | `["auth", mint]` | **System program, never allocated.** Holds all XNT (raise + deposits), is the mint authority, the XDEX pool creator and the LP owner. Signs with `invoke_signed`. |
| `position` | `["pos", curve, owner]` | bonding_curve |
| `nft_mint` | `["nft", curve]` | Token-2022 (created in `graduate_lock`) |

## Accounts (Anchor, borsh, 8-byte discriminator first; field order is the layout)

```rust
pub struct Curve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub supply: u64,             // S, base units
    pub curve_tokens: u64,       // T = S * CURVE_BPS / 10000
    pub pool_tokens_gross: u64,  // S - T, minted to auth and deposited into XDEX
    pub pool_tokens_net: u64,    // what the XDEX vault receives after the transfer fee
    pub target_xnt: u64,         // lamports into the pool at graduation: target_whole * 1e9 (20e9 on older curves)
    pub virtual_xnt: u64,        // current x (starts at x0)
    pub virtual_tokens: u64,     // current y (starts at y0)
    pub tokens_sold: u64,
    pub raised_xnt: u64,         // net XNT in the curve (= virtual_xnt - x0)
    pub created_at: i64,
    pub status: u8,              // 0 Trading, 1 Complete, 2 PoolCreated, 3 Graduated, 4 Finished, 5 Refunding
    pub positions: u32,          // open (undelivered) positions
    pub delivered: u64,          // tokens delivered so far; Complete: completion time; PoolCreated: pool creation time
    pub pool: Pubkey,            // set in graduate_pool
    pub lock_nft: Pubkey,        // set in graduate_lock (stays default after graduate_burn)
    pub tax_bps: u16,            // the mint's transfer fee, read at creation
    pub bump: u8,
    pub auth_bump: u8,
}
pub struct Position {
    pub curve: Pubkey,
    pub owner: Pubkey,
    pub balance: u64,            // tokens owed, base units
    pub deposit: u64,            // lamports paid on the first buy for the token account
    pub bump: u8,
}
```

## Curve maths (u128, rounding always favours the curve)

Setup in `create_curve` (S = supply base units, R = target_whole * 10^9):

```
T  = S * CURVE_BPS / 10000
Pg = S - T
Pn = Pg - fee(Pg)             fee(a) = min(ceil(a * tax_bps / 10000), max_fee)  (Token-2022 epoch fee)
a  = Pn * T / (T - Pn)        (floor)
y0 = a + T
x0 = R * (a - Pn) / Pn        (floor)
k  = x0 * y0                  (u128, recomputed from current x, y each time as x*y is NOT stored)
```

Because `a` is floored, buying the whole curve raises up to about `R * T / a²` lamports
less than R (at most 3 at 20 XNT, 143 at 10,000 XNT with the minimum supply); `graduate_pool`
still wraps exactly R and the graduation deposit covers the difference. The last curve price
matches the pool's opening price R / Pn to better than 1e-9 for every target and supply.
All intermediate products fit u128 (x0 * y0 < 1e32 at 10,000 XNT and the maximum supply).

Invariant: the curve keeps `k0 = x0 * y0` fixed; the program recomputes it from `x0`,
which is derivable (`x0 = virtual_xnt - raised_xnt`), so k0 = (virtual_xnt - raised_xnt) * y0
where y0 = virtual_tokens + tokens_sold. Implementations may instead store nothing extra
and use these identities.

Buy(`xnt_in`, `min_tokens_out`):
```
fee   = ceil(xnt_in * FEE_BPS / 10000)
net   = xnt_in - fee
y1    = ceil(k0 / (x + net));  out = y - y1
if tokens_sold + out >= T:            // last buy: fill exactly to T
    out     = T - tokens_sold
    net     = ceil(k0 / (y - out)) - x
    xnt_in  = ceil(net * 10000 / (10000 - FEE_BPS)); fee = xnt_in - net
    status  = Complete
require out > 0, out >= min_tokens_out
if now < created_at + SNIPE_WINDOW_SECS:
    require position.balance + out <= S * SNIPE_MAX_BPS / 10000     // TooBigEarly
    require tokens_sold + out <= S * EARLY_TOTAL_BPS / 10000        // EarlyWindowFull
    require this is the transaction's only buy, a top-level ix      // OneBuyPerTransaction
if complete: delivered = now   // completion time, until graduate_pool replaces it
x += net; y -= out; tokens_sold += out; raised_xnt += net; position.balance += out
transfer: buyer -> auth: net (+ deposit on first buy); buyer -> FEE_RECEIVER: fee
```

Sell(`tokens_in`, `min_xnt_out`), only while status == Trading:
```
require position.balance >= tokens_in > 0
(implementation: also require gross > 0, else ZeroAmount)
x1  = ceil(k0 / (y + tokens_in)); gross = x - x1
fee = ceil(gross * FEE_BPS / 10000); out = gross - fee
require out >= min_xnt_out
x = x1; y += tokens_in; tokens_sold -= tokens_in; raised_xnt -= gross; position.balance -= tokens_in
transfer (auth signs): auth -> seller: out; auth -> FEE_RECEIVER: fee
```

Deposit on first buy (position created): the rent for a Token-2022 associated token
account of this mint = `Rent::minimum_balance(len)` where len = account length with
extensions `[ImmutableOwner, TransferFeeAmount]` (165 + 1 + TLVs; compute with
`ExtensionType::try_calculate_account_len::<Account>`).

## Instructions (Anchor discriminator = sha256("global:<name>")[..8], args borsh)

Account lists in this exact order (w = writable, s = signer).

1. `create_curve(supply_whole: u64, target_whole: u64)`
   creator(w,s), mint(w), curve(w, init), auth(w), system_program.
   `target_whole` must be in `TARGETS_XNT_WHOLE` (`BadTarget` otherwise); the curve is set
   up for R = target_whole × 10^9 lamports and stores it in `target_xnt`. (The first testnet
   program took `supply_whole` only and used a fixed 20 XNT.)
   The site's `POST /api/curve/create` takes `targetXnt` (whole XNT, default 500) and refuses
   other values before building the transaction; `/api/info` lists the choices under `curve`.
   Checks the mint as described above (Token-2022 owner, decimals 9, supply 0, mint
   authority == auth, no freeze, extensions ⊆ {TransferFeeConfig, MetadataPointer,
   TokenMetadata}, fee config authority None, 100 ≤ bps ≤ 1000). Transfers
   GRADUATION_DEPOSIT creator → auth. Sets up the curve. Emits `CurveCreated`.
   *Added in implementation:* the TokenMetadata extension must be present and its
   update authority must equal `creator` (`BadMint` otherwise); this stops anyone else
   from opening a curve on a creator's fresh mint and taking the creator role. The older
   and newer transfer fees must also be identical (always true for a fresh mint).
   Because Token-2022 metadata `initialize` needs the mint authority's signature, the
   client initializes the mint with the creator as mint authority, initializes the
   metadata, then `SetAuthority(MintTokens → auth)`, ideally in the same transaction as
   `create_curve` (verified: fits, ~850 bytes without the launch-fee instructions).

2. `buy(xnt_in: u64, min_tokens_out: u64)`
   buyer(w,s), curve(w), auth(w), position(w, init_if_needed, payer buyer),
   fee_receiver(w, == FEE_RECEIVER), system_program.
   Requires status == Trading and buyer != creator. Emits `Trade`.

3. `sell(tokens_in: u64, min_xnt_out: u64)`
   seller(w,s), curve(w), auth(w), position(w, owner == seller),
   fee_receiver(w), system_program. Emits `Trade`.

4. `graduate_pool()` — status Complete → PoolCreated
   caller(w,s), curve(w), auth(w), mint(w), auth_token(w) [ATA(auth, mint, Token-2022)],
   auth_wxnt(w) [ATA(auth, NATIVE_MINT, SPL Token)], auth_lp(w) [ATA(auth, lp_mint, SPL Token)],
   xdex_program, amm_config, xdex_authority, pool(w), lp_mint(w), vault0(w), vault1(w),
   create_pool_fee(w), observation(w), native_mint, token_program, token_2022_program,
   associated_token_program, system_program, rent, locker_program [== LOCKER_PROGRAM_ID].
   Refuses (`LockerUnavailable`) unless locker_program is executable. Sets `delivered` to
   the pool's creation time (for graduate_burn); graduate_lock / graduate_burn reset it to 0.
   Clients send it with graduate_lock in one transaction (measured: 1,178 bytes with two
   compute-budget instructions, under the 1,232 limit, and 400k CU together, measured on a
   local validator by scripts/local-curve-graduate-test.ts; test/curve.test.ts checks the size).
   (locker_program was appended in the BC-M1 fix; older clients without it fail with
   Anchor's not-enough-accounts error.)
   Mints `Pg` to auth_token, wraps the curve's `target_xnt` into auth_wxnt, then CPIs XDEX `initialize`
   with creator = auth (same account order as `buildCreatePool` in `src/xdex.ts`,
   open_time 0). Checks xdex_program/amm_config/create_pool_fee against the constants and
   `pool == PDA(["pool", amm_config, mint0, mint1], XDEX)` with mints sorted like
   `poolAddresses()`. Records `pool`.
   *Implementation:* auth_wxnt and auth_token are empty after the CPI and are closed back
   to auth. At the end auth must still hold `positions × token-account deposit + rent
   minimum of a 0-byte account`, else `InsufficientReserve` (anyone can top auth up and
   retry). Needs a compute-budget instruction (220k–255k CU measured locally, varies with PDA bumps).

5. `graduate_lock()` — status PoolCreated → Graduated
   caller(w,s), curve(w), auth(w), creator(w) [== curve.creator], nft_mint(w) [PDA],
   auth_nft(w) [ATA(auth, nft_mint, Token-2022)], creator_nft(w) [ATA(creator, nft_mint, Token-2022)],
   pool, token_0_vault, token_1_vault, lp_mint, auth_lp(w),
   lock(w) [PDA(["lock", nft_mint], LOCKER)], lock_vault(w) [PDA(["vault", lock], LOCKER)],
   locker_program, token_program, token_2022_program, associated_token_program, system_program.
   Creates the NFT mint (decimals 0, mint authority auth, no freeze, MetadataPointer +
   TokenMetadata: name "99 + Tax LP Lock", symbol "LPLOCK", uri "", update authority =
   creator), creates auth_nft, CPIs `lp_locker::lock(amount = all of auth_lp)` with
   owner = auth, creates creator_nft and transfers the NFT to it, pays GRADUATE_REWARD to
   caller. Records `lock_nft`. Emits `Graduated`.
   *Implementation:* the metadata pointer's authority is the creator and it points at the
   NFT mint itself; auth_nft and auth_lp are closed back to auth after the lock; same
   reserve check as graduate_pool (150k–160k CU measured locally). Anchor account constraints
   run before the status check, so calling this before graduate_pool fails with
   `WrongAccount` (pool != curve.pool) rather than `WrongStatus`.

5a. `graduate_burn()` — status PoolCreated → Graduated, once `now ≥ pool creation time
   (delivered; created_at on curves whose pool predates it) + LOCK_AFTER_SECS`
   (`BurnNotOpen` before).
   caller(w,s), curve(w), auth(w), lp_mint(w) [== PDA(["pool_lp_mint", curve.pool], XDEX)],
   auth_lp(w) [ATA(auth, lp_mint, SPL Token)], token_program, system_program.
   Burns all of auth_lp (auth signs), closes auth_lp to auth, pays GRADUATE_REWARD to the
   caller, `lock_nft` stays default, `delivered` = 0, same reserve check. Emits `LpBurned`.

6. `deliver()` — status Graduated (→ Finished when the last position is delivered)
   payer(w,s), curve(w), auth(w), position(w, closed to owner), owner(w) [== position.owner],
   owner_token(w) [ATA(owner, mint, Token-2022)], mint(w), creator(w) [== curve.creator],
   token_2022_program, associated_token_program, system_program.
   If balance > 0: create owner_token idempotently (payer auth), mint `balance` to it
   (auth signs). Refunds `deposit` minus what the account creation actually cost
   (0 if it already existed) to owner, closes the position to owner. When `positions`
   reaches 0: sets the mint authority to None, status Finished, and sends all remaining
   auth lamports to the creator. (The curve account is kept: it is the on-chain record of
   the graduation, pool and lock NFT that the site and the creator's tax-vault step read.)

7. `refund()` — status Complete for REFUND_AFTER_SECS (→ Refunding) or Refunding
   payer(w,s), curve(w), auth(w), position(w, closed to owner), owner(w), creator(w),
   system_program. Pays the position's pro-rata share of `raised_xnt` plus its deposit.
   After the last one, the rest of auth goes to the creator and the curve is closed to the
   creator.

8. `close_curve()` — status Trading with `tokens_sold == 0` (`CurveNotEmpty` otherwise)
   creator(w,s) [== curve.creator], curve(w), auth(w), system_program.
   positions == 0: all of auth to the creator and the curve closed to the creator.
   positions > 0 (all emptied by selling): status Refunding; `refund` returns each deposit
   and the last one closes the curve. Emits `CurveClosed`.

## Tax authority and the creator's start step

The program doesn't constrain the mint's withdraw-withheld authority (`check_curve_mint`
checks everything else), so the site picks it when it builds the creator's create-curve
transaction:

- **Tax Vault site** (testnet, `factory.taxVault` with a publisher key): the withdraw
  authority is the `tax_vault` program's `auth` PDA for the mint (`["auth", mint]`). No
  distributor key is generated and no distributor gas is charged; the launch record is
  flagged `taxVault: true` (its `distributor` field is that PDA).
- **Otherwise** (and on mainnet, where the curve is off): a new distributor wallet, as
  before.

`init_vault` needs the XDEX pool and the lp_locker lock NFT (`check_lock` only checks the
lock's NFT and pool, not who locked it, so the curve's lock qualifies), and its payer must
be the mint's metadata update authority: the creator. Both only exist after graduation,
and the creator isn't there to sign then, so:

1. At graduation the site's curve crank records the pool and lock NFT and registers the
   token as a vault token (per-launch config with `taxVault: true`); the hot-wallet
   distributor never serves it.
2. The creator starts the vault with the same "Start the tax vault" transaction as a
   normal vault launch (`/api/launch/vault`: `init_vault` with the recorded split,
   publisher = the site's publisher key, guardian = the creator), from the curve page, the
   lock NFT's page or "Your launches". Everyone else sees "Waiting for the creator to
   start the tax vault".
3. Until then the tax stays withheld in the token accounts (and the mint): only the
   vault's `auth` PDA can ever withdraw it, and it can't sign before the vault exists.
   Once the vault exists, the vault crank, "Run the vault now", lists and payouts work as
   for any vault token; `collect` harvests what was withheld meanwhile.

## Events (Anchor `emit!`, parsed by the site from logs)

```rust
CurveCreated { curve, mint, creator, supply, x0, y0, created_at }
Trade { curve, trader, is_buy: bool, xnt: u64 /* gross paid or received before fee */,
        fee: u64, tokens: u64, virtual_xnt: u64, virtual_tokens: u64,
        tokens_sold: u64, raised_xnt: u64, ts: i64 }
Graduated { curve, mint, pool, lock_nft, raised_xnt }
Delivered { curve, owner, tokens }
Refunded { curve, owner, tokens, xnt }
LpBurned { curve, mint, pool, lp_amount, raised_xnt }
CurveClosed { curve, mint, creator, positions: u32 }
```

## Errors

`BadMint, BadSupply, BadTax, NotTrading, CreatorCannotBuy, ZeroAmount, Slippage,
TooBigEarly, InsufficientBalance, WrongStatus, WrongAccount, MathOverflow,
InsufficientReserve, BadTarget, EarlyWindowFull, OneBuyPerTransaction,
BadWithdrawAuthority, XdexClosed, RefundNotOpen, LockerUnavailable, BurnNotOpen,
CurveNotEmpty` (codes 6000.. in this order; `InsufficientReserve` = 6012
was added by the implementation, see graduate_pool; `BadTarget` = 6013 came with
selectable targets, see create_curve).
