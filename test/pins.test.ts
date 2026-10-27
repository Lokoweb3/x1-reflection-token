/**
 * Pins made for a transaction that never landed are removed from Pinata; anything in use, a
 * file pinned twice, or one whose check fails, is kept. Gateway reads stop at a byte cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { fetchFromGateways, pinJson, readCapped } from "../src/factory/ipfs.js";
import { pinTracker } from "../src/factory/pins.js";

const cfg = { network: "testnet", factory: { feeReceiver: "x", feeUsdc: "1", pinataJwt: "secret" } } as unknown as Config;
const GW = "https://gateway.pinata.cloud/ipfs/";
const cidOf = (n: number) => `bafkrei${String(n).padStart(52, "a")}`;

/** A stand-in Pinata: uploads answer with a CID and id (a CID uploaded before is a duplicate); deletes are logged. */
function fakePinata() {
  const deleted: string[] = [];
  const seen = new Set<string>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") { deleted.push(url); return new Response("", { status: 200 }); }
    const text = await ((init.body as FormData).get("file") as File).text();
    const cid = cidOf(Number(text));
    const dup = seen.has(cid);
    seen.add(cid);
    return new Response(JSON.stringify({ data: { cid, id: `id-${text}`, is_duplicate: dup || null } }), { status: 200 });
  }) as typeof fetch;
  return { deleted, restore: () => { globalThis.fetch = real; } };
}

test("an unused pin is removed after its wait; a used one, its image and a failed check are kept", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    // 1: metadata whose transaction never landed, pointing at image 2; 3: metadata in use, pointing at 4.
    for (const n of [1, 2, 3, 4, 5]) await pinJson(cfg, String(n), "f.json", "test");
    tr.track(GW + cidOf(1), "orphan metadata", async () => false, { refs: [GW + cidOf(2)] });
    tr.track(GW + cidOf(2), "orphan image", async () => tr.referenced(GW + cidOf(2)), { after: 31 * 60_000 });
    tr.track(GW + cidOf(3), "metadata in use", async () => true, { refs: [GW + cidOf(4)] });
    tr.track(GW + cidOf(4), "image in use", async () => tr.referenced(GW + cidOf(4)), { after: 31 * 60_000 });
    tr.track(GW + cidOf(5), "can't tell", async () => { throw new Error("rpc down"); });
    const now = Date.now();
    await tr.sweep();
    assert.deepEqual(p.deleted, [], "nothing is due yet");
    t.mock.method(Date, "now", () => now + 30 * 60_000 + 1);
    await tr.sweep();
    assert.deepEqual(p.deleted, ["https://api.pinata.cloud/v3/files/public/id-1"]);
    t.mock.method(Date, "now", () => now + 32 * 60_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, ["https://api.pinata.cloud/v3/files/public/id-1", "https://api.pinata.cloud/v3/files/public/id-2"]);
    assert.ok(tr.wasRemoved(GW + cidOf(2)) && !tr.wasRemoved(GW + cidOf(4)));
    // The failed check is retried, then the pin kept for good.
    for (let i = 1; i <= 6; i++) { t.mock.method(Date, "now", () => now + (32 + 11 * i) * 60_000); await tr.sweep(); }
    assert.equal(p.deleted.length, 2);
  } finally { p.restore(); }
});

test("a file uploaded twice (in use elsewhere, maybe) is never removed", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    await pinJson(cfg, "7", "f.json", "test");
    await pinJson(cfg, "7", "f.json", "test"); // the same bytes again: Pinata's duplicate
    tr.track(GW + cidOf(7), "orphan", async () => false);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 31 * 60_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, []);
  } finally { p.restore(); }
});

test("gateway reads stop at the byte cap, by header or while streaming", async () => {
  assert.equal((await readCapped(new Response("hello"), 10)).toString(), "hello");
  await assert.rejects(readCapped(new Response("x".repeat(11), { headers: { "content-length": "11" } }), 10), /larger than 10 bytes/);
  // No length given: counted as it arrives.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(4)); c.close(); } });
  await assert.rejects(readCapped(new Response(stream), 10), /larger than 10 bytes/);

  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => new Response(url.startsWith("https://big/") ? "y".repeat(100) : "ok")) as typeof fetch;
  try {
    assert.equal((await fetchFromGateways(["https://big/", "https://small/"], "cid", 50)).toString(), "ok");
    await assert.rejects(fetchFromGateways(["https://big/"], "cid", 50), /larger than 50 bytes/);
  } finally { globalThis.fetch = real; }
});
