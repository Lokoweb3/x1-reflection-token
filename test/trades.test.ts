import { test } from "node:test";
import assert from "node:assert/strict";
import { positions, type Trade } from "../src/trades.js";

const T = (wallet: string, tokens: number, xnt: number, at: number): Trade =>
  ({ sig: `s${at}`, at, wallet, tokens: String(BigInt(Math.round(tokens * 1e9))), xnt: String(BigInt(Math.round(xnt * 1e9))) });
const x = (v: bigint) => Number(v) / 1e9;

test("average cost over several buys (your CUP buys)", () => {
  const p = positions([T("me", 45.4869, -0.5, 1), T("me", 41.2659, -0.5, 2), T("me", 72.0238, -1, 3)], new Set()).get("me")!;
  assert.equal(x(p.spent), 2);
  assert.ok(Math.abs(x(p.cost) / x(p.held) - 0.012596) < 1e-5, `avg ${x(p.cost) / x(p.held)}`);
  assert.equal(p.realized, 0n);
});

test("a sell removes cost at the average price and books realized profit", () => {
  // Buy 100 for 1 XNT (0.01 each), buy 100 for 3 XNT (0.03 each): average 0.02.
  // Sell 50 for 2 XNT: cost removed 50 × 0.02 = 1, realized +1; 150 left costing 3.
  const p = positions([T("a", 100, -1, 1), T("a", 100, -3, 2), T("a", -50, 2, 3)], new Set()).get("a")!;
  assert.equal(x(p.held), 150); assert.equal(x(p.cost), 3); assert.equal(x(p.realized), 1);
  assert.equal(x(p.cost) / x(p.held), 0.02); // average cost unchanged by a sell
});

test("selling tokens that were never bought (transfers in) doesn't invent a cost", () => {
  // Bought 10 for 1 XNT, sold 30 for 6 XNT: 10 from buys (got 2, cost 1 → +1), 20 had no known cost.
  const p = positions([T("b", 10, -1, 1), T("b", -30, 6, 2)], new Set()).get("b")!;
  assert.equal(x(p.held), 0); assert.equal(x(p.cost), 0); assert.equal(x(p.realized), 1);
  assert.equal(x(p.sold), 30); assert.equal(x(p.received), 6);
});

test("pool and distributor trades are left out", () => {
  const m = positions([T("pool", 5, -1, 1), T("dist", -5, 1, 2), T("c", 1, -0.1, 3)], new Set(["pool", "dist"]));
  assert.deepEqual([...m.keys()], ["c"]);
});
