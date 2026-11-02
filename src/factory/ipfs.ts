/**
 * Token logos, metadata and Tax Vault rewards lists on IPFS through Pinata, so the site
 * stores no images and a token's on-chain metadata link (or a vault's list file, whose CID
 * is on-chain) doesn't depend on this server.
 *
 * Set the Pinata API key as factory.pinataJwt in config.json (or PINATA_JWT in the
 * environment). Without it, uploads are off and launches fall back to pasting a logo URL
 * with metadata served by the site. The upload API and the gateway can be pointed elsewhere
 * (factory.pinataApiUrl / PINATA_API_URL, factory.ipfsGateway / IPFS_GATEWAY), e.g. at a
 * local stand-in for rehearsals.
 */
import bs58 from "bs58";
import { Config } from "../config.js";

/** Pinata's upload API (works with keys that have Files: Write). */
export const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
export const DEFAULT_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
/** Largest logo accepted (bytes). */
export const MAX_LOGO_BYTES = 500_000;

const jwt = (cfg: Config) => process.env.PINATA_JWT || cfg.factory?.pinataJwt || "";
const uploadUrl = (cfg: Config) => process.env.PINATA_API_URL || cfg.factory?.pinataApiUrl || PINATA_UPLOAD_URL;
export const ipfsEnabled = (cfg: Config) => !!jwt(cfg);
/** The gateway base URL (ends with "/"). Pinata's own serves what we pin (public ones rate-limit). */
export const gatewayBase = (cfg: Config) => (process.env.IPFS_GATEWAY || cfg.factory?.ipfsGateway || DEFAULT_GATEWAY).replace(/\/?$/, "/");
/** Gateway for the links wallets fetch; https works in more wallets than ipfs://. */
export const gatewayUrl = (cfg: Config, cid: string) => `${gatewayBase(cfg)}${cid}`;

/** The image type from its first bytes, or null if it isn't a PNG, JPEG, WebP or GIF. */
export function sniffImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image/webp", ext: "webp" };
  if (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return { type: "image/gif", ext: "gif" };
  return null;
}

/** Where and how to pin: a Pinata key and its upload API. */
export interface PinTarget { jwt: string; uploadUrl?: string }

/**
 * A trustless gateway (content-addressed blocks, open CORS): `?format=raw` returns a
 * single-block file's bytes, which is what a rewards list is (a raw-codec CID, checked
 * against its sha256 by parseListFile). ipfs.io and dweb.link now answer scripts with 429
 * (browsers get a service-worker gateway instead), so this is the working fallback.
 */
export const TRUSTLESS_GATEWAY = "https://trustless-gateway.link/ipfs/{cid}?format=raw";
/** A gateway entry's URL for `cid`: "{cid}" is replaced, else the CID is appended to the base. */
export const gatewayFor = (g: string, cid: string) => (g.includes("{cid}") ? g.replace("{cid}", cid) : `${g.replace(/\/?$/, "/")}${cid}`);
/** Tidy a gateway entry: a base gets its trailing "/", a "{cid}" template is kept as it is. */
export const normGateway = (g: string) => (g.includes("{cid}") ? g : g.replace(/\/?$/, "/"));

/** Upload one file to public IPFS through Pinata (or a stand-in with the same API). */
async function postFile(t: PinTarget, blob: Blob, filename: string, label: string) {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("network", "public"); // public IPFS, so wallets and gateways can fetch it
  form.append("name", label.slice(0, 100));
  const r = await fetch(t.uploadUrl || PINATA_UPLOAD_URL, { method: "POST", body: form, headers: { Authorization: `Bearer ${t.jwt}` }, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  // Pinata's own reason (a revoked key, missing Files: Write, the plan's file or storage limit) is in the body.
  if (r.status === 401 || r.status === 403) throw new Error(`IPFS upload was refused (${r.status}: ${text.replace(/\s+/g, " ").slice(0, 160) || "no reason given"}): check the Pinata key is active, has Files: Write, and the plan isn't at its limit.`);
  if (!r.ok) throw new Error(`IPFS upload failed (${r.status}): ${text.slice(0, 160)}`);
  const data = (JSON.parse(text) as { data?: { cid?: string; id?: string; is_duplicate?: boolean | null } }).data;
  const cid = data?.cid;
  if (!cid) throw new Error("IPFS upload returned no content ID");
  return { cid, id: data?.id, duplicate: !!data?.is_duplicate };
}

/**
 * Upload one file and return its content ID. Identical bytes get the same CID, so an upload
 * that overlaps a removal of that CID (unpinOrphan) may be answered with a pin about to vanish:
 * it waits for the removal to finish and uploads again, so the pin exists when the CID is
 * returned. That CID is never removed by this process after that.
 */
export async function pinFile(t: PinTarget, blob: Blob, filename: string, label: string) {
  const started = ++pinClock;
  const { cid, id, duplicate } = await postFile(t, blob, filename, label);
  const racing = unpinning.get(cid);
  if (racing || (lastUnpin.get(cid) ?? 0) > started) {
    sharedCids.add(cid);
    pinIds.delete(cid);
    if (racing) { racing.waiters++; await racing.done; }
    await postFile(t, blob, filename, label);
    return cid;
  }
  // Remembered so a pin nothing ended up using can be removed (unpinOrphan); a file that was
  // already pinned (the same bytes uploaded twice) may be in use elsewhere, so it never is.
  if (duplicate || pinIds.has(cid)) { sharedCids.add(cid); pinIds.delete(cid); }
  else if (id) pinIds.set(cid, id);
  if (pinIds.size > 5_000) pinIds.delete(pinIds.keys().next().value!);
  return cid;
}

/** Pinata file ids of what this process pinned, by CID; and CIDs uploaded more than once. */
const pinIds = new Map<string, string>();
const sharedCids = new Set<string>();
/** Orders uploads and removals, to tell whether an upload overlapped a removal of its CID. */
let pinClock = 0;
/** Removals in flight by CID, with how many uploads wait for each; and when each CID's last one began. */
const unpinning = new Map<string, { done: Promise<void>; waiters: number }>();
const lastUnpin = new Map<string, number>();
/** Pinata's files API (for removing a pin), unless the uploads go to a stand-in without one. */
const filesUrl = (cfg: Config) => process.env.PINATA_FILES_URL || (uploadUrl(cfg) === PINATA_UPLOAD_URL ? "https://api.pinata.cloud/v3/files/public" : "");

/**
 * Remove a pin this process made that nothing ended up using (its transaction never landed).
 * Only a CID uploaded once, by this process, is removed. Returns whether it's gone: false too
 * when an upload of the same content overlapped the removal (it is pinned again).
 */
export async function unpinOrphan(cfg: Config, cid: string) {
  const id = pinIds.get(cid);
  if (!id || sharedCids.has(cid) || !filesUrl(cfg) || !ipfsEnabled(cfg)) return false;
  let finish = () => {};
  const entry = { done: new Promise<void>((resolve) => { finish = resolve; }), waiters: 0 };
  unpinning.set(cid, entry);
  lastUnpin.set(cid, ++pinClock);
  if (lastUnpin.size > 5_000) lastUnpin.delete(lastUnpin.keys().next().value!);
  try {
    const r = await fetch(`${filesUrl(cfg)}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${jwt(cfg)}` }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok && r.status !== 404) throw new Error(`unpin ${cid} failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
    pinIds.delete(cid);
    return entry.waiters === 0 && !sharedCids.has(cid);
  } finally {
    unpinning.delete(cid);
    finish();
  }
}

/** The CID in a link to this site's gateway, else null. */
export function cidOfUrl(cfg: Config, url: string) {
  const base = gatewayBase(cfg);
  return url.startsWith(base) && /^[A-Za-z0-9]{46,64}$/.test(url.slice(base.length)) ? url.slice(base.length) : null;
}

const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32 = /^[bB][A-Za-z2-7]{20,}$/;
/** Something in a link shaped like a CID: base58 Qm..., or base32 v1 (raw "bafkrei...", dag-pb "bafybei..."). */
const CID_IN_TEXT = /(?:^|[^A-Za-z0-9])(Qm[1-9A-HJ-NP-Za-km-z]{44}|[bB][aA][fF][A-Za-z2-7]{50,})(?![A-Za-z0-9])/;
/** The hash inside a CID: the same file's hash whichever CID version or letter case spells it. Null if it can't be read. */
function cidHash(token: string): string | null {
  let bytes: Uint8Array;
  try {
    if (CID_V0.test(token)) bytes = bs58.decode(token);
    else if (CID_V1_BASE32.test(token)) {
      const out: number[] = [];
      let bits = 0, acc = 0;
      for (const ch of token.slice(1).toLowerCase()) {
        acc = (acc << 5) | "abcdefghijklmnopqrstuvwxyz234567".indexOf(ch);
        bits += 5;
        if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); acc &= (1 << bits) - 1; }
      }
      if (out[0] !== 1) return null; // only CID version 1 is spelled this way
      let at = 1;
      while (out[at] & 0x80) at++; // the codec, a varint: raw and dag-pb files can share one hash
      bytes = Uint8Array.from(out.slice(at + 1));
    } else return null;
  } catch { return null; }
  // A multihash is its type, its length, then that many bytes.
  if (bytes.length < 3 || bytes[0] > 0x7f || bytes[1] !== bytes.length - 2) return null;
  return Buffer.from(bytes).toString("hex");
}

/**
 * What a link says about the content it names:
 *   hash     it names IPFS content (any gateway, ipfs://, a subdomain gateway, a bare CID)
 *   web      an ordinary web link, with nothing about IPFS in it
 *   unclear  it looks like IPFS but the content can't be identified (a mutable ipns name, a CID
 *            form not read here, an IPFS path with no CID)
 */
export type ContentRef = { kind: "hash"; hash: string } | { kind: "web" } | { kind: "unclear" };
export function contentRef(link: unknown): ContentRef {
  const text = typeof link === "string" ? link.trim() : "";
  if (!text) return { kind: "web" };
  const named = (token: string): ContentRef => { const hash = cidHash(token); return hash ? { kind: "hash", hash } : { kind: "unclear" }; };
  if (CID_V0.test(text) || CID_V1_BASE32.test(text)) return named(text);
  if (/^ipns:\/\//i.test(text)) return { kind: "unclear" };
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/i.exec(text);
  if (ipfs) return named(ipfs[1]);
  if (/^ipfs:/i.test(text)) return { kind: "unclear" };
  let url: URL;
  try { url = new URL(text); } catch { return { kind: "unclear" }; }
  if (/(^|\.)ipns\./i.test(url.hostname) || /(^|\/)ipns\//i.test(url.pathname)) return { kind: "unclear" };
  const sub = /^([^.]+)\.ipfs\./i.exec(url.hostname);
  if (sub) return named(sub[1]);
  const inPath = /(?:^|\/)ipfs\/([^/?#]+)/i.exec(url.pathname);
  if (inPath) return named(decodeURIComponent(inPath[1]));
  const found = CID_IN_TEXT.exec(`${url.pathname}${url.search}`);
  if (found) return named(found[1]);
  return /ipfs/i.test(text) ? { kind: "unclear" } : { kind: "web" };
}
/**
 * Whether a link names the content of `pinned` (a link or CID): true, false, or null when that
 * can't be established. Compared by content, never by how the link is spelled.
 */
export function sameContent(link: unknown, pinned: string): boolean | null {
  const a = contentRef(link), b = contentRef(pinned);
  if (b.kind !== "hash") return link === pinned ? true : null;
  if (a.kind === "hash") return a.hash === b.hash;
  return a.kind === "web" ? false : null;
}
/**
 * Whether a token's on-chain metadata link still uses the `pinned` file. Null, so the pin stays,
 * for anything but a link naming IPFS content: a web link could serve that file for all we know.
 */
export function chainLinkUses(onChain: unknown, pinned: string): boolean | null {
  if (contentRef(onChain).kind !== "hash") return null;
  return sameContent(onChain, pinned);
}

/**
 * A response body, read as it streams in and given up on past `maxBytes` (a gateway or a
 * file it serves could otherwise make the server hold any amount in memory).
 */
export async function readCapped(r: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(r.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { await r.body?.cancel().catch(() => undefined); throw new Error(`larger than ${maxBytes} bytes`); }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error(`larger than ${maxBytes} bytes`); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
const upload = (cfg: Config, blob: Blob, filename: string, label: string) => pinFile({ jwt: jwt(cfg), uploadUrl: uploadUrl(cfg) }, blob, filename, label);

/** Pin a JSON document exactly as `text` (the bytes are what the CID addresses). Returns its content ID. */
export async function pinJson(cfg: Config, text: string, filename: string, label: string) {
  if (!ipfsEnabled(cfg)) throw new Error("IPFS isn't set up on this site (factory.pinataJwt)");
  return upload(cfg, new Blob([text], { type: "application/json" }), filename, label);
}

/**
 * Fetch a file by CID from the first gateway that has it (each base ends with "/"). Refuses
 * anything larger than `maxBytes`. The caller checks the content (e.g. a list's Merkle root).
 */
export async function fetchFromGateways(gateways: string[], cid: string, maxBytes = 50_000_000) {
  const errors: string[] = [];
  for (const g of gateways) {
    try {
      const r = await fetch(gatewayFor(g, cid), { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { errors.push(`${g}: ${r.status}`); await r.body?.cancel().catch(() => undefined); continue; }
      return await readCapped(r, maxBytes);
    } catch (e) {
      errors.push(`${g}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new Error(`Couldn't fetch ${cid} from IPFS (${errors.join("; ")})`);
}

/** Pin a logo; nothing is written to disk. Returns its content ID and gateway URL. */
export async function pinLogo(cfg: Config, bytes: Buffer, name: string) {
  if (!ipfsEnabled(cfg)) throw new Error("Logo uploads aren't set up on this site; paste a logo URL instead.");
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new Error(`The logo must be under ${MAX_LOGO_BYTES / 1000} KB.`);
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("The logo must be a PNG, JPG, WebP or GIF image.");
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40) || "logo";
  const cid = await upload(cfg, new Blob([new Uint8Array(bytes)], { type: kind.type }), `${safe}.${kind.ext}`, `99tax logo ${safe}`);
  return { cid, url: gatewayUrl(cfg, cid) };
}

/** Largest receipt image accepted (a 2x PNG of the receipt is ~30-80 KB). */
export const MAX_RECEIPT_PNG_BYTES = 1_000_000;
/** Pin a lock NFT's receipt PNG (rendered from the receipt SVG in the creator's browser). Returns its gateway URL. */
export async function pinReceiptPng(cfg: Config, bytes: Buffer, label: string) {
  if (!ipfsEnabled(cfg)) throw new Error("IPFS isn't set up on this site (factory.pinataJwt)");
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_PNG_BYTES) throw new Error("The receipt image is empty or too large.");
  if (sniffImage(bytes)?.type !== "image/png") throw new Error("The receipt image must be a PNG.");
  return gatewayUrl(cfg, await upload(cfg, new Blob([new Uint8Array(bytes)], { type: "image/png" }), "receipt.png", `99tax receipt ${label}`));
}

/** Pin a token's metadata JSON (see tokenMetadataJson). Returns its gateway URL. */
export async function pinMetadata(cfg: Config, content: Record<string, string | boolean>, label: string) {
  const cid = await upload(cfg, new Blob([JSON.stringify(content)], { type: "application/json" }), "metadata.json", `99tax metadata ${label}`);
  return gatewayUrl(cfg, cid);
}
