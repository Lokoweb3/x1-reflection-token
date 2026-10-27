/**
 * New launch records: kept in memory until the token (step 1) is on-chain, then saved with
 * the distributor key; a step 1 that never lands leaves nothing on disk. Old records whose
 * token never reached the chain are removed after a day; anything else is kept. No network:
 * the connection is a stand-in.
 */
import { test } from "node:test";
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
const { buildTokenStep, flushPendingLaunches, gcLaunchRecords, isPendingLaunch, listLaunches, persistLaunch, readLaunch, sweepPendingLaunches } = await import("../src/factory/launch.js");
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

test("step 1 writes nothing to disk; the record is readable and listed meanwhile", async () => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  assert.equal(fs.existsSync(path.join(dir, "launches", record.mint)), false);
  assert.equal(readLaunch(record.mint)?.symbol, "PEND");
  assert.ok(listLaunches().some((r) => r.mint === record.mint));
  assert.ok(isPendingLaunch(record.mint));
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
  // Listed once, from disk.
  assert.equal(listLaunches().filter((r) => r.mint === record.mint).length, 1);
});

test("persistLaunch (the pool step, /api/send) saves at once; a step 1 that never lands is forgotten", async (t) => {
  const a = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  persistLaunch(a.mint);
  assert.ok(fs.existsSync(file(a.mint, "launch.json")) && fs.existsSync(file(a.mint, "distributor.json")));

  const b = (await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1")).record;
  await sweepPendingLaunches(fakeConn());
  assert.ok(isPendingLaunch(b.mint), "still waiting: its blockhash may not have expired yet");
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 16 * 60_000);
  await sweepPendingLaunches(fakeConn());
  assert.equal(isPendingLaunch(b.mint), false);
  assert.equal(readLaunch(b.mint), null);
  assert.equal(fs.existsSync(path.join(dir, "launches", b.mint)), false);
});

test("on shutdown the launches still waiting are saved", async () => {
  const { record } = await buildTokenStep(fakeConn(), cfg, params, "http://127.0.0.1:1");
  flushPendingLaunches();
  assert.ok(fs.existsSync(file(record.mint, "launch.json")) && fs.existsSync(file(record.mint, "distributor.json")));
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
