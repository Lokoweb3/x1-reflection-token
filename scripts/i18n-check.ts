/**
 * Page translations: what needs translating, and what a language is missing.
 *
 *   npx tsx scripts/i18n-check.ts            # Spanish (es)
 *   npx tsx scripts/i18n-check.ts es --all   # also list every key found
 *
 * It lists, for each public page (src/*.html) and the shared scripts (src/web/*.js):
 *   - static text and title/placeholder/aria-label/alt/data-forever attributes (the page
 *     translator in src/web/i18n.js matches these by their exact English text),
 *   - every tr("…") key,
 *   - sentence-like string literals in page scripts that aren't wrapped in tr() (usually a
 *     string someone forgot to wrap),
 * and reports the ones the dictionary (src/web/i18n/<lang>.js) doesn't cover. The same
 * checks run in `npm test` (test/i18n.test.ts). It reads files only; nothing is sent anywhere.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The public pages (dashboard.html is the operator's local dashboard, English only). */
export const PAGES = ["landing", "factory", "tokens", "nft", "wallet", "leaderboard", "analytics", "curve", "faucet"]
  .map((p) => path.join(ROOT, "src", `${p}.html`));
export const SHARED = ["theme.js", "wallet.js", "countdown.js"].map((f) => path.join(ROOT, "src", "web", f));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–", times: "×", middot: "·" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Static text of a page: text between tags and the translatable attributes, as the page translator sees them. */
export function staticTexts(html: string): string[] {
  const out = new Set<string>();
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (title) out.add(norm(decode(title[1])));
  const body = html.slice(html.search(/<body[\s>]/)).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/>([^<]+)</g)) out.add(norm(decode(m[1])));
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label|alt|data-forever)="([^"]*)"/g)) out.add(norm(decode(m[1])));
  return [...out].filter((s) => /[A-Za-z]/.test(s));
}

/** Inline page scripts, or the whole file for .js. */
const scriptsOf = (file: string) => {
  const src = fs.readFileSync(file, "utf8");
  return file.endsWith(".js") ? [src] : [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
};

/** Every tr("…") key (string-literal first argument). */
export function trKeys(code: string): string[] {
  return [...code.matchAll(/\btr\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
}

/**
 * Sentence-like literals not wrapped in tr(): quoted or template strings that start with a
 * capital letter and have at least two words, outside a tr( call. Placeholders become {}.
 */
export function unwrapped(code: string): string[] {
  const out: string[] = [];
  code = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"); // comments
  for (const m of code.matchAll(/(tr\(\s*)?("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) {
    if (m[1]) continue;
    const before = code.slice(Math.max(0, m.index! - 40), m.index);
    if (/(?:getElementById|querySelector(?:All)?|fetch|api|getJson|\$|createElement|addEventListener|setAttribute|replace|split|join|test|console\.\w+)\(\s*$/.test(before)) continue;
    const text = m[2].slice(1, -1).replace(/\$\{[^}]*\}/g, "{}");
    if (/^[A-Z][a-z']*[ ,:][^\n]*[a-z]{2}/.test(text) && !/^[A-Z][a-z]+\s*[({=]/.test(text)) out.push(text);
  }
  return out;
}

/** The dictionary for `lang`, loaded through the real page helper (src/web/i18n.js) with a stub page. */
export function loadLang(lang: string) {
  const html = { lang: "", classList: { add() {}, remove() {} } };
  const ctx: Record<string, unknown> = {
    localStorage: { getItem: () => lang, setItem() {}, removeItem() {} },
    location: { search: "", href: "http://localhost/" }, navigator: { language: "en" }, URL, URLSearchParams,
    document: { documentElement: html, head: { append() {} }, createElement: () => ({}), write() {}, addEventListener() {} },
    setTimeout: () => 0,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "web", "i18n.js"), "utf8"), ctx);
  const file = path.join(ROOT, "src", "web", "i18n", `${lang}.js`);
  const src = fs.readFileSync(file, "utf8");
  vm.runInContext(src, ctx);
  // The raw entries too (for the checks on each translation).
  const entries: Record<string, string> = {};
  vm.runInNewContext(src, { I18N: { add: (_: string, d: Record<string, string>) => Object.assign(entries, d) } });
  const api = ctx.I18N as { tr: (k: string, v?: Record<string, unknown>) => string; lookup: (s: string) => string | undefined };
  return { ...api, entries };
}

/** Everything a language is missing: static texts, tr() keys, and unwrapped literals. */
export function report(lang: string) {
  const d = loadLang(lang);
  const missing = { static: [] as string[], keys: [] as string[], unwrapped: [] as string[] };
  const seen = new Set<string>();
  const add = (list: string[], where: string, s: string) => { const k = `${list === missing.static ? "s" : list === missing.keys ? "k" : "u"}|${s}`; if (!seen.has(k)) { seen.add(k); list.push(`${where}: ${s}`); } };
  for (const file of [...PAGES, ...SHARED]) {
    const name = path.relative(ROOT, file);
    if (file.endsWith(".html")) for (const s of staticTexts(fs.readFileSync(file, "utf8"))) if (d.lookup(s) === undefined) add(missing.static, name, s);
    for (const code of scriptsOf(file)) {
      for (const k of trKeys(code)) if (!(k in d.entries)) add(missing.keys, name, k);
      for (const s of unwrapped(code)) if (!ALLOW_UNWRAPPED.has(s)) add(missing.unwrapped, name, s);
    }
  }
  return missing;
}

/** Literals the unwrapped check flags that aren't page text (or stay English on purpose). */
export const ALLOW_UNWRAPPED = new Set<string>([
  "Browser wallet", // wallet.js remembers the wallet by this name; the menu shows it translated
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lang = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "es";
  const r = report(lang);
  const n = r.static.length + r.keys.length + r.unwrapped.length;
  for (const [what, list] of Object.entries(r)) if (list.length) console.log(`\n${what} (${list.length}):\n  ${list.join("\n  ")}`);
  if (process.argv.includes("--all")) {
    for (const file of [...PAGES, ...SHARED]) {
      console.log(`\n# ${path.relative(ROOT, file)}`);
      if (file.endsWith(".html")) for (const s of staticTexts(fs.readFileSync(file, "utf8"))) console.log(`  ${JSON.stringify(s)}`);
      for (const code of scriptsOf(file)) for (const k of trKeys(code)) console.log(`  ${JSON.stringify(k)}`);
    }
  }
  console.log(n ? `\n${lang}: ${n} untranslated.` : `${lang}: everything is translated.`);
  process.exitCode = n ? 1 : 0;
}
