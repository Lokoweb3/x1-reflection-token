import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CURVE_DISC, CURVE_LEN, EVENT, FEE_RECEIVER, IX, TARGET_XNT, applyBuy, applySell, authPda, buyIx, createCurveIx, curvePda, curveSetup,
  decodeCurve, deliverIx, graduateLockIx, graduatePoolIx, k0Of, parseEvents, positionPda, priceOf, quoteBuy, quoteSell, sellIx,
  transferFee, type Curve, type CurveState,
} from "../src/curve.js";

const sha8 = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const XNT = 1_000_000_000n;

/** A fresh curve as create_curve sets it up. */
function fresh(supplyWhole = 1_000_000_000n, taxBps = 500, createdAt = 0): CurveState & { x0: bigint; y0: bigint; Pn: bigint } {
  const s = curveSetup(supplyWhole, taxBps);
  return { supply: s.S, curveTokens: s.T, virtualXnt: s.x0, virtualTokens: s.y0, tokensSold: 0n, raisedXnt: 0n, createdAt, x0: s.x0, y0: s.y0, Pn: s.Pn };
}
const LATER = 10_000; // past the anti-sniping window

test("setup for 1e9 tokens at 5% tax", () => {
  const s = curveSetup(1_000_000_000n, 500);
  assert.equal(s.S, 1_000_000_000n * XNT);
  assert.equal(s.T, 800_000_000n * XNT);
  assert.equal(s.Pg, 200_000_000n * XNT);
  assert.equal(s.Pn, 190_000_000n * XNT); // 5% of 2e17 is exact
  // a = Pn*T/(T-Pn) = 190e6*800e6/610e6 tokens, floored in base units
  assert.equal(s.a, (190_000_000n * XNT * 800_000_000n * XNT) / (610_000_000n * XNT));
  assert.equal(s.y0, s.a + s.T);
  assert.equal(s.x0, (TARGET_XNT * (s.a - s.Pn)) / s.Pn);
  // Sanity: a ≈ 249.18 M tokens and x0 ≈ 6.2295 XNT of virtual XNT.
  assert.ok(Math.abs(Number(s.x0) / 1e9 - 6.2295) < 0.001 && Math.abs(Number(s.a) / 1e18 - 0.24918) < 0.00001, `x0 ${Number(s.x0) / 1e9}`);
});

test("Token-2022 fee rounds up and respects the max", () => {
  assert.equal(transferFee(1n, 500), 1n);
  assert.equal(transferFee(20n, 500), 1n);
  assert.equal(transferFee(21n, 500), 2n);
  assert.equal(transferFee(10_000n, 500, 7n), 7n);
  assert.equal(transferFee(0n, 500), 0n);
});

test("start price and completion price", () => {
  const c = fresh();
  const start = priceOf(c);
  assert.ok(Math.abs(start - Number(c.x0) / Number(c.y0)) < 1e-18);
  // Buy the whole curve in one go (after the snipe window).
  const q = quoteBuy(c, 1_000n * XNT, LATER);
  assert.ok(q.complete);
  const end = applyBuy(c, q);
  assert.equal(end.tokensSold, c.curveTokens);
  const open = Number(TARGET_XNT) / Number(c.Pn);
  assert.ok(Math.abs(priceOf(end) / open - 1) < 1e-6, `end ${priceOf(end)} vs pool ${open}`);
  // It raised (about) the target: never less than the target minus rounding.
  assert.ok(end.raisedXnt >= TARGET_XNT - 2n && end.raisedXnt <= TARGET_XNT + 1_000n, `raised ${end.raisedXnt}`);
  assert.ok(end.virtualXnt * end.virtualTokens >= k0Of(c));
});

test("final partial fill hits exactly T and charges only what it needs", () => {
  let c: CurveState = fresh();
  c = applyBuy(c, quoteBuy(c, 15n * XNT, LATER));
  const q = quoteBuy(c, 50n * XNT, LATER);
  assert.ok(q.complete);
  assert.equal(c.tokensSold + q.out, c.curveTokens);
  assert.ok(q.xntIn < 50n * XNT);
  assert.equal(q.xntIn, q.net + q.fee);
  assert.equal(q.xntIn, (q.net * 10_000n + 9_899n) / 9_900n);
  // Paying exactly that amount again also completes with the same tokens.
  const again = quoteBuy(c, q.xntIn, LATER);
  assert.equal(again.out, q.out);
});

test("buy then sell never returns more than was paid", () => {
  let c: CurveState = fresh();
  for (const amt of [1n, 777n, 10_000_000n, XNT / 3n, 2n * XNT, 7n * XNT]) {
    const b = quoteBuy(c, amt, LATER);
    if (b.error) continue;
    const after = applyBuy(c, b);
    const s = quoteSell(after, b.out);
    assert.ok(s.out <= b.xntIn, `sold ${s.out} > paid ${b.xntIn}`);
    assert.ok(s.gross <= b.net, "gross back never beats net in");
    const back = applySell(after, s);
    assert.ok(back.virtualXnt >= c.virtualXnt, "curve never loses XNT on a round trip");
    assert.ok(back.virtualXnt * back.virtualTokens >= k0Of(c));
    c = after; // keep buying up the curve
  }
});

test("quote rounding favours the curve", () => {
  const c = fresh();
  const q = quoteBuy(c, 12_345_678n, LATER);
  assert.equal(q.fee, (12_345_678n * 100n + 9_999n) / 10_000n); // ceil
  assert.equal(q.net, 12_345_678n - q.fee);
  const k0 = k0Of(c);
  const y1 = (k0 + (c.virtualXnt + q.net) - 1n) / (c.virtualXnt + q.net);
  assert.equal(q.out, c.virtualTokens - y1);
  // Exact maths would give a little more; the quote never exceeds it.
  const exact = Number(c.virtualTokens) - Number(k0) / Number(c.virtualXnt + q.net);
  assert.ok(Number(q.out) <= exact + 1);
  assert.equal(quoteBuy(c, 0n, LATER).error, "zero");
});

test("anti-sniping cap in the first 120 s", () => {
  const c = fresh(1_000_000_000n, 500, 1_000);
  const big = quoteBuy(c, 5n * XNT, 1_050);
  assert.equal(big.error, "too-big-early");
  assert.equal(quoteBuy(c, 5n * XNT, 1_120).error, undefined);
  const small = quoteBuy(c, XNT / 100n, 1_050);
  assert.equal(small.error, undefined);
  assert.equal(big.maxEarly, 10_000_000n * XNT);
});

test("instruction data and account order", () => {
  const program = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  assert.deepEqual(IX.buy, sha8("global:buy"));
  assert.deepEqual(IX.createCurve, sha8("global:create_curve"));
  assert.deepEqual(IX.graduatePool, sha8("global:graduate_pool"));
  assert.deepEqual(IX.graduateLock, sha8("global:graduate_lock"));
  assert.deepEqual(IX.deliver, sha8("global:deliver"));
  assert.deepEqual(CURVE_DISC, sha8("account:Curve"));

  const cc = createCurveIx(program, user, mint, 1_000_000_000n);
  assert.equal(cc.data.length, 16);
  assert.equal(cc.data.readBigUInt64LE(8), 1_000_000_000n);
  assert.deepEqual(cc.keys.map((k) => k.pubkey.toBase58()).slice(0, 4),
    [user, mint, curvePda(program, mint), authPda(program, mint)].map((k) => k.toBase58()));
  assert.ok(cc.keys[0].isSigner && cc.keys[0].isWritable && !cc.keys[1].isSigner);

  const b = buyIx(program, user, mint, 123n, 456n);
  assert.deepEqual(b.data.subarray(0, 8), sha8("global:buy"));
  assert.equal(b.data.readBigUInt64LE(8), 123n);
  assert.equal(b.data.readBigUInt64LE(16), 456n);
  assert.equal(b.keys.length, 6);
  assert.ok(b.keys[3].pubkey.equals(positionPda(program, curvePda(program, mint), user)));
  assert.ok(b.keys[4].pubkey.equals(FEE_RECEIVER));

  const s = sellIx(program, user, mint, 7n, 8n);
  assert.deepEqual(s.data.subarray(0, 8), sha8("global:sell"));
  assert.equal(s.data.readBigUInt64LE(16), 8n);

  assert.equal(graduatePoolIx(program, "testnet", user, mint).keys.length, 22);
  assert.equal(graduateLockIx(program, "testnet", user, mint, user).keys.length, 19);
  const d = deliverIx(program, user, mint, Keypair.generate().publicKey, user);
  assert.equal(d.keys.length, 11);
  assert.equal(d.data.length, 8);
});

test("curve account decodes and events parse from logs", () => {
  const mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
  const buf = Buffer.alloc(CURVE_LEN + 16); // Anchor may leave spare room
  CURVE_DISC.copy(buf, 0);
  mint.toBuffer().copy(buf, 8); creator.toBuffer().copy(buf, 40);
  let o = 72;
  for (const v of [100n, 80n, 20n, 19n, TARGET_XNT, 5n, 6n, 7n, 8n]) { buf.writeBigUInt64LE(v, o); o += 8; }
  buf.writeBigInt64LE(1_700_000_000n, o); o += 8;
  buf[o] = 3; o += 1;
  buf.writeUInt32LE(4, o); o += 4;
  buf.writeBigUInt64LE(9n, o); o += 8;
  o += 64;
  buf.writeUInt16LE(500, o);
  const c: Curve = decodeCurve(new PublicKey(mint), buf);
  assert.equal(c.supply, 100n); assert.equal(c.raisedXnt, 8n); assert.equal(c.status, 3);
  assert.equal(c.positions, 4); assert.equal(c.delivered, 9n); assert.equal(c.taxBps, 500); assert.equal(c.createdAt, 1_700_000_000);

  const ev = Buffer.alloc(8 + 64 + 1 + 8 * 7 + 8);
  EVENT.Trade.copy(ev, 0);
  mint.toBuffer().copy(ev, 8); creator.toBuffer().copy(ev, 40);
  ev[72] = 1;
  ev.writeBigUInt64LE(1_000n, 73); ev.writeBigUInt64LE(10n, 81); ev.writeBigUInt64LE(555n, 89);
  ev.writeBigInt64LE(42n, 8 + 64 + 1 + 56);
  const logs = ["Program log: Instruction: Buy", `Program data: ${ev.toString("base64")}`, "Program data: AAAA"];
  const [t] = parseEvents(logs);
  assert.equal(t.name, "Trade");
  if (t.name !== "Trade") return;
  assert.equal(t.isBuy, true); assert.equal(t.xnt, 1_000n); assert.equal(t.fee, 10n); assert.equal(t.tokens, 555n); assert.equal(t.ts, 42);
  assert.equal(t.trader, creator.toBase58());
});

test("setup holds across the supply and tax range", () => {
  for (const supply of [1_000n, 123_457n, 1_000_000_000n, 10_000_000_000n]) {
    for (const tax of [100, 500, 1000]) {
      const c = fresh(supply, tax);
      assert.ok(c.x0 > 0n && c.y0 > c.curveTokens);
      const q = quoteBuy(c, 10_000n * XNT, LATER);
      assert.ok(q.complete);
      const end = applyBuy(c, q);
      const open = Number(TARGET_XNT) / Number(c.Pn);
      assert.ok(Math.abs(priceOf(end) / open - 1) < 1e-6, `supply ${supply} tax ${tax}`);
    }
  }
});
