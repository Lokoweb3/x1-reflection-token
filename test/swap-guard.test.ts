import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  AuthorityType, NATIVE_MINT, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSetAuthorityInstruction, createSyncNativeInstruction, createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { JUPITER_V6, checkSwapEffect, checkSwapInstructions } from "../src/swap-guard.js";

// Pure checks only: no network, no funds.
const owner = Keypair.generate().publicKey, other = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
const outAta = getAssociatedTokenAddressSync(mint, owner);
const w = { owner, wsolAta };
const jupiter = new TransactionInstruction({ programId: JUPITER_V6, keys: [{ pubkey: owner, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });

test("a plain Jupiter swap (SOL in, wrapped and unwrapped) passes", () => {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: 1_000_000 }), createSyncNativeInstruction(wsolAta),
    createAssociatedTokenAccountIdempotentInstruction(owner, outAta, owner, mint), jupiter, createCloseAccountInstruction(wsolAta, owner, owner)];
  assert.deepEqual(checkSwapInstructions(ixs, w), []);
});

test("approvals, authority changes, closes and SOL transfers to anyone else are refused", () => {
  const cases = [
    createApproveInstruction(outAta, other, owner, 1n),
    createSetAuthorityInstruction(outAta, owner, AuthorityType.AccountOwner, other),
    createCloseAccountInstruction(wsolAta, other, owner),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: other, lamports: 1 }),
    createTransferInstruction(outAta, other, owner, 1n),
    createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(mint, other), other, mint),
    new TransactionInstruction({ programId: other, keys: [], data: Buffer.alloc(0) }),
  ];
  for (const ix of cases) assert.equal(checkSwapInstructions([jupiter, ix], w).length, 1, ix.programId.toBase58());
});

test("an approval or authority change to Jupiter itself is allowed", () => {
  assert.deepEqual(checkSwapInstructions([createApproveInstruction(outAta, JUPITER_V6, owner, 1n)], w), []);
  assert.deepEqual(checkSwapInstructions([createSetAuthorityInstruction(outAta, owner, AuthorityType.CloseAccount, JUPITER_V6)], w), []);
});

const base = { amount: 1_000n, minOut: 500n, maxFee: 10_000n, inIsSol: false, outIsSol: false, inDebit: 1_000n, outCredit: 500n, solDelta: -10_000n };
test("the effect must spend at most the amount, deliver the minimum and cost at most the fee", () => {
  assert.deepEqual(checkSwapEffect(base), []);
  assert.equal(checkSwapEffect({ ...base, inDebit: 1_001n }).length, 1);
  assert.equal(checkSwapEffect({ ...base, outCredit: 499n }).length, 1);
  assert.equal(checkSwapEffect({ ...base, solDelta: -10_001n }).length, 1);
});

test("SOL legs are judged on the wallet's lamports", () => {
  const solIn = { ...base, inIsSol: true, inDebit: 0n };
  assert.deepEqual(checkSwapEffect({ ...solIn, solDelta: -11_000n }), []);
  assert.equal(checkSwapEffect({ ...solIn, solDelta: -11_001n }).length, 1);
  const solOut = { ...base, outIsSol: true, outCredit: 0n };
  assert.deepEqual(checkSwapEffect({ ...solOut, solDelta: 500n - 10_000n }), []);
  assert.equal(checkSwapEffect({ ...solOut, solDelta: 499n - 10_000n }).length, 1);
});
