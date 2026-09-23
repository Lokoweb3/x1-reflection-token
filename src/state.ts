/**
 * Crash-safe payout journal. XNT that has been allocated to holders but not yet
 * paid is tracked in `owed`, and is never counted as new distributable XNT.
 * Every payout signature is written to disk *before* the transaction is sent, so
 * a restart can tell whether a batch landed and will never pay it twice.
 *
 * `lp` tracks what is set aside for auto-LP: collected tokens kept for the token
 * side, collected tokens still to be sold for the XNT side, and XNT already raised.
 * Withdraw, sell and deposit transactions are journaled in `inflight` the same way,
 * and their effect on `lp` is applied from the confirmed transaction.
 */
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";

export interface Batch {
  payments: [owner: string, lamports: string][];
  status: "unsent" | "sent" | "confirmed";
  signature?: string;
  lastValidBlockHeight?: number;
}

export interface Inflight {
  kind: "withdraw" | "sell" | "lp" | "burn";
  signature: string;
  lastValidBlockHeight: number;
  amount?: string;        // withdraw: tokens withdrawn
  lp?: string;            // lp: LP tokens minted and burned
  lpTokens?: string;      // withdraw: tokens to keep for the LP token side
  lpSellTokens?: string;  // withdraw: tokens to sell for the LP XNT side; sell: LP's part of amountIn
  burnTokens?: string;    // withdraw: tokens set aside to burn; burn: tokens burned
  amountIn?: string;      // sell
}

export interface State {
  version: 1;
  mint: string;
  owed: Record<string, string>;
  pending: null | { createdAt: string; batches: Batch[] };
  lp: { tokens: string; sellTokens: string; xnt: string };
  /** Collected tax set aside to burn, and the running total burned. */
  burn: { pending: string; burned: string };
  inflight: Inflight | null;
  history: { at: string; kind: string; detail: string; signature?: string }[];
}

const FILE = path.join(STATE_DIR, "distributor-state.json");
const EVENTS = path.join(STATE_DIR, "events.jsonl");
const LOCK = path.join(STATE_DIR, "distributor.lock");

export function loadState(mint: string): State {
  const empty: State = {
    version: 1, mint, owed: {}, pending: null, lp: { tokens: "0", sellTokens: "0", xnt: "0" },
    burn: { pending: "0", burned: "0" }, inflight: null, history: [],
  };
  if (!fs.existsSync(FILE)) return empty;
  const s = JSON.parse(fs.readFileSync(FILE, "utf8")) as State;
  if (s.mint !== mint) throw new Error(`State file belongs to mint ${s.mint}, config has ${mint}`);
  s.lp ??= empty.lp;
  s.burn ??= empty.burn;
  s.inflight ??= null;
  return s;
}

export function saveState(s: State) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  s.history = s.history.slice(-1000);
  const tmp = `${FILE}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  fs.writeSync(fd, JSON.stringify(s, null, 2) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, FILE);
}

export function record(s: State, kind: string, detail: string, signature?: string) {
  s.history.push({ at: new Date().toISOString(), kind, detail, signature });
  console.log(`[${kind}] ${detail}${signature ? `  ${signature}` : ""}`);
}

export const totalOwed = (s: State) => Object.values(s.owed).reduce((a, v) => a + BigInt(v), 0n);

/** XNT in the distributor wallet that is spoken for: owed to holders or set aside for auto-LP. */
export const reservedXnt = (s: State) => totalOwed(s) + BigInt(s.lp.xnt);

/** Adjust an `lp` counter, flooring at zero. */
export function addLp(s: State, key: keyof State["lp"], delta: bigint) {
  const next = BigInt(s.lp[key]) + delta;
  s.lp[key] = (next > 0n ? next : 0n).toString();
}

export function addOwed(s: State, owner: string, lamports: bigint) {
  const next = BigInt(s.owed[owner] ?? "0") + lamports;
  if (next < 0n) throw new Error(`Owed balance for ${owner} would go negative`);
  if (next === 0n) delete s.owed[owner];
  else s.owed[owner] = next.toString();
}

/**
 * Append-only activity log for the dashboard: one JSON object per line, amounts in
 * base units as strings. `state` stays the source of truth; this is never read back
 * by the distributor, so a line lost to a crash only affects the dashboard.
 */
export interface Event {
  at: string;
  kind: "withdraw" | "sell" | "auto-lp" | "burn" | "allocate" | "payout";
  signature?: string;
  [field: string]: unknown;
}

export function logEvent(e: Omit<Event, "at">) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
}

export function readEvents(): Event[] {
  if (!fs.existsSync(EVENTS)) return [];
  return fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Event]; } catch { return []; }
  });
}

/** Whether a distributor run currently holds the lock. */
export function lockHolder(): number | null {
  if (!fs.existsSync(LOCK)) return null;
  const pid = Number(fs.readFileSync(LOCK, "utf8"));
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

/** Single-instance guard so a cron run can't overlap a slow previous run. */
export function acquireLock(): () => void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
  } catch {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
    if (alive) throw new Error(`Another distributor run is active (pid ${pid})`);
    fs.writeFileSync(LOCK, String(process.pid));
  }
  return () => fs.rmSync(LOCK, { force: true });
}
