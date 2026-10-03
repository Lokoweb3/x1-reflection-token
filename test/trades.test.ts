import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { parseSwap, parseTx, positions, type Trade } from "../src/trades.js";

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

const M = (wallet: string, tokens: number, at: number, kind: "move" | "lp" | "unpriced" | "order" = "move"): Trade =>
  ({ ...T(wallet, tokens, 0, at), kind });

test("tokens moved into the LP or another wallet take their share of the cost, with no profit or loss", () => {
  // Bought 100 for 10 XNT; 60 into the LP, 20 to another wallet: 20 left, costing 2.
  const p = positions([T("a", 100, -10, 1), M("a", -60, 2, "lp"), M("a", -20, 3)], new Set()).get("a")!;
  assert.equal(x(p.held), 20); assert.equal(x(p.cost), 2); assert.equal(p.realized, 0n);
  assert.equal(x(p.lpOut), 60); assert.equal(x(p.movedOut), 20); assert.equal(x(p.spent), 10);
  assert.equal(x(p.movedCost), 8); // spent 10 = 2 still held + 8 that left with the moved tokens
  assert.equal(p.trades, 1); // moves aren't trades
});

test("tokens transferred in have no known cost, and don't borrow one", () => {
  // Bought 100 for 10, sent all 100 away, then 50 came back from a limit order: none of them cost 10.
  const p = positions([T("c", 100, -10, 1), M("c", -100, 2), M("c", 50, 3)], new Set()).get("c")!;
  assert.equal(x(p.held), 0); assert.equal(x(p.cost), 0); assert.equal(x(p.unknown), 50);
});

test("a swap paid with another token, an old entry with no XNT paid, and an order fill are valued at the market price", () => {
  // The market: someone buys 100 for 1 XNT (0.01 each) and sells 100 for 0.8 (0.008 each).
  const m = [T("m", 100, -1, 1000), T("m", -100, 0.8, 1000)];
  const p = positions([...m, M("d", 100, 1060, "unpriced"), T("d", 100, 0, 1120), M("d", 50, 1180, "order"), M("d", -50, 1200, "unpriced")], new Set()).get("d")!;
  assert.equal(x(p.bought), 250); assert.equal(x(p.spent), 2.5); assert.equal(x(p.spentEstimated), 2.5); // buys at the buy price
  assert.equal(x(p.received), 0.4); assert.equal(x(p.receivedEstimated), 0.4); // the sale at the sell price
  assert.equal(x(p.held), 200); assert.equal(x(p.unknown), 0); assert.equal(p.trades, 4);
  assert.equal(x(p.realized), -0.1); // sold 50 costing 0.5 for 0.4
});

test("with no priced swap within a day, an unpriced buy keeps no known cost (and a transfer never gets one)", () => {
  const p = positions([T("m", 100, -1, 0), M("e", 100, 2 * 86400, "unpriced"), M("e", 100, 60)], new Set()).get("e")!;
  assert.equal(x(p.spent), 0); assert.equal(x(p.unknown), 200); assert.equal(x(p.bought), 100);
});

test("a sale draws on known- and unknown-cost tokens in proportion; profit only on the known part", () => {
  // 100 bought for 1 XNT, 100 transferred in; sell 100 for 4 XNT: 50 known (cost 0.5, got 2 → +1.5).
  const p = positions([T("e", 100, -1, 1), M("e", 100, 2), T("e", -100, 4, 3)], new Set()).get("e")!;
  assert.equal(x(p.held), 50); assert.equal(x(p.unknown), 50); assert.equal(x(p.cost), 0.5);
  assert.equal(x(p.realized), 1.5); assert.equal(x(p.received), 4);
});

/**
 * A transaction record: token balances per owner (account i + 1; `pre: null` = opened by this
 * transaction), lamports before and after per account (the signer's first), and logs.
 */
function txOf(signer: PublicKey, balances: { owner: string; mint: string; pre: bigint | null; post: bigint }[], lamports: [number, number][], logs: string[], fee = 5000) {
  const tb = (which: "pre" | "post") => balances.flatMap((b, i) => which === "pre" && b.pre === null ? [] : [{ accountIndex: i + 1, mint: b.mint, owner: b.owner, uiTokenAmount: { amount: String(which === "pre" ? b.pre : b.post) } }]);
  return {
    meta: { err: null, fee, logMessages: logs, preBalances: lamports.map(([a]) => a), postBalances: lamports.map(([, b]) => b), preTokenBalances: tb("pre"), postTokenBalances: tb("post"), loadedAddresses: { writable: [], readonly: [] } },
    transaction: { message: { getAccountKeys: () => ({ get: () => signer }) } },
  } as unknown as VersionedTransactionResponse;
}

test("parseTx: an LP deposit and a transfer are moves; a swap's side payments are moves for their owners", () => {
  const me = Keypair.generate().publicKey, pool = Keypair.generate().publicKey.toBase58(), fee = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const dep = txOf(me, [{ owner: me.toBase58(), mint, pre: 500n, post: 300n }, { owner: pool, mint, pre: 1000n, post: 1190n }], [[1e9, 1e9 - 5000]], ["Program log: Instruction: Deposit"]);
  assert.deepEqual(parseTx(dep, mint), [
    { wallet: me.toBase58(), tokens: "-200", xnt: "0", kind: "lp" }, { wallet: pool, tokens: "190", xnt: "0", kind: "move" }]);
  // Collecting a filled limit order logs "WithdrawOrderTokens": an order fill, not an LP withdrawal.
  const fill = txOf(me, [{ owner: me.toBase58(), mint, pre: 0n, post: 50n }], [[1e9, 1e9 - 5000]], ["Program log: Instruction: WithdrawOrderTokens"]);
  assert.equal(parseTx(fill, mint)[0].kind, "order");
});

test("parseSwap adds back the real rent of a Token-2022 account the swap opened", () => {
  const me = Keypair.generate().publicKey, mint = Keypair.generate().publicKey.toBase58();
  // Paid 1 XNT + 0.0021576 rent for a new token account (more than a plain account's 0.00203928) + fee.
  const tx = txOf(me, [{ owner: me.toBase58(), mint, pre: null, post: 100n }],
    [[3e9, 3e9 - 1e9 - 2_157_600 - 5000], [0, 2_157_600]], ["Program log: Instruction: SwapBaseInput"]);
  assert.deepEqual(parseSwap(tx, mint), { wallet: me.toBase58(), tokens: "100", xnt: "-1000000000" });
});

test("parseSwap: paid with another token is unpriced", () => {
  const me = Keypair.generate().publicKey, mint = Keypair.generate().publicKey.toBase58(), other = Keypair.generate().publicKey.toBase58();
  const tx = txOf(me, [{ owner: me.toBase58(), mint, pre: 0n, post: 100n }, { owner: me.toBase58(), mint: other, pre: 50n, post: 0n }], [[1e9, 1e9 - 5000]], ["Program log: Instruction: SwapBaseInput"]);
  assert.equal(parseSwap(tx, mint)?.kind, "unpriced");
});
