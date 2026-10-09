/**
 * What running a Tax Vault costs: the network fees of every transaction that touched the vault
 * (whoever sent it: the site's crank, another crank, a visitor), by step and by UTC day, next to
 * the tax it handled. Shown on the token's page ("Cost to run") through GET /api/vault/<mint>.
 *
 * The ledger is state/vault-costs.jsonl in the token's launch folder, one line per transaction
 * ({ sig, at, fee, step, payer, err }), filled in from the chain by refresh(): new signatures of the
 * vault account since the newest one recorded (the first run reads back BACKFILL_DAYS). Lines older
 * than KEEP_DAYS are dropped when the file is next loaded. The tax side comes from the token's
 * events.jsonl (what the vault's own steps logged: each sale's XNT, each payout's wallets).
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";

const BACKFILL_DAYS = 7;
const KEEP_DAYS = 30;
const DAY = 86_400_000;

export interface CostLine { sig: string; at: number; fee: number; step: string; payer: string; err: boolean }

/** The vault step a transaction ran, from its program's "Instruction: X" log lines. */
export function stepOf(names: string[]): string {
  const has = (n: string) => names.some((x) => x === n);
  if (has("FundCreator") || has("FundHolders")) return "reward";
  if (has("AddLiquidity")) return "liquidity";
  if (has("Sell")) return "sell";
  if (has("Collect")) return "collect";
  if (has("PublishList") || has("CancelList")) return "list";
  if (names.some((n) => n.startsWith("Pay"))) return "pay";
  if (names.some((n) => /^(InitVault|UpgradeVault|SetPublisher|AppointPublisher|InitVaultPayout)$/.test(n))) return "setup";
  return names.length ? "other" : "none";
}

/** The vault program's instruction names in a transaction's logs (only at the program's own invocation depth). */
export function instructionNames(logs: string[], program: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const l of logs) {
    if (l.startsWith(`Program ${program} invoke`)) depth++;
    else if (l.startsWith(`Program ${program} success`) || l.startsWith(`Program ${program} failed`)) depth--;
    else if (depth > 0 && l.startsWith("Program log: Instruction: ")) out.push(l.slice(26));
  }
  return out;
}

export interface DayCosts {
  day: string;
  txs: number;
  failed: number;
  /** Network fees in lamports, all of them and by step. */
  fees: number;
  byStep: Record<string, number>;
  /** Fees the site's crank paid (the rest: other cranks and visitors). */
  crankFees: number;
  /** XNT the vault sold the tax for that day, what it paid holders, and how many wallet payments. */
  taxSold: number;
  paidHolders: number;
  payments: number;
}

/** Group a ledger and the token's events into UTC days (newest last), the last `days` of them. */
export function summarize(lines: CostLine[], events: Record<string, unknown>[], crank: string | null, days = 7, now = Date.now()) {
  // How much of the window the ledger actually covers (a vault just added has hours, not days): averages use this.
  const windowStart = now - days * DAY;
  const covered = lines.length ? Math.min(days, Math.max(1 / 24, (now - Math.max(windowStart, lines[0].at)) / DAY)) : days;
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const first = dayOf(now - (days - 1) * DAY);
  const byDay = new Map<string, DayCosts>();
  const get = (d: string) => {
    let x = byDay.get(d);
    if (!x) { x = { day: d, txs: 0, failed: 0, fees: 0, byStep: {}, crankFees: 0, taxSold: 0, paidHolders: 0, payments: 0 }; byDay.set(d, x); }
    return x;
  };
  for (let i = 0; i < days; i++) get(dayOf(now - (days - 1 - i) * DAY));
  for (const l of lines) {
    const d = dayOf(l.at);
    if (d < first) continue;
    const x = get(d);
    x.txs++;
    if (l.err) x.failed++;
    x.fees += l.fee;
    x.byStep[l.step] = (x.byStep[l.step] ?? 0) + l.fee;
    if (crank && l.payer === crank) x.crankFees += l.fee;
  }
  for (const e of events) {
    const at = typeof e.at === "string" ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(at) || dayOf(at) < first) continue;
    const x = get(dayOf(at));
    if (e.kind === "sell") x.taxSold += Number(e.xnt ?? 0);
    if (e.kind === "payout") { x.paidHolders += Number(e.total ?? 0); x.payments += Array.isArray(e.payments) ? e.payments.length : 0; }
  }
  const list = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const sum = (k: keyof DayCosts) => list.reduce((t, d) => t + (d[k] as number), 0);
  const fees = sum("fees"), taxSold = sum("taxSold"), payments = sum("payments");
  const payFees = list.reduce((t, d) => t + (d.byStep.pay ?? 0), 0);
  return {
    days: list,
    total: {
      txs: sum("txs"), failed: sum("failed"), fees, crankFees: sum("crankFees"), taxSold, paidHolders: sum("paidHolders"), payments,
      /** Fees as a share of the XNT the tax was sold for (percent), null without sales. */
      feePct: taxSold > 0 ? (fees / taxSold) * 100 : null,
      /** Fees per wallet payment (lamports), null without payments. */
      perPayment: payments > 0 ? payFees / payments : null,
      /** Average per day over the time the ledger covers, and that time in days. */
      perDay: fees / covered,
      coveredDays: covered,
    },
  };
}

export function createVaultCosts(o: {
  conn: Connection;
  program: PublicKey;
  /** The site's crank wallet, if any (its share of the fees is shown apart). */
  crank: PublicKey | null;
  addrOf: (mint: string) => PublicKey;
  stateDirOf: (mint: string) => string;
  log: (s: string) => void;
  /** How far back the first read of a vault goes (days). */
  backfillDays?: number;
}) {
  const file = (mint: string) => path.join(o.stateDirOf(mint), "vault-costs.jsonl");
  const ledgers = new Map<string, CostLine[]>();

  function load(mint: string): CostLine[] {
    const hit = ledgers.get(mint);
    if (hit) return hit;
    const f = file(mint), keep = Date.now() - KEEP_DAYS * DAY;
    const lines: CostLine[] = [];
    if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      if (!l) continue;
      try { const x = JSON.parse(l) as CostLine; if (x.at >= keep) lines.push(x); } catch { /* a torn line */ }
    }
    lines.sort((a, b) => a.at - b.at);
    // Rewrite without the old lines, so the file doesn't grow forever.
    if (fs.existsSync(f)) fs.writeFileSync(f, lines.map((x) => JSON.stringify(x)).join("\n") + (lines.length ? "\n" : ""));
    ledgers.set(mint, lines);
    return lines;
  }

  /** Read the vault's new transactions from the chain into the ledger. */
  let busy = false;
  async function refresh(mints: string[]) {
    if (busy) return;
    busy = true;
    try {
      for (const mint of mints) {
        try { await refreshOne(mint); } catch (e) { o.log(`[vault costs] ${mint}: ${e instanceof Error ? e.message : e}`); }
      }
    } finally { busy = false; }
  }
  async function refreshOne(mint: string) {
    const lines = load(mint);
    const known = new Set(lines.map((l) => l.sig));
    const newest = lines.at(-1)?.sig;
    const cutoff = (Date.now() - (o.backfillDays ?? BACKFILL_DAYS) * DAY) / 1000;
    const sigs: { signature: string; blockTime?: number | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await o.conn.getSignaturesForAddress(o.addrOf(mint), { limit: 1000, before, until: newest }, "confirmed");
      sigs.push(...page.filter((s) => (s.blockTime ?? 0) >= cutoff && !known.has(s.signature)));
      if (page.length < 1000 || (page.at(-1)!.blockTime ?? 0) < cutoff) break;
      before = page.at(-1)!.signature;
    }
    if (!sigs.length) return;
    const fresh: CostLine[] = [];
    const prog = o.program.toBase58();
    for (let i = 0; i < sigs.length; i += 4) {
      await Promise.all(sigs.slice(i, i + 4).map(async (s) => {
        const t = await o.conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (!t?.meta || !t.blockTime) return;
        const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
        fresh.push({ sig: s.signature, at: t.blockTime * 1000, fee: t.meta.fee, step: stepOf(instructionNames(t.meta.logMessages ?? [], prog)),
          payer: keys.get(0)!.toBase58(), err: !!t.meta.err });
      }));
    }
    fresh.sort((a, b) => a.at - b.at);
    fs.mkdirSync(path.dirname(file(mint)), { recursive: true });
    fs.appendFileSync(file(mint), fresh.map((x) => JSON.stringify(x)).join("\n") + "\n");
    lines.push(...fresh);
    lines.sort((a, b) => a.at - b.at);
    o.log(`[vault costs] ${mint}: +${fresh.length} transaction(s)`);
  }

  /** The last 7 UTC days of costs for the page, or null before anything is recorded. */
  function json(mint: string) {
    const lines = load(mint);
    if (!lines.length) return null;
    const f = path.join(o.stateDirOf(mint), "events.jsonl");
    const events: Record<string, unknown>[] = [];
    if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (l) try { events.push(JSON.parse(l)); } catch { /* torn */ } }
    const s = summarize(lines, events, o.crank?.toBase58() ?? null);
    return { since: new Date(lines[0].at).toISOString(), ...s };
  }

  return { refresh, json };
}
