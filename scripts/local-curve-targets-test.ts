/**
 * Selectable graduation targets, rehearsed on a LOCAL validator (nothing is sent to testnet
 * or mainnet): the curve program as deployed today (fixed 20 XNT, create_curve(supply))
 * is upgraded in place under a live curve, then:
 *
 *   1. Before the upgrade: an old-style 20 XNT curve is created and partly bought.
 *   2. The program is extended (if the new build is bigger) and upgraded with the
 *      selectable-target build. Old-style create_curve data and targets outside the list
 *      are refused.
 *   3. The old curve is bought to its stored 20 XNT, graduates (the pool gets exactly
 *      20 XNT and opens at the curve's last price), locks its LP and delivers.
 *   4. Through the site (real factory server, its crank signing): /api/info lists the
 *      targets, a create with a target outside the list is refused, a 500 XNT (default)
 *      and a 10,000 XNT curve are created. The 500 one is bought to graduation and the
 *      site's crank creates the pool (exactly 500 XNT, opening at the curve's last price),
 *      locks the LP and delivers every buyer. The 10,000 one gets partial buys; its setup,
 *      prices and views are checked against src/curve.ts.
 *
 * Start the validator (3.1.x) with the CURRENT build loaded upgradeable, on these ports:
 *   solana-keygen new --no-bip39-passphrase -o <scratch>/upgrade-authority.json
 *   solana-test-validator --reset --ledger <scratch>/targets-ledger --rpc-port 9401 --faucet-port 9405 \
 *     --gossip-port 9403 --dynamic-port-range 9410-9440 --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --upgradeable-program CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY lp-locker/target/curve-test/bonding_curve.so <scratch>/upgrade-authority.json
 * then:
 *   LOCAL_RPC=http://127.0.0.1:9401 UPGRADE_AUTHORITY=<scratch>/upgrade-authority.json \
 *     NEW_SO=lp-locker/target/curve2-test/bonding_curve.so SOLANA=<3.1 bin>/solana \
 *     npx tsx scripts/local-curve-targets-test.ts
 * Both builds are `--features "testnet short-windows"` (5 s anti-snipe window on-chain; the
 * site still applies its 2-minute window, so the site part waits it out). The site runs on
 * port 8151. KEEP_DIR=1 keeps the throwaway config/factory/state directory (it holds keys).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMint,
  createSetAuthorityInstruction, getAccount, getAssociatedTokenAddressSync, getMint, getMintLen, mintTo,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import {
  CURVE_BPS, FEE_RECEIVER, POSITION_DISC, applyBuy, authPda, buyIx, createCurveIx, curvePda, curveSetup, decodeCurve, decodePosition,
  deliverIx, graduateLockIx, graduatePoolIx, nftMintPda, quoteBuy, type Curve,
} from "../src/curve.js";
import { lockPda } from "../src/locker.js";
import { poolAddresses } from "../src/xdex.js";
import bs58 from "bs58";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9401";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const AUTHORITY_FILE = process.env.UPGRADE_AUTHORITY!, NEW_SO = process.env.NEW_SO!, SOLANA = process.env.SOLANA ?? "solana";
assert.ok(AUTHORITY_FILE && NEW_SO, "set UPGRADE_AUTHORITY and NEW_SO");
const PROGRAM = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PORT = 8151, SITE = `http://127.0.0.1:${PORT}`;
const XNT = 10n ** 9n;
const TAX_BPS = 500;
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: bigint | number) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

// ---------- helpers ----------
const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
async function send(ixs: TransactionInstruction[], signers: Keypair[], cu?: number) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-1200)}`);
    ok(`rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
async function readCurve(mint: PublicKey): Promise<Curve> {
  const addr = curvePda(PROGRAM, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  assert.ok(info && info.owner.equals(PROGRAM), "curve account");
  return decodeCurve(addr, info.data);
}
async function positionsOf(curve: PublicKey) {
  const raw = await conn.getProgramAccounts(PROGRAM, { commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISC) } }, { memcmp: { offset: 8, bytes: curve.toBase58() } }] });
  return raw.map(({ pubkey, account }) => decodePosition(pubkey, account.data));
}
async function chainTime() {
  return BigInt((await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000));
}
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
/** Program bytes the ProgramData account can hold (its size minus the 45-byte header). */
const programCapacity = async () => (await conn.getAccountInfo(programData, "confirmed"))!.data.length - 45;
function cli(...args: string[]) {
  const r = spawnSync(SOLANA, [...args, "-u", RPC, "-k", AUTHORITY_FILE, "--commitment", "confirmed"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`solana ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}

/** Token-2022 tax token like buildCurveStep: mint authority handed to the curve's auth, nothing minted. */
async function mintIxs(creator: PublicKey, mintKp: Keypair, name: string, symbol: string) {
  const mint = mintKp.publicKey;
  const uri = `https://example.invalid/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name, symbol, uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  return [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, null, Keypair.generate().publicKey, TAX_BPS, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 9, creator, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, mint, mintAuthority: creator, name, symbol, uri }),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, authPda(PROGRAM, mint), [], TOKEN_2022_PROGRAM_ID),
  ];
}
/** The first program's create_curve: data is (supply_whole) only. */
function oldCreateCurveIx(creator: PublicKey, mint: PublicKey, supplyWhole: bigint) {
  const ix = createCurveIx(PROGRAM, creator, mint, supplyWhole, 0n);
  return new TransactionInstruction({ programId: PROGRAM, keys: ix.keys, data: ix.data.subarray(0, 16) });
}

/**
 * The pool XDEX created for `mint`: its XNT and token vault balances, and the price it opens
 * at (XNT per token, the same units as the curve's virtual_xnt / virtual_tokens).
 */
async function poolOf(mint: PublicKey) {
  const pa = poolAddresses(XDEX, AMM_CONFIG, mint);
  const tokenIs0 = pa.mint0.equals(mint);
  const [v0, v1] = await Promise.all([pa.vault0, pa.vault1].map((v, i) =>
    getAccount(conn, v, "confirmed", tokenIs0 === (i === 0) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)));
  const token = tokenIs0 ? v0 : v1, x = tokenIs0 ? v1 : v0;
  return { pool: pa.pool, xnt: x.amount, tokens: token.amount, price: Number(x.amount) / Number(token.amount) };
}
/** Pool checks after graduation: exactly the target in XNT, the net tokens, and the curve's last price. */
async function checkPool(label: string, c: Curve) {
  const p = await poolOf(c.mint);
  assert.ok(c.pool.equals(p.pool), `${label}: curve recorded its pool`);
  assert.equal(p.xnt, c.targetXnt, `${label}: pool got exactly the curve's target`);
  assert.equal(p.tokens, c.poolTokensNet, `${label}: pool token vault got pool_tokens_net`);
  const last = Number(c.virtualXnt) / Number(c.virtualTokens);
  const diff = Math.abs(p.price / last - 1);
  assert.ok(diff < 1e-9, `${label}: pool price ${p.price} vs curve ${last}`);
  ok(`${label}: pool ${p.pool.toBase58().slice(0, 8)}… holds exactly ${xnt(p.xnt)} XNT + ${xnt(p.tokens)} tokens; opens at ${p.price.toExponential(6)} XNT/token = curve's last price (diff ${diff.toExponential(1)})`);
}
/** Lock and delivery checks once a curve is Finished. */
async function checkFinished(label: string, c: Curve, buyers: Keypair[], balances: Map<string, bigint>) {
  assert.equal(c.status, 4, `${label}: Finished`);
  assert.equal(c.positions, 0);
  assert.equal(c.delivered, c.curveTokens);
  const nft = nftMintPda(PROGRAM, c.address);
  assert.ok(c.lockNft.equals(nft));
  const lock = await conn.getAccountInfo(lockPda(LOCKER, nft), "confirmed");
  assert.ok(lock?.owner.equals(LOCKER), `${label}: lp_locker lock exists`);
  assert.ok(new PublicKey(lock!.data.subarray(40, 72)).equals(c.pool), `${label}: lock is for the pool`);
  const nftAcc = await getAccount(conn, getAssociatedTokenAddressSync(nft, c.creator, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(nftAcc.amount, 1n, `${label}: creator holds the lock NFT`);
  const m = await getMint(conn, c.mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m.mintAuthority, null, `${label}: mint authority revoked`);
  assert.equal(m.supply, c.supply, `${label}: supply == S`);
  for (const b of buyers) {
    const want = balances.get(b.publicKey.toBase58()) ?? 0n;
    if (want === 0n) continue;
    const got = (await getAccount(conn, getAssociatedTokenAddressSync(c.mint, b.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    assert.equal(got, want, `${label}: buyer got their curve balance`);
  }
  assert.equal(await bal(authPda(PROGRAM, c.mint)), 0n, `${label}: auth emptied`);
  ok(`${label}: LP locked forever, lock NFT with the creator, ${balances.size} buyers delivered, supply ${xnt(m.supply)} == S, mint authority None, auth empty`);
}

// ---------- wallets ----------
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY_FILE, "utf8"))));
const creator = Keypair.generate(), crank = Keypair.generate(), payer = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
await fund(authority.publicKey, 20);
await Promise.all([creator, crank, payer].map((k) => fund(k.publicKey, 50)));
for (const b of buyers) await fund(b.publicKey, 2_000);
await fund(FEE_RECEIVER, 1); // exists on the real networks; a fresh local ledger needs it to take small fees

console.log("1. Before the upgrade: an old-style 20 XNT curve, partly bought");
const oldCap = await programCapacity();
const oldMintKp = Keypair.generate(), oldMint = oldMintKp.publicKey;
await send([...(await mintIxs(creator.publicKey, oldMintKp, "Old Curve", "OLD")), oldCreateCurveIx(creator.publicKey, oldMint, 1_000_000_000n)], [creator, oldMintKp]);
let old = await readCurve(oldMint);
assert.equal(old.targetXnt, 20n * XNT, "the first program stores 20 XNT");
const oldSetup = curveSetup(1_000_000_000n, TAX_BPS, 20n);
assert.equal(old.virtualXnt, oldSetup.x0, "x0 for 20 XNT, as src/curve.ts computes it");
while ((await chainTime()) < BigInt(old.createdAt + 6)) await sleep(500);
const oldBalances = new Map<string, bigint>();
async function buyDirect(b: Keypair, mint: PublicKey, xntIn: bigint) {
  const c = await readCurve(mint);
  const q = quoteBuy(c, xntIn, Number(await chainTime()) + 1_000);
  await send([buyIx(PROGRAM, b.publicKey, mint, xntIn, q.out)], [b]);
  const after = await readCurve(mint);
  assert.deepEqual([after.virtualXnt, after.tokensSold], [applyBuy(c, q).virtualXnt, applyBuy(c, q).tokensSold], "buy matches the client quote");
  return { q, after };
}
for (const [i, amt] of [[0, 4n], [1, 6n], [2, 3n]] as const) {
  const { q } = await buyDirect(buyers[i], oldMint, amt * XNT);
  oldBalances.set(buyers[i].publicKey.toBase58(), (oldBalances.get(buyers[i].publicKey.toBase58()) ?? 0n) + q.out);
}
old = await readCurve(oldMint);
ok(`old program (${oldCap} bytes of program data): curve ${oldMint.toBase58().slice(0, 8)}… target ${xnt(old.targetXnt)} XNT, raised ${xnt(old.raisedXnt)} by 3 buyers`);

console.log("2. Extend and upgrade the program under it");
const size = fs.statSync(NEW_SO).size;
if (size > oldCap) {
  cli("program", "extend", PROGRAM.toBase58(), String(size - oldCap));
  ok(`extended by ${size - oldCap} bytes (${oldCap} -> ${await programCapacity()})`);
} else ok(`no extend needed (${size} <= ${oldCap})`);
cli("program", "deploy", NEW_SO, "--program-id", PROGRAM.toBase58(), "--upgrade-authority", AUTHORITY_FILE);
const slot = await conn.getSlot("confirmed");
while ((await conn.getSlot("confirmed")) < slot + 2) await sleep(400); // an upgrade takes effect from the next slot
ok(`upgraded to ${path.basename(path.dirname(NEW_SO))}/${path.basename(NEW_SO)} (${size} bytes, capacity ${await programCapacity()})`);
{
  const kp = Keypair.generate();
  await send(await mintIxs(creator.publicKey, kp, "Refused", "NOPE"), [creator, kp]);
  await fails("old-style create_curve (no target)", send([oldCreateCurveIx(creator.publicKey, kp.publicKey, 1_000_000_000n)], [creator]), /InstructionDidNotDeserialize|0x66/);
  for (const t of [0n, 20n, 499n, 501n, 20_000n]) {
    await fails(`create_curve with target ${t} XNT`, send([createCurveIx(PROGRAM, creator.publicKey, kp.publicKey, 1_000_000_000n, t)], [creator]), /BadTarget|0x177d/);
  }
}

console.log("3. The old curve finishes at its stored 20 XNT");
{
  const { q, after } = await buyDirect(buyers[0], oldMint, 30n * XNT);
  assert.ok(q.complete && after.status === 1, "Complete");
  oldBalances.set(buyers[0].publicKey.toBase58(), oldBalances.get(buyers[0].publicKey.toBase58())! + q.out);
  assert.ok(after.raisedXnt <= 20n * XNT && 20n * XNT - after.raisedXnt < 10n, `raised ${after.raisedXnt}`);
  ok(`last buy offered 30 XNT, paid ${xnt(q.xntIn)}; raised ${xnt(after.raisedXnt)} of ${xnt(after.targetXnt)} XNT`);
  await send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, oldMint)], [crank], 1_400_000);
  await checkPool("old 20 XNT curve", await readCurve(oldMint));
  await send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, oldMint, creator.publicKey)], [crank], 1_400_000);
  for (const p of await positionsOf(after.address)) await send([deliverIx(PROGRAM, crank.publicKey, oldMint, p.owner, creator.publicKey)], [crank]);
  await checkFinished("old 20 XNT curve", await readCurve(oldMint), buyers, oldBalances);
}

console.log("4. New curves through the site: 500 XNT (default) and 10,000 XNT");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curve-targets-"));
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
const creatorFee = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, creatorFee, creator.publicKey, feeMint)), [payer]);
await mintTo(conn, payer, feeMint, creatorFee, payer, 5_000_000);
fs.writeFileSync(path.join(dir, "crank.json"), JSON.stringify(Array.from(crank.secretKey)), { mode: 0o600 });
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], pinataJwt: undefined, faucet: undefined, turnstile: undefined, taxVault: undefined,
    quoteTokens: undefined, launchesPaused: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    curve: { programId: PROGRAM.toBase58(), crankKeypair: path.join(dir, "crank.json") },
  },
};
delete cfg.creatorReward;
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = { ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC };
const server = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
const log: string[] = [];
server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
process.on("exit", () => server.kill());
for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const fresh = (p: string) => api(`${p}${p.includes("?") ? "&" : "?"}t=${Date.now()}`);
async function step(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64"), curveMint: body.mint });
  return { ...out, signature };
}

try {
  const info = await api("/api/info");
  assert.deepEqual(info.curve, { targetsXnt: ["500", "1000", "3000", "5000", "10000"], defaultTargetXnt: "500" });
  ok(`/api/info curve: ${JSON.stringify(info.curve)}`);
  const page = await fetch(SITE + "/curve").then((r) => r.text());
  assert.match(page, /Graduates at/);
  const params = { name: "Target Curve", symbol: "TGT", image: "", description: "targets rehearsal", supply: "1000000000", taxBps: TAX_BPS,
    autoLpBps: 2500, burnBps: 2500, creator: creator.publicKey.toBase58() };
  for (const bad of ["20", "499", "20000", "lots"]) {
    await api("/api/curve/create", { ...params, targetXnt: bad }).then(() => assert.fail(`target ${bad} should be refused`),
      (e) => { assert.match(String(e.message), /Graduation target must be 500, 1,000, 3,000, 5,000 or 10,000 XNT/); });
  }
  ok("the site refuses targets 20, 499, 20000 and 'lots' with a clear message");
  const { mint: m500 } = await step("/api/curve/create", params, creator); // no targetXnt: the default
  const { mint: m10k } = await step("/api/curve/create", { ...params, name: "Deep Curve", symbol: "DEEP", targetXnt: "10000" }, creator);
  const [c500, c10k] = await Promise.all([readCurve(new PublicKey(m500)), readCurve(new PublicKey(m10k))]);
  for (const [c, t] of [[c500, 500n], [c10k, 10_000n]] as const) {
    const s = curveSetup(1_000_000_000n, TAX_BPS, t);
    assert.equal(c.targetXnt, t * XNT);
    assert.deepEqual([c.virtualXnt, c.virtualTokens, c.curveTokens, c.poolTokensGross, c.poolTokensNet], [s.x0, s.y0, s.T, s.Pg, s.Pn], `setup for ${t} XNT`);
    assert.equal(c.curveTokens, (c.supply * CURVE_BPS) / 10_000n);
  }
  const rec10k = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", m10k, "launch.json"), "utf8"));
  assert.equal(rec10k.poolXnt, "10000");
  ok(`created ${m500.slice(0, 8)}… (target ${xnt(c500.targetXnt)} XNT, x0 ${xnt(c500.virtualXnt)}) and ${m10k.slice(0, 8)}… (target ${xnt(c10k.targetXnt)} XNT, x0 ${xnt(c10k.virtualXnt)}); both match src/curve.ts`);

  const list = await fresh("/api/curves");
  const byMint = new Map(list.curves.map((c: { mint: string }) => [c.mint, c]));
  assert.equal((byMint.get(oldMint.toBase58()) as { targetXnt: string }).targetXnt, String(20n * XNT), "the old curve shows its own 20 XNT");
  assert.equal((byMint.get(m500) as { targetXnt: string }).targetXnt, String(500n * XNT));
  assert.equal((byMint.get(m10k) as { targetXnt: string }).targetXnt, String(10_000n * XNT));
  assert.deepEqual(list.params.targetsXnt, ["500", "1000", "3000", "5000", "10000"]);
  ok("/api/curves shows each curve's own target (20, 500, 10,000 XNT)");

  console.log("5. Buy the 500 XNT curve to graduation through the site (after the site's 2-minute window)");
  await sleep(125_000);
  const bal500 = new Map<string, bigint>();
  for (const [i, amt] of [[0, "120"], [1, "150"], [2, "100"], [0, "300"]] as const) {
    const r = await step("/api/curve/buy", { wallet: buyers[i].publicKey.toBase58(), mint: m500, xnt: amt }, buyers[i]);
    bal500.set(buyers[i].publicKey.toBase58(), (bal500.get(buyers[i].publicKey.toBase58()) ?? 0n) + BigInt(r.quote.tokensOut));
    ok(`buyer ${i} offered ${amt} XNT: pays ${xnt(BigInt(r.quote.xntIn))}, ${xnt(BigInt(r.quote.tokensOut))} tokens${r.quote.completes ? ", completes the curve" : ""}`);
  }
  const done = await readCurve(new PublicKey(m500));
  assert.ok(done.status >= 1 && done.tokensSold === done.curveTokens, "complete");
  assert.ok(done.raisedXnt <= 500n * XNT && 500n * XNT - done.raisedXnt < 20n, `raised ${done.raisedXnt}`);
  ok(`complete: raised ${xnt(done.raisedXnt)} of 500 XNT`);

  console.log("6. The site's crank graduates it (pool, lock) and delivers");
  const t0 = Date.now();
  let c = done;
  while (Date.now() - t0 < 300_000 && c.status < 4) { await sleep(5_000); c = await readCurve(new PublicKey(m500)); }
  ok(`status ${c.status} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await checkPool("500 XNT curve", c);
  await checkFinished("500 XNT curve", c, buyers, bal500);
  let rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", m500, "launch.json"), "utf8"));
  for (let i = 0; i < 12 && !rec.registeredAt; i++) { await sleep(5_000); rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", m500, "launch.json"), "utf8")); }
  assert.ok(rec.registeredAt, "registered with the distributor");
  assert.equal(rec.poolXnt, "500");
  ok(`registered with the distributor (launch record poolXnt ${rec.poolXnt}, pool ${String(rec.pool).slice(0, 8)}…)`);
  const v500 = await fresh(`/api/curve/${m500}`);
  assert.equal(v500.targetXnt, String(500n * XNT)); assert.equal(v500.status, "finished");

  console.log("7. The 10,000 XNT curve: partial buys, setup and prices");
  let before = await readCurve(new PublicKey(m10k));
  const startPrice = Number(before.virtualXnt) / Number(before.virtualTokens);
  for (const [i, amt] of [[1, "200"], [2, "1500"]] as const) {
    const r = await step("/api/curve/buy", { wallet: buyers[i].publicKey.toBase58(), mint: m10k, xnt: amt }, buyers[i]);
    const after = await readCurve(new PublicKey(m10k));
    assert.equal(after.tokensSold - before.tokensSold, BigInt(r.quote.tokensOut), "the site's quote is what the program gave");
    assert.equal(r.quote.completes, false);
    before = after;
  }
  const v = await fresh(`/api/curve/${m10k}`);
  const s10k = curveSetup(1_000_000_000n, TAX_BPS, 10_000n);
  assert.equal(v.targetXnt, String(10_000n * XNT));
  assert.equal(v.state.x0, String(s10k.x0)); assert.equal(v.state.y0, String(s10k.y0));
  assert.equal(v.raisedXnt, String(before.raisedXnt));
  const openPrice = Number(v.state.targetXnt) / Number(v.state.poolTokensNet);
  const nowPrice = v.priceXnt;
  assert.ok(nowPrice > startPrice && nowPrice < openPrice, "price between the start and the pool's opening price");
  assert.ok(Math.abs(v.progress - Number(before.tokensSold) / Number(before.curveTokens)) < 1e-6);
  // The curve's price at raised r is (x0 + r)^2 / k0; at r = target it is the pool's opening price.
  const k0 = Number(s10k.x0) * Number(s10k.y0), endPrice = (Number(s10k.x0) + 1e13) ** 2 / k0;
  assert.ok(Math.abs(endPrice / openPrice - 1) < 1e-6, "the full curve ends at the pool's opening price");
  ok(`raised ${xnt(BigInt(v.raisedXnt))} of ${xnt(BigInt(v.targetXnt))} XNT (${(v.progress * 100).toFixed(2)}% of the tokens); price ${startPrice.toExponential(4)} -> ${nowPrice.toExponential(4)}, ends at ${openPrice.toExponential(4)} (pool opening); market cap ${xnt(BigInt(v.marketCapXnt))} XNT`);
  const s500 = curveSetup(1_000_000_000n, TAX_BPS, 500n);
  ok(`start prices: 500 XNT ${(Number(s500.x0) / Number(s500.y0)).toExponential(4)}, 10,000 XNT ${startPrice.toExponential(4)} (20x: the curve scales with the target)`);
  console.log("\nAll selectable-target checks passed.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error("--- server log (last 30 lines) ---\n" + log.join("").split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  server.kill();
  if (!process.env.KEEP_DIR) fs.rmSync(dir, { recursive: true, force: true });
}
