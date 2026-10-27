/**
 * The audit fixes to graduation and closing (BC-M1, BC-L4), on a LOCAL validator that clones
 * testnet XDEX, its pool config and lp_locker (nothing is sent to testnet or mainnet):
 *
 *   A. graduate_pool + graduate_lock in ONE transaction (the crank's way): size and compute
 *      measured, then every buyer delivered.
 *   B. A pool created on its own and never locked: graduate_burn is refused before
 *      LOCK_AFTER_SECS, then burns the LP; the curve graduates with no lock NFT and delivers.
 *   C. close_curve on a curve with nothing sold: only the creator, deposit and rent back,
 *      and the mint can take a new curve.
 *   D. close_curve with a position emptied by selling: Refunding, the refund returns the
 *      deposit and closes the curve.
 *   E. A full curve that never graduates: the last refund closes the curve.
 *
 *   solana-test-validator --reset --ledger <scratch>/grad-ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY \
 *     --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --bpf-program CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY <build>/bonding_curve.so
 *   LOCAL_RPC=http://127.0.0.1:8999 npx tsx scripts/local-curve-graduate-test.ts
 *
 * The program must be built with `--features "testnet short-windows"` (5 s anti-snipe
 * window, 10 s refund and burn delays, 10 XNT target).
 *
 * NO_LOCKER=1 with a validator started WITHOUT the lp_locker clone runs only the check that
 * graduate_pool refuses to create a pool while lp_locker isn't deployed.
 */
import assert from "node:assert/strict";
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
  FEE_RECEIVER, GRADUATION_DEPOSIT, POSITION_DISC, authPda, buyIx, closeCurveIx, createCurveIx, curvePda, decodeCurve, decodePosition,
  deliverIx, graduateBurnIx, graduateIxs, graduateLockIx, graduatePoolIx, nftMintPda, refundIx, sellIx, type Curve,
} from "../src/curve.js";
import { lockPda } from "../src/locker.js";
import { poolAddresses } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const conn = new Connection(RPC, "confirmed");
const PROGRAM = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const VAULT_PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const SHORT_DELAY_MS = 11_000; // REFUND_AFTER_SECS / LOCK_AFTER_SECS are 10 s in this build
const TARGET_WHOLE = 10n;
const LAMPORTS_PER_SOL_N = BigInt(LAMPORTS_PER_SOL);
const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");

function tx(ixs: TransactionInstruction[], cu?: number) {
  const t = new Transaction();
  if (cu) t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }));
  return t.add(...ixs);
}
const send = (ixs: TransactionInstruction[], signers: Keypair[], cu?: number) =>
  sendAndConfirmTransaction(conn, tx(ixs, cu), signers, { commitment: "confirmed" });
async function stats(sig: string) {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { cu: t?.meta?.computeUnitsConsumed ?? 0, fee: BigInt(t?.meta?.fee ?? 0) };
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
async function findCurve(mint: PublicKey): Promise<Curve | null> {
  const addr = curvePda(PROGRAM, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  return info && info.owner.equals(PROGRAM) ? decodeCurve(addr, info.data) : null;
}
const readCurve = async (mint: PublicKey) => { const c = await findCurve(mint); assert.ok(c, "curve account"); return c; };
async function positionsOf(curve: PublicKey) {
  const raw = await conn.getProgramAccounts(PROGRAM, { commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISC) } }, { memcmp: { offset: 8, bytes: curve.toBase58() } }] });
  return raw.map(({ pubkey, account }) => decodePosition(pubkey, account.data));
}

/** A curve token as the site makes one (tax withdrawable only by the tax vault's auth PDA), and its curve. */
async function newCurve(creator: Keypair, mintKp = Keypair.generate()) {
  const mint = mintKp.publicKey;
  const [name, symbol, uri] = ["Grad Test", "GRAD", "https://example.invalid/grad.json"];
  const metadata: TokenMetadata = { mint, name, symbol, uri, updateAuthority: creator.publicKey, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from("auth"), mint.toBuffer()], VAULT_PROGRAM)[0];
  const c = creator.publicKey;
  const exists = !!(await conn.getAccountInfo(mint, "confirmed"));
  const ixs = exists ? [] : [
    SystemProgram.createAccount({ fromPubkey: c, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, c, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, null, vaultAuth, 500, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 9, c, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: c, mint, mintAuthority: c, name, symbol, uri }),
    createSetAuthorityInstruction(mint, c, AuthorityType.MintTokens, authPda(PROGRAM, mint), [], TOKEN_2022_PROGRAM_ID),
  ];
  await send([...ixs, createCurveIx(PROGRAM, "testnet", c, mint, 1_000_000_000n, TARGET_WHOLE)], exists ? [creator] : [creator, mintKp]);
  return mint;
}
/** Past the 5 s early window, two buys fill the 10 XNT curve. */
async function fill(mint: PublicKey, buyers: Keypair[]) {
  await sleep(6_000);
  await send([buyIx(PROGRAM, buyers[0].publicKey, mint, 3n * LAMPORTS_PER_SOL_N, 0n)], [buyers[0]]);
  await send([buyIx(PROGRAM, buyers[1].publicKey, mint, 20n * LAMPORTS_PER_SOL_N, 0n)], [buyers[1]]);
  const c = await readCurve(mint);
  assert.equal(c.status, 1, "Complete");
  return c;
}
async function deliverAll(c: Curve, crank: Keypair) {
  for (const p of await positionsOf(c.address)) await send([deliverIx(PROGRAM, crank.publicKey, c.mint, p.owner, c.creator)], [crank], 400_000);
  const done = await readCurve(c.mint);
  assert.equal(done.status, 4, "Finished");
  assert.equal(done.delivered, done.curveTokens);
  assert.equal((await getMint(conn, c.mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply, c.supply, "supply == S");
  return done;
}

const creator = Keypair.generate(), crank = Keypair.generate(), other = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate()];
for (const k of [creator, crank, other, ...buyers]) await fund(k.publicKey, 100);
await fund(FEE_RECEIVER, 1);

if (process.env.NO_LOCKER) {
  console.log("graduate_pool without lp_locker deployed");
  assert.equal(await conn.getAccountInfo(LOCKER, "confirmed"), null, "start the validator without the lp_locker clone");
  const mint = await newCurve(creator);
  await fill(mint, buyers);
  await fails("graduate_pool with no lp_locker", send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, mint)], [crank], 1_000_000), /LockerUnavailable/);
  assert.equal((await readCurve(mint)).status, 1, "still Complete: no pool was created");
  assert.equal(await conn.getAccountInfo(poolAddresses(XDEX, AMM_CONFIG, mint).pool, "confirmed"), null, "no XDEX pool");
  console.log("\nThe pool waits for its locker.");
  process.exit(0);
}

console.log("A. Pool and lock in one transaction");
{
  const mint = await newCurve(creator);
  const c = await fill(mint, buyers);
  const ixs = graduateIxs(PROGRAM, "testnet", crank.publicKey, mint, creator.publicKey);
  const t = tx(ixs, 1_000_000);
  t.feePayer = crank.publicKey;
  t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  t.sign(crank);
  const size = t.serialize().length;
  const sig = await conn.sendRawTransaction(t.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  const { cu } = await stats(sig);
  const g = await readCurve(mint);
  assert.equal(g.status, 3, "Graduated in one transaction");
  assert.equal(g.delivered, 0n, "delivered reset for deliver to count from 0");
  const nft = nftMintPda(PROGRAM, c.address);
  assert.ok(g.lockNft.equals(nft));
  assert.ok((await conn.getAccountInfo(lockPda(LOCKER, nft), "confirmed"))?.owner.equals(LOCKER), "lp_locker lock exists");
  ok(`graduate_pool + graduate_lock in one transaction: ${size} bytes (limit 1,232), ${cu} CU (limit set 1,000,000)`);
  await deliverAll(g, crank);
  ok("every buyer delivered, Finished; the curve account stays (the record of its pool and lock)");
}

console.log("B. A pool left without its lock: graduate_burn");
{
  const mint = await newCurve(creator);
  await fill(mint, buyers);
  await send([graduatePoolIx(PROGRAM, "testnet", crank.publicKey, mint)], [crank], 1_000_000);
  const p = await readCurve(mint);
  assert.equal(p.status, 2);
  assert.ok(p.delivered > 0n, "delivered holds the pool's creation time");
  await fails("graduate_burn before LOCK_AFTER_SECS", send([graduateBurnIx(PROGRAM, "testnet", crank.publicKey, mint)], [crank], 200_000), /BurnNotOpen/);
  await sleep(SHORT_DELAY_MS);
  const { lpMint } = poolAddresses(XDEX, AMM_CONFIG, mint);
  const authLp = getAssociatedTokenAddressSync(lpMint, authPda(PROGRAM, mint), true, TOKEN_PROGRAM_ID);
  const lp = (await getAccount(conn, authLp, "confirmed", TOKEN_PROGRAM_ID)).amount;
  const supplyBefore = (await getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID)).supply;
  const crankBefore = await bal(crank.publicKey);
  const sig = await send([graduateBurnIx(PROGRAM, "testnet", crank.publicKey, mint)], [crank], 200_000);
  const { cu, fee } = await stats(sig);
  const g = await readCurve(mint);
  assert.equal(g.status, 3, "Graduated");
  assert.ok(g.lockNft.equals(PublicKey.default), "no lock NFT");
  assert.equal(g.delivered, 0n);
  assert.equal(await conn.getAccountInfo(authLp, "confirmed"), null, "auth's LP account closed");
  assert.equal((await getMint(conn, lpMint, "confirmed", TOKEN_PROGRAM_ID)).supply, supplyBefore - lp, "all of auth's LP burned");
  assert.equal((await bal(crank.publicKey)) - crankBefore + fee, 10_000_000n, "caller got the reward");
  await fails("graduate_lock after the burn", send([graduateLockIx(PROGRAM, "testnet", crank.publicKey, mint, creator.publicKey)], [crank], 1_000_000), /WrongStatus/);
  ok(`LP ${lp} burned (${cu} CU), Graduated with no lock NFT, caller rewarded`);
  await deliverAll(g, crank);
  ok("every buyer delivered after the burn, Finished");
}

console.log("C. close_curve with nothing sold");
{
  const mintKp = Keypair.generate();
  const mint = await newCurve(creator, mintKp);
  const curveRent = BigInt((await conn.getAccountInfo(curvePda(PROGRAM, mint), "confirmed"))!.lamports);
  await fails("close_curve by someone else", send([closeCurveIx(PROGRAM, other.publicKey, mint)], [other]), /WrongAccount|ConstraintAddress/);
  const before = await bal(creator.publicKey);
  const sig = await send([closeCurveIx(PROGRAM, creator.publicKey, mint)], [creator]);
  const { fee } = await stats(sig);
  assert.equal(await findCurve(mint), null, "curve closed");
  assert.equal(await bal(authPda(PROGRAM, mint)), 0n, "auth emptied");
  assert.equal((await bal(creator.publicKey)) - before + fee, GRADUATION_DEPOSIT + curveRent, "deposit and rent back");
  ok(`closed: ${xnt(GRADUATION_DEPOSIT + curveRent)} XNT back to the creator (deposit + curve rent)`);
  await newCurve(creator, mintKp);
  assert.equal((await readCurve(mint)).status, 0);
  ok("the mint (supply 0, mint authority still auth) takes a new curve");
  await sleep(6_000);
  await send([buyIx(PROGRAM, buyers[0].publicKey, mint, LAMPORTS_PER_SOL_N, 0n)], [buyers[0]]);
  await fails("close_curve with tokens sold", send([closeCurveIx(PROGRAM, creator.publicKey, mint)], [creator]), /CurveNotEmpty/);

  console.log("D. close_curve with a position emptied by selling");
  const pos = (await positionsOf(curvePda(PROGRAM, mint)))[0];
  await send([sellIx(PROGRAM, buyers[0].publicKey, mint, pos.balance, 0n)], [buyers[0]]);
  const sold = await readCurve(mint);
  assert.equal(sold.tokensSold, 0n);
  assert.equal(sold.raisedXnt, 0n, "nothing raised once everything is sold back");
  await send([closeCurveIx(PROGRAM, creator.publicKey, mint)], [creator]);
  assert.equal((await readCurve(mint)).status, 5, "Refunding until the empty position is refunded");
  const ownerBefore = await bal(buyers[0].publicKey);
  const creatorBefore = await bal(creator.publicKey);
  await send([refundIx(PROGRAM, crank.publicKey, mint, buyers[0].publicKey, creator.publicKey)], [crank]);
  assert.equal(await findCurve(mint), null, "the last refund closed the curve");
  assert.ok((await bal(buyers[0].publicKey)) - ownerBefore >= pos.deposit, "deposit (and position rent) back");
  assert.ok((await bal(creator.publicKey)) - creatorBefore >= GRADUATION_DEPOSIT, "deposit and curve rent to the creator");
  ok("Refunding, the position's deposit returned, the curve closed");
}

console.log("E. A full curve that never graduates: the last refund closes it");
{
  const mint = await newCurve(creator);
  const c = await fill(mint, buyers);
  await sleep(SHORT_DELAY_MS);
  const positions = await positionsOf(c.address);
  for (const [i, p] of positions.entries()) {
    await send([refundIx(PROGRAM, crank.publicKey, mint, p.owner, creator.publicKey)], [crank]);
    if (i < positions.length - 1) assert.equal((await readCurve(mint)).status, 5);
  }
  assert.equal(await findCurve(mint), null, "curve closed after the last refund");
  assert.equal(await bal(authPda(PROGRAM, mint)), 0n);
  ok(`${positions.length} positions refunded, the curve closed`);
}

console.log("\nAll graduation and close checks passed.");
