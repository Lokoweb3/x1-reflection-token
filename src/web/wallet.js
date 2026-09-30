// Browser wallet helper for every page: finds Wallet Standard wallets (X1 Wallet,
// Backpack, ...) and older injected ones, connects, and signs raw transaction bytes.
// Keys never leave the wallet. It remembers which wallet was used (by name, in this
// browser) and reconnects to it silently on the next page; wallets only allow that for
// sites the viewer already approved, so it never pops a prompt on its own.
window.X1Wallet = (() => {
  // Messages go through tr() from /i18n.js; English if it's missing.
  const tr = window.tr ?? ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (x, n) => (n in v ? String(v[n]) : x)) : s));
  const standard = [];
  const state = { address: null, name: null, active: null, account: null, legacy: null };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(state.address));
  const KEY = "99tax-wallet";
  const remember = (name) => { try { name ? localStorage.setItem(KEY, name) : localStorage.removeItem(KEY); } catch {} };
  const remembered = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

  function register(...ws) {
    for (const w of ws) {
      if (w?.features?.["standard:connect"] && w.features["solana:signTransaction"] && !standard.includes(w)) standard.push(w);
    }
    queueMicrotask(autoConnect); // the remembered wallet may have just announced itself
    return () => {};
  }
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail({ register }); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: { register } })); } catch {}

  function choices() {
    const seen = new Set();
    const legacy = [["Backpack", window.backpack], ["Phantom", window.phantom?.solana], ["Solflare", window.solflare], ["Browser wallet", window.solana]]
      .filter(([, p]) => p && typeof p.connect === "function" && typeof p.signTransaction === "function" && !seen.has(p) && seen.add(p))
      .filter(([name]) => !standard.some((w) => w.name === name));
    return [...standard.map((w) => ({ name: w.name, icon: w.icon, standard: w })), ...legacy.map(([name, p]) => ({ name, legacy: p }))];
  }

  async function connect(choice, { silent = false } = {}) {
    if (choice.standard) {
      const r = await choice.standard.features["standard:connect"].connect(silent ? { silent: true } : undefined);
      const account = r?.accounts?.[0] ?? choice.standard.accounts?.[0];
      if (!account) throw new Error(tr("The wallet didn't share an account."));
      Object.assign(state, { active: choice.standard, account, legacy: null, address: account.address, name: choice.name });
    } else {
      const r = await choice.legacy.connect(silent ? { onlyIfTrusted: true } : undefined);
      const pk = r?.publicKey ?? choice.legacy.publicKey;
      if (!pk) throw new Error(tr("The wallet didn't share an account."));
      Object.assign(state, { active: null, account: null, legacy: choice.legacy, address: pk.toString(), name: choice.name });
    }
    remember(choice.name);
    emit();
  }

  /** Reconnect to the wallet used last time, without a prompt. Quietly gives up if not allowed. */
  let tried = false;
  async function autoConnect() {
    const name = remembered();
    if (!name || state.address || tried) return;
    const c = choices().find((x) => x.name === name);
    if (!c) return; // not announced yet; register() calls back when it is
    tried = true;
    try { await connect(c, { silent: true }); } catch { /* not pre-approved: wait for a click */ }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(autoConnect, 50));
  else setTimeout(autoConnect, 50);
  setTimeout(autoConnect, 800); // injected (non-standard) wallets can appear late

  async function disconnect() {
    try { await state.active?.features["standard:disconnect"]?.disconnect(); await state.legacy?.disconnect?.(); } catch {}
    Object.assign(state, { active: null, account: null, legacy: null, address: null, name: null });
    remember(null); // an explicit disconnect sticks across pages
    emit();
  }

  function loadWeb3() {
    if (window.solanaWeb3) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "/vendor/web3.js"; s.onload = ok; s.onerror = () => fail(new Error(tr("Could not load web3.js")));
      document.head.append(s);
    });
  }

  // ---------- wrong-network hint ----------
  // Wallets don't reliably say which network they're on, so: warn when the wallet reports
  // only test/dev chains on the mainnet site, or when the wallet has 0 XNT on this site's
  // network (usually it's set to the other one). SITE_NET comes from /theme.js.
  const siteNet = () => (typeof SITE_NET === "object" && SITE_NET ? SITE_NET : null);
  const netName = (n) => (n === "mainnet" ? tr("X1 Mainnet") : tr("X1 Testnet"));
  function showNetWarning(text) {
    document.getElementById("netWarn")?.remove();
    if (!text) return;
    const net = siteNet();
    const bar = document.createElement("div");
    bar.id = "netWarn"; bar.className = "net-warn"; bar.setAttribute("role", "status");
    const msg = document.createElement("span"); msg.textContent = text; bar.append(msg);
    if (net?.other?.url) {
      const a = document.createElement("a");
      a.href = net.other.url.replace(/\/$/, "") + location.pathname.replace(/^\/(nft|leaderboard|curve)\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, "/$1");
      a.textContent = tr("Open the {network} site →", { network: net.other.network });
      bar.append(" ", a);
    }
    const x = document.createElement("button");
    x.type = "button"; x.className = "net-warn-x"; x.setAttribute("aria-label", tr("Dismiss")); x.textContent = "✕";
    x.onclick = () => { bar.remove(); try { sessionStorage.setItem("99tax-netwarn-" + state.address, "1"); } catch {} };
    bar.append(x);
    (document.querySelector(".topbar") ?? document.body.firstElementChild)?.after(bar);
  }
  async function checkNetwork() {
    const net = siteNet();
    if (!net || !state.address) { showNetWarning(null); return; }
    try { if (sessionStorage.getItem("99tax-netwarn-" + state.address)) return; } catch {}
    const chains = state.account?.chains ?? [];
    if (net.network === "mainnet" && chains.length && chains.every((c) => /testnet|devnet/i.test(c))) {
      showNetWarning(tr("Your wallet looks set to a test network, but this is the {network} site. Switch your wallet to {network} before signing anything.", { network: netName(net.network) }));
      return;
    }
    try {
      const r = await fetch(`/api/balance/${state.address}`).then((x) => x.json());
      if (typeof r.xnt === "number" && r.xnt === 0) {
        showNetWarning(tr("This wallet has no XNT on {network}. If your wallet is set to {other}, switch it to {network} (every transaction here needs a little XNT for fees).", { network: netName(net.network), other: net.network === "mainnet" ? "testnet" : "mainnet" }));
      } else showNetWarning(null);
    } catch { /* no hint if the check fails */ }
  }
  listeners.add(() => { checkNetwork(); });

  /** Sign serialized transaction bytes; returns the signed bytes. */
  async function sign(bytes) {
    try { return await signRaw(bytes); } catch (e) {
      const m = String(e?.message ?? e);
      const net = siteNet();
      // A wallet on the other network can't find this network's blockhash or accounts.
      if (net && /blockhash|simulat|not found|cluster|genesis|network|insufficient/i.test(m)) {
        throw new Error(`${m} ${tr("(Check that your wallet is set to {network}.)", { network: netName(net.network) })}`);
      }
      throw e;
    }
  }
  /**
   * Sign several transactions with one approval where the wallet supports it (Wallet
   * Standard takes a list; older wallets have signAllTransactions); else one by one.
   */
  async function signAll(list) {
    try {
      if (state.active) {
        const inputs = list.map((transaction) => ({ account: state.account, transaction, ...(state.account.chains?.length ? { chain: state.account.chains[0] } : {}) }));
        const out = await state.active.features["solana:signTransaction"].signTransaction(...inputs);
        return out.map((o) => o.signedTransaction);
      }
      if (state.legacy?.signAllTransactions) {
        await loadWeb3();
        const signed = await state.legacy.signAllTransactions(list.map((b) => window.solanaWeb3.Transaction.from(b)));
        return signed.map((t) => t.serialize({ requireAllSignatures: true }));
      }
    } catch (e) {
      const m = String(e?.message ?? e), net = siteNet();
      if (net && /blockhash|simulat|not found|cluster|genesis|network|insufficient/i.test(m)) throw new Error(`${m} ${tr("(Check that your wallet is set to {network}.)", { network: netName(net.network) })}`);
      throw e;
    }
    const out = [];
    for (const b of list) out.push(await sign(b));
    return out;
  }
  async function signRaw(bytes) {
    if (state.active) {
      const input = { account: state.account, transaction: bytes };
      if (state.account.chains?.length) input.chain = state.account.chains[0];
      const [out] = await state.active.features["solana:signTransaction"].signTransaction(input);
      return out.signedTransaction;
    }
    if (!state.legacy) throw new Error(tr("Connect a wallet first."));
    await loadWeb3();
    const signed = await state.legacy.signTransaction(window.solanaWeb3.Transaction.from(bytes));
    return signed.serialize({ requireAllSignatures: true });
  }

  const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  function bytesToB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  return { state, choices, connect, disconnect, sign, signAll, onChange: (f) => listeners.add(f), b64ToBytes, bytesToB64 };
})();
