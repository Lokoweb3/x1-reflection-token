import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildTree, passLeaf, verifyProof } from "../src/holder-pass.js";

test("leaf hash matches the on-chain program (fixed vector)", () => {
  // Same vector as the Rust test pass_leaf_matches_the_typescript_distributor.
  assert.equal(passLeaf(new PublicKey(Buffer.alloc(32, 7)), 123456789n).toString("hex"),
    "dd70d581440702b8a509ddc24394cf109f0367548330a6c2601b3fe4092d6b5d");
});

test("every pass's proof verifies; wrong amounts and foreign proofs don't", () => {
  for (const n of [1, 2, 3, 7, 16, 33]) {
    const entries: Record<string, bigint> = {};
    for (let i = 0; i < n; i++) entries[Keypair.generate().publicKey.toBase58()] = BigInt(1_000 * (i + 1));
    const { root, proofs } = buildTree(entries);
    for (const [pass, cum] of Object.entries(entries)) {
      const pk = new PublicKey(pass);
      assert.ok(verifyProof(proofs[pass], root, passLeaf(pk, cum)), `n=${n}`);
      assert.ok(!verifyProof(proofs[pass], root, passLeaf(pk, cum + 1n)));
    }
    if (n > 1) {
      const [a, b] = Object.keys(entries);
      assert.ok(!verifyProof(proofs[b], root, passLeaf(new PublicKey(a), entries[a])));
    }
  }
});

test("the root doesn't depend on insertion order", () => {
  const ks = Array.from({ length: 9 }, () => Keypair.generate().publicKey.toBase58());
  const fwd = Object.fromEntries(ks.map((k, i) => [k, BigInt(i + 1)]));
  const rev = Object.fromEntries([...ks].reverse().map((k) => [k, fwd[k]]));
  assert.ok(buildTree(fwd).root.equals(buildTree(rev).root));
});
