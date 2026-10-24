import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import crypto from "node:crypto";
import {
  PASSES_PROGRAM_ID, evictMinimum, heldBy, holderTokenAccount, passBookPda, passPda, passTablesPda, registerPassEvictIx, removalPlan, type PassBook,
} from "../src/passes.js";
import { ERRORS } from "../src/taxvault.js";
import { vaultPda } from "../src/taxvault.js";

const mint = Keypair.generate().publicKey, caller = Keypair.generate().publicKey;
const vault = vaultPda(PASSES_PROGRAM_ID, mint);
const wallets = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
const book = {
  address: passBookPda(PASSES_PROGRAM_ID, vault), count: wallets.length, minHolding: 100n,
  entries: wallets.map((w, i) => ({ index: i, wallet: w, tokenAccount: Keypair.generate().publicKey, weight: 0n, owed: 0n, paid: 0n })),
} as unknown as PassBook;

test("removal plan: each remove_pass names the pass that is at that index once the earlier ones landed", () => {
  // Remove passes 1, 3 and 5 (of 0–5). Replaying the program's swap-with-last after each:
  // 5 is last (no move); then 3, with 4 moving into slot 3; then 1, with 4 (now last) moving into slot 1.
  const gone = new Set([wallets[1], wallets[3], wallets[5]].map((w) => w.toBase58()));
  const plan = removalPlan(PASSES_PROGRAM_ID, caller, mint, book, gone, true);
  assert.deepEqual(plan.map((p) => p.wallet.toBase58()), [wallets[5], wallets[3], wallets[1]].map((w) => w.toBase58()));
  const keys = plan.map((p) => p.ix.keys.map((k) => k.pubkey.toBase58()));
  // Accounts: caller, vault, book, pass, wallet, token account, moved pass (or the program: none), tables.
  assert.equal(keys[0][3], passPda(PASSES_PROGRAM_ID, vault, wallets[5]).toBase58());
  assert.equal(keys[0][6], PASSES_PROGRAM_ID.toBase58(), "the last pass moves nothing");
  assert.equal(keys[1][6], passPda(PASSES_PROGRAM_ID, vault, wallets[4]).toBase58(), "4 moves into 3's slot");
  assert.equal(keys[2][3], passPda(PASSES_PROGRAM_ID, vault, wallets[1]).toBase58());
  assert.equal(keys[2][6], passPda(PASSES_PROGRAM_ID, vault, wallets[4]).toBase58(), "4 (last again) moves into 1's slot");
  for (const k of keys) assert.equal(k[7], passTablesPda(PASSES_PROGRAM_ID, vault).toBase58());
  // The caller only signs; the pass's rent goes to its wallet.
  assert.ok(plan[0].ix.keys[0].isSigner && !plan[0].ix.keys[0].isWritable);
  assert.ok(plan[0].ix.keys[4].isWritable && plan[0].ix.keys[4].pubkey.equals(wallets[5]));
  // Without a tables record the optional account is the program's ID; max limits the plan.
  const one = removalPlan(PASSES_PROGRAM_ID, caller, mint, book, gone, false, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].ix.keys[7].pubkey.toBase58(), PASSES_PROGRAM_ID.toBase58());
});

test("held balance counts only the wallet's own Token-2022 account of the mint", () => {
  const w = wallets[0];
  const data = Buffer.alloc(170);
  mint.toBuffer().copy(data, 0); w.toBuffer().copy(data, 32); data.writeBigUInt64LE(250n, 64);
  assert.equal(heldBy({ owner: TOKEN_2022_PROGRAM_ID, data }, mint, w), 250n);
  assert.equal(heldBy(null, mint, w), 0n, "no account");
  assert.equal(heldBy({ owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data }, mint, w), 0n, "classic token program");
  assert.equal(heldBy({ owner: TOKEN_2022_PROGRAM_ID, data }, mint, wallets[1]), 0n, "someone else's account");
});

test("register_pass_evict: accounts in the program's order, rent back to the evicted wallet", () => {
  const newcomer = Keypair.generate().publicKey, evicted = book.entries[3];
  const ix = registerPassEvictIx(PASSES_PROGRAM_ID, newcomer, mint, evicted, true);
  assert.ok(ix.data.equals(crypto.createHash("sha256").update("global:register_pass_evict").digest().subarray(0, 8)));
  const keys = ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
  // wallet, vault, book, new pass, its token account, evicted pass, evicted wallet, its token account, system program, tables.
  assert.deepEqual(keys, [
    [newcomer.toBase58(), true, true],
    [vault.toBase58(), false, false],
    [passBookPda(PASSES_PROGRAM_ID, vault).toBase58(), false, true],
    [passPda(PASSES_PROGRAM_ID, vault, newcomer).toBase58(), false, true],
    [holderTokenAccount(newcomer, mint).toBase58(), false, false],
    [passPda(PASSES_PROGRAM_ID, vault, evicted.wallet).toBase58(), false, true],
    [evicted.wallet.toBase58(), false, true],
    [evicted.tokenAccount.toBase58(), false, false],
    ["11111111111111111111111111111111", false, false],
    [passTablesPda(PASSES_PROGRAM_ID, vault).toBase58(), false, true],
  ]);
  // No tables record: the optional account is the program's own ID.
  assert.equal(registerPassEvictIx(PASSES_PROGRAM_ID, newcomer, mint, evicted, false).keys[9].pubkey.toBase58(), PASSES_PROGRAM_ID.toBase58());
  // Twice the evicted balance, and never under the registering minimum (twice min_holding).
  assert.equal(evictMinimum(100n, 5_000n), 10_000n);
  assert.equal(evictMinimum(100n, 0n), 200n);
  // The new program errors follow the ones the clients already name.
  assert.deepEqual([ERRORS.indexOf("HadList"), ERRORS.indexOf("PassBookNotFull"), ERRORS.indexOf("EvictTooSmall")].map((i) => 6000 + i), [6046, 6047, 6048]);
});
