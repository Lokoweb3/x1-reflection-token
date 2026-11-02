// fateOfSend against modelled RPC answers: each method can answer as a different node would. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection } from "@solana/web3.js";
import { CLOCK_SKEW_MS, fateOfSend } from "../src/send-fate.js";

const wallet = Keypair.generate().publicKey;
const NOW = 1_800_000_000_000;
const sent = { signature: "SIG", lastValidBlockHeight: 100, wallet, sentAt: NOW };
const older = { signature: "OLD", blockTime: (NOW - CLOCK_SKEW_MS - 1_000) / 1000, err: null };
const newer = { signature: "NEW", blockTime: (NOW + 60_000) / 1000, err: null };

/** A node at finalized slot 500, whose block has height 200, with the wallet's history reaching back past the send and no sign of it. */
function chain(over: Record<string, unknown> = {}) {
  return {
    getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }),
    getSlot: async () => 500,
    getBlock: async () => ({ blockHeight: 200 }),
    getSignaturesForAddress: async () => [newer, older],
    ...over,
  } as unknown as Connection;
}
const behind = async () => { throw new Error("Minimum context slot has not been reached"); };

test("proof: expired on finalized state, no status at that slot, and the wallet's history covers the send", async () => {
  assert.deepEqual(await fateOfSend(chain(), sent), { fate: "never-landed", provenAt: 500 });
});

test("a status decides it, without any proof needed", async () => {
  const st = (s: unknown) => chain({ getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [s] }) });
  assert.deepEqual(await fateOfSend(st({ confirmationStatus: "finalized", err: null }), sent), { fate: "landed", finalized: true });
  assert.deepEqual(await fateOfSend(st({ confirmationStatus: "confirmed", err: null }), sent), { fate: "landed", finalized: false });
  assert.deepEqual(await fateOfSend(st({ confirmationStatus: "finalized", err: {} }), sent), { fate: "failed", finalized: true });
  assert.equal((await fateOfSend(st({ confirmationStatus: "processed", err: null }), sent)).fate, "in-flight");
});

test("not expired on finalized state: can still land", async () => {
  assert.equal((await fateOfSend(chain({ getBlock: async () => ({ blockHeight: 100 }) }), sent)).fate, "in-flight");
});

test("a newer node's height doesn't prove expiry at the anchor block: it may land after that block, where a laggard can't see it", async () => {
  // Finalized block 500 is still within the blockhash. A newer node says the height is past it, and everything from a node
  // at exactly 500 shows nothing, because the transaction landed at 600. That must not read as never landed.
  const conn = chain({ getBlock: async () => ({ blockHeight: 95 }), getBlockHeight: async () => 200 });
  assert.equal((await fateOfSend(conn, sent)).fate, "in-flight");
});

test("the anchor is the block at the finalized slot, at finalized commitment; no block or no height there proves nothing", async () => {
  const asked: unknown[] = [];
  await fateOfSend(chain({ getBlock: async (slot: number, c: { commitment: string; transactionDetails: string }) => { asked.push([slot, c.commitment, c.transactionDetails]); return { blockHeight: 200 }; } }), sent);
  assert.deepEqual(asked, [[500, "finalized", "none"]]);
  for (const [name, getBlock] of [["no block", async () => null], ["no height", async () => ({ blockHeight: null })], ["not available", behind]] as const)
    assert.deepEqual(await fateOfSend(chain({ getBlock }), sent).then((f) => [f.fate, (f as { expired?: boolean }).expired]), ["unknown", false], name);
});

test("unknown says whether the blockhash was shown expired", async () => {
  assert.equal(((await fateOfSend(chain({ getSignaturesForAddress: async () => [] }), sent)) as { expired: boolean }).expired, true);
  assert.equal(((await fateOfSend(chain({ getSlot: behind }), sent)) as { expired: boolean }).expired, false);
});

test("the reads require a context at least as recent as the expiry", async () => {
  const seen: unknown[] = [];
  await fateOfSend(chain({
    getSignaturesForAddress: async (_: unknown, c: { minContextSlot: number }, commitment: string) => { seen.push([c.minContextSlot, commitment]); return [newer, older]; },
  }), sent);
  assert.deepEqual(seen, [[500, "finalized"]]);
});

test("a landed transaction, a lagging or history-limited node: never proof that it didn't", async () => {
  const cases: [string, Connection][] = [
    ["status from a node behind the expiry", chain({ getSignatureStatuses: async () => ({ context: { slot: 499 }, value: [null] }) })],
    ["history from a node behind the expiry", chain({ getSignaturesForAddress: behind })],
    ["anchor block from a node behind", chain({ getBlock: behind })],
    ["history empty", chain({ getSignaturesForAddress: async () => [] })],
    ["history stops after the send", chain({ getSignaturesForAddress: async () => [newer] })],
    ["history reaches only just before the send: the clock might be off", chain({ getSignaturesForAddress: async () => [{ ...older, blockTime: (NOW - 1_000) / 1000 }] })],
    ["no block time", chain({ getSignaturesForAddress: async () => [{ ...older, blockTime: null }] })],
    ["RPC down", chain({ getSlot: behind })],
  ];
  for (const [name, conn] of cases) assert.equal((await fateOfSend(conn, sent)).fate, "unknown", name);
});

test("no block height or send time journaled: can't be proven", async () => {
  assert.equal((await fateOfSend(chain(), { ...sent, lastValidBlockHeight: undefined })).fate, "unknown");
  assert.equal((await fateOfSend(chain(), { ...sent, sentAt: NaN })).fate, "unknown");
});

test("the wallet's history can show it landed where the status lookup can't", async () => {
  assert.deepEqual(await fateOfSend(chain({ getSignaturesForAddress: async () => [newer, { signature: "SIG", blockTime: NOW / 1000, err: null }, older] }), sent), { fate: "landed", finalized: true });
  assert.deepEqual(await fateOfSend(chain({ getSignaturesForAddress: async () => [{ signature: "SIG", blockTime: NOW / 1000, err: {} }] }), sent), { fate: "failed", finalized: true });
});

test("it pages back, within reason", async () => {
  const full = (sig: string) => Array.from({ length: 1000 }, (_, i) => ({ ...newer, signature: `${sig}${i}` }));
  let pages = 0;
  const paged = chain({ getSignaturesForAddress: async (_: unknown, c: { before?: string }) => { pages++; return c.before === "p1999" ? [older] : c.before === "p0999" ? [] : c.before ? [older] : full("p"); } });
  assert.equal((await fateOfSend(paged, sent)).fate, "never-landed");
  assert.equal(pages, 2);
  assert.equal((await fateOfSend(chain({ getSignaturesForAddress: async () => full("q") }), sent)).fate, "unknown", "a wallet too busy to page back");
});
