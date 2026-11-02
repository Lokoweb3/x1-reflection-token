// Peg and limit settlement of a leftover intent, on a landed trade whose RPC has no history for it (no status, past its
// blockhash, nothing covering the send). Modelled RPC answers; nothing is sent. A check that goes on past settlement
// stops at reading the pool, which this fake can't answer: that's outside what's tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey, type Connection } from "@solana/web3.js";
import { createLimitBuy, limitId } from "../src/limit.js";
import { createPeg, type PegSpec } from "../src/peg.js";
import { recordResolution } from "../src/send-intent.js";

const noHistory = { getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }), getSlot: async () => 500, getBlock: async () => ({ blockHeight: 200 }), getSignaturesForAddress: async () => [] } as unknown as Connection;
const covered = { ...noHistory, getSignaturesForAddress: async () => [{ signature: "OLD", blockTime: 1_000, err: null }] } as unknown as Connection;
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const common = (conn: Connection, stateDir: string, alerts: string[], sends: unknown[]) => ({ conn, xdex: PublicKey.unique(), owner: PublicKey.unique(),
  send: async (ixs: unknown) => { sends.push(ixs); return "x"; }, log: () => undefined, alert: async (s: string) => { alerts.push(s); }, stateDir, execute: true });

function limitCase(conn: Connection) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-intent-"));
  const spec = { symbol: "T", mint: PublicKey.unique(), quoteMint: PublicKey.unique(), pool: PublicKey.unique(), price: 100, budget: 50 };
  const id = limitId(spec), file = path.join(stateDir, "limit-orders.json");
  fs.writeFileSync(file, JSON.stringify({ [id]: { spent: "0", pending: { signature: "SIG", lastValidBlockHeight: 100, at: hourAgo(), amountIn: "1000000", minOut: "1", tokens: 1, poolPrice: 100 } } }));
  const alerts: string[] = [], sends: unknown[] = [];
  return { stateDir, alerts, sends, row: () => JSON.parse(fs.readFileSync(file, "utf8"))[id], order: createLimitBuy(spec, common(conn, stateDir, alerts, sends)) };
}

test("limit: unprovable buy blocks new buys and stays journaled, alerts once with the way out, and a person's decision counts it", async () => {
  const c = limitCase(noHistory);
  assert.equal(await c.order.check(), "pending");
  assert.equal(await c.order.check(), "pending");
  assert.equal(c.sends.length, 0);
  assert.equal(c.row().pending.signature, "SIG", "the intent stays");
  assert.equal(c.row().spent, "0");
  assert.equal(c.alerts.length, 1, "one alert");
  assert.match(c.alerts[0], /resolve-intent\.ts SIG/);

  recordResolution(c.stateDir, "SIG", "landed");
  await c.order.check().catch(() => undefined);
  assert.equal(c.row().spent, "1000000", "counted against the budget");
  assert.equal(c.row().pending, undefined);
});

test("limit: a person's 'dropped' clears it without counting; so does proof from the chain", async () => {
  const c = limitCase(noHistory);
  recordResolution(c.stateDir, "SIG", "dropped");
  await c.order.check().catch(() => undefined);
  assert.equal(c.row().spent, "0");
  assert.equal(c.row().pending, undefined);

  const p = limitCase(covered);
  await p.order.check().catch(() => undefined);
  assert.equal(p.row().spent, "0");
  assert.equal(p.row().pending, undefined);
  assert.equal(p.alerts.length, 0);
});

function pegCase(conn: Connection) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "peg-intent-"));
  const spec = { ticker: "T", mint: PublicKey.unique(), quoteMint: PublicKey.unique(), pool: PublicKey.unique() } as unknown as PegSpec;
  const alerts: string[] = [], sends: unknown[] = [];
  const keeper = createPeg(spec, common(conn, stateDir, alerts, sends));
  const files = () => fs.readdirSync(stateDir).filter((f) => f.endsWith(".json") && f !== "intent-resolutions.json");
  const seed = (file: string) => fs.writeFileSync(path.join(stateDir, file), JSON.stringify({ day: nyDay(), used: 0, pending: { signature: "SIG", lastValidBlockHeight: 100, at: hourAgo(), day: nyDay(), side: "buy", amountIn: "1", minOut: "1", tokens: 0.5, poolPrice: 1, refPrice: 1 } }));
  return { stateDir, alerts, sends, keeper, files, seed };
}
const PEG_FILE = "peg-t.json";

/** The writes `work` makes: each state file's contents must be flushed before it gets its final name. */
async function flushedBeforeRename(work: () => Promise<unknown>) {
  const events: string[] = [];
  const { fsyncSync, renameSync } = fs;
  fs.fsyncSync = (fd) => { events.push("fsync"); return fsyncSync(fd); };
  fs.renameSync = (a, b) => { events.push(`rename ${path.basename(String(b))}`); return renameSync(a, b); };
  try { await work(); } finally { fs.fsyncSync = fsyncSync; fs.renameSync = renameSync; }
  return events;
}
const assertDurable = (events: string[], file: string) => {
  const at = events.indexOf(`rename ${file}`);
  assert.ok(at > 0, `${file} was written: ${events.join(", ")}`);
  assert.equal(events[at - 1], "fsync", "its contents flushed first");
  assert.equal(events[at + 1], "fsync", "its name flushed after");
};

// setPending is also what journals the signature before a broadcast: the dropped case reaches that same writer.
test("limit: the intent and the budget are written durably", async () => {
  const dropped = limitCase(noHistory);
  recordResolution(dropped.stateDir, "SIG", "dropped");
  assertDurable(await flushedBeforeRename(() => dropped.order.check().catch(() => undefined)), "limit-orders.json");
  const landed = limitCase(noHistory);
  recordResolution(landed.stateDir, "SIG", "landed");
  assertDurable(await flushedBeforeRename(() => landed.order.check().catch(() => undefined)), "limit-orders.json");
});

test("peg: the intent and the day's count are written durably", async () => {
  for (const verdict of ["dropped", "landed"] as const) {
    const c = pegCase(noHistory);
    c.seed(PEG_FILE);
    recordResolution(c.stateDir, "SIG", verdict);
    assertDurable(await flushedBeforeRename(() => c.keeper.check().catch(() => undefined)), PEG_FILE);
  }
});

test("peg: unprovable trade blocks new trades and stays journaled, alerts once with the way out, and a person's decision counts it", async () => {
  const c = pegCase(noHistory);
  c.seed(PEG_FILE);
  assert.equal(await c.keeper.check(), "pending");
  assert.equal(await c.keeper.check(), "pending");
  assert.equal(c.sends.length, 0);
  const read = () => JSON.parse(fs.readFileSync(path.join(c.stateDir, PEG_FILE), "utf8"));
  assert.equal(read().pending.signature, "SIG");
  assert.equal(c.alerts.length, 1);
  assert.match(c.alerts[0], /resolve-intent\.ts SIG/);

  recordResolution(c.stateDir, "SIG", "landed");
  await c.keeper.check().catch(() => undefined);
  assert.equal(read().used, 0.5, "counted against the day");
  assert.equal(read().pending, undefined);
});
