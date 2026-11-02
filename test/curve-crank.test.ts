/**
 * The curve crank and launch status against a stand-in RPC, with no network and no real keys: what
 * the crank does past a deadline when sends fail, and with a graduation whose LP was burned.
 */
import { test, before, after, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { mockRpc, rpcError } from "./helpers/mock-rpc.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curve-crank-test-"));
process.env.REFLECT_FACTORY_DIR = path.join(dir, "factory");
fs.mkdirSync(process.env.REFLECT_FACTORY_DIR);
// Loaded after the directory is set: src/config.ts reads it once, on import.
const { CURVE_DISC, CURVE_LEN, CurveStatus, IX, LOCKER_PROGRAM_ID, LOCK_AFTER_SECS, REFUND_AFTER_SECS, curvePda } = await import("../src/curve.js");
const { REFUSAL_SPAN_SECS } = await import("../src/factory/curve-fallback.js");
const curves = await import("../src/factory/curve.js");
const launch = await import("../src/factory/launch.js");
const crankKey = path.join(dir, "crank.json");
fs.writeFileSync(crankKey, JSON.stringify([...Keypair.generate().secretKey]));

const program = Keypair.generate().publicKey;
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
type Step = keyof typeof IX;

function curveData(mint: PublicKey, o: { status: number; delivered?: bigint; createdAt?: number; lockNft?: PublicKey; positions?: number }) {
  const d = Buffer.alloc(CURVE_LEN);
  CURVE_DISC.copy(d);
  mint.toBuffer().copy(d, 8);
  Keypair.generate().publicKey.toBuffer().copy(d, 40);
  d.writeBigInt64LE(BigInt(o.createdAt ?? now() - 30 * DAY), 72 + 8 * 9);
  let at = 72 + 8 * 10;
  d[at] = o.status; at += 1;
  d.writeUInt32LE(o.positions ?? 0, at); at += 4;
  d.writeBigUInt64LE(o.delivered ?? 0n, at); at += 8;
  Keypair.generate().publicKey.toBuffer().copy(d, at); at += 32;
  (o.lockNft ?? PublicKey.default).toBuffer().copy(d, at);
  return d;
}

/** What the stand-in chain does. `refuse`: simulations carrying this step fail with lp_locker's error. */
const world = {
  accounts: new Map<string, { owner: string; data: Buffer }>(),
  refuse: new Set<Step>(), sends: [] as Buffer[], programQueries: [] as string[],
  // The RPC failing only for transactions carrying these steps, so a burn or refund that follows could go through.
  simDown: new Set<Step>(), sendDown: new Set<Step>(),
};
const account = (a: { owner: string; data: Buffer }) => ({ data: [a.data.toString("base64"), "base64"], executable: false, lamports: 1_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length });
const ctx = { context: { slot: 1, apiVersion: "1.18" } };
let rpc: Awaited<ReturnType<typeof mockRpc>>;
const conn = () => new Connection(rpc.url, { commitment: "confirmed", disableRetryOnRateLimit: true });

before(async () => {
  rpc = await mockRpc((method, params) => {
    switch (method) {
      case "getLatestBlockhash": return { ...ctx, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000_000 } };
      case "getAccountInfo": { const a = world.accounts.get(params[0]); return { ...ctx, value: a ? account(a) : null }; }
      case "getProgramAccounts": {
        world.programQueries.push(params[0]);
        if (params[0] !== program.toBase58() || params[1].filters?.length > 1) return [];
        return [...world.accounts.entries()].filter(([, a]) => a.owner === program.toBase58()).map(([pubkey, a]) => ({ pubkey, account: account(a) }));
      }
      case "simulateTransaction": {
        const raw = Buffer.from(params[0], "base64");
        if ([...world.simDown].some((s) => raw.includes(IX[s]))) return rpcError(-32005, "Too many requests");
        const refused = [...world.refuse].some((s) => raw.includes(IX[s]));
        return { ...ctx, value: { err: refused ? { InstructionError: [2, { Custom: 6001 }] } : null, unitsConsumed: 1000, accounts: null, returnData: null,
          logs: refused ? [`Program ${LOCKER_PROGRAM_ID.toBase58()} failed: custom program error: 0x1771`] : [] } };
      }
      case "sendTransaction": {
        const raw = Buffer.from(params[0], "base64");
        if ([...world.sendDown].some((s) => raw.includes(IX[s]))) return rpcError(-32005, "Too many requests");
        const tx = Transaction.from(Buffer.from(params[0], "base64"));
        world.sends.push(...tx.instructions.filter((i) => i.programId.equals(program)).map((i) => i.data));
        return "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
      }
      case "getSignatureStatuses": return { ...ctx, value: (params[0] as string[]).map(() => ({ slot: 1, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: "confirmed" })) };
      case "getBlockHeight": return 1;
      default: return rpcError(-32601, `not faked: ${method}`);
    }
  });
});
after(async () => { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { world.accounts.clear(); world.refuse.clear(); world.simDown.clear(); world.sendDown.clear(); world.sends.length = 0; world.programQueries.length = 0; });

const cfg = () => ({ network: "testnet", factory: { curve: { programId: program.toBase58(), crankKeypair: crankKey } }, xdex: { programId: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf" } }) as never;
const service = () => curves.curveService(conn(), cfg(), { microLamports: 1 });
const put = (mint: PublicKey, data: Buffer) => world.accounts.set(curvePda(program, mint).toBase58(), { owner: program.toBase58(), data });
const sent = (name: Step) => world.sends.filter((d) => d.subarray(0, 8).equals(IX[name])).length;

/** Crank passes `stepSecs` apart on a moved clock; the service keeps its sightings between them. */
async function passes(t: TestContext, s: ReturnType<typeof service>, n: number, stepSecs: number) {
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  try {
    for (let i = 0; i < n; i++) { t.mock.timers.setTime(start + i * stepSecs * 1000); await s.crankOnce(); }
  } finally { t.mock.timers.reset(); }
}
const pastBurn = () => BigInt(now() - LOCK_AFTER_SECS - DAY);

test("past the burn deadline: RPC errors on the lock's simulation never burn, however long they last", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: pastBurn() }));
  world.simDown.add("graduateLock");
  await passes(t, service(), 6, REFUSAL_SPAN_SECS);
  assert.equal(sent("graduateBurn"), 0);
});

test("past the burn deadline: the lock's send failing with a healthy simulation never burns", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: pastBurn() }));
  world.sendDown.add("graduateLock");
  await passes(t, service(), 6, REFUSAL_SPAN_SECS);
  assert.equal(sent("graduateBurn"), 0);
});

test("past the burn deadline: a refused lock burns only when seen again some time later", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: pastBurn() }));
  world.refuse.add("graduateLock");
  const s = service();
  await passes(t, s, 3, 1);
  assert.equal(sent("graduateBurn"), 0, "three sightings within seconds");
  await passes(t, s, 2, REFUSAL_SPAN_SECS);
  assert.equal(sent("graduateBurn"), 1, "the same refusal a minute on");
});

test("a lock that starts working again resets the count", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: pastBurn() }));
  const s = service();
  world.refuse.add("graduateLock");
  await passes(t, s, 1, 0);
  world.refuse.clear();
  world.sendDown.add("graduateLock"); // healthy simulation, but the send fails
  await passes(t, s, 1, 0);
  world.sendDown.clear();
  world.refuse.add("graduateLock");
  await passes(t, s, 1, REFUSAL_SPAN_SECS);
  assert.equal(sent("graduateBurn"), 0);
});

test("before the burn deadline a refused lock never burns", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: BigInt(now() - 60) }));
  world.refuse.add("graduateLock");
  await passes(t, service(), 6, REFUSAL_SPAN_SECS);
  assert.equal(sent("graduateBurn"), 0);
  assert.equal(sent("startBurnClock"), 0);
});

test("the old program's pool: starts the wait once the lock keeps being refused, never burns on the curve's age", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.PoolCreated, delivered: 0n, createdAt: now() - 400 * DAY }));
  world.simDown.add("graduateLock");
  const s = service();
  await passes(t, s, 3, REFUSAL_SPAN_SECS);
  assert.equal(sent("startBurnClock"), 0, "a transport failure starts nothing");
  world.simDown.clear();
  world.refuse.add("graduateLock");
  await passes(t, s, 2, REFUSAL_SPAN_SECS);
  assert.equal(sent("startBurnClock"), 1);
  assert.equal(sent("graduateBurn"), 0);
});

test("past the refund deadline: an RPC outage or failed send doesn't open refunds, a repeated refusal does", async (t) => {
  const mint = Keypair.generate().publicKey;
  put(mint, curveData(mint, { status: CurveStatus.Complete, delivered: BigInt(now() - REFUND_AFTER_SECS - DAY), positions: 1 }));
  const refunds: string[] = [];
  const s = service();
  const log = t.mock.method(console, "error", (m: unknown) => { refunds.push(String(m)); });
  world.simDown.add("graduatePool");
  await passes(t, s, 4, REFUSAL_SPAN_SECS);
  world.simDown.clear();
  world.sendDown.add("graduatePool");
  await passes(t, s, 4, REFUSAL_SPAN_SECS);
  assert.equal(refunds.filter((m) => /; refunding/.test(m)).length, 0);
  world.sendDown.clear();
  world.refuse.add("graduatePool");
  await passes(t, s, 2, REFUSAL_SPAN_SECS);
  assert.equal(refunds.filter((m) => /; refunding/.test(m)).length, 1, "the same refusal a minute apart");
  log.mock.restore();
});

/** A curve launch's record, on disk where the crank finds it. */
function record(mint: PublicKey) {
  const d = path.join(process.env.REFLECT_FACTORY_DIR!, "launches", mint.toBase58());
  fs.mkdirSync(d, { recursive: true });
  const r = { kind: "curve", mint: mint.toBase58(), creator: Keypair.generate().publicKey.toBase58(), name: "C", symbol: "C", description: "", image: "", supply: "1000000000",
    taxBps: 500, autoLpBps: 2500, burnBps: 0, poolTokens: "200000000", poolXnt: "10", lockDays: null, quote: "XNT", distributor: Keypair.generate().publicKey.toBase58(),
    pool: Keypair.generate().publicKey.toBase58(), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(d, "launch.json"), JSON.stringify(r));
  return r as never;
}

test("a burned graduation is never put through registration, pass after pass", async (t) => {
  const mint = Keypair.generate().publicKey;
  record(mint);
  put(mint, curveData(mint, { status: CurveStatus.Finished }));
  const errors: string[] = [];
  const log = t.mock.method(console, "error", (m: unknown) => { errors.push(String(m)); });
  await passes(t, service(), 3, 20);
  log.mock.restore();
  assert.ok(!world.programQueries.includes(LOCKER_PROGRAM_ID.toBase58()), "no lock lookup");
  assert.deepEqual(errors, [], "and no error every pass");
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.REFLECT_FACTORY_DIR!, "launches", mint.toBase58(), "launch.json"), "utf8")).registeredAt, undefined);
});

test("a locked graduation still goes through registration", async (t) => {
  const mint = Keypair.generate().publicKey;
  record(mint);
  put(mint, curveData(mint, { status: CurveStatus.Finished, lockNft: Keypair.generate().publicKey }));
  const log = t.mock.method(console, "error", () => {});
  await passes(t, service(), 1, 0);
  log.mock.restore();
  assert.ok(world.programQueries.includes(LOCKER_PROGRAM_ID.toBase58()), "it looks for the lock");
});

test("registerLaunch and launchStatus on a burned curve; a funded closed PDA reads as no curve", async () => {
  const mint = Keypair.generate().publicKey;
  const r = record(mint);
  put(mint, curveData(mint, { status: CurveStatus.Finished }));
  await assert.rejects(launch.registerLaunch(conn(), cfg(), r), /LP was burned at graduation/);
  const s = await launch.launchStatus(conn(), cfg(), r) as { lpBurned: boolean; lock: boolean; pool: boolean };
  assert.deepEqual([s.lpBurned, s.lock, s.pool], [true, false, true]);

  // After closing: anyone can fund the empty address.
  world.accounts.set(curvePda(program, mint).toBase58(), { owner: "11111111111111111111111111111111", data: Buffer.alloc(0) });
  assert.equal(await launch.readCurveOf(conn(), cfg(), r), null);
  const closed = await launch.launchStatus(conn(), cfg(), r) as { token: boolean; curveClosed: boolean };
  assert.equal(closed.token, false);
  assert.equal(closed.curveClosed, false, "no mint on-chain here: never created");
  world.accounts.set(mint.toBase58(), { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: Buffer.alloc(82) });
  assert.equal((await launch.launchStatus(conn(), cfg(), r) as { curveClosed: boolean }).curveClosed, true);
});

test("an RPC failure on the curve read is an error, not 'no curve'", async () => {
  const mint = Keypair.generate().publicKey;
  const dead = new Connection("http://127.0.0.1:9", { commitment: "confirmed", disableRetryOnRateLimit: true });
  await assert.rejects(launch.readCurveOf(dead, cfg(), record(mint)));
});
