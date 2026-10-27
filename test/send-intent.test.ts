import { test } from "node:test";
import assert from "node:assert/strict";
import { intentVerdict, signed, whenSigned } from "../src/send-intent.js";
import { confirmByPolling } from "../src/tx.js";
import type { Connection } from "@solana/web3.js";

test("a journaled intent settles by its transaction's outcome", () => {
  const i = { signature: "sig", lastValidBlockHeight: 5 };
  assert.equal(intentVerdict({}, null), "dropped", "no signature: never broadcast");
  assert.equal(intentVerdict(i, "confirmed"), "landed");
  assert.equal(intentVerdict(i, "failed"), "dropped");
  assert.equal(intentVerdict(i, "expired"), "dropped");
  assert.equal(intentVerdict(i, "pending"), "pending");
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
