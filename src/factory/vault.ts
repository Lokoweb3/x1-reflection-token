/**
 * Tax Vault on the factory site (docs/tax-vault-spec.md): read views for the token pages
 * and the crank that keeps every vault token moving.
 *
 * Every ~60 s, for each vault token (launch record or per-launch config says `taxVault`,
 * or a vault account exists for the mint), one pass:
 *   0. upgrade   a 480-byte v1 vault gets `upgrade_vault` once (the crank pays the extra rent)
 *   1. collect   when the tax waiting is worth at least the token's minHarvestXnt: harvest
 *                the accounts holding withheld tax into the mint, withdraw, split, burn
 *   2. sell      the sell buckets, price-impact capped on-chain (min(3%, tax/2)), one sale
 *                per slot, each confirmed before the next; stops at dust or
 *                when a sale was capped (the rest waits for the next pass)
 *   3. add_liquidity when at least 0.01 XNT is set aside; fund_creator when any is and the
 *                reward swap (XNT -> the network's reward token, capped at half the reward
 *                pool's fee, one per slot) would output something: the program swaps and
 *                deposits into the creator's vesting vault
 *   4. rewards list: new holders' XNT (holders_funded − list_total) is split pro-rata over
 *                eligible holders (the distributor's rules), added to each wallet's running
 *                total, saved to <state>/vault-list.json and published (publish_list)
 *   5. pay       once the list is active, every wallet whose total is at least
 *                minPayoutXnt above what it was paid (several pays per transaction)
 * Each confirmed transaction's program events are appended to the token's events.jsonl in
 * the shapes the hot-wallet distributor writes, so the site's stats keep working.
 *
 * The crank signs with factory.taxVault.publisherKeypair (pays the fees, is the list
 * publisher, earns the on-chain crank reward from each sale). Without it nothing is sent;
 * the read views still work. Every step is guarded: a failure is logged and the pass goes
 * on with the next step or token, never crashing the server; passes never overlap.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { Config, DEFAULT_MIN_HARVEST_XNT, FACTORY_DIR, fromBaseUnits, loadKeypair, toBaseUnits, xnt } from "../config.js";
import { BURN_OWNERS, allocate, eligibleBalances, scanTokenAccounts } from "../holders.js";
import { outcome, sendAndConfirm, sign, simulate, withPriority } from "../tx.js";
import { decodePool, poolAuthority, quoteBuy, quoteSell, snapshot, spotValue } from "../xdex.js";
import {
  MIN_LP_XNT, MIN_SELL_XNT, OUT_TOLERANCE_BPS, RENT_EXEMPT_EMPTY, REWARD_MINT, rewardImpactBps, VAULT_VERSION, sellImpactBps, addLiquidityIx, buildVaultTree,
  cancelsLeft, collectIx, decodePaidRecord, decodeVault, effectiveList, errorOf, fundCreatorIx, paidRecordPda, parseEvents, payIx, poolAccountsFrom, publishListIx,
  rewardPoolAccountsFrom, rewardTokenInfo, sellBuckets, sellIx, upgradeVaultIx, vaultAuthPda, vaultJson, vaultPda, type Vault, type VaultEvent, type VaultPoolAccounts,
} from "../taxvault.js";
import { type LaunchRecord, pairOf, readLaunch, registeredLaunches, vaultManaged } from "./launch.js";

const PASS_MS = 60_000;
/** Most harvest accounts one collect carries (also capped by transaction size). */
const MAX_HARVEST_PER_TX = 20;
/** Sales per token per pass; each is capped at 3% price impact on-chain. */
const MAX_SELLS_PER_PASS = 3;
const MAX_PAYS_PER_TX = 6;
/** Pay transactions per token per pass, so one big list can't hold up the others. */
const MAX_PAY_TXS_PER_PASS = 20;
/** Seconds after a list's active time before paying against it (the chain clock can lag ours). */
const ACTIVATION_MARGIN_SECS = 15;
/** fund_creator calls per token per pass (each capped at half the reward pool's fee, one per slot). */
const MAX_REWARD_SWAPS_PER_PASS = 5;
/** After a failed upgrade_vault (e.g. the program isn't upgraded yet), wait this long before trying again. */
const UPGRADE_RETRY_MS = 10 * 60_000;
const nowSecs = () => Math.floor(Date.now() / 1000);
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
  history: { at: string; epoch: string; root: string; total: string; event: "published" | "active" | "cancelled" | "dropped"; signature?: string }[];
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

  const authOf = (mint: string) => vaultAuthPda(program, new PublicKey(mint));
  const addrOf = (mint: string) => vaultPda(program, new PublicKey(mint));
  /** XNT-paired launches only: the vault is TOKEN/wXNT only in v1. */
  const xntPaired = (r: LaunchRecord) => !pairOf(cfg, r).xntPool;

  /** Whether the vault handles this token (its files say so, or a vault was seen on-chain). */
  function isVaultMint(mint: string) {
    if (seen.has(mint)) return true;
    let r: LaunchRecord | null = null;
    try { r = readLaunch(mint); } catch { return false; }
    return !!r && vaultManaged(r);
  }

  async function readVault(mint: PublicKey): Promise<Vault | null> {
    const addr = vaultPda(program, mint);
    const info = await conn.getAccountInfo(addr, "confirmed");
    if (!info || !info.owner.equals(program)) return null;
    return decodeVault(addr, info.data);
  }

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
      crank: { on: !!crank, wallet: crank?.publicKey.toBase58() ?? null, lastPass: status.get(mint) ?? null },
    };
  }
  const listSummary = (l: VaultList | null) => (l ? { epoch: l.epoch, root: l.root, total: l.total, wallets: Object.keys(l.wallets).length,
    builtAt: l.builtAt, publishedAt: l.publishedAt ?? null, activeAt: l.activeAt ?? null } : null);

  /** GET /api/vault/<mint>/list: the latest rewards list with every wallet's cumulative total. */
  async function listView(mintStr: string) {
    const mint = new PublicKey(mintStr).toBase58();
    if (!isVaultMint(mint)) throw new Error("This token's tax isn't held by the Tax Vault.");
    const file = readListFile(mint);
    const latest = file?.next ?? file?.active ?? null;
    if (!file || !latest) return { mint, vault: addrOf(mint).toBase58(), status: "none", epoch: null, root: null, total: "0", activeAt: null, wallets: [], active: null };
    const v = await cachedVault(mint).catch(() => null);
    const isNext = latest === file.next;
    const listStatus = !isNext ? "active"
      : v && v.listEpoch.toString() === latest.epoch ? "active"
      : latest.publishedAt ? "pending" : "draft";
    return {
      mint, vault: addrOf(mint).toBase58(), status: listStatus, epoch: latest.epoch, root: latest.root, total: latest.total,
      activeAt: latest.activeAt ?? null, builtAt: latest.builtAt, publishedAt: latest.publishedAt ?? null, signature: latest.signature ?? null,
      wallets: Object.entries(latest.wallets).map(([wallet, cumulative]) => ({ wallet, cumulative }))
        .sort((a, b) => (BigInt(b.cumulative) > BigInt(a.cumulative) ? 1 : BigInt(b.cumulative) < BigInt(a.cumulative) ? -1 : a.wallet.localeCompare(b.wallet))),
      // While a new list waits for its time, the one paying now.
      active: isNext && file.active ? { epoch: file.active.epoch, root: file.active.root, total: file.active.total } : null,
    };
  }

  /** The small summary token pages show (badge, list link, next list time); null for other tokens. */
  async function badge(mint: string) {
    if (!isVaultMint(mint)) return null;
    const v = await cachedVault(mint).catch(() => null);
    return {
      programId: program.toBase58(), vault: addrOf(mint).toBase58(), auth: authOf(mint).toBase58(), exists: !!v,
      listEpoch: v && v.listEpoch > 0n ? v.listEpoch.toString() : null,
      nextListAt: v && v.pendingEpoch > 0n ? v.pendingActiveAt : null,
      listUrl: `/api/vault/${mint}/list`,
      version: v?.version ?? null,
      // How many more pending lists the guardian (the creator) may cancel in a row (v2); null: no limit / no vault.
      cancelsLeft: v ? cancelsLeft(v) : null,
    };
  }

  /**
   * The mint a vault token's creator reward is paid in: the vault's reward_mint once it's v2,
   * else the network's reward token (what init_vault and upgrade_vault set).
   */
  async function rewardMintOf(mint: string): Promise<PublicKey> {
    const v = await cachedVault(mint).catch(() => null);
    return v && v.version >= VAULT_VERSION ? v.rewardMint : REWARD_MINT[cfg.network];
  }

  // ---------- crank ----------
  function fits(ixs: TransactionInstruction[]) {
    const tx = new Transaction({ feePayer: crank!.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(...withPriority(ixs, opts.microLamports, 1_400_000));
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  }

  /** The program's events for `vault` in a confirmed transaction (a few tries: RPCs lag). */
  async function eventsOf(signature: string, vault: PublicKey): Promise<VaultEvent[] | null> {
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise((r) => setTimeout(r, 2_000));
      const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (tx?.meta) {
        return parseEvents(tx.meta.logMessages ?? []).filter((e) => e.vault === vault.toBase58());
      }
    }
    return null;
  }

  async function send(tag: string, label: string, ixs: TransactionInstruction[], units: number, vault: PublicKey) {
    const signed = await sign(conn, withPriority(ixs, opts.microLamports, units), crank!);
    try {
      await simulate(conn, signed.tx);
    } catch (e) {
      const name = errorOf(msg(e));
      throw new Error(name ? `${label}: ${name}` : `${label}: ${msg(e).split("\n")[0]}`);
    }
    try {
      await sendAndConfirm(conn, signed);
    } catch (e) {
      // A slow confirmation can look like a failure; only a transaction that didn't land is one.
      if ((await outcome(conn, signed.signature, signed.lastValidBlockHeight).catch(() => "pending")) !== "confirmed") throw e;
    }
    console.log(`[vault crank] ${tag} ${label}: ${signed.signature}`);
    return { signature: signed.signature, events: (await eventsOf(signed.signature, vault)) ?? [] };
  }

  /** Append a confirmed transaction's events to the token's log in the distributor's shapes. */
  function record(mint: string, v: Vault, signature: string, events: VaultEvent[]) {
    const payments: [string, string][] = [];
    for (const e of events) {
      if (e.name === "Collected") {
        const lp = (e.got * BigInt(v.lpBps)) / 10_000n;
        logEvent(mint, { kind: "withdraw", signature, tokens: e.got.toString(), lpTokens: lp.toString(), vault: true });
        if (e.burned > 0n) logEvent(mint, { kind: "burn", signature, tokens: e.burned.toString() });
      } else if (e.name === "Sold") {
        logEvent(mint, { kind: "sell", signature, tokens: e.tokensIn.toString(), xnt: e.xntOut.toString(), lpXnt: e.toLp.toString() });
        // The crank reward is the vault's "Distribute now" reward: it goes to whoever sent the sale.
        if (e.crankReward > 0n) logEvent(mint, { kind: "clicker-reward", signature, xnt: e.crankReward.toString(), wallet: crank!.publicKey.toBase58() });
      } else if (e.name === "LiquidityAdded") {
        logEvent(mint, { kind: "auto-lp", signature, tokens: e.tokens.toString(), xnt: e.xnt.toString(), lp: e.lpBurned.toString() });
      } else if (e.name === "CreatorFunded") {
        // `xnt` is what the creator's share was worth in XNT (the site's totals); `reward` is
        // what went into the vesting vault, in the reward token's base units.
        const info = rewardTokenInfo(cfg.network, new PublicKey(e.rewardMint));
        logEvent(mint, { kind: "creator-reward", signature, xnt: e.xntIn.toString(), reward: e.rewardOut.toString(), rewardMint: e.rewardMint,
          rewardSymbol: info?.symbol ?? null, rewardDecimals: info?.decimals ?? null, vault: true });
      } else if (e.name === "Paid") {
        payments.push([e.wallet, e.amount.toString()]);
      }
    }
    if (payments.length) {
      logEvent(mint, { kind: "payout", signature, payments, total: payments.reduce((a, [, x]) => a + BigInt(x), 0n).toString(), vault: true });
    }
  }

  async function collectStep(r: LaunchRecord, v: Vault, notes: string[]) {
    const mint = new PublicKey(r.mint);
    const [rows, mintInfo] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed")]);
    const withheld = rows.filter((x) => x.withheld > 0n).sort((a, b) => (b.withheld > a.withheld ? 1 : b.withheld < a.withheld ? -1 : 0));
    const inMint = getTransferFeeConfig(unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
    const waiting = withheld.reduce((a, x) => a + x.withheld, 0n) + inMint;
    if (waiting === 0n) return;
    // Same threshold as the distributor: don't spend fees collecting dust.
    const worth = spotValue(waiting, await snapshot(conn, xdex, v.pool, mint));
    const min = toBaseUnits(tokenConfig(r)?.distribution.minHarvestXnt ?? DEFAULT_MIN_HARVEST_XNT, 9);
    if (worth < min) { notes.push(`tax waiting ~${xnt(worth)}, under ${xnt(min)}`); return; }
    const todo = withheld.map((x) => x.address);
    do {
      const chunk: PublicKey[] = [];
      while (todo.length && chunk.length < MAX_HARVEST_PER_TX && fits([collectIx(program, crank!.publicKey, mint, [...chunk, todo[0]])])) chunk.push(todo.shift()!);
      if (!chunk.length && todo.length) chunk.push(todo.shift()!);
      const { signature, events } = await send(r.symbol, `collect (${chunk.length} accounts)`, [collectIx(program, crank!.publicKey, mint, chunk)],
        200_000 + 15_000 * chunk.length, v.address);
      record(r.mint, v, signature, events);
      notes.push(`collected from ${chunk.length} account(s)`);
    } while (todo.length);
  }

  async function sellStep(r: LaunchRecord, pool: VaultPoolAccounts, notes: string[]) {
    const mint = new PublicKey(r.mint);
    for (let i = 0; i < MAX_SELLS_PER_PASS; i++) {
      const v = await readVault(mint);
      if (!v) return;
      const wanted = sellBuckets(v);
      if (wanted === 0n) return;
      // The program caps a sale at min(3%, tax/2) price impact; quote the same cap.
      const q = await quoteSell(conn, xdex, v.pool, mint, wanted, { maxImpactBps: sellImpactBps(r.taxBps), slippageBps: Number(OUT_TOLERANCE_BPS) });
      if (!q || q.expectedOut < MIN_SELL_XNT) { notes.push(`${fromBaseUnits(wanted, 9)} tokens to sell are still dust`); return; }
      // One sale per slot per vault, each confirmed before the next (never two in one
      // transaction). OneSellPerSlot means the last sale's slot hasn't passed: retry shortly.
      let sent: Awaited<ReturnType<typeof send>> | null = null;
      for (let attempt = 0; !sent; attempt++) {
        try {
          sent = await send(r.symbol, `sell ~${fromBaseUnits(q.amountIn, 9)} tokens for ~${xnt(q.expectedOut)}`,
            [sellIx(program, crank!.publicKey, mint, pool, wanted)], 400_000, v.address);
        } catch (e) {
          if (!/OneSellPerSlot/.test(msg(e)) || attempt >= 3) throw e;
          await new Promise((res) => setTimeout(res, 800));
        }
      }
      const { signature, events } = sent;
      record(r.mint, v, signature, events);
      notes.push(`sold for ~${xnt(q.expectedOut)}`);
      // Capped by the 3% price-impact limit: the rest waits for the next pass instead of walking the price down now.
      if (q.amountIn < wanted) return;
    }
  }

  async function liquidityStep(r: LaunchRecord, pool: VaultPoolAccounts, notes: string[]) {
    const mint = new PublicKey(r.mint);
    const v = await readVault(mint);
    if (!v || v.xntLp < MIN_LP_XNT || v.lpTokens === 0n) return;
    const { signature, events } = await send(r.symbol, `add_liquidity (${xnt(v.xntLp)} set aside)`, [addLiquidityIx(program, crank!.publicKey, mint, pool)], 400_000, v.address);
    record(r.mint, v, signature, events);
    notes.push("added liquidity");
  }

  /**
   * Swap the creator's XNT for the reward token and deposit it (fund_creator). Each swap is
   * capped on-chain at half the reward pool's trade fee, so a large bucket takes several
   * calls, one per slot, each confirmed before the next; the rest waits in xnt_creator.
   */
  async function creatorStep(r: LaunchRecord, notes: string[]) {
    const mint = new PublicKey(r.mint);
    for (let i = 0; i < MAX_REWARD_SWAPS_PER_PASS; i++) {
      const v = await readVault(mint);
      if (!v || v.xntCreator === 0n) return;
      if (v.version < VAULT_VERSION) { notes.push("creator reward waits for the vault upgrade"); return; }
      // Quote the swap the program makes (same cap, live reserves); skip when it would buy nothing.
      const q = await quoteBuy(conn, xdex, v.rewardSwapPool, v.rewardMint, v.xntCreator, Number(OUT_TOLERANCE_BPS), rewardImpactBps).catch((e) => {
        if (/too small|too shallow|no liquidity/i.test(msg(e))) return null;
        throw e;
      });
      const info = rewardTokenInfo(cfg.network, v.rewardMint);
      // The program needs a minimum out (expected x 99.5%) above zero.
      if (!q || q.minimumOut <= 0n) { notes.push(`creator reward ${xnt(v.xntCreator)} would buy no ${info?.symbol ?? "reward token"} yet`); return; }
      const rewardPool = rewardPoolAccountsFrom(xdex, q.pool, v.rewardMint);
      const out = info ? `${fromBaseUnits(q.expectedOut, info.decimals)} ${info.symbol}` : `${q.expectedOut} reward base units`;
      // ~150k CU, up to ~195k when it also creates the reward vault: the default 200k is too tight.
      let sent: Awaited<ReturnType<typeof send>> | null = null;
      for (let attempt = 0; !sent; attempt++) {
        try {
          sent = await send(r.symbol, `fund_creator ${xnt(q.amountIn)} for ~${out}`,
            [fundCreatorIx(program, crank!.publicKey, mint, v.creatorNft, rewardPool)], 300_000, v.address);
        } catch (e) {
          // The on-chain quote can come out smaller than ours (live reserves): wait for more.
          if (/: TooSmall$/.test(msg(e))) { notes.push(`creator reward ${xnt(v.xntCreator)} is still too small to swap`); return; }
          // One reward swap per slot: the last one's slot hasn't passed yet.
          if (!/OneSellPerSlot/.test(msg(e)) || attempt >= 3) throw e;
          await new Promise((res) => setTimeout(res, 800));
        }
      }
      record(r.mint, v, sent.signature, sent.events);
      notes.push(`creator reward ${xnt(q.amountIn)} -> ~${out}`);
      if (q.amountIn >= v.xntCreator) return; // all of it went
    }
  }

  /** A v1 (480-byte) vault: send upgrade_vault once; the crank pays the extra rent. */
  const upgradeFailedAt = new Map<string, number>();
  async function upgradeStep(r: LaunchRecord, v: Vault, notes: string[]) {
    if (v.version >= VAULT_VERSION) return v;
    const last = upgradeFailedAt.get(r.mint);
    if (last && Date.now() - last < UPGRADE_RETRY_MS) { notes.push("vault still v1 (upgrade retried later)"); return v; }
    try {
      await send(r.symbol, "upgrade_vault", [upgradeVaultIx(program, crank!.publicKey, v.mint)], 60_000, v.address);
      upgradeFailedAt.delete(r.mint);
      notes.push("vault upgraded to v2");
    } catch (e) {
      upgradeFailedAt.set(r.mint, Date.now());
      throw e;
    }
    return (await readVault(v.mint)) ?? v;
  }

  const tokenConfig = (r: LaunchRecord): Config | null => {
    const f = path.join(launchDir(r.mint), "config.json");
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch { return null; }
  };

  /**
   * Bring vault-list.json in line with the chain: the next list became active, is pending,
   * was cancelled by the guardian, or never landed (sent again). Returns false when the
   * file and the chain disagree in a way the crank can't repair (lists and pays stop).
   */
  async function syncList(r: LaunchRecord, v: Vault, file: VaultListFile, notes: string[]): Promise<boolean> {
    const hex = (b: Buffer) => b.toString("hex");
    const n = file.next;
    if (n) {
      if (v.listEpoch.toString() === n.epoch && hex(v.listRoot) === n.root) {
        file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "active" });
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
        file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "cancelled" });
        file.next = null;
        saveListFile(file);
        notes.push(`list ${n.epoch} was cancelled by the guardian`);
      } else {
        const floor = v.listEpoch > v.pendingEpoch ? v.listEpoch : v.pendingEpoch;
        const minTotal = v.listTotal > v.pendingTotal ? v.listTotal : v.pendingTotal;
        if (BigInt(n.epoch) > floor && BigInt(n.total) >= minTotal && BigInt(n.total) <= v.holdersFunded && v.pendingEpoch === 0n
            && (file.active?.root ?? hex(Buffer.alloc(32))) === hex(v.listRoot)) {
          await publish(r, v, file, notes); // saved but never landed: send the same list again
        } else {
          file.history.push({ at: new Date().toISOString(), epoch: n.epoch, root: n.root, total: n.total, event: "dropped" });
          file.next = null;
          saveListFile(file);
        }
      }
    }
    if (v.listEpoch > 0n && (!file.active || file.active.epoch !== v.listEpoch.toString() || file.active.root !== hex(v.listRoot))) {
      console.error(`[vault crank] ${r.symbol}: the on-chain rewards list (epoch ${v.listEpoch}) isn't the one in vault-list.json; lists and payouts paused for this token.`);
      notes.push("rewards list out of sync with the chain");
      return false;
    }
    return true;
  }

  async function publish(r: LaunchRecord, v: Vault, file: VaultListFile, notes: string[]) {
    const n = file.next!;
    const mint = new PublicKey(r.mint);
    const ix = publishListIx(program, crank!.publicKey, mint, Buffer.from(n.root, "hex"), BigInt(n.epoch), BigInt(n.total));
    const { signature, events } = await send(r.symbol, `publish_list epoch ${n.epoch} (${Object.keys(n.wallets).length} wallets, total ${xnt(BigInt(n.total))})`,
      [ix], 60_000, v.address);
    const pub = events.find((e) => e.name === "ListPublished");
    n.signature = signature;
    n.publishedAt = new Date().toISOString();
    if (pub?.name === "ListPublished") n.activeAt = pub.activeAt;
    file.history.push({ at: n.publishedAt, epoch: n.epoch, root: n.root, total: n.total, event: "published", signature });
    saveListFile(file);
    logEvent(r.mint, { kind: "allocate", signature, xnt: n.allocated ?? "0", holders: n.holders ?? 0, epoch: n.epoch, vault: true });
    notes.push(`published list ${n.epoch}`);
  }

  /** Allocate the holder pool's new XNT over eligible holders and publish the new totals. */
  async function listStep(r: LaunchRecord, v: Vault, file: VaultListFile, notes: string[]) {
    if (file.next || v.pendingEpoch > 0n) return; // one list at a time: a new one would restart the wait
    const tc = tokenConfig(r);
    if (!tc) { notes.push("no per-launch config yet"); return; }
    const dc = tc.distribution;
    const pot = v.holdersFunded - v.listTotal;
    if (pot < toBaseUnits(dc.minCycleXnt, 9)) return; // carried over, as the distributor does
    const mint = new PublicKey(r.mint);
    const [rows, mintInfo] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed")]);
    const decimals = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID).decimals;
    // The distributor's rules. The vault's auth PDA (off-curve, holds the collected tax) and
    // a migrated token's old distributor wallet never earn.
    const excluded = new Set([...dc.excludeOwners, ...BURN_OWNERS, r.distributor, authOf(r.mint).toBase58(), poolAuthority(xdex).toBase58()]);
    const balances = eligibleBalances(rows, { excluded, excludeOffCurve: dc.excludeOffCurveOwners, minHolding: toBaseUnits(dc.minHoldingTokens, decimals) });
    const shares = allocate(balances, pot);
    let allocated = 0n;
    for (const x of shares.values()) allocated += x;
    if (allocated === 0n) { if (balances.size === 0) notes.push("no eligible holders yet"); return; }
    const wallets: Record<string, string> = { ...(file.active?.wallets ?? {}) };
    for (const [w, x] of shares) wallets[w] = (BigInt(wallets[w] ?? "0") + x).toString();
    const total = v.listTotal + allocated;
    const epoch = (v.listEpoch > v.pendingEpoch ? v.listEpoch : v.pendingEpoch) + 1n;
    const { root } = buildVaultTree(v.address, wallets);
    file.next = {
      epoch: epoch.toString(), root: root.toString("hex"), total: total.toString(), wallets, builtAt: new Date().toISOString(),
      allocated: allocated.toString(), holders: shares.size,
    };
    saveListFile(file); // the list is on disk (and served) before it's published
    console.log(`[vault crank] ${r.symbol}: list ${epoch}: ${xnt(allocated)} across ${shares.size} holder(s), total ${xnt(total)}`);
    await publish(r, v, file, notes);
  }

  /** Pay every wallet the active list owes at least minPayoutXnt. */
  async function payStep(r: LaunchRecord, v: Vault, file: VaultListFile, notes: string[]) {
    const now = nowSecs();
    const eff = effectiveList(v, now - ACTIVATION_MARGIN_SECS);
    if (!eff) return;
    // A pending list inside the margin: wait, so every proof is for the list the program checks.
    if (!eff.pending && v.pendingEpoch > 0n && now >= v.pendingActiveAt) return;
    const list = eff.pending ? file.next : file.active;
    if (!list || list.root !== eff.root.toString("hex")) { notes.push("the list to pay isn't in vault-list.json"); return; }
    const tc = tokenConfig(r);
    const minPayout = toBaseUnits(tc?.distribution.minPayoutXnt ?? "0", 9);
    const entries = Object.entries(list.wallets).map(([w, c]) => ({ wallet: new PublicKey(w), cumulative: BigInt(c) }));
    // The program refuses a payout that would leave an empty wallet below the rent-exempt minimum.
    const rentMin = RENT_EXEMPT_EMPTY;
    const due: { wallet: PublicKey; cumulative: bigint; owed: bigint }[] = [];
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const [records, accounts] = await Promise.all([
        conn.getMultipleAccountsInfo(chunk.map((e) => paidRecordPda(program, v.address, e.wallet)), "confirmed"),
        conn.getMultipleAccountsInfo(chunk.map((e) => e.wallet), "confirmed"),
      ]);
      chunk.forEach((e, j) => {
        const info = records[j];
        const paid = info && info.owner.equals(program) ? decodePaidRecord(paidRecordPda(program, v.address, e.wallet), info.data).paid : 0n;
        const owed = e.cumulative - paid;
        // A payment to a wallet that doesn't exist yet must cover its rent-exempt minimum.
        if (owed > 0n && owed >= minPayout && (accounts[j] || owed >= rentMin)) due.push({ ...e, owed });
      });
    }
    if (!due.length && eff.pending) {
      // The program switches to a new list inside `pay`. If nobody is owed minPayoutXnt yet,
      // pay the largest amount owed anyway so the new list takes over and the next can follow.
      const owedAll = await owedUnder(v, entries, rentMin);
      if (owedAll) due.push(owedAll);
    }
    if (!due.length) return;
    const { proofs } = buildVaultTree(v.address, list.wallets);
    const mint = new PublicKey(r.mint);
    const ixOf = (d: (typeof due)[number]) => payIx(program, crank!.publicKey, mint, d.wallet, d.cumulative, proofs[d.wallet.toBase58()]);
    let txs = 0, paidWallets = 0;
    while (due.length && txs < MAX_PAY_TXS_PER_PASS) {
      const batch: typeof due = [];
      while (due.length && batch.length < MAX_PAYS_PER_TX && fits([...batch, due[0]].map(ixOf))) batch.push(due.shift()!);
      if (!batch.length) batch.push(due.shift()!);
      txs++;
      try {
        const { signature, events } = await send(r.symbol, `pay ${batch.length} wallet(s)`, batch.map(ixOf), Math.min(1_400_000, 60_000 + 90_000 * batch.length), v.address);
        // Events are the record; if they couldn't be read, log what was sent (the amounts are exact).
        record(r.mint, v, signature, events.some((e) => e.name === "Paid") ? events
          : batch.map((b) => ({ name: "Paid", vault: v.address.toBase58(), wallet: b.wallet.toBase58(), amount: b.owed, cumulative: b.cumulative }) as VaultEvent));
        paidWallets += batch.length;
      } catch (e) {
        if (batch.length === 1) { console.error(`[vault crank] ${r.symbol}: pay ${batch[0].wallet.toBase58()} failed: ${msg(e)}`); continue; }
        // One bad payment shouldn't hold up the rest: retry them one by one.
        for (const b of batch) {
          try {
            const { signature, events } = await send(r.symbol, `pay ${b.wallet.toBase58().slice(0, 4)}…`, [ixOf(b)], 200_000, v.address);
            record(r.mint, v, signature, events.some((x) => x.name === "Paid") ? events
              : [{ name: "Paid", vault: v.address.toBase58(), wallet: b.wallet.toBase58(), amount: b.owed, cumulative: b.cumulative }]);
            paidWallets++;
          } catch (err) {
            console.error(`[vault crank] ${r.symbol}: pay ${b.wallet.toBase58()} failed: ${msg(err)}`);
          }
        }
      }
    }
    if (paidWallets) notes.push(`paid ${paidWallets} wallet(s)`);
  }

  /** The wallet owed the most on this list (any amount), or null. */
  async function owedUnder(v: Vault, entries: { wallet: PublicKey; cumulative: bigint }[], rentMin: bigint) {
    let best: { wallet: PublicKey; cumulative: bigint; owed: bigint } | null = null;
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      const [records, accounts] = await Promise.all([
        conn.getMultipleAccountsInfo(chunk.map((e) => paidRecordPda(program, v.address, e.wallet)), "confirmed"),
        conn.getMultipleAccountsInfo(chunk.map((e) => e.wallet), "confirmed"),
      ]);
      chunk.forEach((e, j) => {
        const info = records[j];
        const paid = info && info.owner.equals(program) ? decodePaidRecord(paidRecordPda(program, v.address, e.wallet), info.data).paid : 0n;
        const owed = e.cumulative - paid;
        if (owed > 0n && (accounts[j] || owed >= rentMin) && (!best || owed > best.owed)) best = { ...e, owed };
      });
    }
    return best as { wallet: PublicKey; cumulative: bigint; owed: bigint } | null;
  }

  /** One token's pass. Each step is on its own: a failed sale doesn't stop payouts. */
  async function crankToken(r: LaunchRecord) {
    const notes: string[] = [];
    let ok = true;
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) {
        // A v1 vault under the v2 program refuses everything but upgrade_vault: wait for the upgrade.
        if (/: WrongVersion$/.test(msg(e))) { notes.push(`${name} waits for the vault upgrade`); return; }
        ok = false; notes.push(`${name} failed: ${msg(e).slice(0, 200)}`); console.error(`[vault crank] ${r.symbol} ${name}: ${msg(e)}`);
      }
    };
    const mint = new PublicKey(r.mint);
    // Only the creator can start a vault (init_vault); until then there's nothing to crank.
    const v = await readVault(mint);
    if (!v) { status.set(r.mint, { at: new Date().toISOString(), ok, notes: ["no vault yet (the creator starts it after the LP lock)"] }); return; }
    seen.add(r.mint);
    let vault = v;
    await step("upgrade_vault", async () => { vault = await upgradeStep(r, v, notes); });
    let pool: VaultPoolAccounts | null = null;
    await step("pool", async () => {
      const [info] = await conn.getMultipleAccountsInfo([vault.pool], "confirmed");
      pool = poolAccountsFrom(xdex, decodePool(vault.pool, info, xdex), mint);
    });
    await step("collect", () => collectStep(r, vault, notes));
    if (pool) {
      await step("sell", () => sellStep(r, pool!, notes));
      await step("add_liquidity", () => liquidityStep(r, pool!, notes));
    }
    await step("fund_creator", () => creatorStep(r, notes));
    await step("rewards list", async () => {
      const now = await readVault(mint);
      if (!now) return;
      const file: VaultListFile = readListFile(r.mint) ?? { version: 1, mint: r.mint, vault: now.address.toBase58(), active: null, next: null, history: [] };
      if (!(await syncList(r, now, file, notes))) return;
      const fresh = (await readVault(mint)) ?? now; // a re-sent list changes the pending fields
      await listStep(r, fresh, file, notes);
      const latest = (await readVault(mint)) ?? fresh;
      await payStep(r, latest, file, notes);
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

  return { program, isVaultMint, authOf, view, listView, badge, rewardMintOf, crankOnce, discover, crankOn: () => !!crank, passMs: PASS_MS };
}
