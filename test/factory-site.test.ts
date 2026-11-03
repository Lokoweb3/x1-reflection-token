/**
 * The real server process against a stand-in RPC: crash recovery, its launch hooks, and the view
 * budgets under a flood of junk. No network and no real keys; everything lives in a temp directory.
 */
import { test, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Keypair } from "@solana/web3.js";
import { startSite, until } from "./helpers/site.js";

let site: Awaited<ReturnType<typeof startSite>>;
before(async () => { site = await startSite(); });
after(async () => { await site.stop(); });
// A test that failed between killing the server and starting it again doesn't take the next ones with it.
beforeEach(async () => { site.rpc.down.clear(); await site.ensureUp(); });

test("killed right after step 1 goes out: the transaction lands, a restart still has the record and key", async () => {
  const res = await site.startLaunch();
  const { mint, error } = await res.json() as { mint: string; error?: string };
  assert.equal(error, undefined);
  // On disk the moment the creator has the transaction, but not among the launches yet.
  assert.ok(fs.existsSync(site.journalFile(mint, "launch.json")), "record journalled");
  assert.equal(fs.existsSync(site.launchFile(mint, "launch.json")), false, "not in the launches until it lands");
  const distributor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(site.journalFile(mint, "distributor.json"), "utf8"))));
  const record = JSON.parse(fs.readFileSync(site.journalFile(mint, "launch.json"), "utf8"));
  assert.equal(distributor.publicKey.toBase58(), record.distributor);
  assert.equal(fs.statSync(site.journalFile(mint, "distributor.json")).mode & 0o777, 0o600);

  await site.kill();
  site.rpc.onChain.add(mint); // the creator's wallet sends it while the server is down
  await site.boot();

  await until(() => fs.existsSync(site.launchFile(mint, "launch.json")), "the record to be saved after the restart");
  const saved = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(site.launchFile(mint, "distributor.json"), "utf8"))));
  assert.equal(saved.publicKey.toBase58(), record.distributor, "the withdraw key survived");
  assert.equal(fs.statSync(site.launchFile(mint, "distributor.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(site.journalFile(mint, "launch.json")), false, "journal cleared");
  const mine = await (await site.call(`/api/launches?creator=${record.creator}`)).json() as { mint: string }[];
  assert.ok(mine.some((r) => r.mint === mint), "and the creator can continue it");
});

test("step 1 records when it stops being able to land before it's returned; a build that fails leaves no journal", async () => {
  const { mint } = await (await site.startLaunch()).json() as { mint: string };
  assert.deepEqual(JSON.parse(fs.readFileSync(site.journalFile(mint, "step.json"), "utf8")), { lastValidBlockHeight: 1_000_000 }, "the stand-in RPC's");
  site.rpc.down.add("simulateTransaction");
  const res = await site.startLaunch();
  site.rpc.down.clear();
  assert.notEqual(res.status, 200);
  const left = fs.readdirSync(`${site.factoryDir}/pending-launches`).filter((m) => m !== mint && !fs.existsSync(site.journalFile(m, "step.json")));
  assert.deepEqual(left, [], "no transaction went out: nothing to keep");
});

test("killed before it lands: after the restart the launch is still readable, not yet in the launches", async () => {
  const { mint } = await (await site.startLaunch()).json() as { mint: string };
  await site.kill();
  await site.boot();
  const res = await site.call(`/meta/${mint}.json`);
  assert.equal(res.status, 200, "read from the journal");
  assert.equal(fs.existsSync(site.launchFile(mint, "launch.json")), false);
});

test("down longer than a launch's window while it landed: saved at the restart, without waiting for a GC", async () => {
  const { mint } = await (await site.startLaunch()).json() as { mint: string };
  await site.kill();
  const f = site.journalFile(mint, "launch.json");
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...r, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
  site.rpc.onChain.add(mint);
  await site.boot();
  await until(() => fs.existsSync(site.launchFile(mint, "launch.json")), "the record to be saved");
  assert.ok(fs.existsSync(site.launchFile(mint, "distributor.json")));
});

test("/api/send saves step 1's record at once: the server's own hook, not the half-minute sweep", async () => {
  const { tx, mint } = await (await site.startLaunch()).json() as { tx: string; mint: string };
  assert.equal(fs.existsSync(site.launchFile(mint, "launch.json")), false);
  const res = await site.call("/api/send", { body: { tx: site.walletSign(tx) } });
  const out = await res.json() as { signature?: string; error?: string };
  assert.ok(out.signature, out.error);
  assert.ok(fs.existsSync(site.launchFile(mint, "launch.json")), "saved when /api/send answers");
  assert.ok(fs.existsSync(site.launchFile(mint, "distributor.json")));
});

test("/api/launch/pool saves the record of a token on-chain: the server's own hook", async () => {
  const { mint } = await (await site.startLaunch()).json() as { mint: string };
  site.rpc.onChain.add(mint);
  assert.equal(fs.existsSync(site.launchFile(mint, "launch.json")), false);
  // How far the pool step gets on the stand-in chain doesn't matter: the record is saved first.
  await site.call("/api/launch/pool", { body: { mint, creator: site.creator.publicKey.toBase58() } });
  assert.ok(fs.existsSync(site.launchFile(mint, "launch.json")), "saved by the pool step");
});

test("a journal that can't be written: no transaction goes out, and the visitor sees no path", async () => {
  const root = `${site.factoryDir}/pending-launches`;
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(root, "in the way");
  try {
    const res = await site.startLaunch();
    const out = await res.json() as { tx?: string; error?: string };
    assert.equal(out.tx, undefined, "nothing to sign");
    assert.match(out.error ?? "", /nothing was sent to your wallet/);
    assert.ok(!(out.error ?? "").includes(site.factoryDir), "no server path in the answer");
  } finally { fs.rmSync(root, { force: true }); }
});

test("a saved record reaches the status at once: its cached answer is dropped by the write itself", async () => {
  const creator = Keypair.generate();
  const { mint } = await (await site.startLaunch(creator)).json() as { mint: string };
  const who = creator.publicKey.toBase58();
  const status = async () => (await (await site.call(`/api/launches?creator=${who}`)).json() as { mint: string; status: { token: boolean } }[]).find((r) => r.mint === mint)!.status;
  assert.equal((await status()).token, false, "cached for 15 s");
  site.rpc.onChain.add(mint);
  assert.equal((await status()).token, false, "still the cached answer");
  await site.call("/api/launch/pool", { body: { mint, creator: who } }); // saves the record
  assert.ok(fs.existsSync(site.launchFile(mint, "launch.json")));
  assert.equal((await status()).token, true);
});

test("requests that change nothing don't drop a creator's cached status, so they can't drain its budget", async () => {
  const creator = Keypair.generate();
  const { mint } = await (await site.startLaunch(creator)).json() as { mint: string };
  const who = creator.publicKey.toBase58();
  const posts = [
    { path: "/api/launch/not-a-route", body: { creator: who } },
    { path: "/api/launch/pool", body: { mint, creator: who } }, // refused: its token isn't on-chain
    { path: "/api/launch/register", body: { mint, creator: who } }, // refused too
    { path: "/api/curve/create", body: { creator: who } }, // no curves on this site, and invalid
  ];
  // Each kind on its own, for more rounds than one reader's 30 charged status reads: all from the cache.
  for (const [k, p] of posts.entries()) {
    for (let i = 0; i < 32; i++) {
      const posted = await site.call(p.path, { ip: `198.51.${100 + k}.${100 + i}`, body: p.body });
      assert.ok(posted.status >= 400, `${p.path}: ${posted.status}`);
      await posted.arrayBuffer();
      const read = await site.call(`/api/launches?creator=${who}`, { ip: `198.51.100.${20 + k}` });
      assert.equal(read.status, 200, `${p.path}, round ${i}`);
      await read.arrayBuffer();
    }
  }
});

test("a flood on one expired balance is one chain read, one admission", async () => {
  const wallet = addr(), p = `/api/balance/${wallet}`;
  assert.equal((await site.call(p, { ip: "198.51.100.30" })).status, 200);
  const before = site.rpc.calls.getBalance ?? 0;
  await site.skipClock();
  const held = site.rpc.hold("getBalance");
  const flood = Array.from({ length: 120 }, (_, i) => site.call(p, { ip: `198.51.100.${40 + i % 6}` }));
  await held.reached;
  await new Promise((r) => setTimeout(r, 50));
  held.release();
  for (const res of await Promise.all(flood)) { assert.equal(res.status, 200); await res.arrayBuffer(); }
  assert.equal((site.rpc.calls.getBalance ?? 0) - before, 1);
});

test("the server down past a launch's window with the RPC down too: saved once the RPC is back", async () => {
  const started = await (await site.startLaunch()).json() as { mint: string; error?: string };
  assert.equal(started.error, undefined);
  const { mint } = started;
  await site.kill();
  const f = site.journalFile(mint, "launch.json");
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...r, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
  site.rpc.onChain.add(mint);
  site.rpc.down.add("getMultipleAccounts");
  await site.boot();
  await new Promise((res) => setTimeout(res, 1_000));
  assert.equal(fs.existsSync(site.launchFile(mint, "launch.json")), false, "the chain can't be read yet");
  assert.equal((await site.call(`/meta/${mint}.json`)).status, 200, "readable meanwhile, like a saved record");
  assert.ok(fs.existsSync(f), "and nothing was given up on");
  site.rpc.down.delete("getMultipleAccounts");
  await until(() => fs.existsSync(site.launchFile(mint, "launch.json")), "the retry after the RPC came back", 15_000);
  assert.ok(fs.existsSync(site.launchFile(mint, "distributor.json")));
});

const addr = () => Keypair.generate().publicKey.toBase58();
const ips = Array.from({ length: 12 }, (_, i) => `203.0.113.${i + 1}`);

test("a flood of junk views is answered for free and leaves real reads working", async () => {
  const creator = Keypair.generate();
  const { mint } = await (await site.startLaunch(creator)).json() as { mint: string };
  const who = creator.publicKey.toBase58();
  // Malformed routes, made-up tokens, made-up parameters: 12 addresses, 30 each, more than the site-wide cap.
  const junk = (ip: string, i: number): string[] => [
    `/api/token/junk${ip}-${i}`, `/api/token/${addr()}/stats`, `/api/leaderboard/${addr()}`, `/api/wallet/not-an-address-${ip}-${i}`, `/api/vault/x${ip}-${i}`, `/api/nft/x${ip}-${i}`,
    `/api/token/${addr()}/nope`, `/api/analytics?mint=${addr()}`, `/api/distribute/status?mint=${addr()}`, `/api/launches?creator=${addr()}`,
  ];
  const statuses = new Set<number>();
  const count = () => Object.values(site.rpc.calls).reduce((a, b) => a + b, 0);
  const rpcBefore = count();
  for (const ip of ips) {
    const paths = Array.from({ length: 30 }, (_, i) => junk(ip, i)[i % 10]);
    for (const res of await Promise.all(paths.map((p) => site.call(p, { ip })))) { statuses.add(res.status); await res.arrayBuffer(); }
  }
  assert.ok(!statuses.has(429), `junk is never charged (saw ${[...statuses].join(", ")})`);
  assert.ok(count() - rpcBefore < 20, `360 junk requests made no chain reads of their own (${count() - rpcBefore} calls, from timers)`);
  // Real views from an address not seen yet: they weren't blocked.
  const fresh = "198.51.100.7";
  const lookup = await site.call(`/api/wallet/${addr()}`, { ip: fresh });
  assert.equal(lookup.status, 200, await lookup.text());
  const launchStatus = await site.call(`/api/launches?creator=${who}`, { ip: fresh });
  assert.equal(launchStatus.status, 200);
  assert.ok((await launchStatus.json() as { mint: string }[]).some((r) => r.mint === mint));
});

test("real lookups still hit the site-wide cap, but it doesn't stop a launch in progress being followed", async () => {
  const creator = Keypair.generate();
  const { mint } = await (await site.startLaunch(creator)).json() as { mint: string };
  const who = creator.publicKey.toBase58();
  const balance = `/api/balance/${addr()}`;
  assert.equal((await site.call(balance, { ip: "198.51.100.8" })).status, 200, "cached while there's budget");
  // Valid addresses that each need a read: this is what the cap is for. Exhaust it from many addresses.
  const seen = new Set<number>();
  for (let i = 0; i < 14; i++) {
    for (const res of await Promise.all(Array.from({ length: 30 }, () => site.call(`/api/wallet/${addr()}`, { ip: `192.0.2.${i + 1}` })))) { seen.add(res.status); await res.arrayBuffer(); }
  }
  assert.ok(seen.has(429), "the cap is still there");
  const blocked = await site.call(`/api/wallet/${addr()}`, { ip: "198.51.100.8" });
  assert.equal(blocked.status, 429, "lookups are out of budget now");
  // A launch's status read, not cached (the step above forgot it).
  const res = await site.call(`/api/launches?creator=${who}`, { ip: "198.51.100.8" });
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok((await res.json() as { mint: string }[]).some((r) => r.mint === mint));
  // An expired balance is a real lookup too: once past its freshness it's charged, so refused now.
  assert.equal((await site.call(balance, { ip: "198.51.100.8" })).status, 200, "still fresh: from the cache");
  await site.skipClock();
  assert.equal((await site.call(balance, { ip: "198.51.100.9" })).status, 429, "expired: refused like any lookup");
});
