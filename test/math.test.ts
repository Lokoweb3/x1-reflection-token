import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { allocate, eligibleBalances, splitTax, type TokenAccountRow } from "../src/holders.js";
import { XDEX_CREATE, cpmmOut, depositAmounts, inverseTransferFee, lpKeepForBalance, maxInputForImpact, maxLpFor, poolAddresses } from "../src/xdex.js";
import { validateParams } from "../src/factory/launch.js";
import { fromBaseUnits, toBaseUnits } from "../src/config.js";

const row = (owner: string, amount: bigint, extra: Partial<TokenAccountRow> = {}): TokenAccountRow =>
  ({ address: Keypair.generate().publicKey, owner, amount, withheld: 0n, frozen: false, ...extra });

test("allocate splits pro-rata, rounding down, never exceeding the pot", () => {
  const out = allocate(new Map([["a", 1n], ["b", 2n], ["c", 3n]]), 1_000n);
  assert.deepEqual([...out.values()], [166n, 333n, 500n]);
  assert.ok([...out.values()].reduce((x, y) => x + y) <= 1_000n);
  assert.equal(allocate(new Map(), 100n).size, 0);
  assert.equal(allocate(new Map([["a", 5n]]), 0n).size, 0);
});

test("eligibleBalances aggregates per owner and applies exclusions", () => {
  const [a, b, x] = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
  const pda = PublicKey.findProgramAddressSync([Buffer.from("v")], Keypair.generate().publicKey)[0].toBase58();
  const rows = [row(a, 600n), row(a, 600n), row(b, 500n), row(x, 9_999n), row(pda, 9_999n), row(b, 5_000n, { frozen: true })];
  const got = eligibleBalances(rows, { excluded: new Set([x]), excludeOffCurve: true, minHolding: 1_000n });
  assert.deepEqual([...got], [[a, 1_200n]]);
  const withPda = eligibleBalances(rows, { excluded: new Set(), excludeOffCurve: false, minHolding: 0n });
  assert.equal(withPda.get(pda), 9_999n);
});

test("cpmmOut matches constant product with rounded-up trade fee", () => {
  // 0.25% fee: 1000 in -> 997.5 rounds fee up to 3 -> 997 net
  assert.equal(cpmmOut(1_000n, 1_000_000n, 1_000_000n, 2_500n), (997n * 1_000_000n) / 1_000_997n);
});

test("maxInputForImpact respects impact bound after transfer fee", () => {
  const reserve = 1_000_000_000n;
  const amount = maxInputForImpact(reserve, 300n, 500n);
  const net = amount - (amount * 500n) / 10_000n;
  assert.ok((net * 10_000n) / (reserve + net) <= 300n);
  assert.equal(maxInputForImpact(reserve, 0n, 500n), 0n);
  assert.equal(maxInputForImpact(reserve, 300n, 10_000n), 0n);
});

test("decimal conversions are exact", () => {
  assert.equal(toBaseUnits("1.5", 9), 1_500_000_000n);
  assert.equal(toBaseUnits("1000000000", 9), 10n ** 18n);
  assert.equal(fromBaseUnits(1_500_000_000n, 9), "1.5");
  assert.throws(() => toBaseUnits("0.0000000001", 9));
});

test("splitTax sets aside burnBps to burn and lpBps for LP (half kept, half sold)", () => {
  assert.deepEqual(splitTax(1_000n, 4_000), { burn: 0n, keep: 200n, sell: 200n });
  assert.deepEqual(splitTax(1_001n, 4_000), { burn: 0n, keep: 200n, sell: 200n });
  assert.deepEqual(splitTax(999n, 4_000), { burn: 0n, keep: 199n, sell: 200n });
  assert.deepEqual(splitTax(1_000n, 0), { burn: 0n, keep: 0n, sell: 0n });
  assert.deepEqual(splitTax(1_000n, 4_000, 2_000), { burn: 200n, keep: 200n, sell: 200n });
  const s = splitTax(123_456_789n, 3_000, 2_500);
  assert.ok(s.burn + s.keep + s.sell <= 123_456_789n);
});

test("inverseTransferFee delivers at least the net amount after Token-2022's fee", () => {
  const U64_MAX = 2n ** 64n - 1n;
  for (const net of [1n, 19n, 20n, 999n, 123_456_789n, 10n ** 18n]) {
    const fee = inverseTransferFee(net, 500n, U64_MAX);
    const gross = net + fee;
    const charged = (gross * 500n + 9_999n) / 10_000n; // Token-2022 rounds the fee up
    assert.ok(gross - charged >= net, `net ${net}`);
  }
  assert.equal(inverseTransferFee(1_000n, 0n, U64_MAX), 0n);
  assert.equal(inverseTransferFee(1_000_000n, 500n, 7n), 7n);
});

test("maxLpFor fits both budgets, transfer fee included, and is nearly tight", () => {
  const U64_MAX = 2n ** 64n - 1n;
  const [rt, rx, supply] = [475_000_000n * 10n ** 9n, 50n * 10n ** 9n, 154_110_350_074_224n];
  const tokens = 5_000_000n * 10n ** 9n, xntBudget = 10n ** 9n;
  const lp = maxLpFor(tokens, xntBudget, rt, rx, supply, 500n, U64_MAX);
  const need = depositAmounts(lp, rt, rx, supply);
  assert.ok(need.token + inverseTransferFee(need.token, 500n, U64_MAX) <= tokens);
  assert.ok(need.xnt <= xntBudget);
  // 5M tokens are worth ~0.5 XNT at this price, so tokens bind; almost all of them are used.
  const spent = need.token + inverseTransferFee(need.token, 500n, U64_MAX);
  assert.ok(spent * 10_000n >= tokens * 9_999n);
  // With a smaller XNT budget, XNT binds instead.
  const lp2 = maxLpFor(tokens, xntBudget / 4n, rt, rx, supply, 500n, U64_MAX);
  const need2 = depositAmounts(lp2, rt, rx, supply);
  assert.ok(need2.xnt <= xntBudget / 4n && need2.xnt * 10_000n >= (xntBudget / 4n) * 9_999n);
  assert.equal(maxLpFor(0n, xntBudget, rt, rx, supply, 500n, U64_MAX), 0n);
});

test("lpKeepForBalance leaves both deposit sides worth the same", () => {
  const [rt, rx, bps, tfr] = [475_000_000n * 10n ** 9n, 50n * 10n ** 9n, 500n, 2_500n];
  const value = (tokens: bigint) => (tokens * (10_000n - bps) / 10_000n) * rx / rt; // XNT value after transfer fee
  const check = (total: bigint, x: bigint) => {
    const k = lpKeepForBalance(total, x, rt, rx, bps, tfr);
    const sold = total - k;
    const xAfter = x + (value(sold) * (1_000_000n - tfr)) / 1_000_000n;
    return { k, tokenSide: value(k), xAfter };
  };
  // Nothing set aside yet: keep a bit under half (selling loses the trade fee).
  let r = check(10_000_000n * 10n ** 9n, 0n);
  assert.ok(r.k < 5_000_000n * 10n ** 9n && r.k > 4_990_000n * 10n ** 9n);
  assert.ok(Math.abs(Number(r.tokenSide - r.xAfter)) <= 2);
  // 0.43 XNT waiting from last cycle and 10M tokens: keep more than half to match it.
  r = check(10_000_000n * 10n ** 9n, 430_000_000n);
  assert.ok(r.k > 7_000_000n * 10n ** 9n);
  assert.ok(Math.abs(Number(r.tokenSide - r.xAfter)) <= 2);
  // More XNT than all tokens are worth: keep everything, sell nothing.
  assert.equal(lpKeepForBalance(1_000n * 10n ** 9n, 10n ** 9n, rt, rx, bps, tfr), 1_000n * 10n ** 9n);
  assert.equal(lpKeepForBalance(0n, 10n ** 9n, rt, rx, bps, tfr), 0n);
});

test("factory pool addresses match the real RFLT testnet pool", () => {
  const a = poolAddresses(new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf"),
    new PublicKey(XDEX_CREATE.testnet.ammConfig), new PublicKey("Hi2E1kU3ZoMHQeve5WgWARnmJCky3h1jdTsdU9rw2eqA"));
  assert.equal(a.pool.toBase58(), "F21d72QPdKZiCb2yeYjnRU2KzRCoQ7GdgE82UohfwSfU");
  assert.equal(a.lpMint.toBase58(), "25VUPqXPs36WDxTvUYf6gXGtNb5DRUmHMgBmML9ASEx1");
  assert.equal(a.vault1.toBase58(), "E5sevgo9jxVsfqe8qW2bt7faJTZFsZFFP98ivfkY15PX");
});

test("factory launch input is validated", () => {
  const ok = {
    creator: "53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy", name: "My Token", symbol: "MYT", description: "", image: "https://x.io/a.png",
    supply: "1000000000", taxBps: 500, autoLpBps: 4000, poolTokens: "900000000", poolXnt: "5", lockDays: null,
  };
  assert.equal(validateParams(ok).symbol, "MYT");
  assert.equal(validateParams({ ...ok, lockDays: 7 }).lockDays, 7);
  assert.equal(validateParams({ ...ok, burnBps: 2000 }).burnBps, 2000);
  assert.equal(validateParams(ok).burnBps, 0);
  for (const bad of [
    { taxBps: 50 }, { taxBps: 1500 }, { autoLpBps: 6000 }, { symbol: "BAD SYMBOL" }, { name: "" }, { poolTokens: "2000000000" },
    { poolXnt: "0.001" }, { image: "javascript:alert(1)" }, { image: "http://insecure.io/x.png" }, { supply: "12.5" }, { lockDays: 0 },
    { creator: "not-a-key" }, { burnBps: 6000 }, { autoLpBps: 5000, burnBps: 4500 },
  ]) assert.throws(() => validateParams({ ...ok, ...bad }), `should reject ${JSON.stringify(bad)}`);
});
