/**
 * The XDEX-wide scanner, as a module: scripts/arb-scan.ts runs it on its own, and scripts/arb-bot.ts
 * --scan runs it inside the bot's process, sharing the bot's engine (one wallet, one queue of trades,
 * so the two never send through the same pool at once).
 *
 * Routes:
 *   triangles   every token's deepest XNT pool, one of its other pools, and that pool's other token's
 *               deepest XNT pool (both directions)
 *   hub pairs   for the busiest middle tokens (the ones with the most watched side pools, e.g. USDC.X):
 *               XNT -> Qa (Qa/XNT) -> hub (hub/Qa) -> Qb (hub/Qb) -> XNT (Qb/XNT), between their most
 *               liquid side pools; four swaps, through the wallet's lookup tables (filled at each full read)
 *
 * Every `loopSecs` it reads all of XDEX (every pool, vault, fee config and mint, in batches of 100). Between
 * those reads it subscribes (at "processed", as soon as a swap lands) to the watched pools' vaults and re-prices the routes a changed pool belongs to
 * the moment the change arrives (the new balance comes with the notification); before trading it re-reads
 * the pools involved, so a trade is never based on a stale notification.
 *
 * A route only counts when its profit covers its minimum (the engine's, higher on the owner's own pools)
 * plus the rent of any token accounts the wallet would still need (about 0.0021 XNT each). Triangles are
 * skipped when either token has a freeze authority, a transfer hook, a permanent delegate, a pause switch,
 * non-transferable or default-frozen accounts, or a transfer fee above 10%.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountState, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TransferFeeConfig, getDefaultAccountState, getExtensionTypes,
  getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { routesFor, type Engine, type Route } from "./arb-engine.js";
import { symbolOf } from "./pools.js";
import { decodePool, snapshotMany, type Pool, type Snapshot, type SnapshotSpec } from "./xdex.js";

export interface ScannerOptions {
  conn: Connection;
  xdex: PublicKey;
  engine: Engine;
  execute: boolean;
  /** Tokens another loop already covers: no triangle goes through them. */
  skip: Set<string>;
  /** Only triangles whose two XNT pools each hold at least this much XNT (lamports). */
  minLiquidity: bigint;
  /** At most this many pool vaults watched live. */
  maxSubs: number;
  /** Seconds between full reads (0: once). */
  loopSecs: number;
  /** Watch the pools live between full reads. */
  instant: boolean;
  /** How many hub tokens get side-pool-pair routes (0: none), and how many of each hub's side pools. */
  hubs: number;
  hubSides: number;
  verbose: boolean;
  log: (s: string) => void;
}

const X = NATIVE_MINT.toBase58();
const ACCOUNT_RENT = 2_100_000n;
const NO_FEE: TransferFeeConfig = {
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
  newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
};
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why a token is too risky to route through, or null if it's fine. */
function unsafe(info: Parameters<typeof unpackMint>[1], mint: PublicKey): string | null {
  const m = unpackMint(mint, info, info!.owner);
  if (m.freezeAuthority) return "freeze authority";
  if (!info!.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  const ext = getExtensionTypes(m.tlvData);
  if (ext.includes(ExtensionType.TransferHook)) return "transfer hook";
  if (ext.includes(ExtensionType.PermanentDelegate)) return "permanent delegate";
  if (ext.includes(ExtensionType.NonTransferable)) return "non-transferable";
  if (ext.includes(ExtensionType.PausableConfig)) return "pausable";
  if (ext.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(m)?.state === AccountState.Frozen) return "accounts start frozen";
  const fee = getTransferFeeConfig(m)?.newerTransferFee.transferFeeBasisPoints ?? 0;
  return fee > 1000 ? `${fee / 100}% transfer fee` : null;
}

export function createScanner(o: ScannerOptions) {
  const { conn, xdex, engine, log } = o;

  interface P { pool: Pool; mints: [string, string]; owed: [bigint, bigint]; rate: bigint; vault: [bigint, bigint] }
  interface Tri { T: string; Q: string; main: string; side: string; quote: string; liq: bigint }
  /** A hub token and its chosen side pools: each pairs the hub with another token that has its own XNT pool. */
  interface HubSide { side: string; other: string; otherPool: string; liq: bigint }
  interface Hub { mint: string; sides: HubSide[] }
  let pools = new Map<string, P>();
  let tax = new Map<string, TransferFeeConfig>();
  let tris: Tri[] = [];
  let hubs: Hub[] = [];
  let byPool = new Map<string, number[]>();
  let hubsByPool = new Map<string, number[]>();
  let epoch = 0n;
  const symbols = new Map<string, string>();
  const name = async (m: string) => { if (!symbols.has(m)) symbols.set(m, await symbolOf(conn, new PublicKey(m))); return symbols.get(m)!; };

  async function many(keys: PublicKey[]) {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) { out.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")); await new Promise((r) => setTimeout(r, 150)); }
    return out;
  }

  /** Read all of XDEX and rebuild the watched triangles and hubs. */
  async function fullRead() {
    const raw = await conn.getProgramAccounts(xdex, { commitment: "confirmed", filters: [{ dataSize: 637 }] });
    const decoded: Pool[] = [];
    for (const { pubkey, account } of raw) { try { decoded.push(decodePool(pubkey, account, xdex)); } catch { /* paused or not open */ } }
    const cfgKeys = [...new Map(decoded.map((p) => [p.ammConfig.toBase58(), p.ammConfig])).values()];
    const mintKeys = [...new Map(decoded.flatMap((p) => p.mints).map((m) => [m.toBase58(), m])).values()];
    const [vaultInfo, cfgInfo, mintInfo, ep] = await Promise.all([many(decoded.flatMap((p) => p.vaults)), many(cfgKeys), many(mintKeys), conn.getEpochInfo("confirmed")]);
    epoch = BigInt(ep.epoch);
    const rate = new Map(cfgKeys.map((c, i) => [c.toBase58(), cfgInfo[i]?.data.readBigUInt64LE(12) ?? 1_000_000n]));
    const nextTax = new Map<string, TransferFeeConfig>(), bad = new Map<string, string>();
    mintKeys.forEach((m, i) => {
      const a = mintInfo[i];
      if (!a) return;
      try {
        const u = unpackMint(m, a, a.owner);
        nextTax.set(m.toBase58(), a.owner.equals(TOKEN_2022_PROGRAM_ID) ? (getTransferFeeConfig(u) ?? NO_FEE) : NO_FEE);
        const why = unsafe(a, m);
        if (why) bad.set(m.toBase58(), why);
      } catch { /* unreadable mint: its pools are left out */ }
    });
    const next = new Map<string, P>();
    decoded.forEach((p, i) => {
      try {
        const mints = [p.mints[0].toBase58(), p.mints[1].toBase58()] as [string, string];
        if (!nextTax.has(mints[0]) || !nextTax.has(mints[1])) return;
        const v0 = unpackAccount(p.vaults[0], vaultInfo[2 * i], p.programs[0]).amount, v1 = unpackAccount(p.vaults[1], vaultInfo[2 * i + 1], p.programs[1]).amount;
        next.set(p.address.toBase58(), { pool: p, mints, owed: [p.protocolFees[0] + p.fundFees[0], p.protocolFees[1] + p.fundFees[1]], rate: rate.get(p.ammConfig.toBase58())!, vault: [v0, v1] });
      } catch { /* a vault we can't read */ }
    });
    pools = next; tax = nextTax;
    const xntIn = (p: P) => (p.mints[0] === X ? p.vault[0] - p.owed[0] : p.vault[1] - p.owed[1]);
    const main = new Map<string, string>();
    for (const [a, p] of pools) {
      if (!p.mints.includes(X)) continue;
      const t = p.mints[0] === X ? p.mints[1] : p.mints[0], c = main.get(t);
      if (!c || xntIn(p) > xntIn(pools.get(c)!)) main.set(t, a);
    }
    const out: Tri[] = [], seen = new Set<string>();
    let unsafeSkipped = 0;
    for (const [a, p] of pools) {
      if (p.mints.includes(X)) continue;
      for (const [T, Q] of [[p.mints[0], p.mints[1]], [p.mints[1], p.mints[0]]]) {
        const m = main.get(T), q = main.get(Q);
        // Any triangle through a skipped token belongs to the other loop (from either side), so the two never overlap.
        if (!m || !q || o.skip.has(T) || o.skip.has(Q)) continue;
        const k = [m, a, q].sort().join();
        if (seen.has(k)) continue;
        seen.add(k);
        if (bad.has(T) || bad.has(Q)) { unsafeSkipped++; continue; }
        const liq = xntIn(pools.get(m)!) < xntIn(pools.get(q)!) ? xntIn(pools.get(m)!) : xntIn(pools.get(q)!);
        if (liq < o.minLiquidity) continue;
        out.push({ T, Q, main: m, side: a, quote: q, liq });
      }
    }
    tris = out.sort((x, y) => Number(y.liq - x.liq));
    // Hubs: the tokens with the most watched side pools (a side pool counts for both its tokens);
    // each keeps its most liquid ones.
    const byToken = new Map<string, HubSide[]>();
    for (const t of tris) {
      byToken.set(t.T, [...(byToken.get(t.T) ?? []), { side: t.side, other: t.Q, otherPool: t.quote, liq: t.liq }]);
      byToken.set(t.Q, [...(byToken.get(t.Q) ?? []), { side: t.side, other: t.T, otherPool: t.main, liq: t.liq }]);
    }
    hubs = o.hubs > 0 ? [...byToken].filter(([, l]) => l.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, o.hubs)
      .map(([mint, l]) => ({ mint, sides: [...l].sort((a, b) => Number(b.liq - a.liq)).slice(0, o.hubSides) })) : [];
    byPool = new Map();
    tris.forEach((t, i) => { for (const k of [t.main, t.side, t.quote]) byPool.set(k, [...(byPool.get(k) ?? []), i]); });
    hubsByPool = new Map();
    hubs.forEach((h, hi) => { for (const s of h.sides) for (const k of [s.side, s.otherPool]) hubsByPool.set(k, [...new Set([...(hubsByPool.get(k) ?? []), hi])]); });
    return { pools: pools.size, triangles: tris.length, unsafeSkipped, unsafeTokens: bad.size };
  }

  /** A pool's snapshot from the in-memory market (token side `mint`). */
  function snap(addr: string, mint: string): Snapshot | undefined {
    const p = pools.get(addr);
    if (!p) return undefined;
    const side = p.mints.indexOf(mint);
    return { pool: p.pool, side, quoteMint: p.pool.mints[1 - side], reserveToken: p.vault[side] - p.owed[side], reserveQuote: p.vault[1 - side] - p.owed[1 - side],
      tradeFeeRate: p.rate, feeCfg: tax.get(mint)!, epoch };
  }
  async function triRoutes(t: Tri): Promise<Route[]> {
    const main = snap(t.main, t.T), side = snap(t.side, t.T), quote = snap(t.quote, t.Q);
    if (!main || !side || !quote) return [];
    engine.learnFees([main, side, quote]);
    return routesFor({ mint: new PublicKey(t.T), symbol: await name(t.T), main, sides: [{ name: `${await name(t.T)}/${await name(t.Q)}`, side, quote, quoteMint: new PublicKey(t.Q) }] }, false);
  }
  /** Four-swap routes between two of a hub's side pools: XNT -> Qa -> hub -> Qb -> XNT (the hub's own XNT pool isn't used). */
  async function hubRoutes(h: Hub): Promise<Route[]> {
    const sides = [];
    for (const s of h.sides) {
      const side = snap(s.side, h.mint), quote = snap(s.otherPool, s.other);
      if (!side || !quote) continue;
      engine.learnFees([side, quote]);
      sides.push({ name: `${await name(h.mint)}/${await name(s.other)}`, side, quote, quoteMint: new PublicKey(s.other) });
    }
    if (sides.length < 2) return [];
    // routesFor also makes triangles through `main`; only its pair routes are kept, which don't touch it.
    return routesFor({ mint: new PublicKey(h.mint), symbol: await name(h.mint), main: sides[0].side, sides }, true).filter((r) => r.hops.length > 3);
  }

  /** The same route with every hop's pool re-read fresh (null if one can't be read). */
  function refreshed(r: Route, fresh: Map<string, Snapshot>): Route | null {
    const hops = [];
    for (const h of r.hops) {
      const s = fresh.get(`${h.snap.pool.address.toBase58()}:${h.snap.pool.mints[h.snap.side].toBase58()}`);
      if (!s) return null;
      hops.push({ snap: s, inMint: h.inMint });
    }
    return { ...r, hops };
  }

  /** Price these routes from memory; re-read the paying ones fresh, re-price, and trade them. */
  async function evaluate(routes: Route[]) {
    const paying = (await engine.bestAll(routes)).filter((p) => p.pays);
    if (!paying.length) return 0;
    const keys = new Set<string>();
    for (const p of paying) for (const h of p.plan.route.hops) keys.add(`${h.snap.pool.address.toBase58()}|${h.snap.pool.mints[h.snap.side].toBase58()}`);
    const specs: SnapshotSpec[] = [...keys].map((k) => { const [pool, mint] = k.split("|"); return { pool: new PublicKey(pool), mint: new PublicKey(mint), quote: null }; });
    const fresh = await snapshotMany(conn, xdex, specs, epoch, "processed");
    engine.learnFees(fresh.values());
    const again = paying.map((p) => refreshed(p.plan.route, fresh)).filter((r): r is Route => !!r);
    const ok = [];
    for (const p of (await engine.bestAll(again)).filter((x) => x.pays)) {
      const rent = ACCOUNT_RENT * BigInt((await engine.missingAccounts([p.plan.route])).length);
      if (p.plan.profit >= p.plan.minProfit + rent) ok.push(p);
      else if (o.verbose) log(`${p.plan.route.name}: +${xnt(p.plan.profit)} doesn't cover ${xnt(rent)} of new-account rent`);
    }
    if (!ok.length) return 0;
    if (!o.execute) {
      for (const p of ok) log(`[dry run] ${engine.describe(p.plan)}: ${xnt(p.plan.xntIn)} XNT -> +${xnt(p.plan.profit)}${p.ownShare >= 0.5 ? ` (${Math.round(p.ownShare * 100)}% your own pool)` : ""}`);
      return ok.length;
    }
    return engine.execute(ok);
  }
  async function allRoutes() {
    const out: Route[] = [];
    for (const t of tris) out.push(...await triRoutes(t));
    for (const h of hubs) out.push(...await hubRoutes(h));
    return out;
  }

  // ---------- live: vault notifications re-price the routes they touch ----------
  const subs = new Map<string, number>();
  const dirty = new Set<string>();
  let running = false, timer: NodeJS.Timeout | null = null;
  function schedule() {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (running) { schedule(); return; }
      running = true;
      const changed = [...dirty];
      dirty.clear();
      try {
        const routes: Route[] = [];
        for (const i of new Set(changed.flatMap((p) => byPool.get(p) ?? []))) routes.push(...await triRoutes(tris[i]));
        for (const hi of new Set(changed.flatMap((p) => hubsByPool.get(p) ?? []))) routes.push(...await hubRoutes(hubs[hi]));
        if (routes.length) await evaluate(routes);
      } catch (e) { log(`live check failed: ${msg(e)}`); }
      running = false;
      if (dirty.size) schedule();
    }, 300);
  }
  function watch() {
    const want = new Map<string, { pool: string; i: 0 | 1 }>();
    const add = (a: string) => { const p = pools.get(a); if (!p) return; want.set(p.pool.vaults[0].toBase58(), { pool: a, i: 0 }); want.set(p.pool.vaults[1].toBase58(), { pool: a, i: 1 }); };
    for (const h of hubs) for (const s of h.sides) [s.side, s.otherPool].forEach(add);
    for (const t of tris) { if (want.size >= o.maxSubs) break; [t.main, t.side, t.quote].forEach(add); }
    for (const [v, w] of want) {
      if (subs.has(v)) continue;
      subs.set(v, conn.onAccountChange(new PublicKey(v), (info) => {
        const p = pools.get(w.pool);
        if (!p || info.data.length < 72) return;
        p.vault[w.i] = info.data.readBigUInt64LE(64);
        dirty.add(w.pool);
        schedule();
      }, { commitment: "processed" }));
    }
    for (const [v, id] of subs) if (!want.has(v)) { conn.removeAccountChangeListener(id).catch(() => undefined); subs.delete(v); }
    return want.size;
  }

  /** One full read: rebuild everything, fill the lookup tables for the hub routes, and price every route. */
  async function pass() {
    const r = await fullRead();
    const watched = o.instant ? watch() : 0;
    const routes = await allRoutes();
    const pairs = routes.filter((x) => x.hops.length > 3);
    if (o.execute && pairs.length) {
      try { await engine.ensureAlt(pairs); } catch (e) { log(`lookup tables not ready: ${msg(e)}`); }
    }
    log(`scan: ${r.pools} pools, ${r.triangles} triangles with ${xnt(o.minLiquidity)}+ XNT on both XNT pools`
      + ` (${r.unsafeSkipped} skipped for risky tokens), ${hubs.length} hub(s) with ${pairs.length} pair routes`
      + `${hubs.length ? ` (${(await Promise.all(hubs.map((h) => name(h.mint)))).join(", ")})` : ""}${o.instant ? `, ${watched} vaults watched live` : ""}`);
    running = true;
    try { return await evaluate(routes); } finally { running = false; }
  }

  /** Run forever (or once, with loopSecs 0). */
  async function start() {
    if (o.loopSecs) engine.warm();
    for (;;) {
      try {
        const n = await pass();
        if (!n && o.verbose) log("scan: nothing pays right now");
      } catch (e) { running = false; log(`scan: full read failed: ${msg(e)}`); }
      if (!o.loopSecs) return;
      await new Promise((r) => setTimeout(r, o.loopSecs * 1000));
    }
  }
  return { start, pass };
}
