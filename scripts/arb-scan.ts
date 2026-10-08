/**
 * The XDEX-wide arbitrage scanner on its own (src/arb-scanner.ts; the arb bot can run the same scanner
 * inside its own process with --scan, which is the better setup: one wallet, one queue of trades).
 *
 *   npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10]
 *     [--slippage 0.1] [--loop <seconds> (default 300) | --once] [--skip <mint,...>] [--no-instant]
 *     [--max-subs 400] [--min-liquidity <XNT> (default 5)] [--hubs 3] [--hub-sides 12]
 *     [--own <wallet,...> [--own-min-profit <XNT>]] [--network mainnet|testnet] [--rpc <url>] [--verbose]
 *     [--webhook <url>] [--telegram-token <t> --telegram-chat <id>]
 *
 *   --skip           tokens another bot already watches: no triangle goes through them
 *   --min-liquidity  only watch triangles whose two XNT pools each hold at least this much XNT
 *   --max-subs       at most this many pool vaults are watched live (hub pools first, then the most liquid)
 *   --hubs           how many of the busiest middle tokens get four-swap side-pool-pair routes (0: none),
 *                    between up to --hub-sides of their most liquid side pools
 * See src/arb-scanner.ts for how routes are found, watched and checked.
 */
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { XDEX_PROGRAM_IDS, loadKeypair } from "../src/config.js";
import { createEngine } from "../src/arb-engine.js";
import { createScanner } from "../src/arb-scanner.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10] [--slippage 0.1]\n"
    + "         [--loop <seconds> | --once] [--skip <mint,...>] [--no-instant] [--max-subs 400] [--min-liquidity 5] [--hubs 3] [--hub-sides 12]\n"
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
const loopSecs = has("once") ? 0 : num("loop", 300);
const own = (flag("own") ?? "").split(",").filter(Boolean).map((w) => new PublicKey(w));
const ownMinProfit = flag("own-min-profit") !== undefined ? lamports(num("own-min-profit", 0)) : undefined;
const webhook = flag("webhook");
const envTg = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
const tgToken = flag("telegram-token") ?? (envTg ? process.env.TELEGRAM_BOT_TOKEN : undefined);
const tgChat = flag("telegram-chat") ?? (envTg ? process.env.TELEGRAM_CHAT_ID : undefined);

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function alert(text: string) {
  log(text);
  const posts: Promise<unknown>[] = [];
  if (webhook) posts.push(fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[arb scan] ${text}` }), signal: AbortSignal.timeout(10_000) }));
  if (tgToken) posts.push(fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: tgChat, text: `[arb scan] ${text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) }));
  for (const r of await Promise.allSettled(posts)) if (r.status === "rejected") log(`alert delivery failed: ${msg(r.reason)}`);
}

const engine = createEngine({ conn, xdex, wallet, minProfit: lamports(num("min-profit", 0.02)), ownMinProfit, own, maxIn: lamports(num("max-in", 10)),
  slipBps: BigInt(Math.round(num("slippage", 0.1) * 100)), reserve: lamports(0.1), priority: 1000,
  stateDir: process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state"), log, alert });
const scanner = createScanner({ conn, xdex, engine, execute, skip: new Set((flag("skip") ?? "").split(",").filter(Boolean)),
  minLiquidity: lamports(num("min-liquidity", 5)), maxSubs: num("max-subs", 400), loopSecs, instant: !has("no-instant") && loopSecs > 0,
  hubs: num("hubs", 3), hubSides: num("hub-sides", 12), verbose: has("verbose"), log });

log(`arb scan ${execute ? "LIVE" : "dry run"} on ${network}, full read ${loopSecs ? `every ${loopSecs}s, live between reads` : "once"}`);
await scanner.start();
