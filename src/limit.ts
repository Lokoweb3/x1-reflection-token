/**
 * Limit buy: buys a token with USDC.X from its XDEX pool once the pool's price is at or below `price` (USDC.X per
 * token), and only up to that price: each buy is sized so the pool's price after it is no higher than the limit,
 * so every token costs at most the limit. It keeps buying on later checks while the price stays low, until
 * `budget` USDC.X is spent (or, without a budget, until the wallet's USDC.X runs out). What it has spent is kept
 * in state/limit-orders.json, so a restart doesn't spend the budget again.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { cpmmOut, snapshot, swapIx, type Snapshot } from "./xdex.js";
import { sizeFor } from "./peg.js";

export interface LimitBuySpec {
  /** The token to buy, its USDC.X pool, and the name the log uses. */
  mint: PublicKey;
  symbol: string;
  pool: PublicKey;
  quoteMint: PublicKey;
  /** Highest price paid, quote per token (whole units). */
  price: number;
  /** Quote (whole units) to spend in all; undefined = all the wallet holds. */
  budget?: number;
}

export interface LimitOptions {
  conn: Connection;
  xdex: PublicKey;
  owner: PublicKey;
  send: (ixs: TransactionInstruction[]) => Promise<string>;
  log: (s: string) => void;
  alert: (s: string) => Promise<void>;
  stateDir: string;
  execute: boolean;
  /** Slippage allowed on each buy, percent (default 0.5). */
  slippagePct?: number;
}

/** The order's key in state/limit-orders.json: a new price or budget is a new order. */
export const limitId = (s: LimitBuySpec) => `buy ${s.mint.toBase58()} at ${s.price} for ${s.budget ?? "all"}`;

/**
 * One buy against `sQ` (the pool as the quote side, going in, sees it): how much quote to put in so the pool's
 * price ends no higher than the limit, within what's left of the budget and the wallet's balance (raw units).
 */
export function limitBuySize(sQ: Snapshot, d: { tok: number; quote: number }, price: number, left: bigint, balance: bigint):
  { action: "buy"; poolPrice: number; amountIn: bigint; out: bigint } | { action: "wait" | "filled" | "no funds" | "rounds to nothing"; poolPrice: number } {
  const priceAt = (rIn: bigint, rOut: bigint) => (Number(rIn) / 10 ** d.quote) / (Number(rOut) / 10 ** d.tok);
  const poolPrice = priceAt(sQ.reserveToken, sQ.reserveQuote);
  if (left <= 0n) return { action: "filled", poolPrice };
  if (poolPrice > price) return { action: "wait", poolPrice };
  if (balance <= 0n) return { action: "no funds", poolPrice };
  const want = sizeFor(sQ, (rIn, rOut) => priceAt(rIn, rOut) >= price);
  // sizeFor stops at the first input that reaches the limit; one unit less stays at or under it.
  const amountIn = [want.amountIn - 1n, left, balance].reduce((a, b) => (a < b ? a : b));
  if (amountIn <= 0n) return { action: "rounds to nothing", poolPrice };
  const out = cpmmOut(amountIn - calculateEpochFee(sQ.feeCfg, sQ.epoch, amountIn), sQ.reserveToken, sQ.reserveQuote, sQ.tradeFeeRate);
  if (out <= 0n) return { action: "rounds to nothing", poolPrice };
  return { action: "buy", poolPrice, amountIn, out };
}

export function createLimitBuy(spec: LimitBuySpec, o: LimitOptions) {
  const slip = (o.slippagePct ?? 0.5) / 100;
  const file = path.join(o.stateDir, "limit-orders.json");
  const journal = path.join(o.stateDir, "limit-trades.jsonl");
  const id = limitId(spec);
  let dec: { tok: number; quote: number; tokProgram: PublicKey; quoteProgram: PublicKey } | null = null;
  let lastNote = "";
  const note = (s: string) => { if (s !== lastNote) o.log(`limit ${spec.symbol}: ${s}`); lastNote = s; };

  const read = (): Record<string, { spent: string }> => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
  const spent = () => BigInt(read()[id]?.spent ?? "0");
  function addSpent(n: bigint) {
    const all = read();
    all[id] = { spent: (spent() + n).toString() };
    fs.mkdirSync(o.stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
  }

  async function check(): Promise<string> {
    const sQ = await snapshot(o.conn, o.xdex, spec.pool, spec.quoteMint, spec.mint);
    if (!dec) {
      const [mq, mt] = await Promise.all([getMint(o.conn, spec.quoteMint, "confirmed", sQ.pool.programs[sQ.side]),
        getMint(o.conn, spec.mint, "confirmed", sQ.pool.programs[1 - sQ.side])]);
      dec = { tok: mt.decimals, quote: mq.decimals, quoteProgram: sQ.pool.programs[sQ.side], tokProgram: sQ.pool.programs[1 - sQ.side] };
    }
    const d = dec;
    const ata = getAssociatedTokenAddressSync(spec.quoteMint, o.owner, false, d.quoteProgram);
    const bal = await o.conn.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    const balance = bal ? BigInt(bal.value.amount) : 0n;
    const left = spec.budget === undefined ? balance : BigInt(Math.floor(spec.budget * 10 ** d.quote)) - spent();
    const usd = (raw: bigint) => (Number(raw) / 10 ** d.quote).toFixed(2);
    const r = limitBuySize(sQ, d, spec.price, left, balance);
    const at = `pool $${r.poolPrice.toFixed(2)}, limit $${spec.price}`;
    if (r.action !== "buy") {
      if (r.action === "filled") { note(`filled: ${usd(spent())} USDC.X spent (${at})`); return "filled"; }
      if (r.action === "no funds") { note(`${at}, but the wallet holds no USDC.X`); return "no funds"; }
      note(r.action === "wait" ? `waiting: ${at}` : `${at}: the buy that keeps the price under the limit rounds to nothing`);
      return "waiting";
    }
    const minOut = BigInt(Math.floor(Number(r.out) * (1 - slip)));
    const tokens = Number(r.out) / 10 ** d.tok, paid = Number(r.amountIn) / 10 ** d.quote;
    const what = `buy ~${tokens.toFixed(6)} ${spec.symbol} for ${paid.toFixed(4)} USDC.X (~$${(paid / tokens).toFixed(2)} each)`;
    if (!o.execute) { o.log(`limit ${spec.symbol}: ${at}: [dry run] would ${what}`); return "dry run"; }
    const dest = getAssociatedTokenAddressSync(spec.mint, o.owner, false, d.tokProgram);
    const sig = await o.send([createAssociatedTokenAccountIdempotentInstruction(o.owner, dest, o.owner, spec.mint, d.tokProgram),
      swapIx(o.xdex, o.owner, { pool: sQ.pool, side: sQ.side, amountIn: r.amountIn, minimumOut: minOut }, ata, dest)]);
    addSpent(r.amountIn);
    lastNote = "";
    fs.appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), order: id, pool: spec.pool.toBase58(), poolPrice: r.poolPrice,
      limit: spec.price, amountIn: r.amountIn.toString(), minOut: minOut.toString(), tokens, signature: sig }) + "\n");
    await o.alert(`limit ${spec.symbol}: ${at}: ${what}. ${sig}`);
    return "traded";
  }

  return { spec, check };
}
