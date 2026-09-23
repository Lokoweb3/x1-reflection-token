// Browser wallet helper for the token factory page: finds Wallet Standard wallets
// (X1 Wallet, Backpack, ...) and older injected ones, connects, and signs raw
// transaction bytes. Keys never leave the wallet.
window.X1Wallet = (() => {
  const standard = [];
  const state = { address: null, name: null, active: null, account: null, legacy: null };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => f(state.address));

  function register(...ws) {
    for (const w of ws) {
      if (w?.features?.["standard:connect"] && w.features["solana:signTransaction"] && !standard.includes(w)) standard.push(w);
    }
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

  async function connect(choice) {
    if (choice.standard) {
      const r = await choice.standard.features["standard:connect"].connect();
      const account = r?.accounts?.[0] ?? choice.standard.accounts?.[0];
      if (!account) throw new Error("The wallet didn't share an account.");
      Object.assign(state, { active: choice.standard, account, legacy: null, address: account.address, name: choice.name });
    } else {
      const r = await choice.legacy.connect();
      const pk = r?.publicKey ?? choice.legacy.publicKey;
      Object.assign(state, { active: null, account: null, legacy: choice.legacy, address: pk.toString(), name: choice.name });
    }
    emit();
  }

  async function disconnect() {
    try { await state.active?.features["standard:disconnect"]?.disconnect(); await state.legacy?.disconnect?.(); } catch {}
    Object.assign(state, { active: null, account: null, legacy: null, address: null, name: null });
    emit();
  }

  function loadWeb3() {
    if (window.solanaWeb3) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "/vendor/web3.js"; s.onload = ok; s.onerror = () => fail(new Error("Could not load web3.js"));
      document.head.append(s);
    });
  }

  /** Sign serialized transaction bytes; returns the signed bytes. */
  async function sign(bytes) {
    if (state.active) {
      const input = { account: state.account, transaction: bytes };
      if (state.account.chains?.length) input.chain = state.account.chains[0];
      const [out] = await state.active.features["solana:signTransaction"].signTransaction(input);
      return out.signedTransaction;
    }
    if (!state.legacy) throw new Error("Connect a wallet first.");
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

  return { state, choices, connect, disconnect, sign, onChange: (f) => listeners.add(f), b64ToBytes, bytesToB64 };
})();
