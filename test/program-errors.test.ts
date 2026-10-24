import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PROGRAM_ERRORS, explainError, type ProgramKind } from "../src/program-errors.js";
import { ERRORS } from "../src/taxvault.js";

const VAULT = "D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW", CURVE = "CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY", LOCKER = "5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C";
const programs = new Map<string, ProgramKind>([[VAULT, "vault"], [CURVE, "curve"], [LOCKER, "locker"]]);

test("the error tables match the programs' error enums (names, order and messages)", () => {
  for (const [dir, kind] of [["tax_vault", "vault"], ["bonding_curve", "curve"], ["lp_locker", "locker"]] as const) {
    const src = fs.readFileSync(`lp-locker/programs/${dir}/src/lib.rs`, "utf8");
    const body = /#\[error_code\]\s*pub enum \w+\s*\{([\s\S]*?)\n\}/.exec(src)![1];
    const rust = [...body.matchAll(/#\[msg\("((?:[^"\\]|\\.)*)"\)\]\s*(\w+),/g)].map((m) => [m[2], m[1].replace(/\\(.)/g, "$1")]);
    assert.deepEqual(PROGRAM_ERRORS[kind].map((r) => [...r]), rust, `${dir}: regenerate PROGRAM_ERRORS from its #[msg]s`);
  }
  assert.deepEqual(PROGRAM_ERRORS.vault.map((r) => r[0]), [...ERRORS], "taxvault.ts ERRORS in step");
});

test("a code means what the failing program says it means", () => {
  // 0x1776 = 6006: the curve's Slippage, the vault's NotGuardian.
  assert.equal(explainError(`Simulation failed — Program ${CURVE} failed: custom program error: 0x1776`, programs),
    "The price moved while you were signing. Try again, or allow more slippage. (Slippage)");
  assert.equal(explainError(`Program ${VAULT} failed: custom program error: 0x1776`, programs), "Only the token's creator can do this. (NotGuardian)");
  // No plain wording of its own: the program's message.
  assert.equal(explainError(`Program ${VAULT} failed: custom program error: 0x1777`, programs), `${PROGRAM_ERRORS.vault[7][1]}. (StaleEpoch)`);
  // New codes: the curve's early-window cap and the passes' eviction minimum.
  assert.match(explainError(`Program ${CURVE} failed: custom program error: 0x177e`, programs), /all buyers together can take at most 10%.*\(EarlyWindowFull\)$/);
  assert.match(explainError(`Program ${VAULT} failed: custom program error: 0x17a0`, programs), /twice its balance.*\(EvictTooSmall\)$/);
  assert.match(explainError(`Program ${LOCKER} failed: custom program error: 0x1774`, programs), /doesn't hold the lock NFT\. \(NotNftHolder\)$/);
});

test("Anchor's own log line is used when present (any program, XDEX too)", () => {
  const logs = `Simulation failed: {"InstructionError":[2,{"Custom":6005}]} — Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6005. Error Message: Exceeds desired slippage limit. | Program sEsY failed: custom program error: 0x1775`;
  assert.equal(explainError(logs, programs), "The price moved while you were signing. Try again, or allow more slippage. (ExceededSlippage)");
  const vault = `Program log: AnchorError thrown in programs/tax_vault/src/lib.rs:1200. Error Code: RoundTooSoon. Error Number: 6036. Error Message: Too soon. | Program ${VAULT} failed: custom program error: 0x1794`;
  assert.equal(explainError(vault, programs), "The last holder-pass round was too recent; the next one can run soon. (RoundTooSoon)");
});

test("common non-program failures, and messages left alone", () => {
  assert.match(explainError("Transfer: insufficient lamports 100, need 2000", programs), /doesn't have enough XNT/);
  assert.match(explainError("Attempt to debit an account but found no record of a prior credit.", programs), /doesn't have enough XNT/);
  assert.match(explainError("Blockhash not found", programs), /expired/);
  assert.equal(explainError("Pool XNT must be at least 0.01", programs), "Pool XNT must be at least 0.01");
  assert.equal(explainError("Program Unknown111111111111111111111111111111 failed: custom program error: 0x1", programs).includes("0x1"), true);
});
