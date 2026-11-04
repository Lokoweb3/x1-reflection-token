import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type TransferFeeConfig } from "@solana/spl-token";
import { bidPriority, createEngine, fastTripped, fastUnits, routesFor, type Route } from "../src/arb-engine.js";
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

test("the profit-based priority spends its share of the profit, within the floor and the ceiling", () => {
  // 0.01 XNT profit, 15%, 90k CU: 1.5M lamports / 90k CU = 16.67M µL/CU.
  assert.equal(bidPriority(10_000_000n, 90_000, 0.15, 1000, 50_000_000), 16_666_666);
  assert.equal(bidPriority(10_000_000n, 90_000, 0.15, 1000, 5_000_000), 5_000_000, "capped");
  assert.equal(bidPriority(100n, 90_000, 0.15, 1000, 50_000_000), 1000, "never under the flat priority");
  assert.equal(bidPriority(10_000_000n, 90_000, 0, 1000, 50_000_000), 1000, "share 0: flat priority, as before");
  assert.equal(bidPriority(-5n, 90_000, 0.15, 1000, 50_000_000), 1000);
  // What the bid costs is the share of the profit (fee = µL/CU × CU / 1e6 lamports).
  assert.ok(Math.abs((16_666_666 * 90_000) / 1e6 - 1_500_000) < 1);
});

test("the fast compute limit covers measured trips (3 swaps ≤ 77k CU, 4 swaps ≤ 102k) with headroom", () => {
  assert.equal(fastUnits(3, false), 90_000);
  assert.equal(fastUnits(4, false), 120_000);
  assert.equal(fastUnits(3, true), 105_000);
  assert.ok(fastUnits(3, false) > 77_157 * 1.1 && fastUnits(4, false) > 102_236 * 1.1);
});

test("the fast guard trips only once failed fees exceed what fast trades made by the allowed loss", () => {
  const d = (spent: bigint, made: bigint) => ({ day: "2026-11-01", spent: spent.toString(), made: made.toString() });
  assert.equal(fastTripped(d(40_000_000n, 0n), 50_000_000n), false);
  assert.equal(fastTripped(d(60_000_000n, 0n), 50_000_000n), true);
  assert.equal(fastTripped(d(60_000_000n, 20_000_000n), 50_000_000n), false, "profits offset failed fees");
});

/** A fake RPC for executing trades: every account exists, plenty is wrapped, and each sent trade ends as `status`. */
function fakeConn(status: () => { err: unknown } | { confirmationStatus: string }, fee = 900_000) {
  const calls = { simulate: 0, sent: [] as Buffer[] };
  const conn = {
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ lamports: 1, data: Buffer.alloc(0), owner: key(), executable: false })),
    getTokenAccountBalance: async () => ({ value: { amount: (1_000n * XNT).toString() } }),
    getBalance: async () => Number(XNT),
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 ** 9 }),
    simulateTransaction: async () => { calls.simulate++; return { value: { err: { InstructionError: [2, { Custom: 6005 }] }, unitsConsumed: 0, logs: [] } }; },
    sendRawTransaction: async (raw: Buffer) => { calls.sent.push(Buffer.from(raw)); return `sig${calls.sent.length}`; },
    getSignatureStatuses: async () => ({ value: [status()] }),
    getBlockHeight: async () => 1,
    getTransaction: async () => ({ meta: { fee, preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
      transaction: { message: { getAccountKeys: () => ({ length: 0, get: () => undefined }) } } }),
  } as unknown as Connection;
  return { conn, calls };
}
/** The compute limit and price a sent transaction asked for. */
function budget(raw: Buffer) {
  const tx = VersionedTransaction.deserialize(raw), keys = tx.message.staticAccountKeys;
  let limit = 0, price = 0n;
  for (const ix of tx.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 2) limit = d.readUInt32LE(1);
    if (d[0] === 3) price = d.readBigUInt64LE(1);
  }
  return { limit, price };
}
const until = async (ok: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); assert.ok(ok(), "timed out"); };

test("fast mode sends without simulating, at the estimated limit and the profit bid, and holds the pools until the trade settles", async () => {
  let landed = false;
  const { conn, calls } = fakeConn(() => (landed ? { confirmationStatus: "confirmed" } : null) as never);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-fast-"));
  const e = createEngine({ conn, xdex: key(), wallet: Keypair.generate(), minProfit: 20_000_000n, maxIn: 25n * XNT, slipBps: 10n,
    reserve: 0n, priority: 1000, priorityShare: 0.15, fast: true, stateDir: dir, log: () => {}, alert: async () => {} });
  const [buySide] = triangle(market(-15), e);
  const plan = e.best(buySide, 20_000_000n);
  assert.equal(await e.execute([{ plan, ownShare: 0 }]), 1);
  assert.equal(calls.simulate, 0, "no simulation before sending");
  assert.equal(calls.sent.length, 1);
  const b = budget(calls.sent[0]);
  assert.equal(b.limit, fastUnits(3, false));
  assert.equal(b.price, BigInt(bidPriority(plan.profit, b.limit, 0.15, 1000, 50_000_000)));
  // Still unconfirmed: another trade through the same pools waits.
  assert.equal(await e.execute([{ plan, ownShare: 0 }]), 0);
  assert.equal(calls.sent.length, 1);
  landed = true;
  await until(() => fs.existsSync(path.join(dir, "arb-trades.jsonl")));
  await until(() => e.traded.count === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await e.execute([{ plan, ownShare: 0 }]), 1, "pools free again once it landed");
});

test("fast mode counts a failed trade's fee and goes back to simulating once the day's loss passes the limit", async () => {
  const { conn, calls } = fakeConn(() => ({ err: { InstructionError: [2, { Custom: 6005 }] } }), 900_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-fast-"));
  const e = createEngine({ conn, xdex: key(), wallet: Keypair.generate(), minProfit: 20_000_000n, maxIn: 25n * XNT, slipBps: 10n,
    reserve: 0n, priority: 1000, fast: true, fastMaxLoss: 500_000n, stateDir: dir, log: () => {}, alert: async () => {} });
  const [buySide] = triangle(market(-15), e);
  const plan = e.best(buySide, 20_000_000n);
  assert.equal(await e.execute([{ plan, ownShare: 0 }]), 1);
  assert.equal(calls.simulate, 0);
  const file = path.join(dir, "arb-fast.json");
  await until(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).spent === "900000");
  await new Promise((r) => setTimeout(r, 100));
  const lostRow = JSON.parse(fs.readFileSync(path.join(dir, "arb-lost.jsonl"), "utf8").trim().split("\n")[0]);
  assert.equal(lostRow.reason, "gap gone before it landed");
  assert.equal(lostRow.fee, "900000");
  // 0.0009 XNT lost against a 0.0005 limit: the next trade is simulated first (and this one's simulation fails, so nothing is sent).
  assert.equal(await e.execute([{ plan, ownShare: 0 }]), 0);
  assert.equal(calls.simulate, 1);
  assert.equal(calls.sent.length, 1);
});

test("without fast mode a trade is still simulated first, and a lost race is journaled with what it would have made", async () => {
  const { conn, calls } = fakeConn(() => ({ confirmationStatus: "confirmed" }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arb-plain-")), logs: string[] = [];
  const e = createEngine({ conn, xdex: key(), wallet: Keypair.generate(), minProfit: 20_000_000n, maxIn: 25n * XNT, slipBps: 10n,
    reserve: 0n, priority: 1000, stateDir: dir, log: (l) => logs.push(l), alert: async () => {} });
  const [buySide] = triangle(market(-15), e);
  const plan = e.best(buySide, 20_000_000n);
  assert.equal(await e.execute([{ plan, ownShare: 0.76 }]), 0, "the fake simulation rejects it");
  assert.equal(calls.simulate, 1);
  assert.equal(calls.sent.length, 0);
  const [row] = fs.readFileSync(path.join(dir, "arb-lost.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(row.name, plan.route.name);
  assert.equal(row.reason, "gap gone before sending");
  assert.equal(row.expectedProfit, plan.profit.toString());
  assert.equal(row.xntIn, plan.xntIn.toString());
  assert.equal(row.ownShare, 0.76);
  assert.equal(row.fee, undefined, "skipped before sending: no fee");
  assert.match(logs.join("\n"), /gap gone before sending \(simulation failed\), skipped; would have made \+[\d.]+ XNT on [\d.]+ \(76% your own pool\)/);
});

test("a fast lane sends only its own routes blind, at the lane priority and to the extra sender; other routes are still simulated first", async () => {
  const { conn, calls } = fakeConn(() => ({ confirmationStatus: "confirmed" }));
  const extra: Uint8Array[] = [];
  const mk = () => market(-15);
  const lane = mk(), other = mk();
  const e = createEngine({ conn, xdex: key(), wallet: Keypair.generate(), minProfit: 20_000_000n, maxIn: 25n * XNT, slipBps: 10n, reserve: 0n, priority: 1000,
    fastLane: (p) => p.route.hops.some((h) => h.snap.pool.address.equals(lane.side.pool.address)), lanePriority: 2_000_000, extraSend: (raw) => extra.push(raw),
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "arb-lane-")), log: () => {}, alert: async () => {} });
  const [laneRoute] = triangle(lane, e), [otherRoute] = triangle(other, e);
  const pl = e.best(laneRoute, 20_000_000n), po = e.best(otherRoute, 20_000_000n);
  await e.execute([{ plan: pl, ownShare: 0 }, { plan: po, ownShare: 0 }]);
  assert.equal(calls.simulate, 1, "only the other route is simulated (and the fake rejects it)");
  assert.equal(calls.sent.length, 1, "the lane route went out without a simulation");
  assert.ok(budget(calls.sent[0]).price >= 2_000_000n, "at least the lane priority");
  assert.equal(extra.length, 1, "and to the extra sender too");
  assert.deepEqual(Buffer.from(extra[0]), calls.sent[0]);
});
