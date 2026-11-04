/**
 * Dust sweep: sell the tokens a visitor picks from their wallet for XNT on XDEX, then buy a site token
 * (TEST on mainnet) with it. The site builds unsigned transactions and the visitor's wallet signs them;
 * the server never holds a key.
 *
 *   scan   every token account the wallet has: what each is worth in XNT through its deepest XNT pool
 *          (after its transfer fee and the pool fee), the price impact of selling it all, whether it can
 *          be sold at all, and the rent an emptied account gives back when it's closed
 *   sell   the picked tokens sold to wrapped XNT, a few per transaction, each with its own minimum out;
 *          closing the empty accounts picked, and (with `close`) the ones just emptied, to get their rent back
 *   buy    after the sells land: reads from the chain what they really gave (wrapped XNT gained and
 *          rent reclaimed) and buys the target token with that, in one transaction, minimum out set
 *
 * Every swap has a minimum: if a price moves past the slippage the visitor allowed, that transaction
 * fails as a whole and nothing in it is traded.
 */
import {
  Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createHarvestWithheldTokensToMintInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
  getExtensionTypes, unpackMint, type TransferFeeConfig,
} from "@solana/spl-token";
import { cpmmOut, decodePool, snapshotMany, swapIx, type Snapshot } from "../xdex.js";
import { symbolOf } from "../pools.js";

/** What the pure parts below need from a pool snapshot. */
export type Quote = Pick<Snapshot, "reserveToken" | "reserveQuote" | "tradeFeeRate" | "feeCfg" | "epoch">;

/** XNT (lamports) for selling all `amount` of a token into its XNT pool, after its transfer fee and the pool fee; and the impact. */
export function quoteSell(q: Quote, amount: bigint) {
  const net = amount - calculateEpochFee(q.feeCfg, q.epoch, amount);
  const out = net > 0n ? cpmmOut(net, q.reserveToken, q.reserveQuote, q.tradeFeeRate) : 0n;
  const spot = Number(net) * Number(q.reserveQuote) / Number(q.reserveToken);
  return { out, impactPct: spot > 0 ? (1 - Number(out) / spot) * 100 : 100 };
}

/** Target tokens received for `xntIn` lamports through its XNT pool, after the pool fee and its transfer tax on the way out. */
export function quoteBuy(q: Quote, xntIn: bigint) {
  const gross = xntIn > 0n ? cpmmOut(xntIn, q.reserveQuote, q.reserveToken, q.tradeFeeRate) : 0n;
  const tax = calculateEpochFee(q.feeCfg, q.epoch, gross);
  return { gross, received: gross - tax, tax };
}

/** `x` less `bps` basis points (a minimum out). */
export const lessSlippage = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n;

/**
 * What landed sell transactions gave the wallet, from their metadata: wrapped XNT gained (its wXNT account's
 * balance change) and rent of accounts they closed (lamports that left an account that ended empty).
 */
export function soldFor(owner: string, metas: { feePayer: string; err: unknown; keys: string[]; pre: number[]; post: number[];
  preTok: { owner?: string; mint: string; amount: string }[]; postTok: { owner?: string; mint: string; amount: string }[] }[]) {
  let wrapped = 0n, rent = 0n;
  for (const m of metas) {
    if (m.err || m.feePayer !== owner) continue;
    const w = (l: typeof m.preTok) => l.filter((b) => b.owner === owner && b.mint === NATIVE_MINT.toBase58()).reduce((a, b) => a + BigInt(b.amount), 0n);
    const d = w(m.postTok) - w(m.preTok);
    if (d > 0n) wrapped += d;
    m.keys.forEach((k, i) => { if (i > 0 && m.pre[i] > 0 && m.post[i] === 0) rent += BigInt(m.pre[i]); });
  }
  return { wrapped, rent };
}

/** Why a token can't be sold from a wallet, or null. (A freeze authority alone is fine: it's the holder's own sale.) */
function unsellable(mintInfo: Parameters<typeof unpackMint>[1], mint: PublicKey, frozen: boolean): string | null {
  if (frozen) return "account is frozen";
  if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const ext = getExtensionTypes(unpackMint(mint, mintInfo, mintInfo.owner).tlvData);
  if (ext.includes(ExtensionType.TransferHook)) return "transfer hook (XDEX can't trade it)";
  if (ext.includes(ExtensionType.NonTransferable)) return "non-transferable";
  if (ext.includes(ExtensionType.PausableConfig)) return "pausable token";
  return null;
}

export interface SweepItem {
  account: string; mint: string; symbol: string; program: string; amount: string; decimals: number; ui: number;
  /** Lamports of XNT selling it all gives now (0 if it can't be sold), its price impact, and its XNT pool. */
  xntOut: string; impactPct: number | null; pool: string | null;
  canSell: boolean; why: string | null; empty: boolean; rent: number; withheld: string; wrapped?: boolean;
}

const MAX_ACCOUNTS = 120, TX_LIMIT = 1232, BUDGET_BYTES = 90;

export function createSweep(o: { conn: Connection; xdex: PublicKey; microLamports: number }) {
  const { conn, xdex } = o;
  // Every token's deepest XNT pool, from one read of all of XDEX (refreshed every 10 minutes).
  let index: { at: number; deepest: Map<string, string> } | null = null;
  let indexing: Promise<Map<string, string>> | null = null;
  async function deepest() {
    if (index && Date.now() - index.at < 10 * 60_000) return index.deepest;
    indexing ??= (async () => {
      const raw = await conn.getProgramAccounts(xdex, { commitment: "confirmed", filters: [{ dataSize: 637 }] });
      const pools = raw.flatMap(({ pubkey, account }) => { try { return [decodePool(pubkey, account, xdex)]; } catch { return []; } })
        .filter((p) => p.mints.some((m) => m.equals(NATIVE_MINT)));
      const vaults = pools.map((p) => p.vaults[p.mints[0].equals(NATIVE_MINT) ? 0 : 1]);
      const bal: bigint[] = [];
      for (let i = 0; i < vaults.length; i += 100) for (const a of await conn.getMultipleAccountsInfo(vaults.slice(i, i + 100), "confirmed")) bal.push(a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n);
      const best = new Map<string, { pool: string; xnt: bigint }>();
      pools.forEach((p, i) => { const t = p.mints[p.mints[0].equals(NATIVE_MINT) ? 1 : 0].toBase58(); const c = best.get(t); if (!c || bal[i] > c.xnt) best.set(t, { pool: p.address.toBase58(), xnt: bal[i] }); });
      const m = new Map([...best].map(([k, v]) => [k, v.pool]));
      index = { at: Date.now(), deepest: m };
      return m;
    })().finally(() => { indexing = null; });
    return indexing;
  }
  const symbols = new Map<string, string>();
  const sym = async (m: string) => { if (!symbols.has(m)) symbols.set(m, await symbolOf(conn, new PublicKey(m)).catch(() => m.slice(0, 4) + "…")); return symbols.get(m)!; };
  async function epoch() { return BigInt((await conn.getEpochInfo("confirmed")).epoch); }

  /** The target token's XNT pool snapshot (to buy it). */
  async function targetQuote(to: PublicKey) {
    const pool = (await deepest()).get(to.toBase58());
    if (!pool) throw new Error("That token has no XNT pool to buy it with");
    const s = (await snapshotMany(conn, xdex, [{ pool: new PublicKey(pool), mint: to, quote: NATIVE_MINT }], await epoch(), "confirmed")).get(`${pool}:${to.toBase58()}`);
    if (!s) throw new Error("Couldn't read the token's XNT pool");
    return s;
  }

  /** Every token account of `owner`, valued for a sweep into `to`. */
  async function scan(owner: PublicKey, to: PublicKey) {
    const accounts = (await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(async (programId) =>
      (await conn.getParsedTokenAccountsByOwner(owner, { programId }, "confirmed")).value.map((a) => ({ ...a, programId }))))).flat();
    if (accounts.length > MAX_ACCOUNTS) accounts.length = MAX_ACCOUNTS;
    const pools = await deepest(), ep = await epoch();
    type Parsed = { mint: string; state: string; tokenAmount: { amount: string; decimals: number; uiAmount: number }; extensions?: { extension: string; state: { withheldAmount?: number | string } }[] };
    const rows = accounts.map((a) => ({ a, info: a.account.data.parsed.info as Parsed }))
      .filter((r) => r.info.mint !== to.toBase58());
    const mints = [...new Set(rows.map((r) => r.info.mint))];
    const mintInfos = new Map<string, Awaited<ReturnType<Connection["getAccountInfo"]>>>();
    for (let i = 0; i < mints.length; i += 100) (await conn.getMultipleAccountsInfo(mints.slice(i, i + 100).map((m) => new PublicKey(m)), "confirmed")).forEach((x, j) => mintInfos.set(mints[i + j], x));
    const specs = rows.filter((r) => r.info.tokenAmount.amount !== "0" && r.info.mint !== NATIVE_MINT.toBase58() && pools.has(r.info.mint))
      .map((r) => ({ pool: new PublicKey(pools.get(r.info.mint)!), mint: new PublicKey(r.info.mint), quote: NATIVE_MINT }));
    const snaps = specs.length ? await snapshotMany(conn, xdex, specs, ep, "confirmed") : new Map<string, Snapshot>();
    const items: SweepItem[] = [];
    for (const { a, info } of rows) {
      const amount = BigInt(info.tokenAmount.amount), empty = amount === 0n, mint = new PublicKey(info.mint);
      const withheld = String(info.extensions?.find((e) => e.extension === "transferFeeAmount")?.state.withheldAmount ?? "0");
      const base = { account: a.pubkey.toBase58(), mint: info.mint, symbol: await sym(info.mint), program: a.programId.toBase58(), amount: info.tokenAmount.amount,
        decimals: info.tokenAmount.decimals, ui: info.tokenAmount.uiAmount ?? 0, empty, rent: a.account.lamports, withheld };
      // Wrapped XNT: already XNT (the buy can use it); its account's lamports are the balance plus the rent.
      if (mint.equals(NATIVE_MINT)) { items.push({ ...base, rent: a.account.lamports - Number(amount), xntOut: info.tokenAmount.amount, impactPct: 0, pool: null, canSell: !empty, why: null, wrapped: true }); continue; }
      const why = unsellable(mintInfos.get(info.mint) ?? null, mint, info.state === "frozen");
      const pool = pools.get(info.mint) ?? null, s = pool ? snaps.get(`${pool}:${info.mint}`) : undefined;
      if (empty) { items.push({ ...base, xntOut: "0", impactPct: null, pool, canSell: false, why: why ?? "empty", }); continue; }
      if (why || !s) { items.push({ ...base, xntOut: "0", impactPct: null, pool, canSell: false, why: why ?? (pool ? "its XNT pool can't be read" : "no XNT pool") }); continue; }
      const q = quoteSell(s, amount);
      items.push({ ...base, xntOut: q.out.toString(), impactPct: Number(q.impactPct.toFixed(2)), pool, canSell: q.out > 0n, why: q.out > 0n ? null : "too small to sell" });
    }
    items.sort((x, y) => Number(BigInt(y.xntOut) - BigInt(x.xntOut)));
    const t = await targetQuote(to);
    return {
      owner: owner.toBase58(), items, native: await conn.getBalance(owner, "confirmed"),
      hasWrapped: items.some((i) => i.wrapped),
      target: { mint: to.toBase58(), symbol: await sym(to.toBase58()), xntPerToken: Number(t.reserveQuote) / Number(t.reserveToken) * 10 ** (await decimalsOf(to)) / LAMPORTS_PER_SOL,
        taxBps: t.feeCfg.newerTransferFee.transferFeeBasisPoints, pool: t.pool.address.toBase58() },
    };
  }
  const decs = new Map<string, number>();
  async function decimalsOf(m: PublicKey) {
    if (!decs.has(m.toBase58())) { const i = await conn.getAccountInfo(m, "confirmed"); decs.set(m.toBase58(), unpackMint(m, i, i!.owner).decimals); }
    return decs.get(m.toBase58())!;
  }

  /** Pack instruction groups into as few legacy transactions as fit (each starting with `head`). */
  function pack(payer: PublicKey, head: TransactionInstruction[], groups: TransactionInstruction[][]) {
    const out: TransactionInstruction[][] = [];
    let cur: TransactionInstruction[] = [];
    const size = (ixs: TransactionInstruction[]) => {
      const t = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }); t.add(...head, ...ixs);
      try { return t.serialize({ requireAllSignatures: false, verifySignatures: false }).length + BUDGET_BYTES; } catch { return Infinity; } // over the limit
    };
    for (const g of groups) {
      if (cur.length && size([...cur, ...g]) > TX_LIMIT) { out.push(cur); cur = []; }
      if (size(g) > TX_LIMIT) throw new Error("One of these tokens needs too big a transaction to sell");
      cur.push(...g);
    }
    if (cur.length) out.push(cur);
    return out.map((ixs) => [...head, ...ixs]);
  }

  /**
   * Unsigned sell transactions for the picked accounts: each sale to wrapped XNT with a minimum out, and
   * (with `close`) each emptied or picked empty account closed. Returns what the sales should give at least.
   */
  async function sell(owner: PublicKey, to: PublicKey, picked: string[], close: boolean, slippageBps: number, build: (payer: PublicKey, ixs: TransactionInstruction[]) => Promise<string>) {
    const s = await scan(owner, to), want = new Set(picked);
    // Picked empty accounts are always closed (that's why they're picked); `close` is for the ones sold here.
    const chosen = s.items.filter((i) => want.has(i.account) && !i.wrapped && (i.canSell || i.empty));
    if (!chosen.length) throw new Error("Pick at least one token that can be sold (or an empty account to close)");
    const pools = await deepest(), ep = await epoch();
    const wx = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
    const head = [createAssociatedTokenAccountIdempotentInstruction(owner, wx, owner, NATIVE_MINT, TOKEN_PROGRAM_ID)];
    const sellSpecs = chosen.filter((i) => i.canSell).map((i) => ({ pool: new PublicKey(pools.get(i.mint)!), mint: new PublicKey(i.mint), quote: NATIVE_MINT }));
    const snaps = sellSpecs.length ? await snapshotMany(conn, xdex, sellSpecs, ep, "confirmed") : new Map<string, Snapshot>();
    let minTotal = 0n, rent = 0;
    const groups: TransactionInstruction[][] = [];
    for (const i of chosen) {
      const g: TransactionInstruction[] = [], acct = new PublicKey(i.account), program = new PublicKey(i.program), mint = new PublicKey(i.mint);
      if (i.canSell) {
        const snap = snaps.get(`${pools.get(i.mint)}:${i.mint}`);
        if (!snap) throw new Error(`Couldn't price ${i.symbol} right now; try again`);
        const minOut = lessSlippage(quoteSell(snap, BigInt(i.amount)).out, slippageBps);
        minTotal += minOut;
        g.push(swapIx(xdex, owner, { pool: snap.pool, side: snap.side, amountIn: BigInt(i.amount), minimumOut: minOut }, acct, wx));
      }
      if (close || i.empty) {
        if (i.withheld !== "0") g.push(createHarvestWithheldTokensToMintInstruction(mint, [acct], program));
        g.push(createCloseAccountInstruction(acct, owner, owner, [], program));
        rent += i.rent;
      }
      groups.push(g);
    }
    const txs = [];
    for (const ixs of pack(owner, head, groups)) txs.push(await build(owner, ixs));
    return { txs, minXnt: minTotal.toString(), rent, hadWrapped: s.hasWrapped };
  }

  /**
   * The buy, after the sells landed: what they gave (read from the chain; only this wallet's own successful
   * transactions from the last 30 minutes count), plus the wallet's existing wrapped XNT if picked, plus the
   * reclaimed rent if wanted, swapped for the target with a minimum out. Unwraps what's left if the wallet
   * had no wrapped XNT account before the sweep.
   */
  async function buy(owner: PublicKey, to: PublicKey, o2: { signatures: string[]; useWrapped: boolean; addRent: boolean; hadWrapped: boolean; slippageBps: number },
    build: (payer: PublicKey, ixs: TransactionInstruction[]) => Promise<string>) {
    const metas = [];
    for (const sig of [...new Set(o2.signatures)].slice(0, 12)) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!t?.meta || !t.blockTime || Date.now() / 1000 - t.blockTime > 1800) continue;
      const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses }).staticAccountKeys.map((k) => k.toBase58());
      const tok = (l: typeof t.meta.preTokenBalances) => (l ?? []).map((b) => ({ owner: b.owner, mint: b.mint, amount: b.uiTokenAmount.amount }));
      metas.push({ feePayer: keys[0], err: t.meta.err, keys, pre: t.meta.preBalances, post: t.meta.postBalances, preTok: tok(t.meta.preTokenBalances), postTok: tok(t.meta.postTokenBalances) });
    }
    const got = soldFor(owner.toBase58(), metas);
    const wx = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
    const wrappedNow = await conn.getTokenAccountBalance(wx, "confirmed").then((b) => BigInt(b.value.amount)).catch(() => 0n);
    const native = BigInt(await conn.getBalance(owner, "confirmed"));
    // Rent to wrap: what was reclaimed, keeping 0.003 XNT plain for fees (and the target account's rent if it's new).
    const rentIn = o2.addRent ? (got.rent < native - 3_000_000n - 2_100_000n ? got.rent : native > 5_100_000n ? native - 5_100_000n : 0n) : 0n;
    const fromSales = got.wrapped < wrappedNow ? got.wrapped : wrappedNow;
    const spend = (o2.useWrapped ? wrappedNow : fromSales) + (rentIn > 0n ? rentIn : 0n);
    if (spend < 1_000_000n) throw new Error("Less than 0.001 XNT to buy with: nothing to do");
    // XDEX checks the minimum against what arrives after the token's transfer tax.
    const t = await targetQuote(to), q = quoteBuy(t, spend), minOut = lessSlippage(q.received, o2.slippageBps);
    const toProgram = t.pool.programs[t.side], toAta = getAssociatedTokenAddressSync(to, owner, false, toProgram);
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(owner, wx, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
      ...(rentIn > 0n ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: wx, lamports: rentIn }), createSyncNativeInstruction(wx, TOKEN_PROGRAM_ID)] : []),
      createAssociatedTokenAccountIdempotentInstruction(owner, toAta, owner, to, toProgram),
      swapIx(xdex, owner, { pool: t.pool, side: 1 - t.side, amountIn: spend, minimumOut: minOut }, wx, toAta),
      ...(o2.hadWrapped ? [] : [createCloseAccountInstruction(wx, owner, owner, [], TOKEN_PROGRAM_ID)]),
    ];
    return { tx: await build(owner, ixs), spendXnt: spend.toString(), fromSales: fromSales.toString(), rentWrapped: rentIn.toString(),
      expected: q.received.toString(), tax: q.tax.toString(), decimals: await decimalsOf(to) };
  }

  return { scan, sell, buy, deepest };
}

/** Clamp a visitor's slippage to 0.1%–5% (default 1%). */
export const slippageOf = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 10 && n <= 500 ? Math.round(n) : 100; };
export type { TransferFeeConfig };
