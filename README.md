# 99 + Tax: tax tokens on X1 that pay holders in XNT

**99 + Tax** is a launchpad for tax tokens on the X1 blockchain. Every trade of a 99 + Tax
token pays a small tax (1–10%), and the **Tax Vault program** (on mainnet since 1 Oct 2026
as a marked beta, and on testnet) turns that tax into:

- **XNT paid straight to holders' wallets**, in proportion to their balance (at least 35%
  of the tax),
- **permanent liquidity**: tokens + XNT added to the pool, with the LP tokens burned,
- **burned tokens**, so the supply only goes down,
- a **10% creator reward**, paid in USDC.X on mainnet (XNM on testnet) and vesting over
  7 days.

Anyone can launch one in a few wallet approvals. The whole supply goes into the pool
(no dev bag), the launch liquidity is locked forever in an NFT, and the tax can never be
changed.

On **both networks every token's tax is held by the Tax Vault** program (v3): no server key
can move it, and holders keep getting paid if the site disappears (see
[Tax Vault](#tax-vault) and [If 99 + Tax goes offline](#if-99--tax-goes-offline)). On
mainnet the vault went live on 1 Oct 2026 as an **unaudited beta** (the site says so): the
first token, "Test", moved onto it from its old hot-wallet distributor and was paid out by
it the same morning. New mainnet launches reopen on the vault shortly. Testnet also runs
**payout tokens** (v4, live since 1 Oct 2026): holders paid in a token the creator picks
instead of XNT, and, as a trial since 23 Oct 2026, **on-chain holder passes**: holders
register once and the program itself splits and pays the holders' share, with no
published list (see [On-chain holder passes](#on-chain-holder-passes-v4-trial-testnet)).

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
a bonding curve (testnet), the Tax Vault and (retired) an off-chain distributor around them.

| Piece | What it does |
|---|---|
| **Token-2022 mint** (TransferFee + Metadata extensions) | The token. Token-2022 withholds the tax on every transfer; no fee-config authority, so the rate can never change; mint authority revoked. |
| **XDEX pool** (TOKEN/XNT, or TOKEN/JACK) | Where the token trades and where the tax is sold. |
| **`lp_locker`** (Anchor, `lp-locker/programs/lp_locker`) | Locks the pool's LP behind a 1-of-1 NFT (forever or timed). The NFT holder collects the LP's trading fees and claims the creator reward from a 7-day vesting vault. Also Holder Passes (built, not deployed). |
| **`bonding_curve`** (Anchor, `lp-locker/programs/bonding_curve`, testnet) | Curve launches with no starting liquidity; at graduation it creates the XDEX pool and locks the LP through `lp_locker`. See [docs/bonding-curve-spec.md](docs/bonding-curve-spec.md). |
| **`tax_vault`** (Anchor, `lp-locker/programs/tax_vault`, testnet) | Program custody of each token's tax: collect, burn, sell, add liquidity, creator reward and holder payouts against a published Merkle list, all enforced on-chain and cranked by anyone. See [docs/tax-vault-spec.md](docs/tax-vault-spec.md). |
| **Distributor** (`src/distribute.ts`, one wallet per token) | The pre-vault path, now retired on both networks (every live token is on the Tax Vault); kept for JACK-paired tokens and sites without the vault: each cycle collects the tax, burns, sells for XNT, adds liquidity (LP burned), funds the creator reward and pays holders. Crash-safe journal. |
| **Site** (`src/factory-server.ts`) | Landing page, launch app and all the public pages below; builds transactions for the visitor's wallet to sign (it never holds their keys). |

**Program ids**

| Program | Mainnet | Testnet |
|---|---|---|
| `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` |
| `bonding_curve` | – | `CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY` |
| `tax_vault` | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` (v3, beta) | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` |
| `tax_vault` with holder passes (trial) | – | `Aqt57qzgBy9cJLiygL6V8fHK7Sov7DwXeQFAm8aphxc8` |
| XDEX | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` | `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` |

The home page's **Contracts** section lists every address the live site uses.

**Site pages:** `/` (how it works, on-chain checks, contracts, costs, FAQ) · `/launch`
(launch app, your launches, Distribute now) · `/tokens` · `/nft` and `/nft/<mint>` (lock
NFTs, withdraw, full token stats incl. burns) · `/leaderboard/<mint>` (holders' average
cost, rewards earned, total return) · `/wallet/<address>` (My earnings) · `/analytics` ·
`/curve` (testnet) · `/faucet` (testnet) · `/v4` and `/v4/standalone` (holder passes, testnet). A Mainnet/Testnet toggle and a theme picker
(Notebook by default) sit in every header.

The project began as one testnet token, **RFLT**, run by an off-chain distributor wallet;
that path is retired (every live token is on the Tax Vault). Its setup, runbook, cycle,
the NFT-based holder passes, "Distribute now" and the local dashboard are in
[docs/DISTRIBUTOR.md](docs/DISTRIBUTOR.md).

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

**From the local dashboard** ([docs/DISTRIBUTOR.md](docs/DISTRIBUTOR.md#dashboard)): click **Connect wallet** (any Wallet Standard wallet, such as X1
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

### Lock receipt NFT

After a lock confirms, one more approval "prints" a receipt into the NFT (token, tax
split, LP locked, pool share, lock term, and the exact on-chain lock time). On a site with
IPFS uploads set up, the creator's browser draws the receipt as a PNG; the site pins it
and a standard metadata JSON (name, image, the lock details as attributes, a link to the
lock page) to IPFS, and the NFT's Token-2022 metadata `uri` points to the JSON's https
link: the form wallets and explorers read. Without uploads, the receipt goes on-chain as a
small SVG inside a `data:` URI (nothing hosted, but many wallets can't show it; such a
receipt shows "Update receipt" once uploads are on). The JSON keeps the receipt's
fingerprint, so the site offers an update when the numbers change. A receipt stays
"current" while its fixed facts match and the drifting numbers stay close (pool share within
1 point, LP locked within 5%). "Locked at" and "Until" show the visitor's local time (the
receipt image keeps UTC). Only the wallet that
locked (the NFT's update authority) can print it.

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
- Themes: every page has a **Theme** menu in its header. Visitors pick one of seven:
  Receipt (cream paper, monospace, red price tags), Arcade (dark cabinet, pixel font, CRT
  scanlines; always dark), Lunch bag (kraft paper bag, marker pen, taped notes), Notebook
  (ruled paper, handwriting, tokens and NFTs as sticky notes), Space (mission control on a
  starfield), Desert (sun-bleached trading post) or Casino (green baize and gold leaf), and
  a mode:
  Auto (follows the device), Light or Dark. The choice is saved in their browser and
  applied before the page paints. `factory.theme` in config.json sets the default for
  new visitors. Links can carry `?theme=arcade&mode=dark` (`?theme=default` clears it).
  Files: `src/web/theme-<name>.css` (fonts, colours and a dark-mode token set) on top of
  `src/web/theme-base.css` (shared layout rules); `src/web/theme.js` is the menu.
- Language: an **EN / ES** switch in every header; the whole site is translated into
  Spanish (`src/web/i18n/es.js`, checked complete by the tests). `?lang=es` sets it from a link.
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
the wallet can afford the whole launch. Their wallet approves four transactions (five with holder passes):

1. **Token:** Token-2022 mint with the tax and **no fee authority** (the tax can never
   change), the supply minted to the creator only to be put into the pool in step 2
   (100% of it; the creator keeps none), **mint authority revoked**, the launch fee
   (`factory.feeUsdc` USDC to `factory.feeReceiver`; on testnet `factory.feeToken` can swap in another token such as XNM, and mainnet ignores it and always charges USDC.X).
2. **Pool:** a TOKEN/XNT pool on XDEX with the creator's tokens and XNT (or, if the
   creator picks another pair the site offers, e.g. JACK, a TOKEN/JACK pool with their
   JACK; XDEX's pool fee is still XNT).
3. **Lock:** all of the creator's LP locked in an NFT, which collects the trading fees.
4. **Start the tax vault:** `init_vault` hands the token's withdraw authority to the vault
   program, so no distributor key is ever created for it.
5. **Turn on holder passes** (testnet, only with **Holder passes (testnet trial)** ticked):
   the vault is started under the holder-passes program instead, and one more approval
   allocates the pass book and sets its rules (`init_passes`). See
   [On-chain holder passes](#on-chain-holder-passes-v4-trial-testnet).

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

Then the launch is verified on-chain and registered, and the site's vault crank runs it
from there. (A site without the Tax Vault gives each token its own distributor wallet; see
[docs/DISTRIBUTOR.md](docs/DISTRIBUTOR.md).)

- Launch fee: USDC.X on mainnet (`B69ch…m9Tq`); on testnet, the USDC that has an XDEX
  testnet pool (`4dr9…2KsU`). Launchers need it in their wallet.
- **Supply** is capped at 10 billion (as for curves): above about 18.4 billion the 9-decimal
  amount wraps in u64 and the pool step could never be built.
- **Costs** besides the fee and the pool's XNT: account rent ≈ 0.08 XNT (≈ 0.24 XNT with
  holder passes, 0.16 of it the pass book), measured on testnet. The form shows "–" and
  stops before the confirm box for an invalid pool amount, and says when burn or liquidity
  was lowered to keep them within 55%.
- **Registration checks the pool and the lock:** the pool's reserves must hold at least 98%
  of (1 − tax) × supply × pool amount (trading only grows it, so a pool seeded with a sliver
  of the supply or emptied before the lock falls short), and the creator's locks must hold
  at least 99% of the pool's starting LP. A launch that fails isn't listed.
- A launch record without its own `config.json` falls back to the site's settings, and a
  token that still can't be read is left out of `/tokens` instead of breaking the list.
- The tax starts with the first transfer, so seeding the pool pays it once. That
  tax is collected and goes back to holders and liquidity like any other.
- Token metadata (`/meta/<mint>.json`) is served by the factory. To make the page public,
  put it behind an HTTPS reverse proxy, set `factory.publicUrl` and list the host name in
  `factory.hosts`. It only listens on 127.0.0.1 by default.

### For AI agents

`/agents` explains how to let an AI agent launch a token: paste one line into the agent, install the skill
in Claude Code, or run the launcher yourself. Each site serves the same files for its own network:

| Path | What |
|---|---|
| `/skill.md` | the skill (the `SKILL.md` format) agents follow: collect the settings, run the check, show it, launch only after the person's explicit yes |
| `/agents/launch.mjs` | the launcher, signing with a local keypair that never leaves the machine |
| `/agents/reference.md` | the launch API step by step, with its real error responses |
| `/agents/openapi.yaml` | the same API as OpenAPI 3.0, with both servers |
| `/llms.txt` | a pointer to the above |

Always pass the site, and keep it for the whole launch, including a resume:

```bash
curl -O https://99tax-testnet.vercel.app/agents/launch.mjs && npm i @solana/web3.js@1
S=https://99tax-testnet.vercel.app   # or https://99tax.vercel.app (mainnet, real funds)
node launch.mjs --site $S --keypair wallet.json --name "My Token" --symbol MYT --supply 1000000000 --tax 5 --pool 10 --lock forever         # check: sends nothing
node launch.mjs --site $S --keypair wallet.json --name "My Token" --symbol MYT --supply 1000000000 --tax 5 --pool 10 --lock forever --live  # launch
node launch.mjs --site $S --keypair wallet.json --resume <mint> --live   # finish a launch that stopped
node launch.mjs --site $S --keypair wallet.json --status                 # this wallet's launches
```

The check prints the network, settings, whether the launch uses the Tax Vault, the paying wallet and the full
cost, and stops if the wallet is short. Before anything is signed, the launcher stops unless the site's
`/api/info` reports the network expected for that URL (`https://99tax.vercel.app` → mainnet,
`https://99tax-testnet.vercel.app` → testnet; any other site needs `--network mainnet|testnet`), and a resumed
mint must belong to that site and exist on that network's chain. The person's approval is a rule in the skill:
the launcher can't tell who said yes.

The files live in src/agents/; `{{SITE}}` and `{{NETWORK}}` are filled in with `factory.publicUrl`, used as it
is (a local site points agents at itself), and the network. So a public site needs `factory.publicUrl` set to
its public URL. After changing them, restart the site (`reflect-factory` on testnet, `reflect-mainnet-factory`
on mainnet). Validate the OpenAPI file with `npx @redocly/cli lint src/agents/openapi.yaml`.

## Token logos and metadata on IPFS

With a Pinata API key with Files: Write (`factory.pinataJwt` in config.json, or `PINATA_JWT`), the launch
form gets an **Upload image** button: the logo goes straight through to IPFS (PNG, JPG,
WebP or GIF, checked by its bytes, ≤ 500 KB, 20 uploads per IP per hour) and nothing is
kept on the server. The token's metadata JSON (name, symbol, description, image) is
pinned too, so the on-chain link points to IPFS (`factory.ipfsGateway`, default
`https://gateway.pinata.cloud/ipfs/`) and keeps working even if the site goes away. If Pinata refuses (key or plan), the
error goes to the server log and the visitor sees "can't save files to IPFS right now,
nothing was sent to your wallet". `/api/launch/metadata` is rate-limited like logo uploads,
and a pending metadata update is keyed by (mint, new link), so a stranger's request can't
replace the creator's. Without a key,
creators paste a logo link and the site serves the metadata as before. Tax Vault rewards
lists are pinned the same way (v3). For rehearsals the upload API and the gateway can be
pointed at a local stand-in (`factory.pinataApiUrl` / `PINATA_API_URL`, `IPFS_GATEWAY`).

## Bonding curve (testnet)

The **Curve** tab launches a token with no starting liquidity. Buyers fill a price curve
with XNT; when the curve's target is raised (**500, 1,000, 3,000, 5,000 or 10,000 XNT**, plus **10 or 20 XNT on testnet** for trying a full graduation with faucet XNT; the
creator's pick, 500 by default; curves made before targets were selectable keep 20 XNT) the
curve **graduates**: it creates the XDEX pool with that XNT and the last 20% of the supply, locks all the LP forever through `lp_locker`
(the NFT goes to the creator), and delivers every buyer's tokens to their wallet.

- **Tokens are created at graduation.** During the curve, balances live in the curve, so
  no tax applies; the tax is live from the first XDEX trade after graduation.
- 80% of the supply sells on the curve, priced so its last price equals the pool's
  opening price. 1% fee on curve trades. The creator can't buy their own curve.
- **Early-buy limits:** for the first 2 minutes a wallet's position may hold at most 1% of
  the supply across all its buys, and all buyers together at most 10%; a transaction may
  carry only one buy of the curve (also refused through another program).
- **No deadline, but a refund:** tokens stay with the curve until it fills, and you can sell
  back any time. A curve that is complete but hasn't graduated 7 days later can be refunded:
  anyone sends each position its share of the XNT raised plus its deposit, and the last
  refund sends what's left to the creator (status 5, Refunding; the crank does it).
- `create_curve` checks the XDEX amm config (owner, size, pool creation enabled).
- Graduation and delivery are permissionless; the site's crank (`factory.curve.crankKeypair`)
  does them automatically and earns the 0.01 XNT graduation reward.
- **Tax custody:** a curve token's tax belongs to the Tax Vault from the start: the
  program requires the withdraw authority to be a tax-vault `auth` PDA (no distributor
  wallet, no distributor gas), so curve launches need the Tax Vault and the site refuses
  others up front. At graduation the crank registers it as a vault token; the
  creator then signs one transaction, **Start the tax vault** (on the curve page, the lock
  NFT's page or "Your launches"), and the vault crank takes over. Until then the tax waits
  in the token accounts, where nobody can move it.
- **Holder passes on a curve** (testnet trial): the curve form has the same "Holder passes
  (testnet trial)" checkbox. After graduation the creator's button starts the vault and turns
  the passes on (two approvals) on the curve page, "Your launches" and the lock NFT page.
- `/curve`'s "Graduated" filter shows graduated curves; refunding ones appear only under "All".
- Spec: [docs/bonding-curve-spec.md](docs/bonding-curve-spec.md). Tests:
  `scripts/local-curve-test.ts` (program end to end), `scripts/curve-rehearsal.ts`
  (site + program + crank + distributor) and `scripts/curve-vault-rehearsal.ts` (site +
  curve + Tax Vault v3), `scripts/local-curve-targets-test.ts` (the selectable-target upgrade
  over a live 20 XNT curve, with the site). Enabled by `factory.curve.programId`; off on
  mainnet until audited.

## Tax Vault

> **Payout tokens (v4, live on testnet):** a launch can pay its holders in another token
> instead of XNT ("Pay holders in" on the launch form, fixed for good). The vault swaps the
> holders' XNT on that token's XDEX pool and pays the token. See
> [docs/tax-vault-spec.md](docs/tax-vault-spec.md#payout-token-v4). The first v4 build sent
> the holders' tokens to the creator when the payout token was also the creator-reward token
> (XNM / USDC.X); the fixed build keeps them apart, and until a network runs it the site
> refuses the reward token as payout token (`factory.taxVault.rewardTokenPayouts`).

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
cancel) and cannot move funds. On mainnet it also needs `factory.taxVault.mainnet: true`
(set since 1 Oct 2026, with `beta: true` for the "not formally audited" notice); the runbook
is [docs/MAINNET-ROLLOUT.md](docs/MAINNET-ROLLOUT.md).

The publisher key also pays every vault transaction's network fee, so it needs XNT: with
`distribution.priorityMicroLamports: 1000` that's roughly 0.0002–0.0004 XNT per transaction
(about 7 an hour on an active token), partly paid back by the crank reward on each sale. Under
`factory.taxVault.crankLowXnt` (default 0.2 XNT) the vault panels show a warning and the
server logs `[vault crank] LOW BALANCE` hourly. If it runs dry the vaults just wait (the tax
stays collected-in-place), and anyone can still press **Run the vault now** with their own wallet.

- **Rent for first payments:** a wallet's first payment creates its paid record (~0.00145 XNT
  of rent, paid by the crank). The crank sends it only once the wallet is owed at least the
  minimum plus that rent, within a daily rent budget per token (`RECORD_RENT_PER_DAY`,
  0.05 XNT), so it never pays more rent than it pays out.
- **Run the vault now** (`/api/vault/<mint>/crank-tx`): plans are cached 10 s per token and
  caller, new ones are limited (6 a minute per address, 60 a minute site-wide), and a run's
  result clears the cache, so visitors can't starve the crank's RPC queue.
- **Readable errors:** a failed transaction's error code is turned into words before it
  reaches the visitor (`src/program-errors.ts`), read against the program that failed:
  Anchor's own message first (XDEX too), else the vault, passes, curve and locker tables;
  plus "not enough XNT" and "expired". The error's name stays in brackets. Spanish too.

## On-chain holder passes (v4 trial, testnet)

The Tax Vault normally pays holders from a list the site computes off-chain and publishes
(Merkle root on-chain, file on IPFS). **Holder passes** move that split on-chain: holders
register once, and the program reads their balances and pays them itself. No list, no
publisher, no 10-minute cancel window for the holders' share.

Live on X1 testnet as a trial under a separate program,
`Aqt57qzgBy9cJLiygL6V8fHK7Sov7DwXeQFAm8aphxc8`, built from the same
`lp-locker/programs/tax_vault` source. The testnet site runs both programs side by side:
existing vaults stay on `D9jt…`, and a launch with **Holder passes (testnet trial)** ticked
gets its vault under `Aqt57…`. Mainnet doesn't offer it.

**How it works**

- **Pass book:** one account per token with room for 256 passes, grown in place by
  `alloc_pass_book` and switched on by `init_passes`, which sets the rules. The launch page
  uses: minimum holding = supply / 1,000,000, minimum pot 0.05 XNT, at least 5 minutes
  between rounds.
- **Register:** a wallet registers its own pass (`register_pass`, top-level instruction
  only, so a pool or other program address can't). It must hold at least **2× the
  minimum** to register; empty wallets can't take the book's slots. Its associated
  Token-2022 account is what each round reads. `remove_pass` (anyone) drops a fully paid
  pass whose wallet fell under the minimum and returns its rent to the wallet; the crank
  removes up to 10 such passes per token on each pass, so sellers don't keep their slots.
- **Full book:** `register_pass_evict` lets a wallet holding at least **2×** a pass's live
  balance (and the registering minimum) take the slot of a pass owed nothing, outside a
  round; the evicted pass's rent goes back to its wallet. `/v4` builds it when the book is
  full and says what it takes.
- **Rounds:** the vault's holder share (after burn, liquidity and creator reward) builds a
  pot. Once it reaches the minimum, anyone runs a round: `snapshot_batch` reads the
  registered balances (all within ~60 s), `close_round` sets the payout, and `pay_passes`
  sends each pass's share straight to its wallet, in proportion to its balance.
- **Cap on every round:** a round pays at most **80% of the transfer tax on the eligible
  tokens' value** at the pool price, whether it's read in one transaction or several (256
  passes need several). Moving tokens between batches to be counted twice, or buying,
  snapshotting and selling in one transaction, always costs more in tax than it earns. The
  rest waits for the next round, so small holdings earn little per round however large the
  pot is.
- **Caller reward:** whoever runs the round earns 1% of it (at most 0.05 XNT).
- **Passes or a list, never both:** `init_passes` refuses a vault that ever had a rewards
  list (published or waiting), since a list's `pay_fallback` counts vault-wide totals; the
  crank never builds a list for a pass-mode launch (the holders' share waits for the first
  round), and the site refuses to turn passes on for a listed vault.
- **Rules:** the minimum holding defaults to a millionth of the supply; the server refuses
  one under a ten-millionth, a minimum pot under 0.01 XNT and an interval under 60 s.
- **Extras:** `sponsor_holders` lets anyone add XNT to the holders' pot; `index_passes`
  keeps program-owned address lookup tables so a round's transactions fit.

**Running it**

- The site's crank runs due rounds every 60 s, next to the usual collect / sell /
  liquidity / creator reward steps. Config (testnet only):
  `factory.taxVault.passes: true` and `factory.taxVault.passesProgramId`. Each launch
  record carries `vaultProgram`, so the server routes every token to the right program.
- **`/v4`** lists the tokens with passes (book, pot, rounds, paid) and lets any wallet
  register, run a round, pay or **Remove N empty passes** with its own key. The pass table
  shows 20 at a time (Previous/Next, "Show my pass") with a Status column, warns a holder
  whose pass no longer earns, shows "Register to earn: N of 256 passes left", fits a phone
  and is in Spanish. `/tokens` links pass-mode tokens to `/v4` with the slots left. **`/v4/standalone`** is the same as one
  self-contained HTML file (`scripts/build-recovery.ts --program`), also pinned to IPFS,
  that talks only to an X1 RPC (served with the recovery page's CSP so it can reach it). It has to be served over http(s); opened as a local file,
  the RPC refuses it.
- API: `/api/v4` (all tokens), `/api/v4/<mint>?wallet=<address>` (one token, one wallet),
  `/api/v4/<mint>/remove-tx` (remove empty passes), `/api/launch/passes` (the launch step).
- Test helpers (testnet only): `scripts/v4-test-wallets.ts --mint <token> --funder
  <keypair.json> [--count 5]` makes wallets that buy the token and register passes (keys
  in the git-ignored `test-wallets/`); `scripts/v4-spread-tokens.ts` spreads tokens over them.

**Testnet so far:** WAY (`JAAz…9GFs`) has a full book of 256 passes and has paid about
23.1 XNT over 22 rounds; PASST (`CViB…S85H`) was launched from the launch page with holder
passes ticked and paid its first round to 256 passes on 23 Oct 2026, all cranked by the
site. CPASS (`AeJG…`) was the first bonding-curve launch with passes: bought to its 10 XNT
target, graduated by the crank (LP locked forever), vault started and passes turned on. The program is **unaudited**, like the rest.

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
  | mainnet | `bafybeid64cdbdnrx26ewj7kn6bvw5mnlruikiqpvqopobpeiqgpze5mdge` (built from `e462dfb`, sha256 `351fb123…`) | https://bafybeid64cdbdnrx26ewj7kn6bvw5mnlruikiqpvqopobpeiqgpze5mdge.ipfs.dweb.link/ (also https://99tax.vercel.app/recovery) |

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
[PINATA_JWT=<own key>] npx tsx scripts/cosigner.ts --rpc https://rpc.testnet.x1.xyz --keypair <co-signer.json> --multisig <address> \
  [--webhook <url>] [--ipfs-gateway <url>,...] [--loop 20]
```

It checks every pending proposal, approves or rejects it, executes approved lists if the
site doesn't, and with `PINATA_JWT` set pins a second copy of every approved list file.
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

- **Holder leaderboard** (`/leaderboard/<mint>`): every holder's balance, cost (with the
  average price paid), worth now, profit/loss, **If sold now**, **rewards earned (XNT)**,
  **total return** (profit/loss + realized + rewards), XNT spent and realized profit, built
  from their XDEX swaps (average-cost method, `src/trades.ts`). Trades are found through the
  token's mint, so buys routed through other pools (XNT → JACK → token) count too, and every
  trade since launch is read (older ones backfill over a few minutes). **If sold now** is
  what selling the whole balance in one go would return today: after the token's tax, the
  pool's fee and the sale's own price impact (each wallet as if it sold alone), with the
  profit/loss on that basis; "Worth now" is balance × spot price. The table fits the page
  without sideways scrolling; on phones each holder is a card. Click a wallet to open its
  My earnings page.
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

The site's own rate limits count only real requests: `/api/send` counts once the
transaction is fully signed and calls only this site's programs, and launches and curve
creation count once the request validates and the wallet can afford it, so junk can't use
up the site-wide allowances. IPv6 addresses are limited by their /64, and a forwarded
`127.0.0.1` no longer skips the limits (only requests made on the machine itself do).

## Running on a VPS

See [deploy/README.md](deploy/README.md): one setup script, systemd services that
restart on crash and boot, HTTPS via Caddy (or a Vercel front door), a firewall, and daily
encrypted backups. The live setup runs both networks on one server: the testnet site and
distributors from the app folder, and the mainnet site (`reflect-mainnet-factory`) from
`mainnet/` with its own config, launches and keys; each Vercel project forwards to its site
over a secret path plus an `X-Origin-Auth` header secret Caddy checks, **over HTTPS all the way** (since 24 Oct 2026): the server answers the
secret path only over HTTPS as its own name (`ORIGIN_HOST`, by default `<IP with
dashes>.sslip.io`) with a certificate Caddy renews itself, and `vercel-deploy.sh` refuses an
`http://` backend. The testnet services can't read the mainnet folder (systemd
`InaccessiblePaths`), although every service runs as the same user. Both sites run the Tax Vault crank; the distributor services on both
networks are disabled (their tokens moved to the vault).

## Commit hook

Once per clone, `git config core.hooksPath .githooks`: the pre-commit hook then refuses any
staged file holding a JSON array of 64 bytes (a Solana secret key, whatever the file is called).

## Tests

```bash
npm test          # 157 tests: allocation, eligibility, CPMM/impact maths, pairs, trades, curve maths, curve tokens on the Tax Vault, holder-pass and tax-vault trees, vault layouts, CIDs, fallback maths, list verification (publisher quorum), Spanish coverage, IPFS gateways, the served recovery page matching its pin, program error texts in step with the Rust, crank rent rules, receipt freshness
cargo test -p bonding_curve --manifest-path lp-locker/Cargo.toml
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
| `scripts/payout-token-rehearsal.ts` | Tax Vault v4 payout tokens: a launch paying holders in another token (init_vault_payout), the site's checks (a freeze-authority token, XNT and a non-token refused), the crank swapping the holders' XNT into the token and paying it (each holder's balance = its list amount), an XNT pay refused, stats valued in XNT, a visitor's run; then a launch paying in XNM, the creator reward token (one shared account: the creator gets only its part, holders are paid) |
| `scripts/mainnet-v4-rehearsal.ts` | The v3 → v4 upgrade on a local copy of mainnet: the deployed v3 program and Test's live vault cloned, extend + deploy as in the runbook, Test still paid in XNT, a new launch paying holders in USDC.X (also the creator reward) |
| `scripts/mainnet-vault-rehearsal.ts` | The mainnet rollout on a local copy of mainnet: deploy, Test migrated, USDC.X creator reward, payouts, a visitor's run, a new launch paying the fee in USDC.X |
| `scripts/build-recovery.ts --short-windows` | The recovery page, driven in a real browser with a test wallet: on testnet a stranger's wallet ran CUP's due steps (collect, sell, liquidity, creator reward) and earned the crank reward; on a local validator holding a copy of CUP's vault under the short-windows program, the guardian appointed a new publisher and a stranger paid holders with `pay_fallback` from the IPFS list |
| `scripts/publisher-quorum-rehearsal.ts` | The publisher quorum: the site with a plain key, then a 2-of-3 Squads multisig set up by `scripts/setup-publisher-quorum.ts` and made the publisher; the site's proposals, a co-signer rejection and a new list, the co-signer's approval, execution and payouts; a malicious list and a publisher change proposed by the site's key alone rejected by the co-signer and never on-chain, the recovery clocks unmoved |

Use the solana 3.x CLI and test validator for the program upgrade tests: the older 2.1
test validator rejects `solana program extend`, which X1 testnet (solana-core 4.x)
accepts.

The product video and tutorial are recorded from the live site by `scripts/video-tour.ts`;
the narration and how to run it are in [docs/VIDEO-SCRIPT.md](docs/VIDEO-SCRIPT.md).

## Verified vs. not yet verified

**Live on mainnet:** the launchpad, the `lp_locker` program and, since 1 Oct 2026, the
`tax_vault` program v3 as a marked beta (each deployed from a build checked byte-for-byte
against the rehearsed one; `tax_vault` sha256 `25e9881f…`, upgrade authority the team
wallet until the Squads multisig). The first real launch ("Test") ran on its distributor
for its first days, then moved onto the vault (`scripts/migrate-to-vault.ts`): within
minutes the site's crank collected, burned, sold, added liquidity and sent the creator
reward in USDC.X to the lock NFT, its first rewards list was pinned and published, and the
vault paid holders after the 10-minute window; the retired distributor wallet paid what it
still owed and was swept. The whole rollout was rehearsed first on a local copy of mainnet
(`scripts/mainnet-vault-rehearsal.ts`). The mainnet recovery page is pinned to IPFS and
served at `/recovery`. Lock NFT receipts are printed as a PNG + metadata JSON on IPFS so
wallets and explorers can show them.

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
runs the crank on a schedule with its own wallet. Also live: a
creator's collect-fees and metadata updates with a real wallet, and the faucet. **Agent launches**
(27 Oct 2026, ahead of deploying `/agents`): a launch with the launcher (`src/agents/launch.mjs`) against
the live testnet site, vault-enabled, confirmed every step: token, pool, lock, start the tax vault,
register (VCHK, `4M3hjqXw…9diG`). The person approved it from the check output; a fresh agent following
the skill stopped for that approval and refused a forwarded one. Its first payout cycle ran on the
live crank: after test trades, the list was built, pinned to Pinata and published, and 11 minutes
later the holder was paid exactly its list amount (0.035682435 XNT).

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
still upgradeable by the team; the upgrade key moves to a Squads multisig next); new
mainnet launches on the vault (reopening shortly); payout tokens (v4) on mainnet (live on testnet since 1 Oct 2026; mainnet stays on v3 until
then); a second, independent IPFS pin of the rewards lists and the recovery page (today
they're pinned on one Pinata account, readable through any gateway); a JACK-paired launch on mainnet itself;  the bonding curve on
mainnet; an agent launch on mainnet (launches are paused there); trustless holder payouts (lists are published by one key; see
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
