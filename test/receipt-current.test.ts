import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptAttributes, receiptStillCurrent } from "../src/locker-tx.js";

const base = { symbol: "RVW3", taxPct: 5, split: { holders: 40, liquidity: 25, burn: 25, creator: 10 }, lockedLp: "43,588,989.4354",
  lpSharePct: 99.99, term: "FOREVER", lockedAt: "2026-10-23 22:10:00 UTC" } as never as Parameters<typeof receiptAttributes>[0];
const printed = receiptAttributes(base);

test("a receipt stays current while pool share and LP locked only drift", () => {
  // The vault's first auto-LP deposit: share 99.99% -> 99.39%, LP locked a hair lower after a fee collection.
  assert.ok(receiptStillCurrent(printed, receiptAttributes({ ...base, lpSharePct: 99.39, lockedLp: "43,580,000.0000" })));
  // Exactly the same: current.
  assert.ok(receiptStillCurrent(printed, receiptAttributes(base)));
});

test("a receipt goes out of date when a fact changes or the numbers move a lot", () => {
  assert.equal(receiptStillCurrent(printed, receiptAttributes({ ...base, lpSharePct: 97.9 })), false, "share moved more than 1 point");
  assert.equal(receiptStillCurrent(printed, receiptAttributes({ ...base, lockedLp: "40,000,000.0000" })), false, "LP locked down more than 5%");
  assert.equal(receiptStillCurrent(printed, receiptAttributes({ ...base, term: "UNTIL 2027-01-01 00:00 UTC" })), false, "the lock term");
  assert.equal(receiptStillCurrent(printed, receiptAttributes({ ...base, symbol: "OTHER" })), false, "another token");
  assert.equal(receiptStillCurrent(undefined, receiptAttributes(base)), false, "an old receipt without attributes");
});
