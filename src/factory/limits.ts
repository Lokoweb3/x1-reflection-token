/** Rate-limit helpers for the factory server. */

/** An IPv6 address counts by its /64 (one connection usually has the whole block); IPv4 as is. */
export function limitKey(ip: string) {
  if (!ip.includes(":") || ip.startsWith("forwarded ")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
