import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedAnalytics } from "../src/factory/analytics-scope.js";

test("two tokens' payouts and burns stay separate, including cached platform results", async () => {
  const tokens = [{ mint: "TEST", paid: 12, burns: 2 }, { mint: "OTHER", paid: 900, burns: 40 }];
  let calls = 0, now = 0;
  const analytics = scopedAnalytics(() => tokens, async (selected) => {
    calls++;
    return selected.reduce((sum, t) => ({ paid: sum.paid + t.paid, burns: sum.burns + t.burns }), { paid: 0, burns: 0 });
  }, () => now);
  assert.deepEqual(await analytics(), { paid: 912, burns: 42 });
  assert.deepEqual(await analytics("TEST"), { paid: 12, burns: 2 });
  assert.deepEqual(await analytics("OTHER"), { paid: 900, burns: 40 });
  tokens[0].paid = 20;
  assert.deepEqual(await analytics("TEST"), { paid: 12, burns: 2 });
  assert.deepEqual(await analytics(), { paid: 912, burns: 42 });
  assert.equal(calls, 3);
  now = 30_000;
  assert.deepEqual(await analytics("TEST"), { paid: 20, burns: 2 });
  assert.deepEqual(await analytics(), { paid: 920, burns: 42 });
  assert.throws(() => analytics("missing"), /Unknown analytics mint/);
  assert.throws(() => analytics(""), /Unknown analytics mint/);
});

test("a failed request can retry without evicting a newer request for the same token", async () => {
  let now = 0, calls = 0;
  let rejectFirst!: (error: Error) => void;
  const analytics = scopedAnalytics(() => [{ mint: "TEST" }], async () => {
    if (++calls === 1) return new Promise<number>((_, reject) => { rejectFirst = reject; });
    return 42;
  }, () => now);
  const first = analytics("TEST");
  assert.equal(analytics("TEST"), first, "concurrent requests share the pending result");
  now = 30_000;
  assert.equal(await analytics("TEST"), 42);
  rejectFirst(new Error("upstream failed"));
  await assert.rejects(first, /upstream failed/);
  assert.equal(await analytics("TEST"), 42);
  assert.equal(calls, 2);

  let attempts = 0;
  const retry = scopedAnalytics(() => [{ mint: "TEST" }], async () => {
    if (++attempts === 1) throw new Error("temporary failure");
    return 7;
  });
  await assert.rejects(retry("TEST"), /temporary failure/);
  assert.equal(await retry("TEST"), 7);
});
