/** A view cache entry past its freshness is refreshed like a new one: asked for, and read, once. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshCache } from "../src/factory/fresh-cache.js";

test("fresh answers are free; an expired one is one admission and one read, however many ask", async (t) => {
  let at = Date.now(), loads = 0, admissions = 0;
  t.mock.method(Date, "now", () => at);
  const c = freshCache<number>(30_000, 10);
  const admit = () => { admissions++; return true; };
  const load = async () => { await new Promise((r) => setTimeout(r, 5)); return ++loads; };
  const busy = () => new Error("busy");
  assert.equal(await c.get("a", admit, busy, load), 1);
  assert.equal(await c.get("a", admit, busy, load), 1);
  assert.deepEqual([loads, admissions], [1, 1]);
  at += 30_001;
  assert.deepEqual(await Promise.all(Array.from({ length: 120 }, () => c.get("a", admit, busy, load))), Array(120).fill(2));
  assert.deepEqual([loads, admissions], [2, 2]);
});

test("refused: an expired entry isn't served or read; a failed read isn't kept", async (t) => {
  let at = Date.now(), fail = false;
  t.mock.method(Date, "now", () => at);
  const c = freshCache<number>(1_000, 10);
  const busy = () => new Error("busy");
  const load = async () => { if (fail) throw new Error("rpc"); return 7; };
  await c.get("a", () => true, busy, load);
  at += 1_001;
  await assert.rejects(c.get("a", () => false, busy, load), /busy/);
  fail = true;
  await assert.rejects(c.get("a", () => true, busy, load), /rpc/);
  fail = false;
  assert.equal(await c.get("a", () => true, busy, load), 7);
});
