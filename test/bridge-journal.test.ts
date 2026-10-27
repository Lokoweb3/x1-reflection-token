import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeSendNeverLanded } from "../src/bridge-journal.js";

test("a bridge send is failed only after its blockhash expired with nothing debited", () => {
  const e = { lastValidBlockHeight: 100 };
  assert.equal(bridgeSendNeverLanded(e, { landed: false, blockHeight: 101, debited: false }), true);
  assert.equal(bridgeSendNeverLanded(e, { landed: false, blockHeight: 100, debited: false }), false, "can still land");
  assert.equal(bridgeSendNeverLanded(e, { landed: false, blockHeight: 101, debited: true }), false, "the tokens were taken");
  assert.equal(bridgeSendNeverLanded(e, { landed: true, blockHeight: 101, debited: false }), false, "it has a status");
});

test("an entry journaled without its block height is never failed automatically", () => {
  assert.equal(bridgeSendNeverLanded({}, { landed: false, blockHeight: 1e9, debited: false }), false);
});
