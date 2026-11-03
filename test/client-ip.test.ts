/**
 * Who gets the rate limits' localhost exemption: the real server, reached the way Caddy reaches
 * it (from this machine, so only the headers tell a proxied request from a local one). Caddy
 * itself isn't in this test: these are the requests it can send on.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Keypair } from "@solana/web3.js";
import { startSite } from "./helpers/site.js";
import { limitKey, visitorAddress } from "../src/factory/limits.js";

const PUBLIC_HOST = "site.vercel.app";
let site: Awaited<ReturnType<typeof startSite>>;
before(async () => { site = await startSite({ hosts: [PUBLIC_HOST] }); });
after(async () => { await site.stop(); });

const GET_LIMIT = 120; // LIMITS.get in factory-server.ts
const path = `/api/launches?creator=${Keypair.generate().publicKey.toBase58()}`; // answered without a chain read
function hit(headers: http.OutgoingHttpHeaders) {
  const { hostname, port } = new URL(site.origin);
  return new Promise<number>((resolve, reject) => {
    http.get({ hostname, port, path, headers, setHost: !("host" in headers), agent: false }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); }).on("error", reject);
  });
}
/** More requests than one address may make: how many were refused. */
async function refusals(headers: http.OutgoingHttpHeaders) {
  let refused = 0;
  for (let i = 0; i < 10; i++) refused += (await Promise.all(Array.from({ length: Math.ceil((GET_LIMIT + 10) / 10) }, () => hit(headers)))).filter((s) => s === 429).length;
  return refused;
}

// In this order: the buckets last a minute, and each case after the first shares the unknown one.
test("a local caller keeps the exemption; a proxied request with an empty or missing address doesn't", async () => {
  assert.equal(await refusals({}), 0, "direct, by 127.0.0.1:<port>: scripts and rehearsals");
  assert.ok(await refusals({ host: PUBLIC_HOST, "x-forwarded-for": "" }) > 0, "through the proxy, the empty header a path-secret caller causes");
});

test("one who has used up the no-address bucket is refused however the address is missing; a valid one stands alone", async () => {
  assert.equal(await hit({ host: PUBLIC_HOST }), 429, "public host, no header");
  assert.equal(await hit({ "x-forwarded-for": "" }), 429, "local host, empty header");
  assert.equal(await hit({ host: PUBLIC_HOST, "x-forwarded-proto": "https", "x-forwarded-for": "   " }), 429, "blank");
  assert.equal(await hit({ host: PUBLIC_HOST, "x-forwarded-for": "," }), 429, "no first entry");
  assert.equal(await hit({ host: PUBLIC_HOST, "x-forwarded-for": "not-an-address" }), 429, "not an address");
  assert.equal(await hit({ "x-forwarded-proto": "https" }), 429, "another sign of the proxy");
  assert.equal(await hit({ host: PUBLIC_HOST, "x-forwarded-for": "203.0.113.9" }), 200, "a visitor's own limit");
  assert.equal(await hit({}), 200, "and this machine");
});

test("the address: valid ones as before, from the first entry, and the proxy never reads as this machine", () => {
  const local = new Set(["127.0.0.1:8124", "localhost:8124"]);
  const at = (peer: string, headers: http.IncomingHttpHeaders) => visitorAddress(peer, headers, local);
  // Direct local callers.
  for (const host of local) assert.equal(at("127.0.0.1", { host }), "127.0.0.1");
  assert.equal(at("::ffff:127.0.0.1", { host: "localhost:8124" }), "127.0.0.1");
  assert.equal(at("::1", { host: "localhost:8124" }), "::1");
  // Forwarded, valid.
  for (const peer of ["127.0.0.1", "::1"]) {
    assert.equal(at(peer, { host: PUBLIC_HOST, "x-forwarded-for": "203.0.113.9" }), "203.0.113.9");
    assert.equal(at(peer, { host: PUBLIC_HOST, "x-forwarded-for": "203.0.113.9, 198.51.100.1" }), "203.0.113.9");
    assert.equal(at(peer, { host: PUBLIC_HOST, "x-forwarded-for": "2001:db8::1" }), "2001:db8::1");
    assert.equal(at(peer, { host: "127.0.0.1:8124", "x-forwarded-for": "203.0.113.9" }), "203.0.113.9");
    assert.equal(at(peer, { host: PUBLIC_HOST, "x-forwarded-for": "127.0.0.1" }), "forwarded 127.0.0.1");
    assert.equal(at(peer, { host: PUBLIC_HOST, "x-forwarded-for": "::1" }), "forwarded ::1");
  }
  // From anywhere else the header means nothing.
  assert.equal(at("203.0.113.1", { host: PUBLIC_HOST, "x-forwarded-for": "198.51.100.1" }), "203.0.113.1");
  assert.equal(at("203.0.113.1", { host: PUBLIC_HOST }), "203.0.113.1");
  // Through the proxy with nothing usable: never the exempt address, and all counted together.
  for (const headers of [{ host: PUBLIC_HOST }, { host: PUBLIC_HOST, "x-forwarded-for": "" }, { host: "127.0.0.1:8124", "x-forwarded-for": "" },
    { host: "localhost:8124", "x-forwarded-proto": "https" }, { host: PUBLIC_HOST, "x-forwarded-for": ", 203.0.113.9" }, {}]) {
    const ip = at("127.0.0.1", headers);
    assert.notEqual(ip, "127.0.0.1", JSON.stringify(headers));
    assert.equal(limitKey(ip), limitKey(at("::1", { host: PUBLIC_HOST })), JSON.stringify(headers));
  }
});
