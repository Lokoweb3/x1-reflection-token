/**
 * Mainnet Tax Vault rollout rehearsal (docs/MAINNET-ROLLOUT.md, P3), on a LOCAL validator
 * holding copies of the real mainnet accounts. Nothing is sent to mainnet.
 *
 *   1. prepare (reads mainnet only): every account the rollout touches is listed for cloning:
 *      XDEX and lp_locker, Test's mint, pool, every Test token account and holder wallet, its
 *      lock NFT and reward vault, USDC.X and its XNT pool, XDEX's pool-creation accounts.
 *      Test's mint is written out with its tax withdraw authority pointed at a throwaway
 *      stand-in (the real distributor key never leaves the VM), with its launch record
 *      rebuilt from the site's public data.
 *        npx tsx scripts/mainnet-vault-rehearsal.ts prepare <dir>
 *      then start the validator with the command it prints (a 3.x solana-test-validator).
 *   2. run (local validator only): deploy the mainnet build with `solana program deploy`,
 *      start the current site as the mainnet site (vault on, beta), trade Test, migrate Test
 *      with scripts/migrate-to-vault.ts, and let the site's crank collect, sell, add
 *      liquidity, pay the creator reward in USDC.X, publish a list (IPFS stand-in) and pay
 *      holders; "Run the vault now" from a visitor's wallet; then a new launch on the vault
 *      through the site.
 *        LOCAL_RPC=http://127.0.0.1:9401 npx tsx scripts/mainnet-vault-rehearsal.ts run <dir>
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { XDEX_CREATE, buildBuy, buildSell, decodePool, quoteBuy, quoteSell } from "../src/xdex.js";
import {
  PAID_RECORD_LEN, REWARD_TOKEN, addLiquidityIx, cidFromBytes, collectIx, decodePaidRecord, decodeVault, fundCreatorIx, initVaultIx,
  poolAccountsFrom, rawCid, rewardPoolAccountsFrom, sellIx, vaultAuthPda, vaultPda, type Vault,
} from "../src/taxvault.js";
import { listLocks, rewardTokensPda, rewardVaultPda, vaultPda as lockVaultPda } from "../src/locker.js";

const [mode, dirArg] = process.argv.slice(2);
assert.ok((mode === "prepare" || mode === "run") && dirArg, "usage: mainnet-vault-rehearsal.ts prepare|run <dir>");
const DIR = path.resolve(dirArg);
const MAINNET = "https://rpc.mainnet.x1.xyz";
const SITE_PUBLIC = "https://99tax.vercel.app";
const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const TEST = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");
const SO = "lp-locker/target/vault3-mainnet/tax_vault.so";
const PROGRAM_KEYPAIR = "lp-locker/target/deploy/tax_vault-keypair.json";
const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keyFile = (f: string, k: Keypair) => { fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const loadKey = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));

if (mode === "prepare") {
  const conn = new Connection(MAINNET, "confirmed");
  fs.mkdirSync(path.join(DIR, "accounts"), { recursive: true });
  const clone = new Set<string>();
  const add = (...ks: (PublicKey | string)[]) => ks.forEach((k) => clone.add(k.toString()));
  // Test's pool and the USDC.X reward pool, with every account their instructions use.
  const token = (await (await fetch(`${SITE_PUBLIC}/api/tokens`)).json() as Record<string, unknown>[]).find((t) => t.mint === TEST.toBase58())!;
  assert.ok(token, "Test is listed on the mainnet site");
  const poolKey = new PublicKey(String(token.pool));
  const pool = decodePool(poolKey, await conn.getAccountInfo(poolKey), XDEX);
  const rp = REWARD_TOKEN.mainnet;
  const rewardPool = decodePool(rp.pool, await conn.getAccountInfo(rp.pool), XDEX);
  const locks = await listLocks(conn, LOCKER, poolKey);
  const nft = new PublicKey(String(token.lockNft ?? "BsR6qa86A1yaN6RXD8vQrLVXDrtdu4ek1eq82Aadjdqf"));
  const lock = locks.find((l) => l.nftMint.equals(nft));
  assert.ok(lock, "Test's lock NFT is in the locker");
  const payer = Keypair.generate().publicKey;
  const pa = poolAccountsFrom(XDEX, pool, TEST);
  for (const ix of [
    initVaultIx(PROGRAM, { payer, mint: TEST, pool: poolKey, creatorNft: nft, burnBps: 2500, lpBps: 2500, publisher: payer, guardian: payer }),
    collectIx(PROGRAM, payer, TEST, []), sellIx(PROGRAM, payer, TEST, pa, 1n), addLiquidityIx(PROGRAM, payer, TEST, pa),
    fundCreatorIx(PROGRAM, payer, TEST, nft, rewardPoolAccountsFrom(XDEX, rewardPool, rp.mint)),
  ]) add(...ix.keys.map((k) => k.pubkey));
  add(poolKey, rp.pool, rp.mint, nft, lock!.address, lockVaultPda(LOCKER, lock!.address), XDEX_CREATE.mainnet.ammConfig, XDEX_CREATE.mainnet.createPoolFee);
  // Every Test token account, its owner, and every lock of the pool.
  const tokenAccounts = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: TEST.toBase58() } }] });
  for (const a of tokenAccounts) { add(a.pubkey, new PublicKey(a.account.data.subarray(32, 64))); }
  for (const l of locks) add(l.address, l.nftMint);
  // Keep only accounts that exist on mainnet, minus programs (cloned as programs) and builtins.
  const builtins = new Set(["11111111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    TOKEN_2022_PROGRAM_ID.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "So11111111111111111111111111111111111111112",
    "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", XDEX.toBase58(), LOCKER.toBase58(), PROGRAM.toBase58(), TEST.toBase58()]);
  const keys = [...clone].filter((k) => !builtins.has(k));
  const exists: string[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k)));
    infos.forEach((inf, j) => { if (inf && !inf.executable) exists.push(keys[i + j]); });
  }
  // Test's mint with the withdraw authority pointed at a local stand-in (TransferFeeConfig, TLV type 1: [config authority, withdraw authority, ...]).
  const standIn = Keypair.generate();
  keyFile(path.join(DIR, "distributor-standin.json"), standIn);
  const mintInfo = (await conn.getAccountInfo(TEST))!;
  const data = Buffer.from(mintInfo.data);
  const realWithdraw = getTransferFeeConfig(unpackMint(TEST, mintInfo, TOKEN_2022_PROGRAM_ID))!.withdrawWithheldAuthority;
  let o = 166, patched = false;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o), len = data.readUInt16LE(o + 2);
    if (type === 1) { assert.ok(data.subarray(o + 4 + 32, o + 4 + 64).equals(realWithdraw.toBuffer())); standIn.publicKey.toBuffer().copy(data, o + 4 + 32); patched = true; break; }
    o += 4 + len;
  }
  assert.ok(patched, "found the TransferFeeConfig extension");
  assert.ok(getTransferFeeConfig(unpackMint(TEST, { ...mintInfo, data }, TOKEN_2022_PROGRAM_ID))!.withdrawWithheldAuthority.equals(standIn.publicKey));
  fs.writeFileSync(path.join(DIR, "accounts", "test-mint.json"), JSON.stringify({
    pubkey: TEST.toBase58(), account: { lamports: mintInfo.lamports, data: [data.toString("base64"), "base64"], owner: mintInfo.owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
  }));
  // Test's launch record, rebuilt from the site's public view (the distributor is the stand-in here).
  const launch = {
    name: token.name, symbol: token.symbol, image: token.image ?? "", description: token.description ?? "", supply: token.supply, poolTokens: token.poolTokens,
    poolXnt: token.poolXnt, taxBps: token.taxBps, autoLpBps: token.autoLpBps, burnBps: token.burnBps, lockDays: token.lockDays ?? null, creator: token.creator,
    mint: TEST.toBase58(), distributor: standIn.publicKey.toBase58(), pool: poolKey.toBase58(), lockNft: nft.toBase58(), createdAt: token.createdAt,
  };
  fs.writeFileSync(path.join(DIR, "test-launch.json"), JSON.stringify(launch, null, 2));
  const authority = Keypair.generate();
  keyFile(path.join(DIR, "upgrade-authority.json"), authority);
  const cmd = ["solana-test-validator --reset --ledger", path.join(DIR, "ledger"), "--rpc-port 9401 --faucet-port 9405 --gossip-port 9403 --dynamic-port-range 9410-9440",
    "--url", MAINNET, "--clone-upgradeable-program", XDEX.toBase58(), "--clone-upgradeable-program", LOCKER.toBase58(),
    "--account", TEST.toBase58(), path.join(DIR, "accounts", "test-mint.json"), ...exists.flatMap((k) => ["--clone", k])].join(" ");
  fs.writeFileSync(path.join(DIR, "validator-cmd.sh"), cmd + "\n");
  console.log(`prepared ${exists.length} accounts to clone (+ XDEX, lp_locker, Test's patched mint); real withdraw authority ${realWithdraw.toBase58().slice(0, 4)}… -> stand-in ${standIn.publicKey.toBase58().slice(0, 4)}…`);
  console.log(`Test: ${tokenAccounts.length} token accounts; locks on the pool: ${locks.length}`);
  console.log(`validator command: ${path.join(DIR, "validator-cmd.sh")}`);
  process.exit(0);
}

// ====================== run (local validator only) ======================
const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9401";
assert.match(RPC, /127\.0\.0\.1|localhost/, "the rehearsal only runs against a local validator");
const SOLANA = process.env.SOLANA_CLI ?? "solana";
const conn = new Connection(RPC, "confirmed");
const PORT = 8141, SITE = `http://127.0.0.1:${PORT}`, IPFS_PORT = 8142, IPFS = `http://127.0.0.1:${IPFS_PORT}`, JWT = "rehearsal-jwt";
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
const xntS = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);

// ONLY_LAUNCH=1 reruns step 6 on the chain a previous run left (its site directory and keys).
const ONLY_LAUNCH = process.env.ONLY_LAUNCH === "1";
if (!ONLY_LAUNCH) console.log("1. Deploy the mainnet build (as on rollout day)");
const authority = loadKey(path.join(DIR, "upgrade-authority.json"));
if (!ONLY_LAUNCH) {
await fund(authority.publicKey, 10);
const before = await conn.getBalance(authority.publicKey);
execFileSync(SOLANA, ["program", "deploy", "--program-id", PROGRAM_KEYPAIR, "--upgrade-authority", path.join(DIR, "upgrade-authority.json"),
  "--keypair", path.join(DIR, "upgrade-authority.json"), "--url", RPC, SO], { stdio: "inherit" });
const spent = before - await conn.getBalance(authority.publicKey);
const dump = path.join(DIR, "dump.so");
execFileSync(SOLANA, ["program", "dump", PROGRAM.toBase58(), dump, "--url", RPC]);
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
assert.equal(sha(dump), sha(SO), "deployed bytes = the mainnet build");
ok(`deployed ${PROGRAM.toBase58().slice(0, 4)}… (sha256 ${sha(SO).slice(0, 8)}…, matches the build); cost ${xntS(spent)} XNT`);
}

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

console.log("2. The mainnet site, vault on (beta), on the local chain");
const work = path.join(DIR, "site");
if (!ONLY_LAUNCH) { fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(path.join(work, "factory", "launches", TEST.toBase58()), { recursive: true }); fs.mkdirSync(path.join(work, "state")); }
const publisher = ONLY_LAUNCH ? loadKey(path.join(work, "publisher.json")) : Keypair.generate(), visitor = Keypair.generate(), newCreator = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [publisher, visitor]) await fund(k.publicKey, 5);
for (const k of [newCreator, ...traders]) await fund(k.publicKey, 200);
const publisherFile = ONLY_LAUNCH ? path.join(work, "publisher.json") : keyFile(path.join(work, "publisher.json"), publisher);
// Test's launch record and stand-in distributor key, then the site registers it as on mainnet.
const testDir = path.join(work, "factory", "launches", TEST.toBase58());
if (!ONLY_LAUNCH) {
  fs.copyFileSync(path.join(DIR, "test-launch.json"), path.join(testDir, "launch.json"));
  fs.copyFileSync(path.join(DIR, "distributor-standin.json"), path.join(testDir, "distributor.json"));
}
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
// A local fee token stands in for USDC.X as the launch fee (the creator can't hold real USDC.X here).
const { createMint, mintTo, getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
const feeMint = await createMint(conn, newCreator, newCreator.publicKey, null, 6);
await mintTo(conn, newCreator, feeMint, (await getOrCreateAssociatedTokenAccount(conn, newCreator, feeMint, newCreator.publicKey)).address, newCreator, 5_000_000);
const cfg = {
  ...base, network: "mainnet", rpcUrl: RPC, mint: "",
  xdex: { ...base.xdex, programId: XDEX.toBase58(), pool: "" }, locker: { ...base.locker, programId: LOCKER.toBase58() },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined, curve: undefined, quoteTokens: undefined,
    launchesPaused: undefined, lockForeverOnly: true, otherNetwork: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "USDC", amount: "1" },
    pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
    taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: publisherFile, mainnet: true, beta: true },
  },
};
delete cfg.creatorReward;
const cfgFile = path.join(work, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
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
const readVault = async (mint: PublicKey): Promise<Vault | null> => { const a = vaultPda(PROGRAM, mint); const i = await conn.getAccountInfo(a, "confirmed"); return i ? decodeVault(a, i.data) : null; };
async function trade(mint: PublicKey, pool: PublicKey, xntEach = 5n) {
  for (const t of traders) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, pool, mint, xntEach * 10n ** 9n, 300)))), [t]);
  for (const t of traders.slice(0, 2)) {
    const bal = (await getAccount(conn, getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const q = await quoteSell(conn, XDEX, pool, mint, bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
    if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, mint, q))), [t]);
  }
}
await startSite();
const info = await api("/api/info");
assert.equal(info.network, "mainnet"); assert.equal(info.taxVault?.launches, true); assert.equal(info.taxVault?.beta, true); assert.equal(info.taxVault?.rewardSymbol, "USDC");
ok("site up as mainnet: vault launches on, beta notice on, creator reward USDC");
if (!ONLY_LAUNCH) {
await api("/api/launch/register", { mint: TEST.toBase58(), creator: JSON.parse(fs.readFileSync(path.join(DIR, "test-launch.json"), "utf8")).creator });
assert.ok(fs.existsSync(path.join(testDir, "config.json")));
ok("Test registered from its rebuilt launch record (per-launch config written by the site)");

console.log("3. Trade Test, then migrate it (scripts/migrate-to-vault.ts)");
const testPool = new PublicKey(JSON.parse(fs.readFileSync(path.join(DIR, "test-launch.json"), "utf8")).pool);
await trade(TEST, testPool); await trade(TEST, testPool);
ok("traders bought and sold Test (tax withheld in their accounts)");
// The USDC.X in the lock NFT's reward vault before the vault takes over (it vests creator rewards).
const testNft = new PublicKey(JSON.parse(fs.readFileSync(path.join(DIR, "test-launch.json"), "utf8")).lockNft);
const usdcVault = async () => (await getAccount(conn, rewardTokensPda(LOCKER, rewardVaultPda(LOCKER, testNft, REWARD_TOKEN.mainnet.mint)), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const usdcBefore = await usdcVault();
const migrate = (extra: string[]) => execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/migrate-to-vault.ts", TEST.toBase58(), ...extra], { env, encoding: "utf8" });
console.log(migrate([]).split("\n").map((l) => `    ${l}`).join("\n"));
console.log(migrate(["--execute"]).split("\n").map((l) => `    ${l}`).join("\n"));
const v0 = (await readVault(TEST))!;
const fee = getTransferFeeConfig(unpackMint(TEST, await conn.getAccountInfo(TEST, "confirmed"), TOKEN_2022_PROGRAM_ID))!;
assert.ok(fee.withdrawWithheldAuthority.equals(vaultAuthPda(PROGRAM, TEST)), "withdraw authority = vault auth PDA");
assert.equal(v0.version, 3); assert.equal(v0.burnBps, 2500); assert.equal(v0.lpBps, 2500);
assert.equal(v0.guardian.toBase58(), JSON.parse(fs.readFileSync(path.join(DIR, "test-launch.json"), "utf8")).creator);
assert.ok(v0.publisher.equals(publisher.publicKey)); assert.ok(v0.rewardMint.equals(REWARD_TOKEN.mainnet.mint), "creator reward token = USDC.X");
ok("Test migrated: tax withdraw authority = the vault, v3, split 25/25, guardian = creator, publisher = the site key, reward = USDC.X");

console.log("4. The site's crank runs Test's vault (restart, as in the runbook)");
await stopSite(); await startSite();
await waitFor("collect, sell, liquidity, USDC.X creator reward", async () => { const v = (await readVault(TEST))!; return v.totalCollected > 0n && v.totalRewardOut > 0n && v.totalLpXnt > 0n; });
const usdcAfter = await usdcVault();
assert.ok(usdcAfter > usdcBefore, "USDC.X reached the creator's reward vault");
ok(`creator reward: +${(Number(usdcAfter - usdcBefore) / 1e6).toFixed(6)} USDC.X into the lock NFT's reward vault`);
await waitFor("a rewards list published with its CID on IPFS", async () => { const v = (await readVault(TEST))!; return (v.listEpoch > 0n || v.pendingEpoch > 0n) && !!cidFromBytes(v.pendingEpoch > 0n ? v.pendingCid : v.listCid); });
const vl = (await readVault(TEST))!;
const cid = cidFromBytes(vl.pendingEpoch > 0n ? vl.pendingCid : vl.listCid)!;
assert.ok(pinned.has(cid), "list file pinned");
const file = JSON.parse(pinned.get(cid)!.toString()) as { entries: [string, string][] };
ok(`list ${vl.pendingEpoch || vl.listEpoch}: ${file.entries.length} wallets, ${cid.slice(0, 12)}…; the 10-minute window runs (mainnet build)`);
await waitFor("holders paid exactly their list amounts", async () => {
  const v = (await readVault(TEST))!;
  if (v.listEpoch === 0n) return false;
  const raw = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: v.address.toBase58() } }] });
  const paid = new Map(raw.map(({ pubkey, account }) => { const r = decodePaidRecord(pubkey, account.data); return [r.wallet.toBase58(), r.paid]; }));
  // Every wallet owed at least the minimum payout was paid its list amount (later lists, which
  // the crank publishes as more tax arrives, only add to it); smaller amounts wait.
  return file.entries.filter(([, c]) => BigInt(c) >= 1_000_000n).every(([w, c]) => (paid.get(w) ?? 0n) >= BigInt(c)) && paid.size > 0;
}, 1_200_000, 15_000);

console.log("5. \"Run the vault now\" from a visitor's wallet");
await trade(TEST, testPool, 20n);
const plan = await api(`/api/vault/${TEST.toBase58()}/crank-tx`, { caller: visitor.publicKey.toBase58() }).catch((e) => ({ error: String(e) }));
if ("txs" in plan) {
  const sigs: string[] = [];
  for (const t of plan.txs as { tx: string; label: string }[]) {
    const tx = Transaction.from(Buffer.from(t.tx, "base64")); tx.partialSign(visitor);
    try { sigs.push((await api("/api/send", { tx: tx.serialize().toString("base64") })).signature); } catch (e) { console.log(`    – ${t.label}: ${String(e).slice(0, 120)}`); }
  }
  const res = await api(`/api/vault/${TEST.toBase58()}/crank-result`, { signatures: sigs });
  ok(`visitor ran ${sigs.length}/${plan.txs.length} step(s); crank reward ${xntS(BigInt(res.crankRewardLamports))} XNT`);
} else ok(`nothing due for a visitor right now (${plan.error.slice(0, 120)})`);

} // end of steps 3-5 (skipped with ONLY_LAUNCH)

console.log("6. A new launch on the vault through the site");
// Mainnet charges the launch fee in real USDC.X: the creator buys some with XNT on the XNT/USDC.X pool, as a real creator would.
{
  const q = await quoteBuy(conn, XDEX, REWARD_TOKEN.mainnet.pool, REWARD_TOKEN.mainnet.mint, 10n * 10n ** 9n, 300);
  await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, newCreator, q))), [newCreator]);
  const bal = (await getAccount(conn, getAssociatedTokenAddressSync(REWARD_TOKEN.mainnet.mint, newCreator.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  ok(`creator bought ${(Number(bal) / 1e6).toFixed(2)} USDC.X for the launch fee`);
}
const params = { name: "Rollout Drill", symbol: "DRILL", image: "", description: "mainnet vault drill", supply: "1000000000", poolTokens: "1000000000", poolXnt: "20",
  taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: newCreator.publicKey.toBase58() };
const { mint } = await step("/api/launch/token", params, newCreator);
await step("/api/launch/pool", { mint, creator: params.creator }, newCreator);
await step("/api/launch/lock", { mint, creator: params.creator }, newCreator);
await step("/api/launch/vault", { mint, creator: params.creator }, newCreator);
await api("/api/launch/register", { mint, creator: params.creator });
const nv = (await readVault(new PublicKey(mint)))!;
assert.equal(nv.version, 3); assert.ok(nv.rewardMint.equals(REWARD_TOKEN.mainnet.mint));
const nfee = getTransferFeeConfig(unpackMint(new PublicKey(mint), await conn.getAccountInfo(new PublicKey(mint), "confirmed"), TOKEN_2022_PROGRAM_ID))!;
assert.ok(nfee.withdrawWithheldAuthority.equals(vaultAuthPda(PROGRAM, new PublicKey(mint))));
ok(`new launch ${mint.slice(0, 4)}… on the vault from creation (withdraw = vault auth, reward USDC.X), lock forever`);
const rec = JSON.parse(fs.readFileSync(path.join(work, "factory", "launches", mint, "launch.json"), "utf8"));
await trade(new PublicKey(mint), new PublicKey(rec.pool), 10n);
await waitFor("the new token's vault cranked (collect, sell, USDC.X reward)", async () => { const v = (await readVault(new PublicKey(mint)))!; return v.totalCollected > 0n && v.totalRewardOut > 0n; });

await stopSite();
console.log("\nMainnet rehearsal passed.");
process.exit(0);
