import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOGO_BYTES, ipfsEnabled, pinLogo, pinMetadata, sniffImage } from "../src/factory/ipfs.js";
import type { Config } from "../src/config.js";

const cfg = (jwt?: string) => ({ network: "testnet", factory: { feeReceiver: "x", feeUsdc: "1", pinataJwt: jwt } }) as unknown as Config;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);

test("only real images are accepted, by their bytes", () => {
  assert.equal(sniffImage(PNG)?.type, "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.type, "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a......"))?.type, "image/gif");
  assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.type, "image/webp");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>")), null); // SVG (scriptable) is refused
  assert.equal(sniffImage(Buffer.from("hello")), null);
});

test("uploads are off without a key, and oversized or non-image files are refused", async () => {
  assert.equal(ipfsEnabled(cfg()), false);
  await assert.rejects(pinLogo(cfg(), PNG, "x"), /aren't set up/);
  await assert.rejects(pinLogo(cfg("k"), Buffer.alloc(MAX_LOGO_BYTES + 1, 0x89), "x"), /under/);
  await assert.rejects(pinLogo(cfg("k"), Buffer.from("not an image"), "x"), /PNG, JPG, WebP or GIF/);
});

test("logo and metadata go to Pinata with the key; results are gateway links", async () => {
  const calls: { url: string; auth: string; body: unknown }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: init.body });
    const f = (init.body as FormData).get("file") as File;
    return new Response(JSON.stringify({ data: { cid: f.name === "metadata.json" ? "QmMeta" : "QmLogo" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const logo = await pinLogo(cfg("secret"), PNG, "My Logo!");
    assert.equal(logo.url, "https://gateway.pinata.cloud/ipfs/QmLogo");
    assert.equal(calls[0].url, "https://uploads.pinata.cloud/v3/files");
    assert.equal((calls[0].body as FormData).get("network"), "public");
    assert.equal(calls[0].auth, "Bearer secret");
    const file = (calls[0].body as FormData).get("file") as File;
    assert.equal(file.name, "MyLogo.png"); assert.equal(file.type, "image/png"); assert.equal(file.size, PNG.length);

    const uri = await pinMetadata(cfg("secret"), { name: "Cup", symbol: "CUP", description: "d", image: logo.url }, "CUP");
    assert.equal(uri, "https://gateway.pinata.cloud/ipfs/QmMeta");
    const meta = (calls[1].body as FormData).get("file") as File;
    assert.equal(meta.type, "application/json");
    assert.deepEqual(JSON.parse(await meta.text()), { name: "Cup", symbol: "CUP", description: "d", image: "https://gateway.pinata.cloud/ipfs/QmLogo" });
  } finally { globalThis.fetch = real; }
});
