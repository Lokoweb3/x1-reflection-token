/**
 * New launch records: journalled with the distributor key before step 1's transaction goes out,
 * moved to the launches once the token is on-chain; a step 1 that never lands leaves only a
 * journal, removed after a day with proof from the chain. Saved records whose token never reached
 * the chain need the same proof and carry what it takes; anything else is kept. No network: the connection is a stand-in. The server's own
 * hooks and a real kill and restart are in factory-site.test.ts.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Config } from "../src/config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-launch-test-"));
process.env.REFLECT_FACTORY_DIR = dir;
process.env.PINATA_JWT = "";
const { applyMetadataUpdate, buildTokenStep, gcLaunchRecords, gcPendingJournal, handOutLaunchStep, isPendingLaunch, listLaunches, persistLaunch, readLaunch, recoverPendingLaunches, sweepPendingLaunches } = await import("../src/factory/launch.js");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const feeMint = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const cfg = {
  network: "testnet", xdex: { programId: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf", pool: "" },
  factory: { feeReceiver: Keypair.generate().publicKey.toBase58(), feeUsdc: "1", gasXnt: "0.05", feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" } },
} as unknown as Config;
const params = {
  creator: creator.toBase58(), name: "Pending", symbol: "PEND", description: "", image: "", supply: "1000000000", taxBps: 500,
  autoLpBps: 2500, burnBps: 0, poolTokens: "1000000000", poolXnt: "1", lockDays: null, quote: "XNT",
};
const file = (mint: string, f: string) => path.join(dir, "launches", mint, f);
const journal = (mint: string, f = "") => path.join(dir, "pending-launches", mint, f);
const noSpace = () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" }); };

/** The builder's reads (fee token, creator balance), and `onChain` for the sweeps' account reads. */
function fakeConn(onChain = new Set<string>(), funded = new Set<string>()) {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  return {
    getMinimumBalanceForRentExemption: async (n: number) => 1_000 * n,
    getAccountInfo: async (k: PublicKey) => (k.equals(feeMint)
      ? { owner: TOKEN_PROGRAM_ID, data: mintData, lamports: 1, executable: false }
      : { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 1, executable: false }),
    getTokenAccountBalance: async () => ({ value: { amount: "5000000", decimals: 6, uiAmount: 5 } }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (onChain.has(k.toBase58()) || funded.has(k.toBase58())
      ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 5, executable: false } : null)),
  } as unknown as Connection;
}

/**
 * For the removal proof, on top of `fakeConn`'s plain reads: the finalized tip, and a finalized read at or past `readSlot`,
 * where `seen` are the accounts that read finds (a lagging node's plain read can miss them).
 */
function chainAt(height: number, opts: { onChain?: Set<string>; funded?: Set<string>; seen?: Set<string>; readSlot?: number; slot?: number; fail?: "tip" | "read" } = {}) {
  const slot = opts.slot ?? height + 40;
  const reads: unknown[] = [];
  const conn = Object.assign(fakeConn(opts.onChain, opts.funded), {
    getEpochInfo: async (c: unknown) => {
      assert.equal(c, "finalized");
      if (opts.fail === "tip") throw new Error("rpc down");
      return { absoluteSlot: slot, blockHeight: height, epoch: 1, slotIndex: 1, slotsInEpoch: 100 };
    },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[], c: { commitment: string; minContextSlot: number }) => {
      reads.push(c);
      assert.equal(c.commitment, "finalized");
      assert.equal(c.minContextSlot, slot);
      if (opts.fail === "read") throw new Error("rpc down");
      return { context: { slot: opts.readSlot ?? slot }, value: keys.map((k) => (opts.seen?.has(k.toBase58()) ? { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 5, executable: false } : null)) };
    },
  });
  return { conn, reads };
}
/** A step 1 handed out with this last valid block height, then a day and more gone by. */
async function expiredStep(t: TestContext, lastValid: number | null = 100) {
  const r = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  if (lastValid !== null) await handOutLaunchStep(r.mint, async (built) => built(lastValid));
  const c = clock(t);
  c.set(Date.parse(r.createdAt) + 25 * 3_600_000);
  await sweepPendingLaunches(fakeConn());
  assert.equal(isPendingLaunch(r.mint), false);
  return r;
}
const walletOf = (mint: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(journal(mint, "distributor.json"), "utf8")))).publicKey.toBase58();

/** The clock for one test, moved by what's returned (one mock: stacking them doesn't restore cleanly). */
function clock(t: TestContext) {
  const start = Date.now();
  let at = start;
  t.mock.method(Date, "now", () => at);
  return { start, set: (ms: number) => { at = ms; } };
}

test("step 1 is journalled with its key before anything else, and stays out of the launches", async () => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  assert.equal(fs.existsSync(path.join(dir, "launches", record.mint)), false);
  assert.equal(JSON.parse(fs.readFileSync(journal(record.mint, "launch.json"), "utf8")).mint, record.mint);
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(journal(record.mint, "distributor.json"), "utf8"))));
  assert.equal(key.publicKey.toBase58(), record.distributor);
  assert.equal(fs.statSync(journal(record.mint, "distributor.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(journal(record.mint)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(journal(record.mint)).sort(), ["distributor.json", "launch.json"], "no temp files left");
  assert.equal(readLaunch(record.mint)?.symbol, "PEND");
  assert.ok(listLaunches().some((r) => r.mint === record.mint));
  assert.ok(isPendingLaunch(record.mint));
});

test("a journal that can't be written fails the step: no record, no key, nothing to sign", async (t) => {
  const before = fs.existsSync(path.join(dir, "pending-launches")) ? fs.readdirSync(path.join(dir, "pending-launches")).length : 0;
  const m = t.mock.method(fs, "fsyncSync", noSpace);
  await assert.rejects(buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1"), /ENOSPC/);
  m.mock.restore();
  assert.equal(fs.readdirSync(path.join(dir, "pending-launches")).length, before, "nothing half written stays");
});

test("once the mint is on-chain the record and its distributor key are saved", async () => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  await sweepPendingLaunches(fakeConn(new Set([record.mint])));
  assert.equal(isPendingLaunch(record.mint), false);
  assert.equal(JSON.parse(fs.readFileSync(file(record.mint, "launch.json"), "utf8")).mint, record.mint);
  // The key whose public half is the token's withdraw authority, readable by the owner only.
  const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file(record.mint, "distributor.json"), "utf8"))));
  assert.equal(key.publicKey.toBase58(), record.distributor);
  assert.equal(fs.statSync(file(record.mint, "distributor.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(journal(record.mint)), false, "the journal is cleared");
  // Listed once, from disk.
  assert.equal(listLaunches().filter((r) => r.mint === record.mint).length, 1);
});

test("a disk error while saving loses nothing: the entry and journal stay, and the next try saves it", async (t) => {
  for (const [what, method] of [["the record", "fsyncSync"], ["the directory", "mkdirSync"], ["the key's move", "renameSync"]] as const) {
    const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
    const secret = fs.readFileSync(journal(record.mint, "distributor.json"), "utf8");
    const m = t.mock.method(fs, method, noSpace);
    assert.equal(persistLaunch(record.mint), false, `${what}: reported, not thrown`);
    await sweepPendingLaunches(fakeConn(new Set([record.mint]))); // retried, and fails again
    m.mock.restore();
    assert.ok(isPendingLaunch(record.mint), `${what}: still pending`);
    assert.equal(readLaunch(record.mint)?.mint, record.mint);
    assert.ok(fs.existsSync(journal(record.mint, "launch.json")), `${what}: journal kept`);
    assert.ok(!fs.existsSync(file(record.mint, "launch.json")), `${what}: no partial record`);
    await sweepPendingLaunches(fakeConn(new Set([record.mint])));
    assert.equal(isPendingLaunch(record.mint), false, `${what}: saved once the disk works`);
    assert.equal(fs.readFileSync(file(record.mint, "distributor.json"), "utf8"), secret);
    assert.equal(JSON.parse(fs.readFileSync(file(record.mint, "launch.json"), "utf8")).mint, record.mint);
  }
});

test("a saved record is replaced atomically: a failed write leaves the old one, and no temp file", async (t) => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  persistLaunch(record.mint);
  const m = t.mock.method(fs, "renameSync", noSpace);
  assert.throws(() => applyMetadataUpdate(record, { description: "new" }), /ENOSPC/);
  m.mock.restore();
  assert.equal(JSON.parse(fs.readFileSync(file(record.mint, "launch.json"), "utf8")).description, "");
  assert.deepEqual(fs.readdirSync(path.dirname(file(record.mint, "launch.json"))).sort(), ["distributor.json", "launch.json"]);
});

test("a sweep's slow chain read doesn't overwrite what another path saved meanwhile", async () => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  let answer = () => {};
  const slow = { getMultipleAccountsInfo: (keys: PublicKey[]) => new Promise((r) => {
    answer = () => r(keys.map(() => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 5, executable: false })));
  }) } as unknown as Connection;
  const sweeping = sweepPendingLaunches(slow);
  // Meanwhile /api/send saves it, and a later step changes it (registration, a metadata update).
  persistLaunch(record.mint);
  applyMetadataUpdate(readLaunch(record.mint)!, { description: "updated", registeredAt: "2026-11-02T00:00:00.000Z" });
  answer();
  await sweeping;
  const saved = JSON.parse(fs.readFileSync(file(record.mint, "launch.json"), "utf8"));
  assert.equal(saved.description, "updated");
  assert.equal(saved.registeredAt, "2026-11-02T00:00:00.000Z");
});

test("persistLaunch (the pool step, /api/send) saves at once; a step 1 that never lands stops being listed, its journal stays a day", async (t) => {
  const a = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  persistLaunch(a.mint);
  assert.ok(fs.existsSync(file(a.mint, "launch.json")) && fs.existsSync(file(a.mint, "distributor.json")));

  const b = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await sweepPendingLaunches(fakeConn());
  assert.ok(isPendingLaunch(b.mint), "still waiting: its blockhash may not have expired yet");
  const c = clock(t), now = c.start;
  c.set(now + 16 * 60_000);
  await sweepPendingLaunches(fakeConn());
  assert.equal(isPendingLaunch(b.mint), false);
  assert.equal(readLaunch(b.mint), null);
  assert.equal(fs.existsSync(path.join(dir, "launches", b.mint)), false);
  assert.ok(fs.existsSync(journal(b.mint, "distributor.json")), "kept in case that chain read was wrong");
  // Before the day is up, nothing goes; and if the mint turns out to exist, it's saved.
  assert.deepEqual(await gcPendingJournal(fakeConn()), []);
  assert.ok(fs.existsSync(journal(b.mint, "launch.json")));
  await gcPendingJournal(fakeConn(new Set([b.mint])));
  assert.ok(fs.existsSync(file(b.mint, "launch.json")) && fs.existsSync(file(b.mint, "distributor.json")));
  assert.equal(fs.existsSync(journal(b.mint)), false);
});

test("the journal GC removes only what never reached the chain, after a day", async (t) => {
  const { createdAt, mint: abandoned } = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await handOutLaunchStep(abandoned, async (built) => built(100));
  const funded = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await handOutLaunchStep(funded.mint, async (built) => built(100));
  const landed = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  const c = clock(t), later = Date.parse(createdAt) + 25 * 3_600_000;
  c.set(later);
  await sweepPendingLaunches(fakeConn()); // past their window: out of memory
  // A journal with the record unreadable is never removed while its mint exists.
  const torn = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  fs.writeFileSync(journal(torn.mint, "launch.json"), "{");
  const t2 = later + 60 * 60_000;
  c.set(t2);
  await sweepPendingLaunches(fakeConn());
  const removed = await gcPendingJournal(chainAt(101, { onChain: new Set([landed.mint, torn.mint]), funded: new Set([funded.distributor]), seen: new Set([funded.distributor]) }).conn);
  assert.ok(removed.includes(abandoned));
  assert.equal(fs.existsSync(journal(abandoned)), false);
  assert.ok(fs.existsSync(journal(funded.mint, "distributor.json")), "a funded wallet: kept");
  assert.ok(fs.existsSync(file(landed.mint, "launch.json")), "a mint on-chain: saved");
  assert.ok(fs.existsSync(journal(torn.mint, "distributor.json")), "unreadable record: kept");
  fs.rmSync(journal(funded.mint), { recursive: true });
  fs.rmSync(journal(torn.mint), { recursive: true });
});

test("removal needs a finalized read past the step's validity: a stale null from a lagging node changes nothing", async (t) => {
  const r = await expiredStep(t);
  const wallet = walletOf(r.mint);
  const kept = async (why: string, conn: Connection) => {
    assert.deepEqual(await gcPendingJournal(conn), [], why);
    assert.ok(fs.existsSync(journal(r.mint, "distributor.json")), why);
    assert.ok(fs.existsSync(journal(r.mint, "launch.json")), why);
  };
  // Every plain read here says mint and wallet are gone.
  await kept("the tip isn't past the validity", chainAt(100, { readSlot: 500 }).conn);
  await kept("the node reading is behind the tip", chainAt(150, { slot: 190, readSlot: 189 }).conn);
  await kept("no tip", chainAt(150, { fail: "tip" }).conn);
  await kept("no read", chainAt(150, { fail: "read" }).conn);
  await kept("a node without the method", fakeConn());
  await kept("a tip without a height", Object.assign(chainAt(150).conn, { getEpochInfo: async () => ({ absoluteSlot: 190, epoch: 1, slotIndex: 1, slotsInEpoch: 100 }) }));
  await kept("the finalized read finds the mint", chainAt(150, { seen: new Set([r.mint]) }).conn);
  await kept("the finalized read finds the wallet funded", chainAt(150, { seen: new Set([wallet]) }).conn);
  const proof = chainAt(101);
  assert.deepEqual(await gcPendingJournal(proof.conn), [r.mint], "proof: finalized, past it, neither found");
  assert.equal(proof.reads.length, 1);
  assert.equal(fs.existsSync(journal(r.mint)), false);
});

test("a vault launch (no wallet to look at) needs the same proof", async (t) => {
  const r = await expiredStep(t);
  fs.rmSync(journal(r.mint, "distributor.json"));
  await gcPendingJournal(chainAt(150, { slot: 190, readSlot: 100 }).conn);
  assert.ok(fs.existsSync(journal(r.mint, "launch.json")), "a lagging read");
  await gcPendingJournal(chainAt(150, { seen: new Set([r.mint]) }).conn);
  assert.ok(fs.existsSync(journal(r.mint, "launch.json")), "the mint is there");
  assert.deepEqual(await gcPendingJournal(chainAt(150).conn), [r.mint]);
});

test("a journal from before the validity was kept, or with it unreadable, stays and says so", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (m: unknown) => { lines.push(String(m)); });
  const old = await expiredStep(t, null);
  assert.deepEqual(await gcPendingJournal(chainAt(10_000).conn), []);
  assert.ok(fs.existsSync(journal(old.mint, "launch.json")));
  assert.ok(lines.some((l) => l.includes(old.mint) && /kept/.test(l)), lines.join("; "));
  for (const bad of ["{", "null", "{}", '{"lastValidBlockHeight":"100"}', '{"lastValidBlockHeight":-1}']) {
    fs.writeFileSync(journal(old.mint, "step.json"), bad);
    assert.deepEqual(await gcPendingJournal(chainAt(10_000).conn), [], bad);
  }
  // An old journal whose mint turns out to exist is still saved.
  await gcPendingJournal(chainAt(10_000, { onChain: new Set([old.mint]) }).conn);
  assert.ok(fs.existsSync(file(old.mint, "launch.json")));
});

test("a step handed out: what it needs is on disk before the bytes are returned; never handed out, nothing stays", async () => {
  const r = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  const tx = await handOutLaunchStep(r.mint, async (built) => {
    built(4_242);
    assert.deepEqual(JSON.parse(fs.readFileSync(journal(r.mint, "step.json"), "utf8")), { lastValidBlockHeight: 4_242 });
    return "bytes";
  });
  assert.equal(tx, "bytes");
  persistLaunch(r.mint);
  assert.equal(fs.existsSync(journal(r.mint)), false, "goes with the journal");
  const failed = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await assert.rejects(handOutLaunchStep(failed.mint, async () => { throw new Error("Simulation failed"); }), /Simulation failed/);
  assert.equal(fs.existsSync(journal(failed.mint)), false, "no transaction left this server");
  assert.equal(isPendingLaunch(failed.mint), false);
  assert.equal(readLaunch(failed.mint), null);
});

test("recoverPendingLaunches brings back every journal, whatever its age; the sweep settles it on an answer from the chain", async (t) => {
  const { record: { mint } } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  const c = clock(t), now = c.start;
  c.set(now + 16 * 60_000);
  await sweepPendingLaunches(fakeConn());
  assert.equal(isPendingLaunch(mint), false);
  // A restart much later: readable again, until a chain read that answers says otherwise.
  c.set(now + 3 * 3_600_000);
  assert.ok(recoverPendingLaunches() >= 1);
  assert.ok(isPendingLaunch(mint));
  assert.equal(readLaunch(mint)?.mint, mint);
  const down = { getMultipleAccountsInfo: async () => { throw new Error("rpc down"); } } as unknown as Connection;
  assert.equal(await sweepPendingLaunches(down), false, "reported, to be retried soon");
  assert.ok(isPendingLaunch(mint), "a failed read decides nothing");
  assert.equal(await sweepPendingLaunches(fakeConn(new Set([mint]))), true);
  assert.ok(fs.existsSync(file(mint, "distributor.json")));
});

const old = () => new Date(Date.now() - 2 * 86_400_000).toISOString();
/** A saved launch written directly, with its recorded step 1 validity (null: from before that was kept). */
function writeRecord(opts: { extra?: Record<string, unknown>; files?: string[]; lastValid?: number | null; key?: boolean; mint?: string } = {}) {
  const mint = opts.mint ?? Keypair.generate().publicKey.toBase58(), distributor = Keypair.generate();
  fs.mkdirSync(path.join(dir, "launches", mint), { recursive: true });
  fs.writeFileSync(file(mint, "launch.json"), JSON.stringify({ ...params, mint, distributor: distributor.publicKey.toBase58(), pool: mint, createdAt: old(), ...opts.extra }));
  if (opts.key !== false) fs.writeFileSync(file(mint, "distributor.json"), JSON.stringify(Array.from(distributor.secretKey)));
  if (opts.lastValid !== null) fs.writeFileSync(file(mint, "step.json"), JSON.stringify({ lastValidBlockHeight: opts.lastValid ?? 100 }));
  for (const f of opts.files ?? []) fs.writeFileSync(file(mint, f), "{}");
  return { mint, distributor: distributor.publicKey.toBase58() };
}
const present = (mint: string) => fs.existsSync(file(mint, "launch.json")) && fs.existsSync(file(mint, "distributor.json"));
/** The real flow: step 1 built and handed out, saved (a confirmed read saw it, or the relay's confirmation), then over a day old. */
async function savedLaunch(lastValid = 100) {
  const r = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await handOutLaunchStep(r.mint, async (built) => built(lastValid));
  assert.equal(persistLaunch(r.mint), true);
  fs.writeFileSync(file(r.mint, "launch.json"), JSON.stringify({ ...r, createdAt: old() }));
  return r;
}

test("records: a stale null from a lagging node doesn't remove a launch or its key", async () => {
  const r = await savedLaunch();
  const key = fs.readFileSync(file(r.mint, "distributor.json"), "utf8");
  // The plain confirmed read says mint and wallet are gone.
  assert.deepEqual(await gcLaunchRecords(fakeConn()), []);
  assert.equal(fs.readFileSync(file(r.mint, "distributor.json"), "utf8"), key);
  // It really landed: every plain read still misses it, the finalized one finds it.
  assert.deepEqual(await gcLaunchRecords(chainAt(10_000, { seen: new Set([r.mint, r.distributor]) }).conn), []);
  assert.equal(fs.readFileSync(file(r.mint, "distributor.json"), "utf8"), key);
  fs.rmSync(path.join(dir, "launches", r.mint), { recursive: true });
});

test("records: a new launch abandoned after step 1 carries its evidence and goes once proven; the record itself is unchanged", async () => {
  const r = await savedLaunch(4_242);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(r.mint, "step.json"), "utf8")), { lastValidBlockHeight: 4_242 });
  assert.equal(fs.statSync(file(r.mint, "step.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(journal(r.mint)), false, "the journal is gone, the evidence isn't");
  assert.equal("lastValidBlockHeight" in readLaunch(r.mint)!, false, "the record means what it did");
  assert.deepEqual(await gcLaunchRecords(chainAt(4_242).conn), [], "not past it yet");
  const proof = chainAt(4_243);
  assert.deepEqual(await gcLaunchRecords(proof.conn), [r.mint]);
  assert.equal(proof.reads.length, 1, "one finalized answer for the mint and the wallet");
  assert.equal(fs.existsSync(path.join(dir, "launches", r.mint)), false);
});

test("records: anything short of the proof keeps the record and key", async () => {
  const { mint, distributor } = writeRecord();
  const kept = async (why: string, conn: Connection) => {
    assert.deepEqual(await gcLaunchRecords(conn), [], why);
    assert.ok(present(mint), why);
  };
  const answer = (value: unknown, slot: unknown = 190) => async () => ({ context: { slot }, value });
  await kept("the tip isn't past the validity", chainAt(100, { readSlot: 500 }).conn);
  await kept("the node reading is behind the tip", chainAt(150, { slot: 190, readSlot: 189 }).conn);
  await kept("no tip", chainAt(150, { fail: "tip" }).conn);
  await kept("no read", chainAt(150, { fail: "read" }).conn);
  await kept("a node without the methods", fakeConn());
  await kept("a tip without a height", Object.assign(chainAt(150).conn, { getEpochInfo: async () => ({ absoluteSlot: 190, epoch: 1, slotIndex: 1, slotsInEpoch: 100 }) }));
  await kept("a tip without a slot", Object.assign(chainAt(150).conn, { getEpochInfo: async () => ({ blockHeight: 150, epoch: 1, slotIndex: 1, slotsInEpoch: 100 }) }));
  await kept("the finalized read finds the mint", chainAt(150, { seen: new Set([mint]) }).conn);
  await kept("the finalized read finds the wallet funded", chainAt(150, { seen: new Set([distributor]) }).conn);
  await kept("an answer without a slot", Object.assign(chainAt(150).conn, { getMultipleAccountsInfoAndContext: async () => ({ context: {}, value: [null, null] }) }));
  await kept("an answer missing accounts", Object.assign(chainAt(150).conn, { getMultipleAccountsInfoAndContext: answer([null]) }));
  await kept("an answer for other accounts too", Object.assign(chainAt(150).conn, { getMultipleAccountsInfoAndContext: answer([null, null, null]) }));
  await kept("an answer with a hole in it", Object.assign(chainAt(150).conn, { getMultipleAccountsInfoAndContext: answer([undefined, undefined]) }));
  await kept("a wallet account with nothing in it isn't nothing", Object.assign(chainAt(150).conn, { getMultipleAccountsInfoAndContext: answer([null, { lamports: 0, owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), executable: false }]) }));
  assert.deepEqual(await gcLaunchRecords(chainAt(101).conn), [mint]);
});

test("records: a failed batch only keeps its own, and each batch is read in one answer", async () => {
  const mints = Array.from({ length: 120 }, () => writeRecord().mint);
  const base = chainAt(150);
  let reads = 0;
  const sizes: number[] = [];
  const conn = Object.assign(base.conn, {
    getMultipleAccountsInfo: async () => { throw new Error("a plain read proves nothing"); },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      sizes.push(keys.length);
      if (++reads === 1) throw new Error("rpc down");
      return { context: { slot: 190 }, value: keys.map(() => null) };
    },
  });
  const removed = await gcLaunchRecords(conn);
  assert.ok(sizes.length >= 3 && sizes.every((n) => n <= 100), `reads of ${sizes.join(", ")}`);
  assert.equal(removed.length, 70, "one batch of 50 stays");
  const left = mints.filter((m) => !removed.includes(m));
  left.forEach((m) => assert.ok(present(m)));
  assert.deepEqual((await gcLaunchRecords(chainAt(150).conn)).sort(), left.sort());
});

test("records: without evidence one is kept however old, said once per server run, with no key in the log and no chain read", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (m: unknown) => { lines.push(String(m)); });
  const conn = { getEpochInfo: async () => { throw new Error("no read needed"); } } as unknown as Connection;
  const ancient = writeRecord({ lastValid: null, extra: { createdAt: "2020-01-01T00:00:00.000Z" } });
  const secret = fs.readFileSync(file(ancient.mint, "distributor.json"), "utf8");
  const damaged = ["{", "null", "{}", '{"lastValidBlockHeight":"100"}', '{"lastValidBlockHeight":-1}'].map((bad) => {
    const { mint } = writeRecord();
    fs.writeFileSync(file(mint, "step.json"), bad);
    return mint;
  });
  const before = lines.length;
  assert.deepEqual(await gcLaunchRecords(conn), []);
  for (const mint of [ancient.mint, ...damaged]) {
    assert.ok(present(mint), mint);
    assert.equal(lines.filter((l) => l.includes(mint) && /kept/.test(l)).length, 1, lines.join("; "));
  }
  assert.ok(!lines.some((l) => l.includes(secret)), "no key in the log");
  const once = lines.length;
  assert.ok(once > before);
  assert.deepEqual(await gcLaunchRecords(chainAt(10_000).conn), [], "still kept with the chain answering");
  assert.equal(lines.length, once, "not again every pass");
  for (const mint of [ancient.mint, ...damaged]) fs.rmSync(path.join(dir, "launches", mint), { recursive: true });
});

test("records: a key file that's unreadable or another wallet's keeps the record, without its contents in the log", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (m: unknown) => { lines.push(String(m)); });
  const torn = writeRecord(), other = writeRecord();
  fs.writeFileSync(file(torn.mint, "distributor.json"), "[12,34,not-a-number-77");
  fs.writeFileSync(file(other.mint, "distributor.json"), JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const otherKey = fs.readFileSync(file(other.mint, "distributor.json"), "utf8");
  assert.deepEqual(await gcLaunchRecords(chainAt(10_000).conn), []);
  for (const { mint } of [torn, other]) {
    assert.ok(present(mint));
    assert.ok(lines.some((l) => l.includes(mint) && /kept/.test(l)), lines.join("; "));
  }
  assert.ok(!lines.some((l) => l.includes("not-a-number") || l.includes("12,34") || l.includes(otherKey)), lines.join("; "));
  for (const { mint } of [torn, other]) fs.rmSync(path.join(dir, "launches", mint), { recursive: true });
});

test("records: a vault launch (no key file) needs the same proof, on its mint", async () => {
  const { mint, distributor } = writeRecord({ key: false, extra: { taxVault: true } });
  const onDisk = () => fs.existsSync(file(mint, "launch.json"));
  assert.deepEqual(await gcLaunchRecords(fakeConn()), []);
  assert.deepEqual(await gcLaunchRecords(chainAt(150, { slot: 190, readSlot: 100 }).conn), []);
  assert.deepEqual(await gcLaunchRecords(chainAt(150, { seen: new Set([mint]) }).conn), []);
  assert.ok(onDisk());
  // Its "distributor" is the vault's PDA, with no key here to lose: not what decides.
  assert.deepEqual(await gcLaunchRecords(chainAt(150, { seen: new Set([distributor]) }).conn), [mint]);
  assert.equal(onDisk(), false);
});

test("records: moved on while the chain was being read: kept", async () => {
  const registered = writeRecord(), configured = writeRecord();
  const base = chainAt(150);
  const read = base.conn.getMultipleAccountsInfoAndContext;
  const conn = Object.assign(base.conn, {
    getMultipleAccountsInfoAndContext: async (...a: Parameters<typeof read>) => {
      fs.writeFileSync(file(registered.mint, "launch.json"), JSON.stringify({ ...params, mint: registered.mint, distributor: registered.distributor, pool: registered.mint, createdAt: old(), registeredAt: old() }));
      fs.writeFileSync(file(configured.mint, "config.json"), "{}");
      return read(...a);
    },
  });
  assert.deepEqual(await gcLaunchRecords(conn), []);
  for (const { mint } of [registered, configured]) {
    assert.ok(present(mint));
    fs.rmSync(path.join(dir, "launches", mint), { recursive: true });
  }
});

test("records: a directory name that isn't a mint is never touched, nor what a link points at", async (t) => {
  t.mock.method(console, "error", () => undefined);
  writeRecord({ mint: "not-a-mint" });
  assert.deepEqual(await gcLaunchRecords(chainAt(10_000).conn), []);
  assert.ok(present("not-a-mint"), "a name that isn't a key: kept");
  fs.rmSync(path.join(dir, "launches", "not-a-mint"), { recursive: true });
  // A link in the launches: only the link can ever go.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "pending-launch-link-"));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const { mint } = writeRecord();
  fs.cpSync(path.join(dir, "launches", mint), target, { recursive: true });
  fs.rmSync(path.join(dir, "launches", mint), { recursive: true });
  fs.symlinkSync(target, path.join(dir, "launches", mint));
  assert.deepEqual(await gcLaunchRecords(chainAt(10_000).conn), [mint]);
  assert.ok(fs.existsSync(path.join(target, "distributor.json")));
});

test("records: the guards still apply; only an unregistered day-old record with nothing else beside it can go", async () => {
  const never = writeRecord();
  const onChain = writeRecord();
  const funded = writeRecord();
  const registered = writeRecord({ extra: { registeredAt: old() } });
  const recent = writeRecord({ extra: { createdAt: new Date().toISOString() } });
  const configured = writeRecord({ files: ["config.json"] });
  const removed = await gcLaunchRecords(chainAt(150, { seen: new Set([onChain.mint, funded.distributor]) }).conn);
  assert.deepEqual(removed, [never.mint]);
  assert.equal(fs.existsSync(path.join(dir, "launches", never.mint)), false);
  for (const k of [onChain, funded, registered, recent, configured]) assert.ok(fs.existsSync(file(k.mint, "launch.json")), k.mint);
});
