# 99 + Tax: tax tokens on X1 that pay holders in XNT

**99 + Tax** is a launchpad for tax tokens on the X1 blockchain. Every trade of a 99 + Tax
token pays a small tax (1–10%), and the **Tax Vault program** (testnet; a per-token
distributor on mainnet until the vault is audited) turns that tax into:

- **XNT paid straight to holders' wallets**, in proportion to their balance (at least 35%
  of the tax),
- **permanent liquidity**: tokens + XNT added to the pool, with the LP tokens burned,
- **burned tokens**, so the supply only goes down,
- a **10% creator reward**, paid in USDC.X on mainnet (XNM on testnet) and vesting over
  7 days.

Anyone can launch one in a few wallet approvals. The whole supply goes into the pool
(no dev bag), the launch liquidity is locked forever in an NFT, and the tax can never be
changed.

On testnet **every token's tax is held by the Tax Vault** program (v3): no server key can
move it, and holders keep getting paid if the site disappears (see
[Tax Vault](#tax-vault-testnet) and [If 99 + Tax goes offline](#if-99--tax-goes-offline)).
**Mainnet launches are paused** until the vault is audited and deployed there, so that the
site never holds a key to anyone's tax.

**Reviewing the code?** Start with [docs/REVIEW.md](docs/REVIEW.md): scope, deployed
program hashes and how to reproduce them, tests, trust assumptions and what to look at.

| | |
|---|---|
| **Mainnet** | https://99tax.vercel.app |
| **Testnet** | https://99tax-testnet.vercel.app (faucet, bonding curve) |

> Estimates only; nothing on the site is financial advice. The programs have **not** had
> an independent audit yet, and the LP locker is still upgradeable until it has; the site
> says so wherever "forever" appears, and the notice disappears once it's immutable.

## How it fits together

Pools are **real XDEX pools**, created by XDEX's own program; this project adds a locker,
a bonding curve (testnet) and an off-chain distributor around them.

| Piece | What it does |
|---|---|
| **Token-2022 mint** (TransferFee + Metadata extensions) | The token. Token-2022 withholds the tax on every transfer; no fee-config authority, so the rate can never change; mint authority revoked. |
| **XDEX pool** (TOKEN/XNT, or TOKEN/JACK) | Where the token trades and where the tax is sold. |
| **`lp_locker`** (Anchor, `lp-locker/programs/lp_locker`) | Locks the pool's LP behind a 1-of-1 NFT (forever or timed). The NFT holder collects the LP's trading fees and claims the creator reward from a 7-day vesting vault. Also Holder Passes (built, not deployed). |
| **`bonding_curve`** (Anchor, `lp-locker/programs/bonding_curve`, testnet) | Curve launches with no starting liquidity; at graduation it creates the XDEX pool and locks the LP through `lp_locker`. See [docs/bonding-curve-spec.md](docs/bonding-curve-spec.md). |
| **`tax_vault`** (Anchor, `lp-locker/programs/tax_vault`, testnet) | Program custody of each token's tax: collect, burn, sell, add liquidity, creator reward and holder payouts against a published Merkle list, all enforced on-chain and cranked by anyone. See [docs/tax-vault-spec.md](docs/tax-vault-spec.md). |
| **Distributor** (`src/distribute.ts`, one wallet per token) | The pre-vault path (mainnet's "Test", JACK tokens, and curve tokens on a site without the vault): each cycle collects the tax, burns, sells for XNT, adds liquidity (LP burned), funds the creator reward and pays holders. Crash-safe journal. |
| **Site** (`src/factory-server.ts`) | Landing page, launch app and all the public pages below; builds transactions for the visitor's wallet to sign (it never holds their keys). |

**Program ids**

| Program | Mainnet | Testnet |
|---|---|---|
| `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` |
| `bonding_curve` | – | `CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY` |
| `tax_vault` | – | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` |
| XDEX | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` | `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` |

The home page's **Contracts** section lists every address the live site uses.

**Site pages:** `/` (how it works, on-chain checks, contracts, costs, FAQ) · `/launch`
(launch app, your launches, Distribute now) · `/tokens` · `/nft` and `/nft/<mint>` (lock
NFTs, withdraw, full token stats incl. burns) · `/leaderboard/<mint>` (holders' average
cost, rewards earned, total return) · `/wallet/<address>` (My earnings) · `/analytics` ·
`/curve` (testnet) · `/faucet` (testnet). A Mainnet/Testnet toggle and a theme picker
(Notebook by default) sit in every header.

## The original single token (RFLT)

The project started as one reflection token, **RFLT** (testnet), run from `config.json`
with its own distributor. The sections below cover that single-token setup, then the
launchpad that grew out of it. X1 runs on the Solana VM, so SafeMoon-style "balances grow
by themselves" contracts don't carry over: balances live in separate token accounts, and
a custom ledger would not work with wallets or XDEX. So payouts are real XNT transfers.

> **RFLT is on the Tax Vault now** (testnet): `scripts/adopt-main-token.ts` gave it a
> launch record like any launchpad token, its fee and mint authorities were revoked
> (`npm run admin -- lock-fee`, `revoke-mint`), and `scripts/migrate-to-vault.ts` handed its
> tax to the vault. The single-token setup below still describes how it started and how the
> distributor path works.

## Setup

```bash
npm install
cp config.example.json config.json
solana-keygen new -o distributor.keypair.json      # dedicated bot wallet (gitignored)
```

Edit `config.json`:

- `keypairs.creator`: your deployer wallet. It becomes the mint, fee-config and metadata
  authority, and receives the whole supply.
- `keypairs.distributor`: the bot wallet. Use a **dedicated** wallet. Any XNT it holds
  above `operatingReserveXnt` is treated as reflections and paid out.
- `token.*`: name, symbol, `uri` (a metadata JSON with an image, e.g. on IPFS), supply,
  decimals, `feeBps` (500 = 5%).
- `network` / `rpcUrl` / `xdex.programId`: the example is set up for testnet. For mainnet
  use `https://rpc.mainnet.x1.xyz` and `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`.
  The config refuses a program ID that doesn't match the network.

**Gas auto top-up:** the distributor pays its own transaction fees from its own XNT.
Each cycle, sale proceeds first refill it up to `operatingReserveXnt` (0.05 XNT), and only
the rest goes to holders. It needs **one** initial funding of about 0.05 XNT to pay for the
first harvest and sale. After that it maintains itself. If its free XNT drops below
`minGasXnt`, it pauses fee-costing work and payouts rather than failing partway, and tells
you how much to send.

## Launch runbook

1. **Create the token:** `npm run create-token`. This writes `mint` into `config.json`
   and backs up the mint keypair under `state/`. With `launchGrace: true`, the fee
   starts at **0%** and switches to `feeBps` two epochs later (X1 epochs are about
   22 hours). That gives you a window to add liquidity without losing 5% of it.
2. **Create the XDEX pool:** create a TOKEN/XNT pool in the XDEX UI and add liquidity.
   Put the pool address in `xdex.pool`.
3. **Check:** `npm run admin -- status`
4. **Lock it down:** `npm run admin -- revoke-mint` makes the supply permanently fixed.
   Optionally, `npm run admin -- lock-fee` makes the fee permanently unchangeable.
   Holders will look for both.
5. **Run the distributor:**
   To keep it running in the background (logs to `state/distributor.log`):
   ```bash
   npm run distributor:start -- 15               # a cycle every 15 minutes
   npm run distributor:status                    # running? last log lines
   npm run distributor:logs                      # follow the log
   npm run distributor:stop
   ```
   It stops if WSL or the machine shuts down; start it again afterwards.

   Or run it by hand:
   ```bash
   npm run distribute                            # dry run: prints what it would do
   npm run distribute -- --execute               # one real cycle
   npm run distribute -- --execute --loop 60     # every hour (or run the one-shot from cron/systemd)
   ```

Change the fee later with `npm run admin -- set-fee <bps>`. Token-2022 always delays
fee changes by two epochs, so holders can't be surprised by a sudden fee increase.

## One distribution cycle

1. **Recover:** a withdraw, sale or auto-LP deposit from an interrupted run is checked
   by signature, and its effect is applied from the confirmed transaction. Any payout
   batch from an interrupted run is also checked by signature. It is
   either marked paid, re-sent (only once its blockhash has expired, so the old
   transaction can never land), or left alone until it resolves.
2. **Harvest** the withheld fees from every token account into the mint. Anyone can do
   this. Then **withdraw** them to the distributor's token account. `burnBps` of them
   are set aside to burn, and `autoLpBps` for auto-LP: half kept as tokens, half to be
   sold for the XNT side.
   **Burn:** the tokens set aside to burn are burned right away (Token-2022 burn), so
   the supply shrinks. They are never sold, so there's no swap fee and no sell
   pressure for that share. `burnBps` is 0 (off) unless you set it; `autoLpBps +
   burnBps` can't exceed 10000.
   **Creator reward:** `creatorBps` of the collected tax (RFLT and every factory token:
   10%) is sold with the holders' share. That XNT is deposited into an `lp_locker`
   reward vault tied to a lock NFT (`creatorReward.nftMint`), as wrapped XNT, or swapped
   to USDC first when `creatorReward.rewardMint` and `swapPool` are set (mainnet: the
   XNT/USDC.X pool). Each deposit vests for 7 days; then whoever holds the NFT claims it
   (dashboard **Claim rewards**, or the factory page's **Claim**). Selling the NFT sells
   the reward stream. Quiet cycles skip collecting tax worth less than `minHarvestXnt`
   (default 0.05 XNT): X1 charges roughly 0.01–0.015 XNT in network fees for one full
   cycle, so collecting less would mostly feed fees. Sales under `minSellXnt` (0.002 XNT)
   also wait.
3. **Sell** the collected tokens for XNT through XDEX `swap_base_input`. The sale size is
   capped by `maxPriceImpactBps` and optionally by `maxSellTokensPerCycle`. The quote
   accounts for the 5% transfer fee on the way into the pool and the pool's trade fee.
   The minimum output is protected by `slippageBps`. Every transaction is simulated
   before it is sent.
4. **Auto-LP:** the set-aside tokens and XNT are deposited into the XDEX pool in one
   transaction, and the LP tokens received are **burned** in the same transaction, so that
   liquidity can never be withdrawn by anyone. The LP amount is sized with `slippageBps`
   of headroom. Before each sale, the auto-LP tokens are rebalanced: just enough is kept
   that, after the sale, the kept tokens and the XNT are worth the same at the pool
   price (transfer and trade fees included). Anything left over from a previous cycle is
   paired this way instead of waiting. The deposit is skipped until at least `minCycleXnt`
   is set aside. If it fails, holder payouts in that cycle still go ahead.
5. **Refill gas, then allocate:** XNT that isn't owed to holders or set aside for auto-LP first tops the gas reserve
   back up to `operatingReserveXnt`. Anything above that is split pro-rata over eligible
   holders, rounded down.
6. **Pay:** everyone whose accumulated share is at least `minPayoutXnt` receives native
   XNT, in batches of `transfersPerTx`. Smaller shares carry over until they reach the
   threshold.

**Who is eligible:** wallets holding at least `minHoldingTokens` (balances summed
across all their token accounts). **Excluded:** the distributor, the XDEX pool vaults,
burn addresses, frozen accounts, anything in `excludeOwners` (e.g. your treasury or a
CEX wallet), and off-curve owners (program-controlled PDAs, where XNT could get stuck)
when `excludeOffCurveOwners` is true.

The payout journal is `state/distributor-state.json`. Every signature is written to disk
**before** its transaction is broadcast, so a crash or restart never pays anyone twice.
**Keep the `state/` directory and back it up.** A lock file stops overlapping runs.

## Locking LP in an NFT (lp_locker)

`lp-locker/` is a small Anchor program that locks XDEX LP tokens behind a 1-of-1 NFT,
either **forever** or **until a date** (for example 7 days). Whoever holds the NFT can
collect the trading fees that liquidity earns, and can sell or transfer that right with
the NFT.

- **Forever** (`lock`): nobody can ever withdraw the liquidity.
- **Timed** (`lock_timed`): nobody can withdraw it before the unlock time. After that,
  the NFT holder can `unlock`: all the LP goes back to them. The NFT is kept, because
  it's also the key for claiming creator rewards.
- **Creator rewards** (`init_reward_vault`, `deposit_reward`, `claim_reward`): a vesting
  vault per lock NFT and reward token. Deposits vest 7 days; only the NFT holder can
  claim. Tested on local copies of testnet (XNT) and mainnet (swap on the real
  XNT/USDC.X pool, then USDC.X deposit and claim). The
  unlock time lives in a separate schedule account that only `lock_timed` can create,
  in the same instruction as its lock, so a forever lock can never become unlockable.

- `lock` moves LP tokens into a vault owned by the program and mints a Token-2022 NFT
  (supply 1, mint and freeze authority removed) to the locker.
- `collect_fees` only pays out growth. In a constant-product pool, sqrt(reserve0 ×
  reserve1) per LP token only rises, and only from trading fees. The program records the
  locked liquidity at lock time (rounded up), then withdraws just the LP tokens worth
  more than that, and checks afterwards that the principal is still fully covered.

**From the dashboard:** click **Connect wallet** (any Wallet Standard wallet, such as X1
Wallet or Backpack, or an older injected wallet), enter an amount and click **Lock
forever** (or pick 7 days, 30 days, 90 days or 1 year). Locks your wallet's NFT holds get
a **Collect** button, and timed locks get an **Unlock** button once they end. The server builds each
transaction for your wallet's address and your wallet shows it for approval and signs
it; the server never holds your key.

**From the command line:**

```bash
npm run lp-lock -- status                  # every lock on the pool, fees ready to collect
npm run lp-lock -- lock <amount|all>       # simulate locking the creator's LP
npm run lp-lock -- lock <amount|all> --yes # send it (irreversible)
npm run lp-lock -- lock <amount> --days 7 --yes   # timed lock
npm run lp-lock -- unlock --nft <mint> --yes      # after it ends: LP back, NFT burned
npm run lp-lock -- collect --yes           # collect fees as the NFT holder
```

**Build:** `cargo-build-sbf --manifest-path lp-locker/programs/lp_locker/Cargo.toml
--sbf-out-dir lp-locker/target/deploy` (add `--features testnet` for X1 testnet's XDEX).
Deploy with `solana program deploy`, then set `locker.programId` in `config.json`.
**For holders to trust it, make it immutable after testing:**
`solana program set-upgrade-authority <program id> --final`. Until then, whoever holds
the upgrade key could change the program. The program has not had a third-party audit.

### Lock receipt NFT (on-chain image)

After a lock confirms, one more approval "prints" a receipt into the NFT: a small SVG
(token, tax split, LP locked, pool share, lock term, and the exact on-chain lock time)
plus its JSON, stored as a `data:` URI in the NFT's Token-2022 metadata. Nothing is
hosted. A transaction can only write about 1,000 bytes of metadata, so the art is kept
compact. Only the wallet that locked (the NFT's update authority) can print it.

- Dashboard: prompted right after Lock; otherwise a "Print receipt" button on the lock row.
- Launch app: printed after step 3; otherwise "Print receipt" in "Your launches".
- CLI: `npm run lp-lock -- receipt --nft <mint> --yes`.
- View any lock NFT at `/nft/<mint>` on the launch site. Unprinted NFTs show a preview.
  The holder can withdraw there: "Collect fees" (the liquidity's trading fees) and
  "Claim rewards" (creator rewards, once vested). Locked LP itself only comes back when
  a timed lock ends; forever locks never release it.
- `/tokens` lists every token (RFLT and all launches) with live price and pool liquidity,
  its tax split, and what it has paid to holders, liquidity and its creator.
- `/analytics` shows platform totals, XNT from the tax over time (holders, liquidity,
  creators), a per-token table and recent activity, from each token's `events.jsonl`.
- Each NFT page also shows its token's stats: tokens burned (and % of supply), XNT added
  to liquidity, paid to holders and to the creator, and every holder with balance,
  share, XNT received and status (earning, below minimum, excluded, sold).
- Holder yield (NFT token stats and `/tokens`): XNT paid to holders over the last 7 days,
  split across the tokens that earn now, as XNT per 1,000 tokens per day and a simple
  yearly % at today's price. A trailing estimate, not a promise.
- `/wallet/<address>` ("My earnings"): a wallet's holdings across every token, XNT
  received (payouts and "Distribute now" rewards), estimated XNT/day at the current
  yield, and its LP-lock NFTs with fees and creator rewards ready to claim.
- Themes: every page has a **Theme** menu in its header. Visitors pick Receipt (cream
  paper, monospace, red price tags), Arcade (dark cabinet, pixel font, CRT scanlines;
  always dark), Lunch bag (kraft paper bag, marker pen, taped notes) or Notebook (ruled
  paper, handwriting, tokens and NFTs as sticky notes), and a mode:
  Auto (follows the device), Light or Dark. The choice is saved in their browser and
  applied before the page paints. `factory.theme` in config.json sets the default for
  new visitors. Links can carry `?theme=arcade&mode=dark` (`?theme=default` clears it).
  Files: `src/web/theme-<name>.css` (fonts, colours and a dark-mode token set) on top of
  `src/web/theme-base.css` (shared layout rules); `src/web/theme.js` is the menu.
- `/nft` lists every lock NFT (RFLT and all launches) with what it has earned: fees
  collected, fees ready and creator rewards, valued in XNT at current pool prices.
  "Mine" filters to the connected wallet.

## Token factory (launchpad): "99 + Tax"

The launchpad is branded **99 + Tax**: `/` is the landing page (live totals, how it works,
on-chain checks, costs, launched tokens, FAQ) and `/launch` is the launch app.

A public launch page where anyone connects a wallet and launches a tax token that works
like RFLT: every transfer pays a tax, the tax is sold for XNT and paid to holders, and a
share of it is added to the pool's liquidity (LP burned). The launch liquidity is locked
in an `lp_locker` NFT, forever or until a date.

```bash
npm run factory:start -- 15     # launch page + distributor for every launched token
npm run factory:status
npm run factory:logs
npm run factory:stop
```

The site runs at `http://127.0.0.1:8124` (launch app at `/launch`). The creator picks the name, symbol, logo,
supply, tax (1–10%), the share of the tax that goes to liquidity (0–50%), the share that
is burned (0–50%; liquidity + burn at most 55%, because 10% is the creator's reward and
holders keep at least 35%), the starting
liquidity, and the lock (forever, 7, 30, 90 days or 1 year; mainnet offers **forever
only**, via `factory.lockForeverOnly`). Before step 1 charges anything, the site checks
the wallet can afford the whole launch. Their wallet approves three transactions (four with the Tax Vault):

1. **Token:** Token-2022 mint with the tax and **no fee authority** (the tax can never
   change), the supply minted to the creator only to be put into the pool in step 2
   (100% of it; the creator keeps none), **mint authority revoked**, the launch fee
   (`factory.feeUsdc` USDC to `factory.feeReceiver`; on testnet `factory.feeToken` can swap in another token such as XNM, and mainnet ignores it and always charges USDC.X) and the token distributor's gas.
2. **Pool:** a TOKEN/XNT pool on XDEX with the creator's tokens and XNT (or, if the
   creator picks another pair the site offers, e.g. JACK, a TOKEN/JACK pool with their
   JACK; XDEX's pool fee is still XNT).
3. **Lock:** all of the creator's LP locked in an NFT, which collects the trading fees.
4. **Start the tax vault** (when `factory.taxVault` is set, i.e. testnet): `init_vault`
   hands the token's withdraw authority to the vault program, so no distributor key is
   ever created for it.

**Pairs other than XNT.** List them in `factory.quoteTokens` and the launch form shows
"Pair with: XNT / JACK" (XNT stays the default; without the list the choice is hidden):

```json
"quoteTokens": [{ "mint": "54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg", "symbol": "JACK", "xntPool": "wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW" }]
```

`xntPool` is that token's deep XNT pool on XDEX. Holders are still paid in XNT: the
distributor sells the tax for JACK, keeps the auto-LP share as JACK for the TOKEN+JACK
deposit, and swaps the rest to XNT on the JACK/XNT pool (price-impact capped) for gas,
payouts and the creator reward. The site shows those tokens' prices in JACK with the XNT
value, and their leaderboard costs in JACK. Only tokens without a transfer fee work as a
pair. `scripts/mainnet-rehearsal-jack.ts` rehearses a JACK launch on a local validator.

Then the launch is verified on-chain and registered. `factory:distribute` runs the same
cycle as RFLT for every registered token, each with its **own distributor wallet**
(the only key that can withdraw that token's tax), settings and state, under
`factory/launches/<mint>/`. **That folder holds those wallets' keys: back it up and never
commit it** (it is gitignored).

- Launch fee: USDC.X on mainnet (`B69ch…m9Tq`); on testnet, the USDC that has an XDEX
  testnet pool (`4dr9…2KsU`). Launchers need it in their wallet.
- The tax starts with the first transfer, so seeding the pool pays it once. That
  tax is collected and goes back to holders and liquidity like any other.
- Token metadata (`/meta/<mint>.json`) is served by the factory. To make the page public,
  put it behind an HTTPS reverse proxy, set `factory.publicUrl` and list the host name in
  `factory.hosts`. It only listens on 127.0.0.1 by default.

## Token logos and metadata on IPFS

With a Pinata API key with Files: Write (`factory.pinataJwt` in config.json, or `PINATA_JWT`), the launch
form gets an **Upload image** button: the logo goes straight through to IPFS (PNG, JPG,
WebP or GIF, checked by its bytes, ≤ 500 KB, 20 uploads per IP per hour) and nothing is
kept on the server. The token's metadata JSON (name, symbol, description, image) is
pinned too, so the on-chain link points to IPFS (`factory.ipfsGateway`, default
`https://gateway.pinata.cloud/ipfs/`) and keeps working even if the site goes away. Without a key,
creators paste a logo link and the site serves the metadata as before. Tax Vault rewards
lists are pinned the same way (v3). For rehearsals the upload API and the gateway can be
pointed at a local stand-in (`factory.pinataApiUrl` / `PINATA_API_URL`, `IPFS_GATEWAY`).

## Holder passes (pull-based holder rewards)

Paying every holder a transfer each cycle costs gas per holder, and X1 fees are
~0.001–0.004 XNT per transaction. With `distribution.holderRewards: "claims"` a token
pays holders through **Holder Passes** instead:

- A holder mints a 1-of-1 **Holder Pass** NFT for the token (My earnings → Mint pass;
  one-time ~0.01 XNT of rent + fee). Only wallets holding a pass earn; a wallet counts
  once however many passes it holds.
- Each cycle the distributor adds every pass's share to its running total and posts
  **one** Merkle root of all totals, funding the on-chain pool in the same transaction
  (`set_root`). Gas per cycle stays flat whatever the number of holders.
- Whoever holds a pass clicks **Claim** (`claim_pass`) and receives its total minus
  what it already claimed. Rewards follow the pass: selling it sells the unclaimed part.
  Unclaimed rewards never expire.
- On-chain (lp_locker): `init_holder_pool` (only the token's tax-withdraw authority, i.e.
  its distributor), `set_root` (epoch must increase, totals can only grow), `mint_pass`,
  `claim_pass`. The pool can never pay out more than it was funded with.
- The root is journaled in state before sending; the next cycle settles or re-sends it
  from what the chain shows, so a crash can't double-fund or lose rewards.
- Tests: `npm test` (tree + a fixed hash vector shared with the Rust tests),
  `cargo test` in `lp-locker/programs/lp_locker`, and two local-validator end-to-end
  scripts: `scripts/local-holder-pass-test.ts` (program, incl. rejected cheats) and
  `scripts/local-claims-cycle-test.ts` (distributor publish, crash recovery, expiry).

## Distribute now (anyone can trigger a payout)

The site's **Keep payouts moving** section lists RFLT and every launched token with the
tax waiting to be collected. Anyone can press **Distribute now** and approve one
transaction: a small tip (`factory.tipXnt`, default 0.005 XNT) to that token's
distributor wallet. The server checks the tip on-chain (confirmed, recent, sent to the
right wallet, never used before), then runs that token's normal cycle immediately. The
tip becomes the distributor's gas; nobody can change who gets paid. Guardrails: 10
minutes between triggered runs per token, never overlapping a running cycle (the lock
is held only during each cycle), and not while the waiting tax is dust.

## Bonding curve (testnet)

The **Curve** tab launches a token with no starting liquidity. Buyers fill a price curve
with XNT; when the curve's target is raised (**500, 1,000, 3,000, 5,000 or 10,000 XNT**, plus **10 or 20 XNT on testnet** for trying a full graduation with faucet XNT; the
creator's pick, 500 by default; curves made before targets were selectable keep 20 XNT) the
curve **graduates**: it creates the XDEX pool with that XNT and the last 20% of the supply, locks all the LP forever through `lp_locker`
(the NFT goes to the creator), and delivers every buyer's tokens to their wallet.

- **Tokens are created at graduation.** During the curve, balances live in the curve, so
  no tax applies; the tax is live from the first XDEX trade after graduation.
- 80% of the supply sells on the curve, priced so its last price equals the pool's
  opening price. 1% fee on curve trades. The creator can't buy their own curve. For the
  first 2 minutes one buy can take at most 1% of the supply.
- Graduation and delivery are permissionless; the site's crank (`factory.curve.crankKeypair`)
  does them automatically and earns the 0.01 XNT graduation reward.
- **Tax custody:** on a site running the Tax Vault (testnet), a curve token's tax belongs
  to the vault from the start (withdraw authority = the vault's `auth` PDA; no distributor
  wallet, no distributor gas). At graduation the crank registers it as a vault token; the
  creator then signs one transaction, **Start the tax vault** (on the curve page, the lock
  NFT's page or "Your launches"), and the vault crank takes over. Until then the tax waits
  in the token accounts, where nobody can move it. Without `factory.taxVault` a curve
  token gets a distributor wallet as before.
- Spec: [docs/bonding-curve-spec.md](docs/bonding-curve-spec.md). Tests:
  `scripts/local-curve-test.ts` (program end to end), `scripts/curve-rehearsal.ts`
  (site + program + crank + distributor) and `scripts/curve-vault-rehearsal.ts` (site +
  curve + Tax Vault v3), `scripts/local-curve-targets-test.ts` (the selectable-target upgrade
  over a live 20 XNT curve, with the site). Enabled by `factory.curve.programId`; off on
  mainnet until audited.

## Tax Vault (testnet)

The distributor model needs one hot wallet per token that can withdraw that token's tax.
The **Tax Vault** removes that key: the token's withdraw-withheld authority is a PDA of
the `tax_vault` program, and every step of the cycle is a program instruction with its
rules checked on-chain. Anyone can crank it; the site's crank does it automatically.

- **Authorities at launch:** fee config, mint and freeze authorities all revoked; the
  withdraw authority is the vault's `auth` PDA (`["auth", mint]`).
- **Starting the vault:** the creator signs `init_vault` (publisher = the site's key,
  guardian = the creator): step 4 of a normal launch, or after graduation for a bonding
  curve token (see [Bonding curve](#bonding-curve-testnet)).
- **Collect → burn → sell → add liquidity:** each sale's price impact is capped and at
  most one sale runs per slot; the LP from auto-liquidity is burned.
- **Holder payouts:** the site publishes a Merkle list of each wallet's cumulative XNT
  (public at `/api/vault/<mint>/list`). A list becomes payable after a **10-minute delay**
  during which the token's **guardian** (the creator) can cancel it; each wallet's
  payment is capped by the list, recorded on-chain and can't be paid twice.
- **Creator reward:** funded from the vault into the lock NFT's 7-day vesting vault.
- **Migration:** `scripts/migrate-to-vault.ts` moves an existing distributor token onto
  the vault (hands over the withdraw authority once the old wallet is drained). CUP was
  migrated this way.

**v2** (live on testnet since 29 Sep 2026):

- the creator reward is **swapped into the network's reward token** before it is
  deposited: **XNM** on testnet (pool `6XES…`), **USDC.X** on mainnet (pool `CAJe…`),
  with price impact capped at half the reward pool's fee, one swap per slot;
- the guardian can cancel at most **2 lists in a row** (the count resets when a list
  goes live), so payouts can't be stalled forever;
- `upgrade_vault` converts a v1 vault in place (480 → 552 bytes); the crank runs it by
  itself, and older XNT rewards stay claimable next to the new token.

**v3** (live on testnet since 29 Sep 2026; every testnet vault is v3): the vault keeps
working if 99 + Tax disappears (see the next section).

- every rewards list file is **pinned to IPFS** before it is published, and its CID is
  stored on-chain next to the list's Merkle root, so anyone can pay from it without the
  site (no pin, no publish: the crank retries next pass);
- the **guardian** (the creator) can **appoint a new publisher** once the publisher has
  published nothing for **7 days**; before that it can't, so a stolen creator key can't
  take over while the site is alive;
- after **30 days** without a published list, **anyone** can keep paying holders from the
  last list with `pay_fallback`: each wallet's share of that list scaled up to all the XNT
  set aside for holders so far (`floor(cumulative × funded / list_total)`). Any new list
  ends the fallback; lists never pay anyone less than they already received;
- the token page shows the publisher, when it last published, when appointing / fallback
  open up, and a **Run the vault now** button: the visitor's wallet signs the steps that
  are due (collect, sell, liquidity, creator reward, a few payouts) and earns the crank
  reward. The creator gets an **Appoint a new publisher** form there once it's allowed;
- `upgrade_vault` converts v1 and v2 vaults in place (→ 640 bytes); the crank does it.

Enabled by `factory.taxVault: { programId, publisherKeypair }` (v3 lists also need
`factory.pinataJwt`). The publisher key can only post lists (which the guardian can
cancel) and cannot move funds. Mainnet stays on distributors, with launches paused, until
the vault is audited.

## If 99 + Tax goes offline

Tax Vault tokens don't depend on this site, its server or its keys (v3):

- **The recovery page: open a link, connect a wallet, click.** One self-contained HTML
  file on IPFS (`src/recovery`) that talks only to an X1 RPC, IPFS gateways and the
  visitor's wallet. It lists every vault, shows its state and recovery windows, fetches
  the active rewards list by its on-chain CID (checked against the on-chain root), and
  runs the steps due now (collect, sell, add liquidity, creator reward, `pay`, or
  `pay_fallback` in fallback), with the visitor earning the crank reward. The creator can
  appoint a new publisher from it once the 7 days are up. It can't publish new lists (see
  below). Pinned copies:

  | Network | CID | Open |
  |---|---|---|
  | testnet | `bafybeidzdlu2ggduswbtr637qnsfxgvjx5ogakxkihuamexkgvpjd5aska` (built from `5d162a7`, sha256 `17f0150b…`) | https://bafybeidzdlu2ggduswbtr637qnsfxgvjx5ogakxkihuamexkgvpjd5aska.ipfs.dweb.link/ |
  | mainnet | pinned at the mainnet rollout | |

  Open it through a subdomain gateway (`https://<cid>.ipfs.dweb.link/` or
  `https://<cid>.ipfs.inbrowser.link/`), `ipfs://<cid>` in Brave or a local node, or any web
  host: Pinata's public gateway refuses HTML. Some antivirus and browser security tools
  block IPFS gateways, so the site also serves the same bytes at `/recovery`
  (e.g. https://99tax-testnet.vercel.app/recovery), only if they match the pinned sha256. Anyone can rebuild it and compare:
  `git checkout 5d162a7 && npx tsx scripts/build-recovery.ts --network testnet` prints the
  same sha256 (`src/recovery/pinned.ts` records each pinned copy). Save a copy: it works
  opened from disk too.
- **Always, with no one's permission:** collecting the tax, burning, selling, adding
  liquidity, the creator reward and paying holders from a published list are program
  instructions anyone can send; whoever sends a sale earns the crank reward (1% of the
  holders' XNT from it, up to 0.05 XNT). The list files are on IPFS and their CIDs are
  on-chain; a file is only used if it gives the on-chain Merkle root.
- **A free scheduled crank on GitHub Actions** is included (`.github/workflows/crank.yml`):
  add a secret `CRANK_KEYPAIR` (a wallet made just for this, with ~0.05 XNT) and it runs
  every 10 minutes. Anyone can fork the repo and run their own.
- **Anyone can run the crank** with only an RPC and a funded wallet:

  ```bash
  npx tsx scripts/crank.ts --rpc https://rpc.testnet.x1.xyz --keypair <wallet.json> --all --loop 300
  # one token: --mint <mint>; other gateways: --ipfs-gateway https://ipfs.io/ipfs/
  ```

  It finds every vault of the program (`--program`, default the testnet `tax_vault`),
  reads the rules the site pinned with each list, and runs collect, sell, add liquidity,
  creator reward and payouts (`pay`, or `pay_fallback` in fallback).
- **New lists need a publisher.** If the publisher has published nothing for 7 days, the
  token's creator (its guardian) can appoint a new one, on the NFT page ("Appoint a new
  publisher", if a copy of the site is up) or without any site:

  ```bash
  npx tsx scripts/appoint-publisher.ts --rpc <url> --keypair <creator wallet.json> --mint <mint> --new-publisher <address>   # dry run
  # add --execute to send it (the program refuses it before the 7 days are up)
  ```

  The new publisher runs the same script with its key and a Pinata key:

  ```bash
  PINATA_JWT=<key> npx tsx scripts/crank.ts --rpc <url> --keypair <wallet.json> --publisher <publisher.json> --all --loop 300
  ```

  Its lists use the same eligibility rules (pinned with each list), build on the active
  list's running totals (read from IPFS and checked against the on-chain root, so nobody
  loses an amount allocated but not yet paid), and end any fallback. If that file can't be
  read from any gateway, it won't publish unless you pass `--allow-rebuild` (every wallet
  then restarts from what it was paid on-chain; the site's equivalent is
  `factory.taxVault.allowListRebuild`).
- **If nobody publishes for 30 days**, holders are still paid: anyone running the crank
  pays each wallet of the last list its share of everything funded since (`pay_fallback`).
  New holders who bought after that list aren't in it until a publisher publishes again.

## Publisher quorum and running a co-signer

**Optional, per token, off by default.** Tokens keep the site's single publisher key (as
everything above describes) unless their vault's publisher is switched to the multisig
below; switching one token doesn't affect any other.

Rewards lists decide who gets the holders' XNT, and the program can only check their totals.
To take that decision away from a single key without changing the program, a vault's
publisher can be a **Squads v4 multisig** (its vault PDA): a list only goes on-chain once 2
of its members approved it. Design: [docs/tax-vault-spec.md](docs/tax-vault-spec.md#publisher-quorum-squads-no-program-change).

- **Members:** the site's crank key (proposes, votes, executes), an independent
  **co-signer** (votes, executes) and optionally a cold **backup**; threshold 2, no config
  authority (membership changes need the multisig itself), no time lock.
- **The site** builds and pins each list as before, then proposes it (one Squads vault
  transaction holding just the `publish_list`) and approves it; it executes it once the
  co-signer approved. A rejected or stale proposal is dropped and a new list built. The token
  page shows the multisig (members, threshold) and each list's co-signer status.
- **Every list file carries its inputs** (snapshot slot, each eligible wallet's balance, the
  pot, the previous list), so anyone can recompute it.
- **The co-signer** approves only a single `publish_list` whose file (fetched by the CID in
  the instruction) matches the root, keeps every wallet at or above its previous total and
  what it was paid, fits the vault's totals, equals the allocation recomputed from its
  inputs, pays no excluded wallet and whose balances match the chain. Anything else it
  rejects, with the reason as its vote's memo, and alerts. A rejected proposal never reaches
  the chain, so it doesn't restart the recovery clocks.

Set up (dry run first; `--execute` needs the vault's current publisher key, i.e. on the
machine that has the site's key):

```bash
npx tsx scripts/setup-publisher-quorum.ts --rpc <url> --keypair <payer.json> --create-key <new-file.json> \
  --site <site key> --cosigner <co-signer key> [--backup <cold key>] --mint <mint>[,<mint>...] [--publisher <site key file>] [--execute]
```

then set `factory.taxVault.quorum = { "multisig": "<multisig address>" }` in the site's
config.json (optional `labels` name the members on the page) and restart it.

**Running a co-signer** needs only its own key (a member of the multisig, with ~0.01 XNT for
fees) and an RPC; run it on another machine than the site, by someone else:

```bash
npx tsx scripts/cosigner.ts --rpc https://rpc.testnet.x1.xyz --keypair <co-signer.json> --multisig <address> \
  [--webhook <url>] [--pinata-jwt <own key>] [--ipfs-gateway <url>,...] [--loop 20]
```

It checks every pending proposal, approves or rejects it, executes approved lists if the
site doesn't, and with `--pinata-jwt` pins a second copy of every approved list file.
`--dry-run` only reports; `--strict` also rejects flagged lists (balances moved since the
snapshot, a large share for a new wallet, an old snapshot); `--allow-rule-change` /
`--allow-rebuild` accept a change of eligibility rules / a list that doesn't build on the
last one (announce those first). Rejections and flags go to stdout and `--webhook`.

**Before switching, know that it's meant to be hard to undo.** Going back to a single-key
publisher needs a `set_publisher` approved through the multisig, which the co-signer
refuses by design, or the guardian's `appoint_publisher` after 7 days without a list. If
the co-signer is offline, **new lists stop** (wallets on the current list are still paid);
after 7 days the guardian can appoint a publisher, after 30 the fallback opens. The
guarantee holds while at least 2 members are honest: two colluding members are still a
single point of control.

## Leaderboard, burns and earnings

- **Holder leaderboard** (`/leaderboard/<mint>`): every holder's balance, average cost,
  cost, worth now, profit/loss, **rewards earned (XNT)** and **total return** (profit/loss +
  realized + rewards), built from their XDEX swaps (average-cost method, `src/trades.ts`).
  Click a wallet to open its My earnings page. Public RPCs keep only about a day of history,
  so trades are indexed every 10 minutes.
- **Burns** (token stats on `/nft/<mint>`): every tax burn with its transaction, a running
  total chart and the share of launch supply burned.
- **My earnings** (`/wallet/<address>`): XNT in the wallet, XNT received, earnings per day,
  holdings and lock NFTs with fees and rewards ready.

## RPC and rate limits

X1 has one public RPC per network, and mainnet's rate-limits hard. So every connection
spaces its requests (`REFLECT_RPC_GAP_MS`, default 150 ms) and waits out "429 Too Many
Requests" for up to ~45 s; transactions are confirmed by polling rather than the
websocket; and the site's read-only views serve their last good answer while refreshing
in the background (warmed every 5 minutes). A dedicated RPC endpoint is still
recommended as usage grows: set `rpcUrl` (or `REFLECT_RPC_URL`).

## Running on a VPS

See [deploy/README.md](deploy/README.md): one setup script, systemd services that
restart on crash and boot, HTTPS via Caddy (or a Vercel front door), a firewall, and daily
encrypted backups. The live setup runs both networks on one server: the testnet site and
distributors from the app folder, and the mainnet site and distributor (`reflect-mainnet-*`
services) from `mainnet/` with its own config, launches and keys; each Vercel project
forwards to its site over a secret path.

## Dashboard

```bash
npm run dashboard            # http://127.0.0.1:8123  (--port N to change)
```

A local, read-only page that refreshes every 30 seconds. It shows:

- total XNT paid to holders, XNT owed but not yet paid, and XNT and tokens added to liquidity
- fees collected and sold, fees waiting to be collected, pool depth and price
- a chart of XNT allocated to holders vs. added to liquidity, per hour or per day
- every holder's balance, share, amount owed and lifetime amount paid
- an activity feed of every collection, sale, auto-LP deposit, allocation and payout, with explorer links
- warnings for low gas, unconfirmed transactions and payouts in progress

It reads `state/events.jsonl`, which the distributor appends to after each confirmed
transaction, plus live chain data. It never signs anything. It only listens on
localhost, because it lists every holder's payouts.

## Tests

```bash
npm test          # 102 tests: allocation, eligibility, CPMM/impact maths, pairs, trades, curve maths, curve tokens on the Tax Vault, holder-pass and tax-vault trees, vault layouts, CIDs, fallback maths, list verification (publisher quorum), Spanish coverage, IPFS gateways, the served recovery page matching its pin
cargo test -p tax_vault --manifest-path lp-locker/Cargo.toml
npm run typecheck
```

Full rehearsals on a local validator loaded with copies of the real chain (see each
script's header for the validator command):

| Script | Proves |
|---|---|
| `scripts/mainnet-rehearsal.ts` | A mainnet launch through the site (USDC fee, pool, lock), trades, a distributor cycle (burn, sell, auto-LP, USDC creator reward, payouts), fee collection |
| `scripts/mainnet-rehearsal-jack.ts` | The same for a TOKEN/JACK launch, incl. the JACK→XNT swap for payouts |
| `scripts/local-curve-test.ts`, `scripts/curve-rehearsal.ts` | The bonding curve, alone and with the site, crank and distributor |
| `scripts/local-curve-targets-test.ts` | Selectable graduation targets: the old curve program upgraded in place under a part-bought 20 XNT curve (which still graduates with 20 XNT), then 500 and 10,000 XNT curves created through the site; the 500 one bought to graduation, pool, lock and delivery checked |
| `scripts/curve-vault-rehearsal.ts` | A curve token on the Tax Vault (v3): the vault's auth PDA as withdraw authority from creation, graduation and registration as a vault token, the tax waiting until the creator starts the vault through the site, then the site's vault crank (collect, sell, XNM creator reward, list, payouts) and "Run the vault now" from a visitor's wallet |
| `scripts/local-vault-test.ts`, `scripts/vault-rehearsal.ts` | Tax Vault v1: the program alone, then site + crank, including migrating a distributor token |
| `scripts/local-vault-v2-test.ts` | Tax Vault v2: a v1 vault upgraded in place, the XNM creator-reward swap, the guardian cancel limit, error cases |
| `scripts/vault-v2-rehearsal.ts` | The v2 rollout as it happens on testnet: the previous site + v1 program, then the program upgrade and the new site upgrading the vault by itself |
| `scripts/local-vault-v3-test.ts` | Tax Vault v3 program alone: v1/v2 vaults upgraded, list CIDs, appointing a publisher, `pay_fallback` maths and error cases |
| `scripts/vault-v3-rehearsal.ts` | The "operator dies" drill: previous site + v2 program, v3 deployed, the new site upgrades the vault and publishes lists to IPFS (a local stand-in), "Run the vault now" from a visitor's wallet; then the site stops and another wallet keeps holders paid with `scripts/crank.ts` from the IPFS list, through fallback, until the creator's appointed publisher publishes again |
| `scripts/build-recovery.ts --short-windows` | The recovery page, driven in a real browser with a test wallet: on testnet a stranger's wallet ran CUP's due steps (collect, sell, liquidity, creator reward) and earned the crank reward; on a local validator holding a copy of CUP's vault under the short-windows program, the guardian appointed a new publisher and a stranger paid holders with `pay_fallback` from the IPFS list |
| `scripts/publisher-quorum-rehearsal.ts` | The publisher quorum: the site with a plain key, then a 2-of-3 Squads multisig set up by `scripts/setup-publisher-quorum.ts` and made the publisher; the site's proposals, a co-signer rejection and a new list, the co-signer's approval, execution and payouts; a malicious list and a publisher change proposed by the site's key alone rejected by the co-signer and never on-chain, the recovery clocks unmoved |
| `scripts/local-holder-pass-test.ts`, `scripts/local-claims-cycle-test.ts` | Holder passes |

Use the solana 3.x CLI and test validator for the program upgrade tests: the older 2.1
test validator rejects `solana program extend`, which X1 testnet (solana-core 4.x)
accepts.

## Verified vs. not yet verified

**Live on mainnet:** the launchpad and the `lp_locker` program (deployed from a build
checked byte-for-byte against the rehearsed one). The first real launch ("Test", paired
with XNT) completed all four steps and its distributor has been paying holders, burning
and adding liquidity every cycle; the site's figures were checked against the chain.

**Live on testnet:** the `tax_vault` program **v3** (upgraded in place from v1 and v2,
each deployed build checked byte-for-byte against the rehearsed one). **Every testnet token
runs on it**: CUP (migrated, then upgraded v1 → v2 → v3 by the crank), RFLT (migrated),
every new launch, and curve tokens (the vault holds their tax from creation): **Honey**,
the first live curve, graduated to XDEX with its LP locked and has paid its holder from
the vault. Both testnet
distributor services are off. Seen live: collect, burn, sale, auto-liquidity, the XNM creator
reward, rewards lists pinned to Pinata (the file's hash and Merkle root checked against
the chain), holder payouts (a new holder paid exactly its list amount 11½ minutes after
buying), and "Run the vault now" from a browser wallet. Every transaction fits its compute
limit to what it uses (X1 bills requested units), which cut fees ~5–10×. The
`bonding_curve` program with selectable graduation targets (500 default, 1,000, 3,000,
5,000, 10,000 XNT; 10 and 20 XNT on testnet) since 30 Sep 2026, and supply presets on both
launch forms. The **recovery page** is pinned to IPFS and served at `/recovery`: from it a
stranger's wallet ran CUP's due steps live and earned the crank reward (appointing and
fallback were driven from it on a local copy of CUP's vault). A **GitHub Actions keeper**
runs the crank on a schedule with its own wallet. Also live:
RFLT and CUP's earlier distributor cycles, a creator's collect-fees and metadata updates
with a real wallet, and the faucet.

**Reviewed:** an independent pre-audit review (Theo, 30 Sep 2026, commit `ce38a49`)
reproduced the deployed build hashes and found no critical or high issues; two findings
were fixed in `5302391` and one is open for the audit. See the review log in
[docs/REVIEW.md](docs/REVIEW.md#review-log).

**Rehearsed on local copies of the chain:** every launch path (XNT, JACK, bonding curve,
bonding curve on the Tax Vault),
the locker's attack cases (collecting without the NFT, draining the vault, a fake XDEX
program, a freezable NFT mint, unlocking early or a forever lock), crash recovery of the
distributor's journal, and program upgrades against the real lock accounts.

**Not yet:** an independent audit of `lp_locker`, `bonding_curve` and `tax_vault` (all
still upgradeable by the team); the vault on mainnet (mainnet launches stay paused until
then); a second, independent IPFS pin of the rewards lists and the recovery page (today
they're pinned on one Pinata account, readable through any gateway); a JACK-paired launch on mainnet itself; Holder Passes on a public
network (testnet `lp_locker` is an older revision without them); the bonding curve on
mainnet; trustless holder payouts (lists are published by one key; see
[docs/REVIEW.md](docs/REVIEW.md#trust-assumptions)). The publisher quorum (Squads multisig +
co-signer, [above](#publisher-quorum-and-running-a-co-signer)) is implemented and rehearsed
on a local validator only; no testnet vault uses it yet.

## Things to know before launching

- **The sale is constant sell pressure.** Every cycle sells the collected fees into
  your own pool. Deep liquidity and the price-impact cap limit the damage, but it
  offsets part of what holders gain.
- **Auto-LP deposits pay the transfer fee too.** 5% of the tokens deposited is withheld
  and collected again next cycle, so a little less than 40% of the fees ends up in the
  pool. The burned LP tokens mean nobody, including you, can withdraw that liquidity.
- **LP providers don't earn reflections** on tokens sitting in the pool (the vaults are
  excluded). They do earn XDEX trading fees.
- **Snapshot gaming** (buy just before a cycle, sell after) costs about 10% round-trip in
  transfer fees, so it only pays when a cycle's pot is very large. Raising
  `minHoldingTokens` or running cycles at unpredictable times helps.
- **Fee-on-transfer tokens** confuse some aggregators, bridges and CEXs. The fee also
  applies to plain wallet-to-wallet transfers.
- **Scaling:** holders are found with `getProgramAccounts`, and mainnet's public RPC is
  heavily rate-limited (see "RPC and rate limits"). Use a dedicated RPC as usage grows.
- **Key safety:** on the distributor path, the distributor key can withdraw all
  collected fees, and the creator key controls the fee until you run `lock-fee`. Keep
  both off shared machines. Tax Vault tokens have no such key.
- Paying holders from trading fees can create securities or tax obligations in some
  jurisdictions. That is worth checking before a public launch.
