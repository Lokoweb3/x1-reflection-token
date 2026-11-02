/**
 * What survives a power cut or a stumble: the order things reach the disk (seen through the
 * flushes, on Linux's /proc), and journal cleanup running over itself or a failing RPC. Its own
 * process and an as yet uncreated factory directory two levels down. No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Config } from "../src/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-durability-test-"));
const factory = path.join(root, "nest", "factory");
process.env.REFLECT_FACTORY_DIR = factory;
process.env.PINATA_JWT = "";
const { applyMetadataUpdate, buildTokenStep, gcPendingJournal, isPendingLaunch, onLaunchSaved, persistLaunch, readLaunch, recoverPendingLaunches, sweepPendingLaunches } = await import("../src/factory/launch.js");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const feeMint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
const cfg = {
  network: "testnet", xdex: { programId: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf", pool: "" },
  factory: { feeReceiver: Keypair.generate().publicKey.toBase58(), feeUsdc: "1", gasXnt: "0.05", feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" } },
} as unknown as Config;
const params = { creator: creator.toBase58(), name: "Pending", symbol: "PEND", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 0, poolTokens: "1000000000", poolXnt: "1", lockDays: null, quote: "XNT" };
const launches = path.join(factory, "launches"), journals = path.join(factory, "pending-launches");
const saved = (m: string, f: string) => path.join(launches, m, f), journal = (m: string, f = "") => path.join(journals, m, f);
const onChainAccount = { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 5, executable: false };
function fakeConn(onChain = new Set<string>()) {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  return {
    getMinimumBalanceForRentExemption: async (n: number) => 1_000 * n,
    getAccountInfo: async (k: PublicKey) => (k.equals(feeMint) ? { owner: TOKEN_PROGRAM_ID, data: mintData, lamports: 1, executable: false } : { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 1, executable: false }),
    getTokenAccountBalance: async () => ({ value: { amount: "5000000", decimals: 6, uiAmount: 5 } }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (onChain.has(k.toBase58()) ? onChainAccount : null)),
  } as unknown as Connection;
}
const newLaunch = async () => (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
/** The flushed directories, in order, with the journal's key removal among them. */
function watchDisk(t: { mock: { method: (o: object, m: string, f: (...a: never[]) => unknown) => unknown } }) {
  const events: string[] = [];
  const realFsync = fs.fsyncSync.bind(fs), realRm = fs.rmSync.bind(fs), realRename = fs.renameSync.bind(fs);
  t.mock.method(fs, "fsyncSync", ((fd: number) => { realFsync(fd); events.push(`sync ${fs.readlinkSync(`/proc/self/fd/${fd}`)}`); }) as never);
  t.mock.method(fs, "rmSync", ((p: string, o: fs.RmOptions) => { events.push(`rm ${p}`); realRm(p, o); }) as never);
  t.mock.method(fs, "renameSync", ((a: string, b: string) => { events.push(`rename ${a} ${b}`); realRename(a, b); }) as never);
  return events;
}
const syncedBefore = (events: string[], end: number) => new Set(events.slice(0, end).filter((e) => e.startsWith("sync ")).map((e) => e.slice(5)));
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };

// First in the file: nothing under `root` exists yet.
test("the first journal flushes every directory it created, up to the one above them", async (t) => {
  assert.equal(fs.existsSync(path.join(root, "nest")), false);
  const events = watchDisk(t);
  const { mint } = await newLaunch();
  const flushed = syncedBefore(events, events.length);
  for (const d of [journal(mint), journals, factory, path.join(root, "nest"), root]) assert.ok(flushed.has(real(d)), `${d} flushed (${[...flushed].join(", ")})`);
});

test("the first save flushes launches/ and its parent before the journal's key is given up", async (t) => {
  const { mint } = await newLaunch();
  const key = fs.readFileSync(journal(mint, "distributor.json"), "utf8");
  assert.equal(fs.existsSync(launches), false, "no launch saved yet");
  const events = watchDisk(t);
  assert.equal(persistLaunch(mint), true);
  const gone = events.findIndex((e) => e === `rm ${journal(mint)}`);
  assert.ok(gone > 0, "the journal goes");
  const flushed = syncedBefore(events, gone);
  for (const d of [path.join(launches, mint), launches, factory]) assert.ok(flushed.has(real(d)), `${d} flushed before the journal goes (${[...flushed].join(", ")})`);
  assert.equal(events.filter((e) => e.startsWith(`rename ${journal(mint, "distributor.json")}`)).length, 0, "the journal's key is copied, never moved away");
  assert.equal(fs.readFileSync(saved(mint, "distributor.json"), "utf8"), key);
  assert.equal(fs.statSync(saved(mint, "distributor.json")).mode & 0o777, 0o600);
});

const noSpace = () => { throw Object.assign(new Error("ENOSPC: no space left on device, fsync"), { code: "ENOSPC", syscall: "fsync" }); };
test("a flush failing after a file was renamed into place keeps the journal, and the retry completes", async (t) => {
  // The nth directory flush fails, for each n of the save: the renames before it have happened.
  const realFsync = fs.fsyncSync.bind(fs);
  for (let n = 1; ; n++) {
    const { mint } = await newLaunch();
    const key = fs.readFileSync(journal(mint, "distributor.json"), "utf8");
    let dirSyncs = 0;
    const m = t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (fs.fstatSync(fd).isDirectory() && ++dirSyncs === n) noSpace();
      realFsync(fd);
    });
    const ok = persistLaunch(mint);
    m.mock.restore();
    if (ok) { assert.ok(n > 3, "the save flushes several directories"); break; }
    assert.ok(isPendingLaunch(mint), `flush ${n}: still pending`);
    assert.equal(fs.readFileSync(journal(mint, "distributor.json"), "utf8"), key, `flush ${n}: the journal keeps the key`);
    assert.ok(fs.existsSync(journal(mint, "launch.json")), `flush ${n}: and the record`);
    assert.equal(persistLaunch(mint), true, `flush ${n}: the retry saves it`);
    assert.equal(fs.readFileSync(saved(mint, "distributor.json"), "utf8"), key);
    assert.equal(fs.existsSync(journal(mint)), false);
  }
});

test("each save tells the server, after it's on disk; a failed one doesn't", async (t) => {
  const seen: string[] = [];
  onLaunchSaved((r) => { assert.ok(fs.existsSync(saved(r.mint, "launch.json"))); seen.push(r.description); });
  const { mint } = await newLaunch();
  const m = t.mock.method(fs, "fsyncSync", noSpace);
  assert.equal(persistLaunch(mint), false);
  m.mock.restore();
  assert.deepEqual(seen, []);
  persistLaunch(mint);
  applyMetadataUpdate(readLaunch(mint)!, { description: "new" });
  assert.deepEqual(seen, ["", "new"]);
  onLaunchSaved(() => undefined);
});

/** A launch past its window: out of memory, its journal left for the GC. */
async function dormant(t: { mock: { method: (o: object, m: string, f: () => number) => { mock: { restore(): void } } } }) {
  const r = await newLaunch();
  const now = Date.now();
  const m = t.mock.method(Date, "now", () => now + 16 * 60_000);
  await sweepPendingLaunches(fakeConn());
  m.mock.restore();
  assert.equal(isPendingLaunch(r.mint), false);
  return r;
}

test("GC runs overlapping: one chain read, and a copy read before it can't overwrite what was saved meanwhile", async (t) => {
  const r = await dormant(t as never);
  let reads = 0, answer = () => {};
  const slow = { getMultipleAccountsInfo: (keys: PublicKey[]) => { reads++; return new Promise((res) => { answer = () => res(keys.map(() => onChainAccount)); }); } } as unknown as Connection;
  const first = gcPendingJournal(slow), second = gcPendingJournal(slow);
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(reads, 1, "single flight");
  // During that read something else saved it (a restart's sweep, say), and registration moved it on.
  recoverPendingLaunches();
  persistLaunch(r.mint);
  applyMetadataUpdate(readLaunch(r.mint)!, { description: "updated", registeredAt: "2026-11-02T00:00:00.000Z" });
  answer();
  await Promise.all([first, second]);
  const onDisk = JSON.parse(fs.readFileSync(saved(r.mint, "launch.json"), "utf8"));
  assert.equal(onDisk.registeredAt, "2026-11-02T00:00:00.000Z");
  assert.equal(onDisk.description, "updated");
});

test("a saved launch with its journal left over: the GC finishes the job, without a chain read", async () => {
  const r = await newLaunch();
  const key = fs.readFileSync(journal(r.mint, "distributor.json"), "utf8");
  persistLaunch(r.mint);
  fs.mkdirSync(journal(r.mint), { recursive: true });
  fs.writeFileSync(journal(r.mint, "distributor.json"), key, { mode: 0o600 });
  fs.rmSync(saved(r.mint, "distributor.json"));
  const never = { getMultipleAccountsInfo: async () => { throw new Error("no read needed"); } } as unknown as Connection;
  await gcPendingJournal(never);
  assert.equal(fs.readFileSync(saved(r.mint, "distributor.json"), "utf8"), key);
  assert.equal(fs.existsSync(journal(r.mint)), false);
});

/** Journals written directly: many, without a key. */
function writeJournals(n: number) {
  return Array.from({ length: n }, () => {
    const mint = Keypair.generate().publicKey.toBase58();
    fs.mkdirSync(journal(mint), { recursive: true });
    fs.writeFileSync(journal(mint, "launch.json"), JSON.stringify({ ...params, mint, distributor: Keypair.generate().publicKey.toBase58(), pool: mint, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
    return mint;
  });
}
/** Fails the first `failures` reads; all accounts exist. */
function flaky(failures: number) {
  const seen: number[] = [];
  return { seen, conn: { getMultipleAccountsInfo: async (keys: PublicKey[]) => {
    seen.push(keys.length);
    if (seen.length <= failures) throw new Error("rpc down");
    return keys.map(() => onChainAccount);
  } } as unknown as Connection };
}

test("recovery after downtime: bounded batches, one failed batch doesn't stop the others, and it's retried", async () => {
  const mints = writeJournals(250);
  assert.ok(recoverPendingLaunches() >= 250);
  mints.forEach((m) => assert.ok(isPendingLaunch(m)));
  const first = flaky(1);
  assert.equal(await sweepPendingLaunches(first.conn), false, "not everything could be read");
  assert.ok(first.seen.every((n) => n <= 100), `batches of ${first.seen.join(", ")}`);
  assert.ok(first.seen.length >= 3, "the batches after the failed one still ran");
  const left = mints.filter((m) => isPendingLaunch(m));
  assert.ok(left.length > 0 && left.length <= 100, `only the failed batch is left (${left.length})`);
  left.forEach((m) => assert.ok(fs.existsSync(journal(m, "launch.json"))));
  mints.filter((m) => !left.includes(m)).forEach((m) => assert.ok(fs.existsSync(saved(m, "launch.json"))));
  assert.equal(await sweepPendingLaunches(flaky(0).conn), true);
  mints.forEach((m) => assert.ok(fs.existsSync(saved(m, "launch.json"))));
});

test("sweeps overlapping share one run", async () => {
  await newLaunch();
  const f = flaky(0);
  await Promise.all([sweepPendingLaunches(f.conn), sweepPendingLaunches(f.conn), sweepPendingLaunches(f.conn)]);
  assert.equal(f.seen.length, 1);
});

test("the journal GC reads in batches too, and a failed one only delays its own", async (t) => {
  const mints = writeJournals(120);
  void t;
  const f = flaky(1);
  await gcPendingJournal(f.conn);
  assert.ok(f.seen.length >= 3 && f.seen.every((n) => n <= 100), `reads of ${f.seen.join(", ")}`);
  const left = mints.filter((m) => !fs.existsSync(saved(m, "launch.json")));
  assert.equal(left.length, 50, "one batch of 50 still waits");
  await gcPendingJournal(flaky(0).conn);
  mints.forEach((m) => assert.ok(fs.existsSync(saved(m, "launch.json"))));
});
