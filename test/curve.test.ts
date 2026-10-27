import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction } from "@solana/web3.js";
import {
  CURVE_DISC, CURVE_LEN, CurveStatus, DEFAULT_TARGET_XNT, EVENT, FEE_RECEIVER, IX, LOCKER_PROGRAM_ID, LOCK_AFTER_SECS, REFUND_AFTER_SECS, TARGETS_XNT,
  applyBuy, applySell, authPda, burnOpensAt, buyIx, closeCurveIx, completedAt, createCurveIx, curvePda, curveSetup, decodeCurve, decodeEvent, deliverIx,
  graduateBurnIx, graduateIxs, graduateLockIx, graduatePoolIx, hasPool, isGraduated, k0Of, lockNftOf, parseEvents,
  parseTarget, poolOpenPrice, positionPda, priceOf, quoteBuy, quoteSell, refundIx, refundOpensAt, refundShare, sellIx, transferFee, xdexIds,
  type Curve, type CurveState,
} from "../src/curve.js";

const sha8 = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const XNT = 1_000_000_000n;
/** The default target in lamports (the old fixed target was 20 XNT). */
const R = DEFAULT_TARGET_XNT * XNT;

/** A fresh curve as create_curve sets it up. */
function fresh(supplyWhole = 1_000_000_000n, taxBps = 500, createdAt = 0, targetWhole = DEFAULT_TARGET_XNT): CurveState & { x0: bigint; y0: bigint; Pn: bigint } {
  const s = curveSetup(supplyWhole, taxBps, targetWhole);
  return { supply: s.S, curveTokens: s.T, virtualXnt: s.x0, virtualTokens: s.y0, tokensSold: 0n, raisedXnt: 0n, createdAt, x0: s.x0, y0: s.y0, Pn: s.Pn };
}
/** Flooring `a` leaves a full curve up to R*T/a² lamports short of R (143 at 10,000 XNT, minimum supply); the program's deposit covers it. */
const maxShort = (r: bigint) => 10n + r / 50_000_000_000n;
const LATER = 10_000; // past the anti-sniping window

test("setup for 1e9 tokens at 5% tax", () => {
  const s = curveSetup(1_000_000_000n, 500, DEFAULT_TARGET_XNT);
  assert.equal(s.S, 1_000_000_000n * XNT);
  assert.equal(s.T, 800_000_000n * XNT);
  assert.equal(s.Pg, 200_000_000n * XNT);
  assert.equal(s.Pn, 190_000_000n * XNT); // 5% of 2e17 is exact
  // a = Pn*T/(T-Pn) = 190e6*800e6/610e6 tokens, floored in base units
  assert.equal(s.a, (190_000_000n * XNT * 800_000_000n * XNT) / (610_000_000n * XNT));
  assert.equal(s.y0, s.a + s.T);
  assert.equal(s.x0, (R * (s.a - s.Pn)) / s.Pn);
  // Sanity: a ≈ 249.18 M tokens and x0 ≈ 155.74 XNT of virtual XNT (6.2295 at the old 20 XNT).
  assert.ok(Math.abs(Number(s.x0) / 1e9 - 155.7377) < 0.001 && Math.abs(Number(s.a) / 1e18 - 0.24918) < 0.00001, `x0 ${Number(s.x0) / 1e9}`);
  assert.ok(Math.abs(Number(curveSetup(1_000_000_000n, 500, 20n).x0) / 1e9 - 6.2295) < 0.001);
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
  const open = Number(R) / Number(c.Pn);
  assert.ok(Math.abs(priceOf(end) / open - 1) < 1e-6, `end ${priceOf(end)} vs pool ${open}`);
  // It raised the target, short by rounding only.
  assert.ok(end.raisedXnt <= R && R - end.raisedXnt <= maxShort(R), `raised ${end.raisedXnt}`);
  assert.ok(end.virtualXnt * end.virtualTokens >= k0Of(c));
});

test("final partial fill hits exactly T and charges only what it needs", () => {
  let c: CurveState = fresh();
  c = applyBuy(c, quoteBuy(c, 400n * XNT, LATER));
  const q = quoteBuy(c, 500n * XNT, LATER);
  assert.ok(q.complete);
  assert.equal(c.tokensSold + q.out, c.curveTokens);
  assert.ok(q.xntIn < 500n * XNT);
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

test("early-buy limits count the whole position and all buyers together", () => {
  const c = fresh(1_000_000_000n, 500, 1_000);
  const per = 10_000_000n * XNT; // 1% of the supply
  const q = quoteBuy(c, XNT / 2n, 1_050);
  assert.equal(q.error, undefined);
  // The same buy is refused once the wallet's position would pass 1%.
  assert.equal(quoteBuy(c, XNT / 2n, 1_050, per - q.out + 1n).error, "too-big-early");
  assert.equal(quoteBuy(c, XNT / 2n, 1_050, per - q.out).error, undefined);
  // All buyers together: 10% of the supply.
  assert.equal(q.maxEarlyTotal, 10n * per);
  // Other wallets' buys up to just under 10%: the next one that would pass it is refused.
  let full = c;
  for (;;) {
    const next = quoteBuy(full, XNT / 2n, 1_050);
    if (next.error) { assert.equal(next.error, "early-full"); break; }
    full = applyBuy(full, next);
  }
  assert.ok(full.tokensSold <= 10n * per && full.tokensSold > 9n * per);
  assert.equal(quoteBuy(full, XNT / 2n, 1_200).error, undefined, "no limits after the window");
});

test("refunds and statuses", () => {
  // Pro rata, rounded down; the last position takes the rest.
  let raised = 999_999_999n, sold = 800n * XNT;
  let paid = 0n;
  for (const b of [sold / 3n, sold / 5n, sold - sold / 3n - sold / 5n]) {
    const r = refundShare(raised, sold, b);
    paid += r; raised -= r; sold -= b;
  }
  assert.equal(paid, 999_999_999n);
  assert.equal(refundShare(5n, 10n, 0n), 0n);
  // Refunds open REFUND_AFTER_SECS after completion (kept in `delivered`; older curves: creation time).
  const base = { createdAt: 1_000, delivered: 5_000n };
  assert.equal(completedAt({ ...base, status: CurveStatus.Complete }), 5_000);
  assert.equal(refundOpensAt({ ...base, status: CurveStatus.Complete }), 5_000 + REFUND_AFTER_SECS);
  assert.equal(refundOpensAt({ ...base, status: CurveStatus.Complete, delivered: 0n }), 1_000 + REFUND_AFTER_SECS);
  assert.equal(refundOpensAt({ ...base, status: CurveStatus.Trading }), null);
  assert.equal(refundOpensAt({ ...base, status: CurveStatus.Graduated }), null);
  // Refunding (5) is past Finished in number but has no pool and never graduated.
  assert.ok(!hasPool(CurveStatus.Refunding) && !isGraduated(CurveStatus.Refunding));
  assert.ok(hasPool(CurveStatus.PoolCreated) && hasPool(CurveStatus.Finished) && !hasPool(CurveStatus.Complete));
  assert.ok(isGraduated(CurveStatus.Graduated) && isGraduated(CurveStatus.Finished) && !isGraduated(CurveStatus.PoolCreated));
});

test("instruction data and account order", () => {
  const program = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, user = Keypair.generate().publicKey;
  assert.deepEqual(IX.buy, sha8("global:buy"));
  assert.deepEqual(IX.createCurve, sha8("global:create_curve"));
  assert.deepEqual(IX.graduatePool, sha8("global:graduate_pool"));
  assert.deepEqual(IX.graduateLock, sha8("global:graduate_lock"));
  assert.deepEqual(IX.deliver, sha8("global:deliver"));
  assert.deepEqual(CURVE_DISC, sha8("account:Curve"));

  const cc = createCurveIx(program, "testnet", user, mint, 1_000_000_000n, 3_000n);
  assert.equal(cc.data.length, 24); // create_curve(supply_whole: u64, target_whole: u64)
  assert.equal(cc.data.readBigUInt64LE(8), 1_000_000_000n);
  assert.equal(cc.data.readBigUInt64LE(16), 3_000n);
  assert.deepEqual(cc.keys.map((k) => k.pubkey.toBase58()).slice(0, 4),
    [user, mint, curvePda(program, mint), authPda(program, mint)].map((k) => k.toBase58()));
  assert.ok(cc.keys[0].isSigner && cc.keys[0].isWritable && !cc.keys[1].isSigner);
  // The XDEX fee tier graduation will use, checked at creation.
  assert.equal(cc.keys.length, 6);
  assert.ok(cc.keys[5].pubkey.equals(xdexIds("testnet").ammConfig) && !cc.keys[5].isWritable);

  const b = buyIx(program, user, mint, 123n, 456n);
  assert.deepEqual(b.data.subarray(0, 8), sha8("global:buy"));
  assert.equal(b.data.readBigUInt64LE(8), 123n);
  assert.equal(b.data.readBigUInt64LE(16), 456n);
  assert.equal(b.keys.length, 7);
  assert.ok(b.keys[3].pubkey.equals(positionPda(program, curvePda(program, mint), user)));
  assert.ok(b.keys[4].pubkey.equals(FEE_RECEIVER));
  assert.ok(b.keys[6].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY), "the instructions sysvar (one buy per transaction early on)");

  const owner = Keypair.generate().publicKey;
  const rf = refundIx(program, user, mint, owner, user);
  assert.deepEqual(rf.data, sha8("global:refund"));
  assert.equal(rf.keys.length, 7);
  assert.ok(rf.keys[3].pubkey.equals(positionPda(program, curvePda(program, mint), owner)) && rf.keys[4].pubkey.equals(owner));

  const s = sellIx(program, user, mint, 7n, 8n);
  assert.deepEqual(s.data.subarray(0, 8), sha8("global:sell"));
  assert.equal(s.data.readBigUInt64LE(16), 8n);

  const gp = graduatePoolIx(program, "testnet", user, mint);
  assert.equal(gp.keys.length, 23);
  assert.ok(gp.keys[22].pubkey.equals(LOCKER_PROGRAM_ID) && !gp.keys[22].isWritable, "lp_locker last (graduate_pool checks it's executable)");
  assert.equal(graduateLockIx(program, "testnet", user, mint, user).keys.length, 19);

  const gb = graduateBurnIx(program, "testnet", user, mint);
  assert.deepEqual(gb.data, sha8("global:graduate_burn"));
  assert.equal(gb.keys.length, 7);
  assert.ok(gb.keys[3].pubkey.equals(gp.keys[11].pubkey), "the pool's LP mint");
  assert.ok(gb.keys[4].pubkey.equals(gp.keys[6].pubkey), "auth's LP account");
  const cl = closeCurveIx(program, user, mint);
  assert.deepEqual(cl.data, sha8("global:close_curve"));
  assert.ok(cl.keys[0].isSigner && cl.keys[1].pubkey.equals(curvePda(program, mint)) && cl.keys[2].pubkey.equals(authPda(program, mint)));
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
  for (const v of [100n, 80n, 20n, 19n, 10_000n * XNT, 5n, 6n, 7n, 8n]) { buf.writeBigUInt64LE(v, o); o += 8; }
  buf.writeBigInt64LE(1_700_000_000n, o); o += 8;
  buf[o] = 3; o += 1;
  buf.writeUInt32LE(4, o); o += 4;
  buf.writeBigUInt64LE(9n, o); o += 8;
  o += 64;
  buf.writeUInt16LE(500, o);
  const c: Curve = decodeCurve(new PublicKey(mint), buf);
  assert.equal(c.supply, 100n); assert.equal(c.raisedXnt, 8n); assert.equal(c.status, 3);
  assert.equal(c.positions, 4); assert.equal(c.delivered, 9n); assert.equal(c.taxBps, 500); assert.equal(c.createdAt, 1_700_000_000);
  assert.equal(c.targetXnt, 10_000n * XNT, "each curve's own target is read from the account");

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
      const open = Number(R) / Number(c.Pn);
      assert.ok(Math.abs(priceOf(end) / open - 1) < 1e-6, `supply ${supply} tax ${tax}`);
    }
  }
});

test("every target, at the supply bounds: ends at the target and the pool's opening price", () => {
  // The old fixed 20 XNT too: curves created before targets were selectable keep it.
  for (const target of [...TARGETS_XNT, 20n]) {
    const r = target * XNT;
    for (const supply of [1_000n, 10_000_000_000n]) {
      for (const tax of [100, 1000]) {
        let c = fresh(supply, tax, 0, target);
        const s = curveSetup(supply, tax, target);
        const pool = { targetXnt: r, poolTokensNet: s.Pn };
        // Partial buys first: the price rises from the start price, nothing completes.
        const start = priceOf(c);
        for (let i = 0; i < 10; i++) c = applyBuy(c, quoteBuy(c, r / 20n, LATER));
        assert.ok(priceOf(c) > start && c.tokensSold < c.curveTokens);
        assert.ok(c.raisedXnt < r, `raised ${c.raisedXnt} of ${r}`);
        // Then one buy fills it.
        const q = quoteBuy(c, 2n * r, LATER);
        assert.ok(q.complete && q.xntIn < 2n * r);
        const end = applyBuy(c, q);
        assert.equal(end.tokensSold, end.curveTokens);
        assert.ok(end.raisedXnt <= r && r - end.raisedXnt <= maxShort(r), `target ${target} supply ${supply}: raised ${end.raisedXnt}`);
        assert.ok(Math.abs(priceOf(end) / poolOpenPrice(pool) - 1) < 1e-9, `target ${target} supply ${supply} tax ${tax}`);
        // Everything fits the program's u64 fields and its u128 k.
        assert.ok(end.virtualXnt < 2n ** 64n && k0Of(c) < 2n ** 128n);
        // The anti-snipe cap is 1% of the supply whatever the target.
        assert.equal(q.maxEarly, supply * XNT / 100n);
      }
    }
  }
});

test("the graduation target: default 500, only the allowed values", () => {
  assert.deepEqual(TARGETS_XNT, [500n, 1_000n, 3_000n, 5_000n, 10_000n]);
  for (const raw of [undefined, null, "", "  "]) assert.equal(parseTarget(raw), 500n);
  assert.equal(parseTarget(500), 500n);
  assert.equal(parseTarget("1000"), 1_000n);
  assert.equal(parseTarget("3,000"), 3_000n);
  assert.equal(parseTarget(" 5000 "), 5_000n);
  assert.equal(parseTarget(10_000), 10_000n);
  for (const bad of [0, 20, 499, 501, 20_000, -500, "500.5", "1e3", "abc", "0x1f4", true]) {
    assert.throws(() => parseTarget(bad), /Graduation target must be 500, 1,000, 3,000, 5,000 or 10,000 XNT/, `should reject ${String(bad)}`);
  }
  // Testnet also takes 10 and 20 XNT (curves you can graduate with faucet XNT); mainnet doesn't.
  assert.equal(parseTarget(10, "testnet"), 10n);
  assert.equal(parseTarget("20", "testnet"), 20n);
  assert.equal(parseTarget("", "testnet"), 500n, "the default stays 500");
  for (const bad of [0, 9, 11, 19, 21, 499]) assert.throws(() => parseTarget(bad, "testnet"), /Graduation target must be 10, 20, 500, 1,000, 3,000, 5,000 or 10,000 XNT/);
  assert.throws(() => parseTarget(10, "mainnet"));
});

test("BC-M1: graduate_pool + graduate_lock fit one transaction with compute-budget instructions", () => {
  const program = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
  for (const network of ["mainnet", "testnet"] as const) {
    const caller = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, creator = Keypair.generate().publicKey;
    const tx = new Transaction({ feePayer: caller, recentBlockhash: PublicKey.default.toBase58() }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
      ...graduateIxs(program, network, caller, mint, creator));
    const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    assert.ok(size <= 1232, `${network}: ${size} bytes`);
    assert.ok(size >= 1150, `${network}: ${size} bytes (the measured ~1,178; a big drop means accounts went missing)`);
  }
});

test("lock fallback clock, closed curves and burned-LP graduations", () => {
  const base = { delivered: 0n, createdAt: 1_000 };
  assert.equal(burnOpensAt({ ...base, status: CurveStatus.Complete }), null);
  assert.equal(burnOpensAt({ ...base, status: CurveStatus.PoolCreated }), 1_000 + LOCK_AFTER_SECS, "pool made before it was recorded: creation time");
  assert.equal(burnOpensAt({ ...base, status: CurveStatus.PoolCreated, delivered: 5_000n }), 5_000 + LOCK_AFTER_SECS);
  const nft = Keypair.generate().publicKey;
  assert.ok(lockNftOf({ status: CurveStatus.Graduated, lockNft: nft })?.equals(nft));
  assert.equal(lockNftOf({ status: CurveStatus.Finished, lockNft: PublicKey.default }), null, "LP burned: no lock NFT");
  assert.equal(lockNftOf({ status: CurveStatus.PoolCreated, lockNft: nft }), null);

  const [curve, mint, pool] = [0, 1, 2].map(() => Keypair.generate().publicKey);
  const ev = Buffer.concat([EVENT.LpBurned, curve.toBuffer(), mint.toBuffer(), pool.toBuffer(), Buffer.alloc(16)]);
  ev.writeBigUInt64LE(77n, 8 + 96); ev.writeBigUInt64LE(500n * XNT, 8 + 104);
  assert.deepEqual(decodeEvent(ev), { name: "LpBurned", curve: curve.toBase58(), mint: mint.toBase58(), pool: pool.toBase58(), lpAmount: 77n, raisedXnt: 500n * XNT });
  const cl = Buffer.concat([EVENT.CurveClosed, curve.toBuffer(), mint.toBuffer(), pool.toBuffer(), Buffer.from([3, 0, 0, 0])]);
  assert.deepEqual(decodeEvent(cl), { name: "CurveClosed", curve: curve.toBase58(), mint: mint.toBase58(), creator: pool.toBase58(), positions: 3 });
});
