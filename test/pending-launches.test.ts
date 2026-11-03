/**
 * New launch records: journalled with the distributor key before step 1's transaction goes out,
 * moved to the launches once the token is on-chain; a step 1 that never lands leaves only a
 * journal, removed after a day. Old records whose token never reached the chain are removed
 * after a day; anything else is kept. No network: the connection is a stand-in. The server's own
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

test("GC removes only day-old unregistered records whose token and wallet never reached the chain", async () => {
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const write = (extra: Record<string, unknown> = {}, files: string[] = []) => {
    const mint = Keypair.generate().publicKey.toBase58(), distributor = Keypair.generate();
    fs.mkdirSync(path.join(dir, "launches", mint), { recursive: true });
    fs.writeFileSync(file(mint, "launch.json"), JSON.stringify({ ...params, mint, distributor: distributor.publicKey.toBase58(), pool: mint, createdAt: old, ...extra }));
    fs.writeFileSync(file(mint, "distributor.json"), JSON.stringify(Array.from(distributor.secretKey)));
    for (const f of files) fs.writeFileSync(file(mint, f), "{}");
    return { mint, distributor: distributor.publicKey.toBase58() };
  };
  const never = write();
  const onChain = write();
  const funded = write();
  const registered = write({ registeredAt: old });
  const recent = write({ createdAt: new Date().toISOString() });
  const configured = write({}, ["config.json"]);
  const removed = await gcLaunchRecords(fakeConn(new Set([onChain.mint]), new Set([funded.distributor])));
  assert.deepEqual(removed, [never.mint]);
  assert.equal(fs.existsSync(path.join(dir, "launches", never.mint)), false);
  for (const k of [onChain, funded, registered, recent, configured]) assert.ok(fs.existsSync(file(k.mint, "launch.json")), k.mint);
});
