import { test } from "node:test";
import assert from "node:assert/strict";
import { isqrt, poolLockProblem } from "../src/factory/launch.js";

// 1B tokens (9 decimals) and 10 XNT, 5% tax: what the site's pool step puts in.
const T = 1_000_000_000n * 10n ** 9n, X = 10n * 10n ** 9n, tax = 500;
// After the deposit the pool holds 95% of the tokens (the tax is withheld on the way in).
const honest = { poolTokens: T, poolQuote: X, taxBps: tax, reserveToken: T * 95n / 100n, reserveQuote: X, lockedLp: isqrt(T * 95n / 100n * X) - 100n };

test("an honest launch passes, also after trading moved the reserves", () => {
  assert.equal(poolLockProblem(honest), null);
  // A buy of 3 XNT: XNT in, tokens out; the product grows by the trading fee.
  const k = honest.reserveToken * honest.reserveQuote;
  assert.equal(poolLockProblem({ ...honest, reserveQuote: 13n * 10n ** 9n, reserveToken: k / (13n * 10n ** 9n) }), null);
  // A sell pushes tokens in and XNT out: same.
  assert.equal(poolLockProblem({ ...honest, reserveQuote: 7n * 10n ** 9n, reserveToken: k / (7n * 10n ** 9n) + 1n }), null);
});

test("a pool built with a sliver of the supply is refused", () => {
  const sliver = T / 100n;
  const lp = isqrt(sliver * 95n / 100n * X);
  assert.match(poolLockProblem({ ...honest, reserveToken: sliver * 95n / 100n, lockedLp: lp }) ?? "", /holds less than the launch put in/);
});

test("liquidity taken out before the lock is refused", () => {
  // 99% of the LP withdrawn, the rest locked: reserves and LP both fall to 1%.
  assert.match(poolLockProblem({ ...honest, reserveToken: honest.reserveToken / 100n, reserveQuote: X / 100n, lockedLp: honest.lockedLp / 100n }) ?? "", /holds less/);
  // Even 5% out is too much.
  assert.match(poolLockProblem({ ...honest, reserveToken: honest.reserveToken * 95n / 100n, reserveQuote: X * 95n / 100n, lockedLp: honest.lockedLp * 95n / 100n }) ?? "", /holds less/);
});

test("a lock that holds only part of the LP is refused", () => {
  assert.match(poolLockProblem({ ...honest, lockedLp: honest.lockedLp / 2n }) ?? "", /whole LP must be locked/);
  assert.match(poolLockProblem({ ...honest, lockedLp: 0n }) ?? "", /whole LP must be locked/);
});

test("integer square root", () => {
  for (const n of [0n, 1n, 2n, 15n, 16n, 17n, 10n ** 30n, 10n ** 30n - 1n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, String(n));
  }
});

test("rate limits count an IPv6 address by its /64", async () => {
  const { limitKey } = await import("../src/factory/limits.js");
  assert.equal(limitKey("203.0.113.7"), "203.0.113.7");
  assert.equal(limitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:0db8:0001:0002::5"), "2001:db8:1:2::/64");
  assert.equal(limitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(limitKey("2001:DB8:1:2::ffff"), limitKey("2001:db8:1:2:9:9:9:9"));
  assert.equal(limitKey("forwarded 127.0.0.1"), "forwarded 127.0.0.1");
});
