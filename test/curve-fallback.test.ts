import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { REFUSALS_NEEDED, REFUSAL_SPAN_SECS, RefusalWatch, chainRefusal } from "../src/factory/curve-fallback.js";

const curve = Keypair.generate().publicKey;
const locker = "5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C";
const failed = (id: string, why: string) => `Program ${id} failed: ${why}`;
const custom = (code: number) => ({ InstructionError: [2, { Custom: code }] });

test("a program refusing the step counts as a refusal", () => {
  // lp_locker's own error, then the curve program passing it on.
  assert.equal(chainRefusal(custom(6001), [failed(locker, "custom program error: 0x1771"), failed(curve.toBase58(), "custom program error: 0x1771")], curve), `${locker}: custom 6001`);
  // A framework error, but lp_locker's: it refuses what the curve program sent it.
  assert.equal(chainRefusal(custom(2003), [failed(locker, "custom program error: 0x7d3")], curve), `${locker}: custom 2003`);
  // lp_locker closed: these are the logs a local validator gave for it.
  assert.equal(chainRefusal({ InstructionError: [1, "UnsupportedProgramId"] }, [failed(locker, "Unsupported program id"), failed(curve.toBase58(), "Unsupported program id")], curve), `${locker}: "UnsupportedProgramId"`);
  // Non-custom errors from the curve program itself say nothing about the locker.
  assert.equal(chainRefusal({ InstructionError: [1, "MissingAccount"] }, [failed(curve.toBase58(), "missing account")], curve), null);
  assert.equal(chainRefusal({ InstructionError: [2, "ProgramFailedToComplete"] }, [failed(locker, "Program failed to complete")], curve), `${locker}: "ProgramFailedToComplete"`);
  // The curve program's own refusal, e.g. no locker deployed.
  assert.equal(chainRefusal(custom(6019), [failed(curve.toBase58(), "custom program error: 0x178b")], curve), `${curve.toBase58()}: custom 6019`);
});

test("nothing else counts: not transport, fees, budgets or mismatched requests", () => {
  assert.equal(chainRefusal(null, [], curve), null);
  assert.equal(chainRefusal("BlockhashNotFound", [], curve), null);
  assert.equal(chainRefusal("InsufficientFundsForFee", [], curve), null);
  assert.equal(chainRefusal("AccountNotFound", null, curve), null);
  assert.equal(chainRefusal(custom(6001), null, curve), null, "no logs: can't tell who failed");
  assert.equal(chainRefusal(custom(6001), [], curve), null);
  // Out of compute: our limit, not the program's answer.
  assert.equal(chainRefusal({ InstructionError: [2, "ComputationalBudgetExceeded"] }, [failed(locker, "x")], curve), null);
  assert.equal(chainRefusal({ InstructionError: [2, "ProgramFailedToComplete"] }, ["Program x consumed 1000000 of 1000000 compute units", "exceeded CUs meter at BPF instruction", failed(locker, "x")], curve), null);
  // Our request doesn't suit this program (old client, new program or the reverse).
  assert.equal(chainRefusal(custom(101), [failed(curve.toBase58(), "custom program error: 0x65")], curve), null, "unknown instruction");
  assert.equal(chainRefusal(custom(3005), [failed(curve.toBase58(), "custom program error: 0xbbd")], curve), null, "too few accounts");
  // The state moved on, or anyone can top auth up and retry.
  assert.equal(chainRefusal(custom(6009), [failed(curve.toBase58(), "x")], curve), null, "WrongStatus");
  assert.equal(chainRefusal(custom(6012), [failed(curve.toBase58(), "x")], curve), null, "InsufficientReserve");
});

test("one sighting is never enough, nor several within a moment", () => {
  const w = new RefusalWatch();
  assert.equal(REFUSALS_NEEDED, 2);
  assert.equal(w.note("k", "a", 1_000), false, "first sighting");
  assert.equal(w.note("k", "a", 1_001), false, "second, a second later");
  assert.equal(w.note("k", "a", 1_000 + REFUSAL_SPAN_SECS - 1), false);
  assert.equal(w.note("k", "a", 1_000 + REFUSAL_SPAN_SECS), true);
});

test("a different refusal, a non-refusal or a success starts over", () => {
  const w = new RefusalWatch();
  w.note("k", "a", 0);
  assert.equal(w.note("k", "b", 100), false, "another failure isn't a repeat");
  assert.equal(w.note("k", "b", 100 + REFUSAL_SPAN_SECS), true);
  w.note("k", null, 200);
  assert.equal(w.note("k", "b", 300), false);
  w.clear("k");
  assert.equal(w.note("k", "b", 300 + REFUSAL_SPAN_SECS), false);
  // Each step and curve counts for itself.
  w.note("x", "a", 0);
  assert.equal(w.note("y", "a", 1_000), false);
});
