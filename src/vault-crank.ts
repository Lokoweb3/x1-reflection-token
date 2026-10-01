/**
 * The Tax Vault crank's steps (docs/tax-vault-spec.md), shared by the site's crank
 * (src/factory/vault.ts), the "Run the vault now" button (unsigned transactions for a
 * visitor's wallet) and the standalone scripts/crank.ts, so all three follow the same rules:
 *
 *   upgrade        a v1/v2 vault gets `upgrade_vault` once (the caller pays the extra rent)
 *   collect        when the tax waiting is worth at least minHarvest: harvest, withdraw, split, burn
 *   sell           the sell buckets, impact-capped on-chain (min(3%, tax/2)), one sale per slot
 *   add_liquidity  when at least 0.01 XNT is set aside
 *   fund_creator   swap the creator's XNT for the reward token (capped, one per slot) and deposit it
 *   lists          new holders' XNT is split pro-rata over eligible holders and added to each
 *                  wallet's running total, starting from max(previous total, on-chain paid), so
 *                  a new list never pays anyone less than they already got
 *   pay            every wallet the active list owes at least minPayout
 *   pay_fallback   v3, once no list was published for FALLBACK_AFTER_SECS: every wallet owed
 *                  something of its last-list share scaled up to everything funded
 *   fund_holders   payout-token vaults: swap the holders' XNT into the payout token (capped,
 *                  one swap per slot, shared with fund_creator); lists and payouts are then in
 *                  that token (pay_token / pay_fallback_token), and the XNT minimums (minCycle,
 *                  minPayout) are converted at the payout pool's price
 *
 * List files (v3) are pinned to IPFS before they're published and their CID goes on-chain,
 * so anyone can pay from them without the site: `listFileText` is the pinned bytes and
 * `parseListFile` checks a fetched file against the on-chain root. A file also carries the
 * list's inputs (snapshot slot, every eligible balance, the pot, the previous list), so a
 * co-signer (src/list-verify.ts) can recompute it with `listFromInputs`.
 */
import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { DEFAULT_MIN_HARVEST_XNT, fromBaseUnits, toBaseUnits, xnt } from "./config.js";
import { BURN_OWNERS, allocate, eligibleBalances, scanTokenAccounts, type EligibilityRules } from "./holders.js";
import { outcome, sendAndConfirm, sign, simulate, withPriority } from "./tx.js";
import { decodePool, maxLpFor, poolAuthority, quoteBuy, quoteSell, snapshot, spotValue } from "./xdex.js";
import {
  CID_CODEC, CRANK_REWARD_BPS, CRANK_REWARD_CAP, fundHoldersIx, payFallbackTokenIx, payTokenIx, paysInToken, payoutPoolAccountsFrom, MIN_LP_XNT, MIN_SELL_XNT, OUT_TOLERANCE_BPS, PAID_RECORD_DISC, PAID_RECORD_LEN, RENT_EXEMPT_EMPTY,
  VAULT_VERSION, addLiquidityIx, buildVaultTree, cidFromBytes, cidToBytes, collectIx, decodePaidRecord, decodeVault, effectiveList, errorOf, fallbackActive,
  fallbackEntitled, fundCreatorIx, paidRecordPda, parseEvents, payFallbackIx, payIx, poolAccountsFrom, publishListIx, rewardImpactBps,
  rewardPoolAccountsFrom, rewardTokenInfo, sellBuckets, sellImpactBps, sellIx, upgradeVaultIx, vaultAuthPda, vaultPda,
  type Vault, type VaultEvent, type VaultPoolAccounts,
} from "./taxvault.js";

/** Most harvest accounts one collect carries (also capped by transaction size). */
export const MAX_HARVEST_PER_TX = 20;
/** Sales per token per pass; each is capped at 3% price impact on-chain. */
export const MAX_SELLS_PER_PASS = 3;
export const MAX_PAYS_PER_TX = 6;
/** Pay transactions per token per pass, so one big list can't hold up the others. */
export const MAX_PAY_TXS_PER_PASS = 20;
/** Seconds of margin around on-chain times (the chain clock can lag ours). */
export const ACTIVATION_MARGIN_SECS = 15;
/** fund_creator calls per token per pass (each capped at half the reward pool's fee, one per slot). */
export const MAX_REWARD_SWAPS_PER_PASS = 5;
/** After a failed upgrade_vault (e.g. the program isn't upgraded yet), wait this long before trying again. */
const UPGRADE_RETRY_MS = 10 * 60_000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nowSecs = () => Math.floor(Date.now() / 1000);

// ---------- rules ----------
/** A token's payout rules (the distributor's), in base units. */
export interface CrankRules {
  /** Collect only when the tax waiting is worth this much XNT (lamports). */
  minHarvest: bigint;
  /** Pay a wallet only when it's owed at least this (lamports). */
  minPayout: bigint;
  /** Publish a new list only when at least this much new XNT is waiting (lamports). */
  minCycle: bigint;
  /** Smallest balance that earns (token base units). */
  minHolding: bigint;
  /** Wallets that never earn, besides the burn addresses, the vault's auth and the pool. */
  excludeOwners: string[];
  /** Off-curve owners (programs, PDAs) don't earn. */
  excludeOffCurve: boolean;
}
/** The rules as pinned with each list file (amounts as base-unit strings). */
export interface RulesJson { minHarvest: string; minPayout: string; minCycle: string; minHolding: string; excludeOwners: string[]; excludeOffCurve: boolean }
export const rulesJson = (r: CrankRules): RulesJson => ({
  minHarvest: r.minHarvest.toString(), minPayout: r.minPayout.toString(), minCycle: r.minCycle.toString(), minHolding: r.minHolding.toString(),
  excludeOwners: [...r.excludeOwners], excludeOffCurve: r.excludeOffCurve,
});
export function rulesFromJson(j: Partial<RulesJson> | undefined, fallback: CrankRules): CrankRules {
  const big = (v: unknown, d: bigint) => { try { return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : d; } catch { return d; } };
  if (!j) return fallback;
  return {
    minHarvest: big(j.minHarvest, fallback.minHarvest), minPayout: big(j.minPayout, fallback.minPayout), minCycle: big(j.minCycle, fallback.minCycle),
    minHolding: big(j.minHolding, fallback.minHolding),
    excludeOwners: Array.isArray(j.excludeOwners) ? j.excludeOwners.filter((w) => { try { return !!new PublicKey(w); } catch { return false; } }) : fallback.excludeOwners,
    excludeOffCurve: typeof j.excludeOffCurve === "boolean" ? j.excludeOffCurve : fallback.excludeOffCurve,
  };
}
/**
 * The site's defaults (config.example.json's distribution; a launch's minimum holding is a
 * millionth of its supply) for a token whose list file carries no rules.
 */
export const defaultRules = (supply: bigint): CrankRules => ({
  minHarvest: toBaseUnits(DEFAULT_MIN_HARVEST_XNT, 9), minPayout: toBaseUnits("0.001", 9), minCycle: toBaseUnits("0.01", 9),
  minHolding: supply / 1_000_000n, excludeOwners: [], excludeOffCurve: true,
});
/**
 * Who earns: the rules' exclusions plus the burn addresses, the vault's auth PDA, XDEX's pool
 * authority and `also` (the publisher, e.g. a multisig vault).
 */
export const eligibilityFor = (rules: CrankRules, auth: PublicKey, xdex: PublicKey, also: string[] = []): EligibilityRules => ({
  excluded: new Set([...rules.excludeOwners, ...BURN_OWNERS, auth.toBase58(), poolAuthority(xdex).toBase58(), ...also]),
  excludeOffCurve: rules.excludeOffCurve, minHolding: rules.minHolding,
});

/** The publisher among the excluded wallets when it's a PDA (a multisig vault); none for a plain key. */
export const publisherExclusion = (publisher: PublicKey) => (PublicKey.isOnCurve(publisher.toBytes()) ? [] : [publisher.toBase58()]);

// ---------- list files ----------
/**
 * What a list was computed from (docs/tax-vault-spec.md "Lists carry their inputs"); amounts
 * are base-unit strings, pairs sorted by wallet. `listFromInputs` recomputes the entries.
 */
export interface ListInputsJson {
  /** Slot the balances were read at. */
  slot: string;
  /** The vault's holders_funded the pot was taken from. */
  holdersFunded: string;
  /** max(list_total, pending_total, holders_paid) when built: the total is topped up to it. */
  floor: string;
  /** New XNT split pro-rata over `balances`: holdersFunded − Σ start. */
  pot: string;
  /** The list this one builds on (its entries are every wallet's start), or null for the first. */
  prev: { epoch: string; root: string; cid: string | null } | null;
  /** On-chain PaidRecords above the previous list's amount (after a fallback; usually empty). */
  paid: [string, string][];
  /** Every eligible wallet's balance used (token base units). */
  balances: [string, string][];
}
/** A published list's file, as pinned to IPFS (entries sorted by wallet). */
export interface ListFileJson {
  version: 1;
  mint: string;
  vault: string;
  epoch: string;
  root: string;
  total: string;
  entries: [string, string][];
  rules?: RulesJson;
  inputs?: ListInputsJson;
}
const byWallet = <T>([x]: [string, T], [y]: [string, T]) => (x < y ? -1 : x > y ? 1 : 0);
/** The exact bytes pinned for a list (its CID addresses these). */
export function listFileText(a: { mint: string; vault: string; epoch: string; root: string; total: string; wallets: Record<string, string>; rules?: RulesJson; inputs?: ListInputsJson }) {
  const entries = Object.entries(a.wallets).sort(byWallet);
  const f: ListFileJson = { version: 1, mint: a.mint, vault: a.vault, epoch: a.epoch, root: a.root, total: a.total, entries, ...(a.rules ? { rules: a.rules } : {}),
    ...(a.inputs ? { inputs: a.inputs } : {}) };
  return JSON.stringify(f);
}
/**
 * Read a list file fetched from IPFS and check it is the list the vault has on-chain: same
 * vault, and its entries give `root`. For a raw-codec CID the bytes' sha256 must also match.
 */
export function parseListFile(bytes: Buffer, vault: PublicKey, root: Buffer, cid?: Buffer) {
  if (cid && cid[0] === CID_CODEC.raw && !crypto.createHash("sha256").update(bytes).digest().equals(cid.subarray(1))) {
    throw new Error("The list file's bytes don't match its CID");
  }
  const f = JSON.parse(bytes.toString("utf8")) as ListFileJson;
  if (f.vault !== vault.toBase58()) throw new Error("The list file is for another vault");
  if (!Array.isArray(f.entries)) throw new Error("The list file has no entries");
  const wallets: Record<string, string> = {};
  for (const [w, c] of f.entries) {
    new PublicKey(w); // throws on a bad address
    if (!/^\d+$/.test(String(c))) throw new Error("Bad amount in the list file");
    wallets[w] = String(c);
  }
  if (!buildVaultTree(vault, wallets).root.equals(root)) throw new Error("The list file doesn't match the on-chain root");
  return { file: f, wallets };
}

// ---------- building a new list ----------
/**
 * The next list's totals: every wallet starts at max(its previous total, what it was paid
 * on-chain), then gets its share of the new XNT. If rounding (or a list rebuilt from paid
 * records) would leave the total under `floor` (max(list_total, holders_paid)), the
 * difference goes to the wallet with the largest share, so the program's
 * `total >= max(list_total, holders_paid)` holds and nobody drops below what they got.
 */
export function composeList(prev: Record<string, string> | null, paid: Map<string, bigint>, shares: Map<string, bigint>, floor: bigint) {
  const start = new Map<string, bigint>();
  for (const [w, c] of Object.entries(prev ?? {})) start.set(w, BigInt(c));
  for (const [w, p] of paid) if (p > (start.get(w) ?? 0n)) start.set(w, p);
  const wallets = new Map(start);
  let allocated = 0n;
  for (const [w, x] of shares) { wallets.set(w, (wallets.get(w) ?? 0n) + x); allocated += x; }
  let total = 0n;
  for (const x of wallets.values()) total += x;
  if (total < floor && wallets.size) {
    // Ties go to the smaller address, so anyone recomputing the list gets the same one.
    const pick = [...(shares.size ? shares : wallets).entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
    const add = floor - total;
    wallets.set(pick, wallets.get(pick)! + add);
    allocated += add; total = floor;
  }
  const out: Record<string, string> = {};
  for (const [w, x] of wallets) if (x > 0n) out[w] = x.toString();
  return { wallets: out, total, allocated, startTotal: [...start.values()].reduce((a, b) => a + b, 0n) };
}

/**
 * A list's entries recomputed from its inputs and the previous list's entries (`prev`, null
 * for the first list or a rebuild): the same composeList / allocate the builder runs.
 */
export function listFromInputs(prev: Record<string, string> | null, inputs: ListInputsJson) {
  const paid = new Map(inputs.paid.map(([w, x]) => [w, BigInt(x)] as [string, bigint]));
  const balances = new Map(inputs.balances.map(([w, x]) => [w, BigInt(x)] as [string, bigint]));
  return composeList(prev, paid, allocate(balances, BigInt(inputs.pot)), BigInt(inputs.floor));
}

/**
 * `lamports` of XNT in the unit the vault pays holders in: itself for an XNT vault, else
 * payout-token base units at the payout pool's spot price (at least 1 for a non-zero amount),
 * so the XNT minimums (minPayout, minCycle) mean the same for every vault.
 */
export async function xntInPayout(conn: Connection, xdex: PublicKey, v: Vault, lamports: bigint) {
  if (!paysInToken(v) || lamports === 0n) return lamports;
  const pool = decodePool(v.payoutPool, (await conn.getMultipleAccountsInfo([v.payoutPool], "confirmed"))[0], xdex);
  const p = payoutPoolAccountsFrom(xdex, pool);
  const snap = await snapshot(conn, xdex, v.payoutPool, p.payoutMint);
  const units = (lamports * snap.reserveToken) / snap.reserveQuote;
  return units > 0n ? units : 1n;
}
/** The payout pool's accounts of a payout-token vault. */
export async function payoutAccountsOf(conn: Connection, xdex: PublicKey, v: Vault) {
  return payoutPoolAccountsFrom(xdex, decodePool(v.payoutPool, (await conn.getMultipleAccountsInfo([v.payoutPool], "confirmed"))[0], xdex));
}

/** Every PaidRecord of a vault: wallet -> cumulative paid (in the vault's payout unit). */
export async function readPaidRecords(conn: Connection, program: PublicKey, vault: PublicKey) {
  const raw = await conn.getProgramAccounts(program, {
    commitment: "confirmed",
    filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 0, bytes: bs58.encode(PAID_RECORD_DISC) } }, { memcmp: { offset: 8, bytes: vault.toBase58() } }],
  });
  const out = new Map<string, bigint>();
  for (const { pubkey, account } of raw) {
    const r = decodePaidRecord(pubkey, account.data);
    out.set(r.wallet.toBase58(), r.paid);
  }
  return out;
}
/** A wallet owed something by a list (normal pay or fallback). */
export interface Due { wallet: PublicKey; cumulative: bigint; owed: bigint; recordExists: boolean }
/**
 * Wallets `wallets` (a list's totals) owes: cumulative − paid, or in fallback
 * fallbackEntitled − paid. `minPayout` skips small amounts; a wallet with no account must be
 * owed at least the rent-exempt minimum (the program refuses less). Largest first.
 */
export async function dueFrom(conn: Connection, program: PublicKey, v: Vault, wallets: Record<string, string>, opts: { fallback: boolean; minPayout: bigint; listTotal: bigint }) {
  const entries = Object.entries(wallets).map(([w, c]) => ({ wallet: new PublicKey(w), cumulative: BigInt(c) }));
  const due: Due[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    const [records, accounts] = await Promise.all([
      conn.getMultipleAccountsInfo(chunk.map((e) => paidRecordPda(program, v.address, e.wallet)), "confirmed"),
      conn.getMultipleAccountsInfo(chunk.map((e) => e.wallet), "confirmed"),
    ]);
    chunk.forEach((e, j) => {
      const info = records[j];
      const exists = !!info && info.owner.equals(program);
      const paid = exists ? decodePaidRecord(paidRecordPda(program, v.address, e.wallet), info!.data).paid : 0n;
      const target = opts.fallback ? fallbackEntitled(e.cumulative, v.holdersFunded, opts.listTotal) : e.cumulative;
      const owed = target - paid;
      // An XNT payout to a wallet with no account must cover its rent; a token payout opens the wallet's token account.
      if (owed > 0n && owed >= opts.minPayout && (paysInToken(v) || accounts[j] || owed >= RENT_EXEMPT_EMPTY)) due.push({ ...e, owed, recordExists: exists });
    });
  }
  return due.sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : 0));
}

/** A mint's vault account (any version), or null if it has none. */
export async function readVaultAccount(conn: Connection, program: PublicKey, mint: PublicKey): Promise<Vault | null> {
  const addr = vaultPda(program, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(program)) return null;
  return decodeVault(addr, info.data);
}

// ---------- the crank ----------
export interface CrankEnv {
  conn: Connection;
  program: PublicKey;
  xdex: PublicKey;
  network: "mainnet" | "testnet";
  /** Signs and pays every transaction (and earns the crank rewards). */
  signer: Keypair;
  microLamports: number;
  /** Log prefix, e.g. "[vault crank]". */
  tag?: string;
  /** Every confirmed transaction with its events (the site appends them to the token's log). */
  onTx?: (t: CrankToken, v: Vault, signature: string, events: VaultEvent[]) => void;
}
export interface CrankToken { mint: PublicKey; symbol: string; taxBps: number; rules: CrankRules }
/** A list the crank can pay from: its on-chain root and every wallet's total. */
export interface PayList { root: string; wallets: Record<string, string> }

export function vaultCrank(env: CrankEnv) {
  const { conn, program, xdex, signer } = env;
  const tag = env.tag ?? "[vault crank]";

  const readVault = (mint: PublicKey) => readVaultAccount(conn, program, mint);

  function fits(ixs: TransactionInstruction[]) {
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(...withPriority(ixs, env.microLamports, 1_400_000));
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  }

  /** The program's events for `vault` in a confirmed transaction (a few tries: RPCs lag). */
  async function eventsOf(signature: string, vault: PublicKey): Promise<VaultEvent[] | null> {
    for (let i = 0; i < 5; i++) {
      if (i) await sleep(2_000);
      const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (tx?.meta) return parseEvents(tx.meta.logMessages ?? [], program).filter((e) => e.vault === vault.toBase58());
    }
    return null;
  }

  async function send(t: CrankToken, v: Vault, label: string, ixs: TransactionInstruction[], units: number) {
    const signed = await sign(conn, withPriority(ixs, env.microLamports, units), signer);
    try {
      await simulate(conn, signed.tx);
    } catch (e) {
      const name = errorOf(msg(e));
      throw new Error(name ? `${label}: ${name}` : `${label}: ${msg(e).split("\n")[0]}`);
    }
    try {
      await sendAndConfirm(conn, signed);
    } catch (e) {
      // A slow confirmation can look like a failure; only a transaction that didn't land is one.
      if ((await outcome(conn, signed.signature, signed.lastValidBlockHeight).catch(() => "pending")) !== "confirmed") throw e;
    }
    console.log(`${tag} ${t.symbol} ${label}: ${signed.signature}`);
    const events = (await eventsOf(signed.signature, v.address)) ?? [];
    env.onTx?.(t, v, signed.signature, events);
    return { signature: signed.signature, events };
  }

  /** Retries `fn` when the program says the last sale / reward swap's slot hasn't passed. */
  async function perSlot<T>(fn: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); } catch (e) {
        if (!/OneSellPerSlot/.test(msg(e)) || attempt >= 3) throw e;
        await sleep(800);
      }
    }
  }

  /** A v1/v2 vault: send upgrade_vault once (the signer pays the extra rent). */
  const upgradeFailedAt = new Map<string, number>();
  async function upgrade(t: CrankToken, v: Vault, notes: string[]) {
    if (v.version >= VAULT_VERSION) return v;
    const key = t.mint.toBase58();
    const last = upgradeFailedAt.get(key);
    if (last && Date.now() - last < UPGRADE_RETRY_MS) { notes.push(`vault still v${v.version} (upgrade retried later)`); return v; }
    try {
      await send(t, v, "upgrade_vault", [upgradeVaultIx(program, signer.publicKey, v.mint)], 60_000);
      upgradeFailedAt.delete(key);
      notes.push(`vault upgraded to v${VAULT_VERSION}`);
    } catch (e) {
      upgradeFailedAt.set(key, Date.now());
      throw e;
    }
    return (await readVault(v.mint)) ?? v;
  }

  async function poolOf(v: Vault) {
    const [info] = await conn.getMultipleAccountsInfo([v.pool], "confirmed");
    return poolAccountsFrom(xdex, decodePool(v.pool, info, xdex), v.mint);
  }

  /** Token accounts holding withheld tax (largest first) and the whole tax waiting, in tokens. */
  async function taxWaiting(mint: PublicKey) {
    const [rows, mintInfo] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed")]);
    const withheld = rows.filter((x) => x.withheld > 0n).sort((a, b) => (b.withheld > a.withheld ? 1 : b.withheld < a.withheld ? -1 : 0));
    const inMint = getTransferFeeConfig(unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
    return { accounts: withheld.map((x) => x.address), waiting: withheld.reduce((a, x) => a + x.withheld, 0n) + inMint };
  }

  async function collect(t: CrankToken, v: Vault, notes: string[]) {
    const { accounts, waiting } = await taxWaiting(t.mint);
    if (waiting === 0n) return;
    // Same threshold as the distributor: don't spend fees collecting dust.
    const worth = spotValue(waiting, await snapshot(conn, xdex, v.pool, t.mint));
    if (worth < t.rules.minHarvest) { notes.push(`tax waiting ~${xnt(worth)}, under ${xnt(t.rules.minHarvest)}`); return; }
    const todo = [...accounts];
    do {
      const chunk: PublicKey[] = [];
      while (todo.length && chunk.length < MAX_HARVEST_PER_TX && fits([collectIx(program, signer.publicKey, t.mint, [...chunk, todo[0]])])) chunk.push(todo.shift()!);
      if (!chunk.length && todo.length) chunk.push(todo.shift()!);
      await send(t, v, `collect (${chunk.length} accounts)`, [collectIx(program, signer.publicKey, t.mint, chunk)], 200_000 + 15_000 * chunk.length);
      notes.push(`collected from ${chunk.length} account(s)`);
    } while (todo.length);
  }

  async function sell(t: CrankToken, pool: VaultPoolAccounts, notes: string[]) {
    for (let i = 0; i < MAX_SELLS_PER_PASS; i++) {
      const v = await readVault(t.mint);
      if (!v) return;
      const wanted = sellBuckets(v);
      if (wanted === 0n) return;
      // The program caps a sale at min(3%, tax/2) price impact; quote the same cap.
      const q = await quoteSell(conn, xdex, v.pool, t.mint, wanted, { maxImpactBps: sellImpactBps(t.taxBps), slippageBps: Number(OUT_TOLERANCE_BPS) });
      if (!q || q.expectedOut < MIN_SELL_XNT) { notes.push(`${fromBaseUnits(wanted, 9)} tokens to sell are still dust`); return; }
      // One sale per slot per vault, each confirmed before the next (never two in one transaction).
      await perSlot(() => send(t, v, `sell ~${fromBaseUnits(q.amountIn, 9)} tokens for ~${xnt(q.expectedOut)}`, [sellIx(program, signer.publicKey, t.mint, pool, wanted)], 400_000));
      notes.push(`sold for ~${xnt(q.expectedOut)}`);
      // Capped by the price-impact limit: the rest waits for the next pass instead of walking the price down now.
      if (q.amountIn < wanted) return;
    }
  }

  async function liquidity(t: CrankToken, pool: VaultPoolAccounts, notes: string[]) {
    const v = await readVault(t.mint);
    if (!v || v.xntLp < MIN_LP_XNT || v.lpTokens === 0n) return;
    await send(t, v, `add_liquidity (${xnt(v.xntLp)} set aside)`, [addLiquidityIx(program, signer.publicKey, t.mint, pool)], 400_000);
    notes.push("added liquidity");
  }

  /**
   * Swap the creator's XNT for the reward token and deposit it (fund_creator). Each swap is
   * capped on-chain at half the reward pool's trade fee, so a large bucket takes several
   * calls, one per slot, each confirmed before the next; the rest waits in xnt_creator.
   */
  async function creator(t: CrankToken, notes: string[]) {
    for (let i = 0; i < MAX_REWARD_SWAPS_PER_PASS; i++) {
      const v = await readVault(t.mint);
      if (!v || v.xntCreator === 0n) return;
      if (v.version < VAULT_VERSION) { notes.push("creator reward waits for the vault upgrade"); return; }
      const q = await creatorQuote(v);
      const info = rewardTokenInfo(env.network, v.rewardMint);
      // The program needs a minimum out (expected x 99.5%) above zero.
      if (!q || q.minimumOut <= 0n) { notes.push(`creator reward ${xnt(v.xntCreator)} would buy no ${info?.symbol ?? "reward token"} yet`); return; }
      const rewardPool = rewardPoolAccountsFrom(xdex, q.pool, v.rewardMint);
      const out = info ? `${fromBaseUnits(q.expectedOut, info.decimals)} ${info.symbol}` : `${q.expectedOut} reward base units`;
      try {
        // ~150k CU, up to ~195k when it also creates the reward vault: the default 200k is too tight.
        await perSlot(() => send(t, v, `fund_creator ${xnt(q.amountIn)} for ~${out}`, [fundCreatorIx(program, signer.publicKey, t.mint, v.creatorNft, rewardPool)], 300_000));
      } catch (e) {
        // The on-chain quote can come out smaller than ours (live reserves): wait for more.
        if (/: TooSmall$/.test(msg(e))) { notes.push(`creator reward ${xnt(v.xntCreator)} is still too small to swap`); return; }
        throw e;
      }
      notes.push(`creator reward ${xnt(q.amountIn)} -> ~${out}`);
      if (q.amountIn >= v.xntCreator) return; // all of it went
    }
  }
  /** The reward swap fund_creator would make now (same cap, live reserves); null when too small. */
  const creatorQuote = (v: Vault) => quoteBuy(conn, xdex, v.rewardSwapPool, v.rewardMint, v.xntCreator, Number(OUT_TOLERANCE_BPS), rewardImpactBps).catch((e) => {
    if (/too small|too shallow|no liquidity/i.test(msg(e))) return null;
    throw e;
  });

  /**
   * Payout-token vaults: swap the holders' XNT into the payout token (fund_holders), each
   * swap capped on-chain like the reward swap and one per slot (shared with fund_creator).
   */
  async function holders(t: CrankToken, notes: string[]) {
    for (let i = 0; i < MAX_REWARD_SWAPS_PER_PASS; i++) {
      const v = await readVault(t.mint);
      if (!v || !paysInToken(v) || v.xntHolders === 0n) return;
      const p = await payoutAccountsOf(conn, xdex, v);
      const q = await quoteBuy(conn, xdex, v.payoutPool, p.payoutMint, v.xntHolders, Number(OUT_TOLERANCE_BPS), rewardImpactBps).catch((e) => {
        if (/too small|too shallow|no liquidity/i.test(msg(e))) return null;
        throw e;
      });
      if (!q || q.minimumOut <= 0n) { notes.push(`holders' ${xnt(v.xntHolders)} would buy no payout token yet`); return; }
      try {
        await perSlot(() => send(t, v, `fund_holders ${xnt(q.amountIn)} for ~${q.expectedOut} payout units`, [fundHoldersIx(program, signer.publicKey, t.mint, p)], 300_000));
      } catch (e) {
        if (/: TooSmall$/.test(msg(e))) { notes.push(`holders' ${xnt(v.xntHolders)} is still too small to swap`); return; }
        throw e;
      }
      notes.push(`holders ${xnt(q.amountIn)} -> payout token`);
      if (q.amountIn >= v.xntHolders) return;
    }
  }

  /**
   * Pay what `list` owes (pay), or in fallback its scaled-up shares (pay_fallback), a few
   * wallets per transaction; a failed batch is retried one by one. `list` must be the list
   * the program checks (effectiveList). Returns how many wallets were paid.
   */
  async function pay(t: CrankToken, v: Vault, list: PayList, mode: "pay" | "fallback", notes: string[], opts: { due?: Due[] } = {}) {
    const eff = effectiveList(v, nowSecs());
    if (!eff || eff.root.toString("hex") !== list.root) throw new Error("the list to pay isn't the one on-chain");
    const minPayout = await xntInPayout(conn, xdex, v, t.rules.minPayout);
    let due = opts.due ?? await dueFrom(conn, program, v, list.wallets, { fallback: mode === "fallback", minPayout, listTotal: eff.total });
    if (!due.length && eff.pending && !opts.due) {
      // The program switches to a due pending list inside `pay`. If nobody is owed minPayout
      // yet, pay the largest amount owed anyway so the new list takes over and the next can follow.
      due = (await dueFrom(conn, program, v, list.wallets, { fallback: mode === "fallback", minPayout: 0n, listTotal: eff.total })).slice(0, 1);
    }
    if (!due.length) return 0;
    const { proofs } = buildVaultTree(v.address, list.wallets);
    const payout = paysInToken(v) ? await payoutAccountsOf(conn, xdex, v) : null;
    const ixOf = (d: Due) => payout
      ? (mode === "fallback" ? payFallbackTokenIx : payTokenIx)(program, signer.publicKey, t.mint, d.wallet, d.cumulative, proofs[d.wallet.toBase58()], payout)
      : (mode === "fallback" ? payFallbackIx : payIx)(program, signer.publicKey, t.mint, d.wallet, d.cumulative, proofs[d.wallet.toBase58()]);
    const what = mode === "fallback" ? "pay_fallback" : "pay";
    let txs = 0, paid = 0;
    const queue = [...due];
    while (queue.length && txs < MAX_PAY_TXS_PER_PASS) {
      const batch: Due[] = [];
      while (queue.length && batch.length < MAX_PAYS_PER_TX && fits([...batch, queue[0]].map(ixOf))) batch.push(queue.shift()!);
      if (!batch.length) batch.push(queue.shift()!);
      txs++;
      try {
        await send(t, v, `${what} ${batch.length} wallet(s) ${xnt(batch.reduce((a, b) => a + b.owed, 0n))}`, batch.map(ixOf), Math.min(1_400_000, 60_000 + 90_000 * batch.length));
        paid += batch.length;
      } catch (e) {
        if (batch.length === 1) { console.error(`${tag} ${t.symbol}: ${what} ${batch[0].wallet.toBase58()} failed: ${msg(e)}`); continue; }
        // One bad payment shouldn't hold up the rest: retry them one by one.
        for (const b of batch) {
          try {
            await send(t, v, `${what} ${b.wallet.toBase58().slice(0, 4)}… ${xnt(b.owed)}`, [ixOf(b)], 200_000);
            paid++;
          } catch (err) {
            console.error(`${tag} ${t.symbol}: ${what} ${b.wallet.toBase58()} failed: ${msg(err)}`);
          }
        }
      }
    }
    if (paid) notes.push(`${mode === "fallback" ? "fallback-paid" : "paid"} ${paid} wallet(s)`);
    return paid;
  }

  /**
   * The next list: the holder pool's XNT not yet in anyone's total (holders_funded minus
   * every wallet's starting total) split over eligible holders. Null when that's under the
   * token's minCycle and `force` isn't set (a publisher ending a fallback publishes anyway).
   * `prev` is the active list's totals (null when unknown: then it's rebuilt from the paid
   * records). The result carries its `inputs` for the pinned file (listFromInputs gives the
   * same wallets back).
   */
  async function nextList(t: CrankToken, v: Vault, prev: Record<string, string> | null, notes: string[], force = false) {
    const paid = await readPaidRecords(conn, program, v.address);
    let start = 0n;
    const seen = new Map<string, bigint>();
    for (const [w, c] of Object.entries(prev ?? {})) seen.set(w, BigInt(c));
    const paidAbove: [string, string][] = [];
    for (const [w, p] of paid) if (p > (seen.get(w) ?? 0n)) { seen.set(w, p); paidAbove.push([w, p.toString()]); }
    for (const x of seen.values()) start += x;
    const pot = v.holdersFunded > start ? v.holdersFunded - start : 0n;
    if (pot < await xntInPayout(conn, xdex, v, t.rules.minCycle) && !force) return null;
    const slot = await conn.getSlot("confirmed");
    const rows = await scanTokenAccounts(conn, t.mint);
    // A publisher that is a PDA (a multisig vault) never earns; a plain-key publisher is unchanged.
    const balances = eligibleBalances(rows, eligibilityFor(t.rules, vaultAuthPda(program, t.mint), xdex, publisherExclusion(v.publisher)));
    const floor = [v.listTotal, v.pendingTotal, v.holdersPaid].reduce((a, b) => (b > a ? b : a), 0n);
    // The list it builds on: the active one, or a due pending one publish_list will activate first.
    const eff = effectiveList(v, nowSecs() - ACTIVATION_MARGIN_SECS);
    const inputs: ListInputsJson = {
      slot: String(slot), holdersFunded: v.holdersFunded.toString(), floor: floor.toString(), pot: pot.toString(),
      // null also for a list rebuilt without the previous one's entries (allowRebuild).
      prev: prev && eff ? { epoch: eff.epoch.toString(), root: eff.root.toString("hex"), cid: cidFromBytes(eff.cid) } : null,
      paid: paidAbove.sort(byWallet), balances: [...balances].map(([w, b]) => [w, b.toString()] as [string, string]).sort(byWallet),
    };
    const c = listFromInputs(prev, inputs);
    if (!Object.keys(c.wallets).length) { notes.push(balances.size ? "nothing to allocate yet" : "no eligible holders yet"); return null; }
    if (c.total > v.holdersFunded) throw new Error(`list total ${c.total} is above holders_funded ${v.holdersFunded}`);
    if (c.allocated === 0n && !force) return null;
    const epoch = (v.listEpoch > v.pendingEpoch ? v.listEpoch : v.pendingEpoch) + 1n;
    return { epoch, total: c.total, wallets: c.wallets, allocated: c.allocated, holders: allocate(balances, pot).size, root: buildVaultTree(v.address, c.wallets).root, inputs };
  }

  /** publish_list with the file's CID (pin first: no pin, no publish). Returns the signature and active time. */
  async function publish(t: CrankToken, v: Vault, a: { epoch: bigint; total: bigint; root: Buffer; cid: string; wallets: number }) {
    const ix = publishListIx(program, signer.publicKey, t.mint, a.root, a.epoch, a.total, cidToBytes(a.cid));
    const { signature, events } = await send(t, v, `publish_list epoch ${a.epoch} (${a.wallets} wallets, total ${xnt(a.total)}, ${a.cid})`, [ix], 60_000);
    const pub = events.find((e) => e.name === "ListPublished");
    return { signature, activeAt: pub?.name === "ListPublished" ? pub.activeAt : null };
  }

  return { readVault, send, upgrade, poolOf, taxWaiting, collect, sell, liquidity, creator, creatorQuote, holders, pay, nextList, publish, fits };
}

/** Whether the vault is in fallback now, with a margin so the chain's clock agrees. */
export const inFallback = (v: Vault, now = nowSecs()) => fallbackActive(v, now - ACTIVATION_MARGIN_SECS);

// ---------- "Run the vault now": the due steps as unsigned instruction lists for any wallet ----------
/**
 * A visitor's steps after the first can't be simulated (each counts on the one before
 * landing), so their compute limits are fixed: measured use on testnet plus a margin
 * (X1 bills the requested units). Sell ~88k, fund_creator up to ~194k (the spec asks for >= 250k), collect ~32k-45k,
 * pay / pay_fallback ~16k-20k per wallet, upgrade ~6k.
 */
export interface PlannedStep { kind: "upgrade" | "collect" | "sell" | "add_liquidity" | "fund_creator" | "fund_holders" | "pay" | "pay_fallback"; label: string; ixs: TransactionInstruction[]; units: number }
/**
 * What a visitor's wallet (`caller`) can run right now, in order: each step is one
 * transaction the caller pays and signs; later ones count on the earlier ones landing (the
 * sale sells what collect adds). `list` is the list pay would verify against (null: no pays).
 * The estimate is the crank reward the sale would earn (1% of the holders' part, capped).
 */
export async function planForCaller(conn: Connection, env: { program: PublicKey; xdex: PublicKey; network: "mainnet" | "testnet" }, v: Vault, t: { mint: PublicKey; taxBps: number },
  caller: PublicKey, list: PayList | null, opts: { maxPays: number; minPayout: bigint; includeNew?: boolean }) {
  const { program, xdex } = env;
  const steps: PlannedStep[] = [];
  const notes: string[] = [];
  if (v.version < VAULT_VERSION) {
    steps.push({ kind: "upgrade", label: `Upgrade the vault to v${VAULT_VERSION}`, ixs: [upgradeVaultIx(program, caller, t.mint)], units: 20_000 });
    notes.push("The vault is upgraded first; the other steps wait for the next run.");
    return { steps, notes, rewardLamports: 0n, recordsRent: 0n };
  }
  // 1. collect: every account holding tax that fits one transaction.
  const [rows, mintInfo] = await Promise.all([scanTokenAccounts(conn, t.mint), conn.getAccountInfo(t.mint, "confirmed")]);
  const withheld = rows.filter((x) => x.withheld > 0n).sort((a, b) => (b.withheld > a.withheld ? 1 : b.withheld < a.withheld ? -1 : 0));
  const inMint = getTransferFeeConfig(unpackMint(t.mint, mintInfo, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
  const fitsFor = (ixs: TransactionInstruction[]) => {
    const tx = new Transaction({ feePayer: caller, recentBlockhash: PublicKey.default.toBase58() }).add(...withPriority(ixs, 10_000, 1_400_000));
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  };
  const harvest: PublicKey[] = [];
  let got = inMint;
  for (const w of withheld) {
    if (harvest.length >= MAX_HARVEST_PER_TX || !fitsFor([collectIx(program, caller, t.mint, [...harvest, w.address])])) break;
    harvest.push(w.address); got += w.withheld;
  }
  if (got > 0n) steps.push({ kind: "collect", label: `Collect the tax (${harvest.length} account${harvest.length === 1 ? "" : "s"})`, ixs: [collectIx(program, caller, t.mint, harvest)], units: 50_000 + 12_000 * harvest.length });
  // What collect adds to the buckets (the program's split).
  const burn = (got * BigInt(v.burnBps)) / 10_000n, lp = (got * BigInt(v.lpBps)) / 10_000n, cr = (got * BigInt(v.creatorBps)) / 10_000n;
  const holders = got - burn - lp - cr;
  const sellLp = v.sellLp + (lp - lp / 2n), sellCr = v.sellCreator + cr, sellHo = v.sellHolders + holders;
  const wanted = sellLp + sellCr + sellHo;
  // 2. sell (one sale; the program caps it).
  let reward = 0n, toLp = 0n, toCreator = 0n, toHolders = 0n, soldIn = 0n, soldOut = 0n;
  const pool = poolAccountsFrom(xdex, decodePool(v.pool, (await conn.getMultipleAccountsInfo([v.pool], "confirmed"))[0], xdex), t.mint);
  if (wanted > 0n) {
    const q = await quoteSell(conn, xdex, v.pool, t.mint, wanted, { maxImpactBps: sellImpactBps(t.taxBps), slippageBps: Number(OUT_TOLERANCE_BPS) }).catch(() => null);
    if (q && q.expectedOut >= MIN_SELL_XNT) {
      steps.push({ kind: "sell", label: `Sell ~${fromBaseUnits(q.amountIn, 9)} tokens for ~${xnt(q.expectedOut)}`, ixs: [sellIx(program, caller, t.mint, pool, wanted)], units: 140_000 });
      const part = (q.expectedOut * sellHo) / wanted;
      reward = (part * CRANK_REWARD_BPS) / 10_000n;
      if (reward > CRANK_REWARD_CAP) reward = CRANK_REWARD_CAP;
      toLp = (q.expectedOut * sellLp) / wanted; toCreator = (q.expectedOut * sellCr) / wanted;
      toHolders = q.expectedOut - toLp - toCreator - reward;
      soldIn = q.amountIn - q.transferFee; soldOut = q.expectedOut;
    } else if (q) notes.push("The tax to sell is still dust.");
  }
  // 3. add_liquidity, 4. fund_creator (counting what the sale sets aside).
  // Only when the program will find something to deposit (its deposit_for, mirrored by
  // maxLpFor, on the pool as the sale leaves it; 1% of margin on the tokens), so the
  // visitor doesn't pay for a step it refuses with TooSmall.
  const lpTokens = v.lpTokens + lp / 2n, lpXnt = v.xntLp + toLp;
  const depositable = lpXnt >= MIN_LP_XNT && lpTokens > 0n && await snapshot(conn, xdex, v.pool, t.mint).then((snap) =>
    maxLpFor((lpTokens * 99n) / 100n, lpXnt, snap.reserveToken + soldIn, snap.reserveQuote - soldOut, snap.pool.lpSupply,
      BigInt(t.taxBps), 2n ** 64n - 1n) > 0n).catch(() => false);
  if (depositable) {
    steps.push({ kind: "add_liquidity", label: "Add liquidity", ixs: [addLiquidityIx(program, caller, t.mint, pool)], units: 220_000 });
  }
  const creatorXnt = v.xntCreator + toCreator;
  if (creatorXnt > 0n) {
    const q = await quoteBuy(conn, xdex, v.rewardSwapPool, v.rewardMint, creatorXnt, Number(OUT_TOLERANCE_BPS), rewardImpactBps).catch(() => null);
    if (q && q.minimumOut > 0n) {
      const info = rewardTokenInfo(env.network, v.rewardMint);
      steps.push({ kind: "fund_creator", label: `Pay the creator reward (${xnt(q.amountIn)} → ${info?.symbol ?? "reward token"})`,
        ixs: [fundCreatorIx(program, caller, t.mint, v.creatorNft, rewardPoolAccountsFrom(xdex, q.pool, v.rewardMint))], units: 260_000 });
    }
  }
  // 4b. fund_holders (payout-token vaults): the holders' XNT, including what the sale adds.
  // It shares fund_creator's one-swap-per-slot rule; the visitor's steps land in separate slots.
  const payout = paysInToken(v) ? await payoutAccountsOf(conn, xdex, v) : null;
  if (payout && v.xntHolders + toHolders > 0n) {
    const q = await quoteBuy(conn, xdex, v.payoutPool, payout.payoutMint, v.xntHolders + toHolders, Number(OUT_TOLERANCE_BPS), rewardImpactBps).catch(() => null);
    if (q && q.minimumOut > 0n) {
      steps.push({ kind: "fund_holders", label: `Swap the holders' XNT into the payout token (${xnt(q.amountIn)})`,
        ixs: [fundHoldersIx(program, caller, t.mint, payout)], units: 260_000 });
    }
  }
  // 5. pay / pay_fallback a few wallets. Only wallets that already have a PaidRecord: a
  // visitor earns nothing for paying, so they never pay a record's rent (the site crank
  // and scripts/crank.ts create new records). `includeNew` (the recovery page, when the
  // visitor opts in) pays new wallets too, the caller paying each new record's rent.
  let recordsRent = 0n;
  const now = nowSecs();
  const eff = effectiveList(v, now - ACTIVATION_MARGIN_SECS);
  const waitingActivation = !!eff && !eff.pending && v.pendingEpoch > 0n && now >= v.pendingActiveAt;
  if (list && eff && !waitingActivation && eff.root.toString("hex") === list.root) {
    const fallback = inFallback(v, now);
    const due = (await dueFrom(conn, program, v, list.wallets, { fallback, minPayout: await xntInPayout(conn, xdex, v, opts.minPayout), listTotal: eff.total }))
      .filter((d) => d.recordExists || opts.includeNew).slice(0, opts.maxPays);
    if (due.length) {
      const { proofs } = buildVaultTree(v.address, list.wallets);
      const build = (x: Due) => payout
        ? (fallback ? payFallbackTokenIx : payTokenIx)(program, caller, t.mint, x.wallet, x.cumulative, proofs[x.wallet.toBase58()], payout)
        : (fallback ? payFallbackIx : payIx)(program, caller, t.mint, x.wallet, x.cumulative, proofs[x.wallet.toBase58()]);
      const batch: Due[] = [];
      for (const d of due) {
        const next = [...batch, d].map(build);
        if (!fitsFor(next)) break;
        batch.push(d);
      }
      if (batch.length) {
        const rent = BigInt(await conn.getMinimumBalanceForRentExemption(PAID_RECORD_LEN));
        recordsRent = rent * BigInt(batch.filter((d) => !d.recordExists).length);
        steps.push({ kind: fallback ? "pay_fallback" : "pay",
          label: `${fallback ? "Pay holders from the last list (fallback)" : "Pay holders"}: ${batch.length} wallet${batch.length === 1 ? "" : "s"}, ${payout ? `${batch.reduce((a, d) => a + d.owed, 0n)} payout-token units` : xnt(batch.reduce((a, d) => a + d.owed, 0n))}`,
          // A token payout may also open the wallet's token account.
          ixs: batch.map(build), units: Math.min(1_400_000, (payout ? 45_000 : 20_000) + (payout ? 60_000 : 30_000) * batch.length) });
      }
    }
  }
  return { steps, notes, rewardLamports: reward, recordsRent };
}
