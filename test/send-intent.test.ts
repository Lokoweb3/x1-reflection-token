import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, type Connection } from "@solana/web3.js";
import { UNRESOLVED_ALERT_MS, intentVerdict, recordResolution, settleIntent, signed, unresolvedHelp, unresolvedOverdue, whenSigned } from "../src/send-intent.js";
import { confirmByPolling } from "../src/tx.js";

test("a journaled intent settles by what became of its transaction", () => {
  const i = { signature: "sig", lastValidBlockHeight: 5 };
  assert.equal(intentVerdict({}, null), "dropped", "no signature: never broadcast");
  assert.equal(intentVerdict(i, "landed"), "landed");
  assert.equal(intentVerdict(i, "failed"), "dropped");
  assert.equal(intentVerdict(i, "never-landed"), "dropped");
  assert.equal(intentVerdict(i, "in-flight"), "pending");
  assert.equal(intentVerdict(i, "unknown"), "unresolved", "no proof: never forgotten");
});

// A trade that landed before a crash, on a lagging or history-limited RPC: the case that used to read as "expired".
const wallet = Keypair.generate().publicKey;
const state = () => fs.mkdtempSync(path.join(os.tmpdir(), "intent-"));
const intent = { signature: "SIG", lastValidBlockHeight: 100, at: new Date(1_800_000_000_000).toISOString() };
const noStatusPastExpiry = (list: unknown) => ({
  getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }),
  getSlot: async () => 500,
  getBlockHeight: async () => 200,
  getSignaturesForAddress: list,
}) as unknown as Connection;

test("no status past its blockhash doesn't clear an intent: the chain must prove it, or a person decides", async () => {
  const stateDir = state();
  const historyLimited = noStatusPastExpiry(async () => []);
  assert.equal(await settleIntent(historyLimited, intent, { wallet, stateDir }), "unresolved");
  const lagging = noStatusPastExpiry(async () => { throw new Error("Minimum context slot has not been reached"); });
  assert.equal(await settleIntent(lagging, intent, { wallet, stateDir }), "unresolved");
  const covered = noStatusPastExpiry(async () => [{ signature: "OLD", blockTime: 1_700_000_000, err: null }]);
  assert.equal(await settleIntent(covered, intent, { wallet, stateDir }), "dropped", "proof");
});

test("a person's decision clears it, without trusting the chain, and only for that signature", async () => {
  const stateDir = state();
  const conn = noStatusPastExpiry(async () => []);
  recordResolution(stateDir, "SIG", "landed");
  assert.equal(await settleIntent(conn, intent, { wallet, stateDir }), "landed");
  recordResolution(stateDir, "OTHER", "dropped");
  assert.equal(await settleIntent(conn, intent, { wallet, stateDir }), "landed", "the earlier decision is kept");
  assert.equal(await settleIntent(conn, { ...intent, signature: "THIRD" }, { wallet, stateDir }), "unresolved");
  const garbled = state();
  fs.writeFileSync(path.join(garbled, "intent-resolutions.json"), "{ torn");
  assert.equal(await settleIntent(conn, intent, { wallet, stateDir: garbled }), "unresolved", "an unreadable decision is no decision");
});

test("scripts/resolve-intent.ts records a decision and refuses anything else", () => {
  const stateDir = state(), script = path.join(import.meta.dirname, "..", "scripts", "resolve-intent.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env: { ...process.env, REFLECT_STATE_DIR: stateDir } });
  const signature = bs58.encode(Buffer.alloc(64, 9));
  assert.equal(run(signature, "maybe").status, 1);
  assert.equal(run("short", "landed").status, 1);
  assert.equal(fs.existsSync(path.join(stateDir, "intent-resolutions.json")), false);
  const ok = run(signature, "dropped");
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "intent-resolutions.json"), "utf8")), { [signature]: "dropped" });
});

test("an unresolved intent stays quiet briefly, then the alert says how to get out", () => {
  const at = new Date(1_800_000_000_000).toISOString(), t = Date.parse(at);
  assert.equal(unresolvedOverdue({ at }, t + UNRESOLVED_ALERT_MS - 1), false);
  assert.equal(unresolvedOverdue({ at }, t + UNRESOLVED_ALERT_MS), true);
  assert.equal(unresolvedOverdue({}, t), true, "no time on it: say so now");
  assert.ok(unresolvedHelp("SIG").includes("scripts/resolve-intent.ts SIG landed|dropped"));
});

test("the sender tells the caller's hook the signature, and only inside its own send", async () => {
  const seen: string[] = [];
  const fakeSend = async () => { await new Promise((r) => setTimeout(r, 1)); signed("abc", 7); return "abc"; };
  assert.equal(await whenSigned((s, h) => seen.push(`${s}@${h}`), fakeSend), "abc");
  await fakeSend();
  assert.deepEqual(seen, ["abc@7"]);
});

test("confirmByPolling gives up at its deadline even when the RPC never answers", async () => {
  const hang = () => new Promise<never>(() => undefined);
  const conn = { getSignatureStatuses: hang, getBlockHeight: hang, sendRawTransaction: hang } as unknown as Connection;
  await assert.rejects(confirmByPolling(conn, Buffer.alloc(0), "sig", 1e9, 50), /not confirmed within/);
});
