/**
 * XDEX-wide arbitrage scan: reads every XDEX pool, prices the round trip of every triangle
 * (a token's deepest XNT pool, one of its other pools, and that pool's other token's deepest XNT
 * pool; same maths as src/arb.ts and the arb bot), and lists the ones that pay. With --execute it
 * takes each paying one by running the arb bot once on that token (scripts/arb-bot.ts --once
 * --execute), so every trade keeps the bot's guarantee: one transaction that fails unless it ends
 * at least --min-profit up.
 *
 *   npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10] [--slippage <pct>]
 *     [--loop <seconds> (default 300) | --once] [--skip <mint,...>] [--network mainnet|testnet] [--rpc <url>]
 *
 *   --skip   tokens another bot already watches (e.g. the main arb bot's --mint list), so the two
 *            don't race for the same gaps
 *
 * A route only counts when its profit covers --min-profit plus the rent of the token accounts the
 * wallet would still need to open for it (about 0.0021 XNT each). Pools are re-read every pass in
 * batches of 100 (about 30 requests for 1,400 pools), and the pool list itself every 30 minutes.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TransferFeeConfig, getAssociatedTokenAddressSync, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { XDEX_PROGRAM_IDS, loadKeypair } from "../src/config.js";
import { bestTrip, gapPct, type Leg, type Route } from "../src/arb.js";
import { symbolOf } from "../src/pools.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/arb-scan.ts --keypair <wallet.json> [--execute] [--min-profit 0.02] [--max-in 10]\n"
    + "         [--loop <seconds> | --once] [--skip <mint,...>] [--network mainnet|testnet] [--rpc <url>] (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const num = (name: string, d: number) => { const x = flag(name); if (x === undefined) return d; const n = Number(x); if (!Number.isFinite(n) || n < 0) usage(`--${name} takes a number`); return n; };
const network = flag("network") ?? "mainnet";
if (!XDEX_PROGRAM_IDS[network]) usage("--network is mainnet or testnet");
const xdex = new PublicKey(XDEX_PROGRAM_IDS[network]);
const rpcUrl = flag("rpc") ?? `https://rpc.${network}.x1.xyz`;
const conn = new Connection(rpcUrl, "confirmed");
const keypairPath = flag("keypair") ?? usage("--keypair is required");
const owner = loadKeypair(keypairPath).publicKey;
const execute = has("execute");
const minProfit = BigInt(Math.round(num("min-profit", 0.02) * 1e9));
const maxIn = num("max-in", 10);
const slippage = flag("slippage"); // passed on to the arb bot (its default otherwise)
const loopSecs = has("once") ? 0 : num("loop", 300);
const skip = new Set((flag("skip") ?? "").split(",").filter(Boolean));
const ACCOUNT_RENT = 2_100_000n; // a Token-2022 account with the immutable-owner extension, rounded up

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const X = NATIVE_MINT.toBase58();
const NO_FEE: TransferFeeConfig = {
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
  newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
};

/** getMultipleAccountsInfo in batches of 100, gently spaced for the public RPC. */
async function many(keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

// ---------- the pool list (every 30 minutes) ----------
interface PoolDef { addr: string; cfg: PublicKey; vaults: [PublicKey, PublicKey]; mints: [string, string]; programs: [PublicKey, PublicKey] }
let list: { at: number; pools: PoolDef[]; feeRate: Map<string, bigint>; tax: Map<string, TransferFeeConfig>; program: Map<string, PublicKey> } | null = null;

async function poolList() {
  if (list && Date.now() - list.at < 30 * 60_000) return list;
  const key = (d: Buffer, i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));
  const pools: PoolDef[] = [];
  for (const { pubkey, account } of await conn.getProgramAccounts(xdex, { commitment: "confirmed", filters: [{ dataSize: 637 }] })) {
    const d = account.data;
    if (d[329] & 4) continue; // swaps paused
    pools.push({ addr: pubkey.toBase58(), cfg: key(d, 0), vaults: [key(d, 2), key(d, 3)], mints: [key(d, 5).toBase58(), key(d, 6).toBase58()], programs: [key(d, 7), key(d, 8)] });
  }
  const cfgs = [...new Set(pools.map((p) => p.cfg.toBase58()))];
  const cfgInfo = await many(cfgs.map((c) => new PublicKey(c)));
  const feeRate = new Map(cfgs.map((c, i) => [c, cfgInfo[i]?.data.readBigUInt64LE(12) ?? 1_000_000n]));
  const mints = [...new Set(pools.flatMap((p) => p.mints))];
  const mInfo = await many(mints.map((m) => new PublicKey(m)));
  const tax = new Map<string, TransferFeeConfig>(), program = new Map<string, PublicKey>();
  mints.forEach((m, i) => {
    const a = mInfo[i];
    if (!a) return;
    try {
      const u = unpackMint(new PublicKey(m), a, a.owner);
      tax.set(m, a.owner.equals(TOKEN_2022_PROGRAM_ID) ? (getTransferFeeConfig(u) ?? NO_FEE) : NO_FEE);
      program.set(m, a.owner);
    } catch { /* not a mint we can read: its pools are skipped */ }
  });
  list = { at: Date.now(), pools, feeRate, tax, program };
  log(`pool list: ${pools.length} open XDEX pools, ${mints.length} tokens`);
  return list;
}

// ---------- one scan ----------
interface Found { T: string; Q: string; side: string; gap: number; profit: bigint; xntIn: bigint; dir: string; newAccounts: number }

async function scan(): Promise<Found[]> {
  const l = await poolList();
  const vInfo = await many(l.pools.flatMap((p) => p.vaults));
  const { epoch } = await conn.getEpochInfo();
  // Reserves (vault balance less the protocol and fund fees the pool owes), per pool and mint.
  const poolData = await many(l.pools.map((p) => new PublicKey(p.addr)));
  type P = { addr: string; a: string; b: string; ra: bigint; rb: bigint; fee: bigint };
  const live: P[] = [];
  l.pools.forEach((p, i) => {
    try {
      const d = poolData[i]?.data;
      if (!d || !l.tax.has(p.mints[0]) || !l.tax.has(p.mints[1])) return;
      const ra = unpackAccount(p.vaults[0], vInfo[2 * i], p.programs[0]).amount - d.readBigUInt64LE(341) - d.readBigUInt64LE(357);
      const rb = unpackAccount(p.vaults[1], vInfo[2 * i + 1], p.programs[1]).amount - d.readBigUInt64LE(349) - d.readBigUInt64LE(365);
      if (ra > 0n && rb > 0n) live.push({ addr: p.addr, a: p.mints[0], b: p.mints[1], ra, rb, fee: l.feeRate.get(p.cfg.toBase58())! });
    } catch { /* a vault we can't read */ }
  });
  const leg = (p: P, tok: string): Leg => ({
    reserveToken: p.a === tok ? p.ra : p.rb, reserveQuote: p.a === tok ? p.rb : p.ra, tradeFeeRate: p.fee, feeCfg: l.tax.get(tok)!, epoch: BigInt(epoch),
  });
  const xntIn = (p: P) => (p.a === X ? p.ra : p.rb);
  const main = new Map<string, P>(); // each token's deepest XNT pool
  for (const p of live) {
    if (p.a !== X && p.b !== X) continue;
    const t = p.a === X ? p.b : p.a, c = main.get(t);
    if (!c || xntIn(p) > xntIn(c)) main.set(t, p);
  }
  const out: Found[] = [];
  const seen = new Set<string>();
  const cap = BigInt(Math.round(maxIn * 1e9));
  for (const s of live) {
    if (s.a === X || s.b === X) continue;
    for (const [T, Q] of [[s.a, s.b], [s.b, s.a]]) {
      const m = main.get(T), q = main.get(Q);
      if (!m || !q || skip.has(T)) continue;
      const tri = [m.addr, s.addr, q.addr].sort().join();
      if (seen.has(tri)) continue;
      seen.add(tri);
      const r: Route = { main: leg(m, T), side: leg(s, T), quote: leg(q, Q) };
      const b = bestTrip(r, 1_000_000n, cap);
      if (b.profit < minProfit) continue;
      out.push({ T, Q, side: s.addr, gap: gapPct(r), profit: b.profit, xntIn: b.xntIn, dir: b.dir, newAccounts: 0 });
    }
  }
  // The wallet's token accounts these routes would still need (each costs rent once).
  const need = (m: string) => getAssociatedTokenAddressSync(new PublicKey(m), owner, false, l.program.get(m)!);
  const atas = [...new Set(out.flatMap((f) => [f.T, f.Q]))];
  const have = new Map((await many(atas.map(need))).map((a, i) => [atas[i], !!a]));
  for (const f of out) f.newAccounts = [f.T, f.Q].filter((m) => !have.get(m)).length;
  return out.filter((f) => f.profit >= minProfit + ACCOUNT_RENT * BigInt(f.newAccounts)).sort((a, b) => Number(b.profit - a.profit));
}

async function pass() {
  const found = await scan();
  if (!found.length) { log(`nothing pays over ${xnt(minProfit)} XNT (after any account rent)`); return; }
  const name = async (m: string) => symbolOf(conn, new PublicKey(m));
  for (const f of found)
    log(`${await name(f.T)}/${await name(f.Q)} ${f.gap >= 0 ? "+" : ""}${f.gap.toFixed(1)}%: ${f.dir} ${xnt(f.xntIn)} XNT -> +${xnt(f.profit)}`
      + `${f.newAccounts ? ` (opens ${f.newAccounts} account${f.newAccounts > 1 ? "s" : ""})` : ""} | side pool ${f.side} | token ${f.T}`);
  if (!execute) return;
  // One bot run per token, best first; a token's run re-checks every route it's in, so later ones that
  // shared a pool with an earlier trade are simply skipped if they no longer pay.
  for (const T of [...new Set(found.map((f) => f.T))]) {
    const r = spawnSync("npx", ["tsx", path.join(import.meta.dirname, "arb-bot.ts"), "--mint", T, "--keypair", keypairPath, "--once", "--execute",
      "--network", network, "--rpc", rpcUrl, "--max-in", String(maxIn), "--min-profit", String(Number(minProfit) / 1e9), ...(slippage ? ["--slippage", slippage] : [])], { encoding: "utf8", timeout: 300_000 });
    const lines = `${r.stdout}${r.stderr}`.split("\n").filter((x) => /traded|didn't|short|setup:|failed/.test(x) && !/429/.test(x));
    log(`${await name(T)}: ${lines.length ? lines.map((x) => x.replace(/^\S+ \S+ /, "")).join(" | ") : "no trade (the gap moved)"}`);
  }
}

async function main() {
  log(`arb scan ${execute ? "LIVE" : "dry run"} on ${network}: routes paying +${xnt(minProfit)} XNT up to ${maxIn} XNT in`
    + `${skip.size ? `, skipping ${skip.size} token(s)` : ""}, ${loopSecs ? `every ${loopSecs}s` : "once"}`);
  for (;;) {
    try { await pass(); } catch (e) { log(`pass failed: ${msg(e)}`); }
    if (!loopSecs) return;
    await new Promise((r) => setTimeout(r, loopSecs * 1000));
  }
}
await main();
