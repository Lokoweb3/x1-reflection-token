// The engine's send against a modelled RPC: no network, no real sends. What is modelled: the RPC answers below, with
// every transaction confirming at once. The trades of executeNow are modelled by parallel engine.send calls (it sends
// with Promise.all over this same send).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { createEngine } from "../src/arb-engine.js";
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
    log: () => undefined, alert: async (s) => { alerts.push(s); }, maxFeesPerDay: cap, feeReconcile });
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
  assert.ok(await until(() => !feesOf(stateDir, wallet).unsettled(Date.now()).some((u) => u.signature === "LATE")), "reached past the five oldest");
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

test("a direct send (sweep, peg, limit) against a full cap reconciles first, and goes out if that makes room", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const cap = reservation + 1_000n;
  // Recent reservations, so only a send's own urgent pass reaches them; together they fill the cap.
  seed(stateDir, wallet, [{ at: Date.now() - 1_000, fee: cap.toString(), signature: "FULL", lastValidBlockHeight: 100 }]);
  const { conn, sent } = fakeConn({ fee: (sig) => (sig === "FULL" ? 500 : 600) });
  assert.equal(await engineOn(conn, wallet, stateDir, cap).send(ix(wallet, 1), false, { units: 100_000 }).then(() => "sent"), "sent");
  assert.equal(sent.length, 1);
});

test("the same with room short of the fee, not at the cap: the reservation's own refusal reconciles too", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const cap = reservation + 1_000n;
  seed(stateDir, wallet, [{ at: Date.now() - 1_000, fee: "2000", signature: "ALMOST", lastValidBlockHeight: 100 }]);
  const { conn, sent } = fakeConn({ fee: (sig) => (sig === "ALMOST" ? 500 : null) });
  await engineOn(conn, wallet, stateDir, cap).send(ix(wallet, 1), false, { units: 100_000 });
  assert.equal(sent.length, 1);
});

test("no room to be made: refused, and a hung RPC can't hold the send past its bound", async () => {
  const wallet = Keypair.generate(), stateDir = dir();
  const cap = reservation + 1_000n;
  seed(stateDir, wallet, [{ at: Date.now() - 1_000, fee: cap.toString(), signature: "FULL", lastValidBlockHeight: 100 }]);
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
