// bridgeSendFate against modelled RPC answers, each method as a different node might answer. No network, no bridge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection } from "@solana/web3.js";
import { bridgeSendFate } from "../src/bridge-journal.js";

const wallet = Keypair.generate().publicKey, outgoing = Keypair.generate().publicKey.toBase58();
const createdAt = new Date(1_800_000_000_000).toISOString();
const e = { signature: "SIG", createdAt, lastValidBlockHeight: 100, outgoing };
const covering = [{ signature: "OLD", blockTime: 1_700_000_000, err: null }];

function chain(over: Record<string, unknown> = {}) {
  return {
    getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }),
    getSlot: async () => 500,
    getBlockHeight: async () => 200,
    getSignaturesForAddress: async () => covering,
    getAccountInfoAndContext: async () => ({ context: { slot: 505 }, value: null }),
    ...over,
  } as unknown as Connection;
}
const behind = async () => { throw new Error("Minimum context slot has not been reached"); };

test("failed only on proof: finalized expiry, covered history, and no outgoing account at least that recent", async () => {
  const seen: unknown[] = [];
  const conn = chain({ getAccountInfoAndContext: async (_: unknown, c: unknown) => { seen.push(c); return { context: { slot: 505 }, value: null }; } });
  assert.deepEqual(await bridgeSendFate(conn, e, wallet), { kind: "never-landed" });
  assert.deepEqual(seen, [{ commitment: "finalized", minContextSlot: 500 }]);
});

test("moved funds on a load-balanced RPC stay pending: each stale answer alone holds the next bridge back", async () => {
  const stale: [string, Connection][] = [
    ["account read from a node behind the expiry", chain({ getAccountInfoAndContext: behind })],
    ["account read answering from an older context", chain({ getAccountInfoAndContext: async () => ({ context: { slot: 499 }, value: null }) })],
    ["outgoing account exists", chain({ getAccountInfoAndContext: async () => ({ context: { slot: 505 }, value: { lamports: 1 } }) })],
    ["history from a node behind", chain({ getSignaturesForAddress: behind })],
    ["history that doesn't reach the send", chain({ getSignaturesForAddress: async () => [] })],
    ["not expired on finalized state, though a newer node says so", chain({ getBlockHeight: async () => 100 })],
    ["status from a node behind", chain({ getSignatureStatuses: async () => ({ context: { slot: 400 }, value: [null] }) })],
  ];
  for (const [name, conn] of stale) assert.equal((await bridgeSendFate(conn, e, wallet)).kind, "wait", name);
});

test("an entry journaled without its block height or outgoing account is never failed automatically", async () => {
  assert.equal((await bridgeSendFate(chain(), { signature: "SIG", createdAt, outgoing }, wallet)).kind, "wait");
  assert.equal((await bridgeSendFate(chain(), { signature: "SIG", createdAt, lastValidBlockHeight: 100 }, wallet)).kind, "wait");
});

test("found in the wallet's finalized history: landed or failed as it shows; a merely confirmed status waits", async () => {
  const list = (err: unknown) => chain({ getSignaturesForAddress: async () => [{ signature: "SIG", blockTime: 1_800_000_000, err }] });
  assert.deepEqual(await bridgeSendFate(list(null), e, wallet), { kind: "landed" });
  assert.deepEqual(await bridgeSendFate(list({}), e, wallet), { kind: "failed" });
  const confirmed = chain({ getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [{ confirmationStatus: "confirmed", err: null }] }) });
  assert.equal((await bridgeSendFate(confirmed, e, wallet)).kind, "wait");
});
