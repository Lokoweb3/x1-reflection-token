/** curve.html's banner and vault box, lifted out of the page and run with stand-ins for its helpers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../src/curve.html", import.meta.url), "utf8");
const lift = (from: string, to: string) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return html.slice(a, b); };
const flat = (n: unknown): string => Array.isArray(n) ? n.map(flat).join(" ") : n === null || n === undefined ? "" : typeof n === "object" ? flat((n as { kids: unknown[]; text?: string }).text ?? "") + flat((n as { kids: unknown[] }).kids) : String(n);
const context = vm.createContext({
  el: (tag: string, attrs: { text?: string }, ...kids: unknown[]) => ({ tag, text: attrs?.text, kids, attrs }),
  tr: (s: string, vars?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k])),
  link: (href: string, text: string) => ({ tag: "a", text, kids: [], attrs: { href } }),
  info: { explorer: "x" }, W: { state: { address: "creator" } }, chainNow: () => 0, vaultBusy: false, fmt: String,
});
vm.runInContext(`${lift("function banner(v) {", "/**\n * A Tax Vault token after graduation")}\n${lift("function vaultStart(v) {", "async function startVault")}\nthis.banner = banner; this.vaultStart = vaultStart;`, context);
const { banner, vaultStart } = context as unknown as { banner: (v: object) => unknown; vaultStart: (v: object) => unknown };
const base = { mint: "M", creator: "creator", pool: "P", state: { positions: 2 }, params: {}, vault: { exists: false } };

test("burned, delivering: says the LP was burned, promises no lock", () => {
  const t = flat(banner({ ...base, statusCode: 3, lockNft: null, lpBurned: true }));
  assert.match(t, /LP tokens were burned/);
  assert.match(t, /2 left/);
  assert.doesNotMatch(t, /locked forever/);
});

test("burned, finished: promises neither holder payouts nor a vault", () => {
  const t = flat(banner({ ...base, statusCode: 4, lockNft: null, lpBurned: true }));
  assert.match(t, /Graduated, LP burned/);
  assert.match(t, /holders aren't paid/);
  assert.doesNotMatch(t, /pays holders in XNT/);
  assert.doesNotMatch(t, /Tax vault\b/);
  assert.doesNotMatch(t, /Leaderboard/);
});

test("burned: the creator isn't offered 'Start the tax vault'", () => {
  assert.equal(vaultStart({ ...base, statusCode: 4, lockNft: null, lpBurned: true }), null);
  assert.equal(vaultStart({ ...base, statusCode: 3, lockNft: null, lpBurned: true }), null);
});

test("an ordinary graduation reads as before", () => {
  const t = flat(banner({ ...base, statusCode: 4, lockNft: "N", lpBurned: false }));
  assert.match(t, /its tax pays holders in XNT/);
  assert.ok(vaultStart({ ...base, statusCode: 4, lockNft: "N", lpBurned: false }), "the creator still gets the button");
  assert.match(flat(banner({ ...base, statusCode: 3, lockNft: "N", lpBurned: false })), /locked forever/);
});
