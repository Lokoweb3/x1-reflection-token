import { test } from "node:test";
import assert from "node:assert/strict";
import { instructionNames, stepOf, summarize, type CostLine } from "../src/factory/vault-costs.js";

const P = "D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const H = 3_600_000;

test("a transaction's vault step comes from the vault program's own instruction lines", () => {
  const logs = [
    "Program ComputeBudget111111111111111111111111111111 invoke [1]",
    `Program ${P} invoke [1]`,
    "Program log: Instruction: Sell",
    "Program sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN invoke [2]",
    "Program log: Instruction: SwapBaseInput", // XDEX's, called from inside the vault's instruction
    "Program sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN success",
    `Program ${P} success`,
    "Program log: Instruction: Transfer", // outside the vault program
  ];
  // Lines inside the vault's call count (its inner XDEX swap too); lines outside it don't.
  assert.deepEqual(instructionNames(logs, P), ["Sell", "SwapBaseInput"]);
  assert.equal(stepOf(instructionNames(logs, P)), "sell", "the inner swap doesn't change the step");
  assert.equal(stepOf(["FundCreator"]), "reward");
  assert.equal(stepOf(["AddLiquidity"]), "liquidity");
  assert.equal(stepOf(["Burn", "Collect"]), "collect");
  assert.equal(stepOf(["PublishList"]), "list");
  assert.equal(stepOf(["Pay"]), "pay");
  assert.equal(stepOf(["PayFallbackToken"]), "pay");
  assert.equal(stepOf(["InitVault"]), "setup");
  assert.equal(stepOf([]), "none");
});

test("costs are grouped by UTC day with steps, the site crank's share, and the tax sold and paid that day", () => {
  const lines: CostLine[] = [
    { sig: "a", at: NOW - 2 * H, fee: 1_000_000, step: "sell", payer: "crank", err: false },
    { sig: "b", at: NOW - 1 * H, fee: 600_000, step: "pay", payer: "crank", err: false },
    { sig: "c", at: NOW - 1 * H, fee: 400_000, step: "pay", payer: "visitor", err: true },
    { sig: "d", at: NOW - 30 * H, fee: 2_000_000, step: "liquidity", payer: "crank", err: false }, // yesterday
    { sig: "e", at: NOW - 9 * 24 * H, fee: 9_000_000, step: "sell", payer: "crank", err: false }, // outside the 7 days
  ];
  const events = [
    { at: new Date(NOW - 2 * H).toISOString(), kind: "sell", xnt: "100000000" },
    { at: new Date(NOW - 1 * H).toISOString(), kind: "payout", total: "50000000", payments: [["w1", "1"], ["w2", "1"]] },
  ];
  const s = summarize(lines, events, "crank", 7, NOW);
  assert.equal(s.days.length, 7);
  const today = s.days.at(-1)!, yesterday = s.days.at(-2)!;
  assert.equal(today.day, "2026-10-09");
  assert.deepEqual([today.txs, today.failed, today.fees, today.crankFees], [3, 1, 2_000_000, 1_600_000]);
  assert.deepEqual(today.byStep, { sell: 1_000_000, pay: 1_000_000 });
  assert.deepEqual([today.taxSold, today.paidHolders, today.payments], [100_000_000, 50_000_000, 2]);
  assert.equal(yesterday.fees, 2_000_000);
  assert.equal(s.total.fees, 4_000_000, "the 9-day-old line is outside the window");
  assert.equal(s.total.feePct, 4, "4,000,000 of fees on 100,000,000 of tax sold");
  assert.equal(s.total.perPayment, 500_000, "pay fees over wallet payments");
});

test("the daily average uses the time the ledger covers, not the whole week", () => {
  const lines: CostLine[] = [{ sig: "a", at: NOW - 6 * H, fee: 6_000_000, step: "sell", payer: "x", err: false }];
  const s = summarize(lines, [], null, 7, NOW);
  assert.equal(s.total.coveredDays, 0.25);
  assert.equal(s.total.perDay, 24_000_000, "6,000,000 in a quarter day is 24,000,000 a day");
  assert.equal(s.total.feePct, null, "no sales, no percentage");
  assert.equal(s.total.perPayment, null);
  const week = summarize([{ ...lines[0], at: NOW - 20 * 24 * H }, ...lines], [], null, 7, NOW);
  assert.equal(week.total.coveredDays, 7, "a ledger older than the window covers all of it");
});
