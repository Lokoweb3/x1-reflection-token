/**
 * Spending brakes for the arb engine (src/arb-engine.ts), kept free of the chain so they can be tested without one:
 *
 *   RouteFailures  a route whose trades keep failing after they were sent (each one costs its fee) is skipped
 *                  for a while: 5 failures in a row, all within 10 minutes, skip it for an hour.
 *   FeeCap         every fee the wallet pays in the last 24 hours, against a cap, across all processes sharing the
 *                  wallet's state directory; a send that would pass the cap isn't sent (the bot stops trading) until
 *                  older fees fall out of the window.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileDurable } from "./factory/durable.js";

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

/** The cap would be passed: nothing was reserved, so nothing may be sent. */
export class FeeCapReached extends Error {}
/** The fee journal or its lock can't be trusted: refuse to send (never assume nothing was spent). */
export class FeeJournalError extends Error {}

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return errno(e) !== "ESRCH"; }
};

export interface LockOptions {
  /** How long to wait for another process before giving up (a refusal to send, never permission to). */
  waitMs?: number;
  /** A lock is only ever held for one read and one write: past this age it's stale even if its pid is in use (a reused pid). */
  staleMs?: number;
}

/**
 * Run `fn` holding `<file>.lock`, a lock shared by every process on this machine. The lock file is created exclusively
 * and names its holder. A lock whose holder is dead (or which is older than `staleMs`) is removed, one remover at a
 * time, by way of `<file>.lock.break`; that file is only held for one read and one delete, so it is left for a person
 * if a crash ever strands it. Anything else that stops the lock being taken throws FeeJournalError.
 */
export function withFileLock<T>(file: string, fn: (stillHeld: () => boolean) => T, opts: LockOptions = {}): T {
  const lock = `${file}.lock`, breaker = `${lock}.break`;
  const waitMs = opts.waitMs ?? 5_000, staleMs = opts.staleMs ?? 60_000;
  const me = JSON.stringify({ pid: process.pid, host: os.hostname(), token: crypto.randomUUID(), at: Date.now() });
  const ownedBy = (text: string) => { try { return JSON.parse(text) as { pid?: number; host?: string; at?: number }; } catch { return null; } };
  const stale = (text: string, mtime: number) => {
    const h = ownedBy(text);
    if (h && h.host === os.hostname() && typeof h.pid === "number" && !isAlive(h.pid)) return true;
    return Date.now() - mtime > staleMs;
  };
  /** Remove the lock if it is still the stale one, with no other process doing the same at the same moment. */
  const breakStale = () => {
    try { fs.writeFileSync(breaker, me, { flag: "wx" }); } catch (e) { if (errno(e) === "EEXIST") return; throw e; }
    try {
      const st = fs.statSync(lock), text = fs.readFileSync(lock, "utf8");
      if (stale(text, st.mtimeMs)) fs.unlinkSync(lock);
    } catch (e) { if (errno(e) !== "ENOENT") throw e; } finally { fs.rmSync(breaker, { force: true }); }
  };
  const deadline = Date.now() + waitMs;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { throw new FeeJournalError(`can't create ${path.dirname(file)}: ${(e as Error).message}`); }
  for (;;) {
    try { fs.writeFileSync(lock, me, { flag: "wx" }); break; } catch (e) {
      if (errno(e) !== "EEXIST") throw new FeeJournalError(`can't take the lock ${lock}: ${(e as Error).message}`);
    }
    try {
      const st = fs.statSync(lock);
      if (stale(fs.readFileSync(lock, "utf8"), st.mtimeMs)) breakStale();
    } catch (e) { if (errno(e) !== "ENOENT") throw new FeeJournalError(`can't check the lock ${lock}: ${(e as Error).message}`); }
    if (Date.now() >= deadline)
      throw new FeeJournalError(`the lock ${lock} is still held after ${waitMs} ms; if no arb process is running, delete it${fs.existsSync(breaker) ? ` and ${breaker}` : ""}`);
    sleepSync(5 + Math.random() * 20);
  }
  const stillHeld = () => { try { return fs.readFileSync(lock, "utf8") === me; } catch { return false; } };
  try { return fn(stillHeld); } finally { if (stillHeld()) fs.rmSync(lock, { force: true }); }
}

interface FeeEntry { at: number; fee: bigint; signature?: string; lastValidBlockHeight?: number; settled?: boolean }

/**
 * What this wallet paid in fees in the last 24 hours, kept in `file`: the file is the record, re-read under a lock on
 * every change, so processes sharing a wallet and state directory (bot and scanner) count against the same total, and a
 * restart loses nothing. `reserve` checks and records in one step, before a transaction is broadcast. `settle` then
 * replaces a reservation with what the chain charged. A cap of 0 sets no limit, but fees are still recorded, so another
 * process with a cap counts them. Only a missing file is a fresh start: an unreadable or malformed one throws
 * FeeJournalError until someone looks at it.
 */
export class FeeCap {
  constructor(public readonly cap: bigint, private file: string, private lock: LockOptions = {}) {}

  private read(now: number): FeeEntry[] {
    const bad = (why: string) => new FeeJournalError(`the fee journal ${this.file} can't be trusted (${why}), so nothing will be sent; repair it, or move it away to restart the 24-hour count from zero`);
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); } catch (e) {
      if (errno(e) === "ENOENT") return [];
      throw bad((e as Error).message);
    }
    let rows: unknown;
    try { rows = (JSON.parse(text) as { paid?: unknown }).paid; } catch (e) { throw bad((e as Error).message); }
    if (!Array.isArray(rows)) throw bad("no list of fees");
    return rows.map((r: { at?: unknown; fee?: unknown; signature?: unknown; lastValidBlockHeight?: unknown; settled?: unknown }) => {
      if (typeof r?.at !== "number" || !Number.isFinite(r.at) || typeof r.fee !== "string" || !/^\d+$/.test(r.fee)) throw bad(`bad entry ${JSON.stringify(r)}`);
      return { at: r.at, fee: BigInt(r.fee), ...(typeof r.signature === "string" ? { signature: r.signature } : {}),
        ...(typeof r.lastValidBlockHeight === "number" ? { lastValidBlockHeight: r.lastValidBlockHeight } : {}), ...(r.settled === true ? { settled: true } : {}) };
    }).filter((p) => now - p.at < DAY);
  }
  private write(stillHeld: () => boolean, paid: FeeEntry[]) {
    // Held for milliseconds: losing it means this process was frozen for a minute, and another may have written since.
    if (!stillHeld()) throw new FeeJournalError(`lost the lock on ${this.file} (this process was paused?); not writing, not sending`);
    try {
      writeFileDurable(this.file, JSON.stringify({ paid: paid.map((p) => ({ ...p, fee: p.fee.toString() })) }) + "\n");
    } catch (e) { throw new FeeJournalError(`can't write the fee journal ${this.file}: ${(e as Error).message}`); }
  }
  private update<T>(now: number, fn: (paid: FeeEntry[], stillHeld: () => boolean) => T): T {
    return withFileLock(this.file, (stillHeld) => fn(this.read(now), stillHeld), this.lock);
  }

  /** Lamports paid (or reserved) in the 24 hours before `now`. The file is replaced atomically, so this needs no lock. */
  spent(now: number): bigint { return this.read(now).reduce((t, p) => t + p.fee, 0n); }
  /** True when the cap is reached: send nothing more. */
  reached(now: number): boolean { return this.cap > 0n && this.spent(now) >= this.cap; }
  /**
   * Check and record `fee` in one step, for every process on this wallet. False, with nothing recorded, when it would
   * pass the cap. Throws FeeJournalError if the journal or the lock can't be trusted: never send after a throw.
   */
  reserve(fee: bigint, now: number, tx: { signature?: string; lastValidBlockHeight?: number } = {}): boolean {
    return this.update(now, (paid, stillHeld) => {
      if (this.cap > 0n && paid.reduce((t, p) => t + p.fee, 0n) + fee > this.cap) return false;
      this.write(stillHeld, [...paid, { at: now, fee, ...tx }]);
      return true;
    });
  }
  /** Replace a reservation with what the transaction really cost (0 if it provably never landed). False if it isn't in the window. */
  settle(signature: string, fee: bigint, now: number): boolean {
    return this.update(now, (paid, stillHeld) => {
      const e = paid.find((p) => p.signature === signature);
      if (!e) return false;
      e.fee = fee;
      e.settled = true;
      this.write(stillHeld, paid);
      return true;
    });
  }
  /** Reservations still at their estimate, oldest first. */
  unsettled(now: number) {
    return this.read(now).filter((p) => p.signature && !p.settled).map((p) => ({ signature: p.signature!, lastValidBlockHeight: p.lastValidBlockHeight, at: p.at }));
  }
}

/**
 * The fee X1 charges a transaction, from its signatures and the compute it *requests* (used or not):
 *   10 lamports x requested CU + priority fee + 3,001 lamports
 * Fitted to live TEST vault transactions (.claude/x1-notes.md). Those were all single-signature, so per-signature base
 * is an assumption; the docs describe dynamic base fees under congestion, which is unverified. Solana-side sends
 * (Jupiter, the bridges) have a different model (scripts/solana-swap.ts) and must not use this.
 */
export const x1MaxTxFee = (signatures: number, computeUnits: number, microLamportsPerCu: number) =>
  3_001n * BigInt(signatures) + 10n * BigInt(computeUnits)
  + (BigInt(computeUnits) * BigInt(Math.ceil(microLamportsPerCu)) + 999_999n) / 1_000_000n;

/** What to reserve before an X1 send: the model plus a quarter, as congestion pricing is unverified. Settling replaces it. */
export const x1FeeReservation = (signatures: number, computeUnits: number, microLamportsPerCu: number) =>
  (x1MaxTxFee(signatures, computeUnits, microLamportsPerCu) * 5n + 3n) / 4n;

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
