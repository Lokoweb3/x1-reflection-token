# X1 Reflection Token (pays holders in XNT)

A reflection token for X1. Every transfer, including XDEX buys and sells, withholds a
**5% fee**. A distributor bot periodically collects those fees. With `autoLpBps: 4000`,
**40%** of them are added to the XDEX pool as permanently locked liquidity (auto-LP), and
the other **60%** are sold for **XNT** and paid to holders in proportion to their balance.

X1 runs on the Solana VM, so SafeMoon-style "balances grow by themselves" contracts
don't carry over: balances live in separate token accounts, and a custom ledger would
not work with wallets or XDEX. This project instead uses standard, audited pieces:

| Piece | What it does |
|---|---|
| **Token-2022 mint** with the *TransferFee* and *Metadata* extensions | Wallets, explorers and XDEX handle it natively. Token-2022 enforces the fee on every transfer. |
| **Distributor wallet** (withdraw-withheld authority) | Harvests fees into the mint, withdraws them, sells them for XNT and pays holders. |
| **XDEX TOKEN/XNT pool** | Where the collected fees are sold. XDEX supports Token-2022 transfer-fee tokens. |

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
liquidity, and the lock (forever, 7, 30, 90 days or 1 year). Their wallet approves three
transactions:

1. **Token:** Token-2022 mint with the tax and **no fee authority** (the tax can never
   change), supply minted to the creator, **mint authority revoked**, the launch fee
   (`factory.feeUsdc` USDC to `factory.feeReceiver`; on testnet `factory.feeToken` can swap in another token such as XNM, and mainnet ignores it and always charges USDC.X) and the token distributor's gas.
2. **Pool:** a TOKEN/XNT pool on XDEX with the creator's tokens and XNT.
3. **Lock:** all of the creator's LP locked in an NFT, which collects the trading fees.

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
creators paste a logo link and the site serves the metadata as before.

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

## Running on a VPS

See [deploy/README.md](deploy/README.md): one setup script, systemd services that
restart on crash and boot, HTTPS via Caddy, a firewall, and daily encrypted backups.

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
npm test          # allocation, eligibility, CPMM and price-impact math, decimal handling
npm run typecheck
```

## Verified vs. not yet verified

**Verified on X1 testnet** (XDEX program `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`):
the full distribution cycle ran for real several times (harvest → withdraw → sell →
auto-LP deposit and LP burn → allocate → pay), both by hand and from the background
loop, and the payouts, the LP burn and the locked-liquidity maths were checked on-chain.
The `lp_locker` program is deployed there, and a forever lock is live.

**Verified on a local validator** loaded with a copy of the real testnet XDEX program and
pool: lock, fee collection, NFT transfer (the new holder collects, the old one can't),
timed lock and unlock, and refusal of these attacks: collecting without the NFT, draining
the vault, a fake XDEX program, a freezable NFT mint, unlocking early, and unlocking a
forever lock. The dashboard's wallet buttons were driven in real Chromium with a mock
Wallet Standard wallet.

**Burn:** verified on a local validator (the supply dropped by exactly the amount
burned) and running live on testnet for RFLT (50% holders / 25% liquidity / 25% burn).

**Token factory:** a full launch through the page (token, pool, LP lock, registration)
and a factory distribution cycle ran on a local validator with a copy of the real
testnet XDEX program. The pool-creation instruction matches a real testnet XDEX
`Initialize` account for account. No launch has been done on testnet itself yet.

**Not yet verified:** anything on mainnet; the dashboard and launchpad with a real wallet
extension; a factory launch on testnet; long-running operation. The `lp_locker` program
has **not** had an independent audit.

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
- **Scaling:** holders are found with `getProgramAccounts`. That's fine for thousands of
  holders on the public RPC. Beyond that, use a dedicated RPC.
- **Key safety:** the distributor key can withdraw all collected fees, and the creator
  key controls the fee until you run `lock-fee`. Keep both off shared machines.
- Paying holders from trading fees can create securities or tax obligations in some
  jurisdictions. That is worth checking before a public launch.
