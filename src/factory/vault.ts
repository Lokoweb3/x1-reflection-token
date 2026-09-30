/**
 * Tax Vault on the factory site (docs/tax-vault-spec.md): read views for the token pages,
 * the crank that keeps every vault token moving, and the unsigned transactions behind the
 * pages' "Run the vault now" and "Appoint a new publisher" buttons.
 *
 * Every ~60 s, for each vault token (launch record or per-launch config says `taxVault`,
 * or a vault account exists for the mint), one pass (the steps are src/vault-crank.ts,
 * shared with scripts/crank.ts):
 *   0. upgrade   a v1/v2 vault gets `upgrade_vault` once (the crank pays the extra rent)
 *   1. collect   when the tax waiting is worth at least the token's minHarvestXnt: harvest
 *                the accounts holding withheld tax into the mint, withdraw, split, burn
 *   2. sell      the sell buckets, price-impact capped on-chain (min(3%, tax/2)), one sale
 *                per slot, each confirmed before the next; stops at dust or
 *                when a sale was capped (the rest waits for the next pass)
 *   3. add_liquidity when at least 0.01 XNT is set aside; fund_creator when any is and the
 *                reward swap (XNT -> the network's reward token, capped at half the reward
 *                pool's fee, one per slot) would output something: the program swaps and
 *                deposits into the creator's vesting vault
 *   4. rewards list: new holders' XNT is split pro-rata over eligible holders (the
 *                distributor's rules) and added to each wallet's running total, starting from
 *                max(previous total, on-chain paid); saved to <state>/vault-list.json, pinned
 *                to IPFS (v3: no pin, no publish; retried next pass) and published with its CID
 *   5. pay       once the list is active, every wallet whose total is at least
 *                minPayoutXnt above what it was paid (several pays per transaction); in
 *                fallback (v3: no list published for 30 days) pay_fallback instead
 * Each confirmed transaction's program events are appended to the token's events.jsonl in
 * the shapes the hot-wallet distributor writes, so the site's stats keep working (steps a
 * visitor runs with "Run the vault now" are added from the chain afterwards).
 *
 * The crank signs with factory.taxVault.publisherKeypair (pays the fees, is the list
 * publisher, earns the on-chain crank reward from each sale). Without it nothing is sent;
 * the read views still work. If the vault's guardian appointed another publisher (v3), the
 * site stops publishing for that token and pays from that publisher's lists (read from IPFS).
 * Every step is guarded: a failure is logged and the pass goes on with the next step or
 * token, never crashing the server; passes never overlap.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Config, DEFAULT_MIN_HARVEST_XNT, FACTORY_DIR, loadKeypair, toBaseUnits, xnt } from "../config.js";
import {
  REWARD_MINT, VAULT_VERSION, appointAllowedAt, appointPublisherIx, cancelsLeft, cidFromBytes, effectiveList, fallbackAt, fallbackActive,
  parseEvents, rewardTokenInfo, vaultAuthPda, vaultJson, vaultPda, type Vault, type VaultEvent,
} from "../taxvault.js";
import {
  ACTIVATION_MARGIN_SECS, type CrankRules, type CrankToken, type PayList, inFallback, listFileText, nowSecs, parseListFile, planForCaller,
  readVaultAccount, rulesJson, vaultCrank,
} from "../vault-crank.js";
import { fetchFromGateways, gatewayBase, gatewayUrl, ipfsEnabled, pinJson } from "./ipfs.js";
import { DECIMALS, type LaunchRecord, pairOf, readLaunch, registeredLaunches, vaultManaged } from "./launch.js";

/** Crank pass interval; TAX_VAULT_PASS_SECS shortens it for local rehearsals (short-windows builds). */
const PASS_MS = Number(process.env.TAX_VAULT_PASS_SECS ?? 60) * 1000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One published (or about to be published) rewards list: every wallet's cumulative XNT. */
export interface VaultList {
  epoch: string;
  root: string;
  total: string;
  wallets: Record<string, string>;
  builtAt: string;
  /** XNT added by this list and how many wallets it went to (for the log). */
  allocated?: string;
  holders?: number;
  /** v3: the list file's IPFS address, once pinned (before it's published). */
  cid?: string;
  signature?: string;
  /** Set once the publish transaction is confirmed (or seen on-chain). */
  publishedAt?: string;
  activeAt?: number;
}
export interface VaultListFile {
  version: 1;
  mint: string;
  vault: string;
  /** The list the program has active (its list_root). */
  active: VaultList | null;
  /** The next list: saved before it's sent, then pending on-chain until its active time. */
  next: VaultList | null;
  history: { at: string; epoch: string; root: string; total: string; event: "published" | "active" | "cancelled" | "dropped" | "adopted"; signature?: string; cid?: string }[];
}

const launchDir = (mint: string) => path.join(FACTORY_DIR, "launches", mint);
const stateDirOf = (mint: string) => path.join(launchDir(mint), "state");
const listPath = (mint: string) => path.join(stateDirOf(mint), "vault-list.json");

export function readListFile(mint: string): VaultListFile | null {
  const f = listPath(mint);
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; }
}
function saveListFile(l: VaultListFile) {
  const f = listPath(l.mint);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  l.history = l.history.slice(-500);
  const tmp = `${f}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  fs.writeSync(fd, JSON.stringify(l, null, 1) + "\n");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, f); // written in full before anything is sent
}

/** Same line format as src/state.ts logEvent, into this token's own log. */
function logEvent(mint: string, e: Record<string, unknown>) {
  const dir = stateDirOf(mint);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
}

export function vaultService(conn: Connection, cfg: Config, opts: { microLamports: number }) {
  const program = new PublicKey(cfg.factory!.taxVault!.programId);
  const xdex = new PublicKey(cfg.xdex.programId);
  /** Mints whose vault account was seen on-chain (covers tokens not flagged in their files). */
  const seen = new Set<string>();
  const status = new Map<string, { at: string; ok: boolean; notes: string[] }>();

  let crank: Keypair | null = null;
  const keyPath = cfg.factory?.taxVault?.publisherKeypair;
  if (keyPath) {
    try { crank = loadKeypair(keyPath); } catch (e) { console.error(`Tax vault crank off: can't read factory.taxVault.publisherKeypair (${msg(e)})`); }
  }
  const core = crank ? vaultCrank({ conn, program, xdex, network: cfg.network, signer: crank, microLamports: opts.microLamports,
    onTx: (t, v, signature, events) => record(t.mint.toBase58(), v, signature, events, crank!.publicKey.toBase58()) }) : null;

  const authOf = (mint: string) => vaultAuthPda(program, new PublicKey(mint));
  const addrOf = (mint: string) => vaultPda(program, new PublicKey(mint));
  /** XNT-paired launches only: the vault is TOKEN/wXNT only. */
  const xntPaired = (r: LaunchRecord) => !pairOf(cfg, r).xntPool;
  /** Where list files are read from: this site's gateway, then a public one. */
  const gateways = [...new Set([gatewayBase(cfg), "https://ipfs.io/ipfs/"])];
  const cidUrl = (cid: string | null | undefined) => (cid ? gatewayUrl(cfg, cid) : null);

  /** Whether the vault handles this token (its files say so, or a vault was seen on-chain). */
  function isVaultMint(mint: string) {
    if (seen.has(mint)) return true;
    let r: LaunchRecord | null = null;
    try { r = readLaunch(mint); } catch { return false; }
    return !!r && vaultManaged(r);
  }

  const readVault = (mint: PublicKey) => readVaultAccount(conn, program, mint);

  // ---------- read views ----------
  const viewCache = new Map<string, { at: number; data: Promise<Vault | null> }>();
  function cachedVault(mint: string) {
    const hit = viewCache.get(mint);
    if (hit && Date.now() - hit.at < 15_000) return hit.data;
    const data = readVault(new PublicKey(mint));
    data.catch(() => viewCache.delete(mint));
    viewCache.set(mint, { at: Date.now(), data });
    if (viewCache.size > 500) viewCache.clear();
    return data;
  }

  /** v3 status for the pages: who publishes, since when, and when appointing / fallback open up. */
  function v3Status(v: Vault | null) {
    if (!v || v.version < 3) return null;
    const now = nowSecs();
    const cid = cidFromBytes(v.listCid), pendingCid = cidFromBytes(v.pendingCid);
    return {
      publisher: v.publisher.toBase58(), guardian: v.guardian.toBase58(), lastPublishAt: v.lastPublishAt,
      appointAllowedAt: appointAllowedAt(v), fallbackAt: fallbackAt(v), fallbackActive: fallbackActive(v, now),
      fallbackPaid: v.fallbackPaid.toString(), listCid: cid, listCidUrl: cidUrl(cid), pendingCid, pendingCidUrl: cidUrl(pendingCid),
      // The site's own key still publishes (false once the guardian appointed someone else).
      sitePublishes: !!crank && v.publisher.equals(crank.publicKey),
    };
  }

  /** GET /api/vault/<mint>: the vault's state and totals, and what the crank last did. */
  async function view(mintStr: string) {
    const mint = new PublicKey(mintStr).toBase58();
    if (!isVaultMint(mint)) throw new Error("This token's tax isn't held by the Tax Vault.");
    const v = await cachedVault(mint);
    const file = readListFile(mint);
    return {
      mint, programId: program.toBase58(), vault: addrOf(mint).toBase58(), auth: authOf(mint).toBase58(),
      exists: !!v, state: v ? vaultJson(v) : null,
      // When the pending list starts paying (unix seconds), if one is waiting.
      nextListAt: v && v.pendingEpoch > 0n ? v.pendingActiveAt : null,
      latestList: file ? listSummary(file.next ?? file.active) : null,
      listUrl: `/api/vault/${mint}/list`,
      ...(v3Status(v) ?? {}),
      crank: { on: !!crank, wallet: crank?.publicKey.toBase58() ?? null, lastPass: status.get(mint) ?? null },
    };
  }
  const listSummary = (l: VaultList | null) => (l ? { epoch: l.epoch, root: l.root, total: l.total, wallets: Object.keys(l.wallets).length,
    builtAt: l.builtAt, publishedAt: l.publishedAt ?? null, activeAt: l.activeAt ?? null, cid: l.cid ?? null, cidUrl: cidUrl(l.cid) } : null);

  /** GET /api/vault/<mint>/list: the latest rewards list with every wallet's cumulative total. */
  async function listView(mintStr: string) {
    const mint = new PublicKey(mintStr).toBase58();
    if (!isVaultMint(mint)) throw new Error("This token's tax isn't held by the Tax Vault.");
    const file = readListFile(mint);
    const latest = file?.next ?? file?.active ?? null;
    if (!file || !latest) return { mint, vault: addrOf(mint).toBase58(), status: "none", epoch: null, root: null, total: "0", activeAt: null, cid: null, cidUrl: null, wallets: [], active: null };
    const v = await cachedVault(mint).catch(() => null);
    const isNext = latest === file.next;
    const listStatus = !isNext ? "active"
      : v && v.listEpoch.toString() === latest.epoch ? "active"
      : latest.publishedAt ? "pending" : "draft";
    return {
      mint, vault: addrOf(mint).toBase58(), status: listStatus, epoch: latest.epoch, root: latest.root, total: latest.total,
      activeAt: latest.activeAt ?? null, builtAt: latest.builtAt, publishedAt: latest.publishedAt ?? null, signature: latest.signature ?? null,
      // v3: the same list as a file on IPFS (its CID is on-chain), so it can be read without this site.
      cid: latest.cid ?? null, cidUrl: cidUrl(latest.cid),
      wallets: Object.entries(latest.wallets).map(([wallet, cumulative]) => ({ wallet, cumulative }))
        .sort((a, b) => (BigInt(b.cumulative) > BigInt(a.cumulative) ? 1 : BigInt(b.cumulative) < BigInt(a.cumulative) ? -1 : a.wallet.localeCompare(b.wallet))),
      // While a new list waits for its time, the one paying now.
      active: isNext && file.active ? { epoch: file.active.epoch, root: file.active.root, total: file.active.total, cid: file.active.cid ?? null, cidUrl: cidUrl(file.active.cid) } : null,
    };
  }

  /**
   * The small summary token pages show (badge, list link, next list time, v3 status); null for
   * other tokens. `exists` false: the creator (`creator`) hasn't started the vault yet (a
   * graduated curve token); the pages offer them "Start the tax vault".
   */
  async function badge(mint: string) {
    if (!isVaultMint(mint)) return null;
    const v = await cachedVault(mint).catch(() => null);
    let r: LaunchRecord | null = null;
    try { r = readLaunch(mint); } catch { /* no record */ }
    const creator = r?.creator ?? null;
    // A creator who builds their own init_vault (a curve token's vault is started after it's
    // listed) could pick other settings than the launch shows: say so on every page.
    const mismatch = v && r && (!v.guardian.equals(new PublicKey(r.creator)) || v.burnBps !== (r.burnBps ?? 0) || v.lpBps !== r.autoLpBps)
      ? "This vault's settings differ from the launch (guardian or tax split)." : null;
    return {
      programId: program.toBase58(), vault: addrOf(mint).toBase58(), auth: authOf(mint).toBase58(), exists: !!v, creator, mismatch,
      listEpoch: v && v.listEpoch > 0n ? v.listEpoch.toString() : null,
      nextListAt: v && v.pendingEpoch > 0n ? v.pendingActiveAt : null,
      listUrl: `/api/vault/${mint}/list`,
      version: v?.version ?? null,
      // How many more pending lists the guardian (the creator) may cancel in a row (v2); null: no limit / no vault.
      cancelsLeft: v ? cancelsLeft(v) : null,
      ...(v3Status(v) ?? {}),
    };
  }

  /**
   * The mint a vault token's creator reward is paid in: the vault's reward_mint once it's
   * upgraded (v2+), else the network's reward token (what init_vault and upgrade_vault set).
   */
  async function rewardMintOf(mint: string): Promise<PublicKey> {
    const v = await cachedVault(mint).catch(() => null);
    return v && v.version >= 2 ? v.rewardMint : REWARD_MINT[cfg.network];
  }

  // ---------- event log ----------
  /** Append a confirmed transaction's events to the token's log in the distributor's shapes; `wallet` sent it. */
  function record(mint: string, v: Vault, signature: string, events: VaultEvent[], wallet: string) {
    const payments: [string, string][] = [];
    let fallback = false;
    for (const e of events) {
      if (e.name === "Collected") {
        const lp = (e.got * BigInt(v.lpBps)) / 10_000n;
        logEvent(mint, { kind: "withdraw", signature, tokens: e.got.toString(), lpTokens: lp.toString(), vault: true });
        if (e.burned > 0n) logEvent(mint, { kind: "burn", signature, tokens: e.burned.toString() });
      } else if (e.name === "Sold") {
        logEvent(mint, { kind: "sell", signature, tokens: e.tokensIn.toString(), xnt: e.xntOut.toString(), lpXnt: e.toLp.toString() });
        // The crank reward is the vault's "Distribute now" reward: it goes to whoever sent the sale.
        if (e.crankReward > 0n) logEvent(mint, { kind: "clicker-reward", signature, xnt: e.crankReward.toString(), wallet });
      } else if (e.name === "LiquidityAdded") {
        logEvent(mint, { kind: "auto-lp", signature, tokens: e.tokens.toString(), xnt: e.xnt.toString(), lp: e.lpBurned.toString() });
      } else if (e.name === "CreatorFunded") {
        // `xnt` is what the creator's share was worth in XNT (the site's totals); `reward` is
        // what went into the vesting vault, in the reward token's base units.
        const info = rewardTokenInfo(cfg.network, new PublicKey(e.rewardMint));
        logEvent(mint, { kind: "creator-reward", signature, xnt: e.xntIn.toString(), reward: e.rewardOut.toString(), rewardMint: e.rewardMint,
          rewardSymbol: info?.symbol ?? null, rewardDecimals: info?.decimals ?? null, vault: true });
      } else if (e.name === "Paid" || e.name === "FallbackPaid") {
        payments.push([e.wallet, e.amount.toString()]);
        if (e.name === "FallbackPaid") fallback = true;
      } else if (e.name === "PublisherChanged") {
        logEvent(mint, { kind: "publisher", signature, old: e.old, new: e.new, byGuardian: e.byGuardian, vault: true });
      }
    }
    if (payments.length) {
      logEvent(mint, { kind: "payout", signature, payments, total: payments.reduce((a, [, x]) => a + BigInt(x), 0n).toString(), vault: true, ...(fallback ? { fallback: true } : {}) });
    }
  }
  /** Signatures already in a token's log (steps a visitor ran are recorded once). */
  function loggedSignatures(mint: string) {
    const f = path.join(stateDirOf(mint), "events.jsonl");
    const out = new Set<string>();
    if (!fs.existsSync(f)) return out;
    for (const l of fs.readFileSync(f, "utf8").split("\n")) { const m = /"signature":"([1-9A-HJ-NP-Za-km-z]+)"/.exec(l); if (m) out.add(m[1]); }
    return out;
  }

  // ---------- crank ----------
  const tokenConfig = (r: LaunchRecord): Config | null => {
    const f = path.join(launchDir(r.mint), "config.json");
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; }
  };
  /** The token's payout rules from its per-launch config; null before it's registered. */
  function rulesOf(r: LaunchRecord): CrankRules | null {
    const dc = tokenConfig(r)?.distribution;
    if (!dc) return null;
    return {
      minHarvest: toBaseUnits(dc.minHarvestXnt ?? DEFAULT_MIN_HARVEST_XNT, 9), minPayout: toBaseUnits(dc.minPayoutXnt ?? "0", 9),
      minCycle: toBaseUnits(dc.minCycleXnt, 9), minHolding: toBaseUnits(dc.minHoldingTokens, DECIMALS),
      // A migrated token's old distributor wallet never earns.
      excludeOwners: [...dc.excludeOwners, ...(r.distributor ? [r.distributor] : [])], excludeOffCurve: dc.excludeOffCurveOwners,
    };
  }
  const tokenOf = (r: LaunchRecord): CrankToken => ({
    mint: new PublicKey(r.mint), symbol: r.symbol, taxBps: r.taxBps,
    // Before the per-launch config exists: the default collection threshold, no list yet.
    rules: rulesOf(r) ?? { minHarvest: toBaseUnits(DEFAULT_MIN_HARVEST_XNT, 9), minPayout: 0n, minCycle: 0n, minHolding: 0n, excludeOwners: [], excludeOffCurve: true },
  });

  /** A list by its CID (IPFS), checked against the on-chain root; cached. */
  const fetched = new Map<string, Record<string, string>>();
  async function listByCid(v: Vault, cidBytes: Buffer, root: Buffer) {
    const cid = cidFromBytes(cidBytes);
    if (!cid) return null;
    const key = `${cid}:${root.toString("hex")}`;
    if (!fetched.has(key)) {
      const { wallets } = parseListFile(await fetchFromGateways(gateways, cid), v.address, root, cidBytes);
      if (fetched.size > 50) fetched.clear();
      fetched.set(key, wallets);
    }
    return { cid, wallets: fetched.get(key)! };
  }

  /**
   * Bring vault-list.json in line with the chain: the next list became active, is pending,
   * was cancelled by the guardian, or never landed (sent again). A list the site doesn't
   * have (another publisher's) is read from IPFS by its on-chain CID. Returns false when the
   * file and the chain disagree in a way the crank can't repair (lists and pays stop).
   */
  async function syncList(t: CrankToken, v: Vault, file: VaultListFile, notes: string[]): Promise<boolean> {
    const hex = (b: Buffer) => b.toString("hex");
    const n = file.next;
    if (n) {
      if (v.listEpoch.toString() === n.epoch && hex(v.listRoot) === n.root) {
        file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "active", cid: n.cid });
        file.active = { ...n, publishedAt: n.publishedAt ?? new Date().toISOString() };
        file.next = null;
        saveListFile(file);
      } else if (v.pendingEpoch.toString() === n.epoch && hex(v.pendingRoot) === n.root) {
        if (!n.publishedAt || n.activeAt !== v.pendingActiveAt) {
          n.publishedAt ??= new Date().toISOString();
          n.activeAt = v.pendingActiveAt;
          saveListFile(file);
        }
      } else if (n.publishedAt) {
        // It was on-chain and isn't any more: the guardian cancelled it. Its allocation is
        // dropped; the XNT stays in the holder pool and is allocated again.
        file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "cancelled", cid: n.cid });
        file.next = null;
        saveListFile(file);
        notes.push(`list ${n.epoch} was cancelled by the guardian`);
      } else {
        const floor = v.listEpoch > v.pendingEpoch ? v.listEpoch : v.pendingEpoch;
        const minTotal = [v.listTotal, v.pendingTotal, v.holdersPaid].reduce((a, b) => (b > a ? b : a), 0n);
        if (BigInt(n.epoch) > floor && BigInt(n.total) >= minTotal && BigInt(n.total) <= v.holdersFunded && v.pendingEpoch === 0n
            && (file.active?.root ?? hex(Buffer.alloc(32))) === hex(v.listRoot) && v.publisher.equals(crank!.publicKey)) {
          await publish(t, v, file, notes); // saved but never landed: pin (if needed) and send the same list again
        } else {
          file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "dropped", cid: n.cid });
          file.next = null;
          saveListFile(file);
        }
      }
    }
    if (v.listEpoch > 0n && (!file.active || file.active.epoch !== v.listEpoch.toString() || file.active.root !== hex(v.listRoot))) {
      // v3: another publisher's list (or one this site lost): read it from IPFS by its CID.
      const got = await listByCid(v, v.listCid, v.listRoot).catch((e) => { notes.push(`list file not readable: ${msg(e).slice(0, 120)}`); return null; });
      if (got) {
        file.active = { epoch: v.listEpoch.toString(), root: hex(v.listRoot), total: v.listTotal.toString(), wallets: got.wallets, cid: got.cid,
          builtAt: new Date().toISOString(), publishedAt: new Date().toISOString() };
        file.history.push({ at: new Date().toISOString(), epoch: file.active.epoch, root: file.active.root, total: file.active.total, event: "adopted", cid: got.cid });
        saveListFile(file);
        notes.push(`list ${v.listEpoch} read from IPFS (${got.cid})`);
        return true;
      }
      console.error(`[vault crank] ${t.symbol}: the on-chain rewards list (epoch ${v.listEpoch}) isn't the one in vault-list.json; lists and payouts paused for this token.`);
      notes.push("rewards list out of sync with the chain");
      return false;
    }
    return true;
  }

  /** Pin the next list's file (no pin, no publish: retried next pass), then publish_list with its CID. */
  async function publish(t: CrankToken, v: Vault, file: VaultListFile, notes: string[]) {
    const n = file.next!;
    if (!n.cid) {
      if (!ipfsEnabled(cfg)) throw new Error("no Pinata key (factory.pinataJwt): the list can't be pinned, so it isn't published");
      const text = listFileText({ mint: file.mint, vault: file.vault, epoch: n.epoch, root: n.root, total: n.total, wallets: n.wallets, rules: rulesJson(t.rules) });
      try {
        n.cid = await pinJson(cfg, text, `${t.symbol}-list-${n.epoch}.json`, `99tax ${t.symbol} rewards list ${n.epoch}`);
      } catch (e) {
        throw new Error(`list ${n.epoch} not pinned to IPFS, publish retried next pass (${msg(e)})`);
      }
      saveListFile(file); // the CID is kept: the next try publishes the same file
    }
    const { signature, activeAt } = await core!.publish(t, v, { epoch: BigInt(n.epoch), total: BigInt(n.total), root: Buffer.from(n.root, "hex"), cid: n.cid, wallets: Object.keys(n.wallets).length });
    n.signature = signature;
    n.publishedAt = new Date().toISOString();
    if (activeAt !== null) n.activeAt = activeAt;
    file.history.push({ at: n.publishedAt, epoch: n.epoch, root: n.root, total: n.total, event: "published", signature, cid: n.cid });
    saveListFile(file);
    logEvent(file.mint, { kind: "allocate", signature, xnt: n.allocated ?? "0", holders: n.holders ?? 0, epoch: n.epoch, cid: n.cid, vault: true });
    notes.push(`published list ${n.epoch} (${n.cid})`);
  }

  /** Allocate the holder pool's new XNT over eligible holders and publish the new totals. */
  async function listStep(r: LaunchRecord, t: CrankToken, v: Vault, file: VaultListFile, notes: string[]) {
    if (file.next || v.pendingEpoch > 0n) return; // one list at a time: a new one would restart the wait
    if (!rulesOf(r)) { notes.push("no per-launch config yet"); return; }
    if (!v.publisher.equals(crank!.publicKey)) { notes.push(`lists are published by ${v.publisher.toBase58().slice(0, 4)}… (not this site)`); return; }
    if (v.version < VAULT_VERSION) { notes.push("new lists wait for the vault upgrade"); return; }
    // Every wallet's running total from the active list: the local copy when it matches the
    // on-chain root, else the IPFS file (checked against the root). Without either, a new list
    // would drop what was allocated but not yet paid, so don't publish unless the operator allows it.
    let prev: Record<string, string> | null = {};
    if (v.listEpoch > 0n) {
      const root = Buffer.from(v.listRoot).toString("hex");
      const local = file.active && file.active.root === root ? file.active.wallets : null;
      const got = local ? null : await listByCid(v, v.listCid, v.listRoot).catch(() => null);
      prev = local ?? (got ? Object.fromEntries(Object.entries(got.wallets).map(([w, c]) => [w, String(c)])) : null);
      if (!prev) {
        if (!cfg.factory?.taxVault?.allowListRebuild) {
          notes.push(`the active list ${v.listEpoch}'s file can't be read (local copy or IPFS): not publishing a new list, which would drop amounts allocated but not yet paid (factory.taxVault.allowListRebuild overrides)`);
          return;
        }
        notes.push(`the active list's file can't be read: rebuilding from what each wallet was paid (allowListRebuild)`);
      }
    }
    // In fallback, publish even a small list: it ends the fallback (the site is alive).
    const next = await core!.nextList(t, v, prev, notes, inFallback(v));
    if (!next) return;
    file.next = {
      epoch: next.epoch.toString(), root: next.root.toString("hex"), total: next.total.toString(), wallets: next.wallets, builtAt: new Date().toISOString(),
      allocated: next.allocated.toString(), holders: next.holders,
    };
    saveListFile(file); // the list is on disk (and served) before it's pinned and published
    console.log(`[vault crank] ${r.symbol}: list ${next.epoch}: ${xnt(next.allocated)} across ${next.holders} holder(s), total ${xnt(next.total)}`);
    await publish(t, v, file, notes);
  }

  /** The list `pay` checks now (a due pending list counts), from vault-list.json or IPFS; null if none. */
  async function payList(v: Vault, file: VaultListFile): Promise<PayList | null> {
    const eff = effectiveList(v, nowSecs() - ACTIVATION_MARGIN_SECS);
    if (!eff) return null;
    const root = eff.root.toString("hex");
    const mine = [file.next, file.active].find((l) => l && l.root === root);
    if (mine) return { root, wallets: mine.wallets };
    const got = await listByCid(v, eff.cid, eff.root);
    return got ? { root, wallets: got.wallets } : null;
  }

  /** Pay every wallet the active list owes at least minPayoutXnt (in fallback: pay_fallback). */
  async function payStep(t: CrankToken, v: Vault, file: VaultListFile, notes: string[]) {
    const now = nowSecs();
    const eff = effectiveList(v, now - ACTIVATION_MARGIN_SECS);
    if (!eff) return;
    // A pending list inside the margin: wait, so every proof is for the list the program checks.
    if (!eff.pending && v.pendingEpoch > 0n && now >= v.pendingActiveAt) return;
    const list = await payList(v, file);
    if (!list) { notes.push("the list to pay isn't in vault-list.json or on IPFS"); return; }
    // (A due pending list with nobody owed minPayoutXnt: core.pay pays the largest amount owed so it takes over.)
    await core!.pay(t, v, list, inFallback(v, now) ? "fallback" : "pay", notes);
  }

  /** One token's pass. Each step is on its own: a failed sale doesn't stop payouts. */
  async function crankToken(r: LaunchRecord) {
    const c = core!;
    const notes: string[] = [];
    let ok = true;
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) {
        // An old vault under the new program refuses everything but upgrade_vault: wait for the upgrade.
        if (/: WrongVersion$/.test(msg(e))) { notes.push(`${name} waits for the vault upgrade`); return; }
        ok = false; notes.push(`${name} failed: ${msg(e).slice(0, 200)}`); console.error(`[vault crank] ${r.symbol} ${name}: ${msg(e)}`);
      }
    };
    const t = tokenOf(r);
    // Only the creator can start a vault (init_vault); until then there's nothing to crank.
    const v = await readVault(t.mint);
    if (!v) { status.set(r.mint, { at: new Date().toISOString(), ok, notes: ["no vault yet (the creator starts it after the LP lock or the curve's graduation)"] }); return; }
    seen.add(r.mint);
    let vault = v;
    await step("upgrade_vault", async () => { vault = await c.upgrade(t, v, notes); });
    let pool: Awaited<ReturnType<typeof c.poolOf>> | null = null;
    await step("pool", async () => { pool = await c.poolOf(vault); });
    await step("collect", () => c.collect(t, vault, notes));
    if (pool) {
      await step("sell", () => c.sell(t, pool!, notes));
      await step("add_liquidity", () => c.liquidity(t, pool!, notes));
    }
    await step("fund_creator", () => c.creator(t, notes));
    await step("rewards list", async () => {
      const now = await readVault(t.mint);
      if (!now) return;
      const file: VaultListFile = readListFile(r.mint) ?? { version: 1, mint: r.mint, vault: now.address.toBase58(), active: null, next: null, history: [] };
      if (!(await syncList(t, now, file, notes))) return;
      const fresh = (await readVault(t.mint)) ?? now; // a re-sent list changes the pending fields
      await listStep(r, t, fresh, file, notes);
      const latest = (await readVault(t.mint)) ?? fresh;
      await payStep(t, latest, file, notes);
    });
    viewCache.delete(r.mint);
    status.set(r.mint, { at: new Date().toISOString(), ok, notes });
  }

  /** Vault tokens: flagged launches, plus XNT-paired launches whose vault exists on-chain (checked in one read). */
  async function vaultTokens(): Promise<LaunchRecord[]> {
    const launches = registeredLaunches().filter(xntPaired);
    const unflagged = launches.filter((r) => !vaultManaged(r) && !seen.has(r.mint));
    for (let i = 0; i < unflagged.length; i += 100) {
      const chunk = unflagged.slice(i, i + 100);
      const infos = await conn.getMultipleAccountsInfo(chunk.map((r) => addrOf(r.mint)), "confirmed");
      chunk.forEach((r, j) => { if (infos[j]?.owner.equals(program)) seen.add(r.mint); });
    }
    return launches.filter((r) => vaultManaged(r) || seen.has(r.mint));
  }

  let cranking = false;
  async function crankOnce() {
    if (cranking || !crank) return;
    cranking = true;
    try {
      for (const r of await vaultTokens()) {
        try { await crankToken(r); } catch (e) { console.error(`[vault crank] ${r.symbol} (${r.mint}): ${msg(e)}`); }
      }
    } catch (e) {
      console.error(`[vault crank] listing vault tokens failed: ${msg(e)}`);
    } finally {
      cranking = false;
    }
  }

  /** Without a crank: still find the vault tokens (read-only), so the pages show their vault and reward token. */
  async function discover() {
    await vaultTokens().catch((e) => console.error(`[vault] listing vault tokens failed: ${msg(e)}`));
  }

  // ---------- visitors' wallets ----------
  /**
   * "Run the vault now": the permissionless steps due right now as instruction lists for
   * `caller`'s wallet to sign and pay (it earns the sale's crank reward), plus an estimate.
   */
  async function crankPlan(mintStr: string, caller: PublicKey) {
    const mint = new PublicKey(mintStr).toBase58();
    const r = readLaunch(mint);
    if (!r || !isVaultMint(mint)) throw new Error("This token's tax isn't held by the Tax Vault.");
    const v = await readVault(new PublicKey(mint));
    if (!v) throw new Error("This token's vault hasn't been started yet.");
    const t = tokenOf(r);
    const file = readListFile(mint) ?? { version: 1 as const, mint, vault: v.address.toBase58(), active: null, next: null, history: [] };
    const list = await payList(v, file).catch(() => null);
    return planForCaller(conn, { program, xdex, network: cfg.network }, v, t, caller, list, { maxPays: 4, minPayout: t.rules.minPayout });
  }

  /**
   * What the "Run the vault now" transactions did, read from the chain (only this program's
   * events count), and added to the token's log so the stats include them.
   */
  async function crankResult(mintStr: string, signatures: string[]) {
    const mint = new PublicKey(mintStr).toBase58();
    if (!isVaultMint(mint)) throw new Error("This token's tax isn't held by the Tax Vault.");
    const v = await readVault(new PublicKey(mint));
    if (!v) throw new Error("This token's vault hasn't been started yet.");
    const logged = loggedSignatures(mint);
    const out: { signature: string; ok: boolean; events: Record<string, string | boolean>[] }[] = [];
    let reward = 0n;
    for (const sig of signatures.slice(0, 10)) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) continue;
      let tx = null;
      for (let i = 0; i < 4 && !tx; i++) {
        if (i) await new Promise((res) => setTimeout(res, 1_500));
        tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      }
      if (!tx?.meta) { out.push({ signature: sig, ok: false, events: [] }); continue; }
      const events = tx.meta.err ? [] : parseEvents(tx.meta.logMessages ?? [], program).filter((e) => e.vault === v.address.toBase58());
      const sender = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).get(0)!.toBase58();
      if (events.length && !logged.has(sig)) { record(mint, v, sig, events, sender); logged.add(sig); }
      for (const e of events) if (e.name === "Sold") reward += e.crankReward;
      out.push({ signature: sig, ok: !tx.meta.err, events: events.map((e) => Object.fromEntries(Object.entries(e).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x]))) });
    }
    viewCache.delete(mint);
    return { results: out, crankRewardLamports: reward.toString() };
  }

  /**
   * v3: the guardian (the creator) appoints a new publisher, once the publisher has been
   * silent long enough. Refused with a clear message before then or for another wallet.
   */
  async function appointIxs(mintStr: string, guardian: PublicKey, newPublisher: PublicKey): Promise<TransactionInstruction[]> {
    const mint = new PublicKey(mintStr);
    if (!isVaultMint(mint.toBase58())) throw new Error("This token's tax isn't held by the Tax Vault.");
    const v = await readVault(mint);
    if (!v) throw new Error("This token's vault hasn't been started yet.");
    if (v.version < 3) throw new Error("This vault hasn't been upgraded to v3 yet; run the vault once first.");
    if (!v.guardian.equals(guardian)) throw new Error(`Only the vault's guardian (the creator, ${v.guardian.toBase58().slice(0, 4)}…${v.guardian.toBase58().slice(-4)}) can appoint a publisher.`);
    if (newPublisher.equals(v.publisher)) throw new Error("That wallet is already the publisher.");
    const at = appointAllowedAt(v)!;
    if (nowSecs() < at) {
      throw new Error(`The publisher published a list ${new Date(v.lastPublishAt * 1000).toUTCString()}; a new publisher can be appointed from ${new Date(at * 1000).toUTCString()}.`);
    }
    return [appointPublisherIx(program, guardian, mint, newPublisher)];
  }

  /** Forget a token's cached vault (after the creator starts it, so the pages show it at once). */
  const forget = (mint: string) => { viewCache.delete(mint); };

  return {
    program, isVaultMint, authOf, view, listView, badge, rewardMintOf, crankOnce, discover, crankPlan, crankResult, appointIxs, forget,
    crankOn: () => !!crank, passMs: PASS_MS,
  };
}
