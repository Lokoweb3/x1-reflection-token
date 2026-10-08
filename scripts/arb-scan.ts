/**
 * XDEX-wide arbitrage scanner: prices the round trip of every triangle on XDEX (a token's deepest XNT
 * pool, one of its other pools, and that pool's other token's deepest XNT pool) and trades the ones
 * that pay, through src/arb-engine.ts (the same pricing, simulate-first and all-or-nothing trades as
 * the arb bot).
 *
 *   npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10]
 *     [--slippage 0.1] [--loop <seconds> (default 300) | --once] [--skip <mint,...>] [--no-instant]
 *     [--max-subs 400] [--min-liquidity <XNT> (default 5)] [--own <wallet,...> [--own-min-profit <XNT>]]
 *     [--network mainnet|testnet] [--rpc <url>] [--verbose] [--webhook <url>] [--telegram-token <t> --telegram-chat <id>]
 *
 *   --skip           tokens another bot already watches (e.g. the arb bot's --mint list): not used as the main token
 *   --min-liquidity  only watch triangles whose two XNT pools each hold at least this much XNT
 *   --max-subs       at most this many pool vaults are watched live (the most liquid triangles first)
 *
 * Every --loop seconds it reads all of XDEX (every pool, vault, fee config and mint, in batches of 100).
 * Between those full reads it subscribes to the vaults of the watched triangles' pools and re-prices the
 * triangles a changed pool belongs to the moment the change arrives (the new balance comes with the
 * notification, no extra request), so a gap is answered within a second or so. Before trading it re-reads
 * the pools involved, so a trade is never based on a stale notification. --no-instant: full reads only.
 *
 * A route only counts when its profit covers the minimum plus the rent of the token accounts the wallet
 * would still need for it (about 0.0021 XNT each). Paying routes that share no pool go out together.
 *
 * Token safety: a triangle is skipped when either token has a freeze authority, a transfer hook, a
 * permanent delegate, a pause switch, non-transferable or default-frozen accounts, or a transfer fee
 * above 10%.
 */
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountState, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TransferFeeConfig, getDefaultAccountState, getExtensionTypes,
  getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { XDEX_PROGRAM_IDS, loadKeypair } from "../src/config.js";
import { createEngine, routesFor, type Route } from "../src/arb-engine.js";
import { symbolOf } from "../src/pools.js";
import { decodePool, snapshotMany, type Pool, type Snapshot, type SnapshotSpec } from "../src/xdex.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10] [--slippage 0.1]\n"
    + "         [--loop <seconds> | --once] [--skip <mint,...>] [--no-instant] [--max-subs 400] [--min-liquidity 5]\n"
    + "         [--own <wallet,...> [--own-min-profit <XNT>]] [--network mainnet|testnet] [--rpc <url>] [--verbose] (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const num = (name: string, d: number) => { const x = flag(name); if (x === undefined) return d; const n = Number(x); if (!Number.isFinite(n) || n < 0) usage(`--${name} takes a number`); return n; };
const lamports = (x: number) => BigInt(Math.round(x * 1e9));
const network = flag("network") ?? "mainnet";
if (!XDEX_PROGRAM_IDS[network]) usage("--network is mainnet or testnet");
const xdex = new PublicKey(XDEX_PROGRAM_IDS[network]);
const conn = new Connection(flag("rpc") ?? `https://rpc.${network}.x1.xyz`, "confirmed");
const wallet = loadKeypair(flag("keypair") ?? usage("--keypair is required"));
const execute = has("execute");
const minProfit = lamports(num("min-profit", 0.02));
const maxIn = lamports(num("max-in", 10));
const slipBps = BigInt(Math.round(num("slippage", 0.1) * 100));
const loopSecs = has("once") ? 0 : num("loop", 300);
const skip = new Set((flag("skip") ?? "").split(",").filter(Boolean));
const instant = !has("no-instant") && loopSecs > 0;
const maxSubs = num("max-subs", 400);
const minLiq = lamports(num("min-liquidity", 5));
const own = (flag("own") ?? "").split(",").filter(Boolean).map((w) => new PublicKey(w));
const ownMinProfit = flag("own-min-profit") !== undefined ? lamports(num("own-min-profit", 0)) : undefined;
const verbose = has("verbose");
const webhook = flag("webhook");
const envTg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
const tgToken = flag("telegram-token") ?? (envTg ? process.env.TELEGRAM_BOT_TOKEN : undefined);
const tgChat = flag("telegram-chat") ?? (envTg ? process.env.TELEGRAM_CHAT_ID : undefined);
const ACCOUNT_RENT = 2_100_000n;

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
async function alert(text: string) {
  log(text);
  const posts: Promise<unknown>[] = [];
  if (webhook) posts.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[arb scan] ${text}` }), signal: AbortSignal.timeout(10_000) }));
  if (tgToken) posts.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `[arb scan] ${text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }));
  for (const r of await Promise.allSettled(posts)) if (r.status === "rejected") log(`alert delivery failed: ${msg(r.reason)}`);
}
const engine = createEngine({ conn, xdex, wallet, minProfit, ownMinProfit, own, maxIn, slipBps, reserve: lamports(0.1), priority: 1000,
  stateDir: process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state"), log, alert });

const X = NATIVE_MINT.toBase58();
const NO_FEE: TransferFeeConfig = {
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
  newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
};

// ---------- the market, as of the last full read (vault balances kept live by subscriptions) ----------
interface P { pool: Pool; mints: [string, string]; owed: [bigint, bigint]; rate: bigint; vault: [bigint, bigint] }
interface Tri { T: string; Q: string; main: string; side: string; quote: string; liq: bigint }
let pools = new Map<string, P>();
let tax = new Map<string, TransferFeeConfig>();
let tris: Tri[] = [];
let byPool = new Map<string, number[]>();
let epoch = 0n;
const symbols = new Map<string, string>();
const name = async (m: string) => { if (!symbols.has(m)) symbols.set(m, await symbolOf(conn, new PublicKey(m))); return symbols.get(m)!; };

async function many(keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) { out.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")); await new Promise((r) => setTimeout(r, 150)); }
  return out;
}

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

/** Read all of XDEX and rebuild the triangles worth watching. */
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
  // Each token's deepest XNT pool, then every triangle through one of its other pools.
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
      if (!m || !q || skip.has(T)) continue;
      const k = [m, a, q].sort().join();
      if (seen.has(k)) continue;
      seen.add(k);
      if (bad.has(T) || bad.has(Q)) { unsafeSkipped++; continue; }
      const liq = xntIn(pools.get(m)!) < xntIn(pools.get(q)!) ? xntIn(pools.get(m)!) : xntIn(pools.get(q)!);
      if (liq < minLiq) continue;
      out.push({ T, Q, main: m, side: a, quote: q, liq });
    }
  }
  tris = out.sort((x, y) => Number(y.liq - x.liq));
  byPool = new Map();
  tris.forEach((t, i) => { for (const k of [t.main, t.side, t.quote]) byPool.set(k, [...(byPool.get(k) ?? []), i]); });
  return { pools: pools.size, triangles: tris.length, unsafeSkipped, unsafeTokens: bad.size };
}

/** A pool's snapshot from the in-memory market (token side `mint`). */
function snap(addr: string, mint: string): Snapshot {
  const p = pools.get(addr)!, side = p.mints.indexOf(mint);
  return { pool: p.pool, side, quoteMint: p.pool.mints[1 - side], reserveToken: p.vault[side] - p.owed[side], reserveQuote: p.vault[1 - side] - p.owed[1 - side],
    tradeFeeRate: p.rate, feeCfg: tax.get(mint)!, epoch };
}
async function routesOf(t: Tri, get: (addr: string, mint: string) => Snapshot | undefined): Promise<Route[]> {
  const main = get(t.main, t.T), side = get(t.side, t.T), quote = get(t.quote, t.Q);
  if (!main || !side || !quote) return [];
  engine.learnFees([main, side, quote]);
  return routesFor({ mint: new PublicKey(t.T), symbol: await name(t.T), main, sides: [{ name: `${await name(t.T)}/${await name(t.Q)}`, side, quote, quoteMint: new PublicKey(t.Q) }] }, false);
}

/** Price these triangles from memory; re-read the paying ones fresh, re-price, and trade them. */
async function evaluate(idx: number[]) {
  const routes: Route[] = [];
  for (const i of idx) routes.push(...await routesOf(tris[i], (a, m) => snap(a, m)));
  const paying = (await engine.bestAll(routes)).filter((p) => p.pays);
  if (!paying.length) return 0;
  // Fresh read of every pool involved, then the same pricing again, with new-account rent counted.
  const keys = new Set<string>();
  for (const p of paying) for (const h of p.plan.route.hops) keys.add(`${h.snap.pool.address.toBase58()}|${h.snap.pool.mints[h.snap.side].toBase58()}`);
  const specs: SnapshotSpec[] = [...keys].map((k) => { const [pool, mint] = k.split("|"); return { pool: new PublicKey(pool), mint: new PublicKey(mint), quote: null }; });
  const fresh = await snapshotMany(conn, xdex, specs, epoch);
  const freshRoutes: Route[] = [];
  const sides = new Set(paying.map((p) => p.plan.route.mispriced[0].toBase58()));
  for (const i of idx) if (sides.has(tris[i].side)) freshRoutes.push(...await routesOf(tris[i], (a, m) => fresh.get(`${a}:${m}`)));
  const ok = [];
  for (const p of (await engine.bestAll(freshRoutes)).filter((x) => x.pays)) {
    const rent = ACCOUNT_RENT * BigInt((await engine.missingAccounts([p.plan.route])).length);
    if (p.plan.profit >= p.plan.minProfit + rent) ok.push(p);
    else if (verbose) log(`${p.plan.route.name}: +${xnt(p.plan.profit)} doesn't cover ${xnt(rent)} of new-account rent`);
  }
  if (!ok.length) return 0;
  if (!execute) {
    for (const p of ok) log(`[dry run] ${engine.describe(p.plan)}: ${xnt(p.plan.xntIn)} XNT -> +${xnt(p.plan.profit)}${p.ownShare >= 0.5 ? ` (${Math.round(p.ownShare * 100)}% your own pool)` : ""}`);
    return ok.length;
  }
  return engine.execute(ok);
}

// ---------- live: vault notifications re-price the triangles they touch ----------
const subs = new Map<string, number>();
const dirty = new Set<string>();
let running = false, timer: NodeJS.Timeout | null = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (running) { schedule(); return; }
    running = true;
    const idx = [...new Set([...dirty].flatMap((p) => byPool.get(p) ?? []))];
    dirty.clear();
    try { if (idx.length) await evaluate(idx); } catch (e) { log(`live check failed: ${msg(e)}`); }
    running = false;
    if (dirty.size) schedule();
  }, 300);
}
function watch() {
  const want = new Map<string, { pool: string; i: 0 | 1 }>();
  for (const t of tris) {
    for (const a of [t.main, t.side, t.quote]) {
      const p = pools.get(a)!;
      want.set(p.pool.vaults[0].toBase58(), { pool: a, i: 0 });
      want.set(p.pool.vaults[1].toBase58(), { pool: a, i: 1 });
    }
    if (want.size >= maxSubs) break;
  }
  for (const [v, w] of want) {
    if (subs.has(v)) continue;
    subs.set(v, conn.onAccountChange(new PublicKey(v), (info) => {
      const p = pools.get(w.pool);
      if (!p || info.data.length < 72) return;
      p.vault[w.i] = info.data.readBigUInt64LE(64);
      dirty.add(w.pool);
      schedule();
    }, { commitment: "confirmed" }));
  }
  for (const [v, id] of subs) if (!want.has(v)) { conn.removeAccountChangeListener(id).catch(() => undefined); subs.delete(v); }
  return want.size;
}

async function main() {
  log(`arb scan ${execute ? "LIVE" : "dry run"} on ${network}: routes paying +${xnt(minProfit)} XNT up to ${xnt(maxIn)} XNT in`
    + `${skip.size ? `, skipping ${skip.size} token(s)` : ""}, full read ${loopSecs ? `every ${loopSecs}s` : "once"}${instant ? ", live between reads" : ""}`);
  for (;;) {
    try {
      const r = await fullRead();
      const watched = instant ? watch() : 0;
      log(`read ${r.pools} pools: ${r.triangles} triangles with ${num("min-liquidity", 5)}+ XNT on both XNT pools`
        + ` (${r.unsafeSkipped} skipped for risky tokens: ${r.unsafeTokens} tokens flagged)${instant ? `, ${watched} vaults watched live` : ""}`);
      running = true;
      const n = await evaluate(tris.map((_, i) => i));
      running = false;
      if (!n && verbose) log("nothing pays right now");
    } catch (e) { running = false; log(`full read failed: ${msg(e)}`); }
    if (!loopSecs) return;
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
  }
}
await main();
