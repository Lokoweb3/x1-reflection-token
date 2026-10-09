/**
 * Mainnet Tax Vault v3 -> v4 (payout tokens) upgrade rehearsal, on a LOCAL validator holding
 * copies of the real mainnet accounts. Nothing is sent to mainnet.
 *
 *   1. prepare (reads mainnet only): dumps the deployed program (checks it is v3, sha256
 *      25e9881f…) and lists every account the upgrade touches for cloning: XDEX and lp_locker,
 *      Test's mint, pool, every Test token account and holder wallet, its lock NFT and reward
 *      vault, Test's live vault, its auth PDA and that PDA's token accounts, every PaidRecord,
 *      USDC.X and its XNT pool, XDEX's pool-creation accounts. Test's vault is written out with
 *      its publisher pointed at a local stand-in (the real publisher key stays on the VM) and its
 *      last sale / reward-swap slots zeroed (they are mainnet slots, ahead of a fresh local chain).
 *        npx tsx scripts/mainnet-v4-rehearsal.ts prepare <dir>
 *      then start the validator with the command it prints (a 3.x solana-test-validator): the
 *      dumped v3 program is loaded upgradeable with a local stand-in upgrade authority, so its
 *      program data account is the same size as on mainnet.
 *   2. run (local validator only):
 *        a. v3 as on mainnet today: the site (vault on, beta, payout tokens off) adopts Test's
 *           active rewards list from IPFS by its on-chain CID and cranks after trades.
 *        b. The upgrade as on rollout day: `solana program extend` by exactly the missing bytes,
 *           then `solana program deploy` of the v4 mainnet build; the dump equals the build.
 *        c. Test's vault after the upgrade: still v3 layout, still XNT payouts; the v4 site
 *           cranks it and pays holders their list amounts.
 *        d. Payout tokens on: /api/payout-token accepts USDC.X; a new launch paying holders in
 *           USDC.X (init_vault_payout through USDC.X's XNT pool); the crank swaps the holders'
 *           XNT into USDC.X and pays it; an XNT `pay` is refused; "Run the vault now".
 *        LOCAL_RPC=http://127.0.0.1:9601 [SOLANA_CLI=<3.x solana>] npx tsx scripts/mainnet-v4-rehearsal.ts run <dir>
 *      The mainnet build's 10-minute list window applies, so a run takes ~40 minutes.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { XDEX_CREATE, buildBuy, buildSell, decodePool, quoteBuy, quoteSell } from "../src/xdex.js";
import {
  PAID_RECORD_LEN, REWARD_TOKEN, VAULT_V3_LEN, addLiquidityIx, buildVaultTree, cidFromBytes, collectIx, decodePaidRecord, decodeVault, errorOf,
  fundCreatorIx, payIx, paysInToken, poolAccountsFrom, rawCid, rewardPoolAccountsFrom, sellIx, vaultAuthPda, vaultPda, type Vault,
} from "../src/taxvault.js";
import { listLocks, vaultPda as lockVaultPda } from "../src/locker.js";

const [mode, dirArg] = process.argv.slice(2);
assert.ok((mode === "prepare" || mode === "run") && dirArg, "usage: mainnet-v4-rehearsal.ts prepare|run <dir>");
const DIR = path.resolve(dirArg);
const MAINNET = "https://rpc.mainnet.x1.xyz";
const SITE_PUBLIC = "https://99tax.vercel.app";
const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const TEST = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");
const V3_SHA = "25e9881f2cc77f0b07f218d64f4abc57b4fa9ad6ed3dc3f18304cc38332ad6f4";
const V4_SO = process.env.V4_SO ?? "lp-locker/target/vault4b-mainnet/tax_vault.so";
const USDC = REWARD_TOKEN.mainnet;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const keyFile = (f: string, k: Keypair) => { fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const loadKey = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const SOLANA = process.env.SOLANA_CLI ?? "solana";

if (mode === "prepare") {
  const conn = new Connection(MAINNET, "confirmed");
  fs.mkdirSync(path.join(DIR, "accounts"), { recursive: true });
  // The deployed program, exactly as on mainnet.
  const v3File = path.join(DIR, "v3-chain.so");
  execFileSync(SOLANA, ["program", "dump", PROGRAM.toBase58(), v3File, "--url", MAINNET], { stdio: "inherit" });
  assert.equal(sha(fs.readFileSync(v3File)), V3_SHA, "mainnet runs the v3 build");
  ok(`dumped the deployed program (${fs.statSync(v3File).size} bytes, sha256 ${V3_SHA.slice(0, 8)}…)`);

  const clone = new Set<string>();
  const add = (...ks: (PublicKey | string)[]) => ks.forEach((k) => clone.add(k.toString()));
  const token = (await (await fetch(`${SITE_PUBLIC}/api/tokens`)).json() as Record<string, unknown>[]).find((t) => t.mint === TEST.toBase58())!;
  assert.ok(token, "Test is listed on the mainnet site");
  const poolKey = new PublicKey(String(token.pool));
  const pool = decodePool(poolKey, await conn.getAccountInfo(poolKey), XDEX);
  const rewardPool = decodePool(USDC.pool, await conn.getAccountInfo(USDC.pool), XDEX);
  const nft = new PublicKey(String(token.lockNft));
  const locks = await listLocks(conn, LOCKER, poolKey);
  const lock = locks.find((l) => l.nftMint.equals(nft));
  assert.ok(lock, "Test's lock NFT is in the locker");
  const payer = Keypair.generate().publicKey;
  const pa = poolAccountsFrom(XDEX, pool, TEST);
  for (const ix of [
    collectIx(PROGRAM, payer, TEST, []), sellIx(PROGRAM, payer, TEST, pa, 1n), addLiquidityIx(PROGRAM, payer, TEST, pa),
    fundCreatorIx(PROGRAM, payer, TEST, nft, rewardPoolAccountsFrom(XDEX, rewardPool, USDC.mint)),
  ]) add(...ix.keys.map((k) => k.pubkey));
  add(poolKey, USDC.pool, USDC.mint, nft, lock!.address, lockVaultPda(LOCKER, lock!.address), XDEX_CREATE.mainnet.ammConfig, XDEX_CREATE.mainnet.createPoolFee);
  // Test's vault: its auth PDA's token accounts and every PaidRecord.
  const vaultKey = vaultPda(PROGRAM, TEST), auth = vaultAuthPda(PROGRAM, TEST);
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    for (const a of (await conn.getTokenAccountsByOwner(auth, { programId: program })).value) add(a.pubkey);
  }
  const records = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: vaultKey.toBase58() } }] });
  for (const r of records) add(r.pubkey);
  // Every Test token account, its owner, and every lock of the pool.
  const tokenAccounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: TEST.toBase58() } }] });
  for (const a of tokenAccounts) add(a.pubkey, new PublicKey(a.account.data.subarray(32, 64)));
  for (const l of locks) add(l.address, l.nftMint);
  const builtins = new Set(["11111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "So11111111111111111111111111111111111111112",
    "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", XDEX.toBase58(), LOCKER.toBase58(), PROGRAM.toBase58(),
    vaultKey.toBase58()]);
  const keys = [...clone].filter((k) => !builtins.has(k));
  const exists: string[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k)));
    infos.forEach((inf, j) => { if (inf && !inf.executable) exists.push(keys[i + j]); });
  }
  // Test's vault with the publisher pointed at a local stand-in (publisher: the 6th key after the discriminator).
  const standIn = Keypair.generate();
  keyFile(path.join(DIR, "publisher-standin.json"), standIn);
  const vInfo = (await conn.getAccountInfo(vaultKey))!;
  const data = Buffer.from(vInfo.data);
  const v = decodeVault(vaultKey, data);
  assert.equal(v.version, 3); assert.equal(data.length, VAULT_V3_LEN); assert.ok(!paysInToken(v), "Test pays in XNT");
  const PUBLISHER_AT = 8 + 32 * 5;
  assert.ok(data.subarray(PUBLISHER_AT, PUBLISHER_AT + 32).equals(v.publisher.toBuffer()));
  standIn.publicKey.toBuffer().copy(data, PUBLISHER_AT);
  // The vault's last sale / reward-swap slots are mainnet slots, far ahead of a fresh local chain (one per slot):
  // zero them. (Warping the local chain past them instead moves its clock hours ahead of the site's.)
  const LAST_SELL_AT = 472, LAST_REWARD_AT = 490;
  assert.equal(data.readBigUInt64LE(LAST_SELL_AT), v.lastSellSlot); assert.equal(data.readBigUInt64LE(LAST_REWARD_AT), v.lastRewardSlot);
  data.writeBigUInt64LE(0n, LAST_SELL_AT); data.writeBigUInt64LE(0n, LAST_REWARD_AT);
  const patched = decodeVault(vaultKey, data);
  assert.ok(patched.publisher.equals(standIn.publicKey)); assert.equal(patched.lastSellSlot, 0n); assert.equal(patched.lastRewardSlot, 0n);
  fs.writeFileSync(path.join(DIR, "accounts", "test-vault.json"), JSON.stringify({
    pubkey: vaultKey.toBase58(), account: { lamports: vInfo.lamports, data: [data.toString("base64"), "base64"], owner: vInfo.owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
  }));
  // Test's launch record as the mainnet site has it (on the vault; the retired distributor stays excluded).
  const launch = {
    name: token.name, symbol: token.symbol, image: token.image ?? "", description: token.description ?? "", supply: token.supply, poolTokens: token.poolTokens,
    poolXnt: token.poolXnt, taxBps: token.taxBps, autoLpBps: token.autoLpBps, burnBps: token.burnBps, lockDays: token.lockDays ?? null, creator: token.creator,
    mint: TEST.toBase58(), distributor: token.distributor, pool: poolKey.toBase58(), lockNft: nft.toBase58(), createdAt: token.createdAt, taxVault: true,
  };
  fs.writeFileSync(path.join(DIR, "test-launch.json"), JSON.stringify(launch, null, 2));
  const authority = Keypair.generate();
  keyFile(path.join(DIR, "upgrade-authority.json"), authority);
  const cmd = ["solana-test-validator --reset --ledger", path.join(DIR, "ledger"), "--rpc-port 9601 --faucet-port 9605 --gossip-port 9603 --dynamic-port-range 9610-9640",
    "--url", MAINNET, "--clone-upgradeable-program", XDEX.toBase58(), "--clone-upgradeable-program", LOCKER.toBase58(),
    "--upgradeable-program", PROGRAM.toBase58(), v3File, authority.publicKey.toBase58(),
    "--account", vaultKey.toBase58(), path.join(DIR, "accounts", "test-vault.json"), ...exists.flatMap((k) => ["--clone", k])].join(" ");
  fs.writeFileSync(path.join(DIR, "validator-cmd.sh"), cmd + "\n");
  console.log(`prepared ${exists.length} accounts to clone (+ XDEX, lp_locker, the v3 program, Test's vault with publisher -> stand-in ${standIn.publicKey.toBase58().slice(0, 4)}…)`);
  console.log(`Test: ${tokenAccounts.length} token accounts, ${records.length} PaidRecords, list epoch ${v.listEpoch} (pending ${v.pendingEpoch}), holders funded ${v.holdersFunded} / paid ${v.holdersPaid} lamports`);
  console.log(`validator command: ${path.join(DIR, "validator-cmd.sh")}`);
  process.exit(0);
}

// ====================== run (local validator only) ======================
const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9601";
assert.match(RPC, /127\.0\.0\.1|localhost/, "the rehearsal only runs against a local validator");
const conn = new Connection(RPC, "confirmed");
const PORT = 8161, SITE = `http://127.0.0.1:${PORT}`, IPFS_PORT = 8162, IPFS = `http://127.0.0.1:${IPFS_PORT}`, JWT = "rehearsal-jwt";
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
const xntS = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);
const usdcS = (u: number | bigint) => (Number(u) / 10 ** USDC.decimals).toFixed(6);

// ---------- IPFS stand-in: pins here; anything else (Test's real lists) from Pinata's gateway ----------
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
  // Test's real lists: through Pinata's gateway, as the mainnet site reads them (public gateways rate-limit or time out).
  const real = g ? await fetch(`https://gateway.pinata.cloud/ipfs/${g[1]}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null) : null;
  if (real?.ok) { res.writeHead(200).end(Buffer.from(await real.arrayBuffer())); return; }
  res.writeHead(404).end("not found");
}).listen(IPFS_PORT, "127.0.0.1");

const work = path.join(DIR, "site");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(path.join(work, "factory", "launches", TEST.toBase58()), { recursive: true }); fs.mkdirSync(path.join(work, "state"));
const testRec = JSON.parse(fs.readFileSync(path.join(DIR, "test-launch.json"), "utf8"));
const testPool = new PublicKey(testRec.pool);
const testDir = path.join(work, "factory", "launches", TEST.toBase58());
fs.writeFileSync(path.join(testDir, "launch.json"), JSON.stringify(testRec, null, 2));
const publisherFile = path.join(DIR, "publisher-standin.json");
const publisher = loadKey(publisherFile), authority = loadKey(path.join(DIR, "upgrade-authority.json"));
const visitor = Keypair.generate(), newCreator = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [publisher, visitor]) await fund(k.publicKey, 5);
for (const k of [newCreator, ...traders]) await fund(k.publicKey, 300);
await fund(authority.publicKey, 10);

const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
// A local fee token stands in for the USDC.X launch fee.
const { createMint, mintTo, getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
const feeMint = await createMint(conn, newCreator, newCreator.publicKey, null, 6);
await mintTo(conn, newCreator, feeMint, (await getOrCreateAssociatedTokenAccount(conn, newCreator, feeMint, newCreator.publicKey)).address, newCreator, 5_000_000);
const cfgFile = path.join(work, "config.json");
function writeConfig(payoutTokens: boolean) {
  const cfg = {
    ...base, network: "mainnet", rpcUrl: RPC, mint: "",
    xdex: { ...base.xdex, programId: XDEX.toBase58(), pool: "" }, locker: { ...base.locker, programId: LOCKER.toBase58() },
    distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
    factory: {
      ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined, curve: undefined, quoteTokens: undefined,
      launchesPaused: undefined, lockForeverOnly: true, otherNetwork: undefined,
      feeToken: { mint: feeMint.toBase58(), symbol: "USDC", amount: "1" },
      pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
      taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: publisherFile, mainnet: true, beta: true, ...(payoutTokens ? { payoutTokens: true, rewardTokenPayouts: true } : {}) },
    },
  };
  delete cfg.creatorReward;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
const env = { ...process.env, REFLECT_CONFIG: cfgFile, REFLECT_FACTORY_DIR: path.join(work, "factory"), REFLECT_STATE_DIR: path.join(work, "state"),
  REFLECT_RPC_URL: RPC, PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "", TAX_VAULT_PASS_SECS: "10" };
let server: ReturnType<typeof spawn> | null = null;
const log: string[] = [];
async function startSite() {
  server = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/factory-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 80 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
  if (!(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false))) { console.error(log.join("")); throw new Error("the site didn't start"); }
}
async function stopSite() { if (!server) return; server.kill(); await new Promise((r) => server!.once("exit", r)); server = null; }
process.on("exit", () => server?.kill());
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
async function waitFor(what: string, test: () => Promise<boolean>, ms = 900_000, every = 5_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; } await sleep(every); }
  console.error(log.slice(-40).join("")); throw new Error(`timed out waiting for: ${what}`);
}
const readVault = async (mint: PublicKey): Promise<Vault> => { const a = vaultPda(PROGRAM, mint); return decodeVault(a, (await conn.getAccountInfo(a, "confirmed"))!.data); };
async function trade(mint: PublicKey, pool: PublicKey, xntEach = 5n) {
  for (const t of traders) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, pool, mint, xntEach * 10n ** 9n, 300)))), [t]);
  for (const t of traders.slice(0, 2)) {
    const bal = (await getAccount(conn, getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const q = await quoteSell(conn, XDEX, pool, mint, bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
    if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, mint, q))), [t]);
  }
}
const paidRecords = async (v: Vault) => {
  const raw = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: v.address.toBase58() } }] });
  return new Map(raw.map(({ pubkey, account }) => { const r = decodePaidRecord(pubkey, account.data); return [r.wallet.toBase58(), r]; }));
};
/** Wait until a list newer than `after` went live and paid every wallet its list amount, except what's under `min` (the
 *  crank holds an unpaid remainder smaller than the minimum payout for later). */
async function waitPaid(what: string, mint: PublicKey, after: bigint, min: bigint) {
  let file: { entries: [string, string][] } | null = null;
  await waitFor(`${what}: a new list published (CID pinned)`, async () => {
    const v = await readVault(mint);
    const epoch = v.pendingEpoch > after ? v.pendingEpoch : v.listEpoch > after ? v.listEpoch : 0n;
    if (!epoch) return false;
    const cid = cidFromBytes(v.pendingEpoch === epoch ? v.pendingCid : v.listCid);
    if (!cid || !pinned.has(cid)) return false;
    file = JSON.parse(pinned.get(cid)!.toString()); return true;
  });
  await waitFor(`${what}: holders paid their list amounts`, async () => {
    const v = await readVault(mint);
    if (v.listEpoch <= after) return false;
    const paid = await paidRecords(v);
    return paid.size > 0 && file!.entries.every(([w, c]) => BigInt(c) - (paid.get(w)?.paid ?? 0n) < min);
  }, 1_500_000, 15_000);
  return file!;
}

console.log("1. v3 as on mainnet today: the site adopts Test's vault");
writeConfig(false);
await startSite();
const info3 = await api("/api/info");
assert.equal(info3.network, "mainnet"); assert.equal(info3.taxVault?.beta, true); assert.ok(!info3.taxVault?.payoutTokens);
await api("/api/launch/register", { mint: TEST.toBase58(), creator: testRec.creator });
const testCfg = path.join(testDir, "config.json");
fs.writeFileSync(testCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(testCfg, "utf8")), taxVault: true }, null, 2), { mode: 0o600 });
const t0 = await readVault(TEST);
assert.equal(t0.version, 3); assert.ok(t0.publisher.equals(publisher.publicKey));
ok(`Test registered on the vault: list epoch ${t0.listEpoch}, holders funded ${xntS(t0.holdersFunded)} / paid ${xntS(t0.holdersPaid)} XNT`);
await trade(TEST, testPool); await trade(TEST, testPool);
await waitFor("v3 crank pass on Test: collected and sold after trades", async () => { const v = await readVault(TEST); return v.totalCollected > t0.totalCollected && v.holdersFunded > t0.holdersFunded; });
if (t0.listEpoch > 0n) await waitFor("Test's active list adopted from IPFS by its on-chain CID", async () =>
  JSON.parse(fs.readFileSync(path.join(testDir, "state", "vault-list.json"), "utf8")).active?.epoch === t0.listEpoch.toString(), 300_000);
await stopSite();

console.log("2. The upgrade as on rollout day: extend, deploy v4, compare");
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
const PD_HEADER = 45;
const pdBefore = (await conn.getAccountInfo(programData))!;
const v4 = fs.readFileSync(V4_SO);
const extra = v4.length - (pdBefore.data.length - PD_HEADER);
assert.equal(pdBefore.data.length - PD_HEADER, 590_376, "the local program data is mainnet's size");
const balBefore = await conn.getBalance(authority.publicKey);
const authFile = path.join(DIR, "upgrade-authority.json");
execFileSync(SOLANA, ["program", "extend", PROGRAM.toBase58(), String(extra), "--keypair", authFile, "--url", RPC], { stdio: "inherit" });
execFileSync(SOLANA, ["program", "deploy", "--program-id", PROGRAM.toBase58(), "--upgrade-authority", authFile, "--keypair", authFile, "--url", RPC, V4_SO], { stdio: "inherit" });
const spent = balBefore - await conn.getBalance(authority.publicKey);
const dump = path.join(DIR, "v4-dump.so");
execFileSync(SOLANA, ["program", "dump", PROGRAM.toBase58(), dump, "--url", RPC]);
const dumped = fs.readFileSync(dump);
assert.equal(dumped.length, v4.length, "extended by exactly the missing bytes");
assert.equal(sha(dumped), sha(v4), "deployed bytes = the v4 mainnet build");
ok(`extended by ${extra} bytes and upgraded (sha256 ${sha(v4).slice(0, 8)}…, matches the build); cost ${xntS(spent)} XNT`);

console.log("3. Test's vault on v4: unchanged layout, still XNT, the crank pays holders");
const t1 = await readVault(TEST);
assert.equal(t1.version, 3); assert.ok(!paysInToken(t1)); assert.equal(t1.xntHolders, 0n);
ok("Test's vault reads the same after the upgrade (no migration step, payout pool zero = XNT)");
writeConfig(true);
await startSite();
const info4 = await api("/api/info");
assert.equal(info4.taxVault?.payoutTokens, true);
await trade(TEST, testPool, 20n); await trade(TEST, testPool, 20n);
const testList = await waitPaid("Test on v4", TEST, t1.listEpoch, 1_000_000n); // minPayoutXnt 0.001
ok(`Test list: ${testList.entries.length} wallets; XNT payouts work on v4`);

console.log("4. Payout tokens: a new launch paying holders in USDC.X");
const good = await api(`/api/payout-token?mint=${USDC.mint.toBase58()}`);
assert.equal(good.pool, USDC.pool.toBase58()); assert.equal(good.decimals, USDC.decimals);
ok(`/api/payout-token: USDC.X accepted (pool ${good.pool.slice(0, 4)}…, ${good.poolXnt} XNT side)`);
{
  const q = await quoteBuy(conn, XDEX, USDC.pool, USDC.mint, 10n * 10n ** 9n, 300);
  await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, newCreator, q))), [newCreator]);
}
const params = { name: "Payout Drill", symbol: "PDRL", image: "", description: "mainnet v4 drill", supply: "1000000000", poolTokens: "1000000000", poolXnt: "30",
  taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: newCreator.publicKey.toBase58(), payoutMint: USDC.mint.toBase58() };
const { mint: mintStr } = await step("/api/launch/token", params, newCreator);
const mint = new PublicKey(mintStr);
await step("/api/launch/pool", { mint: mintStr, creator: params.creator }, newCreator);
await step("/api/launch/lock", { mint: mintStr, creator: params.creator }, newCreator);
await step("/api/launch/vault", { mint: mintStr, creator: params.creator }, newCreator);
await api("/api/launch/register", { mint: mintStr, creator: params.creator });
const n0 = await readVault(mint);
assert.ok(paysInToken(n0)); assert.ok(n0.payoutPool.equals(USDC.pool)); assert.ok(n0.rewardMint.equals(USDC.mint));
ok(`launch ${mintStr.slice(0, 4)}…: init_vault_payout (holders in USDC.X through ${USDC.pool.toBase58().slice(0, 4)}…), creator reward USDC.X`);
const rec = JSON.parse(fs.readFileSync(path.join(work, "factory", "launches", mintStr, "launch.json"), "utf8"));
await trade(mint, new PublicKey(rec.pool), 10n); await trade(mint, new PublicKey(rec.pool), 10n);
await waitFor("collect, sell, fund_holders (holders' XNT swapped into USDC.X)", async () => { const v = await readVault(mint); return v.holdersFunded > 0n; });
const n1 = await readVault(mint);
const authUsdc = getAssociatedTokenAddressSync(USDC.mint, vaultAuthPda(PROGRAM, mint), true, TOKEN_2022_PROGRAM_ID);
const held = (await getAccount(conn, authUsdc, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
assert.ok(held >= n1.holdersFunded - n1.holdersPaid);
ok(`holder pool ${usdcS(n1.holdersFunded)} USDC.X; auth holds ${usdcS(held)}`);
const usdcList = await waitPaid("USDC.X launch", mint, 0n, 1_000n); // 0.001 USDC.X, above 0.001 XNT's worth
const recs = await paidRecords(await readVault(mint));
for (const r of recs.values()) {
  const bal = (await getAccount(conn, getAssociatedTokenAddressSync(USDC.mint, r.wallet, true, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  assert.ok(bal >= r.paid, `${r.wallet.toBase58()} holds its USDC.X payout`);
}
ok(`${recs.size} wallets paid in USDC.X (list of ${usdcList.entries.length})`);
// USDC.X is also the creator reward: fund_creator shares auth's USDC.X account with the holders.
await waitFor("creator reward paid in USDC.X while auth still covers the holders", async () => {
  const v = await readVault(mint);
  const bal = (await getAccount(conn, authUsdc, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  return v.totalRewardOut > 0n && bal >= v.holdersFunded - v.holdersPaid;
}, 300_000);
const v2 = await readVault(mint);
const [w0, c0] = usdcList.entries[0];
const { proofs } = buildVaultTree(v2.address, Object.fromEntries(usdcList.entries));
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(payIx(PROGRAM, visitor.publicKey, mint, new PublicKey(w0), BigInt(c0), proofs[w0])), [visitor]);
  assert.fail("an XNT pay was accepted");
} catch (e) { assert.equal(errorOf(String(e)), "PaysInToken"); }
ok("an XNT `pay` on the USDC.X vault is refused (PaysInToken)");
const stats = await api(`/api/token/${mintStr}/stats?t=${Date.now()}`);
assert.ok(Number(stats.holdersXnt) > 0);
ok(`stats: paid to holders ≈ ${xntS(BigInt(stats.holdersXnt))} XNT (USDC.X valued at the vault's swap price)`);

console.log("5. \"Run the vault now\" from a visitor's wallet");
await trade(mint, new PublicKey(rec.pool), 20n);
const plan = await api(`/api/vault/${mintStr}/crank-tx`, { caller: visitor.publicKey.toBase58() }).catch((e) => ({ error: String(e) }));
if ("txs" in plan) {
  const sigs: string[] = [];
  for (const t of plan.txs as { tx: string; label: string }[]) {
    const tx = Transaction.from(Buffer.from(t.tx, "base64")); tx.partialSign(visitor);
    try { sigs.push((await api("/api/send", { tx: tx.serialize().toString("base64") })).signature); } catch (e) { console.log(`    – ${t.label}: ${String(e).slice(0, 140)}`); }
  }
  ok(`visitor ran ${sigs.length}/${plan.txs.length} step(s): ${(plan.txs as { label: string }[]).map((t) => t.label).join(" · ")}`);
} else ok(`nothing due for a visitor right now (${plan.error.slice(0, 120)})`);

await stopSite();
console.log("\nMainnet v4 rehearsal passed.");
process.exit(0);
