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

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** `auth` short for an account the lock creates, as the runtime logs it: the system program in a CPI, under lp_locker, under the curve. */
const shortOfLamports = [
  `Program ${curve.toBase58()} invoke [1]`,
  `Program ${locker} invoke [2]`,
  `Program ${SYSTEM} invoke [3]`,
  "Transfer: insufficient lamports 1000, need 2039280",
  failed(SYSTEM, "custom program error: 0x1"),
  failed(locker, "custom program error: 0x1"),
  failed(curve.toBase58(), "custom program error: 0x1"),
];

test("short of funds, at whatever depth, proves nothing: anyone can top up and the step works", () => {
  assert.equal(chainRefusal(custom(1), shortOfLamports, curve), null, "system program, under a CPI");
  assert.equal(chainRefusal(custom(1), [failed(SYSTEM, "custom program error: 0x1")], curve), null, "by its code, without the Transfer line");
  assert.equal(chainRefusal(custom(1), ["Transfer: insufficient lamports 5, need 9", failed(locker, "custom program error: 0x1")], curve), null, "by the line, whoever reports it");
  for (const token of [TOKEN, TOKEN_2022]) {
    assert.equal(chainRefusal(custom(1), [`Program ${token} invoke [3]`, "Program log: Error: insufficient funds", failed(token, "custom program error: 0x1"), failed(locker, "custom program error: 0x1")], curve), null, `${token} by its log`);
    assert.equal(chainRefusal(custom(1), [failed(token, "custom program error: 0x1")], curve), null, `${token} by its code`);
    assert.equal(chainRefusal(custom(0), [failed(token, "custom program error: 0x0")], curve), null, `${token}: account below rent`);
  }
  // The runtime's own error for a program taking more lamports than an account has.
  assert.equal(chainRefusal({ InstructionError: [2, "InsufficientFunds"] }, [failed(locker, "insufficient funds for instruction")], curve), null);
  assert.equal(chainRefusal({ InstructionError: [2, "AccountNotRentExempt"] }, [failed(locker, "account does not have enough lamports to be rent exempt")], curve), null);
  // An unrecognised system program failure stays on the side of not burning.
  assert.equal(chainRefusal(custom(7), [failed(SYSTEM, "custom program error: 0x7")], curve), null);
  assert.equal(chainRefusal({ InstructionError: [2, "MissingRequiredSignature"] }, [failed(SYSTEM, "missing required signature for instruction")], curve), null);
  // A failure log in a form this code doesn't know names no program, so it isn't a refusal.
  assert.equal(chainRefusal(custom(1), [`Program ${SYSTEM} error: 0x1`], curve), null);
});

test("what still counts near those: an account already taken, and other programs' code 1", () => {
  // Somebody else created the pool first: the system program won't create it again, top-up or not. Graduation's way out is the refund.
  assert.equal(chainRefusal(custom(0), [`Create Account: account Address { address: x, base: None } already in use`, failed(SYSTEM, "custom program error: 0x0"), failed(locker, "custom program error: 0x0")], curve), `${SYSTEM}: custom 0`);
  // A token program's refusal that money can't fix (OwnerMismatch), and code 1 of another program, which means something else.
  assert.equal(chainRefusal(custom(4), [failed(TOKEN, "custom program error: 0x4")], curve), `${TOKEN}: custom 4`);
  assert.equal(chainRefusal(custom(1), [failed(locker, "custom program error: 0x1")], curve), `${locker}: custom 1`);
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
