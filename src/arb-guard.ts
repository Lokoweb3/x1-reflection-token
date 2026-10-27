/**
 * Spending brakes for the arb engine (src/arb-engine.ts), kept pure so they can be tested without a chain:
 *
 *   RouteFailures  a route whose trades keep failing after they were sent (each one costs its fee) is skipped
 *                  for a while: 5 failures in a row, all within 10 minutes, skip it for an hour.
 *   FeeCap         every fee the engine pays in the last 24 hours, against a cap; once the cap is reached the
 *                  engine sends nothing more (the bot stops trading) until older fees fall out of the window.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

export interface FailureBudget { failures: number; windowMs: number; skipMs: number }
export const ROUTE_FAILURE_BUDGET: FailureBudget = { failures: 5, windowMs: 10 * 60_000, skipMs: 60 * 60_000 };

export class RouteFailures {
  private runs = new Map<string, number[]>();
  private skipUntil = new Map<string, number>();
  constructor(private budget: FailureBudget = ROUTE_FAILURE_BUDGET) {}

  /** Is `route` being skipped at `now`? */
  skipped(route: string, now: number): boolean {
    const until = this.skipUntil.get(route);
    if (until === undefined) return false;
    if (now < until) return true;
    this.skipUntil.delete(route);
    return false;
  }
  /** A trade through `route` went through: its run of failures is over. */
  ok(route: string) { this.runs.delete(route); }
  /**
   * A trade through `route` failed after it was sent. True when this failure used up the budget (the
   * route is now skipped until `now + skipMs`): the caller alerts once.
   */
  fail(route: string, now: number): boolean {
    const run = [...(this.runs.get(route) ?? []), now].filter((t) => now - t <= this.budget.windowMs);
    if (run.length < this.budget.failures) { this.runs.set(route, run); return false; }
    this.runs.delete(route);
    this.skipUntil.set(route, now + this.budget.skipMs);
    return true;
  }
}

const DAY = 24 * 3_600_000;

/** Fees paid in the last 24 hours, kept in `file` (when given) so a restart doesn't reset them. */
export class FeeCap {
  private paid: { at: number; fee: bigint }[] = [];
  constructor(public readonly cap: bigint, private file?: string) {
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { paid: { at: number; fee: string }[] };
      this.paid = j.paid.map((p) => ({ at: p.at, fee: BigInt(p.fee) }));
    } catch { /* no file yet */ }
  }
  /** Lamports paid in the 24 hours before `now`. */
  spent(now: number): bigint {
    this.paid = this.paid.filter((p) => now - p.at < DAY);
    return this.paid.reduce((t, p) => t + p.fee, 0n);
  }
  /** True when the cap is reached: send nothing more. */
  reached(now: number): boolean { return this.spent(now) >= this.cap; }
  add(fee: bigint, now: number) {
    this.spent(now);
    this.paid.push({ at: now, fee });
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ paid: this.paid.map((p) => ({ at: p.at, fee: p.fee.toString() })) }) + "\n");
  }
}

/** The most a transaction can be charged: the base fee per signature plus the priority on its whole compute limit. */
export const maxTxFee = (signatures: number, computeUnits: number, microLamportsPerCu: number) =>
  5_000n * BigInt(signatures) + (BigInt(computeUnits) * BigInt(Math.ceil(microLamportsPerCu)) + 999_999n) / 1_000_000n;

/** The most close-dust ever burns from one account, in raw units, whatever the price says (L2: a bad price can't burn real money). */
export const BURN_MAX_RAW = 1_000_000n;

/**
 * Whether close-dust may burn `amount` (raw) of a token: only when it's worth under `minValue` XNT (`value` is what
 * selling it would bring, via its XNT pool or its USDC.X pool; null when no pool prices it) AND it is at most
 * BURN_MAX_RAW raw units and at most a thousandth of one whole token.
 */
export function dustVerdict(amount: bigint, decimals: number, value: bigint | null, minValue: bigint): "burn" | "worth selling" | "too much to burn" {
  if (value !== null && value >= minValue) return "worth selling";
  const thousandth = 10n ** BigInt(Math.max(0, decimals - 3));
  return amount <= BURN_MAX_RAW && amount <= thousandth ? "burn" : "too much to burn";
}
