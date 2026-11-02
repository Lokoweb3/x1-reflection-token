import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  AuthorityType, NATIVE_MINT, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  ACCOUNT_SIZE, AccountLayout, AccountState as TokenState, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createSetAuthorityInstruction, createSyncNativeInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { JUPITER_V6, checkSwapEffect, checkSwapInstructions, checkWalletAccounts, rentExempt, type AccountState } from "../src/swap-guard.js";

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

test("Jupiter's address is no exception: authority, approvals and lamports handed to it are refused", () => {
  // Nobody can sign for a program's own address, so an authority handed to it is lost, while the amounts still add up.
  const cases = [
    createSetAuthorityInstruction(outAta, owner, AuthorityType.AccountOwner, JUPITER_V6),
    createSetAuthorityInstruction(outAta, owner, AuthorityType.CloseAccount, JUPITER_V6),
    createApproveInstruction(outAta, JUPITER_V6, owner, 1n),
    createCloseAccountInstruction(wsolAta, JUPITER_V6, owner),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: JUPITER_V6, lamports: 1 }),
  ];
  for (const ix of cases) assert.equal(checkSwapInstructions([jupiter, ix], w).length, 1, ix.data.toString("hex"));
  const token22 = createSetAuthorityInstruction(outAta, owner, AuthorityType.AccountOwner, JUPITER_V6, [], TOKEN_2022_PROGRAM_ID);
  assert.equal(checkSwapInstructions([token22], w).length, 1);
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

// checkWalletAccounts: fixtures are real SPL token account layouts. What's modelled is the simulation's returned states.
const RENT = 2_039_280n;
function tokenAcct(tokenOwner: PublicKey, amount: bigint, o: { delegate?: PublicKey; delegated?: bigint; close?: PublicKey; program?: PublicKey; lamports?: bigint } = {}): AccountState {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint, owner: tokenOwner, amount, delegateOption: o.delegate ? 1 : 0, delegate: o.delegate ?? PublicKey.default, state: TokenState.Initialized,
    isNativeOption: 0, isNative: 0n, delegatedAmount: o.delegated ?? 0n, closeAuthorityOption: o.close ? 1 : 0, closeAuthority: o.close ?? PublicKey.default }, data);
  return { lamports: o.lamports ?? RENT, owner: o.program ?? TOKEN_PROGRAM_ID, data };
}
const inAta = getAssociatedTokenAddressSync(Keypair.generate().publicKey, owner);
const wa = { owner, wsolAta, inAta, outAta };
const intermediate = getAssociatedTokenAddressSync(Keypair.generate().publicKey, owner);
const inOk = { address: inAta, pre: tokenAcct(owner, 1_000n), post: tokenAcct(owner, 0n) };
const outOk = { address: outAta, pre: tokenAcct(owner, 0n), post: tokenAcct(owner, 500n) };

test("rent-exempt minimum matches Solana's for a token account", () => {
  assert.equal(rentExempt(ACCOUNT_SIZE), RENT);
  assert.equal(rentExempt(170), 2_074_080n, "Token-2022 with one small extension");
});

test("a multihop that opens a wallet-owned intermediate account: no problems, and its rent is allowed for", () => {
  const r = checkWalletAccounts([inOk, outOk, { address: intermediate, pre: null, post: tokenAcct(owner, 0n) }], wa);
  assert.deepEqual(r.problems, []);
  assert.equal(r.newRent, RENT);
});

test("the output account opened by the swap, an unrelated pool account and the wallet itself earn what they should", () => {
  const pool = Keypair.generate().publicKey;
  const r = checkWalletAccounts([inOk, { address: outAta, pre: null, post: tokenAcct(owner, 500n) }, { address: owner, pre: null, post: null },
    { address: pool, pre: tokenAcct(other, 9n), post: tokenAcct(other, 8n) }], wa);
  assert.deepEqual(r.problems, []);
  assert.equal(r.newRent, RENT);
});

test("rent is allowed only for the wallet's own new token accounts", () => {
  const add = (post: AccountState) => checkWalletAccounts([inOk, outOk, { address: intermediate, pre: null, post }], wa);
  assert.equal(add(tokenAcct(other, 0n)).newRent, 0n, "someone else's token account");
  const notToken = tokenAcct(owner, 0n);
  notToken.owner = other;
  assert.equal(add(notToken).newRent, 0n, "shaped like a wallet token account, but no token program owns it");
  assert.equal(add({ lamports: RENT, owner: SystemProgram.programId, data: Buffer.alloc(0) }).newRent, 0n, "a plain account");
  assert.equal(add(tokenAcct(owner, 0n, { lamports: RENT * 100n })).newRent, RENT, "lamports stuffed into it earn only its rent");
  assert.equal(add(tokenAcct(owner, 0n, { lamports: 5n })).newRent, 5n);
  const t22 = tokenAcct(owner, 0n, { program: TOKEN_2022_PROGRAM_ID });
  assert.equal(add(t22).newRent, RENT, "Token-2022");
  assert.equal(checkWalletAccounts([{ address: wsolAta, pre: null, post: tokenAcct(owner, 0n) }], wa).newRent, 0n, "wSOL's lamports already count as the wallet's");
});

test("an output account handed away is caught, though the amounts all add up", () => {
  const r = checkWalletAccounts([inOk, { address: outAta, pre: tokenAcct(owner, 0n), post: tokenAcct(JUPITER_V6, 500n) }], wa);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /hand the token account/);
  const created = checkWalletAccounts([inOk, { address: outAta, pre: null, post: tokenAcct(other, 500n) }], wa);
  assert.match(created.problems[0], /hand the token account/);
  assert.match(checkWalletAccounts([{ address: inAta, pre: tokenAcct(owner, 1_000n), post: tokenAcct(other, 0n) }], wa).problems[0], /hand the token account/);
  assert.match(checkWalletAccounts([{ address: intermediate, pre: tokenAcct(owner, 7n), post: tokenAcct(other, 7n) }], wa).problems[0], /hand the token account/);
});

test("a new delegate or close authority on any of the wallet's accounts is caught; one it already had isn't", () => {
  assert.match(checkWalletAccounts([{ ...outOk, post: tokenAcct(owner, 500n, { delegate: other, delegated: 5n }) }], wa).problems[0], /spend 5/);
  assert.match(checkWalletAccounts([{ ...outOk, post: tokenAcct(owner, 500n, { delegate: JUPITER_V6, delegated: 1n }) }], wa).problems[0], /spend 1/);
  assert.match(checkWalletAccounts([{ ...outOk, post: tokenAcct(owner, 500n, { close: other }) }], wa).problems[0], /close authority/);
  assert.match(checkWalletAccounts([{ address: intermediate, pre: null, post: tokenAcct(owner, 0n, { delegate: other, delegated: 5n }) }], wa).problems[0], /spend 5/);
  const had = tokenAcct(owner, 0n, { delegate: other, delegated: 5n, close: other });
  assert.deepEqual(checkWalletAccounts([{ address: outAta, pre: had, post: tokenAcct(owner, 500n, { delegate: other, delegated: 5n, close: other }) }], wa).problems, []);
  assert.match(checkWalletAccounts([{ address: outAta, pre: had, post: tokenAcct(owner, 500n, { delegate: other, delegated: 6n, close: other }) }], wa).problems[0], /spend 6/, "a bigger allowance");
});

test("another of the wallet's token accounts can't lose tokens or be closed with tokens in it", () => {
  assert.match(checkWalletAccounts([{ address: intermediate, pre: tokenAcct(owner, 7n), post: tokenAcct(owner, 6n) }], wa).problems[0], /take 1 tokens/);
  assert.deepEqual(checkWalletAccounts([{ address: intermediate, pre: tokenAcct(owner, 7n), post: tokenAcct(owner, 7n) }], wa).problems, []);
  assert.match(checkWalletAccounts([{ address: intermediate, pre: tokenAcct(owner, 7n), post: null }], wa).problems[0], /close/);
  assert.deepEqual(checkWalletAccounts([{ address: intermediate, pre: tokenAcct(owner, 0n), post: null }], wa).problems, [], "an empty one is fine");
  assert.deepEqual(checkWalletAccounts([{ address: wsolAta, pre: tokenAcct(owner, 7n), post: null }], wa).problems, [], "unwrapping");
});

test("an output account that stops being a token account is caught", () => {
  const stolen = tokenAcct(owner, 500n);
  stolen.owner = other;
  assert.match(checkWalletAccounts([{ address: outAta, pre: tokenAcct(owner, 0n), post: stolen }], wa).problems[0], /no longer be a token account/);
});
