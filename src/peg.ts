/**
 * Peg keeper: holds a bridged xStock (e.g. GOOGL.X, bridged 1:1 from GOOGLx on Solana) at its real price in
 * its XDEX pool against USDC.X. The arb bot then carries that price to the token's other pools.
 *
 * The reference price is the xStock on Solana, the token GOOGL.X bridges to and from (the source X1-Prism's
 * Stonks page shows): CoinGecko's price, cross-checked against Jupiter's. Both must answer, be recent and agree
 * within 1%, or nothing trades. When the pool is more than `bandPct` off, the keeper sells the token into the
 * pool (pool too high) or buys it with USDC.X (pool too low), sized to land the pool on the reference price,
 * at most `maxTrade` tokens a trade and `maxDay` tokens a day (New York days), out of the wallet's own inventory.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { cpmmOut, snapshot, swapIx, type Snapshot } from "./xdex.js";

export interface PegSpec {
  /** The bridged token on X1 (GOOGL.X) and the ticker it tracks. */
  mint: PublicKey;
  ticker: string;
  /** Its CoinGecko id and Solana mint (for Jupiter). */
  coingeckoId: string;
  solanaMint: string;
  /** The XDEX pool pairing it with `quoteMint` (USDC.X). */
  pool: PublicKey;
  quoteMint: PublicKey;
}

export interface PegOptions {
  conn: Connection;
  xdex: PublicKey;
  owner: PublicKey;
  send: (ixs: TransactionInstruction[]) => Promise<string>;
  log: (s: string) => void;
  alert: (s: string) => Promise<void>;
  stateDir: string;
  execute: boolean;
  /** Trade when the pool is more than this many percent from the reference (default 1.5). */
  bandPct?: number;
  /** Tokens (whole units) per trade and per New York day, both directions together (defaults 0.02 and 0.1). */
  maxTrade?: number;
  maxDay?: number;
  /** Slippage allowed on each peg trade, percent (default 0.5). */
  slippagePct?: number;
  /** Reference price sources; injectable for tests. */
  fetchPrice?: (spec: PegSpec) => Promise<{ price: number; sources: string } | { error: string }>;
}

/** Known bridged xStocks (from the X1 bridge's own list). */
export const XSTOCKS: Record<string, { ticker: string; coingeckoId: string; solanaMint: string }> = {
  E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5: { ticker: "GOOGL", coingeckoId: "alphabet-xstock", solanaMint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN" },
};
export const USDC_X = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");

const STALE_MS = 15 * 60_000;
const json = async (url: string) => {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (arb-bot peg)" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
};

/** CoinGecko and Jupiter, both recent and within 1% of each other; their average. */
export async function referencePrice(spec: PegSpec): Promise<{ price: number; sources: string } | { error: string }> {
  const [cg, jup] = await Promise.allSettled([
    json(`https://api.coingecko.com/api/v3/simple/price?ids=${spec.coingeckoId}&vs_currencies=usd&include_last_updated_at=true`),
    json(`https://lite-api.jup.ag/price/v3?ids=${spec.solanaMint}`),
  ]);
  if (cg.status === "rejected") return { error: `CoinGecko: ${cg.reason instanceof Error ? cg.reason.message : cg.reason}` };
  if (jup.status === "rejected") return { error: `Jupiter: ${jup.reason instanceof Error ? jup.reason.message : jup.reason}` };
  const c = (cg.value[spec.coingeckoId] ?? {}) as { usd?: number; last_updated_at?: number };
  const j = (jup.value[spec.solanaMint] ?? {}) as { usdPrice?: number; stockData?: { updatedAt?: string } };
  if (!c.usd || !c.last_updated_at) return { error: "CoinGecko has no price" };
  if (!j.usdPrice) return { error: "Jupiter has no price" };
  if (Date.now() - c.last_updated_at * 1000 > STALE_MS) return { error: `CoinGecko's price is ${Math.round((Date.now() - c.last_updated_at * 1000) / 60_000)} min old` };
  const jAt = j.stockData?.updatedAt ? Date.parse(j.stockData.updatedAt) : NaN;
  if (Number.isFinite(jAt) && Date.now() - jAt > STALE_MS) return { error: `Jupiter's price is ${Math.round((Date.now() - jAt) / 60_000)} min old` };
  if (Math.abs(c.usd / j.usdPrice - 1) > 0.01) return { error: `sources disagree: CoinGecko $${c.usd.toFixed(2)}, Jupiter $${j.usdPrice.toFixed(2)}` };
  return { price: (c.usd + j.usdPrice) / 2, sources: `CoinGecko $${c.usd.toFixed(2)}, Jupiter $${j.usdPrice.toFixed(2)}` };
}

/** Price of `s`'s token in its pair, in whole units (quote per token). */
const priceOf = (s: Pick<Snapshot, "reserveToken" | "reserveQuote">, tokDec: number, quoteDec: number) =>
  (Number(s.reserveQuote) / 10 ** quoteDec) / (Number(s.reserveToken) / 10 ** tokDec);

/**
 * The input that moves the pool's price (token per quote side as the snapshot sees it) onto `target`,
 * where `post` maps the pool after the swap to the price being steered. Binary search over the input.
 */
export function sizeFor(s: Snapshot, done: (reserveIn: bigint, reserveOut: bigint) => boolean) {
  let lo = 0n, hi = s.reserveToken;
  const quote = (amt: bigint) => {
    const net = amt - calculateEpochFee(s.feeCfg, s.epoch, amt);
    return { net, out: cpmmOut(net, s.reserveToken, s.reserveQuote, s.tradeFeeRate) };
  };
  for (let i = 0; i < 100 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n, { net, out } = quote(mid);
    if (done(s.reserveToken + net, s.reserveQuote - out)) hi = mid; else lo = mid;
  }
  return { amountIn: hi, ...quote(hi) };
}

export function createPeg(spec: PegSpec, o: PegOptions) {
  const band = (o.bandPct ?? 1.5) / 100, slip = (o.slippagePct ?? 0.5) / 100;
  const fetchPrice = o.fetchPrice ?? referencePrice;
  const file = path.join(o.stateDir, `peg-${spec.ticker.toLowerCase()}.json`);
  const journal = path.join(o.stateDir, "peg-trades.jsonl");
  let dec: { tok: number; quote: number; tokProgram: PublicKey; quoteProgram: PublicKey } | null = null;
  let lastProblem = "";

  const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  function used(): number {
    try { const s = JSON.parse(fs.readFileSync(file, "utf8")) as { day: string; used: number }; return s.day === nyDay() ? s.used : 0; } catch { return 0; }
  }
  function addUsed(n: number) {
    fs.mkdirSync(o.stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ day: nyDay(), used: used() + n }) + "\n");
  }
  async function balance(mint: PublicKey, program: PublicKey) {
    const ata = getAssociatedTokenAddressSync(mint, o.owner, false, program);
    const b = await o.conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    return { ata, raw: b ? BigInt(b.value.amount) : 0n };
  }
  /** Say a problem once (not every minute), and again only when it changes. */
  const problem = (s: string) => { if (s !== lastProblem) o.log(`peg ${spec.ticker}: ${s}`); lastProblem = s; };

  /** One check: compare, and trade when the pool is outside the band. Returns what it did, for the log. */
  async function check(): Promise<string> {
    const ref = await fetchPrice(spec);
    if ("error" in ref) { problem(`no trade, reference price unavailable (${ref.error})`); return "no reference"; }
    // Token side and quote side of the pool, as each direction's swap sees it.
    const sTok = await snapshot(o.conn, o.xdex, spec.pool, spec.mint, spec.quoteMint);
    if (!dec) {
      const [mt, mq] = await Promise.all([getMint(o.conn, spec.mint, "confirmed", sTok.pool.programs[sTok.side]),
        getMint(o.conn, spec.quoteMint, "confirmed", sTok.pool.programs[1 - sTok.side])]);
      dec = { tok: mt.decimals, quote: mq.decimals, tokProgram: sTok.pool.programs[sTok.side], quoteProgram: sTok.pool.programs[1 - sTok.side] };
    }
    const d = dec;
    const pool = priceOf(sTok, d.tok, d.quote), off = pool / ref.price - 1;
    if (Math.abs(off) <= band) {
      problem(`in band: pool $${pool.toFixed(2)} vs $${ref.price.toFixed(2)} (${(off * 100).toFixed(2)}%; ${ref.sources})`);
      return "in band";
    }
    const left = (o.maxDay ?? 0.1) - used();
    if (left <= 0) { problem(`pool $${pool.toFixed(2)} is ${(off * 100).toFixed(2)}% off $${ref.price.toFixed(2)}, but today's ${o.maxDay ?? 0.1} ${spec.ticker} limit is used`); return "day limit"; }
    const capTok = Math.min(o.maxTrade ?? 0.02, left);
    const target = ref.price;
    let ixs: TransactionInstruction[], amountIn: bigint, minOut: bigint, tokens: number, what: string;
    if (off > 0) {
      // Pool too high: sell the token until its price is down to the reference.
      const { ata, raw } = await balance(spec.mint, d.tokProgram);
      const want = sizeFor(sTok, (rIn, rOut) => priceOf({ reserveToken: rIn, reserveQuote: rOut }, d.tok, d.quote) <= target);
      amountIn = [want.amountIn, BigInt(Math.floor(capTok * 10 ** d.tok)), raw].reduce((a, b) => (a < b ? a : b));
      if (amountIn <= 0n) { problem(`pool $${pool.toFixed(2)} is ${(off * 100).toFixed(2)}% above $${target.toFixed(2)}, but the wallet holds no ${spec.ticker} to sell`); return "no inventory"; }
      const out = cpmmOut(amountIn - calculateEpochFee(sTok.feeCfg, sTok.epoch, amountIn), sTok.reserveToken, sTok.reserveQuote, sTok.tradeFeeRate);
      minOut = BigInt(Math.floor(Number(out) * (1 - slip)));
      tokens = Number(amountIn) / 10 ** d.tok;
      const dest = getAssociatedTokenAddressSync(spec.quoteMint, o.owner, false, d.quoteProgram);
      ixs = [createAssociatedTokenAccountIdempotentInstruction(o.owner, dest, o.owner, spec.quoteMint, d.quoteProgram),
        swapIx(o.xdex, o.owner, { pool: sTok.pool, side: sTok.side, amountIn, minimumOut: minOut }, ata, dest)];
      what = `sell ${tokens.toFixed(6)} ${spec.ticker}.X for ~${(Number(out) / 10 ** d.quote).toFixed(4)} USDC.X`;
    } else {
      // Pool too low: buy the token with USDC.X until its price is up to the reference.
      const sQ = await snapshot(o.conn, o.xdex, spec.pool, spec.quoteMint, spec.mint);
      const { ata, raw } = await balance(spec.quoteMint, d.quoteProgram);
      const want = sizeFor(sQ, (rIn, rOut) => (Number(rIn) / 10 ** d.quote) / (Number(rOut) / 10 ** d.tok) >= target);
      const capQuote = BigInt(Math.floor(capTok * target * 10 ** d.quote));
      amountIn = [want.amountIn, capQuote, raw].reduce((a, b) => (a < b ? a : b));
      if (amountIn <= 0n) { problem(`pool $${pool.toFixed(2)} is ${(off * 100).toFixed(2)}% below $${target.toFixed(2)}, but the wallet holds no USDC.X to buy with`); return "no inventory"; }
      const out = cpmmOut(amountIn - calculateEpochFee(sQ.feeCfg, sQ.epoch, amountIn), sQ.reserveToken, sQ.reserveQuote, sQ.tradeFeeRate);
      minOut = BigInt(Math.floor(Number(out) * (1 - slip)));
      tokens = Number(out) / 10 ** d.tok;
      const dest = getAssociatedTokenAddressSync(spec.mint, o.owner, false, d.tokProgram);
      ixs = [createAssociatedTokenAccountIdempotentInstruction(o.owner, dest, o.owner, spec.mint, d.tokProgram),
        swapIx(o.xdex, o.owner, { pool: sQ.pool, side: sQ.side, amountIn, minimumOut: minOut }, ata, dest)];
      what = `buy ~${tokens.toFixed(6)} ${spec.ticker}.X for ${(Number(amountIn) / 10 ** d.quote).toFixed(4)} USDC.X`;
    }
    const head = `peg ${spec.ticker}: pool $${pool.toFixed(2)} is ${(off * 100).toFixed(2)}% ${off > 0 ? "above" : "below"} $${target.toFixed(2)} (${ref.sources})`;
    if (!o.execute) { o.log(`${head}: [dry run] would ${what}`); return "dry run"; }
    const sig = await o.send(ixs);
    addUsed(tokens);
    lastProblem = "";
    fs.mkdirSync(o.stateDir, { recursive: true });
    fs.appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ticker: spec.ticker, pool: spec.pool.toBase58(), poolPrice: pool, refPrice: target,
      side: off > 0 ? "sell" : "buy", amountIn: amountIn.toString(), minOut: minOut.toString(), tokens, signature: sig }) + "\n");
    await o.alert(`${head}: ${what}. ${sig}`);
    return "traded";
  }

  return { spec, check };
}
