import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type TransferFeeConfig } from "@solana/spl-token";
import { createEngine, routesFor, type Route } from "../src/arb-engine.js";
import { roundTrip } from "../src/arb.js";
import type { Pool, Snapshot } from "../src/xdex.js";

// Everything here is maths on made-up pools: no network, no wallet funds (the Connection is never used).
const key = () => Keypair.generate().publicKey;
const X = NATIVE_MINT;
const TEST = key(), Q = key(), Q2 = key();
const EPOCH = 100n;
const XNT = 1_000_000_000n;

/** A Token-2022 transfer fee of `bps` (0 = none). */
const fee = (bps: number): TransferFeeConfig => ({
  transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 2n ** 63n, transferFeeBasisPoints: bps },
  newerTransferFee: { epoch: 0n, maximumFee: 2n ** 63n, transferFeeBasisPoints: bps },
});
/** A pool of `tok` (token side, transfer fee `bps`) against `quote`, at XDEX's 0.28% trade fee. */
function pool(tok: PublicKey, quote: PublicKey, reserveToken: bigint, reserveQuote: bigint, bps = 0): Snapshot {
  const p: Pool = {
    address: key(), ammConfig: key(), vaults: [key(), key()], mints: [tok, quote],
    programs: [bps ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], observation: key(), lpMint: key(),
    lpSupply: 1_000_000n, lpDecimals: 9, depositsPaused: false, protocolFees: [0n, 0n], fundFees: [0n, 0n],
  };
  return { pool: p, side: 0, quoteMint: quote, reserveToken, reserveQuote, tradeFeeRate: 2800n, feeCfg: fee(bps), epoch: EPOCH };
}
function engine(minProfit = 20_000_000n, maxIn = 25n * XNT, slipBps = 10n) {
  return createEngine({ conn: new Connection("http://127.0.0.1:1"), xdex: key(), wallet: Keypair.generate(), minProfit, maxIn, slipBps,
    reserve: XNT / 10n, priority: 1000, stateDir: os.tmpdir(), log: () => {}, alert: async () => {} });
}
/**
 * TEST at 1e-5 XNT in its main pool (1,000 XNT deep); Q worth 5 XNT (Q/XNT 5,000 XNT deep); the TEST/Q side pool
 * prices TEST `gapPct` percent off the main pool. TEST carries a 5% transfer tax; Q `qBps`.
 */
function market(gapPct: number, qBps = 0, sideDepth = 50n) {
  const main = pool(TEST, X, 100_000_000n * XNT, 1_000n * XNT, 500);
  const quote = pool(Q, X, 1_000n * XNT, 5_000n * XNT, qBps);
  // Side pool: `sideDepth` Q against TEST at 1e-5 * (1 + gap) XNT per TEST.
  const testPerQ = (5 / (1e-5 * (1 + gapPct / 100)));
  const side = pool(TEST, Q, BigInt(Math.round(testPerQ * Number(sideDepth))) * XNT, sideDepth * XNT, 500);
  return { main, side, quote };
}
function triangle(m: ReturnType<typeof market>, e: ReturnType<typeof engine>): Route[] {
  e.learnFees([m.main, m.side, m.quote]);
  return routesFor({ mint: TEST, symbol: "TEST", main: m.main, sides: [{ name: "TEST/Q", side: m.side, quote: m.quote, quoteMint: Q }] }, false);
}
const outMint = (h: Route["hops"][number]) => h.snap.pool.mints[h.snap.pool.mints.findIndex((m) => m.equals(h.inMint)) === 0 ? 1 : 0];

test("the engine's pricing equals src/arb.ts's round trip exactly (no slippage margin), with both tokens taxed", () => {
  const e = engine(1n, 25n * XNT, 0n);
  const m = market(-15, 100); // Q has a 1% transfer fee too
  const [buySide, buyMain] = triangle(m, e);
  const r = { main: m.main, side: m.side, quote: m.quote };
  for (const x of [10_000_000n, XNT, 7n * XNT]) {
    assert.equal(e.plan(buySide, x, 1n).xntOut, roundTrip(r, x, "buy-side"));
    assert.equal(e.plan(buyMain, x, 1n).xntOut, roundTrip(r, x, "buy-main"));
  }
});

test("no gap means no profit, and TEST's double 5% tax needs a gap of about 11% before a trip pays", () => {
  const e = engine();
  for (const [gap, pays] of [[0, false], [-8, false], [8, false], [-15, true], [15, true]] as const) {
    const best = triangle(market(gap), e).map((r) => e.best(r, 20_000_000n)).sort((a, b) => Number(b.profit - a.profit))[0];
    assert.equal(best.profit >= 20_000_000n, pays, `gap ${gap}%: best ${best.profit}`);
    if (gap === 0) assert.ok(best.profit < 0n, "a balanced market only costs fees");
  }
});

test("the last swap must return the stake plus the minimum profit (the trade fails as a whole otherwise)", () => {
  const e = engine();
  for (const r of triangle(market(-15), e)) {
    const p = e.plan(r, 3n * XNT, 20_000_000n);
    assert.equal(p.swaps.at(-1)!.minOut, 3n * XNT + 20_000_000n);
  }
});

test("each swap spends exactly the previous swap's minimum, which is its quote less the 0.1% margin", () => {
  const e = engine();
  const p = e.plan(triangle(market(-15), e)[0], 2n * XNT, 20_000_000n);
  assert.equal(p.swaps[0].amountIn, 2n * XNT);
  for (let i = 1; i < p.swaps.length; i++) assert.equal(p.swaps[i].amountIn, p.swaps[i - 1].minOut);
  for (const s of p.swaps.slice(0, -1)) assert.equal(s.minOut, (s.out * 9_990n) / 10_000n);
  assert.equal(p.xntOut, p.swaps.at(-1)!.out);
  assert.equal(p.profit, p.xntOut - p.xntIn);
});

test("sizing stays between the smallest trade (0.01 XNT) and the cap, and beats a fine search over that range", () => {
  const MIN_SIZE = 10_000_000n; // the engine never sizes a trade below 0.01 XNT
  for (const cap of [XNT, 10n * XNT, 25n * XNT]) {
    const e = engine(1n, cap);
    for (const r of triangle(market(-20), e)) {
      const best = e.best(r, 1n);
      assert.ok(best.xntIn >= MIN_SIZE && best.xntIn <= cap, `chosen ${best.xntIn} outside [${MIN_SIZE}, ${cap}]`);
      for (let x = MIN_SIZE; x <= cap; x += cap / 200n) assert.ok(e.plan(r, x, 1n).profit <= best.profit + 100_000n, `size ${x} beats the chosen ${best.xntIn}`);
    }
  }
});

test("a deep side pool gets a bigger trade than a shallow one for the same gap", () => {
  const e = engine(1n, 1000n * XNT);
  const shallow = e.best(triangle(market(-20, 0, 20n), e)[0], 1n), deep = e.best(triangle(market(-20, 0, 400n), e)[0], 1n);
  assert.ok(deep.xntIn > shallow.xntIn * 5n, `deep ${deep.xntIn} vs shallow ${shallow.xntIn}`);
  assert.ok(deep.profit > shallow.profit);
});

test("routes: two triangles per side pool, pairs between side pools of different tokens, each a cycle from XNT to XNT", () => {
  const e = engine();
  const m = market(-15);
  const q2 = pool(Q2, X, 1_000n * XNT, 2_000n * XNT);
  const side2 = pool(TEST, Q2, 20_000_000n * XNT, 100n * XNT, 500);
  const sameQ = pool(TEST, Q, 1_000_000n * XNT, 50n * XNT, 500); // a second TEST/Q pool: no pair with the first
  const sides = [
    { name: "TEST/Q", side: m.side, quote: m.quote, quoteMint: Q },
    { name: "TEST/Q2", side: side2, quote: q2, quoteMint: Q2 },
    { name: "TEST/Q (2nd)", side: sameQ, quote: m.quote, quoteMint: Q },
  ];
  const triangles = routesFor({ mint: TEST, symbol: "TEST", main: m.main, sides }, false);
  const all = routesFor({ mint: TEST, symbol: "TEST", main: m.main, sides }, true);
  assert.equal(triangles.length, 6);
  const pairs = all.filter((r) => r.hops.length === 4);
  assert.equal(pairs.length, 4, "Q<->Q2 both ways, for each of the two TEST/Q pools; never Q<->Q");
  for (const r of all) {
    assert.ok(r.hops[0].inMint.equals(X), `${r.name} starts in XNT`);
    assert.ok(outMint(r.hops.at(-1)!).equals(X), `${r.name} ends in XNT`);
    for (let i = 1; i < r.hops.length; i++) assert.ok(r.hops[i].inMint.equals(outMint(r.hops[i - 1])), `${r.name} hop ${i} takes what hop ${i - 1} gave`);
    for (const p of r.mispriced) assert.ok(r.hops.some((h) => h.snap.pool.address.equals(p)), `${r.name}: mispriced pools are on the route`);
  }
});

test("bestAll marks a route as paying only at or above its minimum", async () => {
  const e = engine(20_000_000n);
  const out = await e.bestAll([...triangle(market(-15), e), ...triangle(market(-2), e)]);
  for (const o of out) assert.equal(o.pays, o.plan.profit >= 20_000_000n);
  assert.ok(out.some((o) => o.pays) && out.some((o) => !o.pays));
  assert.ok(out.every((o) => o.ownShare === 0), "no own wallets: nothing counts as your own pool");
});

test("send() never sends a transaction its own simulation rejected (it would only burn the fee)", async () => {
  let sent = 0;
  const conn = {
    simulateTransaction: async () => ({ value: { err: { InstructionError: [2, { Custom: 6005 }] }, unitsConsumed: 0, logs: ["Program log: Error: ExceededSlippage"] } }),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async () => { sent++; return "sig"; },
  } as unknown as Connection;
  const e = createEngine({ conn, xdex: key(), wallet: Keypair.generate(), minProfit: 1n, maxIn: XNT, slipBps: 10n,
    reserve: 0n, priority: 1000, stateDir: os.tmpdir(), log: () => {}, alert: async () => {} });
  const ix = new TransactionInstruction({ programId: key(), keys: [], data: Buffer.alloc(0) });
  await assert.rejects(e.send([ix]), /simulation failed, not sent/);
  assert.equal(sent, 0);
});
