/**
 * End-to-end test of holder passes against a LOCAL validator running the built
 * lp_locker program (nothing touches testnet or mainnet):
 *
 *   solana-test-validator --reset --ledger test-ledger \
 *     --bpf-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C lp-locker/target/holderpass/lp_locker.so
 *   npx tsx scripts/local-holder-pass-test.ts
 */
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, getMintLen,
} from "@solana/spl-token";
import { buildMintPass, buildTree, claimPassIx, initHolderPoolIx, readHolderPool, setRootIx, passPda } from "../src/holder-pass.js";

const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8899", "confirmed");
const programId = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");

async function fund(k: Keypair, sol = 10) {
  const sig = await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}
const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-600)}`);
    console.log(`  ✓ rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));

const distributor = Keypair.generate(), stranger = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate();
await Promise.all([distributor, stranger, alice, bob].map((k) => fund(k)));

// A 5% tax token whose withheld-tax withdraw authority is the distributor.
const mint = Keypair.generate();
const len = getMintLen([ExtensionType.TransferFeeConfig]);
await send([
  SystemProgram.createAccount({ fromPubkey: distributor.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeTransferFeeConfigInstruction(mint.publicKey, null, distributor.publicKey, 500, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint.publicKey, 9, distributor.publicKey, null, TOKEN_2022_PROGRAM_ID),
], [distributor, mint]);
console.log("token", mint.publicKey.toBase58());

// Only the token's distributor can create its pool.
await fails("stranger creates the pool", send([initHolderPoolIx(programId, stranger.publicKey, mint.publicKey)], [stranger]), /NotTokenDistributor|not this token's distributor/);
await send([initHolderPoolIx(programId, distributor.publicKey, mint.publicKey)], [distributor]);
console.log("  ✓ pool created by the distributor");

// Two holders mint passes.
const mintPass = async (owner: Keypair) => {
  const { ixs, signers, passMint } = await buildMintPass(conn, programId, owner.publicKey, mint.publicKey, "TEST");
  await send(ixs, [owner, ...signers]);
  return passMint;
};
const passA = await mintPass(alice), passB = await mintPass(bob);
const acct = await conn.getAccountInfo(passPda(programId, passA), "confirmed");
assert.ok(acct, "pass account exists");
console.log("  ✓ passes minted", passA.toBase58().slice(0, 6), passB.toBase58().slice(0, 6));

// Epoch 1: Alice 0.3, Bob 0.1 (in lamports). set_root funds the pool with the total.
const e1: Record<string, bigint> = { [passA.toBase58()]: 300_000_000n, [passB.toBase58()]: 100_000_000n };
const t1 = buildTree(e1);
await fails("stranger posts a root", send([setRootIx(programId, stranger.publicKey, mint.publicKey, t1.root, 1n, 400_000_000n)], [stranger]), /NotTokenDistributor|ConstraintHasOne|has one|2001/i);
const poolBefore = (await readHolderPool(conn, programId, mint.publicKey))!;
await send([setRootIx(programId, distributor.publicKey, mint.publicKey, t1.root, 1n, 400_000_000n)], [distributor]);
let pool = (await readHolderPool(conn, programId, mint.publicKey))!;
assert.equal(pool.epoch, 1n); assert.equal(pool.totalFunded, 400_000_000n);
assert.equal(pool.lamports - poolBefore.lamports, 400_000_000n);
console.log("  ✓ root 1 posted, pool funded with 0.4");
await fails("replay of epoch 1", send([setRootIx(programId, distributor.publicKey, mint.publicKey, t1.root, 1n, 400_000_000n)], [distributor]), /StaleEpoch|Epoch must increase/);

// Claims.
await fails("Alice claims too much", send([claimPassIx(programId, alice.publicKey, mint.publicKey, passA, 300_000_001n, t1.proofs[passA.toBase58()])], [alice]), /BadProof|proof/);
await fails("Bob claims with Alice's pass", send([claimPassIx(programId, bob.publicKey, mint.publicKey, passA, 300_000_000n, t1.proofs[passA.toBase58()])], [bob]), /AccountNotInitialized|ConstraintTokenOwner|NotPassHolder|3012|2015/);
const a0 = await bal(alice.publicKey);
await send([claimPassIx(programId, alice.publicKey, mint.publicKey, passA, 300_000_000n, t1.proofs[passA.toBase58()])], [alice]);
const a1 = await bal(alice.publicKey);
assert.ok(a1 - a0 > 299_990_000n && a1 - a0 <= 300_000_000n, `Alice got ${a1 - a0}`); // minus her tx fee
console.log(`  ✓ Alice claimed ${(Number(a1 - a0) / 1e9).toFixed(6)} (0.3 minus her network fee)`);
await fails("Alice claims twice", send([claimPassIx(programId, alice.publicKey, mint.publicKey, passA, 300_000_000n, t1.proofs[passA.toBase58()])], [alice]), /NothingToClaim|Nothing/);

// Epoch 2: Alice +0.05 (cumulative 0.35), Bob unchanged; pool gets only the 0.05 difference.
const e2 = { ...e1, [passA.toBase58()]: 350_000_000n };
const t2 = buildTree(e2);
const p2 = (await readHolderPool(conn, programId, mint.publicKey))!;
await send([setRootIx(programId, distributor.publicKey, mint.publicKey, t2.root, 2n, 450_000_000n)], [distributor]);
pool = (await readHolderPool(conn, programId, mint.publicKey))!;
assert.equal(pool.lamports - p2.lamports, 50_000_000n);
console.log("  ✓ root 2 posted, pool topped up by only the new 0.05");
await fails("old root's proof after update", send([claimPassIx(programId, bob.publicKey, mint.publicKey, passB, 100_000_000n, t1.proofs[passB.toBase58()])], [bob]), /BadProof|proof/);
const b0 = await bal(bob.publicKey);
await send([claimPassIx(programId, bob.publicKey, mint.publicKey, passB, 100_000_000n, t2.proofs[passB.toBase58()])], [bob]);
const a2 = await bal(alice.publicKey);
await send([claimPassIx(programId, alice.publicKey, mint.publicKey, passA, 350_000_000n, t2.proofs[passA.toBase58()])], [alice]);
console.log(`  ✓ Bob claimed ${(Number((await bal(bob.publicKey)) - b0) / 1e9).toFixed(6)}; Alice claimed the extra ${(Number((await bal(alice.publicKey)) - a2) / 1e9).toFixed(6)}`);
pool = (await readHolderPool(conn, programId, mint.publicKey))!;
assert.equal(pool.totalClaimed, 450_000_000n);
const rent = BigInt(await conn.getMinimumBalanceForRentExemption(137));
assert.equal(pool.lamports, rent, "pool is back to just its rent after everything was claimed");
await fails("rewards decrease", send([setRootIx(programId, distributor.publicKey, mint.publicKey, t2.root, 3n, 1n)], [distributor]), /RewardsDecreased|can't go down/);
console.log("\nAll holder-pass checks passed.");
