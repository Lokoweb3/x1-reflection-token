import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLang, report } from "../scripts/i18n-check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const es = loadLang("es");

test("every page text, tr() key and server message shown has a Spanish entry", () => {
  const r = report("es");
  assert.deepEqual(r.static, [], "static page text without a translation");
  assert.deepEqual(r.keys, [], "tr() keys without a translation");
  assert.deepEqual(r.unwrapped, [], "sentence-like strings in page scripts not wrapped in tr()");
});

// Number words where Spanish counts differently ("1 billion" is "mil millones").
const NUMBER_WORDS = new Set(["1 billion", "1 billion (1,000,000,000)"]);
const KEEP = ["99 + Tax", "XNT", "USDC", "XNM", "XDEX", "IPFS", "NFT", "LP", "SVG", "PNG", "JPG", "WebP", "GIF", "RPC", "UTC", "X1", "https://", "ipfs://", "x.com", "t.me", "--publisher", "README", "init_vault", "Squads"];

test("translations keep placeholders, numbers, addresses and fixed names exactly", () => {
  const holes = (s: string) => [...s.matchAll(/\{(~?\w+)\}/g)].map((m) => m[1]).sort();
  const digits = (s: string) => (s.match(/\d+/g) ?? []).sort();
  const addrs = (s: string) => (s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []).sort();
  const count = (s: string, w: string) => s.split(w).length - 1;
  for (const [k, v] of Object.entries(es.entries)) {
    assert.equal(typeof v, "string", k);
    assert.ok(v.trim().length, `empty translation: ${k}`);
    assert.deepEqual([...new Set(holes(v))], [...new Set(holes(k))], `placeholders differ: ${k}`);
    if (!NUMBER_WORDS.has(k)) assert.deepEqual(digits(v), digits(k), `numbers differ: ${k}`);
    assert.deepEqual(addrs(v), addrs(k), `addresses differ: ${k}`);
    for (const w of KEEP) assert.ok(count(v, w) >= Math.min(1, count(k, w)), `"${w}" dropped: ${k}`);
    assert.equal(v.match(/^\s*/)![0], k.match(/^\s*/)![0], `leading space differs: ${k}`);
    assert.equal(v.match(/\s*$/)![0], k.match(/\s*$/)![0], `trailing space differs: ${k}`);
    assert.equal(count(v, "\n"), count(k, "\n"), `line breaks differ: ${k}`);
  }
});

test("the dictionary has no duplicate keys, and no translation is itself another key", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "web", "i18n", "es.js"), "utf8");
  const keys = [...src.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1]) as string);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], "duplicate keys (the later one silently wins)");
  assert.equal(keys.length, Object.keys(es.entries).length);
  // A translated text that is also an English key would be translated twice by the page walker.
  for (const [k, v] of Object.entries(es.entries)) {
    if (v !== k && v in es.entries) assert.equal(es.entries[v], v, `"${v}" (for "${k}") is also a key`);
  }
});

test("tr() fills templates, and finished text is matched with its values untouched", () => {
  assert.equal(es.tr("Paid to holders"), "Pagado a holders");
  assert.equal(es.tr("{vol} XNT a day", { vol: "1,234.5" }), "1,234.5 XNT al día");
  assert.equal(es.tr("Something new"), "Something new"); // unknown: English
  assert.equal(es.tr("Unknown {x}", { x: 5 }), "Unknown 5");
  assert.equal(es.lookup("12.5 XNT a day"), "12.5 XNT al día");
  const addr = "5BVtcDEJfYbUKJSozG6kuWnHjJH6zoA2EQDiU5EcHER4";
  assert.equal(es.tr(`The NFT is held by ${addr}, not this wallet.`), `El NFT lo tiene ${addr}, no esta billetera.`);
  // {~name}: the captured part is translated too when it's a known string.
  assert.equal(es.tr("Website must be a full https:// link"), "Sitio web debe ser un enlace https:// completo");
  assert.equal(es.tr("Too many transactions from this address; try again later."), "Se alcanzó el límite de transacciones desde esta dirección; inténtalo más tarde.");
  // The more specific template wins.
  assert.equal(es.tr("Invalid taxBps: must be a whole number from 100 to 1,000"), "taxBps no válido: debe ser un número entero de 100 a 1,000");
  assert.equal(es.tr("Invalid name"), "name no válido");
});
