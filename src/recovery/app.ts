/**
 * The Tax Vault recovery page: one self-contained file, pinned to IPFS, that keeps every
 * vault working with nothing from 99 + Tax running. It talks only to an X1 RPC, IPFS
 * gateways and the visitor's wallet:
 *
 *   status    any vault's state, read from the chain; the active rewards list fetched from
 *             IPFS by its on-chain CID and checked against the on-chain root
 *   run       the permissionless steps due now (collect, sell, add liquidity, creator
 *             reward, pay / pay_fallback), the same plan as the site's "Run the vault now"
 *             (planForCaller), signed by the visitor's wallet, who earns the crank reward
 *   appoint   the vault's guardian (the token's creator) appoints a new publisher once the
 *             publisher has published nothing for 7 days
 *
 * It can't publish new lists (that needs a holder snapshot and an IPFS upload key): the
 * appointed publisher runs scripts/crank.ts for that, and after 30 days pay_fallback pays
 * holders from the last list without anyone publishing. Built by scripts/build-recovery.ts.
 */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import bs58 from "bs58";
import { XDEX_PROGRAM_IDS, fromBaseUnits } from "../config.js";
import {
  TAX_VAULT_PROGRAM_ID, VAULT_DISC, VAULT_VERSION, appointAllowedAt, appointPublisherIx, cidFromBytes, decodeVault, effectiveList, errorOf,
  fallbackAt, parseEvents, rewardTokenInfo, type Vault,
} from "../taxvault.js";
import { ACTIVATION_MARGIN_SECS, defaultRules, inFallback, nowSecs, parseListFile, planForCaller, rulesFromJson, type CrankRules, type PayList, type PlannedStep } from "../vault-crank.js";
import { confirmByPolling, fitComputeLimit } from "../tx.js";

declare const X1Wallet: {
  state: { address: string | null; name: string | null };
  choices(): { name: string; icon?: string }[];
  connect(c: { name: string }): Promise<void>;
  disconnect(): Promise<void>;
  signAll(list: Uint8Array[]): Promise<Uint8Array[]>;
  onChange(f: (address: string | null) => void): void;
};
// Legacy (non Wallet Standard) wallets sign web3.js Transactions; wallet.js looks for this.
(window as unknown as { solanaWeb3: unknown }).solanaWeb3 = { Transaction };

type Net = "testnet" | "mainnet";
const NETS: Record<Net, { rpc: string; explorer: string }> = {
  testnet: { rpc: "https://rpc.testnet.x1.xyz", explorer: "https://explorer.testnet.x1.xyz" },
  mainnet: { rpc: "https://rpc.mainnet.x1.xyz", explorer: "https://explorer.mainnet.x1.xyz" },
};
const GATEWAYS = "https://gateway.pinata.cloud/ipfs/, https://ipfs.io/ipfs/, https://dweb.link/ipfs/";
const MICRO_LAMPORTS = 10_000;
/** Wallets paid per run (one transaction); run again for more. */
const MAX_PAYS = 6;

// ---------- small DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string | null | undefined | false)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "text" ? (e.textContent = v) : e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}
const link = (href: string, text: string) => el("a", { href, target: "_blank", rel: "noopener", text });
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const xnt = (lamports: bigint) => `${fromBaseUnits(lamports, 9)} XNT`;
const when = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function ago(secs: number) {
  const d = nowSecs() - secs, a = Math.abs(d);
  const t = a < 3600 ? `${Math.round(a / 60)} min` : a < 172_800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} days`;
  return d >= 0 ? `${t} ago` : `in ${t}`;
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function log(text: string, kind: "" | "good" | "bad" = "", href?: string) {
  $("log").querySelector("li.placeholder")?.remove();
  const row = el("li", kind ? { class: kind } : {}, text);
  if (href) row.append(" ", link(href, "view ↗"));
  $("log").prepend(row);
}

// ---------- settings ----------
function settings() {
  const net = ($<HTMLSelectElement>("net").value as Net);
  const rpc = $<HTMLInputElement>("rpc").value.trim() || NETS[net].rpc;
  const program = new PublicKey($<HTMLInputElement>("program").value.trim() || TAX_VAULT_PROGRAM_ID.toBase58());
  const gateways = ($<HTMLInputElement>("gateways").value.trim() || GATEWAYS).split(/[\s,]+/).filter(Boolean).map((g) => g.replace(/\/?$/, "/"));
  return { net, rpc, program, gateways, explorer: NETS[net].explorer };
}
let conn: Connection;
let S: ReturnType<typeof settings>;
function connect() {
  S = settings();
  conn = new Connection(S.rpc, { commitment: "confirmed", disableRetryOnRateLimit: false });
}

// ---------- reading a vault ----------
interface Loaded {
  v: Vault; mint: PublicKey; symbol: string; name: string; taxBps: number; supply: bigint;
  xdex: PublicKey; network: Net; rules: CrankRules;
  list: (PayList & { cid: string; wallets: Record<string, string> }) | null; listError: string | null;
}
let current: Loaded | null = null;

async function fetchCid(cid: string) {
  const errors: string[] = [];
  for (const g of S.gateways) {
    try {
      const r = await fetch(`${g}${cid}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) { errors.push(`${new URL(g).host}: HTTP ${r.status}`); continue; }
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { errors.push(`${new URL(g).host}: ${msg(e)}`); }
  }
  throw new Error(`couldn't fetch ${cid} from IPFS (${errors.join("; ")})`);
}

async function load(mint: PublicKey): Promise<Loaded> {
  const addr = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], S.program)[0];
  const [info, mintInfo, md] = await Promise.all([
    conn.getAccountInfo(addr, "confirmed"), conn.getAccountInfo(mint, "confirmed"),
    getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null),
  ]);
  if (!info || !info.owner.equals(S.program)) throw new Error(`No Tax Vault for ${mint.toBase58()} on this network (program ${short(S.program.toBase58())}).`);
  const v = decodeVault(addr, info.data);
  const m = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(m);
  const epoch = BigInt((await conn.getEpochInfo("confirmed")).epoch);
  const taxBps = fee ? (epoch >= fee.newerTransferFee.epoch ? fee.newerTransferFee : fee.olderTransferFee).transferFeeBasisPoints : 0;
  // The network from the pool's owner (XDEX's program), as scripts/crank.ts does.
  const pool = await conn.getAccountInfo(v.pool, "confirmed");
  if (!pool) throw new Error(`The vault's pool ${v.pool.toBase58()} doesn't exist.`);
  const xdex = pool.owner;
  const network = (Object.entries(XDEX_PROGRAM_IDS).find(([, id]) => id === xdex.toBase58())?.[0] as Net | undefined) ?? S.net;
  let rules = defaultRules(m.supply);
  let list: Loaded["list"] = null, listError: string | null = null;
  const eff = effectiveList(v, nowSecs() - ACTIVATION_MARGIN_SECS);
  if (eff) {
    const cid = cidFromBytes(eff.cid);
    if (!cid) listError = "this list has no IPFS copy (published before v3)";
    else {
      try {
        const { file, wallets } = parseListFile(await fetchCid(cid), v.address, eff.root, eff.cid);
        if (file.rules) rules = rulesFromJson(file.rules, rules);
        list = { root: eff.root.toString("hex"), wallets, cid };
      } catch (e) { listError = msg(e); }
    }
  }
  return { v, mint, symbol: md?.symbol || short(mint.toBase58()), name: md?.name ?? "", taxBps, supply: m.supply, xdex, network, rules, list, listError };
}

// ---------- rendering ----------
function row(k: string, ...v: (Node | string)[]) { return el("div", { class: "kv" }, el("dt", { text: k }), el("dd", {}, ...v)); }
const addrLink = (a: PublicKey | string) => link(`${S.explorer}/address/${a.toString()}`, short(a.toString()));

function renderStatus(L: Loaded) {
  const { v } = L;
  const now = nowSecs();
  const box = $("status");
  box.replaceChildren();
  const rewardInfo = rewardTokenInfo(L.network, v.rewardMint);
  const holdersSplit = 10_000 - v.burnBps - v.lpBps - v.creatorBps;
  box.append(
    el("h3", {}, L.symbol, L.name && L.name !== L.symbol ? el("span", { class: "muted", text: ` ${L.name}` }) : null),
    el("dl", {},
      row("Token", addrLink(L.mint), ` · tax ${L.taxBps / 100}% · network ${L.network}`),
      row("Vault", addrLink(v.address), ` · v${v.version}${v.version < VAULT_VERSION ? " (the next run upgrades it)" : ""}`),
      row("Split of the tax", `burn ${v.burnBps / 100}% · liquidity ${v.lpBps / 100}% · creator ${v.creatorBps / 100}% (${rewardInfo?.symbol ?? "reward token"}) · holders ${holdersSplit / 100}%`),
      row("Holders", `${xnt(v.holdersFunded)} funded · ${xnt(v.holdersPaid)} paid · ${xnt(v.holdersFunded - v.holdersPaid)} still to pay`),
      row("Publisher", addrLink(v.publisher), v.version >= 3 ? ` · last list ${when(v.lastPublishAt)} (${ago(v.lastPublishAt)})` : ""),
      row("Guardian (creator)", addrLink(v.guardian)),
    ),
  );
  // The active list and where it came from.
  const eff = effectiveList(v, now - ACTIVATION_MARGIN_SECS);
  const listRow = !eff ? "no list published yet"
    : L.list ? el("span", {}, `epoch ${eff.epoch}, ${Object.keys(L.list.wallets).length} wallets, total ${xnt(eff.total)} · `, link(`${S.gateways[0]}${L.list.cid}`, "file on IPFS ↗"), el("span", { class: "good", text: " · matches the on-chain root ✓" }))
    : el("span", { class: "bad", text: `epoch ${eff.epoch}: ${L.listError}` });
  box.querySelector("dl")!.append(row("Rewards list", listRow));
  if (v.pendingEpoch > 0n && now < v.pendingActiveAt) box.querySelector("dl")!.append(row("Next list", `epoch ${v.pendingEpoch} takes over ${when(v.pendingActiveAt)} (the creator can cancel it until then)`));

  // Operator-loss windows.
  const w = el("div", { class: "windows" });
  if (v.version >= 3) {
    const ap = appointAllowedAt(v)!, fb = fallbackAt(v)!;
    const fallbackNow = inFallback(v, now);
    w.append(
      el("div", { class: now >= ap ? "win open" : "win" }, el("b", { text: "Appoint a new publisher" }), el("span", { text: now >= ap ? `open since ${when(ap)}: the creator can appoint one below` : `opens ${when(ap)} (${ago(ap)}) if no list is published before then` })),
      el("div", { class: fallbackNow ? "win open" : "win" }, el("b", { text: "Fallback payouts" }), el("span", { text: fallbackNow ? `active since ${when(fb)}: running the vault pays holders their share of everything funded, from the last list`
        : now >= fb ? `due: they start once the published list takes over (${when(v.pendingActiveAt)})`
        : `start ${when(fb)} (${ago(fb)}) if no list is published before then` })),
    );
  } else w.append(el("div", { class: "win" }, el("span", { text: "The recovery windows arrive with the v3 upgrade (the next run does it)." })));
  box.append(w);
  renderActions();
}

function renderActions() {
  const L = current;
  const addr = X1Wallet.state.address;
  $("actions").hidden = !L;
  if (!L) return;
  $<HTMLButtonElement>("plan").disabled = !addr;
  $("walletNote").textContent = addr ? `Connected: ${short(addr)} (${X1Wallet.state.name}). You pay the network fees and earn the crank reward.` : "Connect a wallet to run the vault.";
  // Appoint: only the guardian, only once allowed.
  const isGuardian = !!addr && L.v.guardian.toBase58() === addr;
  const at = appointAllowedAt(L.v);
  $("appointBox").hidden = !isGuardian;
  if (isGuardian) {
    const open = at !== null && nowSecs() >= at;
    $<HTMLButtonElement>("appoint").disabled = !open;
    $("appointNote").textContent = at === null ? "Needs the v3 upgrade first (run the vault once)."
      : open ? "The publisher has published nothing for 7 days: you can appoint a new one. It then publishes lists with scripts/crank.ts --publisher."
      : `You're this vault's guardian. If the publisher publishes nothing, you can appoint a new one from ${when(at)}.`;
  }
}

// ---------- finding vaults ----------
async function findVaults() {
  connect();
  const host = $("vaults");
  host.replaceChildren(el("li", { class: "muted", text: "Reading every vault of the program…" }));
  try {
    const raw = await conn.getProgramAccounts(S.program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(VAULT_DISC) } }] });
    const vaults = raw.map(({ pubkey, account }) => decodeVault(pubkey, account.data));
    const metas = await Promise.all(vaults.map((v) => getTokenMetadata(conn, v.mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null)));
    host.replaceChildren();
    if (!vaults.length) host.append(el("li", { class: "muted", text: "No vaults on this network." }));
    vaults.map((v, i) => ({ v, md: metas[i] })).sort((a, b) => (a.md?.symbol ?? "").localeCompare(b.md?.symbol ?? "")).forEach(({ v, md }) => {
      const b = el("button", { type: "button", class: "chip" }, el("b", { text: md?.symbol ?? short(v.mint.toBase58()) }),
        el("span", { class: "muted", text: ` v${v.version}${v.version >= 3 ? ` · list ${ago(v.lastPublishAt)}` : ""}` }));
      b.onclick = () => { $<HTMLInputElement>("mint").value = v.mint.toBase58(); void open(); };
      host.append(el("li", {}, b));
    });
  } catch (e) { host.replaceChildren(el("li", { class: "bad", text: `Couldn't list vaults: ${msg(e)}` })); }
}

async function open() {
  connect();
  let mint: PublicKey;
  try { mint = new PublicKey($<HTMLInputElement>("mint").value.trim()); } catch { log("Enter a token (mint) address.", "bad"); return; }
  $("status").replaceChildren(el("p", { class: "muted", text: "Reading the vault and its rewards list…" }));
  $("plans").replaceChildren();
  try {
    current = await load(mint);
    renderStatus(current);
    try { history.replaceState(null, "", `#${mint.toBase58()}`); } catch {}
  } catch (e) {
    current = null;
    $("status").replaceChildren(el("p", { class: "bad", text: msg(e) }));
    renderActions();
  }
}

// ---------- running the vault ----------
let busy = false;
let planned: { steps: PlannedStep[]; reward: bigint; rent: bigint } | null = null;

async function plan() {
  if (!current || !X1Wallet.state.address || busy) return;
  busy = true;
  const host = $("plans");
  host.replaceChildren(el("p", { class: "muted", text: "Working out the steps due now…" }));
  try {
    current = await load(current.mint);
    renderStatus(current);
    const L = current;
    const caller = new PublicKey(X1Wallet.state.address);
    const includeNew = $<HTMLInputElement>("includeNew").checked;
    const p = await planForCaller(conn, { program: S.program, xdex: L.xdex, network: L.network }, L.v, { mint: L.mint, taxBps: L.taxBps }, caller,
      L.list ? { root: L.list.root, wallets: L.list.wallets } : null, { maxPays: MAX_PAYS, minPayout: L.rules.minPayout, includeNew });
    planned = { steps: p.steps, reward: p.rewardLamports, rent: p.recordsRent };
    host.replaceChildren();
    if (!p.steps.length) {
      host.append(el("p", {}, "Nothing to run right now: no tax worth collecting or selling, and nobody is owed a payout", includeNew ? "." : " (tick “also pay wallets never paid before” to include those)."));
      for (const n of p.notes) host.append(el("p", { class: "muted", text: n }));
      planned = null;
      return;
    }
    const ol = el("ol", { class: "steps" });
    for (const s of p.steps) ol.append(el("li", { text: s.label }));
    host.append(ol);
    for (const n of p.notes) host.append(el("p", { class: "muted", text: n }));
    host.append(el("p", {}, `Estimated crank reward ≈ ${xnt(p.rewardLamports)}`, p.recordsRent > 0n ? ` · payment records' rent ${xnt(p.recordsRent)}` : "", " · plus network fees."));
    const go = el("button", { type: "button", class: "primary", text: `Sign and run ${p.steps.length} step${p.steps.length === 1 ? "" : "s"}` });
    go.onclick = () => void run();
    host.append(go);
  } catch (e) {
    host.replaceChildren(el("p", { class: "bad", text: `Couldn't plan the run: ${msg(e)}` }));
    planned = null;
  } finally { busy = false; }
}

/** Send one signed transaction; resend a moment later when the vault's one-sale-per-slot rule says so. */
async function sendSigned(raw: Uint8Array) {
  const tx = Transaction.from(raw);
  for (let attempt = 0; ; attempt++) {
    try {
      const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
      await confirmByPolling(conn, raw, signature, tx.lastValidBlockHeight ?? (await conn.getBlockHeight()) + 150);
      return signature;
    } catch (e) {
      const m = msg(e) + " " + ((e as { logs?: string[] }).logs ?? []).join(" ");
      if (attempt < 3 && /OneSellPerSlot|0x1782/.test(m)) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      const name = errorOf(m);
      throw new Error(name ?? m.split("\n")[0]);
    }
  }
}

async function run() {
  if (!current || !planned || busy) return;
  busy = true;
  const { steps } = planned;
  planned = null;
  const L = current;
  $("plans").querySelector("button")?.remove();
  $("plans").append(el("p", { class: "muted", text: "Running… (details in Activity below)" }));
  try {
    const payer = new PublicKey(X1Wallet.state.address!);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const txs: Transaction[] = [];
    for (const [i, s] of steps.entries()) {
      let ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_LAMPORTS }), ComputeBudgetProgram.setComputeUnitLimit({ units: s.units }), ...s.ixs];
      // Only the first can be measured: later ones count on the earlier ones landing.
      if (i === 0) ixs = await fitComputeLimit(conn, ixs, payer);
      txs.push(new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...ixs));
    }
    const first = await conn.simulateTransaction(txs[0]);
    if (first.value.err) throw new Error(`the first step fails in simulation: ${errorOf((first.value.logs ?? []).join(" ")) ?? JSON.stringify(first.value.err)}`);
    log(`Approve ${txs.length} transaction${txs.length === 1 ? "" : "s"} in your wallet…`);
    const signed = await X1Wallet.signAll(txs.map((t) => t.serialize({ requireAllSignatures: false, verifySignatures: false })));
    let reward = 0n, ok = 0;
    for (const [i, s] of steps.entries()) {
      try {
        const sig = await sendSigned(signed[i]);
        ok++;
        log(`✓ ${s.label}`, "good", `${S.explorer}/tx/${sig}`);
        const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        for (const e of parseEvents(t?.meta?.logMessages ?? [], S.program)) if (e.name === "Sold" && e.vault === L.v.address.toBase58()) reward += e.crankReward;
      } catch (e) {
        const m = msg(e);
        // Someone else (a site or another keeper) ran this step first: nothing was charged.
        if (/TooSmall|NothingToPay/.test(m)) log(`– ${s.label}: already done by someone else`);
        else log(`✗ ${s.label}: ${m}`, "bad");
      }
    }
    log(`${ok} of ${steps.length} step${steps.length === 1 ? "" : "s"} confirmed${reward > 0n ? ` · you earned ${xnt(reward)}` : ""}.`, ok ? "good" : "bad");
    // Ready for the next run (a large list takes several). Public RPCs can lag a moment behind
    // what just confirmed, so give them a few seconds before reading the vault again.
    await new Promise((r) => setTimeout(r, 4000));
    current = await load(L.mint);
    renderStatus(current);
    $("plans").replaceChildren(el("p", { class: "muted", text: "Done. Check again for more steps (a long list pays a few wallets per run)." }));
  } catch (e) {
    log(`Run stopped: ${msg(e)}`, "bad");
  } finally { busy = false; }
}

// ---------- appointing a publisher ----------
async function appoint() {
  if (!current || busy) return;
  const addr = X1Wallet.state.address;
  let np: PublicKey;
  try { np = new PublicKey($<HTMLInputElement>("newPublisher").value.trim()); } catch { log("Enter the new publisher's wallet address.", "bad"); return; }
  if (!addr || current.v.guardian.toBase58() !== addr) { log("Only the vault's guardian (the token's creator) can appoint.", "bad"); return; }
  if (np.equals(current.v.publisher)) { log("That wallet is already the publisher.", "bad"); return; }
  const confirmBox = $("appointConfirm");
  if (confirmBox.hidden) {
    confirmBox.hidden = false;
    confirmBox.textContent = `Appoint ${np.toBase58()}? That wallet publishes the rewards lists from now on (it must run scripts/crank.ts with --publisher). Click “Appoint” again to sign.`;
    return;
  }
  confirmBox.hidden = true;
  busy = true;
  try {
    const guardian = new PublicKey(addr);
    const ixs = await fitComputeLimit(conn, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_LAMPORTS }), ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      appointPublisherIx(S.program, guardian, current.mint, np)], guardian);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: guardian, blockhash, lastValidBlockHeight }).add(...ixs);
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) throw new Error(errorOf((sim.value.logs ?? []).join(" ")) ?? JSON.stringify(sim.value.err));
    const [signed] = await X1Wallet.signAll([tx.serialize({ requireAllSignatures: false, verifySignatures: false })]);
    const sig = await sendSigned(signed);
    log(`✓ Appointed ${short(np.toBase58())} as publisher`, "good", `${S.explorer}/tx/${sig}`);
    current = await load(current.mint);
    renderStatus(current);
  } catch (e) {
    log(`Appoint failed: ${msg(e)}`, "bad");
  } finally { busy = false; }
}

// ---------- wallet ----------
function renderWallet() {
  const host = $("wallet");
  host.replaceChildren();
  const addr = X1Wallet.state.address;
  if (addr) {
    const b = el("button", { type: "button", text: `Disconnect ${short(addr)}` });
    b.onclick = () => void X1Wallet.disconnect();
    host.append(b);
  } else {
    const cs = X1Wallet.choices();
    if (!cs.length) host.append(el("span", { class: "muted", text: "No wallet found in this browser (install X1 Wallet or Backpack)." }));
    for (const c of cs) {
      const b = el("button", { type: "button" }, c.icon ? el("img", { src: c.icon, alt: "", class: "wicon" }) : null, `Connect ${c.name}`);
      b.onclick = () => X1Wallet.connect(c).catch((e) => log(`Wallet: ${msg(e)}`, "bad"));
      host.append(b);
    }
  }
  renderActions();
}

// ---------- start ----------
function init() {
  const net = $<HTMLSelectElement>("net");
  // The network this copy opens on (the build's --network).
  const built = (window as unknown as { RECOVERY_NET?: string }).RECOVERY_NET;
  if (built === "mainnet" || built === "testnet") net.value = built;
  const syncNet = () => { $<HTMLInputElement>("rpc").placeholder = NETS[net.value as Net].rpc; };
  net.onchange = () => { syncNet(); current = null; $("status").replaceChildren(); $("vaults").replaceChildren(); renderActions(); };
  syncNet();
  $<HTMLInputElement>("program").placeholder = TAX_VAULT_PROGRAM_ID.toBase58();
  $<HTMLInputElement>("gateways").placeholder = GATEWAYS;
  $("find").onclick = () => void findVaults();
  $("open").onclick = () => void open();
  $("mint").onkeydown = (e) => { if ((e as KeyboardEvent).key === "Enter") void open(); };
  $("plan").onclick = () => void plan();
  $("appoint").onclick = () => void appoint();
  X1Wallet.onChange(() => renderWallet());
  renderWallet();
  setTimeout(renderWallet, 900); // wallets can announce themselves late
  // #<mint> (and #testnet / #mainnet) open straight to a vault.
  const h = location.hash.slice(1);
  if (/^(testnet|mainnet)$/.test(h)) net.value = h;
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h)) { $<HTMLInputElement>("mint").value = h; void open(); }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
