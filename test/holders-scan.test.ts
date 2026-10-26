import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { scanTokenAccounts, scanTokenAccountsAt } from "../src/holders.js";

test("the scan reports the slot the RPC read the balances at", async () => {
  const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, address = Keypair.generate().publicKey;
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint, owner, amount: 5_000n, delegateOption: 0, delegate: mint, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: mint }, data);
  const calls: unknown[] = [];
  const conn = { getProgramAccounts: async (program: unknown, config: { withContext?: boolean }) => {
    calls.push(config);
    assert.ok(config.withContext, "the scan must ask for its context slot");
    return { context: { slot: 4242 }, value: [{ pubkey: address, account: { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false } }] };
  } } as unknown as Connection;
  const { slot, rows } = await scanTokenAccountsAt(conn, mint);
  assert.equal(slot, 4242);
  assert.deepEqual(rows.map((r) => [r.address.toBase58(), r.owner, r.amount]), [[address.toBase58(), owner.toBase58(), 5_000n]]);
  assert.equal((await scanTokenAccounts(conn, mint)).length, 1);
});
