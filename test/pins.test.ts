/**
 * Pins made for a transaction that never landed are removed from Pinata; anything in use, a
 * file pinned twice, or one whose check fails, is kept. Gateway reads stop at a byte cap.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import bs58 from "bs58";
import type { Config } from "../src/config.js";
import { chainLinkUses, contentRef, fetchFromGateways, pinJson, readCapped, sameContent, unpinOrphan } from "../src/factory/ipfs.js";
import { pinTracker } from "../src/factory/pins.js";

const cfg = { network: "testnet", factory: { feeReceiver: "x", feeUsdc: "1", pinataJwt: "secret" } } as unknown as Config;
const GW = "https://gateway.pinata.cloud/ipfs/";
/** The file's own number: each test uses its own, since this file shares one process's pin records. */
let next = 1000;
const fresh = () => ++next;
/** A real CID (v1, raw, sha256), so links to it can be told apart by content. */
function realCid(text: string) {
  const bytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(text).digest()]);
  let out = "b", bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += "abcdefghijklmnopqrstuvwxyz234567"[(acc >> bits) & 31]; acc &= (1 << bits) - 1; }
  }
  return bits ? out + "abcdefghijklmnopqrstuvwxyz234567"[(acc << (5 - bits)) & 31] : out;
}
const cidOf = (n: number) => realCid(String(n));

/** A stand-in Pinata: uploads answer with a CID and id (a CID uploaded before is a duplicate); deletes are logged. */
function fakePinata() {
  const deleted: string[] = [];
  const uploads: string[] = [];
  const pinned = new Set<string>();
  let holdDelete: Promise<void> | null = null, deleteStarted = () => {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (init.method === "DELETE") {
      deleted.push(url);
      const id = url.slice(url.lastIndexOf("/") + 1);
      deleteStarted();
      if (holdDelete) await holdDelete;
      pinned.delete(id); // whatever was uploaded meanwhile: the DELETE takes that pin out
      return new Response("", { status: 200 });
    }
    const text = await ((init.body as FormData).get("file") as File).text();
    const cid = cidOf(Number(text));
    const dup = pinned.has(`id-${text}`);
    pinned.add(`id-${text}`);
    uploads.push(text);
    return new Response(JSON.stringify({ data: { cid, id: `id-${text}`, is_duplicate: dup || null } }), { status: 200 });
  }) as typeof fetch;
  return {
    deleted, uploads,
    isPinned: (n: number) => pinned.has(`id-${n}`),
    /** The next DELETEs wait for the returned function; `started` resolves when one reaches Pinata. */
    hold() {
      let release = () => {};
      holdDelete = new Promise((r) => { release = r; });
      const started = new Promise<void>((r) => { deleteStarted = r; });
      return { started, release };
    },
    restore: () => { globalThis.fetch = real; },
  };
}

/** The clock for one test, moved by what's returned (one mock: stacking them doesn't restore cleanly). */
function clock(t: TestContext) {
  const start = Date.now();
  let at = start;
  t.mock.method(Date, "now", () => at);
  return { start, set: (ms: number) => { at = ms; } };
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
    const c = clock(t), now = c.start;
    await tr.sweep();
    assert.deepEqual(p.deleted, [], "nothing is due yet");
    c.set(now + 30 * 60_000 + 1);
    await tr.sweep();
    assert.deepEqual(p.deleted, ["https://api.pinata.cloud/v3/files/public/id-1"]);
    c.set(now + 32 * 60_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, ["https://api.pinata.cloud/v3/files/public/id-1", "https://api.pinata.cloud/v3/files/public/id-2"]);
    assert.ok(tr.wasRemoved(GW + cidOf(2)) && !tr.wasRemoved(GW + cidOf(4)));
    // The failed check is retried, then the pin kept for good.
    for (let i = 1; i <= 6; i++) { c.set(now + (32 + 11 * i) * 60_000); await tr.sweep(); }
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
    const c = clock(t), now = c.start;
    c.set(now + 31 * 60_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, []);
  } finally { p.restore(); }
});

/** A body that keeps producing until read to the end, recording how far it got and whether it was stopped. */
function endless(chunks = 5_000, size = 4) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (++seen.pulls > chunks) c.close(); else c.enqueue(new Uint8Array(size)); },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, seen };
}

test("gateway reads stop at the byte cap, by header or while streaming", async () => {
  assert.equal((await readCapped(new Response("hello"), 10)).toString(), "hello");
  await assert.rejects(readCapped(new Response("x".repeat(11), { headers: { "content-length": "11" } }), 10), /larger than 10 bytes/);
  // No length given: the read stops as soon as the cap is passed, not after the whole body.
  const s = endless();
  await assert.rejects(readCapped(new Response(s.body), 10), /larger than 10 bytes/);
  assert.equal(s.seen.cancelled, true, "the stream is cancelled");
  assert.ok(s.seen.pulls <= 4, `stopped reading at the cap (read ${s.seen.pulls} chunks of 5000)`);

  const real = globalThis.fetch;
  const big = endless();
  globalThis.fetch = (async (url: string) => (url.startsWith("https://big/") ? new Response(big.body) : new Response("ok"))) as typeof fetch;
  try {
    assert.equal((await fetchFromGateways(["https://big/", "https://small/"], "cid", 50)).toString(), "ok");
    assert.equal(big.seen.cancelled, true, "a gateway over the cap is cut off, and the next one tried");
    assert.ok(big.seen.pulls <= 15, `read ${big.seen.pulls} chunks`);
  } finally { globalThis.fetch = real; }
});

test("an upload racing a removal is pinned again before its CID is returned, and never removed after", async () => {
  const p = fakePinata();
  try {
    const n = fresh();
    await pinJson(cfg, String(n), "f.json", "launch A");
    const { started, release } = p.hold();
    const unpin = unpinOrphan(cfg, cidOf(n));
    await started;
    // Launch B uploads the same bytes while the DELETE is on its way: Pinata answers "duplicate".
    let returned = false;
    const upload = pinJson(cfg, String(n), "f.json", "launch B").then((cid) => { returned = true; return cid; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(returned, false, "the upload waits for the removal");
    release();
    assert.equal(await unpin, false, "not reported as removed: the content is in use again");
    assert.equal(await upload, cidOf(n));
    assert.equal(p.isPinned(n), true, "pinned when its CID is returned");
    assert.equal(await unpinOrphan(cfg, cidOf(n)), false, "and not removed later");
    assert.equal(p.deleted.length, 1);
  } finally { p.restore(); }
});

test("an upload that began before a removal and ended after it is pinned again too", async () => {
  const p = fakePinata();
  const fake = globalThis.fetch;
  try {
    const n = fresh();
    await pinJson(cfg, String(n), "f.json", "launch A");
    // This upload is answered, then the answer is delayed past the whole removal.
    let deliver = () => {};
    const delayed = new Promise<void>((r) => { deliver = r; });
    let first = true;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const res = await fake(url, init);
      if (init.method !== "DELETE" && first) { first = false; await delayed; }
      return res;
    }) as typeof fetch;
    const upload = pinJson(cfg, String(n), "f.json", "launch B");
    await new Promise((r) => setTimeout(r, 5));
    await unpinOrphan(cfg, cidOf(n));
    assert.equal(p.isPinned(n), false);
    deliver();
    assert.equal(await upload, cidOf(n));
    assert.equal(p.isPinned(n), true);
  } finally { p.restore(); }
});

test("usage is compared by content: another gateway, ipfs://, v0 or upper case is the same file", () => {
  const n = fresh(), cid = cidOf(n);
  const digest = crypto.createHash("sha256").update(String(n)).digest();
  const v0 = bs58.encode(Buffer.concat([Buffer.from([0x12, 0x20]), digest]));
  for (const link of [`${GW}${cid}`, `https://ipfs.io/ipfs/${cid}`, `https://ipfs.io/ipfs/${cid}?filename=x.png`, `https://${cid}.ipfs.dweb.link/`, `ipfs://${cid}`, `ipfs://ipfs/${cid}`,
    `https://other.example/ipfs/${v0}`, `ipfs://${v0}`, `ipfs://${cid.toUpperCase()}`, cid, `https://proxy.example/x/${cid}.png`]) {
    assert.equal(sameContent(link, `${GW}${cid}`), true, link);
  }
  assert.equal(sameContent(`https://ipfs.io/ipfs/${cidOf(fresh())}`, `${GW}${cid}`), false, "another file");
  assert.equal(sameContent("https://example.com/logo.png", `${GW}${cid}`), false, "a web link, nothing about IPFS");
  for (const link of ["ipfs://garbage", "ipns://name.example", `https://ipfs.io/ipns/${cid}`, "https://ipfs.io/ipfs/not-a-cid", "not a link"]) {
    assert.equal(contentRef(link).kind, "unclear", link);
    assert.equal(sameContent(link, `${GW}${cid}`), null, link);
  }
  // A token's own on-chain link: anything but identified IPFS content keeps the pin.
  assert.equal(chainLinkUses(`ipfs://${cid}`, `${GW}${cid}`), true);
  assert.equal(chainLinkUses(`ipfs://${cidOf(fresh())}`, `${GW}${cid}`), false);
  for (const link of ["https://example.com/meta.json", "ipfs://garbage", "", undefined]) assert.equal(chainLinkUses(link, `${GW}${cid}`), null, String(link));
});

test("a file named under another gateway or ipfs:// is not deleted as unused", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    const [meta, logo, viaRef, unclear, plain, gone] = [fresh(), fresh(), fresh(), fresh(), fresh(), fresh()];
    for (const n of [meta, logo, viaRef, unclear, plain, gone]) await pinJson(cfg, String(n), "f.json", "test");
    // A token whose link moved to another spelling of the same CID (what tokenUriIs now answers).
    tr.track(GW + cidOf(meta), "metadata", async () => chainLinkUses(`ipfs://${cidOf(meta)}`, GW + cidOf(meta)));
    // A launch whose record names the logo through another gateway.
    tr.track(GW + cidOf(logo), "logo", async () => tr.logoUsed([`https://ipfs.io/ipfs/${cidOf(logo)}`], GW + cidOf(logo)));
    // A kept metadata JSON pointing at its image through ipfs://.
    tr.track(GW + cidOf(viaRef), "image", async () => tr.referenced(GW + cidOf(viaRef)), { after: 31 * 60_000 });
    tr.track(GW + cidOf(meta + 100), "kept", async () => true, { refs: [`ipfs://${cidOf(viaRef)}`] });
    // A launch naming something that can't be identified: in doubt, kept.
    tr.track(GW + cidOf(unclear), "logo", async () => tr.logoUsed(["ipfs://garbage"], GW + cidOf(unclear)));
    // Only web links and other files: this one really is unused, so the cleanup still works.
    tr.track(GW + cidOf(gone), "logo", async () => tr.logoUsed(["https://example.com/a.png", `ipfs://${cidOf(plain)}`], GW + cidOf(gone)));
    const c = clock(t), now = c.start;
    for (let i = 0; i < 8; i++) { c.set(now + (31 + 11 * i) * 60_000); await tr.sweep(); }
    assert.deepEqual(p.deleted, [`https://api.pinata.cloud/v3/files/public/id-${gone}`]);
  } finally { p.restore(); }
});

test("rewards lists pinned by the crank stay out of the cleanup", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    // pinJson is all the crank does (factory/vault.ts): nothing is tracked, so a sweep has nothing to remove.
    const list = fresh();
    await pinJson(cfg, String(list), "TEST-list-1.json", "99tax TEST rewards list 1");
    const c = clock(t), now = c.start;
    c.set(now + 86_400_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, []);
    // A tracked file with the very same bytes (an upload that came second) doesn't expose it either.
    await pinJson(cfg, String(list), "metadata.json", "same bytes");
    tr.track(GW + cidOf(list), "same bytes", async () => false);
    c.set(now + 2 * 86_400_000);
    await tr.sweep();
    assert.deepEqual(p.deleted, []);
  } finally { p.restore(); }
});

test("a removed logo uploaded again can be used: the expired notice goes away, whatever the spelling", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    const n = fresh(), url = GW + cidOf(n);
    await pinJson(cfg, String(n), "logo.png", "logo");
    tr.track(url, "logo", async () => false);
    const c = clock(t), now = c.start;
    c.set(now + 31 * 60_000);
    await tr.sweep();
    assert.equal(tr.wasRemoved(url), true);
    assert.equal(tr.wasRemoved(`ipfs://${cidOf(n)}`), true, "under any spelling");
    await pinJson(cfg, String(n), "logo.png", "logo");
    tr.track(url, "logo", async () => true);
    assert.equal(tr.wasRemoved(url), false, "uploaded again: usable");
  } finally { p.restore(); }
});

test("a cleanup finishing after the same logo was uploaded again leaves no expired notice", async (t) => {
  const p = fakePinata();
  try {
    const tr = pinTracker(cfg, () => undefined);
    const n = fresh(), url = GW + cidOf(n);
    await pinJson(cfg, String(n), "logo.png", "logo");
    tr.track(url, "logo", async () => false);
    const c = clock(t), now = c.start;
    c.set(now + 31 * 60_000);
    const { started, release } = p.hold();
    const sweeping = tr.sweep();
    await started;
    const upload = pinJson(cfg, String(n), "logo.png", "logo");
    await new Promise((r) => setTimeout(r, 5));
    release();
    await upload;
    tr.track(url, "logo", async () => true);
    await sweeping;
    assert.equal(tr.wasRemoved(url), false);
    assert.equal(p.isPinned(n), true);
  } finally { p.restore(); }
});
