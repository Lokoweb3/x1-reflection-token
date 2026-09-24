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
  const THEMES = [["receipt", "Receipt", "Cream paper, monospace"], ["arcade", "Arcade", "Pixels and scanlines"], ["lunchbag", "Lunch bag", "Kraft paper, marker"], ["notebook", "Notebook", "Lined paper, sticky notes"]];
  const MODES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
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

  // ---------- the menu ----------
  function build() {
    const host = document.querySelector("header nav") || document.querySelector("nav .links") || document.querySelector(".mainnav");
    if (!host || document.getElementById("themePicker")) return;
    const d = document.createElement("details");
    d.className = "theme-picker"; d.id = "themePicker";
    const s = document.createElement("summary");
    s.setAttribute("aria-label", "Change theme");
    s.innerHTML = '<span aria-hidden="true">◐</span> Theme';
    const menu = document.createElement("div");
    menu.className = "tp-menu";
    d.append(s, menu);
    const render = () => {
      menu.replaceChildren();
      const h1 = document.createElement("div"); h1.className = "tp-h"; h1.textContent = "Theme"; menu.append(h1);
      for (const [id, name, note] of THEMES) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "tp-opt"; b.setAttribute("aria-pressed", String(current() === id));
        b.innerHTML = `<span class="tp-sw tp-sw-${id}" aria-hidden="true"></span><span><b></b><small></small></span>`;
        b.querySelector("b").textContent = name; b.querySelector("small").textContent = note;
        b.onclick = () => { set("99tax-theme", id === SITE_THEME ? null : id); apply(); render(); };
        menu.append(b);
      }
      const h2 = document.createElement("div"); h2.className = "tp-h"; h2.textContent = "Mode"; menu.append(h2);
      const row = document.createElement("div"); row.className = "tp-modes"; row.setAttribute("role", "group"); row.setAttribute("aria-label", "Light or dark");
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
      n.textContent = locked ? "Arcade is always dark." : mode() === "auto" ? "Auto follows your device's light/dark setting." : "Saved in this browser.";
      menu.append(n);
    };
    render();
    host.append(d);
    // composedPath() is fixed at dispatch, so a click on an option still counts as inside
    // after render() has replaced that option.
    document.addEventListener("click", (ev) => { if (d.open && !ev.composedPath().includes(d)) d.open = false; });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && d.open) { d.open = false; s.focus(); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
