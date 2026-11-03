/** Rate-limit helpers for the factory server. */
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1";
/** Every request through the proxy without a usable address: one shared limit, never the local exemption. */
const NO_ADDRESS = "forwarded unknown";

/**
 * The visitor's address. X-Forwarded-For is only believed when the request comes from this
 * machine (the local Caddy, which sets it: it replaces a client's own value, or in Vercel mode
 * passes on the one Vercel sets). Anyone else could write any address into it.
 *
 * Only a request made on this machine itself gets its loopback address, which skips the rate
 * limits. That is one naming this machine (`localHosts`: Caddy sends the public host, and serves
 * no other) with no X-Forwarded-* header (Caddy adds them; a local script doesn't). A forwarded
 * "127.0.0.1" was written by the client (in Vercel mode Caddy passes on what Vercel, or anyone
 * else holding the secrets, sent).
 */
export function visitorAddress(peerAddress: string, headers: IncomingHttpHeaders, localHosts: ReadonlySet<string>) {
  const peer = peerAddress.replace(/^::ffff:/, "");
  if (!isLoopback(peer)) return peer;
  const fwd = headers["x-forwarded-for"];
  const ip = typeof fwd === "string" ? fwd.split(",")[0].trim() : "";
  if (isIP(ip)) return isLoopback(ip) ? `forwarded ${ip}` : ip;
  const direct = localHosts.has(headers.host ?? "") && !Object.keys(headers).some((h) => h.startsWith("x-forwarded-"));
  return direct ? peer : NO_ADDRESS;
}

/** An IPv6 address counts by its /64 (one connection usually has the whole block); IPv4 as is. */
export function limitKey(ip: string) {
  if (!ip.includes(":") || ip.startsWith("forwarded ")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * A file-system error (a full disk, a read-only mount, a missing file): its message names paths
 * on this server, so it goes to the operator's log and the visitor gets a plain sentence.
 */
export function isFileError(e: unknown) {
  if (typeof (e as NodeJS.ErrnoException | undefined)?.syscall === "string") return true;
  return /\bE(NOENT|ACCES|PERM|ISDIR|NOTDIR|NOSPC|IO|ROFS|MFILE|NFILE|DQUOT|BUSY|XDEV)\b/.test(e instanceof Error ? e.message : String(e));
}
