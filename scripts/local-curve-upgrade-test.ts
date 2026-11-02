/**
 * Upgrading a live bonding_curve, and the new client on the program as deployed, on a LOCAL
 * validator that clones testnet XDEX, its pool config and lp_locker (nothing is sent to testnet
 * or mainnet). Starts the validator with the OLD program as an upgradeable program:
 *
 *   solana-keygen new --no-bip39-passphrase -o <scratch>/local-auth.json
 *   solana-test-validator --reset --ledger <scratch>/up-ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --mint $(solana-keygen pubkey <scratch>/local-auth.json) --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY \
 *     --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --upgradeable-program CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY <old>.so $(solana-keygen pubkey <scratch>/local-auth.json)
 *
 * MODE=upgrade (default): <old>.so is dd221f2 (the source of what testnet runs) built with
 * `--features "testnet short-windows"`. It makes pools the old way, then this upgrades to
 * UPGRADE_SO (the new source, same features; UPGRADE_KEY = the local authority):
 *   A. An old curve whose pool the old program created seconds before the upgrade: graduate_burn
 *      is refused at once, start_burn_clock gives it the full wait, then it burns and delivers.
 *   B. The same kind of pool simply locks after the upgrade, with or without the clock started.
 * Pointed at the unsafe build (1ab9de2) with EXPECT_UNSAFE=1, it shows the burn going through.
 *
 * MODE=deployed: <old>.so is the program dumped from testnet (solana program dump; no short
 * windows, so the first buys wait 2 minutes). The new client against it, before any deploy:
 *   C. Graduation in one transaction, with graduate_pool's extra account, then delivery.
 *   D. The two steps sent apart, as an older client did.
 *   E. close_curve, graduate_burn and start_burn_clock: refused as unknown, nothing changes.
 *
 *   LOCAL_RPC=http://127.0.0.1:8999 UPGRADE_SO=... UPGRADE_KEY=... npx tsx scripts/local-curve-upgrade-test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createSetAuthorityInstruction, getAccount,
  getAssociatedTokenAddressSync, getMint, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import bs58 from "bs58";
import {
  FEE_RECEIVER, POSITION_DISC, authPda, buyIx, closeCurveIx, createCurveIx, curveFromAccount, curvePda, decodePosition,
  deliverIx, graduateBurnIx, graduateIxs, graduateLockIx, graduatePoolIx, startBurnClockIx,
} from "../src/curve.js";
import { poolAddresses } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const MODE = process.env.MODE ?? "upgrade";
const conn = new Connection(RPC, "confirmed");
const PROGRAM = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const VAULT_PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const EARLY_MS = MODE === "deployed" ? 122_000 : 6_000;
const LOCK_AFTER_MS = 11_000; // LOCK_AFTER_SECS is 10 s in the short-windows build
const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
const XNT = BigInt(LAMPORTS_PER_SOL);

const send = (ixs: TransactionInstruction[], signers: Keypair[], cu = 1_000_000) =>
  sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs), signers, { commitment: "confirmed" });
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-1500)}`);
    ok(`rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
async function readCurve(mint: PublicKey) {
  const addr = curvePda(PROGRAM, mint);
  const c = curveFromAccount(PROGRAM, addr, await conn.getAccountInfo(addr, "confirmed"));
  assert.ok(c, "curve account");
  return c;
}
async function deliverAll(mint: PublicKey, crank: Keypair) {
  const c = await readCurve(mint);
  const raw = await conn.getProgramAccounts(PROGRAM, { commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISC) } }, { memcmp: { offset: 8, bytes: c.address.toBase58() } }] });
  const ps = raw.map(({ pubkey, account }) => decodePosition(pubkey, account.data));
  for (const p of ps) await send([deliverIx(PROGRAM, crank.publicKey, mint, p.owner, c.creator)], [crank], 400_000);
  const done = await readCurve(mint);
  assert.equal(done.status, 4, "Finished");
  assert.equal(done.delivered, done.curveTokens);
  for (const p of ps) {
    const ata = getAssociatedTokenAddressSync(mint, p.owner, false, TOKEN_2022_PROGRAM_ID);
    assert.equal((await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, p.balance, "the buyer has their tokens");
  }
  assert.equal((await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply, c.supply);
  return done;
}
async function newCurve(creator: Keypair) {
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const [name, symbol, uri] = ["Upgrade Test", "UPG", "https://example.invalid/u.json"];
  const metadata: TokenMetadata = { mint, name, symbol, uri, updateAuthority: creator.publicKey, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("auth"), mint.toBuffer()], VAULT_PROGRAM)[0];
  const c = creator.publicKey;
  await send([
    SystemProgram.createAccount({ fromPubkey: c, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, c, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, null, vaultAuth, 500, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 9, c, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: c, mint, mintAuthority: c, name, symbol, uri }),
    createSetAuthorityInstruction(mint, c, AuthorityType.MintTokens, authPda(PROGRAM, mint), [], TOKEN_2022_PROGRAM_ID),
    createCurveIx(PROGRAM, "testnet", c, mint, 1_000_000_000n, 10n),
  ], [creator, mintKp], 400_000);
  return mint;
}
async function fill(mint: PublicKey, buyers: Keypair[]) {
  await send([buyIx(PROGRAM, buyers[0].publicKey, mint, 3n * XNT, 0n)], [buyers[0]], 200_000);
  await send([buyIx(PROGRAM, buyers[1].publicKey, mint, 20n * XNT, 0n)], [buyers[1]], 200_000);
  assert.equal((await readCurve(mint)).status, 1, "Complete");
}

const creator = Keypair.generate(), crank = Keypair.generate(), stranger = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate()];
for (const k of [creator, crank, stranger, ...buyers]) await fund(k.publicKey, 200);
await fund(FEE_RECEIVER, 1);

if (MODE === "deployed") {
  console.log("The new client on the program as deployed on testnet");
  const [m1, m2, m3, m4] = [await newCurve(creator), await newCurve(creator), await newCurve(creator), await newCurve(creator)];
  await sleep(EARLY_MS);
  for (const m of [m1, m2, m3]) await fill(m, buyers);
  console.log("C. Graduation in one transaction");
  await send(graduateIxs(PROGRAM, "testnet", crank.publicKey, m1, creator.publicKey), [crank]);
  const c1 = await readCurve(m1);
  assert.equal(c1.status, 3, "Graduated");
  assert.ok(!c1.lockNft.equals(PublicKey.default));
  await deliverAll(m1, crank);
  ok("graduate_pool (with the extra account, which the old program ignores) + graduate_lock in one transaction; every buyer delivered");
  console.log("D. The two steps apart");
  await send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, m2)], [crank]);
  const p2 = await readCurve(m2);
  assert.equal(p2.status, 2);
  assert.equal(p2.delivered, 0n, "the deployed program leaves no pool time");
  await send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, m2, creator.publicKey)], [crank]);
  await deliverAll(m2, crank);
  ok("graduate_pool then graduate_lock; every buyer delivered");
  console.log("E. Instructions the deployed program doesn't have");
  const trading = await readCurve(m4);
  await fails("close_curve on the deployed program", send([closeCurveIx(PROGRAM, creator.publicKey, m4)], [creator]), /InstructionFallbackNotFound|Fallback functions are not supported|0x65/);
  assert.equal((await readCurve(m4)).status, trading.status);
  await send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, m3)], [crank]);
  await fails("graduate_burn on the deployed program", send([graduateBurnIx(PROGRAM, "testnet", crank.publicKey, m3)], [crank]), /InstructionFallbackNotFound|Fallback functions are not supported|0x65/);
  await fails("start_burn_clock on the deployed program", send([startBurnClockIx(PROGRAM, m3)], [crank]), /InstructionFallbackNotFound|Fallback functions are not supported|0x65/);
  assert.equal((await readCurve(m3)).status, 2, "still waiting for its lock");
  await send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, m3, creator.publicKey)], [crank]);
  ok("nothing changed; that pool's lock still works");
  console.log("\nThe new client works on the deployed program.");
  process.exit(0);
}

console.log("Pools made by the old program");
const [mA, mB, mC] = [await newCurve(creator), await newCurve(creator), await newCurve(creator)];
await sleep(EARLY_MS);
for (const m of [mA, mB, mC]) await fill(m, buyers);
// Older than the burn wait by far before their pools exist: the "8-day-old curve".
await sleep(LOCK_AFTER_MS);
for (const m of [mA, mB, mC]) {
  await send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, m)], [crank]);
  const p = await readCurve(m);
  assert.equal(p.status, 2);
  assert.equal(p.delivered, 0n, "the old program leaves no pool time");
}
ok("three curves past the wait by their own age, pools created just now");

console.log("Upgrading the program");
const so = process.env.UPGRADE_SO, key = process.env.UPGRADE_KEY;
assert.ok(so && key, "UPGRADE_SO and UPGRADE_KEY");
const cli = (...a: string[]) => execFileSync("solana", [...a, "--url", RPC, "--keypair", key, "--commitment", "confirmed"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
cli("program", "deploy", so, "--program-id", PROGRAM.toBase58(), "--upgrade-authority", key);
await sleep(1_500); // an upgrade takes effect from the next slot
const before = await readCurve(mA);
assert.equal(before.status, 2, "the accounts read the same after the upgrade");
ok("upgraded");

const { lpMint } = poolAddresses(XDEX, AMM_CONFIG, mA);
const authLp = getAssociatedTokenAddressSync(lpMint, authPda(PROGRAM, mA), true, TOKEN_PROGRAM_ID);
const lp = (await getAccount(conn, authLp, "confirmed", TOKEN_PROGRAM_ID)).amount;

if (process.env.EXPECT_UNSAFE) {
  console.log("The unsafe build: the burn goes through at once");
  await send([graduateBurnIx(PROGRAM, "testnet", stranger.publicKey, mA)], [stranger], 200_000);
  assert.equal((await readCurve(mA)).status, 3);
  assert.equal(await conn.getAccountInfo(authLp, "confirmed"), null);
  ok(`a stranger burned ${lp} LP from a pool seconds old`);
  process.exit(0);
}

console.log("A. An old pool can't burn on its curve's age; it gets the full wait");
await fails("graduate_burn right after the upgrade", send([graduateBurnIx(PROGRAM, "testnet", stranger.publicKey, mA)], [stranger], 200_000), /BurnClockNotStarted/);
assert.equal((await getAccount(conn, authLp, "confirmed", TOKEN_PROGRAM_ID)).amount, lp, "the LP is untouched");
await send([startBurnClockIx(PROGRAM, mA)], [stranger], 50_000);
const started = await readCurve(mA);
assert.ok(started.delivered > 0n, "the wait is on record");
assert.equal(started.status, 2);
await fails("start_burn_clock twice", send([startBurnClockIx(PROGRAM, mA)], [stranger], 50_000), /BurnClockAlreadyStarted/);
assert.equal((await readCurve(mA)).delivered, started.delivered, "can't move the deadline");
await fails("graduate_burn during the wait", send([graduateBurnIx(PROGRAM, "testnet", stranger.publicKey, mA)], [stranger], 200_000), /BurnNotOpen/);
await sleep(LOCK_AFTER_MS);
await send([graduateBurnIx(PROGRAM, "testnet", stranger.publicKey, mA)], [stranger], 200_000);
const burned = await readCurve(mA);
assert.equal(burned.status, 3);
assert.ok(burned.lockNft.equals(PublicKey.default));
await deliverAll(mA, crank);
ok("the wait ran, the LP burned, every buyer has their tokens");

console.log("B. An old pool locks after the upgrade, clock or no clock");
await send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, mB, creator.publicKey)], [crank]);
assert.equal((await readCurve(mB)).status, 3);
await deliverAll(mB, crank);
ok("locked with no clock started; delivered");
await send([startBurnClockIx(PROGRAM, mC)], [stranger], 50_000);
await send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, mC, creator.publicKey)], [crank]);
const g = await readCurve(mC);
assert.equal(g.status, 3);
assert.equal(g.delivered, 0n, "the time is cleared for deliver to count from 0");
await deliverAll(mC, crank);
ok("locked during its wait; delivered");
await fails("start_burn_clock on a graduated curve", send([startBurnClockIx(PROGRAM, mC)], [stranger], 50_000), /WrongStatus/);

console.log("\nThe upgrade leaves old pools safe, and buyers a way to their tokens.");
