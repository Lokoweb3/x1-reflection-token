/**
 * Tax Vault v3 "operator dies" drill, on a LOCAL validator (nothing goes to testnet/mainnet).
 *
 *   1. The site as deployed today (OLD_SITE: a checkout of the previous commit) with the v2
 *      program: a vault token with trading, a rewards list published and paid.
 *   2. Stop the site, deploy the v3 build over the program (extend first), start the NEW
 *      site on the same factory/state directories, with a local stand-in for Pinata and an
 *      IPFS gateway (started here; it computes real CIDs). The new crank upgrades the vault
 *      and publishes lists with a CID (the first pin is made to fail: no pin, no publish).
 *      "Run the vault now" for a visitor's wallet: build, sign, send, crank reward arrives.
 *      The creator's appoint-tx is refused while the publisher is active / for others.
 *   3. The site publishes a list and STOPS before paying it (the operator is gone).
 *   4. Another wallet runs scripts/crank.ts --all: it reads the list from IPFS by its
 *      on-chain CID and pays holders.
 *   5. 30 s without a list (short-windows): crank.ts pays from the last list with
 *      pay_fallback; every wallet ends at exactly floor(cumulative * funded / list_total).
 *   6. The creator appoints a new publisher (after 15 s of silence); crank.ts --publisher
 *      publishes a list that ends the fallback (nobody below what they were paid, total >=
 *      holders_paid) and crank.ts pays it.
 *
 * Start the validator as in scripts/local-vault-v2-test.ts, but on the drill's ports and with
 * the v2 short-windows build (lp-locker/target/vault2-test) loaded upgradeable (the RPC port
 * + 1 is its websocket, so the faucet goes elsewhere):
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9201 --faucet-port 9205 \
 *     --gossip-port 9203 --dynamic-port-range 9210-9240 --url https://rpc.testnet.x1.xyz <clones as there> \
 *     --upgradeable-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault2-test/tax_vault.so <authority pubkey>
 * then (a 3.x CLI: 2.1 rejects `program extend`):
 *   LOCAL_RPC=http://127.0.0.1:9201 OLD_SITE=<checkout> UPGRADE_AUTHORITY=<keypair file> [SOLANA_CLI=<3.x solana>] \
 *     npx tsx scripts/vault-v3-rehearsal.ts
 * The site runs on port 8131, the IPFS stand-in on 8132. KEEP_DIR=1 keeps the throwaway
 * config/factory/state directory (it holds the drill's keypairs) for a look afterwards.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";
import {
  PAID_RECORD_LEN, VAULT_V3_LEN, appointPublisherIx, cidFromBytes, decodePaidRecord, decodeVault, fallbackEntitled, paidRecordPda, parseEvents, rawCid,
  vaultPda, type Vault,
} from "../src/taxvault.js";
import { buildVaultTree } from "../src/taxvault.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9201";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const OLD_SITE = path.resolve(process.env.OLD_SITE ?? "");
const AUTHORITY = process.env.UPGRADE_AUTHORITY!;
const V3_SO = process.env.V3_SO ?? "lp-locker/target/vault3-test/tax_vault.so";
const PORT = 8131, SITE = `http://127.0.0.1:${PORT}`;
const IPFS_PORT = 8132, IPFS = `http://127.0.0.1:${IPFS_PORT}`;
const JWT = "rehearsal-jwt";
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);
assert.ok(process.env.OLD_SITE && AUTHORITY, "OLD_SITE=<old checkout> UPGRADE_AUTHORITY=<keypair file>");

// ---------- a local stand-in for Pinata's upload API and an IPFS gateway ----------
const pinned = new Map<string, Buffer>();
let failPins = 0, pins = 0, gets = 0;
const ipfs = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && req.url === "/v3/files") {
    if (req.headers.authorization !== `Bearer ${JWT}`) { res.writeHead(401).end("{}"); return; }
    if (failPins > 0) { failPins--; res.writeHead(500).end("pinning is down"); return; }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const cid = rawCid(bytes); // a small file is one raw block: its CID is its sha256
    pinned.set(cid, bytes); pins++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { cid } }));
    return;
  }
  const g = /^\/ipfs\/(\w+)$/.exec(req.url ?? "");
  if (req.method === "GET" && g && pinned.has(g[1])) { gets++; res.writeHead(200).end(pinned.get(g[1])); return; }
  res.writeHead(404).end("not found");
});
await new Promise<void>((r) => ipfs.listen(IPFS_PORT, "127.0.0.1", r));

// ---------- throwaway setup ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-v3-rehearsal-"));
const payer = Keypair.generate(), sitePublisher = Keypair.generate(), creator = Keypair.generate();
const runner = Keypair.generate(), visitor = Keypair.generate(), newPublisher = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
for (const k of [payer, creator, ...traders]) await fund(k.publicKey, 80);
for (const k of [sitePublisher, runner, visitor, newPublisher]) await fund(k.publicKey, 5);
await fund(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY, "utf8")))).publicKey, 20);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
{
  const ata = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, creator.publicKey, feeMint)), [payer]);
  await mintTo(conn, payer, feeMint, ata, payer, 5_000_000);
}
const keyFile = (name: string, k: Keypair) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const publisherFile = keyFile("publisher", sitePublisher), runnerFile = keyFile("runner", runner), newPublisherFile = keyFile("new-publisher", newPublisher);
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined,
    curve: undefined, quoteTokens: undefined, launchesPaused: undefined, pinataJwt: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: publisherFile },
  },
};
delete cfg.creatorReward;
// The old site gets no Pinata key (it would pin token metadata); the new one gets the IPFS stand-in.
const cfgOld = path.join(dir, "config-old.json"), cfgNew = path.join(dir, "config-new.json");
fs.writeFileSync(cfgOld, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.writeFileSync(cfgNew, JSON.stringify({ ...cfg, factory: { ...cfg.factory, pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/` } }, null, 2), { mode: 0o600 });
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = {
  ...process.env, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC,
  // The v3 build under test uses short windows (appoint 15 s, fallback 30 s).
  TAX_VAULT_SHORT_WINDOWS: "1", PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "",
  // Crank passes every 10 s, well inside the 30 s fallback window (60 s passes would let the
  // live site drift into fallback between lists).
  TAX_VAULT_PASS_SECS: "10",
};
const log: string[] = [];
let server: ReturnType<typeof spawn> | null = null;
async function startServer(cwd: string, config: string) {
  server = spawn(process.execPath, [path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { cwd, env: { ...env, REFLECT_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
}
async function stopServer() { if (!server) return; server.kill(); await new Promise((r) => server!.once("exit", r)); server = null; }
process.on("exit", () => server?.kill());

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
/** A fresh (uncached) view: the site serves GET views stale-while-revalidate. */
const fresh = (p: string) => api(`${p}?t=${Date.now()}`);
async function step(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64") });
  return { ...out, signature };
}

async function launch(c: Keypair, name: string, symbol: string) {
  const params = { name, symbol, image: "", description: "vault v3 drill", supply: "1000000", poolTokens: "1000000", poolXnt: "10",
    taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: c.publicKey.toBase58() };
  const { mint } = await step("/api/launch/token", params, c);
  await step("/api/launch/pool", { mint, creator: params.creator }, c);
  await step("/api/launch/lock", { mint, creator: params.creator }, c);
  await step("/api/launch/vault", { mint, creator: params.creator }, c);
  await api("/api/launch/register", { mint, creator: params.creator });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
  return { mint, rec };
}
async function trade(mint: string, pool: string, rounds = 1) {
  for (let r = 0; r < rounds; r++) {
    for (const t of traders) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, new PublicKey(pool), new PublicKey(mint), 3n * 10n ** 9n, 300)))), [t]);
    for (const t of traders.slice(0, 2)) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), t.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const bal = (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const q = await quoteSell(conn, XDEX, new PublicKey(pool), new PublicKey(mint), bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
      if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, new PublicKey(mint), q))), [t]);
    }
  }
}
const readVault = async (mint: string): Promise<Vault> => {
  const addr = vaultPda(PROGRAM, new PublicKey(mint));
  return decodeVault(addr, (await conn.getAccountInfo(addr, "confirmed"))!.data);
};
const vaultLen = async (mint: string) => (await conn.getAccountInfo(vaultPda(PROGRAM, new PublicKey(mint)), "confirmed"))?.data.length ?? 0;
async function paidRecords(vault: PublicKey) {
  const raw = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: vault.toBase58() } }] });
  return new Map(raw.map(({ pubkey, account }) => { const r = decodePaidRecord(pubkey, account.data); return [r.wallet.toBase58(), r.paid] as [string, bigint]; }));
}
/** A list file from the IPFS stand-in by the CID stored on-chain. */
const listFromIpfs = (cidBytes: Buffer) => {
  const cid = cidFromBytes(cidBytes);
  assert.ok(cid && pinned.has(cid), `list ${cid} is on IPFS`);
  return { cid: cid!, file: JSON.parse(pinned.get(cid!)!.toString("utf8")) as { entries: [string, string][]; total: string; root: string; rules?: unknown } };
};
async function waitFor(what: string, test: () => Promise<boolean>, ms = 480_000, every = 5_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; } await sleep(every); }
  throw new Error(`timed out waiting for: ${what}`);
}
/** Wait until the chain's clock passes `unix` (+ margin). */
async function untilChainTime(unix: number, what: string) {
  for (;;) {
    const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
    if (t && t >= unix) break;
    await sleep(1_000);
  }
  ok(`chain time past ${what}`);
}
/** scripts/crank.ts as another wallet would run it (no site, no config.json). Async: the IPFS stand-in runs in this process. */
async function crankTs(args: string[]) {
  const child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/crank.ts", "--rpc", RPC, "--program", PROGRAM.toBase58(),
    "--ipfs-gateway", `${IPFS}/ipfs/`, ...args], { env: { ...process.env, TAX_VAULT_SHORT_WINDOWS: "1", PINATA_JWT: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  clearTimeout(timer);
  for (const l of out.trimEnd().split("\n")) console.log(`      | ${l}`);
  assert.equal(code, 0, "crank.ts exited cleanly");
  return out;
}
/** Program events of confirmed transactions that touched `addr`, newest first. */
async function eventsFor(addr: PublicKey, limit = 20) {
  const sigs = await conn.getSignaturesForAddress(addr, { limit }, "confirmed");
  const out = [];
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.meta && !tx.meta.err) out.push(...parseEvents(tx.meta.logMessages ?? [], PROGRAM).map((e) => ({ ...e, signature: s.signature })));
  }
  return out;
}
/** Set the token's collection threshold (its per-launch config; the site reads it every pass). */
function setMinHarvest(mint: string, value: string) {
  const f = path.join(dir, "factory", "launches", mint, "config.json");
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.distribution.minHarvestXnt = value;
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

try {
  console.log("1. OLD site + v2 program: a vault token (T1), trading, a list published and paid");
  await startServer(OLD_SITE, cfgOld);
  const t1 = await launch(creator, "Drill Vault", "DRILL");
  assert.equal(await vaultLen(t1.mint), 552, "a v2 vault is 552 bytes");
  ok(`T1 ${t1.mint.slice(0, 8)}… launched with a v2 vault (552 bytes)`);
  const vaultAddr = vaultPda(PROGRAM, new PublicKey(t1.mint));
  await trade(t1.mint, t1.rec.pool, 3);
  await waitFor("v2 crank published a list and paid holders", async () => (await readVault(t1.mint)).holdersPaid > 0n, 480_000, 10_000);
  const v2 = await readVault(t1.mint);
  ok(`before the upgrade: list epoch ${v2.listEpoch}, holders funded ${xnt(v2.holdersFunded)}, paid ${xnt(v2.holdersPaid)} XNT`);
  await trade(t1.mint, t1.rec.pool, 1); // tax waiting in the vault at upgrade time
  await stopServer();

  console.log("2. Deploy v3 over the program, start the NEW site (IPFS stand-in; the first pin fails)");
  {
    const size = fs.statSync(V3_SO).size;
    const prog = (await conn.getAccountInfo(PROGRAM))!;
    const pd = new PublicKey(prog.data.subarray(4, 36));
    const pdLen = (await conn.getAccountInfo(pd))!.data.length - 45;
    const cli = (args: string[]) => execFileSync(process.env.SOLANA_CLI ?? "solana", [...args, "--url", RPC, "--keypair", AUTHORITY], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (size > pdLen) { cli(["program", "extend", PROGRAM.toBase58(), String(size - pdLen)]); ok(`program extended by ${size - pdLen} bytes`); }
    cli(["program", "deploy", "--use-rpc", "--program-id", PROGRAM.toBase58(), "--upgrade-authority", AUTHORITY, V3_SO]);
    ok(`v3 deployed (${size} bytes)`);
    await sleep(1500);
  }
  failPins = 1;
  await startServer(process.cwd(), cfgNew);
  await waitFor("the crank upgraded the vault to 640 bytes (v3)", async () => (await vaultLen(t1.mint)) === VAULT_V3_LEN, 180_000, 3_000);
  const up = await readVault(t1.mint);
  assert.equal(up.version, 3);
  assert.equal(up.listEpoch, v2.listEpoch, "the v2 list stays active through the upgrade");
  assert.ok(up.holdersPaid >= v2.holdersPaid && up.holdersFunded >= v2.holdersFunded);
  ok(`v3 vault: last_publish_at = upgrade time ${new Date(up.lastPublishAt * 1000).toISOString()}, no list file yet (${cidFromBytes(up.listCid)})`);
  await trade(t1.mint, t1.rec.pool, 1);
  await waitFor("a list published with a CID (after the failed pin was retried)", async () => {
    const v = await readVault(t1.mint);
    return v.pendingEpoch > up.listEpoch || (v.listEpoch > up.listEpoch && !!cidFromBytes(v.listCid));
  }, 300_000, 3_000);
  assert.equal(failPins, 0, "the first pin attempt was refused");
  assert.ok(log.join("").includes("not pinned to IPFS"), "the site logged the failed pin and didn't publish");
  ok("the refused pin held the list back: no pin, no publish");
  await waitFor("that list is active and paid", async () => {
    const v = await readVault(t1.mint);
    return v.listEpoch > up.listEpoch && !!cidFromBytes(v.listCid) && v.holdersPaid > up.holdersPaid;
  }, 300_000, 5_000);
  {
    const v = await readVault(t1.mint);
    const { cid, file } = listFromIpfs(v.listCid);
    const wallets = Object.fromEntries(file.entries);
    assert.ok(buildVaultTree(v.address, wallets).root.equals(v.listRoot), "the pinned file gives the on-chain root");
    const view = await fresh(`/api/vault/${t1.mint}`);
    assert.equal(view.listCid, cid);
    assert.equal(view.publisher, sitePublisher.publicKey.toBase58());
    // (With short windows the site's 60 s passes can land in fallback between lists; it then pays with pay_fallback.)
    assert.equal(typeof view.fallbackActive, "boolean");
    assert.equal(view.appointAllowedAt, view.lastPublishAt + 15);
    assert.equal(view.fallbackAt, view.lastPublishAt + 30);
    const list = await fresh(`/api/vault/${t1.mint}/list`);
    ok(`list ${v.listEpoch} (${file.entries.length} wallets) on IPFS as ${cid}; /api/vault shows it, /list cid ${list.cid ?? list.active?.cid}`);
  }

  console.log("   The creator's appoint-tx while the site publishes");
  await api(`/api/vault/${t1.mint}/appoint-tx`, { guardian: runner.publicKey.toBase58(), newPublisher: newPublisher.publicKey.toBase58() })
    .then(() => assert.fail("a non-guardian got an appoint transaction"), (e) => { assert.match(e.message, /Only the vault's guardian/); ok(`another wallet: "${e.message.split(": ").slice(1).join(": ")}"`); });
  {
    const v = await readVault(t1.mint);
    const res = await api(`/api/vault/${t1.mint}/appoint-tx`, { guardian: creator.publicKey.toBase58(), newPublisher: newPublisher.publicKey.toBase58() })
      .then(() => "built (the publisher has been quiet for 15 s; not sent)", (e) => { assert.match(e.message, /can be appointed from/); return `refused: "${e.message.split(": ").slice(1).join(": ")}"`; });
    ok(`the creator ${Date.now() / 1000 < v.lastPublishAt + 15 ? "right after a publish" : "after 15 s of silence"}: ${res}`);
  }

  console.log("   \"Run the vault now\" from a visitor's wallet");
  {
    setMinHarvest(t1.mint, "1000"); // the site's crank leaves the tax to the visitor meanwhile
    const pass0 = (await fresh(`/api/vault/${t1.mint}`)).crank.lastPass?.at;
    await waitFor("a site crank pass finished", async () => (await fresh(`/api/vault/${t1.mint}`)).crank.lastPass?.at !== pass0, 120_000, 1_000);
    await trade(t1.mint, t1.rec.pool, 1);
    const plan = await api(`/api/vault/${t1.mint}/crank-tx`, { caller: visitor.publicKey.toBase58() });
    ok(`crank-tx: ${plan.txs.map((t: { kind: string }) => t.kind).join(", ")}; estimated reward ${xnt(BigInt(plan.crankRewardLamports))} XNT, fees ${xnt(BigInt(plan.networkFeeLamports))} XNT`);
    assert.ok(plan.txs.some((t: { kind: string }) => t.kind === "collect") && plan.txs.some((t: { kind: string }) => t.kind === "sell"));
    const sigs: string[] = [];
    for (const t of plan.txs) {
      const tx = Transaction.from(Buffer.from(t.tx, "base64"));
      assert.ok(tx.feePayer!.equals(visitor.publicKey), "the visitor pays");
      tx.partialSign(visitor);
      // Like the page: a step right behind the sale may hit OneSellPerSlot; resend a moment later.
      let r: { signature: string } | { error: string } = { error: "" };
      for (let attempt = 0; attempt < 4; attempt++) {
        r = await api("/api/send", { tx: tx.serialize().toString("base64") }).catch((e) => ({ error: e.message as string }));
        if ("signature" in r || !/OneSellPerSlot|0x1782/.test(r.error)) break;
        await sleep(1200);
      }
      if ("signature" in r) sigs.push(r.signature);
      ok(`${t.label}: ${"signature" in r ? "confirmed" : `failed (${r.error})`}`);
    }
    const res = await api(`/api/vault/${t1.mint}/crank-result`, { signatures: sigs });
    const reward = BigInt(res.crankRewardLamports);
    assert.ok(reward > 0n, "the visitor earned a crank reward");
    // The sale's transaction: the visitor's balance moved by exactly reward - fee (temporary accounts' rent refunded).
    const sellSig = res.results.find((r: { events: { name: string }[] }) => r.events.some((e) => e.name === "Sold")).signature;
    const tx = (await conn.getTransaction(sellSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!;
    const delta = BigInt(tx.meta!.postBalances[0]) - BigInt(tx.meta!.preBalances[0]);
    assert.equal(delta + BigInt(tx.meta!.fee), reward, "reward arrived in the visitor's wallet");
    const ev = fs.readFileSync(path.join(dir, "factory", "launches", t1.mint, "state", "events.jsonl"), "utf8");
    assert.ok(ev.includes(sellSig) && ev.includes(visitor.publicKey.toBase58()), "the visitor's run is in the token's log");
    ok(`crank reward ${xnt(reward)} XNT arrived (balance +${xnt(delta)} after the ${xnt(tx.meta!.fee)} XNT fee); recorded for the token's stats`);
    setMinHarvest(t1.mint, "0.05");
    // A pass that started before the reset may still publish with the old threshold in its rules.
    const pass1 = (await fresh(`/api/vault/${t1.mint}`)).crank.lastPass?.at;
    await waitFor("a site crank pass after the reset", async () => (await fresh(`/api/vault/${t1.mint}`)).crank.lastPass?.at !== pass1, 120_000, 1_000);
  }

  console.log("3. The site publishes one more list and STOPS before paying it (the operator is gone)");
  let dead: Vault;
  {
    const before = await readVault(t1.mint);
    const last = before.listEpoch > before.pendingEpoch ? before.listEpoch : before.pendingEpoch;
    await trade(t1.mint, t1.rec.pool, 2);
    await waitFor("a new list pending on-chain, allocating new XNT", async () => {
      const v = await readVault(t1.mint);
      return v.pendingEpoch > last && v.pendingTotal >= v.holdersPaid + 10_000_000n;
    }, 300_000, 500);
    await stopServer();
    dead = await readVault(t1.mint);
    assert.ok(dead.pendingEpoch > last && !!cidFromBytes(dead.pendingCid));
    assert.equal((listFromIpfs(dead.pendingCid).file.rules as { minHarvest: string }).minHarvest, "50000000", "the list carries the token's rules");
    ok(`site stopped; list ${dead.pendingEpoch} (${cidFromBytes(dead.pendingCid)}) pending until ${new Date(dead.pendingActiveAt * 1000).toISOString()}, unpaid`);
  }

  console.log("4. Another wallet runs scripts/crank.ts --all: pays holders from the IPFS list");
  {
    await untilChainTime(dead.pendingActiveAt + 16, "the pending list's time + margin");
    const paidBefore = await paidRecords(vaultAddr);
    const getsBefore = gets;
    await crankTs(["--keypair", runnerFile, "--all"]);
    const v = await readVault(t1.mint);
    assert.equal(v.listEpoch, dead.pendingEpoch, "the list the dead site published is active");
    assert.ok(gets > getsBefore, "the list file was read from the IPFS gateway");
    const { file } = listFromIpfs(v.listCid);
    const paid = await paidRecords(vaultAddr);
    let n = 0;
    for (const [w, cum] of file.entries) {
      const p = paid.get(w) ?? 0n;
      if (p > (paidBefore.get(w) ?? 0n)) { assert.equal(p, BigInt(cum), `${w} paid up to its total`); n++; }
    }
    assert.ok(n > 0, "crank.ts paid holders");
    ok(`crank.ts paid ${n} wallet(s); holders paid ${xnt(v.holdersPaid)} of list total ${xnt(v.listTotal)} XNT`);
  }

  console.log("5. 30 s without a list: crank.ts pays from the last list with pay_fallback");
  {
    await trade(t1.mint, t1.rec.pool, 2); // more tax: funded grows past the list total
    const v0 = await readVault(t1.mint);
    await untilChainTime(v0.lastPublishAt + 30 + 16, "fallback start + margin");
    const before = await paidRecords(vaultAddr);
    const bal0 = new Map(await Promise.all(traders.map(async (t) => [t.publicKey.toBase58(), BigInt(await conn.getBalance(t.publicKey))] as [string, bigint])));
    await crankTs(["--keypair", runnerFile, "--all"]);
    const v = await readVault(t1.mint);
    assert.equal(v.listEpoch, v0.listEpoch, "no new list");
    assert.ok(v.holdersFunded > v.listTotal, "funded beyond the list");
    assert.ok(v.fallbackPaid > v0.fallbackPaid, "pay_fallback paid");
    const { file } = listFromIpfs(v.listCid);
    const after = await paidRecords(vaultAddr);
    let sum = 0n, exact = 0;
    for (const [w, c] of file.entries) {
      const ent = fallbackEntitled(BigInt(c), v.holdersFunded, v.listTotal);
      const p = after.get(w) ?? 0n;
      assert.ok(p <= ent, `${w} not paid above its entitlement`);
      if (p > (before.get(w) ?? 0n)) {
        assert.equal(p, ent, `${w} paid exactly floor(${c} * ${v.holdersFunded} / ${v.listTotal})`);
        sum += p - (before.get(w) ?? 0n); exact++;
        if (bal0.has(w)) assert.equal(BigInt(await conn.getBalance(new PublicKey(w))) - bal0.get(w)!, p - (before.get(w) ?? 0n), `${w}'s balance grew by its payment`);
      }
    }
    assert.ok(exact > 0);
    assert.equal(v.fallbackPaid - v0.fallbackPaid, sum, "fallback_paid grew by the sum of the fallback payments");
    assert.equal(v.holdersPaid, v0.holdersPaid + sum);
    const evs = (await eventsFor(v.address)).filter((e) => e.name === "FallbackPaid");
    assert.ok(evs.length >= exact);
    ok(`pay_fallback paid ${exact} wallet(s) ${xnt(sum)} XNT, each exactly floor(cumulative × ${xnt(v.holdersFunded)} / ${xnt(v.listTotal)}); holders paid ${xnt(v.holdersPaid)} > list total`);
  }

  console.log("6. The creator appoints a new publisher; crank.ts --publisher ends the fallback");
  {
    const v0 = await readVault(t1.mint);
    const ix = appointPublisherIx(PROGRAM, creator.publicKey, new PublicKey(t1.mint), newPublisher.publicKey);
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [creator]);
    const v1 = await readVault(t1.mint);
    assert.ok(v1.publisher.equals(newPublisher.publicKey));
    assert.equal(v1.lastPublishAt, v0.lastPublishAt, "appointing doesn't restart the clock");
    const ev = parseEvents((await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.meta!.logMessages ?? [], PROGRAM);
    assert.deepEqual(ev.map((e) => e.name), ["PublisherChanged"]);
    ok(`appointed ${newPublisher.publicKey.toBase58().slice(0, 8)}… (PublisherChanged by the guardian)`);

    await trade(t1.mint, t1.rec.pool, 2);
    const pinsBefore = pins;
    await crankTs(["--keypair", runnerFile, "--all", "--publisher", newPublisherFile, "--pinata-jwt", JWT, "--pinata-api", `${IPFS}/v3/files`]);
    const v = await readVault(t1.mint);
    assert.ok(pins > pinsBefore, "the new list was pinned first");
    assert.ok(v.pendingEpoch > v1.listEpoch && v.lastPublishAt > v1.lastPublishAt, "a list published: the clocks restart, fallback over");
    assert.ok(v.pendingTotal >= v.holdersPaid, "total >= holders_paid");
    const { cid, file } = listFromIpfs(v.pendingCid);
    const paid = await paidRecords(vaultAddr);
    for (const [w, p] of paid) {
      const e = file.entries.find(([x]) => x === w);
      assert.ok(e && BigInt(e[1]) >= p, `${w} isn't below what it was paid`);
    }
    ok(`list ${v.pendingEpoch} (${cid}): total ${xnt(v.pendingTotal)} >= holders paid ${xnt(v.holdersPaid)}, all ${paid.size} paid wallets at or above what they got`);

    await untilChainTime(v.pendingActiveAt + 16, "the new list's time + margin");
    await crankTs(["--keypair", runnerFile, "--all"]);
    const v2b = await readVault(t1.mint);
    assert.equal(v2b.listEpoch, v.pendingEpoch);
    assert.ok(v2b.holdersPaid > v.holdersPaid && v2b.holdersPaid <= v2b.listTotal, "holders paid from the new list");
    const after = await paidRecords(vaultAddr);
    let n = 0;
    for (const [w, c] of file.entries) if ((after.get(w) ?? 0n) > (paid.get(w) ?? 0n)) { assert.equal(after.get(w), BigInt(c)); n++; }
    ok(`crank.ts paid ${n} wallet(s) from the appointed publisher's list; holders paid ${xnt(v2b.holdersPaid)} of ${xnt(v2b.listTotal)} XNT`);
  }
  console.log("\nVault v3 operator-dies drill finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.stack ?? e.message : e);
  console.error("--- server log (last 60 lines) ---\n" + log.join("").split("\n").slice(-60).join("\n"));
  process.exitCode = 1;
} finally {
  await stopServer();
  ipfs.close();
  if (process.env.KEEP_DIR) console.log(`kept ${dir}`); else fs.rmSync(dir, { recursive: true, force: true });
}
