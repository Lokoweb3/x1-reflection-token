/*
 * Live countdowns. Countdown.el(unixSeconds) returns a <span> that ticks every second
 * ("6d 23h 12m 05s") with the exact local date as its tooltip. When it reaches zero it
 * says "now" and fires a bubbling "countdown-done" event once, so the page can refresh
 * whatever just unlocked.
 */
window.Countdown = (() => {
  const left = (s) => {
    if (s <= 0) return "now";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = String(Math.floor(s % 60)).padStart(2, "0");
    return d ? `${d}d ${h}h ${m}m ${sec}s` : h ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
  };
  function tick() {
    const now = Date.now() / 1000;
    for (const e of document.querySelectorAll("[data-until]")) {
      const s = Number(e.dataset.until) - now;
      e.textContent = left(s);
      if (s <= 0 && !e.dataset.done) {
        e.dataset.done = "1";
        e.classList.add("done");
        e.dispatchEvent(new CustomEvent("countdown-done", { bubbles: true }));
      }
    }
  }
  setInterval(tick, 1000);
  function el(unixSec) {
    const s = document.createElement("span");
    s.className = "countdown";
    s.dataset.until = String(unixSec);
    s.title = new Date(unixSec * 1000).toLocaleString();
    s.textContent = left(unixSec - Date.now() / 1000);
    return s;
  }
  return { el, left };
})();
