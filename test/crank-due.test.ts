import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { dueFrom } from "../src/vault-crank.js";
import { encodePaidRecord, paidRecordPda, type Vault } from "../src/taxvault.js";

const program = Keypair.generate().publicKey;
const v = { address: Keypair.generate().publicKey, holdersFunded: 10n ** 12n, payoutPool: PublicKey.default } as unknown as Vault;
const [old, fresh, dust] = [0, 1, 2].map(() => Keypair.generate().publicKey);
// `old` already has a paid record (paid 1,000,000); `fresh` and `dust` were never paid.
const conn = {
  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => {
      if (k.equals(paidRecordPda(program, v.address, old))) return { owner: program, data: encodePaidRecord({ vault: v.address, wallet: old, paid: 1_000_000n, bump: 255 }) };
      if ([old, fresh, dust].some((w) => w.equals(k))) return { owner: PublicKey.default, data: Buffer.alloc(0), lamports: 1 }; // wallets exist
      return null;
    });
  },
} as never;

test("a first payment must cover the paid record's rent on top of the minimum", async () => {
  // Totals: old is owed 1,200,000 more, fresh 3,000,000, dust 1,500,000 (over the 1,000,000 minimum, under minimum + rent).
  const wallets = { [old.toBase58()]: "2200000", [fresh.toBase58()]: "3000000", [dust.toBase58()]: "1500000" };
  const base = { fallback: false, minPayout: 1_000_000n, listTotal: 6_700_000n };
  const all = await dueFrom(conn, program, v, wallets, base);
  assert.deepEqual(all.map((d) => d.wallet.toBase58()).sort(), [old, fresh, dust].map((w) => w.toBase58()).sort(), "without the rule: everyone over the minimum");
  const due = await dueFrom(conn, program, v, wallets, { ...base, firstPayoutMin: 1_000_000n + 1_454_640n });
  assert.deepEqual(due.map((d) => [d.wallet.toBase58(), d.owed, d.recordExists]), [
    [fresh.toBase58(), 3_000_000n, false],
    [old.toBase58(), 1_200_000n, true], // a wallet with a record only needs the minimum
  ]);
});
