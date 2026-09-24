/**
 * Distributor side of holder passes (src/claims.ts) against a LOCAL validator running the
 * built lp_locker program. Uses a throwaway state directory. See local-holder-pass-test.ts
 * for how to start the validator.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, getMintLen } from "@solana/spl-token";

process.env.REFLECT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claims-state-"));
const { loadState, addOwed, saveState } = await import("../src/state.js");
const { publishRoot, reconcileRoot, PASS } = await import("../src/claims.js");
const { buildMintPass, buildTree, claimPassIx, readHolderPool } = await import("../src/holder-pass.js");

const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8899", "confirmed");
const programId = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const send = (ixs: TransactionInstruction[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const fund = async (k: Keypair) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");

const distributor = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate();
await Promise.all([distributor, alice, bob].map(fund));
const mint = Keypair.generate();
const len = getMintLen([ExtensionType.TransferFeeConfig]);
await send([
  SystemProgram.createAccount({ fromPubkey: distributor.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
  createInitializeTransferFeeConfigInstruction(mint.publicKey, null, distributor.publicKey, 500, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
  createInitializeMintInstruction(mint.publicKey, 9, distributor.publicKey, null, TOKEN_2022_PROGRAM_ID),
], [distributor, mint]);

const cfg = { locker: { programId: programId.toBase58() }, distribution: { holderRewards: "claims", priorityMicroLamports: 0 } } as any;
const ctx = { cfg, conn, mint: mint.publicKey, distributor, execute: true };
const mintPass = async (owner: Keypair) => {
  const { ixs, signers, passMint } = await buildMintPass(conn, programId, owner.publicKey, mint.publicKey, "TEST");
  await send(ixs, [owner, ...signers]);
  return passMint.toBase58();
};

// The pool is created by the first publish; passes need it, so publish an empty cycle first.
let s = loadState(mint.publicKey.toBase58());
await publishRoot(ctx, s);
assert.ok(await readHolderPool(conn, programId, mint.publicKey), "pool created on first publish");
console.log("  ✓ first cycle created the pool (nothing to publish yet)");
const A = await mintPass(alice), B = await mintPass(bob);

// 1. Rewards credited to passes are published in one root.
addOwed(s, PASS + A, 200_000_000n); addOwed(s, PASS + B, 100_000_000n); saveState(s);
await publishRoot(ctx, s);
s = loadState(mint.publicKey.toBase58());
let pool = (await readHolderPool(conn, programId, mint.publicKey))!;
assert.equal(pool.totalFunded, 300_000_000n); assert.equal(pool.epoch, 1n);
assert.deepEqual(s.claims!.cumulative, { [A]: "200000000", [B]: "100000000" });
assert.equal(Object.keys(s.owed).length, 0, "pass rewards cleared from owed once published");
assert.equal(s.claims!.pending, null);
console.log("  ✓ root 1 published: pool funded 0.3, state totals saved, owed cleared");

// 2. A claim with a proof rebuilt from saved state (what the site does).
const claim = async (who: Keypair, pass: string) => {
  const cum = loadState(mint.publicKey.toBase58()).claims!.cumulative;
  const { proofs } = buildTree(cum);
  await send([claimPassIx(programId, who.publicKey, mint.publicKey, new PublicKey(pass), BigInt(cum[pass]), proofs[pass])], [who]);
};
const a0 = await conn.getBalance(alice.publicKey);
await claim(alice, A);
assert.ok((await conn.getBalance(alice.publicKey)) - a0 > 199_990_000);
console.log("  ✓ Alice claimed her 0.2 with a proof from saved state");

// 3. Crash after the root landed but before state recorded it: reconcile settles it once.
addOwed(s, PASS + A, 50_000_000n); saveState(s);
const before = JSON.parse(JSON.stringify(s));
await publishRoot(ctx, s);
const after = loadState(mint.publicKey.toBase58());
const landed = after.history.at(-1)!;
pool = (await readHolderPool(conn, programId, mint.publicKey))!;
// Rewind state to "journaled but not settled".
const crashed = { ...before, claims: { ...before.claims, pending: {
  epoch: pool.epoch.toString(), root: pool.root.toString("hex"), cumulative: after.claims!.cumulative, delta: { [A]: "50000000" },
  total: pool.totalFunded.toString(), signature: landed.signature!, lastValidBlockHeight: 0, createdAt: new Date().toISOString(),
} } };
saveState(crashed);
let r = loadState(mint.publicKey.toBase58());
assert.equal(await reconcileRoot(ctx, r), "done");
r = loadState(mint.publicKey.toBase58());
assert.equal(r.claims!.pending, null); assert.equal(r.owed[PASS + A], undefined);
assert.equal(r.claims!.cumulative[A], "250000000");
const funded = (await readHolderPool(conn, programId, mint.publicKey))!.totalFunded;
await publishRoot(ctx, r); // nothing left to publish: must not fund again
assert.equal((await readHolderPool(conn, programId, mint.publicKey))!.totalFunded, funded);
console.log("  ✓ crash after send: reconciled from the chain, not funded twice");

// 4. A root that never landed and expired is dropped, then rebuilt and sent.
addOwed(r, PASS + B, 30_000_000n);
r.claims!.pending = { epoch: "99", root: "00".repeat(32), cumulative: {}, delta: {}, total: "0",
  signature: "5".repeat(88), lastValidBlockHeight: 1, createdAt: new Date().toISOString() };
saveState(r);
assert.equal(await reconcileRoot(ctx, loadState(mint.publicKey.toBase58())), "done");
r = loadState(mint.publicKey.toBase58());
assert.equal(r.claims!.pending, null);
await publishRoot(ctx, r);
r = loadState(mint.publicKey.toBase58());
assert.equal(r.claims!.cumulative[B], "130000000");
assert.equal((await readHolderPool(conn, programId, mint.publicKey))!.totalFunded, 380_000_000n);
await claim(bob, B);
console.log("  ✓ expired root dropped and re-sent; Bob claimed 0.13");
console.log("\nAll distributor claims checks passed.");
