import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, type TransferFeeConfig } from "@solana/spl-token";
import { lessSlippage, quoteBuy, quoteSell, slippageOf, soldFor } from "../src/factory/sweep.js";
import { cpmmOut } from "../src/xdex.js";

// Maths on made-up pools (no network).
const fee = (bps: number): TransferFeeConfig => ({
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 2n ** 63n, transferFeeBasisPoints: bps },
  newerTransferFee: { epoch: 0n, maximumFee: 2n ** 63n, transferFeeBasisPoints: bps },
});
const XNT = 1_000_000_000n;

test("selling dust pays its own transfer fee first, then the pool fee, and reports the price impact", () => {
  const pool = { reserveToken: 1_000_000n * XNT, reserveQuote: 1_000n * XNT, tradeFeeRate: 2800n, feeCfg: fee(100), epoch: 1n };
  const q = quoteSell(pool, 1_000n * XNT);
  assert.equal(q.out, cpmmOut(990n * XNT, pool.reserveToken, pool.reserveQuote, 2800n), "1% transfer fee comes off before the swap");
  assert.ok(q.impactPct > 0.28 && q.impactPct < 0.5, `small sale: about the 0.28% pool fee plus a little impact (${q.impactPct})`);
  const big = quoteSell(pool, 500_000n * XNT);
  assert.ok(big.impactPct > 30, "selling half the pool's tokens moves the price a lot");
});

test("buying the target applies its 5% tax on the way out", () => {
  const test = { reserveToken: 177_000_000n * XNT, reserveQuote: 4_670n * XNT, tradeFeeRate: 2800n, feeCfg: fee(500), epoch: 1n };
  const q = quoteBuy(test, XNT);
  assert.equal(q.gross, cpmmOut(XNT, test.reserveQuote, test.reserveToken, 2800n));
  assert.equal(q.tax, (q.gross * 500n + 9_999n) / 10_000n, "Token-2022 rounds the fee up");
  assert.equal(q.received, q.gross - q.tax);
});

test("slippage: minimums and the allowed range", () => {
  assert.equal(lessSlippage(10_000n, 100), 9_900n);
  assert.equal(slippageOf(50), 50);
  assert.equal(slippageOf("abc"), 100, "default 1%");
  assert.equal(slippageOf(5_000), 100, "over 5% isn't allowed");
});

test("what the sells gave is read from the chain: only this wallet's successful transactions, wrapped XNT gained and rent of closed accounts", () => {
  const me = "Me", W = NATIVE_MINT.toBase58();
  const ok = { feePayer: me, err: null, keys: [me, "dust1", "dust2", "wx"], pre: [5_000_000, 2_039_280, 2_074_080, 2_039_280], post: [4_990_000, 0, 0, 2_039_280],
    preTok: [{ owner: me, mint: W, amount: "1000" }], postTok: [{ owner: me, mint: W, amount: "301000" }] };
  const failed = { ...ok, err: { InstructionError: [1, { Custom: 6005 }] } };
  const someoneElse = { ...ok, feePayer: "Other" };
  const r = soldFor(me, [ok, failed, someoneElse]);
  assert.equal(r.wrapped, 300_000n);
  assert.equal(r.rent, 2_039_280n + 2_074_080n, "the payer's own lamports never count as rent");
});
