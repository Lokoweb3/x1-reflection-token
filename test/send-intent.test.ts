import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, type Connection } from "@solana/web3.js";
import { UNRESOLVED_ALERT_MS, intentVerdict, recordResolution, settleIntent, signed, unresolvedHelp, unresolvedOverdue, whenSigned } from "../src/send-intent.js";
import { confirmByPolling } from "../src/tx.js";
import { mockRpc, rpcError } from "./helpers/mock-rpc.js";

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
  getBlock: async () => ({ blockHeight: 200 }),
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

test("a person's decision counts only when the chain can't answer and the blockhash has expired", async () => {
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

  const inFlight = { ...(conn as object), getBlock: async () => ({ blockHeight: 100 }) } as unknown as Connection;
  assert.equal(await settleIntent(inFlight, intent, { wallet, stateDir }), "pending", "an in-flight transaction isn't overridden");
  const rpcDown = { ...(conn as object), getSlot: async () => { throw new Error("down"); } } as unknown as Connection;
  assert.equal(await settleIntent(rpcDown, intent, { wallet, stateDir }), "unresolved", "expiry not shown: the decision waits");
  const failed = { ...(conn as object), getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [{ confirmationStatus: "finalized", err: {} }] }) } as unknown as Connection;
  assert.equal(await settleIntent(failed, intent, { wallet, stateDir }), "dropped", "the chain's word beats 'landed'");
});

test("scripts/resolve-intent.ts records only a journaled, expired, chain-unanswered intent", async () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "resolve-intent.ts");
  const signature = bs58.encode(Buffer.alloc(64, 9)), walletText = wallet.toBase58();
  const ctx = (value: unknown) => ({ context: { slot: 510 }, value });
  const base: Record<string, () => unknown> = {
    getSignatureStatuses: () => ctx([null]), getSlot: () => 500,
    getBlock: () => ({ blockhash: "x", previousBlockhash: "y", parentSlot: 499, blockTime: 1, blockHeight: 200 }),
    getSignaturesForAddress: () => [],
  };
  const run = async (over: Record<string, () => unknown>, args: string[], stateDir: string) => {
    const rpc = await mockRpc((m) => ({ ...base, ...over })[m]?.());
    const r = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const c = spawn(process.execPath, ["--import", "tsx", script, ...args], { env: { ...process.env, REFLECT_STATE_DIR: stateDir, REFLECT_RPC_URL: rpc.url }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      c.stdout.on("data", (d) => { text += d; });
      c.stderr.on("data", (d) => { text += d; });
      c.on("exit", (code) => resolve({ code, text }));
    });
    await rpc.close();
    return r;
  };
  const journaled = () => {
    const stateDir = state();
    fs.writeFileSync(path.join(stateDir, "limit-orders.json"), JSON.stringify({ order: { spent: "0", pending: { signature, lastValidBlockHeight: 100, at: new Date().toISOString() } } }));
    return stateDir;
  };
  const decisions = (stateDir: string) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, "intent-resolutions.json"), "utf8")); } catch { return null; } };
  const good = [signature, "dropped", "--wallet", walletText];

  for (const args of [[signature, "maybe", "--wallet", walletText], ["short", "landed", "--wallet", walletText], [signature, "landed"]]) {
    const d = journaled(), r = await run({}, args, d);
    assert.equal(r.code, 1, r.text);
    assert.equal(decisions(d), null);
  }
  const none = state();
  const missing = await run({}, good, none);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /no peg or limit trade/);

  let d = journaled(), r = await run({ getBlock: () => ({ blockhash: "x", previousBlockhash: "y", parentSlot: 499, blockTime: 1, blockHeight: 100 }) }, good, d);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /may still land/, "within the blockhash");
  assert.equal(decisions(d), null);

  d = journaled(); r = await run({ getSlot: () => rpcError(-32000, "down") }, good, d);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /can't confirm its blockhash has expired/);
  assert.equal(decisions(d), null);

  d = journaled(); r = await run({ getSignatureStatuses: () => ctx([{ slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }]) }, good, d);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /the chain says landed/);
  assert.equal(decisions(d), null);

  d = journaled(); r = await run({}, good, d);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(decisions(d), { [signature]: "dropped" });

  // A node with full history answers what the bot's RPC can't: that has to reach the bot.
  const status = (confirmationStatus: string, err: unknown = null) => ({ getSignatureStatuses: () => ctx([{ slot: 1, confirmations: null, err, confirmationStatus }]) });
  d = journaled(); r = await run(status("finalized"), [signature, "landed", "--wallet", walletText], d);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(decisions(d), { [signature]: "landed" }, "finalized landed");
  d = journaled(); r = await run(status("finalized", { InstructionError: [0, "x"] }), good, d);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(decisions(d), { [signature]: "dropped" }, "finalized failed");
  d = journaled(); r = await run({ getSignaturesForAddress: () => [{ signature: bs58.encode(Buffer.alloc(64, 4)), slot: 1, blockTime: 1_000, err: null, memo: null, confirmationStatus: "finalized" }] }, good, d);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(decisions(d), { [signature]: "dropped" }, "proven never landed");
  d = journaled(); r = await run(status("confirmed"), [signature, "landed", "--wallet", walletText], d);
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /not finalized/);
  assert.equal(decisions(d), null, "confirmed isn't enough");
});

test("an unresolved intent stays quiet briefly, then the alert says how to get out", () => {
  const at = new Date(1_800_000_000_000).toISOString(), t = Date.parse(at);
  assert.equal(unresolvedOverdue({ at }, t + UNRESOLVED_ALERT_MS - 1), false);
  assert.equal(unresolvedOverdue({ at }, t + UNRESOLVED_ALERT_MS), true);
  assert.equal(unresolvedOverdue({}, t), true, "no time on it: say so now");
  assert.ok(unresolvedHelp("SIG", wallet).includes(`scripts/resolve-intent.ts SIG landed|dropped --wallet ${wallet.toBase58()}`));
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
