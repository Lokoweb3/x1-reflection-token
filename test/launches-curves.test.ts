/**
 * The real server against a stand-in RPC: a creator's launch list when one curve can't be read,
 * and what the site does with a curve that graduated with its LP burned.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CURVE_DISC, CURVE_LEN, CurveStatus, curvePda } from "../src/curve.js";
import { startSite } from "./helpers/site.js";

const program = Keypair.generate().publicKey;
const SYSTEM = "11111111111111111111111111111111";
const TOKEN22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
let site: Awaited<ReturnType<typeof startSite>>;
before(async () => { site = await startSite({ curveProgram: program.toBase58() }); });
after(async () => { await site.stop(); });
beforeEach(() => { site.rpc.accounts.clear(); site.rpc.unreadable.clear(); site.rpc.down.clear(); });

/** A curve launch's record on disk (read fresh by the server) with its mint on-chain. */
function launch(creator: string) {
  const mint = Keypair.generate().publicKey;
  const dir = path.dirname(site.launchFile(mint.toBase58(), "launch.json"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify({
    kind: "curve", mint: mint.toBase58(), creator, name: "C", symbol: "C", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 0,
    poolTokens: "200000000", poolXnt: "10", lockDays: null, quote: "XNT", distributor: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
    createdAt: new Date().toISOString(), taxVault: true,
  }));
  site.rpc.accounts.set(mint.toBase58(), { owner: TOKEN22, data: Buffer.alloc(82) });
  return mint;
}
function curveAccount(mint: PublicKey, status: number, lockNft = PublicKey.default) {
  const d = Buffer.alloc(CURVE_LEN);
  CURVE_DISC.copy(d);
  mint.toBuffer().copy(d, 8);
  d[72 + 8 * 10] = status;
  lockNft.toBuffer().copy(d, 72 + 8 * 10 + 1 + 4 + 8 + 32);
  site.rpc.accounts.set(curvePda(program, mint).toBase58(), { owner: program.toBase58(), data: d });
}
const list = async (creator: string) => {
  await site.skipClock(); // past the few seconds the server remembers which creators it knows
  const res = await site.call(`/api/launches?creator=${creator}`, { ip: `198.51.100.${Math.floor(Math.random() * 200)}` });
  return { code: res.status, rows: await res.json() as { mint: string; status: Record<string, unknown> }[] };
};
const rowOf = (rows: { mint: string; status: Record<string, unknown> }[], m: PublicKey) => rows.find((r) => r.mint === m.toBase58())!.status;

test("a funded closed curve (empty, system-owned) doesn't break the creator's list", async () => {
  const who = Keypair.generate().publicKey.toBase58();
  const closed = launch(who), live = launch(who);
  site.rpc.accounts.set(curvePda(program, closed).toBase58(), { owner: SYSTEM, data: Buffer.alloc(0) });
  curveAccount(live, CurveStatus.Trading);
  const { code, rows } = await list(who);
  assert.equal(code, 200, JSON.stringify(rows));
  assert.equal(rowOf(rows, closed).token, false);
  assert.equal(rowOf(rows, closed).curveClosed, true, "told apart from one never created");
  assert.equal(rowOf(rows, live).token, true);
  assert.equal(rowOf(rows, live).curveClosed, false);
});

test("one launch that can't be read is marked, the rest still answer", async () => {
  const who = Keypair.generate().publicKey.toBase58();
  const bad = launch(who), live = launch(who);
  curveAccount(live, CurveStatus.Trading);
  site.rpc.unreadable.add(curvePda(program, bad).toBase58());
  const { code, rows } = await list(who);
  assert.equal(code, 200, JSON.stringify(rows));
  assert.deepEqual(rowOf(rows, bad), { unavailable: true }, "nothing claimed about its steps");
  assert.equal(rowOf(rows, live).token, true);
});

test("the chain not answering at all still fails the request", async () => {
  const who = Keypair.generate().publicKey.toBase58();
  site.rpc.unreadable.add(curvePda(program, launch(who)).toBase58());
  const { code } = await list(who);
  assert.notEqual(code, 200, "so a cached answer is served, not a list of unknowns");
});

test("a burned graduation: reported, no lock, and the vault step refuses with the reason", async () => {
  const who = Keypair.generate().publicKey.toBase58();
  const mint = launch(who);
  curveAccount(mint, CurveStatus.Finished);
  const s = rowOf((await list(who)).rows, mint);
  assert.equal(s.lpBurned, true);
  assert.equal(s.lock, false);
  assert.equal(s.lockNft, null);
  assert.equal(s.pool, true);
  const res = await site.call("/api/launch/vault", { body: { mint: mint.toBase58(), creator: who } });
  assert.match((await res.json() as { error: string }).error, /LP was burned at graduation/);
});

test("a locked graduation isn't called burned", async () => {
  const who = Keypair.generate().publicKey.toBase58();
  const mint = launch(who);
  curveAccount(mint, CurveStatus.Finished, Keypair.generate().publicKey);
  const s = rowOf((await list(who)).rows, mint);
  assert.equal(s.lpBurned, false);
  assert.equal(s.lock, true);
});
