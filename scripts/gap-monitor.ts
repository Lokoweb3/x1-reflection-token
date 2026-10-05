/**
 * Pool gap monitor: watches every XDEX pool holding a token, compares each side pool's price
 * (TOKEN/JACK, TOKEN/USDC.X, ...) with the token's main XNT pool, and alerts when a round trip
 * between them would pay: the gap is wide enough to cover the token's transfer tax twice and
 * three pool fees (about 10.5% for a 5% tax). Read-only: it never trades and needs no keys.
 *
 *   npx tsx scripts/gap-monitor.ts --mint <token mint> [--network mainnet|testnet] [--rpc <url>]
 *     [--min-profit 0.05] [--gap <percent>] [--loop <seconds> (default 60) | --once]
 *     [--remind <minutes> (default 60)] [--webhook <url>]
 *     [--telegram-token <bot token> --telegram-chat <chat id> | env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
 *
 *   --min-profit  alert when the best round trip returns at least this much XNT more than it
 *                 puts in (after every fee and tax)
 *   --gap         also alert when a pool's price is this many percent off the main pool's,
 *                 profitable or not
 *   --remind      while a gap stays open, repeat its alert this often
 *   --webhook     POST {"text": ...} here for every alert (Slack, Discord's /slack endpoint, ...)
 *
 * Pools are found on-chain every 30 minutes (any pair, whoever created it), so a new pool is
 * picked up on its own. Each pass logs one line per side pool; alerts go to stdout and the
 * webhook / Telegram. A gap that closes gets a "back in line" message.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { XDEX_PROGRAM_IDS } from "../src/config.js";
import { bestTrip, gapPct, roundTrip, type Route } from "../src/arb.js";
import { deepestXntPool, poolsWith, symbolOf } from "../src/pools.js";
import { snapshot } from "../src/xdex.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/gap-monitor.ts --mint <token mint> [--network mainnet|testnet] [--rpc <url>] [--min-profit 0.05] [--gap <percent>]\n"
    + "         [--loop <seconds> | --once] [--remind <minutes>] [--webhook <url>] [--telegram-token <token> --telegram-chat <id>] (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const num = (name: string, d: number) => { const x = flag(name); if (x === undefined) return d; const n = Number(x); if (!Number.isFinite(n) || n < 0) usage(`--${name} takes a number`); return n; };
const mint = new PublicKey(flag("mint") ?? usage("--mint is required"));
const network = flag("network") ?? "mainnet";
if (!XDEX_PROGRAM_IDS[network]) usage("--network is mainnet or testnet");
const xdex = new PublicKey(XDEX_PROGRAM_IDS[network]);
const conn = new Connection(flag("rpc") ?? `https://rpc.${network}.x1.xyz`, "confirmed");
const minProfit = BigInt(Math.round(num("min-profit", 0.05) * 1e9));
const gapAlert = flag("gap") !== undefined ? num("gap", 0) : null;
const loopSecs = has("once") ? 0 : num("loop", 60);
const remindMs = num("remind", 60) * 60_000;
const webhook = flag("webhook");
if (!!flag("telegram-token") !== !!flag("telegram-chat")) usage("Telegram needs both --telegram-token and --telegram-chat");
// From the environment only when both are set (a token left over from another bot isn't enough).
const envTg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
const tgToken = flag("telegram-token") ?? (envTg ? process.env.TELEGRAM_BOT_TOKEN : undefined);
const tgChat = flag("telegram-chat") ?? (envTg ? process.env.TELEGRAM_CHAT_ID : undefined);

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const xnt = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(Number(lamports) < 1e9 && Number(lamports) > -1e9 ? 4 : 2);

/** stdout, and the webhook / Telegram if set (best effort). */
async function alert(text: string) {
  log(`ALERT ${text}`);
  const posts: Promise<unknown>[] = [];
  if (webhook) posts.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[gap monitor] ${text}` }), signal: AbortSignal.timeout(10_000) }));
  if (tgToken) posts.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `[gap monitor] ${text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }));
  for (const r of await Promise.allSettled(posts)) if (r.status === "rejected") log(`alert delivery failed: ${msg(r.reason)}`);
}

// ---------- pools (found on-chain, refreshed every 30 minutes) ----------
interface Side { pool: PublicKey; quoteMint: PublicKey; quotePool: PublicKey; name: string }
let found: { at: number; symbol: string; main: PublicKey; sides: Side[] } | null = null;

async function discover() {
  if (found && Date.now() - found.at < 30 * 60_000) return found;
  const main = await deepestXntPool(conn, xdex, mint);
  if (!main) throw new Error(`no XNT pool holds ${mint.toBase58()}`);
  const symbol = await symbolOf(conn, mint);
  const sides: Side[] = [];
  for (const p of await poolsWith(conn, xdex, mint)) {
    const quoteMint = new PublicKey(p.data.subarray(8 + (p.side === 0 ? 6 : 5) * 32, 40 + (p.side === 0 ? 6 : 5) * 32));
    if (quoteMint.equals(NATIVE_MINT)) continue; // the main pool, or a shallower second XNT pool (not a side pair)
    const q = await deepestXntPool(conn, xdex, quoteMint);
    const qSym = await symbolOf(conn, quoteMint);
    if (!q) { log(`${symbol}/${qSym} (${p.address.toBase58()}): ${qSym} has no XNT pool, skipped`); continue; }
    sides.push({ pool: p.address, quoteMint, quotePool: q.address, name: `${symbol}/${qSym}` });
  }
  if (!found || found.sides.map((s) => s.pool.toBase58()).join() !== sides.map((s) => s.pool.toBase58()).join())
    log(`watching ${sides.length} side pool(s) against ${symbol}/XNT ${main.address.toBase58()}: ${sides.map((s) => s.name).join(", ") || "none"}`);
  found = { at: Date.now(), symbol, main: main.address, sides };
  return found;
}

// ---------- one pass ----------
/** Open gaps: when first alerted and last reminded. */
const open = new Map<string, { since: number; reminded: number }>();

async function pass() {
  const f = await discover();
  const main = await snapshot(conn, xdex, f.main, mint);
  const line: string[] = [];
  for (const s of f.sides) {
    const r: Route = { main, side: await snapshot(conn, xdex, s.pool, mint, s.quoteMint), quote: await snapshot(conn, xdex, s.quotePool, s.quoteMint) };
    const gap = gapPct(r), best = bestTrip(r);
    const oneXnt = (Number(roundTrip(r, 1_000_000_000n, best.dir)) / 1e9 - 1) * 100; // a 1 XNT trip, in the better direction
    line.push(`${s.name} ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% (1 XNT round trip ${oneXnt >= 0 ? "+" : ""}${oneXnt.toFixed(1)}%, best ${best.profit >= 0n ? "+" : ""}${xnt(best.profit)} XNT)`);
    const paying = best.profit >= minProfit;
    const wide = gapAlert !== null && Math.abs(gap) >= gapAlert;
    const key = s.pool.toBase58(), was = open.get(key), now = Date.now();
    if (paying || wide) {
      if (!was || now - was.reminded >= remindMs) {
        const where = best.dir === "buy-side" ? `buy on ${s.name}, sell on ${f.symbol}/XNT` : `buy on ${f.symbol}/XNT, sell on ${s.name}`;
        await alert(`${was ? "still open: " : ""}${s.name} is ${Math.abs(gap).toFixed(2)}% ${gap < 0 ? "below" : "above"} ${f.symbol}/XNT. `
          + (paying ? `A round trip pays: ${where}, ${xnt(best.xntIn)} XNT in -> ${xnt(best.xntOut)} XNT out (+${xnt(best.profit)} after fees and tax).`
            : `Not worth a round trip yet (best ${xnt(best.profit)} XNT after fees and tax).`)
          + ` Pool ${key}`);
        open.set(key, { since: was?.since ?? now, reminded: now });
      }
    } else if (was) {
      open.delete(key);
      await alert(`${s.name} is back in line: ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% vs ${f.symbol}/XNT (open ${Math.round((now - was.since) / 60_000)} min).`);
    }
  }
  log(line.join(" | ") || "no side pools");
}

async function main() {
  log(`gap monitor: ${mint.toBase58()} on ${network}, alert at +${xnt(minProfit)} XNT${gapAlert !== null ? ` or a ${gapAlert}% gap` : ""}`
    + `${webhook ? ", webhook" : ""}${tgToken ? ", Telegram" : ""}${loopSecs ? `, every ${loopSecs}s` : ", once"}`);
  for (;;) {
    try { await pass(); } catch (e) { log(`pass failed: ${msg(e)}`); }
    if (!loopSecs) return;
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
  }
}
await main();
