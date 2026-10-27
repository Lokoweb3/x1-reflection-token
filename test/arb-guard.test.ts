import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BURN_MAX_RAW, FeeCap, RouteFailures, dustVerdict, maxTxFee } from "../src/arb-guard.js";

const MIN = 60_000;

test("5 failed sends in a row within 10 minutes skip the route for an hour", () => {
  const f = new RouteFailures();
  for (let i = 0; i < 4; i++) assert.equal(f.fail("r", i * MIN), false);
  assert.equal(f.skipped("r", 4 * MIN), false);
  assert.equal(f.fail("r", 4 * MIN), true, "the fifth failure trips it");
  assert.equal(f.skipped("r", 5 * MIN), true);
  assert.equal(f.skipped("other", 5 * MIN), false, "other routes go on");
  assert.equal(f.skipped("r", 4 * MIN + 60 * MIN - 1), true);
  assert.equal(f.skipped("r", 4 * MIN + 60 * MIN), false, "back after an hour");
});

test("a success, or failures spread over more than 10 minutes, don't trip it", () => {
  const f = new RouteFailures();
  for (let i = 0; i < 4; i++) f.fail("r", i * MIN);
  f.ok("r");
  assert.equal(f.fail("r", 5 * MIN), false, "the run started over");
  const g = new RouteFailures();
  for (let i = 0; i < 10; i++) assert.equal(g.fail("r", i * 3 * MIN), false, `failure ${i}`);
});

test("the fee cap counts the last 24 hours and survives a restart", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fees-")), "arb-fees.json");
  const cap = new FeeCap(1_000n, file);
  cap.add(600n, 0);
  assert.equal(cap.reached(1), false);
  cap.add(400n, 10);
  assert.equal(cap.reached(11), true);
  const again = new FeeCap(1_000n, file);
  assert.equal(again.reached(12), true, "read back from the file");
  assert.equal(again.spent(24 * 3_600_000 + 5), 400n, "the first fee aged out");
  assert.equal(again.reached(24 * 3_600_000 + 5), false);
});

test("a transaction's most fee: base fee plus priority on the whole compute limit, rounded up", () => {
  assert.equal(maxTxFee(1, 200_000, 1_000), 5_200n);
  assert.equal(maxTxFee(1, 1, 1), 5_001n);
});

test("close-dust burns only what is worthless and tiny in raw terms", () => {
  assert.equal(dustVerdict(10n, 9, 10n, 1_000_000n), "burn");
  assert.equal(dustVerdict(10n, 9, 1_000_000n, 1_000_000n), "worth selling");
  assert.equal(dustVerdict(BURN_MAX_RAW + 1n, 9, 0n, 1_000_000n), "too much to burn", "over the raw cap, even if priced at nothing");
  assert.equal(dustVerdict(1_000n, 6, null, 1_000_000n), "burn", "unpriced, a thousandth of a token");
  assert.equal(dustVerdict(1_001n, 6, null, 1_000_000n), "too much to burn");
});
