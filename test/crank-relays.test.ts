/** "Run the vault now" relays are matched to their token by what the transaction does. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { crankRelayBook, planIdentity } from "../src/factory/crank-relays.js";

const payer = Keypair.generate();
const BLOCKHASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const VAULT_PROGRAM = Keypair.generate().publicKey;
/** A vault step for `mint`, as unsignedTx serializes it for the wallet. */
function plan(mint: PublicKey, data = "collect", extra: TransactionInstruction[] = []) {
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...extra,
    new TransactionInstruction({ programId: VAULT_PROGRAM, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: true }], data: Buffer.from(data) }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
/** What the wallet hands back: the same transaction, signed. */
function signed(b64: string) {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(payer);
  return tx.serialize().toString("base64");
}

test("two tokens' plans with the same payer and blockhash stay apart", () => {
  const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
  const book = crankRelayBook();
  const ta = plan(new PublicKey(a)), tb = plan(new PublicKey(b));
  book.planned(ta, a);
  book.planned(tb, b); // used to overwrite a's: the same payer and blockhash
  book.relayed(signed(ta), "sig-a");
  book.relayed(signed(tb), "sig-b");
  assert.deepEqual(book.take(["sig-a", "sig-b"], a), ["sig-a"]);
  assert.deepEqual(book.take(["sig-a", "sig-b"], b), ["sig-b"]);
  assert.deepEqual(book.take(["sig-a"], a), [], "each is looked up once");
});

test("an unrelated transaction with the same payer and blockhash doesn't pass for a plan", () => {
  const a = Keypair.generate().publicKey;
  const book = crankRelayBook();
  book.planned(plan(a), a.toBase58());
  const other = new Transaction({ feePayer: payer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 })
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: a, lamports: 1 }));
  other.sign(payer);
  book.relayed(other.serialize().toString("base64"), "sig");
  assert.deepEqual(book.take(["sig"], a.toBase58()), []);
  book.relayed(signed(plan(a, "something else")), "sig2");
  assert.deepEqual(book.take(["sig2"], a.toBase58()), [], "another instruction for the same token");
});

test("a wallet's own additions (priority fee, Lighthouse guard) still match the plan", () => {
  const a = Keypair.generate().publicKey;
  const book = crankRelayBook();
  book.planned(plan(a), a.toBase58());
  const guard = new TransactionInstruction({ programId: new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), keys: [], data: Buffer.from([1]) });
  book.relayed(signed(plan(a, "collect", [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }), guard])), "sig");
  assert.deepEqual(book.take(["sig"], a.toBase58()), ["sig"]);
});

test("the identity survives signing and reads both transaction formats; junk has none", () => {
  const b64 = plan(Keypair.generate().publicKey);
  assert.equal(planIdentity(b64), planIdentity(signed(b64)));
  const legacy = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  assert.equal(planIdentity(Buffer.from(legacy.serialize()).toString("base64")), planIdentity(b64));
  assert.equal(planIdentity("AA=="), null);
});

test("old plans and relays are dropped", (t) => {
  const a = Keypair.generate().publicKey, book = crankRelayBook(), b64 = plan(a), now = Date.now();
  book.planned(b64, a.toBase58());
  book.relayed(signed(b64), "kept");
  t.mock.method(Date, "now", () => now + 601_000);
  book.prune();
  assert.deepEqual(book.take(["kept"], a.toBase58()), []);
  book.relayed(signed(b64), "late");
  assert.deepEqual(book.take(["late"], a.toBase58()), []);
});
