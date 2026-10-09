/**
 * Pool arbitrage bot: when a token's side pool (TOKEN/JACK, TOKEN/USDC.X, ...) drifts far
 * enough from its main XNT pool (or from another side pool) that a round trip pays after every
 * fee and tax, it trades the round trip and pockets the difference in XNT. Pricing, sizing and
 * sending live in src/arb-engine.ts (shared with scripts/arb-scan.ts).
 *
 *   npx tsx scripts/arb-bot.ts --mint <token mint> [--mint <another> ...] --keypair <wallet.json>
 *     [--execute] [--network mainnet|testnet] [--rpc <url>] [--min-profit 0.02] [--max-in 2]
 *     [--slippage 0.1] [--priority <micro-lamports per CU> (default 1000)] [--race-priority <µL/CU> (default 1000000)]
 *     [--own <wallet,...> [--own-min-profit <XNT>]] [--no-pairs]
 *     [--scan [--scan-loop 300] [--min-liquidity 5] [--max-subs 400] [--hubs 3] [--hub-sides 12]]
 *     [--loop <seconds> (default 20) | --once] [--no-instant] [--clean-every <hours> (default 6, 0 = off)]
 *     [--cap <XNT> --skim-to <wallet>] [--low <XNT> (default 1)] [--verbose] [--webhook <url>]
 *     [--telegram-token <bot token> --telegram-chat <chat id> | env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
 *   npx tsx scripts/arb-bot.ts --mint <token mint> --keypair <wallet.json> --setup   (open the token accounts and lookup table)
 *   npx tsx scripts/arb-bot.ts --keypair <wallet.json> --sweep [--execute]
 *       (sell the leftovers: every token the wallet holds besides XNT, through its deepest XNT pool)
 *   npx tsx scripts/arb-bot.ts --keypair <wallet.json> --close-dust [--keep <mint,...>] [--execute]
 *       (burn token balances worth under 0.001 XNT, too small to sell, and close their accounts to get
 *        the ~0.002 XNT rent each back; empty accounts and --keep tokens are left open for the routes)
 *   npx tsx scripts/arb-bot.ts --keypair <wallet.json> --unwrap   (wrapped XNT back to plain XNT)
 *
 * Routes, for each --mint (one wallet, one process; a route two tokens share is checked once):
 *   triangles   XNT -> Q (Q/XNT) -> token (side pool) -> XNT (main pool), and the reverse
 *   side pairs  XNT -> Qa (Qa/XNT) -> token (side pool a) -> Qb (side pool b) -> XNT (Qb/XNT), for
 *               every two side pools (four swaps; through the wallet's address lookup table). --no-pairs
 *               turns these off.
 * Each route is sized to its most profitable stake up to --max-in. A trade is simulated first and only
 * sent if the simulation passes (a gap someone else took costs nothing), and its last swap must return
 * the stake plus the minimum profit, so a trade that moved against you fails as a whole: a missed trade
 * costs its network fee at most, never the stake. Paying routes that share no pool are sent together.
 *
 * --scan also runs the XDEX-wide scanner (src/arb-scanner.ts: every other token's triangles, plus four-swap
 * routes through the busiest hub tokens) in this same process, on this same engine: one wallet and one
 * queue of trades, so the bot and the scanner never send through the same pool at once. Triangles through
 * the --mint tokens are left to the bot's own loop.
 *
 * Your own pools: --own lists your wallets; a route whose mispriced pools are mostly their liquidity
 * (LP held, or locked in the 8N4E… locker) mostly moves your own money, so --own-min-profit (default:
 * --min-profit) can hold it to a higher bar. Every trade is logged with its own-pool share.
 *
 * Speed: besides the --loop timer, the bot subscribes to every route's pool vaults and checks the moment
 * one changes (a trade landed); after a trade it checks again straight away. --no-instant turns the
 * subscriptions off. Each check reads every pool it watches in two batched requests.
 *
 * Upkeep (with --execute): every --clean-every hours it runs --sweep and then --close-dust (keeping the
 * route tokens' accounts open). With --cap and --skim-to it keeps the wallet at about --cap XNT, sending
 * anything above it to --skim-to (checked every 10 minutes); it alerts when the wallet holds under --low XNT.
 *
 * Working balance: the wallet trades out of its wrapped-XNT account, topped up from plain XNT as needed
 * (keeping --reserve, default 0.1, unwrapped for fees). Every trade is logged to state/arb-trades.jsonl.
 */
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction, createCloseAccountInstruction, createHarvestWithheldTokensToMintInstruction, createSyncNativeInstruction,
} from "@solana/spl-token";
import { XDEX_PROGRAM_IDS, loadKeypair } from "../src/config.js";
import { gapPct } from "../src/arb.js";
import { createEngine, routesFor, type Route } from "../src/arb-engine.js";
import { createScanner } from "../src/arb-scanner.js";
import { deepestXntPool, poolsWith, symbolOf } from "../src/pools.js";
import { cpmmOut, snapshot, snapshotMany, swapIx, type Snapshot, type SnapshotSpec } from "../src/xdex.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/arb-bot.ts --mint <token mint> --keypair <wallet.json> [--execute] [--network mainnet|testnet] [--rpc <url>]\n"
    + "         [--min-profit 0.02] [--max-in 2] [--slippage 0.1] [--reserve 0.1] [--priority 1000] [--loop <seconds> | --once]\n"
    + "         [--own <wallet,...> [--own-min-profit <XNT>]] [--no-pairs] [--no-instant] [--clean-every <hours>]\n"
    + "         [--scan [--scan-loop 300] [--min-liquidity 5] [--max-subs 400] [--hubs 3] [--hub-sides 12]]\n"
    + "         [--cap <XNT> --skim-to <wallet>] [--low <XNT>] [--verbose] [--webhook <url>] [--telegram-token <token> --telegram-chat <id>]\n"
    + "       npx tsx scripts/arb-bot.ts --keypair <wallet.json> --sweep | --close-dust | --unwrap (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const num = (name: string, d: number) => { const x = flag(name); if (x === undefined) return d; const n = Number(x); if (!Number.isFinite(n) || n < 0) usage(`--${name} takes a number`); return n; };
const lamports = (x: number) => BigInt(Math.round(x * 1e9));

const network = flag("network") ?? "mainnet";
if (!XDEX_PROGRAM_IDS[network]) usage("--network is mainnet or testnet");
const xdex = new PublicKey(XDEX_PROGRAM_IDS[network]);
const conn = new Connection(flag("rpc") ?? `https://rpc.${network}.x1.xyz`, "confirmed");
const wallet: Keypair = loadKeypair(flag("keypair") ?? usage("--keypair is required"));
const execute = has("execute");
const minProfit = lamports(num("min-profit", 0.02));
const maxIn = lamports(num("max-in", 2));
// The margin each middle swap keeps below its quote. The last swap's minimum (stake + minimum profit) is what
// protects the trip, so this only trades a little failure risk for profit: what it holds back is left in the
// wallet as leftover tokens (0.5% of a 5 XNT TEST trip is ~0.03 XNT, enough to make a paying trip look short).
const slipBps = BigInt(Math.round(num("slippage", 0.1) * 100));
const reserve = lamports(num("reserve", 0.1));
const priority = num("priority", 1000);
// When another trader is racing for a pool (a trade through it just failed or vanished), pay more to land first:
// 1,000,000 µL/CU on a ~150k-CU trade is ~0.00015 XNT.
const racePriority = num("race-priority", 1_000_000);
const loopSecs = has("once") ? 0 : num("loop", 20);
const own = (flag("own") ?? "").split(",").filter(Boolean).map((w) => new PublicKey(w));
const ownMinProfit = flag("own-min-profit") !== undefined ? lamports(num("own-min-profit", 0)) : undefined;
const pairs = !has("no-pairs");
const webhook = flag("webhook");
if (!!flag("telegram-token") !== !!flag("telegram-chat")) usage("Telegram needs both --telegram-token and --telegram-chat");
const envTg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
const tgToken = flag("telegram-token") ?? (envTg ? process.env.TELEGRAM_BOT_TOKEN : undefined);
const tgChat = flag("telegram-chat") ?? (envTg ? process.env.TELEGRAM_CHAT_ID : undefined);
const instant = !has("no-instant");
const verbose = has("verbose");
const cleanEveryMs = num("clean-every", 6) * 3_600_000;
const cap = flag("cap") !== undefined ? lamports(num("cap", 0)) : null;
const skimTo = flag("skim-to") ? new PublicKey(flag("skim-to")!) : null;
const low = lamports(num("low", 1));
if ((cap === null) !== (skimTo === null)) usage("--cap and --skim-to go together");
if (cap !== null && cap < maxIn + reserve) usage("--cap must be at least --max-in + --reserve (the bot needs that much to trade)");
if (minProfit <= 0n) usage("--min-profit must be above 0 (it is what makes a trade that moved against you fail)");
if (ownMinProfit !== undefined && !own.length) usage("--own-min-profit needs --own <wallet,...>");
if (skimTo && skimTo.equals(wallet.publicKey)) usage("--skim-to is this wallet");

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const stateDir = process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state");

async function alert(text: string) {
  log(text);
  const posts: Promise<unknown>[] = [];
  if (webhook) posts.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[arb bot] ${text}` }), signal: AbortSignal.timeout(10_000) }));
  if (tgToken) posts.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `[arb bot] ${text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }));
  for (const r of await Promise.allSettled(posts)) if (r.status === "rejected") log(`alert delivery failed: ${msg(r.reason)}`);
}

const engine = createEngine({ conn, xdex, wallet, minProfit, ownMinProfit, own, maxIn, slipBps, reserve, priority, racePriority, stateDir, log, alert });
const { wxntAta, balanceOf, send } = engine;

if (has("unwrap")) {
  const bal = await balanceOf(wxntAta);
  if (bal === null) { log("no wrapped XNT account: nothing to unwrap"); process.exit(0); }
  const sig = await send([createCloseAccountInstruction(wxntAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)]);
  log(`unwrapped ${xnt(bal)} XNT to ${wallet.publicKey.toBase58()}: ${sig}`);
  process.exit(0);
}
const mints = argv.flatMap((a, i) => (a === "--mint" ? (argv[i + 1] ?? "").split(",") : [])).filter(Boolean).map((m) => new PublicKey(m));
if (!mints.length && !has("sweep") && !has("close-dust")) usage("--mint is required");

// ---------- pools (found on-chain, refreshed every 30 minutes) ----------
interface Side { pool: PublicKey; quoteMint: PublicKey; quotePool: PublicKey; name: string }
interface Found { at: number; mint: PublicKey; symbol: string; main: PublicKey; sides: Side[] }
const foundBy = new Map<string, Found>();

async function discover(mint: PublicKey) {
  const found = foundBy.get(mint.toBase58());
  if (found && Date.now() - found.at < 30 * 60_000) return found;
  const main = await deepestXntPool(conn, xdex, mint);
  if (!main) throw new Error(`no XNT pool holds ${mint.toBase58()}`);
  const symbol = await symbolOf(conn, mint);
  const sides: Side[] = [];
  for (const p of await poolsWith(conn, xdex, mint)) {
    const quoteMint = new PublicKey(p.data.subarray(8 + (p.side === 0 ? 6 : 5) * 32, 40 + (p.side === 0 ? 6 : 5) * 32));
    if (quoteMint.equals(NATIVE_MINT)) continue;
    const q = await deepestXntPool(conn, xdex, quoteMint);
    if (!q) continue;
    sides.push({ pool: p.address, quoteMint, quotePool: q.address, name: `${symbol}/${await symbolOf(conn, quoteMint)}` });
  }
  if (!found || found.sides.map((s) => s.pool.toBase58()).join() !== sides.map((s) => s.pool.toBase58()).join())
    log(`watching ${sides.length} side pool(s) against ${symbol}/XNT ${main.address.toBase58()}: ${sides.map((s) => s.name).join(", ") || "none"}`);
  const f: Found = { at: Date.now(), mint, symbol, main: main.address, sides };
  foundBy.set(mint.toBase58(), f);
  return f;
}

let epochCache: { at: number; epoch: bigint } | null = null;
async function epochNow() {
  if (!epochCache || Date.now() - epochCache.at > 10 * 60_000) epochCache = { at: Date.now(), epoch: BigInt((await conn.getEpochInfo("confirmed")).epoch) };
  return epochCache.epoch;
}
const key = (pool: PublicKey, mint: PublicKey) => `${pool.toBase58()}:${mint.toBase58()}`;

/** Every route of every watched token, from one batched read of all their pools. */
async function readRoutes() {
  const founds: Found[] = [];
  for (const mint of mints) founds.push(await discover(mint));
  const specs: SnapshotSpec[] = [];
  for (const f of founds) {
    specs.push({ pool: f.main, mint: f.mint, quote: NATIVE_MINT });
    for (const s of f.sides) specs.push({ pool: s.pool, mint: f.mint, quote: s.quoteMint }, { pool: s.quotePool, mint: s.quoteMint, quote: NATIVE_MINT });
  }
  // "processed": a swap is seen as soon as it lands (the trade's own checks still protect it).
  const snaps = await snapshotMany(conn, xdex, specs, await epochNow(), "processed");
  engine.learnFees(snaps.values());
  const routes: Route[] = [];
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const f of founds) {
    const main = snaps.get(key(f.main, f.mint));
    if (!main) { gaps.push(`${f.symbol}/XNT unreadable`); continue; }
    const sides = f.sides.flatMap((s) => {
      const side = snaps.get(key(s.pool, f.mint)), quote = snaps.get(key(s.quotePool, s.quoteMint));
      if (!side || !quote) return [];
      const g = gapPct({ main, side, quote });
      gaps.push(`${s.name} ${g >= 0 ? "+" : ""}${g.toFixed(2)}%`);
      return [{ name: s.name, side, quote, quoteMint: s.quoteMint }];
    });
    for (const r of routesFor({ mint: f.mint, symbol: f.symbol, main, sides }, pairs)) {
      // The same pools in the same order are the same trade: a triangle two watched tokens share
      // (TEST/GOOGL.X seen from either side) counts once, while opposite directions stay apart.
      const k = r.hops.map((h) => h.snap.pool.address.toBase58()).join(">");
      if (seen.has(k)) continue;
      seen.add(k);
      routes.push(r);
    }
  }
  return { snaps, routes, gaps };
}

// ---------- one pass ----------
let lastSummary = 0;

/** Price every route; trade (or, without --execute, report) the ones that pay. True once a trade was sent. */
async function pass(): Promise<boolean> {
  const { snaps, routes, gaps } = await readRoutes();
  if (instant && loopSecs) watchVaults(snaps);
  const priced = await engine.bestAll(routes);
  const paying = priced.filter((p) => p.pays);
  if (Date.now() - lastSummary >= 60_000 || !loopSecs) {
    const top = [...priced].sort((a, b) => Number(b.plan.profit - a.plan.profit))[0];
    log(`${gaps.join(" | ") || "no side pools"} || ${routes.length} routes, best ${top ? `${top.plan.route.name} ${top.plan.profit >= 0n ? "+" : ""}${xnt(top.plan.profit)} @ ${xnt(top.plan.xntIn)}` : "none"}`);
    lastSummary = Date.now();
  }
  if (!paying.length) return false;
  if (!execute) {
    for (const p of paying) {
      const missing = await engine.missingAccounts([p.plan.route]);
      const four = p.plan.route.hops.length > 3;
      const sim = missing.length ? null : await engine.simulate(engine.tripIxs(p.plan), four).catch(() => null);
      log(`[dry run] ${engine.describe(p.plan)}: ${xnt(p.plan.xntIn)} XNT -> ~${xnt(p.plan.xntOut)} (+${xnt(p.plan.profit)})`
        + `${p.ownShare >= 0.5 ? `, ${Math.round(p.ownShare * 100)}% your own pool` : ""}. `
        + (missing.length ? `Needs ${missing.length} new token account(s) (--execute opens them).` : !sim ? "Four swaps: run --setup first (lookup table)."
          : sim.err ? `Simulation failed: ${JSON.stringify(sim.err)}` : `Simulation OK: ${sim.units} CU, ${sim.bytes} bytes.`));
    }
    return false;
  }
  return (await engine.execute(paying)) > 0;
}

// ---------- instant checks: wake up when a watched pool's vault changes ----------
const subs = new Map<string, number>();
let wakePending = false;
let wakeNow: (() => void) | null = null;
function wake() { if (verbose && !wakePending) log("a watched pool changed: checking now"); wakePending = true; wakeNow?.(); }

/** Subscribe to the vaults of every pool just read (and drop pools no longer watched). */
function watchVaults(snaps: Map<string, Snapshot>) {
  const want = new Set<string>();
  for (const sn of snaps.values()) for (const v of sn.pool.vaults) want.add(v.toBase58());
  for (const k of want) if (!subs.has(k)) subs.set(k, conn.onAccountChange(new PublicKey(k), wake, { commitment: "processed" }));
  for (const [k, id] of subs) if (!want.has(k)) { conn.removeAccountChangeListener(id).catch(() => undefined); subs.delete(k); }
}

/** Until the timer runs out or (with instant checks) a watched vault changes; then a short pause so every vault a trade touched has updated. */
async function nextCheck(ms: number) {
  if (!wakePending) await new Promise<void>((r) => { const t = setTimeout(() => { wakeNow = null; r(); }, ms); wakeNow = () => { clearTimeout(t); wakeNow = null; r(); }; });
  if (wakePending) await new Promise((r) => setTimeout(r, 400));
  wakePending = false;
}

// ---------- upkeep: leftovers, wallet cap, low balance ----------
let lastLowAlert = 0;

/** Keep the wallet near --cap (sending the rest to --skim-to) and alert when it's under --low. */
async function capAndLow() {
  const plain = BigInt(await conn.getBalance(wallet.publicKey, "confirmed"));
  const wrapped = (await balanceOf(wxntAta)) ?? 0n;
  const total = plain + wrapped;
  if (total < low && Date.now() - lastLowAlert > 3_600_000) {
    lastLowAlert = Date.now();
    await alert(`wallet is low: ${xnt(total)} XNT (${xnt(plain)} plain + ${xnt(wrapped)} wrapped), under ${xnt(low)}; trades over that size will be skipped`);
  }
  if (cap === null || !skimTo || total <= cap + lamports(0.5)) return;
  const excess = total - cap;
  // From plain XNT when it has enough above the reserve; otherwise unwrap, re-wrap what the bot keeps
  // trading with (cap - reserve) and send the rest, all in one transaction (plain ends at the reserve).
  const keepWrapped = cap - reserve;
  const ixs = wrapped <= keepWrapped
    ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: skimTo, lamports: excess })]
    : [createCloseAccountInstruction(wxntAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wxntAta, wallet.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wxntAta, lamports: keepWrapped }),
      createSyncNativeInstruction(wxntAta, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: skimTo, lamports: excess })];
  if (!execute) { log(`[dry run] wallet holds ${xnt(total)} XNT: would send ${xnt(excess)} above the ${xnt(cap)} cap to ${skimTo.toBase58()}`); return; }
  try {
    await alert(`sent ${xnt(excess)} XNT above the ${xnt(cap)} XNT cap to ${skimTo.toBase58()}: ${await send(ixs)}`);
  } catch (e) {
    log(`cap: sending ${xnt(excess)} XNT to ${skimTo.toBase58()} failed: ${msg(e).split("\n")[0]}`);
  }
}

/** The route tokens' mints: their (possibly empty) accounts stay open through --close-dust. */
function routeMints() {
  const out = new Set<string>();
  for (const f of foundBy.values()) { out.add(f.mint.toBase58()); for (const s of f.sides) out.add(s.quoteMint.toBase58()); }
  return out;
}

/** XNT for selling all `amount` of a pool's token side into it (after its transfer fee and the pool fee), and the minimum to ask. */
function sellQuote(s: Snapshot, amount: bigint) {
  const net = amount - calculateEpochFee(s.feeCfg, s.epoch, amount);
  const out = cpmmOut(net, s.reserveToken, s.reserveQuote, s.tradeFeeRate);
  return { out, minOut: (out * (10_000n - slipBps)) / 10_000n };
}

/**
 * Sell every token the wallet holds besides XNT (the slippage leftovers trips leave behind) into
 * its deepest XNT pool. The proceeds land in the wrapped-XNT trading balance. Amounts worth under
 * 0.001 XNT are left alone (the fee would eat them); without --execute it only says what it would do.
 */
async function sweep() {
  const MIN_OUT = lamports(0.001);
  const held = (await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
    conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, "confirmed")))).flatMap((r) => r.value);
  let total = 0n;
  for (const a of held) {
    const info = a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
    const m = new PublicKey(info.mint), amount = BigInt(info.tokenAmount.amount);
    if (m.equals(NATIVE_MINT) || amount === 0n) continue;
    const sym = await symbolOf(conn, m);
    const pool = await deepestXntPool(conn, xdex, m);
    if (!pool) { log(`sweep: ${sym} has no XNT pool, kept`); continue; }
    const snap = await snapshot(conn, xdex, pool.address, m);
    const q = sellQuote(snap, amount);
    if (q.out < MIN_OUT) { log(`sweep: ${sym} ${info.tokenAmount.amount} raw is worth ~${xnt(q.out)} XNT, under ${xnt(MIN_OUT)}: kept`); continue; }
    const ix = swapIx(xdex, wallet.publicKey, { pool: snap.pool, side: snap.side, amountIn: amount, minimumOut: q.minOut }, a.pubkey, wxntAta);
    if (!execute) { log(`[dry run] sweep: sell all ${sym} for ~${xnt(q.out)} XNT (after its transfer fee and the pool fee)`); total += q.out; continue; }
    try {
      log(`sweep: sold all ${sym} for ~${xnt(q.out)} XNT: ${await send([ix])}`);
      total += q.out;
    } catch (e) {
      log(`sweep: ${sym} didn't sell: ${msg(e).split("\n")[0]}`);
    }
  }
  log(`sweep ${execute ? "done" : "(dry run)"}: ~${xnt(total)} XNT into the wrapped trading balance`);
}

/**
 * Token accounts holding dust worth under 0.001 XNT (or a token with no XNT pool at all): burn the
 * dust, move any transfer tax withheld in the account to its mint (Token-2022 won't close an account
 * that still holds some), and close the account, which returns its rent (~0.002 XNT) to the wallet.
 * Empty accounts stay open (the bot keeps those for its routes), and so do --keep tokens and wrapped
 * XNT. Up to three accounts per transaction; without --execute it only says what it would do.
 */
async function closeDust(extraKeep: Set<string> = new Set()) {
  const MIN_OUT = lamports(0.001);
  const keep = new Set([...(flag("keep") ?? "").split(",").filter(Boolean), ...extraKeep]);
  type Parsed = { mint: string; tokenAmount: { amount: string; decimals: number }; extensions?: { extension: string; state: { withheldAmount?: number | string } }[] };
  const held = (await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(async (programId) =>
    (await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }, "confirmed")).value.map((a) => ({ ...a, programId }))))).flat();
  const batch: { sym: string; rent: number; ixs: TransactionInstruction[] }[] = [];
  for (const a of held) {
    const info = a.account.data.parsed.info as Parsed;
    const m = new PublicKey(info.mint), amount = BigInt(info.tokenAmount.amount);
    if (m.equals(NATIVE_MINT) || amount === 0n || keep.has(info.mint)) continue;
    const sym = await symbolOf(conn, m);
    const pool = await deepestXntPool(conn, xdex, m);
    if (pool) {
      const out = sellQuote(await snapshot(conn, xdex, pool.address, m), amount).out;
      if (out >= MIN_OUT) { log(`close-dust: ${sym} is worth ~${xnt(out)} XNT, kept (--sweep sells it)`); continue; }
    }
    const ixs = [createBurnCheckedInstruction(a.pubkey, m, wallet.publicKey, amount, info.tokenAmount.decimals, [], a.programId)];
    const withheld = info.extensions?.find((e) => e.extension === "transferFeeAmount")?.state.withheldAmount;
    if (withheld && BigInt(withheld) > 0n) ixs.push(createHarvestWithheldTokensToMintInstruction(m, [a.pubkey], a.programId));
    ixs.push(createCloseAccountInstruction(a.pubkey, wallet.publicKey, wallet.publicKey, [], a.programId));
    batch.push({ sym, rent: a.account.lamports, ixs });
  }
  if (!batch.length) { log("close-dust: no dust accounts"); return; }
  const rent = batch.reduce((t, b) => t + b.rent, 0);
  log(`close-dust: ${batch.length} account(s): ${batch.map((b) => b.sym).join(", ")}; ~${(rent / 1e9).toFixed(4)} XNT of rent comes back`);
  if (!execute) { log("close-dust (dry run): add --execute to burn the dust and close them"); return; }
  for (let i = 0; i < batch.length; i += 3) {
    const part = batch.slice(i, i + 3);
    try {
      log(`close-dust: closed ${part.map((b) => b.sym).join(", ")}: ${await send(part.flatMap((b) => b.ixs))}`);
    } catch (e) {
      log(`close-dust: ${part.map((b) => b.sym).join(", ")} not closed: ${msg(e).split("\n")[0]}`);
    }
  }
}

async function main() {
  if (has("sweep")) return sweep();
  if (has("close-dust")) return closeDust();
  if (has("setup")) {
    // Every account and lookup-table entry any route could need, so dry runs can simulate the real transactions.
    const { routes } = await readRoutes();
    log(`setup: ${await engine.openAccounts(routes)} token account(s) opened`);
    if (pairs && routes.some((r) => r.hops.length > 3)) { await engine.ensureAlt(routes.filter((r) => r.hops.length > 3)); log("setup: lookup table ready"); }
    log("setup done");
    return;
  }
  const plain = await conn.getBalance(wallet.publicKey, "confirmed");
  log(`arb bot ${execute ? "LIVE" : "dry run"}: ${mints.map((m) => m.toBase58()).join(", ")} on ${network}, wallet ${wallet.publicKey.toBase58()} `
    + `(${xnt(BigInt(plain))} XNT + ${xnt((await balanceOf(wxntAta)) ?? 0n)} wrapped), trades up to ${xnt(maxIn)} XNT when a trip pays +${xnt(minProfit)}`
    + `${ownMinProfit !== undefined ? ` (+${xnt(ownMinProfit)} on your own pools)` : ""}${pairs ? ", side-pool pairs on" : ""}, `
    + `${loopSecs ? `every ${loopSecs}s${instant ? " and the moment a watched pool changes" : ""}` : "once"}`
    + `${execute && loopSecs && cleanEveryMs ? `, cleans leftovers every ${cleanEveryMs / 3_600_000}h` : ""}${cap !== null ? `, keeps ~${xnt(cap)} XNT (rest to ${skimTo!.toBase58()})` : ""}`);
  if (has("scan")) {
    const scanLoop = has("once") ? 0 : num("scan-loop", 300);
    const scanner = createScanner({ conn, xdex, engine, execute, skip: new Set(mints.map((m) => m.toBase58())),
      minLiquidity: lamports(num("min-liquidity", 5)), maxSubs: num("max-subs", 400), loopSecs: scanLoop, instant: instant && scanLoop > 0,
      hubs: num("hubs", 3), hubSides: num("hub-sides", 12), verbose, log });
    log(`scan: on, in this process (full read ${scanLoop ? `every ${scanLoop}s, live between reads` : "once"})`);
    // Runs alongside the loop below; both trade through the engine's one queue.
    void scanner.start().catch((e) => log(`scan stopped: ${msg(e)}`));
  }
  if (loopSecs) engine.warm();
  let lastClean = Date.now(), lastCap = 0, streak = 0;
  for (;;) {
    let traded = false;
    try { traded = await pass(); } catch (e) { log(`pass failed: ${msg(e)}`); }
    if (!loopSecs) return;
    if (Date.now() - lastCap >= 10 * 60_000) { lastCap = Date.now(); await capAndLow().catch((e) => log(`cap check failed: ${msg(e)}`)); }
    if (execute && cleanEveryMs && Date.now() - lastClean >= cleanEveryMs) {
      lastClean = Date.now();
      log("upkeep: selling leftovers and closing dust accounts");
      await sweep().catch((e) => log(`sweep failed: ${msg(e)}`));
      await closeDust(routeMints()).catch((e) => log(`close-dust failed: ${msg(e)}`));
    }
    // After a trade, check again straight away (a swing usually takes a few trips); at most 30 in a row.
    if (traded && ++streak <= 30) continue;
    streak = 0;
    await nextCheck(loopSecs * 1000);
  }
}
await main();
