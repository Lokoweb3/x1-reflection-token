/**
 * Pool arbitrage bot: when a token's side pool (TOKEN/JACK, TOKEN/USDC.X, ...) drifts far
 * enough from its main XNT pool that a round trip pays after every fee and tax, it trades the
 * round trip and pockets the difference in XNT. The maths is src/arb.ts (shared with the gap
 * monitor); this sends the trades.
 *
 *   npx tsx scripts/arb-bot.ts --mint <token mint> [--mint <another> ...] --keypair <wallet.json>
 *     [--execute] [--network mainnet|testnet] [--rpc <url>] [--min-profit 0.02] [--max-in 2]
 *     [--slippage 0.1] [--priority <micro-lamports per CU> (default 1000)]
 *     [--loop <seconds> (default 20) | --once] [--webhook <url>]
 *     [--telegram-token <bot token> --telegram-chat <chat id> | env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
 *   npx tsx scripts/arb-bot.ts --mint <token mint> --keypair <wallet.json> --setup   (only open the token accounts)
 *   npx tsx scripts/arb-bot.ts --mint <token mint> --keypair <wallet.json> --sweep [--execute]
 *       (sell the leftovers: every token the wallet holds besides XNT, through its deepest XNT pool)
 *   npx tsx scripts/arb-bot.ts --keypair <wallet.json> --unwrap   (wrapped XNT back to plain XNT)
 *
 * Each --mint (or a comma-separated list) is watched against its own deepest XNT pool, all from
 * one wallet in one process; a triangle two of them share (TOKEN/GOOGL.X seen from either side) is
 * checked once a pass.
 *
 * Without --execute it only says what it would trade (and simulates it when the wallet is
 * set up). With it, one round trip is ONE transaction of three swaps:
 *   "buy side":  XNT -> Q (Q/XNT pool) -> token (side pool) -> XNT (main pool)
 *   "buy main":  XNT -> token (main pool) -> Q (side pool) -> XNT (Q/XNT pool)
 * The last swap's minimum output is the XNT put in plus --min-profit, so if prices move
 * before it lands the whole transaction fails and nothing is traded: a missed trade costs
 * its network fee, never the stake. Each swap after the first spends the previous swap's
 * minimum output, so a little slippage on the way leaves dust in the wallet rather than
 * failing the trip.
 *
 * Working balance: the wallet trades out of its wrapped-XNT account. Before a trip it tops
 * that up from plain XNT if needed, keeping --reserve (default 0.1) XNT unwrapped for fees;
 * profits stay wrapped until --unwrap. The first --execute run opens the wallet's token
 * accounts (wrapped XNT, the token, each pair token) in a setup transaction.
 * Every trade is logged to state/arb-trades.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TransferFeeConfig, calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { XDEX_PROGRAM_IDS, loadKeypair } from "../src/config.js";
import { gapPct } from "../src/arb.js";
import { deepestXntPool, poolsWith, symbolOf } from "../src/pools.js";
import { cpmmOut, snapshot, swapIx, type Snapshot } from "../src/xdex.js";
import { confirmByPolling, fitComputeLimit } from "../src/tx.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/arb-bot.ts --mint <token mint> --keypair <wallet.json> [--execute] [--network mainnet|testnet] [--rpc <url>]\n"
    + "         [--min-profit 0.02] [--max-in 2] [--slippage 0.1] [--reserve 0.1] [--priority 1000] [--loop <seconds> | --once]\n"
    + "         [--webhook <url>] [--telegram-token <token> --telegram-chat <id>]\n"
    + "       npx tsx scripts/arb-bot.ts --keypair <wallet.json> --unwrap (see the file's header)");
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
// The margin each middle swap keeps below its quote. The last swap's minimum (stake + --min-profit) is what
// protects the trip, so this only trades a little failure risk for profit: what it holds back is left in the
// wallet as leftover tokens (0.5% of a 5 XNT TEST trip is ~0.03 XNT, enough to make a paying trip look short).
const slipBps = BigInt(Math.round(num("slippage", 0.1) * 100));
const reserve = lamports(num("reserve", 0.1));
const priority = num("priority", 1000);
const loopSecs = has("once") ? 0 : num("loop", 20);
const webhook = flag("webhook");
if (!!flag("telegram-token") !== !!flag("telegram-chat")) usage("Telegram needs both --telegram-token and --telegram-chat");
const envTg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
const tgToken = flag("telegram-token") ?? (envTg ? process.env.TELEGRAM_BOT_TOKEN : undefined);
const tgChat = flag("telegram-chat") ?? (envTg ? process.env.TELEGRAM_CHAT_ID : undefined);
if (minProfit <= 0n) usage("--min-profit must be above 0 (it is what makes a trade that moved against you fail)");

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const JOURNAL = path.join(process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state"), "arb-trades.jsonl");

async function alert(text: string) {
  log(text);
  const posts: Promise<unknown>[] = [];
  if (webhook) posts.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[arb bot] ${text}` }), signal: AbortSignal.timeout(10_000) }));
  if (tgToken) posts.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `[arb bot] ${text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }));
  for (const r of await Promise.allSettled(posts)) if (r.status === "rejected") log(`alert delivery failed: ${msg(r.reason)}`);
}

// ---------- wrapped XNT ----------
const wxntAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey, false, TOKEN_PROGRAM_ID);
const balanceOf = async (ata: PublicKey) => {
  const b = await conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return b ? BigInt(b.value.amount) : null;
};

/** Send `ixs` as one v0 transaction (compute limit fitted by simulation) and wait for it. */
async function send(ixs: TransactionInstruction[]) {
  const fitted = await fitComputeLimit(conn, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs], wallet.publicKey);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: fitted }).compileToV0Message());
  tx.sign([wallet]);
  const raw = tx.serialize();
  const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 3 });
  await confirmByPolling(conn, raw, signature, lastValidBlockHeight);
  return signature;
}

async function simulate(ixs: TransactionInstruction[]) {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message());
  const bytes = tx.serialize().length;
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  return { bytes, err: sim.value.err, units: sim.value.unitsConsumed, logs: sim.value.logs ?? [] };
}

if (has("unwrap")) {
  const bal = await balanceOf(wxntAta);
  if (bal === null) { log("no wrapped XNT account: nothing to unwrap"); process.exit(0); }
  const sig = await send([createCloseAccountInstruction(wxntAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID)]);
  log(`unwrapped ${xnt(bal)} XNT to ${wallet.publicKey.toBase58()}: ${sig}`);
  process.exit(0);
}
const mints = argv.flatMap((a, i) => (a === "--mint" ? (argv[i + 1] ?? "").split(",") : [])).filter(Boolean).map((m) => new PublicKey(m));
if (!mints.length && !has("sweep")) usage("--mint is required");

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

// ---------- planning ----------
/** One swap: sell `amountIn` of `pool.mints[inSide]`, receive at least `minOut` (net of the output's transfer fee). */
interface Swap { snap: Snapshot; inSide: number; amountIn: bigint; out: bigint; minOut: bigint }
interface Plan { dir: "buy-side" | "buy-main"; xntIn: bigint; swaps: Swap[]; xntOut: bigint; profit: bigint }

const NO_FEE = null;
const fee = (cfg: TransferFeeConfig | null, epoch: bigint, a: bigint) => (cfg ? calculateEpochFee(cfg, epoch, a) : 0n);
const haircut = (a: bigint) => (a * (10_000n - slipBps)) / 10_000n;

/** A swap in `s` (its "token" side is `s.pool.mints[s.side]`), selling the token side or the pair side. */
function swap(s: Snapshot, sellTokenSide: boolean, amountIn: bigint, inFee: TransferFeeConfig | null, outFee: TransferFeeConfig | null): Swap {
  const net = amountIn - fee(inFee, s.epoch, amountIn);
  const [rIn, rOut] = sellTokenSide ? [s.reserveToken, s.reserveQuote] : [s.reserveQuote, s.reserveToken];
  const gross = cpmmOut(net, rIn, rOut, s.tradeFeeRate);
  const out = gross - fee(outFee, s.epoch, gross);
  return { snap: s, inSide: sellTokenSide ? s.side : 1 - s.side, amountIn, out, minOut: haircut(out) };
}

/** The three swaps of a round trip of `xntIn`, each spending the previous one's minimum output. */
function plan(main: Snapshot, side: Snapshot, quote: Snapshot, xntIn: bigint, dir: Plan["dir"]): Plan {
  const tax = main.feeCfg, qtax = quote.feeCfg; // the token's and Q's transfer fees
  const s: Swap[] = [];
  if (dir === "buy-side") {
    s.push(swap(quote, false, xntIn, NO_FEE, qtax)); // XNT in, Q out
    s.push(swap(side, false, s[0].minOut, qtax, tax)); // Q in, token out
    s.push(swap(main, true, s[1].minOut, tax, NO_FEE)); // token in, XNT out
  } else {
    s.push(swap(main, false, xntIn, NO_FEE, tax)); // XNT in, token out
    s.push(swap(side, true, s[0].minOut, tax, qtax)); // token in, Q out
    s.push(swap(quote, true, s[1].minOut, qtax, NO_FEE)); // Q in, XNT out
  }
  const xntOut = s[2].out;
  return { dir, xntIn, swaps: s, xntOut, profit: xntOut - xntIn };
}

/** The most profitable trip up to --max-in, both directions (profit is concave in size). */
function best(main: Snapshot, side: Snapshot, quote: Snapshot): Plan {
  let b: Plan | null = null;
  for (const dir of ["buy-side", "buy-main"] as const)
    for (let x = 10_000_000n; x <= maxIn; x = (x * 5n) / 4n) {
      const p = plan(main, side, quote, x, dir);
      if (!b || p.profit > b.profit) b = p;
    }
  return b!;
}

// ---------- instructions ----------
const ataOf = (m: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(m, wallet.publicKey, false, program);
const accountFor = (s: Snapshot, i: number) => (s.pool.mints[i].equals(NATIVE_MINT) ? wxntAta : ataOf(s.pool.mints[i], s.pool.programs[i]));

function tripIxs(p: Plan): TransactionInstruction[] {
  return p.swaps.map((w, i) => {
    const minimumOut = i === 2 ? p.xntIn + minProfit : w.minOut;
    return swapIx(xdex, wallet.publicKey, { pool: w.snap.pool, side: w.inSide, amountIn: w.amountIn, minimumOut },
      accountFor(w.snap, w.inSide), accountFor(w.snap, 1 - w.inSide));
  });
}

/** Token accounts the wallet needs for these pools, opened in one setup transaction. */
async function setup(snaps: Snapshot[], force = false) {
  const need = new Map<string, TransactionInstruction>();
  for (const s of snaps) for (const i of [0, 1]) {
    const m = s.pool.mints[i], prog = s.pool.programs[i], ata = accountFor(s, i);
    need.set(ata.toBase58(), createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, m, prog));
  }
  const infos = await conn.getMultipleAccountsInfo([...need.keys()].map((k) => new PublicKey(k)));
  const missing = [...need.values()].filter((_, i) => !infos[i]);
  if (!missing.length) return true;
  if (!execute && !force) return false;
  log(`setup: opening ${missing.length} token account(s)`);
  for (let i = 0; i < missing.length; i += 4) log(`setup: ${await send(missing.slice(i, i + 4))}`);
  return true;
}

/** Wrap enough XNT to cover `xntIn` (keeping --reserve unwrapped), or null if the wallet is short. */
async function topUp(xntIn: bigint): Promise<TransactionInstruction[] | null> {
  const wrapped = (await balanceOf(wxntAta)) ?? 0n;
  if (wrapped >= xntIn) return [];
  const plain = BigInt(await conn.getBalance(wallet.publicKey, "confirmed"));
  const short = xntIn - wrapped;
  if (plain - reserve < short) return null;
  return [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wxntAta, lamports: short }), createSyncNativeInstruction(wxntAta, TOKEN_PROGRAM_ID)];
}

// ---------- one pass ----------
async function pass() {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const mint of mints) {
    const traded = await passFor(mint, seen, lines);
    if (traded) return; // reserves changed: start a fresh pass before trading another pool
  }
  log(lines.join(" | ") || "no side pools");
}

/** One token's side pools; true once it has sent a trade. */
async function passFor(mint: PublicKey, seen: Set<string>, line: string[]) {
  const f = await discover(mint);
  const main = await snapshot(conn, xdex, f.main, mint);
  for (const s of f.sides) {
    const triangle = [f.main, s.pool, s.quotePool].map((k) => k.toBase58()).sort().join();
    if (seen.has(triangle)) continue;
    seen.add(triangle);
    const side = await snapshot(conn, xdex, s.pool, mint, s.quoteMint);
    const quote = await snapshot(conn, xdex, s.quotePool, s.quoteMint);
    const gap = gapPct({ main, side, quote });
    const p = best(main, side, quote);
    line.push(`${s.name} ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% best ${p.profit >= 0n ? "+" : ""}${xnt(p.profit)} @ ${xnt(p.xntIn)}`);
    if (p.profit < minProfit) continue;

    const where = p.dir === "buy-side" ? `buy on ${s.name}, sell on ${f.symbol}/XNT` : `buy on ${f.symbol}/XNT, sell on ${s.name}`;
    const ready = await setup([main, side, quote]);
    const wrap = ready ? await topUp(p.xntIn) : [];
    const ixs = [...(wrap ?? []), ...tripIxs(p)];
    if (!execute) {
      const sim = await simulate(ixs);
      log(`[dry run] ${s.name} ${gap.toFixed(2)}%: ${where}, ${xnt(p.xntIn)} XNT -> ~${xnt(p.xntOut)} (+${xnt(p.profit)}). `
        + (!ready ? `Wallet not set up yet (--execute opens its token accounts); trade tx is ${sim.bytes} of 1232 bytes.` : !wrap ? "Wallet is short of XNT for this size."
          : sim!.err ? `Simulation failed (${sim!.bytes} bytes): ${JSON.stringify(sim!.err)} ${sim!.logs.filter((l) => /Error|error|failed/.test(l)).slice(-2).join(" | ")}`
            : `Simulation OK: ${sim!.units} CU, ${sim!.bytes} bytes.`));
      continue;
    }
    if (!wrap) { log(`${s.name}: a trip pays +${xnt(p.profit)} XNT but the wallet is short of XNT for ${xnt(p.xntIn)} (keeping ${xnt(reserve)} for fees)`); continue; }
    const before = (await balanceOf(wxntAta)) ?? 0n;
    try {
      const sig = await send(ixs);
      const after = (await balanceOf(wxntAta)) ?? 0n;
      const realized = after - before - (wrap.length ? p.xntIn - before : 0n);
      const entry = { at: new Date().toISOString(), pool: s.pool.toBase58(), name: s.name, dir: p.dir, gapPct: gap, xntIn: p.xntIn.toString(), expectedProfit: p.profit.toString(), signature: sig };
      fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
      fs.appendFileSync(JOURNAL, JSON.stringify(entry) + "\n");
      await alert(`traded ${s.name} (${gap.toFixed(2)}%): ${where}, ${xnt(p.xntIn)} XNT in, ~+${xnt(p.profit)} XNT expected (wrapped balance ${xnt(after)}, made ${xnt(realized)}). ${sig}`);
    } catch (e) {
      log(`${s.name}: trade didn't go through (nothing was traded, only the fee is spent if it landed): ${msg(e).split("\n")[0]}`);
    }
    return true;
  }
  return false;
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
    const w = swap(snap, true, amount, snap.feeCfg, NO_FEE);
    if (w.out < MIN_OUT) { log(`sweep: ${sym} ${info.tokenAmount.amount} raw is worth ~${xnt(w.out)} XNT, under ${xnt(MIN_OUT)}: kept`); continue; }
    const ix = swapIx(xdex, wallet.publicKey, { pool: snap.pool, side: snap.side, amountIn: amount, minimumOut: w.minOut }, a.pubkey, wxntAta);
    if (!execute) { log(`[dry run] sweep: sell all ${sym} for ~${xnt(w.out)} XNT (after its transfer fee and the pool fee)`); total += w.out; continue; }
    try {
      log(`sweep: sold all ${sym} for ~${xnt(w.out)} XNT: ${await send([ix])}`);
      total += w.out;
    } catch (e) {
      log(`sweep: ${sym} didn't sell: ${msg(e).split("\n")[0]}`);
    }
  }
  log(`sweep ${execute ? "done" : "(dry run)"}: ~${xnt(total)} XNT into the wrapped trading balance`);
}

async function main() {
  if (has("sweep")) return sweep();
  if (has("setup")) {
    // Every account any route could need, so a dry run can simulate the real transactions.
    for (const mint of mints) {
      const f = await discover(mint);
      const snaps = [await snapshot(conn, xdex, f.main, mint)];
      for (const s of f.sides) snaps.push(await snapshot(conn, xdex, s.pool, mint, s.quoteMint), await snapshot(conn, xdex, s.quotePool, s.quoteMint));
      await setup(snaps, true);
    }
    log("setup done: the wallet has every token account its routes use");
    return;
  }
  const plain = await conn.getBalance(wallet.publicKey, "confirmed");
  log(`arb bot ${execute ? "LIVE" : "dry run"}: ${mints.map((m) => m.toBase58()).join(", ")} on ${network}, wallet ${wallet.publicKey.toBase58()} `
    + `(${xnt(BigInt(plain))} XNT + ${xnt((await balanceOf(wxntAta)) ?? 0n)} wrapped), trades up to ${xnt(maxIn)} XNT when a trip pays +${xnt(minProfit)}, `
    + `${loopSecs ? `every ${loopSecs}s` : "once"}`);
  for (;;) {
    try { await pass(); } catch (e) { log(`pass failed: ${msg(e)}`); }
    if (!loopSecs) return;
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
  }
}
await main();
