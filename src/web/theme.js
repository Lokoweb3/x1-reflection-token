/*
 * Theme picker for every public page. Loaded right after the theme stylesheet in <head>,
 * so the viewer's saved choice applies before the page paints. The server prepends
 * `const SITE_THEME = "<factory.theme>";`.
 *
 * Choices live in this browser only (localStorage): the theme (receipt, arcade,
 * lunchbag) and the mode (auto follows the device, or light / dark). A shared link can
 * carry ?theme=… and ?mode=… to set them; ?theme=default clears the theme choice.
 */
(() => {
  // Page text goes through tr() from /i18n.js (loaded just before this file); English if it's missing.
  const tr = window.tr ?? ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (x, n) => (n in v ? String(v[n]) : x)) : s));
  const THEMES = [["receipt", tr("Receipt"), tr("Cream paper, monospace")], ["arcade", tr("Arcade"), tr("Pixels and scanlines")], ["lunchbag", tr("Lunch bag"), tr("Kraft paper, marker")], ["notebook", tr("Notebook"), tr("Lined paper, sticky notes")]];
  const MODES = [["auto", tr("Auto")], ["light", tr("Light")], ["dark", tr("Dark")]];
  const ALWAYS_DARK = new Set(["arcade"]);
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const valid = (t) => THEMES.some(([id]) => id === t);

  const q = new URLSearchParams(location.search);
  const qt = q.get("theme"), qm = q.get("mode");
  if (qt) set("99tax-theme", qt === "default" || !valid(qt) ? null : qt);
  if (qm) set("99tax-mode", MODES.some(([id]) => id === qm) && qm !== "auto" ? qm : null);

  const current = () => { const t = get("99tax-theme"); return valid(t) ? t : (valid(SITE_THEME) ? SITE_THEME : "receipt"); };
  const mode = () => get("99tax-mode") ?? "auto";
  function apply() {
    const link = document.querySelector('link[rel="stylesheet"][href^="/theme"]');
    const t = current();
    if (link && !link.href.endsWith(`/theme-${t}.css`)) link.href = `/theme-${t}.css`;
    const m = mode(), root = document.documentElement;
    if (m === "auto") delete root.dataset.mode; else root.dataset.mode = m;
    root.dataset.theme = t;
  }
  apply();

  // Browser-tab and home-screen icons (same on every page).
  for (const [rel, href, sizes] of [["icon", "/brand/logo-64.png", "64x64"], ["apple-touch-icon", "/brand/logo-192.png", "192x192"]]) {
    if (document.head.querySelector(`link[rel="${rel}"]`)) continue;
    const l = document.createElement("link"); l.rel = rel; l.href = href; l.sizes = sizes; l.type = "image/png";
    document.head.append(l);
  }

  /** The 99 + Tax logo in the header, in place of each theme's text badge. */
  function brandLogo() {
    for (const a of document.querySelectorAll("a.brand, header .brand, a.logo")) {
      if (a.classList.contains("has-logo")) continue;
      const img = document.createElement("img");
      img.src = "/brand/logo-wide-120.png"; img.alt = ""; img.className = "brand-logo"; img.width = 88; img.height = 48;
      a.setAttribute("aria-label", tr("99 + Tax home"));
      a.classList.add("has-logo");
      a.prepend(img);
    }
  }

  // ---------- Mainnet / Testnet toggle ----------
  // The same site runs on both networks at different addresses (factory.otherNetwork);
  // switching keeps you on the same page, minus any token or NFT address (they differ
  // between networks). Wallet addresses are the same on both, so /wallet/<addr> is kept.
  function netToggle() {
    const net = typeof SITE_NET === "object" && SITE_NET ? SITE_NET : null;
    const host = document.querySelector("header nav") || document.querySelector("nav .links") || document.querySelector(".mainnav");
    if (!net || !host || document.getElementById("netToggle")) return;
    const wrap = document.createElement("div");
    wrap.className = "net-toggle"; wrap.id = "netToggle"; wrap.setAttribute("role", "group"); wrap.setAttribute("aria-label", tr("Network"));
    const path = location.pathname.replace(/^\/(nft|leaderboard|curve)\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, "/$1");
    for (const id of ["mainnet", "testnet"]) {
      const here = id === net.network;
      // The faucet and (for now) bonding curves only exist on testnet.
      const to = id === "mainnet" && /^\/(faucet|curve)$/.test(path) ? "/" : path;
      const url = here ? null : net.other && net.other.network === id ? net.other.url.replace(/\/$/, "") + to : null;
      const el = document.createElement(url ? "a" : "span");
      el.textContent = id === "mainnet" ? "Mainnet" : "Testnet";
      el.className = `net-${id}`;
      if (here) el.setAttribute("aria-current", "true");
      if (url) { el.href = url; el.title = tr("Open the {network} site", { network: id }); }
      else if (!here) { el.setAttribute("aria-disabled", "true"); el.title = tr("No {network} site linked", { network: id }); }
      wrap.append(el);
    }
    host.append(wrap);
  }

  // ---------- the menu ----------
  function build() {
    const host = document.querySelector("header nav") || document.querySelector("nav .links") || document.querySelector(".mainnav");
    if (!host || document.getElementById("themePicker")) return;
    const d = document.createElement("details");
    d.className = "theme-picker"; d.id = "themePicker";
    const s = document.createElement("summary");
    s.setAttribute("aria-label", tr("Change theme"));
    s.innerHTML = '<span aria-hidden="true">◐</span> ';
    s.append(tr("Theme"));
    const menu = document.createElement("div");
    menu.className = "tp-menu";
    d.append(s, menu);
    const render = () => {
      menu.replaceChildren();
      const h1 = document.createElement("div"); h1.className = "tp-h"; h1.textContent = tr("Theme"); menu.append(h1);
      for (const [id, name, note] of THEMES) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "tp-opt"; b.setAttribute("aria-pressed", String(current() === id));
        b.innerHTML = `<span class="tp-sw tp-sw-${id}" aria-hidden="true"></span><span><b></b><small></small></span>`;
        b.querySelector("b").textContent = name; b.querySelector("small").textContent = note;
        b.onclick = () => { set("99tax-theme", id === SITE_THEME ? null : id); apply(); render(); };
        menu.append(b);
      }
      const h2 = document.createElement("div"); h2.className = "tp-h"; h2.textContent = tr("Mode"); menu.append(h2);
      const row = document.createElement("div"); row.className = "tp-modes"; row.setAttribute("role", "group"); row.setAttribute("aria-label", tr("Light or dark"));
      const locked = ALWAYS_DARK.has(current());
      for (const [id, name] of MODES) {
        const b = document.createElement("button");
        b.type = "button"; b.textContent = name; b.setAttribute("aria-pressed", String(mode() === id));
        b.disabled = locked;
        b.onclick = () => { set("99tax-mode", id === "auto" ? null : id); apply(); render(); };
        row.append(b);
      }
      menu.append(row);
      const n = document.createElement("div"); n.className = "tp-note";
      n.textContent = locked ? tr("Arcade is always dark.") : mode() === "auto" ? tr("Auto follows your device's light/dark setting.") : tr("Saved in this browser.");
      menu.append(n);
    };
    render();
    host.append(d);
    // composedPath() is fixed at dispatch, so a click on an option still counts as inside
    // after render() has replaced that option.
    document.addEventListener("click", (ev) => { if (d.open && !ev.composedPath().includes(d)) d.open = false; });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && d.open) { d.open = false; s.focus(); } });
  }
  // ---------- language menu ----------
  // Same look as the theme menu; the choice is kept by /i18n.js and the page reloads in it.
  function langMenu() {
    const host = document.querySelector("header nav") || document.querySelector("nav .links") || document.querySelector(".mainnav");
    const i18n = window.I18N;
    if (!host || !i18n || document.getElementById("langPicker")) return;
    const d = document.createElement("details");
    d.className = "theme-picker lang-picker"; d.id = "langPicker";
    const s = document.createElement("summary");
    const here = i18n.langs.find(([id]) => id === i18n.lang) ?? i18n.langs[0];
    s.setAttribute("aria-label", tr("Language: {name}", { name: here[1] }));
    s.textContent = here[0].toUpperCase();
    const menu = document.createElement("div");
    menu.className = "tp-menu";
    const h = document.createElement("div"); h.className = "tp-h"; h.textContent = tr("Language"); menu.append(h);
    for (const [id, name] of i18n.langs) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tp-opt"; b.lang = id; b.setAttribute("aria-pressed", String(id === i18n.lang));
      b.innerHTML = '<span class="tp-sw tp-sw-lang" aria-hidden="true"></span><span><b></b></span>';
      b.querySelector(".tp-sw").textContent = id.toUpperCase(); b.querySelector("b").textContent = name;
      b.onclick = () => { if (id !== i18n.lang) i18n.setLang(id); else d.open = false; };
      menu.append(b);
    }
    d.append(s, menu);
    // Theme and language menus sit together, so they wrap onto a new line as a pair.
    const prefs = document.createElement("span");
    prefs.className = "site-prefs";
    const theme = document.getElementById("themePicker");
    if (theme?.parentElement === host) { theme.replaceWith(prefs); prefs.append(theme); } else host.append(prefs);
    prefs.append(d);
    document.addEventListener("click", (ev) => { if (d.open && !ev.composedPath().includes(d)) d.open = false; });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && d.open) { d.open = false; s.focus(); } });
  }
  // ---------- shared empty state ----------
  // A friendly "nothing here yet" block for list pages: a launch link, and on mainnet a
  // link to the same page on testnet, where there's something to look at.
  // `action` swaps the launch link for another ({ href, text }), e.g. the curve form.
  window.siteEmpty = (message, action) => {
    const net = typeof SITE_NET === "object" && SITE_NET ? SITE_NET : null;
    const box = document.createElement("div"); box.className = "site-empty";
    const p = document.createElement("p"); p.textContent = message; box.append(p);
    const row = document.createElement("div"); row.className = "site-empty-actions";
    const launch = document.createElement("a"); launch.className = "btn primary"; launch.href = action?.href ?? "/launch"; launch.textContent = action?.text ?? tr("Launch the first one →");
    row.append(launch);
    if (net?.network === "mainnet" && net.other?.url) {
      const t = document.createElement("a"); t.className = "btn"; t.textContent = tr("Try it free on testnet →");
      t.href = net.other.url.replace(/\/$/, "") + location.pathname.replace(/^\/(nft|leaderboard|curve)\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, "/$1");
      row.append(t);
      const n = document.createElement("p"); n.className = "site-empty-note";
      n.textContent = tr("Testnet has live example tokens, NFTs and payouts, plus a faucet for free test XNT.");
      box.append(row, n);
    } else box.append(row);
    return box;
  };

  // ---------- phone tables ----------
  // Tables with 4+ columns become stacked cards on phones (CSS in theme-base.css): each
  // cell gets its column's name as a label. Pages redraw tables, so this re-runs on changes.
  // Columns that take a whole row on a phone card (by header, in English or the page's language).
  const FULL = new Set(["wallet", "token", "name", tr("Wallet"), tr("Token"), tr("Name")].map((x) => x.toLowerCase()));
  function labelTables() {
    for (const t of document.querySelectorAll("table")) {
      if (t.closest(".receipt, #contracts") || t.id === "costTable") continue;
      const head = [...t.rows].find((r) => r.querySelector("th"));
      if (!head) continue;
      const names = [...head.cells].map((c) => c.textContent.replace(/[↑↓]/g, "").trim());
      if (names.length < 4) { t.removeAttribute("data-stack"); continue; }
      t.setAttribute("data-stack", "");
      head.classList.add("stack-head");
      for (const r of t.rows) {
        if (r === head) continue;
        [...r.cells].forEach((c, i) => {
          const n = r.cells.length === 1 ? "" : names[i] ?? "";
          if (c.dataset.label !== n) c.dataset.label = n;
          c.classList.toggle("stack-hide", n === "#");
          c.classList.toggle("stack-full", FULL.has(n.toLowerCase()) || r.cells.length === 1);
        });
      }
    }
  }
  let tablesQueued = false;
  const queueTables = () => { if (!tablesQueued) { tablesQueued = true; requestAnimationFrame(() => { tablesQueued = false; labelTables(); }); } };

  // ---------- phone menu ----------
  // Under 860px the header's links collapse behind a Menu button (CSS in theme-base.css);
  // the page's main button (Launch a token) stays visible.
  function phoneMenu() {
    const host = document.querySelector("header nav") || document.querySelector("nav .links") || document.querySelector(".mainnav");
    if (!host || document.getElementById("mnavBtn")) return;
    host.id ||= "mainMenu";
    host.classList.add("mnav-host");
    host.parentElement.classList.add("has-mnav");
    const b = document.createElement("button");
    b.type = "button"; b.id = "mnavBtn"; b.className = "mnav-btn";
    b.setAttribute("aria-controls", host.id); b.setAttribute("aria-expanded", "false");
    b.innerHTML = '<span aria-hidden="true">☰</span> ';
    b.append(tr("Menu"));
    b.onclick = () => { const open = host.classList.toggle("open"); b.setAttribute("aria-expanded", String(open)); b.firstChild.textContent = open ? "✕" : "☰"; };
    host.before(b);
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && host.classList.contains("open")) b.click(); });
  }
  const mount = () => {
    brandLogo(); netToggle(); build(); langMenu(); phoneMenu(); labelTables();
    new MutationObserver(queueTables).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
