/** Rate-limit helpers for the factory server. */

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
