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
   this. Then **withdraw** them to the distributor's token account. `autoLpBps` of them
   are set aside for auto-LP: half kept as tokens, half to be sold for the XNT side.
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
  the NFT holder can `unlock`: all the LP goes back to them and the NFT is burned. The
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

**Not yet verified:** anything on mainnet; the dashboard with a real wallet extension;
long-running operation. The `lp_locker` program has **not** had an independent audit.

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
