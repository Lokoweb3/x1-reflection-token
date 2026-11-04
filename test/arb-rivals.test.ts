import { test } from "node:test";
import assert from "node:assert/strict";
import { cuPriceOf, payerGain, pickRival, type SigInfo } from "../src/arb-rivals.js";

// Made-up signatures around a lost race at t = 1000 s through pools A, B and C (no network).
const s = (signature: string, slot: number, blockTime: number, err: unknown = null): SigInfo => ({ signature, slot, blockTime, err });
const race = { key: "k", at: 1000_000, name: "X/Y", pools: ["A", "B", "C"] };

test("the rival is the latest successful transaction through two or more of the route's pools before we gave up", () => {
  const opener = s("open", 100, 990), rival = s("rival", 102, 991), failed = s("late", 103, 992, { InstructionError: [2, { Custom: 6005 }] });
  const byPool = new Map([
    ["A", [failed, rival, opener]],
    ["B", [failed, rival]],
    ["C", [s("old", 50, 900), s("after", 200, 1010)]], // outside the window on both sides
  ]);
  const r = pickRival(race, byPool, new Set());
  assert.equal(r.kind, "arb");
  assert.equal(r.pick?.signature, "rival");
  assert.equal(r.opener?.signature, "open", "the opener is the latest other successful transaction before it");
  assert.equal(r.alsoFailed, 1, "a failed arb through two pools counts as another bot that lost too");
});

test("with no arb, a plain trade that moved the price back is the rival; nothing in the window means unknown; ours never count", () => {
  const trade = new Map([["A", [s("t", 101, 995)]]]);
  assert.equal(pickRival(race, trade, new Set()).kind, "trade");
  assert.equal(pickRival(race, new Map(), new Set()).kind, "unknown");
  const ours = new Map([["A", [s("mine", 101, 995)]], ["B", [s("mine", 101, 995)]]]);
  assert.equal(pickRival(race, ours, new Set(["mine"])).kind, "unknown");
});

test("the priority price is read from the ComputeBudget instruction, and the payer's gain counts wrapped XNT", () => {
  // SetComputeUnitPrice(1,000,000): [3, 0x40 0x42 0x0f 0 0 0 0 0] in base58.
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const enc = (b: Buffer) => { let n = BigInt("0x" + b.toString("hex")), out = ""; while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; } return out; };
  const data = enc(Buffer.from([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]));
  assert.equal(cuPriceOf([{ programId: "Other", data }, { programId: "ComputeBudget111111111111111111111111111111", data }]), 1_000_000);
  const W = "So11111111111111111111111111111111111111112";
  const gain = payerGain({ meta: { preBalances: [5_000_000_000], postBalances: [4_999_000_000],
    preTokenBalances: [{ owner: "P", mint: W, uiTokenAmount: { amount: "1000000000" } }], postTokenBalances: [{ owner: "P", mint: W, uiTokenAmount: { amount: "1031000000" } }] } }, "P");
  assert.ok(Math.abs(gain - 0.030) < 1e-9, `0.031 wrapped gained less a 0.001 fee: ${gain}`);
});
