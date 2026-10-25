# The distributor path (retired)

Before the Tax Vault, every 99 + Tax token's tax was run by an off-chain **distributor**:
one hot wallet per token that collected the tax, burned, sold, added liquidity, funded the
creator reward and paid holders. Every live token on both networks has since moved to the
Tax Vault (see the [README](../README.md#tax-vault)), and both networks' distributor
services are off. The code is kept for JACK-paired tokens and for sites run without the
vault; this page keeps its documentation.

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

## Holder passes (pull-based holder rewards)

> This is the older, NFT-based design in `lp_locker` (built, not deployed). The holder
> passes running on testnet are the Tax Vault's own: see
> [On-chain holder passes](../README.md#on-chain-holder-passes-v4-trial-testnet).

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

Tests: `scripts/local-holder-pass-test.ts` and `scripts/local-claims-cycle-test.ts` (holder
passes, above), `scripts/mainnet-rehearsal.ts` and `scripts/mainnet-rehearsal-jack.ts`
(distributor cycles).
