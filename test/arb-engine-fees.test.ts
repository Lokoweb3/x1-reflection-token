// The engine's send against a modelled RPC: no network, no real sends. What is modelled: the RPC answers below, with
// every transaction confirming at once. The trades of executeNow are modelled by parallel engine.send calls (it sends
// with Promise.all over this same send), except at the end, where what a refusal leaves behind is seen through execute.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { createEngine, type Plan } from "../src/arb-engine.js";
import type { Snapshot } from "../src/xdex.js";
import { FeeCap, FeeCapReached, FeeJournalError, x1FeeReservation, x1MaxTxFee } from "../src/arb-guard.js";
import { whenSigned } from "../src/send-intent.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "engine-fees-"));
const blockhash = bs58.encode(Buffer.alloc(32, 7));

function fakeConn(opts: { fee?: (sig: string) => number | null } = {}) {
  const sent: string[] = [];
  const conn = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1_000 }),
    getBlockHeight: async () => 1,
    sendRawTransaction: async (raw: Uint8Array) => { const sig = bs58.encode(raw.subarray(1, 65)); sent.push(sig); return sig; },
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] }),
    getTransaction: async (sig: string) => { const fee = opts.fee?.(sig); return fee === null || fee === undefined ? null : { meta: { fee } }; },
  };
  return { conn: conn as unknown as Connection, sent };
}

function engineOn(conn: Connection, wallet: Keypair, stateDir: string, cap: bigint, alerts: string[] = [], feeReconcile?: { everyMs?: number; hurryWaitMs?: number }) {
  return createEngine({ conn, xdex: PublicKey.default, wallet, minProfit: 0n, maxIn: 1n, slipBps: 0n, reserve: 0n, priority: 1_000, stateDir,
    log: () => undefined, alert: async (s) => { alerts.push(s); }, maxFeesPerDay: cap, feeReconcile, backgroundFeeWrites: true });
}
const until = async (ok: () => boolean, ms = 3_000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 15)); return ok(); };
// Each distinct transfer amount signs differently, so signatures don't collide.
const ix = (w: Keypair, n: number) => [SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: PublicKey.default, lamports: n })];
// The engine's limit for a simulation that used 100,000 CU: 1.2x + 3,000.
const UNITS = 123_000;
const reservation = x1FeeReservation(1, UNITS, 1_000);
const feesOf = (stateDir: string, w: Keypair) => new FeeCap(0n, path.join(stateDir, `arb-fees-${w.publicKey.toBase58()}.json`));

test("parallel sends with room for one: one broadcast, the rest refused before going out", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const { conn, sent } = fakeConn();
  const alerts: string[] = [];
  const engine = engineOn(conn, wallet, stateDir, reservation + 1n, alerts);
  const results = await Promise.allSettled([1, 2, 3].map((n) => engine.send(ix(wallet, n), false, { units: 100_000 })));
  assert.equal(sent.length, 1, "one broadcast");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof FeeCapReached, String(r.reason));
  assert.equal(alerts.filter((a) => a.startsWith("paused")).length, 1, "one alert for the pause");
});

test("bot and scanner on one wallet and state directory share one cap, across two engines", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const a = fakeConn(), b = fakeConn();
  const cap = reservation * 2n;
  const bot = engineOn(a.conn, wallet, stateDir, cap), scanner = engineOn(b.conn, wallet, stateDir, cap);
  await bot.send(ix(wallet, 1), false, { units: 100_000 });
  await scanner.send(ix(wallet, 2), false, { units: 100_000 });
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), cap, "both recorded");
  await assert.rejects(bot.send(ix(wallet, 3), false, { units: 100_000 }), FeeCapReached);
  await assert.rejects(scanner.send(ix(wallet, 4), false, { units: 100_000 }), FeeCapReached);
  assert.equal(a.sent.length + b.sent.length, 2);
});

test("a fee is reserved before the broadcast, at X1's model, not Solana's", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  let atBroadcast = 0n;
  const { conn } = fakeConn();
  const send = conn.sendRawTransaction.bind(conn);
  conn.sendRawTransaction = (async (raw: Buffer) => { atBroadcast = feesOf(stateDir, wallet).spent(Date.now()); return send(raw); }) as typeof conn.sendRawTransaction;
  await engineOn(conn, wallet, stateDir, 10n ** 9n).send(ix(wallet, 1), false, { units: 100_000 });
  assert.equal(atBroadcast, reservation);
  assert.ok(atBroadcast > x1MaxTxFee(1, UNITS, 1_000), "the model plus a margin");
  assert.ok(atBroadcast > 1_000_000n, `a Solana-style 5,000-lamport estimate would be two orders under: ${atBroadcast}`);
});

test("transaction metadata replaces the reservation, also when the send fails", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const { conn, sent } = fakeConn({ fee: () => 1_234_567 });
  const engine = engineOn(conn, wallet, stateDir, 10n ** 9n);
  await engine.send(ix(wallet, 1), false, { units: 100_000 });
  for (let i = 0; i < 100 && feesOf(stateDir, wallet).unsettled(Date.now()).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), 1_234_567n);

  conn.getSignatureStatuses = (async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "x"] } }] })) as unknown as typeof conn.getSignatureStatuses;
  await assert.rejects(engine.send(ix(wallet, 2), false, { units: 100_000 }), /failed/);
  for (let i = 0; i < 100 && feesOf(stateDir, wallet).unsettled(Date.now()).length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 2);
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), 2n * 1_234_567n, "a transaction that lands and fails still pays");
});

test("with no metadata the reservation stands", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const { conn } = fakeConn({ fee: () => null });
  await engineOn(conn, wallet, stateDir, 10n ** 9n).send(ix(wallet, 1), false, { units: 100_000 });
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), reservation);
  assert.equal(feesOf(stateDir, wallet).unsettled(Date.now()).length, 1);
});

test("a bad fee journal stops the send before broadcast, with one alert, and doesn't touch the file", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const file = path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`);
  fs.writeFileSync(file, "{ torn");
  const { conn, sent } = fakeConn();
  const alerts: string[] = [];
  const engine = engineOn(conn, wallet, stateDir, 10n ** 9n, alerts);
  await assert.rejects(engine.send(ix(wallet, 1), false, { units: 100_000 }), FeeJournalError);
  await assert.rejects(engine.send(ix(wallet, 2), false, { units: 100_000 }), FeeJournalError);
  assert.equal(sent.length, 0);
  assert.equal(alerts.filter((a) => a.startsWith("not sending")).length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{ torn");
  assert.ok(alerts[0].includes(file), "the alert names the file");
});

test("a held lock stops the send too: a lock failure never means unlimited spending", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const file = path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`);
  // A stranded break file and a dead holder's lock: the one case that won't clear by itself.
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 1, host: os.hostname() }));
  fs.writeFileSync(`${file}.lock.break`, "x");
  const { conn, sent } = fakeConn();
  const alerts: string[] = [];
  const engine = engineOn(conn, wallet, stateDir, 10n ** 9n, alerts);
  await assert.rejects(engine.send(ix(wallet, 1), false, { units: 100_000 }), FeeJournalError);
  assert.equal(sent.length, 0);
  assert.ok(alerts[0].startsWith("not sending"));
});

test("no signature reaches the trade journal for a send the cap refused", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const { conn } = fakeConn();
  const engine = engineOn(conn, wallet, stateDir, 1n);
  const told: string[] = [];
  await assert.rejects(whenSigned((s) => told.push(s), () => engine.send(ix(wallet, 1), false, { units: 100_000 })), FeeCapReached);
  assert.deepEqual(told, [], "so a peg or limit intent knows it was never broadcast");
});

const rowsAgo = (minutes: number, ...signatures: string[]) => signatures.map((signature) => ({ at: Date.now() - minutes * 60_000, fee: "2000000", signature, lastValidBlockHeight: 100 }));
const seed = (stateDir: string, wallet: Keypair, paid: unknown[]) => fs.writeFileSync(path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`), JSON.stringify({ paid }));
/** No status, past its blockhash, and a wallet history that covers every send. */
const proofAvailable = (conn: Connection, fromMinutesAgo = 120) => Object.assign(conn, {
  getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }), getSlot: async () => 500, getBlock: async () => ({ blockHeight: 200 }),
  getSignaturesForAddress: async () => [{ signature: "OLD", blockTime: Math.floor((Date.now() - fromMinutesAgo * 60_000) / 1000), err: null }],
});

test("what an earlier run left is reconciled by itself, with no trade or send: metadata if the chain has it, 0 on proof it never landed, else the estimate stands", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, [...rowsAgo(10, "LANDED", "GONE"), { at: Date.now() - 600_000, fee: "2000000", signature: "NOHEIGHT" }, ...rowsAgo(0, "FRESH")]);
  const { conn } = fakeConn({ fee: (sig) => (sig === "LANDED" ? 900_000 : null) });
  proofAvailable(conn);
  engineOn(conn, wallet, stateDir, 10n ** 9n);
  assert.ok(await until(() => feesOf(stateDir, wallet).unsettled(Date.now()).length === 2), "two left, with nothing sent to prompt it");
  const fees = feesOf(stateDir, wallet);
  assert.deepEqual(fees.unsettled(Date.now()).map((u) => u.signature), ["NOHEIGHT", "FRESH"], "no block height: no proof; fresh: left to its own send");
  assert.equal(fees.spent(Date.now()), 900_000n + 0n + 2_000_000n + 2_000_000n);
});

test("the timer gets to them all, a few at a time, though nothing is ever sent", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, rowsAgo(10, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"));
  const { conn, sent } = fakeConn({ fee: () => 1 });
  engineOn(conn, wallet, stateDir, 10n ** 9n, [], { everyMs: 10 });
  assert.ok(await until(() => feesOf(stateDir, wallet).unsettled(Date.now()).length === 0), "all settled");
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), 12n);
  assert.equal(sent.length, 0);
});

test("reservations that can't be settled don't hide the one behind them", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, [...rowsAgo(30, "s1", "s2", "s3", "s4", "s5", "s6"), ...rowsAgo(10, "LATE")]);
  const { conn } = fakeConn({ fee: (sig) => (sig === "LATE" ? 7 : null) });
  // No proof for any of them: history that doesn't reach the sends.
  Object.assign(proofAvailable(conn), { getSignaturesForAddress: async () => [] });
  engineOn(conn, wallet, stateDir, 10n ** 9n, [], { everyMs: 10 });
  assert.ok(await until(() => !feesOf(stateDir, wallet).unsettled(Date.now()).some((u) => u.signature === "LATE")), "reached past the oldest");
});

test("one request that throws costs only its own reservation", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, rowsAgo(10, "BAD", "b", "c"));
  const { conn } = fakeConn({ fee: () => 5 });
  const get = conn.getTransaction.bind(conn);
  conn.getTransaction = (async (sig: string, c: unknown) => { if (sig === "BAD") throw new Error("429"); return get(sig, c as never); }) as typeof conn.getTransaction;
  engineOn(conn, wallet, stateDir, 10n ** 9n);
  assert.ok(await until(() => feesOf(stateDir, wallet).unsettled(Date.now()).length === 1), "the other two settled");
  assert.deepEqual(feesOf(stateDir, wallet).unsettled(Date.now()).map((u) => u.signature), ["BAD"]);
});

/** Every simulation the send runs, in order with the reconciliation it must follow. */
function withSimulation(conn: Connection, events: string[]) {
  conn.simulateTransaction = (async () => { events.push("simulate"); return { value: { err: null, unitsConsumed: 100_000, logs: [] } }; }) as unknown as typeof conn.simulateTransaction;
  const get = conn.getTransaction.bind(conn);
  conn.getTransaction = (async (sig: string, c: unknown) => { events.push("reconcile"); return get(sig, c as never); }) as typeof conn.getTransaction;
  const send = conn.sendRawTransaction.bind(conn);
  conn.sendRawTransaction = (async (raw: Buffer) => { events.push("broadcast"); return send(raw); }) as typeof conn.sendRawTransaction;
}
const fullRow = (fee: bigint | string, signature = "FULL") => [{ at: Date.now() - 1_000, fee: fee.toString(), signature, lastValidBlockHeight: 100 }];
const cap = reservation + 1_000n;
const settledSmall = (sig: string) => (sig === "FULL" ? 500 : null);

test("a direct send (sweep, peg, limit) against a full cap reconciles first, simulates after that, and goes out", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, fullRow(cap)); // recent, so only a send's own urgent pass reaches it
  const { conn, sent } = fakeConn({ fee: settledSmall });
  const events: string[] = [];
  withSimulation(conn, events);
  await engineOn(conn, wallet, stateDir, cap).send(ix(wallet, 1));
  assert.equal(sent.length, 1);
  assert.deepEqual(events.slice(0, 3), ["reconcile", "simulate", "broadcast"], "the simulation comes after the wait");
});

test("a direct send short of room, not at the cap: starts over after the wait, with a fresh simulation", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, fullRow("2000"));
  const { conn, sent } = fakeConn({ fee: settledSmall });
  const events: string[] = [];
  withSimulation(conn, events);
  await engineOn(conn, wallet, stateDir, cap).send(ix(wallet, 1));
  assert.equal(sent.length, 1);
  assert.deepEqual(events.slice(0, 4), ["simulate", "reconcile", "simulate", "broadcast"]);
});

for (const [name, row] of [["at a full cap", cap], ["short of room", 2_000n]] as const)
  test(`a trade simulated before a wait for room (${name}) is refused, though room opened, and goes out on the next check`, async () => {
    const wallet = Keypair.generate(), stateDir = dir();
    seed(stateDir, wallet, fullRow(row));
    const { conn, sent } = fakeConn({ fee: settledSmall });
    const alerts: string[] = [];
    const engine = engineOn(conn, wallet, stateDir, cap, alerts);
    await assert.rejects(engine.send(ix(wallet, 1), false, { units: 100_000 }), (e: Error) => e instanceof FeeCapReached);
    assert.equal(sent.length, 0, "no stale trade with skipPreflight");
    assert.equal(feesOf(stateDir, wallet).spent(Date.now()), 500n, "room was made");
    assert.deepEqual(alerts.filter((a) => a.startsWith("paused")), [], "room now: not a pause");
    await engine.send(ix(wallet, 1), false, { units: 100_000 });
    assert.equal(sent.length, 1);
  });

test("a dry run's engine never rewrites the fee journal, and makes no RPC call for it", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const file = path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`);
  seed(stateDir, wallet, rowsAgo(10, "LANDED"));
  const before = fs.readFileSync(file, "utf8"), { mtimeMs, ino } = fs.statSync(file);
  const { conn } = fakeConn({ fee: () => 1 });
  let calls = 0;
  conn.getTransaction = (async () => { calls++; return { meta: { fee: 1 } }; }) as unknown as typeof conn.getTransaction;
  const engine = createEngine({ conn, xdex: PublicKey.default, wallet, minProfit: 0n, maxIn: 1n, slipBps: 0n, reserve: 0n, priority: 1_000, stateDir,
    log: () => undefined, alert: async () => undefined, maxFeesPerDay: 10n ** 9n, feeReconcile: { everyMs: 5 } });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(engine);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual([fs.statSync(file).mtimeMs, fs.statSync(file).ino], [mtimeMs, ino]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("the scripts give only live runs the background write capability", () => {
  for (const script of ["arb-bot.ts", "arb-scan.ts"])
    assert.match(fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", script), "utf8"), /backgroundFeeWrites: execute \}\)/, script);
});

test("a background pass that finds the journal bad alerts once, before any send hits it", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  fs.writeFileSync(path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`), "{ torn");
  const { conn } = fakeConn();
  const alerts: string[] = [];
  engineOn(conn, wallet, stateDir, 10n ** 9n, alerts, { everyMs: 5 });
  assert.ok(await until(() => alerts.length > 0), "alerted");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(alerts.length, 1, "once");
  assert.match(alerts[0], /^not sending: .*fee journal/);
});

test("a live run on a journal another user left says so: who owns it, who's asking, the fix", { skip: process.getuid?.() === 0 }, async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const file = path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`);
  seed(stateDir, wallet, []);
  fs.chmodSync(file, 0o000);
  // A test can't make a root-owned file without root, so a modelled stat says it's root's. The read's EACCES is real.
  const stat = fs.statSync;
  (fs as { statSync: unknown }).statSync = (p: fs.PathLike, ...rest: unknown[]) => (String(p) === file ? { uid: 0 } : (stat as (...a: unknown[]) => unknown)(p, ...rest));
  try {
    const { conn, sent } = fakeConn();
    const alerts: string[] = [];
    await assert.rejects(engineOn(conn, wallet, stateDir, 10n ** 9n, alerts).send(ix(wallet, 1), false, { units: 100_000 }), FeeJournalError);
    assert.equal(sent.length, 0);
    assert.match(alerts[0], /EACCES/);
    assert.match(alerts[0], new RegExp(`belongs to uid 0 and this process runs as uid ${process.getuid!()}`));
    assert.match(alerts[0], /chown/);
  } finally { (fs as { statSync: unknown }).statSync = stat; }
});

test("a reconcile pass is bounded, and a run of refused sends doesn't repeat it", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, rowsAgo(10, "a", "b", "c", "d", "e", "f", "g"));
  const { conn } = fakeConn({ fee: () => null });
  const asked: string[] = [];
  const get = conn.getTransaction.bind(conn);
  conn.getTransaction = (async (sig: string, c: unknown) => { asked.push(sig); return get(sig, c as never); }) as typeof conn.getTransaction;
  engineOn(conn, wallet, stateDir, 10n ** 9n);
  await until(() => asked.length >= 3, 500);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(asked.length, 3, "a few at a time");

  const w2 = Keypair.generate(), d2 = dir();
  seed(d2, w2, fullRow(cap));
  const c2 = fakeConn({ fee: () => null });
  let lookups = 0;
  c2.conn.getTransaction = (async () => { lookups++; return null; }) as unknown as typeof c2.conn.getTransaction;
  const engine = engineOn(c2.conn, w2, d2, cap);
  await assert.rejects(engine.send(ix(w2, 1), false, { units: 100_000 }), FeeCapReached);
  await assert.rejects(engine.send(ix(w2, 2), false, { units: 100_000 }), FeeCapReached);
  assert.equal(lookups, 1, "the second refusal doesn't look again within the gap");
});

test("no room to be made: refused, and a hung RPC can't hold the send past its bound", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  seed(stateDir, wallet, fullRow(cap));
  const { conn, sent } = fakeConn();
  conn.getTransaction = (() => new Promise(() => undefined)) as unknown as typeof conn.getTransaction;
  const started = Date.now();
  await assert.rejects(engineOn(conn, wallet, stateDir, cap, [], { hurryWaitMs: 100 }).send(ix(wallet, 1), false, { units: 100_000 }), FeeCapReached);
  assert.ok(Date.now() - started < 2_000, "within the bound");
  assert.equal(sent.length, 0);
});

test("two sends of one identical transaction count once", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const { conn, sent } = fakeConn();
  const engine = engineOn(conn, wallet, stateDir, 10n ** 9n);
  await Promise.all([1, 1].map((n) => engine.send(ix(wallet, n), false, { units: 100_000 })));
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1], "same signature");
  assert.equal(feesOf(stateDir, wallet).spent(Date.now()), reservation);
});

// ---------- through execute: what a refused send leaves behind ----------
const NORMAL = 1_000, RACE = 2_000_000;
/** One made-up swap through a pool that isn't a real one; the chain here answers only what execute asks. */
function tradePlan() {
  const k = () => Keypair.generate().publicKey;
  const snap = { pool: { address: k(), ammConfig: k(), vaults: [k(), k()], mints: [NATIVE_MINT, k()], programs: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], observation: k() } } as unknown as Snapshot;
  const route = { name: "r", mispriced: [snap.pool.address], hops: [{ snap, inMint: NATIVE_MINT }] };
  return { plan: { route, xntIn: 1n, xntOut: 2n, profit: 1n, minOut: 1n, minProfit: 0n, swaps: [{ snap, inSide: 0, amountIn: 1n, out: 2n, minOut: 1n }] } as unknown as Plan, ownShare: 0 };
}
/** The chain execute talks to: `onSimulate` says whether the next simulation passes; every broadcast's priority is kept. */
function tradingConn(onSimulate: () => boolean = () => true) {
  const priorities: bigint[] = [];
  const { conn } = fakeConn();
  const send = conn.sendRawTransaction.bind(conn);
  let hashes = 0;
  Object.assign(conn, {
    getLatestBlockhash: async () => ({ blockhash: bs58.encode(Buffer.alloc(32, ++hashes)), lastValidBlockHeight: 1_000 }), // a later try is another transaction
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ lamports: 1 })),
    getTokenAccountBalance: async () => ({ value: { amount: "1000" } }),
    getBalance: async () => 10 ** 12,
    simulateTransaction: async () => ({ value: { err: onSimulate() ? null : { InstructionError: [0, { Custom: 1 }] }, unitsConsumed: 100_000, logs: [] } }),
    sendRawTransaction: async (raw: Uint8Array) => {
      const m = VersionedTransaction.deserialize(raw).message;
      const price = m.compiledInstructions.map((i) => Buffer.from(i.data)).find((d) => d[0] === 3)!; // SetComputeUnitPrice
      priorities.push(price.readBigUInt64LE(1));
      return send(raw);
    },
  });
  return { conn, priorities };
}
const racingEngine = (conn: Connection, wallet: Keypair, stateDir: string, cap: bigint) => createEngine({ conn, xdex: PublicKey.default, wallet, minProfit: 0n, maxIn: 1n, slipBps: 0n, reserve: 0n,
  priority: NORMAL, racePriority: RACE, stateDir, log: () => undefined, alert: async () => undefined, maxFeesPerDay: cap, feeReconcile: { hurryWaitMs: 5 } });

test("execute: room for the normal fee but not the race fee: the refusals don't keep the pool contested, and it goes out once at normal priority", async (t) => {
  const wallet = Keypair.generate(), stateDir = dir();
  let simulations = 0;
  const { conn, priorities } = tradingConn(() => simulations++ > 0); // the first one loses the race
  const cap = x1FeeReservation(1, UNITS, NORMAL) + 1n;
  assert.ok(x1FeeReservation(1, UNITS, RACE) > cap, "the race fee doesn't fit");
  const engine = racingEngine(conn, wallet, stateDir, cap);
  const f = tradePlan();
  const start = Date.now();
  let clock = start;
  t.mock.method(Date, "now", () => clock);
  assert.equal(await engine.execute([f]), 0, "gap gone: the pool is contested now");
  for (const secs of [10, 20]) {
    clock = start + secs * 1000;
    assert.equal(await engine.execute([f]), 0, "contested, and the race fee is refused");
  }
  assert.deepEqual(priorities, [], "nothing goes out while the race fee is the one asked");
  // Past the window from the failed simulation; a refused send must not have extended it.
  for (const secs of [31, 41, 51, 61]) {
    clock = start + secs * 1000;
    await engine.execute([f]);
  }
  assert.deepEqual(priorities, [BigInt(NORMAL)], "broadcast once, at normal priority");
  assert.equal(feesOf(stateDir, wallet).spent(clock), x1FeeReservation(1, UNITS, NORMAL));
});

test("execute: a fee journal that goes bad mid-send doesn't mark the pool contested either", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const file = path.join(stateDir, `arb-fees-${wallet.publicKey.toBase58()}.json`);
  let breakIt = true;
  const { conn, priorities } = tradingConn(() => { if (breakIt) { breakIt = false; fs.writeFileSync(file, "not json"); } return true; });
  const engine = racingEngine(conn, wallet, stateDir, 10n ** 12n);
  const f = tradePlan();
  assert.equal(await engine.execute([f]), 0, "refused");
  assert.deepEqual(priorities, []);
  fs.rmSync(file);
  await engine.execute([f]);
  assert.deepEqual(priorities, [BigInt(NORMAL)], "not the pool's fault: normal priority");
});
