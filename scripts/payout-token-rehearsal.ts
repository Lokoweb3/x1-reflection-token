/**
 * Payout token rehearsal (Tax Vault v4: holders paid in another token), on a LOCAL validator
 * holding testnet's XDEX, lp_locker and XNM reward pool, with the v4 short-windows build.
 * Nothing goes to testnet or mainnet.
 *
 *   1. A payout token PAY (Token-2022, no freeze authority, no extensions) with an XNT pool,
 *      and a FRZ token with a freeze authority. The site's /api/payout-token accepts PAY and
 *      refuses FRZ, XNT and an address that isn't a token.
 *   2. A launch through the site with payoutMint = PAY: the vault is created with
 *      init_vault_payout (pays in PAY through PAY's pool) and registration accepts it.
 *   3. Trades; the site's crank collects, sells (the holders' XNT waits in xnt_holders),
 *      swaps it into PAY (fund_holders), publishes a list in PAY units and pays it with
 *      pay_token: each holder's PAY account ends with exactly its list amount.
 *   4. The program refuses an XNT `pay` on this vault (PaysInToken); the stats pages value the
 *      PAY payouts in XNT; "Run the vault now" from a visitor's wallet plans and runs.
 *
 * Start the validator (3.1.x) with the v4 short-windows build:
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9501 --faucet-port 9505 \
 *     --gossip-port 9503 --dynamic-port-range 9510-9540 --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --clone AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ --clone 6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA \
 *     --clone 5GUzsG219nDBZJvS2xN5L8gQr43G9owzMhEL1X3a6soS --clone FQG6rKgbDCBxVxWZimckZpBMedkGC7RqBLXGMQ379sr2 \
 *     --clone 5nwh3vHNEyhGRA2Hc2o24ekTvqVSr7Dm7C3rkPH7GkP --clone CdQJoNNF1UpYekqzaXKekDc5hsrD6zzuZEMQv8hLavfc \
 *     --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault4-test/tax_vault.so
 * then:
 *   LOCAL_RPC=http://127.0.0.1:9501 npx tsx scripts/payout-token-rehearsal.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildCreatePool, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";
import {
  PAID_RECORD_LEN, buildVaultTree, cidFromBytes, decodePaidRecord, decodeVault, errorOf, payIx, paysInToken, rawCid, vaultAuthPda, vaultPda, type Vault,
} from "../src/taxvault.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9501";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const PORT = 8151, SITE = `http://127.0.0.1:${PORT}`, IPFS_PORT = 8152, IPFS = `http://127.0.0.1:${IPFS_PORT}`, JWT = "rehearsal-jwt";
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");

// ---------- IPFS stand-in ----------
const pinned = new Map<string, Buffer>();
http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && req.url === "/v3/files") {
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const cid = rawCid(bytes); pinned.set(cid, bytes);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { cid } })); return;
  }
  const g = /^\/ipfs\/(\w+)/.exec(req.url ?? "");
  if (g && pinned.has(g[1])) { res.writeHead(200).end(pinned.get(g[1])); return; }
  res.writeHead(404).end("not found");
}).listen(IPFS_PORT, "127.0.0.1");

console.log("1. Payout tokens: PAY (plain, with an XNT pool) and FRZ (freeze authority)");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "payout-token-rehearsal-"));
const maker = Keypair.generate(), creator = Keypair.generate(), publisher = Keypair.generate(), visitor = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [maker, creator, ...traders]) await fund(k.publicKey, 200);
for (const k of [publisher, visitor]) await fund(k.publicKey, 5);
const pay = await createMint(conn, maker, maker.publicKey, null, 6, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);
{
  const ata = getAssociatedTokenAddressSync(pay, maker.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, ata, maker.publicKey, pay, TOKEN_2022_PROGRAM_ID)), [maker]);
  await mintTo(conn, maker, pay, ata, maker, 10_000_000n * 10n ** 6n, [], undefined, TOKEN_2022_PROGRAM_ID);
  const { ixs, pool } = buildCreatePool(XDEX, "testnet", maker.publicKey, pay, 1_000_000n * 10n ** 6n, 50n * 10n ** 9n);
  await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [maker]);
  ok(`PAY ${pay.toBase58().slice(0, 4)}…: pool ${pool.toBase58().slice(0, 4)}… with 1,000,000 PAY + 50 XNT`);
}
const frz = await createMint(conn, maker, maker.publicKey, maker.publicKey, 6, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);

// ---------- the site (testnet, vault + payout tokens on) ----------
const keyFile = (name: string, k: Keypair) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const feeMint = await createMint(conn, creator, creator.publicKey, null, 6);
{
  const ata = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata, creator.publicKey, feeMint)), [creator]);
  await mintTo(conn, creator, feeMint, ata, creator, 5_000_000);
}
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" }, distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined, curve: undefined, quoteTokens: undefined, launchesPaused: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
    taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: keyFile("publisher", publisher), payoutTokens: true, payoutMinPoolXnt: "10" },
  },
};
delete cfg.creatorReward;
const cfgFile = path.join(dir, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = { ...process.env, REFLECT_CONFIG: cfgFile, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC,
  TAX_VAULT_SHORT_WINDOWS: "1", PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "", TAX_VAULT_PASS_SECS: "10" };
const log: string[] = [];
const server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/factory-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
process.on("exit", () => server.kill());
for (let i = 0; i < 80 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
async function step(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64")); tx.partialSign(signer);
  return { ...out, ...(await api("/api/send", { tx: tx.serialize().toString("base64") })) };
}
async function waitFor(what: string, test: () => Promise<boolean>, ms = 300_000, every = 3_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; } await sleep(every); }
  console.error(log.slice(-40).join("")); throw new Error(`timed out waiting for: ${what}`);
}
const info = await api("/api/info");
assert.equal(info.taxVault?.payoutTokens, true);
const good = await api(`/api/payout-token?mint=${pay.toBase58()}`);
assert.equal(good.mint, pay.toBase58()); assert.equal(good.decimals, 6); assert.equal(Number(good.poolXnt), 50);
const refused = async (m: string, re: RegExp) => { try { await api(`/api/payout-token?mint=${m}`); assert.fail(`${m} accepted`); } catch (e) { assert.match(String(e), re); } };
await refused(frz.toBase58(), /freeze authority/);
await refused("So11111111111111111111111111111111111111112", /empty to pay holders in XNT/);
await refused(Keypair.generate().publicKey.toBase58(), /isn't a token/);
ok("/api/payout-token: PAY accepted (50 XNT pool, 6 decimals); FRZ, XNT and a non-token refused");

console.log("2. A launch paying holders in PAY");
const params = { name: "Pays In Pay", symbol: "PIP", image: "", description: "payout token drill", supply: "1000000000", poolTokens: "1000000000", poolXnt: "30",
  taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: creator.publicKey.toBase58(), payoutMint: pay.toBase58() };
const { mint } = await step("/api/launch/token", params, creator);
await step("/api/launch/pool", { mint, creator: params.creator }, creator);
await step("/api/launch/lock", { mint, creator: params.creator }, creator);
await step("/api/launch/vault", { mint, creator: params.creator }, creator);
await api("/api/launch/register", { mint, creator: params.creator });
const readVault = async (): Promise<Vault> => { const a = vaultPda(PROGRAM, new PublicKey(mint)); return decodeVault(a, (await conn.getAccountInfo(a, "confirmed"))!.data); };
const v0 = await readVault();
assert.ok(paysInToken(v0), "the vault pays in a token");
assert.equal(v0.payoutPool.toBase58(), good.pool);
ok(`launch ${mint.slice(0, 4)}…: vault created with init_vault_payout (payout pool ${good.pool.slice(0, 4)}…), registered`);

console.log("3. Trades; the site's crank swaps the holders' XNT into PAY and pays in PAY");
const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
async function trade(xntEach: bigint) {
  for (const t of traders) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, new PublicKey(rec.pool), new PublicKey(mint), xntEach * 10n ** 9n, 300)))), [t]);
  for (const t of traders.slice(0, 2)) {
    const bal = (await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(mint), t.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const q = await quoteSell(conn, XDEX, new PublicKey(rec.pool), new PublicKey(mint), bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
    if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, new PublicKey(mint), q))), [t]);
  }
}
await trade(3n); await trade(3n);
await waitFor("collect + sell (holders' XNT waiting to be swapped) and fund_holders (PAY into the holder pool)", async () => {
  const v = await readVault(); return v.totalCollected > 0n && v.holdersFunded > 0n;
});
const v1 = await readVault();
const authPay = getAssociatedTokenAddressSync(pay, vaultAuthPda(PROGRAM, new PublicKey(mint)), true, TOKEN_2022_PROGRAM_ID);
const held = (await getAccount(conn, authPay, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
assert.ok(held >= v1.holdersFunded - v1.holdersPaid, "auth's PAY covers what holders are owed");
ok(`holder pool: ${(Number(v1.holdersFunded) / 1e6).toFixed(6)} PAY funded; auth holds ${(Number(held) / 1e6).toFixed(6)} PAY`);
await waitFor("a list in PAY units, pinned and published", async () => { const v = await readVault(); return v.listEpoch > 0n || v.pendingEpoch > 0n; });
const vl = await readVault();
const cid = cidFromBytes(vl.pendingEpoch > 0n ? vl.pendingCid : vl.listCid)!;
const file = JSON.parse(pinned.get(cid)!.toString()) as { entries: [string, string][] };
ok(`list: ${file.entries.length} wallets, total ${(Number(file.entries.reduce((a, [, c]) => a + BigInt(c), 0n)) / 1e6).toFixed(6)} PAY`);
await waitFor("holders paid in PAY: each wallet's PAY account = its list amount", async () => {
  const v = await readVault();
  if (v.listEpoch === 0n) return false;
  const raw = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: v.address.toBase58() } }] });
  if (!raw.length) return false;
  for (const { pubkey, account } of raw) {
    const r = decodePaidRecord(pubkey, account.data);
    const bal = (await getAccount(conn, getAssociatedTokenAddressSync(pay, r.wallet, true, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null))?.amount ?? 0n;
    if (bal !== r.paid) return false;
  }
  return true;
}, 300_000, 5_000);

console.log("4. Refusals, stats and a visitor's run");
const v2 = await readVault();
const entries = Object.fromEntries(file.entries);
const [w0, c0] = file.entries[0];
const { proofs } = buildVaultTree(v2.address, entries);
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(payIx(PROGRAM, visitor.publicKey, new PublicKey(mint), new PublicKey(w0), BigInt(c0), proofs[w0])), [visitor]);
  assert.fail("an XNT pay was accepted");
} catch (e) { assert.equal(errorOf(String(e)), "PaysInToken"); }
ok("an XNT `pay` on this vault is refused (PaysInToken)");
const stats = await api(`/api/token/${mint}/stats?t=${Date.now()}`);
assert.ok(Number(stats.holdersXnt) > 0, "PAY payouts valued in XNT");
ok(`stats: paid to holders ≈ ${(Number(stats.holdersXnt) / 1e9).toFixed(6)} XNT (PAY valued at the vault's swap price)`);
await trade(20n);
const plan = await api(`/api/vault/${mint}/crank-tx`, { caller: visitor.publicKey.toBase58() }).catch((e) => ({ error: String(e) }));
if ("txs" in plan) {
  const sigs: string[] = [];
  for (const t of plan.txs as { tx: string; label: string }[]) {
    const tx = Transaction.from(Buffer.from(t.tx, "base64")); tx.partialSign(visitor);
    try { sigs.push((await api("/api/send", { tx: tx.serialize().toString("base64") })).signature); } catch (e) { console.log(`    – ${t.label}: ${String(e).slice(0, 140)}`); }
  }
  ok(`visitor ran ${sigs.length}/${plan.txs.length} step(s): ${(plan.txs as { label: string }[]).map((t) => t.label).join(" · ")}`);
} else ok(`nothing due for a visitor (${plan.error.slice(0, 100)})`);
server.kill();
console.log("\nPayout token rehearsal passed.");
process.exit(0);
