// The little of node:crypto the shared code uses (sha256 digests), for the browser build.
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";

export function createHash(alg: string) {
  if (alg !== "sha256") throw new Error(`createHash(${alg}) isn't available in the browser build`);
  const parts: Uint8Array[] = [];
  const h = {
    update(d: string | Uint8Array) { parts.push(typeof d === "string" ? Buffer.from(d, "utf8") : d); return h; },
    digest() { return Buffer.from(sha256(Buffer.concat(parts))); },
  };
  return h;
}
export function randomBytes(n: number) { return Buffer.from(crypto.getRandomValues(new Uint8Array(n))); }
export default { createHash, randomBytes };
