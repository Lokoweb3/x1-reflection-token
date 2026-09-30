/*
 * Page language for every public page. Loaded first in <head> (before theme.js), so the
 * viewer's language is known before anything is drawn. Nothing leaves the browser: the
 * dictionaries are files on this site (/i18n/<lang>.js) and the lookups happen here.
 *
 * English is the source text: a dictionary maps each English string to its translation,
 * so English needs no dictionary at all. Keys with {name} are templates:
 *   tr("Paid to holders {n} XNT", { n })        in page scripts
 * and the same keys also match finished text ("Paid to holders 12.5 XNT"), which is how
 * static HTML, messages from the server and anything a script built without tr() get
 * translated: a walk over the page at load, then a MutationObserver for later changes.
 * The {name} parts are copied through unchanged, so numbers, symbols, addresses and
 * signatures are never altered. {~name} is translated too if it's a known string.
 *
 * The choice lives in this browser only (localStorage). ?lang=es sets it from a link.
 * With nothing stored, a browser set to Spanish gets Spanish. Adding a language: a
 * dictionary file in src/web/i18n/ and a line in LANGS.
 */
(() => {
  const LANGS = [["en", "English"], ["es", "Español"]];
  const KEY = "99tax-lang";
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const set = (v) => { try { v == null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch {} };
  const valid = (l) => LANGS.some(([id]) => id === l);

  const q = new URLSearchParams(location.search).get("lang");
  if (q && valid(q)) set(q);
  const stored = get();
  const lang = valid(stored) ? stored : /^es\b/i.test(navigator.language || "") ? "es" : "en";
  document.documentElement.lang = lang;

  // ---------- dictionaries ----------
  let exact = null, patterns = [];
  const cache = new Map();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** Called by /i18n/<lang>.js with { "English": "Translation", ... }. */
  function add(code, dict) {
    if (code !== lang) return;
    exact = new Map(Object.entries(dict));
    patterns = [];
    for (const [k, v] of exact) {
      if (!/\{~?\w+\}/.test(k)) continue;
      const names = [], parts = k.split(/\{(~?\w+)\}/);
      let re = "^";
      parts.forEach((p, i) => { if (i % 2) { names.push(p); re += "([\\s\\S]*?)"; } else re += esc(p); });
      // The longest literal piece is a cheap first check before the regex.
      const anchor = parts.filter((_, i) => i % 2 === 0).sort((a, b) => b.length - a.length)[0];
      patterns.push({ re: new RegExp(re + "$"), names, value: v, anchor, fixed: parts.join("").length - names.join("").length });
    }
    // Most specific first: "Invalid {field}: must be …" before "Invalid {field}".
    patterns.sort((a, b) => b.fixed - a.fixed);
    cache.clear();
  }
  /** The translation of a finished English string, or undefined. */
  function lookup(s) {
    if (!exact) return undefined;
    const hit = exact.get(s);
    if (hit !== undefined) return hit;
    if (cache.has(s)) return cache.get(s);
    let out;
    for (const p of patterns) {
      if (p.anchor && !s.includes(p.anchor)) continue;
      const m = p.re.exec(s);
      if (!m) continue;
      const got = {};
      p.names.forEach((n, i) => { got[n] = n[0] === "~" ? (lookup(m[i + 1]) ?? m[i + 1]) : m[i + 1]; });
      out = p.value.replace(/\{(~?\w+)\}/g, (x, n) => (n in got ? got[n] : x));
      break;
    }
    cache.set(s, out);
    return out;
  }
  /** Translate `key`, then fill {name}s from `vars`. Unknown keys come back as English. */
  function tr(key, vars) {
    const s = String(key ?? "");
    let out = exact?.get(s);
    if (out === undefined) out = vars ? s : (lookup(s) ?? s);
    return vars ? out.replace(/\{(\w+)\}/g, (x, n) => (n in vars ? String(vars[n]) : x)) : out;
  }

  // ---------- the page ----------
  // Text people copy (addresses, signatures, code) and anything marked translate="no" is left alone.
  const SKIP = "script, style, textarea, code, pre, .mono, .addr, [translate=no]";
  const ATTRS = ["title", "placeholder", "aria-label", "alt"];
  function trText(s) {
    const core = s.replace(/\s+/g, " ").trim();
    if (!core || !/[A-Za-z]/.test(core)) return null;
    const out = lookup(core);
    if (out === undefined || out === core) return null;
    return s.match(/^\s*/)[0] + out + s.match(/\s*$/)[0];
  }
  function trNode(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) return;
      const out = trText(n.data);
      if (out !== null) n.data = out;
    } else if (n.nodeType === 1) {
      if (n.closest("[translate=no]")) return;
      for (const a of ATTRS) {
        const v = n.getAttribute(a);
        if (v) { const out = trText(v); if (out !== null) n.setAttribute(a, out); }
      }
    }
  }
  function walk(root) {
    trNode(root);
    if (root.nodeType !== 1) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) trNode(n);
  }

  if (lang !== "en") {
    // Keep the English page out of sight until it's translated (never longer than 2.5 s).
    const style = document.createElement("style");
    style.textContent = "html.i18n-wait body { visibility: hidden; }";
    document.head.append(style);
    document.documentElement.classList.add("i18n-wait");
    const show = () => document.documentElement.classList.remove("i18n-wait");
    setTimeout(show, 2500);
    // Parser-blocking, so the dictionary is in place before the page's own scripts run.
    document.write(`<script src="/i18n/${lang}.js"><\/script>`);
    document.addEventListener("DOMContentLoaded", () => {
      if (exact) {
        const t = lookup(document.title);
        if (t) document.title = t;
        walk(document.body);
        new MutationObserver((list) => {
          for (const m of list) {
            if (m.type === "childList") m.addedNodes.forEach(walk);
            else trNode(m.target);
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
      }
      show();
    });
  }

  /** Switch language: remembered here, then the page reloads in it (minus any ?lang=). */
  function setLang(code) {
    if (!valid(code)) return;
    set(code);
    const u = new URL(location.href);
    u.searchParams.delete("lang");
    location.replace(u.href);
  }

  window.tr = tr;
  window.I18N = { lang, langs: LANGS, add, tr, lookup, setLang };
})();
