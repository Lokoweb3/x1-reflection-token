import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, type TransferFeeConfig } from "@solana/spl-token";
import { limitBuySize } from "../src/limit.js";
import { USDC_X } from "../src/peg.js";
import type { Pool, Snapshot } from "../src/xdex.js";

// Maths only: no network, no funds.
const noFee = { transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 } } as unknown as TransferFeeConfig;
/** A GOOGL.X/USDC.X pool (8 and 6 decimals, 0.28% fee) as USDC.X going in sees it. */
function pool(g: number, u: number): Snapshot {
  const p = { address: Keypair.generate().publicKey, mints: [Keypair.generate().publicKey, USDC_X], programs: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID] } as unknown as Pool;
  return { pool: p, side: 1, quoteMint: p.mints[0], reserveToken: BigInt(Math.round(u * 1e6)), reserveQuote: BigInt(Math.round(g * 1e8)),
    tradeFeeRate: 2800n, feeCfg: noFee, epoch: 1n };
}
const d = { tok: 8, quote: 6 }, usdc = (n: number) => BigInt(Math.round(n * 1e6));
const after = (s: Snapshot, r: { amountIn: bigint; out: bigint }) =>
  (Number(s.reserveToken + r.amountIn) / 1e6) / (Number(s.reserveQuote - r.out) / 1e8);

test("above the limit it waits", () => {
  assert.equal(limitBuySize(pool(0.75, 0.75 * 356), d, 300, usdc(38), usdc(38)).action, "wait");
});

test("under the limit it buys only until the pool reaches the limit, never past it", () => {
  const s = pool(0.75, 0.75 * 280);
  const r = limitBuySize(s, d, 300, usdc(1000), usdc(1000));
  assert.equal(r.action, "buy");
  if (r.action !== "buy") return;
  const p = after(s, r);
  assert.ok(p <= 300 && p > 299.99, `pool ends at $${p}`);
  assert.ok(Number(r.amountIn) / Number(r.out) * 100 < 300, "paid under the limit on average");
});

test("a small budget or balance caps the buy", () => {
  const s = pool(0.75, 0.75 * 280);
  const byBudget = limitBuySize(s, d, 300, usdc(2), usdc(38));
  const byBalance = limitBuySize(s, d, 300, usdc(38), usdc(3));
  assert.ok(byBudget.action === "buy" && byBudget.amountIn === usdc(2));
  assert.ok(byBalance.action === "buy" && byBalance.amountIn === usdc(3));
});

test("a spent budget is filled, and an empty wallet doesn't try", () => {
  const s = pool(0.75, 0.75 * 280);
  assert.equal(limitBuySize(s, d, 300, 0n, usdc(38)).action, "filled");
  assert.equal(limitBuySize(s, d, 300, usdc(38), 0n).action, "no funds");
});
