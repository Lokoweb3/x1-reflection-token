/**
 * Limit buy: buys a token with USDC.X from its XDEX pool once the pool's price is at or below `price` (USDC.X per
 * token), and only up to that price: each buy is sized so the pool's price after it is no higher than the limit,
 * so every token costs at most the limit. It keeps buying on later checks while the price stays low, until
 * `budget` USDC.X is spent (or, without a budget, until the wallet's USDC.X runs out). What it has spent is kept
 * in state/limit-orders.json, so a restart doesn't spend the budget again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { cpmmOut, snapshot, swapIx, type Snapshot } from "./xdex.js";
import { sizeFor } from "./peg.js";
import { withFileLock } from "./arb-guard.js";
import { intentSlot, settleIntent, unresolvedHelp, writeIntentState, unresolvedOverdue, whenSigned, type Intent, type IntentRow } from "./send-intent.js";

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
  /** Reads the pool (tests replace it). */
  snapshot?: typeof snapshot;
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

type Pending = Intent & { token?: string; at: string; amountIn: string; minOut: string; tokens: number; poolPrice: number };
type Row = IntentRow<Pending> & { spent: string };
const readOrders = (file: string): Record<string, Row> => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };

/** One order's intent slot in state/limit-orders.json, the file being shared with other orders and processes. */
export function limitSlot(stateDir: string, id: string) {
  const file = path.join(stateDir, "limit-orders.json");
  const change = <T>(fn: (row: Row) => T): T => withFileLock(file, () => {
    const all = readOrders(file), row = all[id] ?? { spent: "0" };
    const out = fn(row);
    all[id] = row;
    writeIntentState(stateDir, file, JSON.stringify(all, null, 2) + "\n");
    return out;
  });
  return intentSlot<Pending, Row>(change, (row, p) => { row.spent = (BigInt(row.spent) + BigInt(p.amountIn)).toString(); });
}

export function createLimitBuy(spec: LimitBuySpec, o: LimitOptions) {
  const slip = (o.slippagePct ?? 0.5) / 100;
  const file = path.join(o.stateDir, "limit-orders.json");
  const journal = path.join(o.stateDir, "limit-trades.jsonl");
  const id = limitId(spec);
  let dec: { tok: number; quote: number; tokProgram: PublicKey; quoteProgram: PublicKey } | null = null;
  let lastNote = "";
  let alertedIntent: string | undefined;
  const note = (s: string) => { if (s !== lastNote) o.log(`limit ${spec.symbol}: ${s}`); lastNote = s; };

  const slot = limitSlot(o.stateDir, id);
  const read = () => readOrders(file);
  const spent = () => BigInt(read()[id]?.spent ?? "0");
  // A buy is journaled (with its signature, once signed) before it is sent, and settled by the next check if
  // this one didn't see it through (a crash, or a confirmation that timed out): src/send-intent.ts.
  const pendingOf = () => read()[id]?.pending;
  /** Count a buy that landed, once whoever sees it first; the same write clears its journaled intent. */
  function landed(p: Pending, signature: string) {
    const first = slot.count(p, signature);
    if (!first) return false;
    fs.appendFileSync(journal, JSON.stringify({ at: p.at, order: id, pool: spec.pool.toBase58(), poolPrice: p.poolPrice,
      limit: spec.price, amountIn: p.amountIn, minOut: p.minOut, tokens: p.tokens, signature }) + "\n");
    return true;
  }
  /** Settle a buy an earlier check journaled; true while it is still in flight (no new buy until it settles). */
  async function settle(): Promise<boolean> {
    const p = pendingOf();
    if (!p) return false;
    // A dry run may share the live bot's state: it only looks. The live bot settles this, and no new buy happens until it does.
    if (!o.execute) { note(`[dry run] an earlier buy (${p.signature ?? "not yet signed"}) is unsettled: a live run settles it; nothing changed`); return true; }
    const v = await settleIntent(o.conn, p, { wallet: o.owner, stateDir: o.stateDir });
    if (v === "pending") { note(`an earlier buy ${p.signature} is still in flight: waiting for it`); return true; }
    if (v === "unresolved") {
      note(`an earlier buy ${p.signature} is unresolved: waiting for proof of what became of it`);
      if (p.signature !== alertedIntent && unresolvedOverdue(p, Date.now())) { alertedIntent = p.signature; await o.alert(`limit ${spec.symbol}: ${unresolvedHelp(p.signature!, o.owner)}`); }
      return true;
    }
    if (v === "landed") { if (landed(p, p.signature!)) await o.alert(`limit ${spec.symbol}: an earlier buy landed after all (${p.amountIn} raw USDC.X): ${p.signature}`); }
    else { slot.drop(p); o.log(`limit ${spec.symbol}: an earlier buy didn't land (${p.signature ?? "never sent"}); nothing spent`); }
    return false;
  }

  async function check(): Promise<string> {
    if (await settle()) return "pending";
    const sQ = await (o.snapshot ?? snapshot)(o.conn, o.xdex, spec.pool, spec.quoteMint, spec.mint);
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
    const pending: Pending = { token: crypto.randomUUID(), at: new Date().toISOString(), amountIn: r.amountIn.toString(), minOut: minOut.toString(), tokens, poolPrice: r.poolPrice };
    if (!slot.claim(pending)) { note("another process has a buy out on this order: waiting for it"); return "pending"; }
    const sig = await whenSigned((signature, lastValidBlockHeight) => slot.sign(pending, signature, lastValidBlockHeight),
      () => o.send([createAssociatedTokenAccountIdempotentInstruction(o.owner, dest, o.owner, spec.mint, d.tokProgram),
        swapIx(o.xdex, o.owner, { pool: sQ.pool, side: sQ.side, amountIn: r.amountIn, minimumOut: minOut }, ata, dest)]));
    landed(pending, sig);
    lastNote = "";
    await o.alert(`limit ${spec.symbol}: ${at}: ${what}. ${sig}`);
    return "traded";
  }

  return { spec, check };
}
