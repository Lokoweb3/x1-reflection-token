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

/** Upload one file to public IPFS through Pinata (or a stand-in with the same API); returns its content ID. */
export async function pinFile(t: PinTarget, blob: Blob, filename: string, label: string) {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("network", "public"); // public IPFS, so wallets and gateways can fetch it
  form.append("name", label.slice(0, 100));
  const r = await fetch(t.uploadUrl || PINATA_UPLOAD_URL, { method: "POST", body: form, headers: { Authorization: `Bearer ${t.jwt}` }, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error("IPFS upload was refused: check the Pinata key has Files: Write.");
  if (!r.ok) throw new Error(`IPFS upload failed (${r.status}): ${text.slice(0, 160)}`);
  const cid = (JSON.parse(text) as { data?: { cid?: string } }).data?.cid;
  if (!cid) throw new Error("IPFS upload returned no content ID");
  return cid;
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
      const r = await fetch(`${g.replace(/\/?$/, "/")}${cid}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { errors.push(`${g}: ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) { errors.push(`${g}: larger than ${maxBytes} bytes`); continue; }
      return buf;
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

/** Pin a token's metadata JSON (see tokenMetadataJson). Returns its gateway URL. */
export async function pinMetadata(cfg: Config, content: Record<string, string | boolean>, label: string) {
  const cid = await upload(cfg, new Blob([JSON.stringify(content)], { type: "application/json" }), "metadata.json", `99tax metadata ${label}`);
  return gatewayUrl(cfg, cid);
}
