import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { bestTrip, gapPct, roundTrip, type Leg, type Route } from "../src/arb.js";

const fee = (bps: number) => ({
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 2n ** 64n - 1n, transferFeeBasisPoints: bps },
  newerTransferFee: { epoch: 0n, maximumFee: 2n ** 64n - 1n, transferFeeBasisPoints: bps },
});
const E = 10n ** 9n;
/** A pool holding `token` whole tokens against `quote` whole quote tokens, 0.28% trade fee. */
const leg = (token: bigint, quote: bigint, taxBps: number): Leg => ({ reserveToken: token * E, reserveQuote: quote * E, tradeFeeRate: 2800n, feeCfg: fee(taxBps), epoch: 1n });

// A 5% tax token at 0.000004 XNT; Q is worth 4 XNT and has no transfer fee.
const route = (sideQuote: bigint): Route => ({
  main: leg(300_000_000n, 1_200n, 500),
  side: leg(100_000_000n, sideQuote, 500),
  quote: leg(1_000n, 4_000n, 0),
});

test("pools in line: the gap is 0 and a round trip costs about 10.5% (the tax twice, three pool fees)", () => {
  const r = route(100n); // 100 Q = 400 XNT for 100M tokens: 0.000004, the main pool's price
  assert.ok(Math.abs(gapPct(r)) < 1e-9);
  for (const dir of ["buy-side", "buy-main"] as const) {
    const back = Number(roundTrip(r, E, dir)) / 1e9;
    assert.ok(back > 0.89 && back < 0.9, `${dir}: ${back}`);
  }
  assert.ok(bestTrip(r).profit < 0n);
});

test("a gap smaller than the round-trip cost doesn't pay", () => {
  const r = route(92n); // side pool 8% cheaper
  assert.ok(Math.abs(gapPct(r) + 8) < 1e-6);
  assert.ok(bestTrip(r).profit < 0n);
});

test("a side pool 20% cheaper pays in the buy-there, sell-on-main direction, at a bounded size", () => {
  const r = route(80n);
  const b = bestTrip(r);
  assert.equal(b.dir, "buy-side");
  assert.ok(b.profit > 0n, `profit ${b.profit}`);
  // Too large a trip closes the gap and loses: the best size is in between.
  assert.ok(roundTrip(r, 500n * E, "buy-side") < 500n * E);
  // And 20% dearer pays the other way.
  assert.equal(bestTrip(route(125n)).dir, "buy-main");
  assert.ok(bestTrip(route(125n)).profit > 0n);
});
