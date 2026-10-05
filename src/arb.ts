/**
 * Price gaps between a token's pools, and whether a round trip between them pays, for the
 * gap monitor (scripts/gap-monitor.ts).
 *
 * The main pool is the token's deepest XNT pool. A side pool pairs the token with another
 * token Q, which has its own Q/XNT pool. A round trip starts and ends in XNT:
 *   "buy side":  XNT -> Q (Q/XNT pool) -> token (side pool) -> XNT (main pool)
 *   "buy main":  XNT -> token (main pool) -> Q (side pool) -> XNT (Q/XNT pool)
 * Every swap pays its pool's trade fee, and every move of a Token-2022 token with a transfer
 * fee pays it: into a pool the vault receives less, out of a pool the wallet does. A tax
 * token is moved twice per trip, so a 5% tax costs about 10% before any price gap is closed.
 */
import { calculateEpochFee } from "@solana/spl-token";
import { cpmmOut, type Snapshot } from "./xdex.js";

export type Leg = Pick<Snapshot, "reserveToken" | "reserveQuote" | "tradeFeeRate" | "feeCfg" | "epoch">;
export interface Route {
  /** The token/XNT main pool (token side = the token). */
  main: Leg;
  /** The token/Q side pool (token side = the token). */
  side: Leg;
  /** Q's XNT pool (token side = Q); its feeCfg is Q's transfer fee. */
  quote: Leg;
}

const afterFee = (l: Pick<Leg, "feeCfg" | "epoch">, amount: bigint) => amount - calculateEpochFee(l.feeCfg, l.epoch, amount);

/** XNT back from a round trip of `xntIn` (lamports) in one direction. */
export function roundTrip(r: Route, xntIn: bigint, dir: "buy-side" | "buy-main") {
  const tax = (a: bigint) => afterFee(r.main, a); // the token's transfer fee
  const qtax = (a: bigint) => afterFee(r.quote, a); // Q's
  if (dir === "buy-side") {
    const q = qtax(cpmmOut(xntIn, r.quote.reserveQuote, r.quote.reserveToken, r.quote.tradeFeeRate)); // Q to the wallet
    const tok = tax(cpmmOut(qtax(q), r.side.reserveQuote, r.side.reserveToken, r.side.tradeFeeRate)); // Q in, token out
    return cpmmOut(tax(tok), r.main.reserveToken, r.main.reserveQuote, r.main.tradeFeeRate); // token in, XNT out
  }
  const tok = tax(cpmmOut(xntIn, r.main.reserveQuote, r.main.reserveToken, r.main.tradeFeeRate));
  const q = qtax(cpmmOut(tax(tok), r.side.reserveToken, r.side.reserveQuote, r.side.tradeFeeRate));
  return cpmmOut(qtax(q), r.quote.reserveToken, r.quote.reserveQuote, r.quote.tradeFeeRate);
}

/** The side pool's price against the main pool's, in percent (both in XNT; positive = side dearer). */
export function gapPct(r: Route) {
  const main = Number(r.main.reserveQuote) / Number(r.main.reserveToken);
  const qXnt = Number(r.quote.reserveQuote) / Number(r.quote.reserveToken);
  const side = (Number(r.side.reserveQuote) * qXnt) / Number(r.side.reserveToken);
  return (side / main - 1) * 100;
}

export interface Best { dir: "buy-side" | "buy-main"; xntIn: bigint; xntOut: bigint; profit: bigint }

/**
 * The most profitable round trip: both directions over sizes from `minIn` growing by half
 * each step up to `maxIn` (profit is concave in size, so this finds the best one closely).
 */
export function bestTrip(r: Route, minIn = 10_000_000n, maxIn = 1_000_000_000_000n): Best {
  let best: Best | null = null;
  for (const dir of ["buy-side", "buy-main"] as const) {
    for (let x = minIn; x <= maxIn; x = (x * 3n) / 2n) {
      const out = roundTrip(r, x, dir);
      if (!best || out - x > best.profit) best = { dir, xntIn: x, xntOut: out, profit: out - x };
    }
  }
  return best!;
}
