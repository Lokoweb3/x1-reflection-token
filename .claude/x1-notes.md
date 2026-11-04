# X1 notes for auditors

Facts about X1 as this repo uses it. Written 2026-11-02 at commit `dc947ea`.

Each fact says where it came from:

- **[repo]**: code or docs in this repo
- **[live]**: read from the public RPC on 2026-11-02; can change
- **[docs]**: docs.x1.xyz
- **UNVERIFIED**: not confirmed by any of these

## Networks

| | Mainnet | Testnet |
|---|---|---|
| RPC [repo, docs] | `https://rpc.mainnet.x1.xyz` | `https://rpc.testnet.x1.xyz` |
| Genesis hash [live] | `4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN` | `C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho` |
| RPC version [live] | `solana-core 4.0.3`, feature-set `2137973216` | same |
| Slots per epoch [live] | 216,000 | **500** |
| Site | https://99tax.vercel.app | https://99tax-testnet.vercel.app |

- Mainnet ran about 2.7 slots/s in one 60-second sample, or about 366 ms per slot and 22 h per epoch [live].
- Testnet epochs last minutes, so epoch-dependent behaviour (such as a scheduled transfer fee) goes live far faster there than on mainnet [live].
- A new blockhash had 149 blocks of validity left [live].
- Public RPC limits per IP on mainnet: 300 requests/5 s, 150,000/hour, 40 `sendTransaction` + `simulateTransaction`/5 s, 30 connections [docs]. The repo spaces requests and retries on 429 (README "RPC and rate limits").

## Program IDs

Our programs share the same ID on both networks where both are deployed. Only the build features differ.

| Program | Mainnet | Testnet | Upgrade authority [live] |
|---|---|---|---|
| `tax_vault` | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` (v3 beta) | same ID | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` |
| `tax_vault` holder-pass trial | not deployed [live] | `Aqt57qzgBy9cJLiygL6V8fHK7Sov7DwXeQFAm8aphxc8` | `53fT…` |
| `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` | same ID | `53fT…` |
| `bonding_curve` | not deployed [live] | `CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY` | `53fT…` |
| XDEX | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` | `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` | mainnet `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY`, testnet `EogcepbZTPwPRQv6FCdViMjLwoFbrPy2i4NKv3zersvP` (third party, owner UNVERIFIED) |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | same | mainnet `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7`, upgradeable, owner UNVERIFIED |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | same | mainnet: none (immutable) |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | same | `BPFLoader2`, not upgradeable |
| Address Lookup Table | `AddressLookupTab1e1111111111111111111111111` | same | mainnet: none (immutable) |
| Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | same | `BPFLoader2`, not upgradeable |
| Squads v4 [repo: `src/squads.ts`] | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` | `DDL3Xp6ie85DXgiPkXJ7abUyS2tGv4CGEod2DeQXQ941` | not checked |

- Authorities for Token-2022, SPL Token and the lookup table program were read on mainnet only. Their testnet authorities are UNVERIFIED.
- Whether the Token-2022, SPL Token and lookup table binaries match upstream Solana is UNVERIFIED. On mainnet, SPL Token was last deployed at slot 85,798,112 and the lookup table program at slot 43,462,112 [live].

Fixed per network in `tax_vault` [repo: `lib.rs:79-86`]:

| | Mainnet | Testnet |
|---|---|---|
| Creator reward mint | USDC.X `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` (6 decimals) | XNM `AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ` (9 decimals) |
| Reward pool | `CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR` | `6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA` |

Build features [repo]: default is mainnet, `testnet` selects testnet XDEX and reward constants, `passes-testnet` selects the trial ID, and `short-windows` is for local tests only. Nothing in the code stops a `testnet` or `short-windows` build being deployed to mainnet; the hash check in `docs/REVIEW.md` is the control. The docs pin cargo-build-sbf **3.1.15** for reproducible hashes.

## XNT

- XNT is the native coin. It has 9 decimals: the code treats it as lamports (`toBaseUnits(x, 9)`) [repo] and the wrapped mint `So11111111111111111111111111111111111111112` reports 9 decimals [live]. The X1 docs pages checked don't state this.
- **Holders are paid in native lamports**: a system transfer from the `auth` PDA (`pay_from_auth`, `lib.rs:2188`). wXNT exists only briefly: each swap or deposit opens `auth`'s wXNT account and closes it in the same instruction.
- Payout-token vaults (testnet only; v4 is not on mainnet) swap the holders' XNT into a chosen token. `holders_funded`, `holders_paid`, list totals and `PaidRecord.paid` are then in that token's units.

## XDEX

A Raydium CP-swap fork, per `src/xdex.ts:2` [repo]. Its source isn't in this repo, so its behaviour beyond what's below is UNVERIFIED.

- **Pricing:** constant product. Trade fee is in millionths and rounded up (`lib.rs:2376`). Reserves are the vault balance minus protocol and fund fees (`lib.rs:2292`).
- **Pool layout:** `PoolState` is exactly 637 bytes; `AmmConfig` exactly 236 bytes with the trade fee as a u64 at offset 12 (`lib.rs:145-148`, `2171`, `2250-2267`). Other pool offsets are hard-coded: status 329, LP supply 333, fees 341-372. A layout change would stop the vault until the program is upgraded.
- **Status bits:** 1 = deposits paused, 4 = swaps paused (`lib.rs:150-151`).

| AMM config [live] | Trade fee | Protocol | Fund | Create-pool fee |
|---|---|---|---|---|
| Mainnet `2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c` | 2800 (0.28%) | 250000 | 50000 | 0.1 XNT |
| Testnet `3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY` | 3000 (0.30%) | 120000 | 70000 | 0.13 XNT |

- These are the reward pools' configs. `bonding_curve` hard-codes the same two configs for its pools; other pools can use other configs.
- That the protocol and fund rates are shares of the trade fee (as in Raydium) is UNVERIFIED for XDEX.
- XDEX pool transfer-hook support: UNVERIFIED from the repo. The mint whitelist rejects hook mints anyway (`lib.rs:2101`).

## Tax split and vesting

**Mint rules enforced on-chain** (`check_vault_mint`, `lib.rs:2095`):

- Token-2022, with only the TransferFee and metadata extensions
- no freeze authority and no fee-config authority
- fee of 1-9,999 bps with no maximum fee, checked separately for the older and newer schedule, so the two rates can differ
- the withdraw-withheld authority is the `auth` PDA

The 1-10% tax range and the revoked mint authority are enforced only in the launch flow (`src/factory/launch.ts`). The program does not check either.

**Split of each `collect`** (`lib.rs:2327`, `2344`):

| Share | Rule | Handling |
|---|---|---|
| Burn | 0-50% | burned at collect |
| Auto-LP | 0-50%, and burn + LP ≤ 55% | half kept as tokens, half sold for XNT; LP tokens received are burned |
| Creator | fixed 10% | sold for XNT, swapped to the reward token, deposited in `lp_locker` |
| Holders | the remainder, at least 35% | sold for XNT; the seller earns 1% of the holders' part, at most 0.05 XNT |

Each share is rounded down, and the rounding goes to holders. Sale proceeds are split pro-rata to the tokens taken, with rounding again to holders.

**Vesting** (`lp_locker/src/lib.rs:68-75`): each deposit vests for 7 days, grouped into 1-day buckets, with `TRANCHES = 10`. Only the holder of the lock NFT can claim. `short-vest` is for local tests only.

## Vault crank cycle

Shared steps are in `src/vault-crank.ts`. Every money-moving step except publishing is permissionless.

1. `upgrade_vault`: once, for a v1 or v2 vault.
2. `collect`: when waiting tax is worth at least `minHarvest`. Harvests and withdraws, burns, and books the buckets.
3. `sell`: on-chain impact cap of `min(3%, tax/2)`, minimum output is expected × 99.5%, one sale per slot, skipped if expected output is under 0.002 XNT.
4. `add_liquidity`: needs at least 0.01 XNT set aside. LP tokens are burned.
5. `fund_creator`: impact cap of `min(3%, trade_fee/2)`, one swap per slot.
6. `fund_holders`: payout-token vaults only; shares that per-slot limit.
7. Lists: built off-chain from a live balance scan, pinned to IPFS, then `publish_list`. Only the publisher can publish. A list goes live after **600 s**, during which the guardian can cancel, at most **2 in a row**. The site publishes one list at a time, when new XNT is at least `minCycle` or the vault is in fallback (`src/factory/vault.ts:705`, `731`).
8. `pay`: `pay` / `pay_token` against the Merkle list.
9. `pay_fallback`: after **30 days** without a publish. The guardian can appoint a new publisher after **7 days** without one. Neither clock counts a publisher that is alive but has nothing to publish.

The site crank runs a pass every 60 s (`TAX_VAULT_PASS_SECS`, `src/factory/vault.ts:69`).

**Invariants** (`lib.rs:34-37`, `2010-2028`, `docs/tax-vault-spec.md:110`, `783`):

- `auth` lamports ≥ `xnt_lp + xnt_creator + owed + rent reserve`. `owed` is `holders_funded − holders_paid` for an XNT vault, or `xnt_holders` for a payout-token vault.
- `auth`'s token account ≥ the sum of the token buckets.
- A payout-token vault's payout account ≥ `holders_funded − holders_paid`.
- List total can't decrease and can't exceed `holders_funded`; it must also be at least `holders_paid`.
- `pay` never takes total paid above `list_total`. Fallback payments can, up to `holders_funded`.
- A wallet's paid amount only rises (`PaidRecord`), so repeating a payment can't pay twice.
- Not enforced on-chain: that each wallet keeps its previous total between lists. This is an off-chain trust assumption (`docs/REVIEW.md`, finding B).

Live keys on TEST, mainnet [live]: publisher `8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb` (a single key, no quorum), guardian `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`. No instruction changes the guardian.

TEST's addresses, derived from the program's seeds and checked on 2026-11-02 [live]:

- Mint `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz`: mint and freeze authorities not set, 5% tax with no maximum, fee config authority not set.
- `auth` PDA `["auth", mint]`: `CWRTWvYTBv3uUkBmLQtp3rXCqM1BQ5nYvoW7XScWuTZS`, bump 255. It is the mint's withdrawal authority.
- `vault` PDA `["vault", mint]`: `CeUD11HkZm6MwMaDtHyDUp83VV1wYzsMCCHKbtZQ92mr`, bump 254.
- `auth` held 0.695312891 XNT, exactly the required total of owed + `xnt_lp` + rent reserve. Balance and buckets were read at different moments that day.

The upgrade authority `53fT…` is a single key, with a move to Squads pending. Until then it can replace the program, and new code could sign as `auth` and move everything it holds. The PDA addresses themselves wouldn't change.

## Backup crank (`.github/workflows/crank.yml`)

- Scheduled every 10 minutes, one job at a time, 9-minute timeout. Runs `scripts/crank.ts --all`.
- Never publishes lists, because it has no `--publisher` key. It can still pay from a list file fetched from IPFS and checked against the on-chain root.
- Running alongside the server crank can't double-pay, since the chain state blocks it. Most races show up as failed simulations. The exception: a `pay_fallback` that lands while a list is being built can leave that list over-allocated (`src/vault-crank.ts:582-606`).
- **Doesn't cover mainnet as configured.** It defaults to the testnet RPC and `gh variable list` showed no `CRANK_RPC` on 2026-11-02. The `CRANK_KEYPAIR` secret is set.
- **Runs less often than scheduled.** The last three runs were hours apart (2026-11-01 22:54 UTC, 2026-11-02 02:09, 09:30), though the workflow only warns of "a few minutes" of delay.

## Differences from Solana mainnet

**Fees: billed on requested compute units.**

- Eight recent TEST vault transactions all fit `fee = 10 lamports × requested CU + priority fee + 3,001 lamports` exactly, with consumed CU lower than requested in each [live]. That matches the repo's "about 0.01 XNT per million requested" (`src/tx.ts:26`, `deploy/README.md:23`).
- `sign` and `signV0` therefore shrink the limit to what simulation uses plus 20% and 3,000 CU, so the fixed limits at `src/vault-crank.ts` call sites are upper bounds (`src/tx.ts:32`, `56`, `65`).
- The docs describe dynamic base fees that scale with congestion and a multiplier, against Solana's fixed 5,000 lamports, and cite 48M CU per block [docs]. They give no formula or multiplier values in text, and their wording suggests consumed CU, which the transactions above don't match. Behaviour under congestion is UNVERIFIED.
- Votes are free for validators [docs].

**Rent: same values as Solana's defaults.**

- 0 bytes = 890,880 lamports; 81 bytes (`PaidRecord`) = 1,454,640 lamports [live]. `RENT_EXEMPT_EMPTY` matches (`src/taxvault.ts:47`).
- "Prevent crediting rent paying accounts" reads as active, so a transfer leaving a new account under the minimum should fail [live]. Not tested directly on X1.

**Transaction limits.**

- The repo assumes 64 accounts per transaction (`src/passes.ts:37`) and 1,232 bytes (`src/vault-crank.ts:319`).
- "Increase tx account lock limit to 128" reads as inactive [live], consistent with 64.

**Program loaders.** SPL Token and the lookup table program sit under the upgradeable loader with no authority, and Token-2022 under it with an authority [live]. Whether those binaries differ from Solana's is UNVERIFIED.

**Feature gates.**

- `solana feature status` from CLI 2.1.0 shows 161 active and 48 inactive, identical on both networks [live].
- **Treat that list with care.** A 2.1.0 CLI doesn't know newer features, and a gate can read inactive while its effect is present. For example, the lookup table's Core BPF migration reads inactive, yet the program is under the upgradeable loader. A 4.x client may also hard-code gates it considers settled.
- Read as active and relevant here: versioned transactions, account data reallocation.
- Read as inactive and possibly relevant: "loosen cpi size restrictions", "Disable rent fees collection".
- Whether X1's gates differ from Solana mainnet's: UNVERIFIED; not compared.
- Used by the code: `sol_get_stack_height` (`lib.rs:1111`, `1399`), lookup table CPI (`lib.rs:1319-1345`) and `AccountInfo::resize` (`lib.rs:915`, `1075`). The first two are in the holder-pass path, which is on testnet only and which the README says is live there. Neither has run on mainnet. `resize` in `upgrade_vault` is also part of the live v3 program.

**Validator client.**

- Docs name the client **Tachyon** and quote `tachyon-validator 2.0.21` on a testnet upgrade page [docs]. The RPC now reports `solana-core 4.0.3` on both networks [live].
- Which client runs today, and which Agave version it's based on: UNVERIFIED. `getVersion` doesn't name the client.
- The docs call X1 "fully SVM/Solana compatible" but list no differences beyond the above [docs].

**Still UNVERIFIED:** priority-fee behaviour under load (recent samples showed 0), whether any private or staked transaction path exists, slot time under congestion, and who controls the Token-2022 and XDEX upgrade keys.

## Sources

- [X1 docs home](https://docs.x1.xyz/)
- [Docs index](https://docs.x1.xyz/llms.txt)
- [Dynamic base fees](https://docs.x1.xyz/technicals/dynamic-base-fees.md)
- [RPC rate limits](https://docs.x1.xyz/build-on-x1/rpc-rate-limits.md)
- [Tachyon 2.0](https://docs.x1.xyz/validating/network-upgrades/tachyon-2.0.md)
- [Builder resources](https://docs.x1.xyz/build-on-x1/resources.md)
