/**
 * The arbitrage engine shared by scripts/arb-bot.ts and scripts/arb-scan.ts: price a route,
 * size it, build its swaps, and send it safely.
 *
 * A route is a cycle of XDEX swaps that starts and ends in XNT, e.g. a triangle
 *   XNT -> Q (Q/XNT) -> T (T/Q) -> XNT (T/XNT)
 * or two side pools of one token
 *   XNT -> Qa (Qa/XNT) -> T (T/Qa) -> Qb (T/Qb) -> XNT (Qb/XNT).
 * Every hop pays its pool's fee and the transfer fee of whatever Token-2022 token moves. Each hop
 * after the first spends the previous hop's minimum output (its quote less --slippage), and the
 * last hop's minimum is the stake plus the minimum profit: if prices move before it lands, the
 * whole transaction fails and nothing is traded.
 *
 * Sending: each trade is simulated first and skipped if the simulation fails (the gap is already
 * gone), so a lost race costs nothing; the simulation also sizes the compute limit (X1 charges for
 * the compute a transaction requests). Routes of four swaps go through an address lookup table the
 * engine creates and extends for the wallet (state/arb-alt-<wallet>.json). Several routes that share
 * no pool can be sent at once.
 *
 * Ownership: with `own` wallets, each route's mispriced pools (the side pools) are checked for how
 * much of their liquidity those wallets provide (LP held, or locked in the 8N4E… locker); a route
 * on your own pools mostly moves your money, so it can be held to a higher minimum profit.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TransferFeeConfig, calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { confirmByPolling } from "./tx.js";
import { cpmmOut, poolAuthority, swapIx, type Snapshot } from "./xdex.js";

/** One swap of a route: sell `inMint` into `snap`'s pool. */
export interface Hop { snap: Snapshot; inMint: PublicKey }
export interface Route {
  name: string;
  hops: Hop[];
  /** The pools whose price is off (side pools): what ownership is judged on. */
  mispriced: PublicKey[];
}
export interface PlannedSwap { snap: Snapshot; inSide: number; amountIn: bigint; out: bigint; minOut: bigint }
export interface Plan { route: Route; xntIn: bigint; xntOut: bigint; profit: bigint; swaps: PlannedSwap[]; minProfit: bigint }

export interface EngineOptions {
  conn: Connection;
  xdex: PublicKey;
  wallet: Keypair;
  minProfit: bigint;
  /** Minimum profit for a route whose mispriced pools are mostly the `own` wallets' liquidity. */
  ownMinProfit?: bigint;
  own?: PublicKey[];
  maxIn: bigint;
  slipBps: bigint;
  /** Plain XNT always kept unwrapped for fees. */
  reserve: bigint;
  priority: number;
  /** Priority (micro-lamports per compute unit) for trades through a pool another trader is racing for. */
  racePriority?: number;
  stateDir: string;
  log: (s: string) => void;
  alert: (s: string) => Promise<void>;
}

const LOCKER_8N4E = new PublicKey("8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf");
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_TX = 1232;

/** Rent of one new token account (about 0.0021 XNT): a route that needs accounts opened must earn it on top of its minimum. */
export const ACCOUNT_RENT = 2_100_000n;

export function createEngine(o: EngineOptions) {
  const { conn, xdex, wallet } = o;
  const owner = wallet.publicKey;
  const wxntAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID);
  const fees = new Map<string, TransferFeeConfig | null>([[NATIVE_MINT.toBase58(), null]]);
  const journal = path.join(o.stateDir, "arb-trades.jsonl");

  /** Remember each snapshot's token-side transfer fee (the other side's comes from its own XNT pool's snapshot). */
  function learnFees(snaps: Iterable<Snapshot>) {
    for (const s of snaps) fees.set(s.pool.mints[s.side].toBase58(), s.feeCfg.newerTransferFee.transferFeeBasisPoints || s.feeCfg.olderTransferFee.transferFeeBasisPoints ? s.feeCfg : null);
  }
  const feeOn = (mint: PublicKey, epoch: bigint, a: bigint) => { const c = fees.get(mint.toBase58()); return c ? calculateEpochFee(c, epoch, a) : 0n; };
  const haircut = (a: bigint) => (a * (10_000n - o.slipBps)) / 10_000n;

  // ---------- planning ----------
  function plan(route: Route, xntIn: bigint, minProfit: bigint): Plan {
    let amt = xntIn;
    const swaps: PlannedSwap[] = [];
    route.hops.forEach((h, i) => {
      const s = h.snap, inSide = s.pool.mints.findIndex((m) => m.equals(h.inMint)), outMint = s.pool.mints[1 - inSide];
      const net = amt - feeOn(h.inMint, s.epoch, amt);
      const [rIn, rOut] = inSide === s.side ? [s.reserveToken, s.reserveQuote] : [s.reserveQuote, s.reserveToken];
      const gross = net > 0n ? cpmmOut(net, rIn, rOut, s.tradeFeeRate) : 0n;
      const out = gross - feeOn(outMint, s.epoch, gross);
      const last = i === route.hops.length - 1;
      const minOut = last ? xntIn + minProfit : haircut(out);
      swaps.push({ snap: s, inSide, amountIn: amt, out, minOut });
      amt = last ? out : minOut;
    });
    return { route, xntIn, xntOut: amt, profit: amt - xntIn, swaps, minProfit };
  }

  /**
   * The most profitable size up to maxIn: a coarse search (sizes 25% apart), then a ternary search
   * between the best size's neighbours (profit rises then falls with size).
   */
  function best(route: Route, minProfit: bigint): Plan {
    const sizes: bigint[] = [];
    for (let x = 10_000_000n; x < o.maxIn; x = (x * 5n) / 4n) sizes.push(x);
    sizes.push(o.maxIn);
    const at = (x: bigint) => plan(route, x, minProfit);
    let bi = 0, bp = at(sizes[0]);
    sizes.forEach((x, i) => { const p = at(x); if (p.profit > bp.profit) { bp = p; bi = i; } });
    let lo = sizes[Math.max(0, bi - 1)], hi = sizes[Math.min(sizes.length - 1, bi + 1)];
    for (let k = 0; k < 40 && hi - lo > 1_000_000n; k++) {
      const m1 = lo + (hi - lo) / 3n, m2 = hi - (hi - lo) / 3n;
      if (at(m1).profit < at(m2).profit) lo = m1; else hi = m2;
    }
    const refined = at((lo + hi) / 2n);
    return refined.profit > bp.profit ? refined : bp;
  }

  // ---------- ownership ----------
  const ownCache = new Map<string, { at: number; share: number }>();
  const own = o.own ?? [];
  /** Share (0..1) of `pool`'s liquidity the own wallets provide (LP held or locked in 8N4E…), cached 30 minutes. */
  async function ownShare(pool: Snapshot): Promise<number> {
    if (!own.length) return 0;
    const k = pool.pool.address.toBase58(), hit = ownCache.get(k);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.share;
    const lp = pool.pool.lpMint, issued = pool.pool.lpSupply;
    let mine = 0n;
    for (const w of own) {
      for (const a of (await conn.getParsedTokenAccountsByOwner(w, { mint: lp }, "confirmed")).value) mine += BigInt(a.account.data.parsed.info.tokenAmount.amount);
      for (const { account } of await conn.getProgramAccounts(LOCKER_8N4E, { commitment: "confirmed", filters: [{ dataSize: 186 }, { memcmp: { offset: 104, bytes: w.toBase58() } }, { memcmp: { offset: 72, bytes: lp.toBase58() } }] }))
        mine += account.data.readBigUInt64LE(136);
    }
    const share = issued > 0n ? Math.min(1, Number(mine) / Number(issued)) : 0;
    ownCache.set(k, { at: Date.now(), share });
    return share;
  }
  async function routeOwnShare(route: Route) {
    const snaps = route.mispriced.map((p) => route.hops.find((h) => h.snap.pool.address.equals(p))!.snap);
    const shares = await Promise.all(snaps.map(ownShare));
    return shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : 0;
  }
  /** The best plan for each route, each judged against its own minimum (higher on your own pools). */
  async function bestAll(routes: Route[]) {
    const out: { plan: Plan; ownShare: number; pays: boolean }[] = [];
    const floor = o.ownMinProfit !== undefined && o.ownMinProfit < o.minProfit ? o.ownMinProfit : o.minProfit;
    for (const r of routes) {
      const p0 = best(r, o.minProfit);
      // Ownership costs RPC calls: only look it up for a route that could pay at all.
      if (p0.profit < floor) { out.push({ plan: p0, ownShare: 0, pays: false }); continue; }
      const share = await routeOwnShare(r);
      const min = share >= 0.5 && o.ownMinProfit !== undefined ? o.ownMinProfit : o.minProfit;
      const p = min === o.minProfit ? p0 : best(r, min);
      out.push({ plan: p, ownShare: share, pays: p.profit >= min });
    }
    return out;
  }

  // ---------- accounts ----------
  const ataOf = (m: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(m, owner, false, program);
  const accountFor = (s: Snapshot, i: number) => (s.pool.mints[i].equals(NATIVE_MINT) ? wxntAta : ataOf(s.pool.mints[i], s.pool.programs[i]));
  /** Token accounts a route needs that the wallet doesn't have yet. */
  async function missingAccounts(routes: Route[]) {
    const need = new Map<string, TransactionInstruction>();
    for (const r of routes) for (const h of r.hops) for (const i of [0, 1]) {
      const s = h.snap, a = accountFor(s, i);
      need.set(a.toBase58(), createAssociatedTokenAccountIdempotentInstruction(owner, a, owner, s.pool.mints[i], s.pool.programs[i]));
    }
    const keys = [...need.keys()];
    const infos = await conn.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)), "confirmed");
    return [...need.values()].filter((_, i) => !infos[i]);
  }
  async function openAccounts(routes: Route[]) {
    const missing = await missingAccounts(routes);
    for (let i = 0; i < missing.length; i += 4) o.log(`setup: opened ${missing.slice(i, i + 4).length} token account(s): ${await send(missing.slice(i, i + 4))}`);
    return missing.length;
  }

  const balanceOf = async (a: PublicKey) => {
    const b = await conn.getTokenAccountBalance(a, "confirmed").catch(() => null);
    return b ? BigInt(b.value.amount) : null;
  };
  /** Instructions wrapping enough XNT for `need` (keeping the reserve unwrapped), [] if already wrapped, null if short. */
  async function wrapFor(need: bigint): Promise<TransactionInstruction[] | null> {
    const wrapped = (await balanceOf(wxntAta)) ?? 0n;
    if (wrapped >= need) return [];
    const plain = BigInt(await conn.getBalance(owner, "confirmed"));
    if (plain - o.reserve < need - wrapped) return null;
    return [SystemProgram.transfer({ fromPubkey: owner, toPubkey: wxntAta, lamports: need - wrapped }), createSyncNativeInstruction(wxntAta, TOKEN_PROGRAM_ID)];
  }

  // ---------- address lookup tables (for four-swap routes) ----------
  // A table holds up to 256 addresses; when it fills up another is created. The list lives in
  // state/arb-alt-<wallet>.json ({"addresses": [...]}, or the older {"address": "..."}).
  const altFile = path.join(o.stateDir, `arb-alt-${owner.toBase58()}.json`);
  const ALT_MAX = 256;
  let alts: AddressLookupTableAccount[] | null = null;
  function altAddresses(): PublicKey[] {
    if (!fs.existsSync(altFile)) return [];
    const j = JSON.parse(fs.readFileSync(altFile, "utf8"));
    return (j.addresses ?? (j.address ? [j.address] : [])).map((a: string) => new PublicKey(a));
  }
  async function loadAlts() {
    if (alts) return alts;
    const out: AddressLookupTableAccount[] = [];
    for (const a of altAddresses()) { const t = (await conn.getAddressLookupTable(a)).value; if (t) out.push(t); }
    alts = out;
    return alts;
  }
  /** Make sure the wallet's lookup tables hold every account these routes use; true if they changed (usable from the next slot). */
  async function ensureAlt(routes: Route[]) {
    const want = new Set<string>([xdex, poolAuthority(xdex), TOKEN_PROGRAM_ID, NATIVE_MINT, wxntAta, owner, SystemProgram.programId].map((k) => k.toBase58()));
    for (const r of routes) for (const h of r.hops) {
      const p = h.snap.pool;
      for (const k of [p.address, p.ammConfig, p.observation, ...p.vaults, ...p.mints, ...p.programs]) want.add(k.toBase58());
      for (const i of [0, 1]) want.add(accountFor(h.snap, i).toBase58());
    }
    alts = null;
    const tables = await loadAlts();
    const have = new Set(tables.flatMap((t) => t.state.addresses.map((a) => a.toBase58())));
    const add = [...want].filter((k) => !have.has(k)).map((k) => new PublicKey(k));
    if (!add.length) return false;
    let list = altAddresses();
    let last = tables[tables.length - 1];
    let room = last ? ALT_MAX - last.state.addresses.length : 0;
    for (let i = 0; i < add.length;) {
      if (room <= 0) {
        const slot = await conn.getSlot("finalized");
        const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority: owner, payer: owner, recentSlot: slot });
        o.log(`lookup table: created ${address.toBase58()}: ${await send([ix])}`);
        list = [...list, address];
        fs.mkdirSync(o.stateDir, { recursive: true });
        fs.writeFileSync(altFile, JSON.stringify({ addresses: list.map((a) => a.toBase58()) }) + "\n");
        await new Promise((r) => setTimeout(r, 1500));
        last = (await conn.getAddressLookupTable(address)).value!;
        room = ALT_MAX;
      }
      const chunk = add.slice(i, i + Math.min(20, room));
      const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: last!.key, authority: owner, payer: owner, addresses: chunk });
      o.log(`lookup table: added ${chunk.length} address(es) to ${last!.key.toBase58().slice(0, 4)}…: ${await send([ix])}`);
      i += chunk.length;
      room -= chunk.length;
    }
    await new Promise((r) => setTimeout(r, 1500));
    alts = null;
    await loadAlts();
    return true;
  }

  /** Trades that went through (bot and scanner alike): how many, and when the latest landed (ms). */
  const traded = { count: 0, lastAt: 0 };

  // ---------- sending ----------
  // A recent blockhash kept warm (refreshed every 2 s once warm() is called), so sending doesn't wait for one.
  let bh: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
  let bhTimer: NodeJS.Timeout | null = null;
  async function blockhash() {
    if (bh && Date.now() - bh.at < 2_500) return bh;
    const r = await conn.getLatestBlockhash("confirmed");
    bh = { ...r, at: Date.now() };
    return bh;
  }
  /** Keep a blockhash ready for long-running loops (the timer doesn't keep the process alive). */
  function warm() {
    if (bhTimer) return;
    bhTimer = setInterval(() => { conn.getLatestBlockhash("confirmed").then((r) => { bh = { ...r, at: Date.now() }; }).catch(() => undefined); }, 2_000);
    bhTimer.unref();
  }

  async function compile(ixs: TransactionInstruction[], useAlt: boolean, recent: string) {
    const tables = useAlt ? await loadAlts() : [];
    return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: recent, instructions: ixs }).compileToV0Message(tables));
  }
  /**
   * Simulate `ixs` (with a generous compute limit) against the latest ("processed") state and return the
   * compute it used, or the error. This is the "simulate first" check: a trade whose gap is already gone
   * fails here, for free.
   */
  async function simulate(ixs: TransactionInstruction[], useAlt = false) {
    const probe = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs];
    const tx = await compile(probe, useAlt, PublicKey.default.toBase58());
    const bytes = tx.serialize().length;
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
    return { bytes, err: sim.value.err, units: sim.value.unitsConsumed ?? 0, logs: sim.value.logs ?? [] };
  }
  /**
   * Send `ixs` as one v0 transaction and wait for it. The compute limit comes from `units` (a simulation
   * the caller already ran) or from a fresh simulation, which must pass: a transaction the simulation
   * rejects is never sent (it would only burn its fee). It goes out without the RPC's own preflight check
   * (already simulated), at `priority` micro-lamports per compute unit.
   */
  async function send(ixs: TransactionInstruction[], useAlt = false, opt: { units?: number; priority?: number } = {}) {
    let used = opt.units;
    if (used === undefined) {
      const sim = await simulate(ixs, useAlt);
      if (sim.err) throw new Error(`simulation failed, not sent: ${JSON.stringify(sim.err)}${sim.logs.length ? ` (${sim.logs.at(-1)})` : ""}`);
      used = sim.units;
    }
    const units = !used ? 600_000 : Math.min(1_400_000, Math.ceil(used * 1.2) + 3_000);
    const all = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opt.priority ?? o.priority }), ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs];
    const { blockhash: recent, lastValidBlockHeight } = await blockhash();
    const tx = await compile(all, useAlt, recent);
    tx.sign([wallet]);
    const raw = tx.serialize();
    if (raw.length > MAX_TX) throw new Error(`transaction is ${raw.length} bytes (max ${MAX_TX})`);
    const signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    await confirmByPolling(conn, raw, signature, lastValidBlockHeight);
    return signature;
  }

  // Pools another trader is racing for: a route through one that just failed or vanished between pricing
  // and sending is "contested" for 30 s, and trades through contested pools pay the higher race priority.
  const contested = new Map<string, number>();
  const RACE_WINDOW = 30_000;
  const markContested = (p: Plan) => { for (const h of p.route.hops) contested.set(h.snap.pool.address.toBase58(), Date.now() + RACE_WINDOW); };
  const isContested = (p: Plan) => p.route.hops.some((h) => (contested.get(h.snap.pool.address.toBase58()) ?? 0) > Date.now());

  function tripIxs(p: Plan) {
    return p.swaps.map((w) => swapIx(xdex, owner, { pool: w.snap.pool, side: w.inSide, amountIn: w.amountIn, minimumOut: w.minOut },
      accountFor(w.snap, w.inSide), accountFor(w.snap, 1 - w.inSide)));
  }
  const poolsOf = (p: Plan) => new Set(p.route.hops.map((h) => h.snap.pool.address.toBase58()));
  const describe = (p: Plan) => {
    const syms = p.route.hops.map((h) => h.snap.pool.address.toBase58().slice(0, 4));
    return `${p.route.name} (${p.route.hops.length} swaps via ${syms.join(" → ")})`;
  };

  /**
   * Send the paying plans: the most profitable first, then any others that share no pool with
   * those already chosen, all at once. Each is simulated first and skipped if that fails.
   * Returns how many went through.
   */
  /** XNT (plain + wrapped) the wallet gained in a landed transaction, fee included: what a trade really made. */
  async function realized(signature: string): Promise<bigint | null> {
    for (let i = 0; i < 4; i++) {
      const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (t?.meta) {
        const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta.loadedAddresses });
        let k = -1;
        for (let j = 0; j < keys.length; j++) if (keys.get(j)!.equals(owner)) { k = j; break; }
        const w = (l: typeof t.meta.preTokenBalances) => (l ?? []).filter((b) => b.owner === owner.toBase58() && b.mint === NATIVE_MINT.toBase58())
          .reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
        const lamports = k >= 0 ? BigInt(t.meta.postBalances[k] - t.meta.preBalances[k]) : 0n;
        return lamports + w(t.meta.postTokenBalances) - w(t.meta.preTokenBalances);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  // One batch of trades at a time: whatever calls execute (the bot's pass, the scanner's live check), two
  // batches never go out together, so the process never sends two trades through the same pool at once.
  // A batch waiting its turn is re-checked by its simulation before it is sent.
  let queue: Promise<unknown> = Promise.resolve();
  function execute(found: { plan: Plan; ownShare: number }[], meta: (p: Plan) => Record<string, unknown> = () => ({})): Promise<number> {
    const run = queue.then(() => executeNow(found, meta));
    queue = run.catch(() => undefined);
    return run;
  }

  async function executeNow(found: { plan: Plan; ownShare: number }[], meta: (p: Plan) => Record<string, unknown>) {
    const chosen: typeof found = [];
    const used = new Set<string>();
    for (const f of [...found].sort((a, b) => Number(b.plan.profit - a.plan.profit))) {
      const ps = poolsOf(f.plan);
      if ([...ps].some((k) => used.has(k))) continue;
      chosen.push(f);
      ps.forEach((k) => used.add(k));
    }
    if (!chosen.length) return 0;
    await openAccounts(chosen.map((c) => c.plan.route));
    const needAlt = chosen.some((c) => c.plan.route.hops.length > 3);
    if (needAlt && await ensureAlt(chosen.filter((c) => c.plan.route.hops.length > 3).map((c) => c.plan.route))) {
      o.log("lookup table updated: four-swap trades go out from the next check");
      chosen.splice(0, chosen.length, ...chosen.filter((c) => c.plan.route.hops.length <= 3));
      if (!chosen.length) return 0;
    }
    // One wrap for all of them (a separate transaction when several go out together).
    const total = chosen.reduce((t, c) => t + c.plan.xntIn, 0n);
    const wrap = await wrapFor(total);
    if (!wrap) { o.log(`skipped: the wallet is short of XNT for ${xnt(total)} (keeping ${xnt(o.reserve)} for fees)`); return 0; }
    if (wrap.length && chosen.length > 1) { await send(wrap); wrap.length = 0; }
    let done = 0;
    await Promise.all(chosen.map(async (c, i) => {
      const p = c.plan, useAlt = p.route.hops.length > 3;
      const ixs = [...(i === 0 ? wrap : []), ...tripIxs(p)];
      const sim = await simulate(ixs, useAlt);
      if (sim.err) { markContested(p); o.log(`${describe(p)}: gap gone before sending (simulation failed), skipped`); return; }
      const racing = isContested(p);
      try {
        const sig = await send(ixs, useAlt, { units: sim.units, priority: racing ? o.racePriority ?? o.priority : o.priority });
        done++;
        traded.count++;
        traded.lastAt = Date.now();
        // What it really made (fee included), next to what the plan expected; a big shortfall is flagged.
        const actual = await realized(sig);
        const short = actual !== null && actual * 2n < p.profit;
        const entry = { at: new Date().toISOString(), name: p.route.name, hops: p.route.hops.length, pools: [...poolsOf(p)], pool: p.route.mispriced[0]?.toBase58(),
          xntIn: p.xntIn.toString(), expectedProfit: p.profit.toString(), actualProfit: actual?.toString() ?? null, ownShare: Number(c.ownShare.toFixed(3)), signature: sig, ...meta(p) };
        fs.mkdirSync(path.dirname(journal), { recursive: true });
        fs.appendFileSync(journal, JSON.stringify(entry) + "\n");
        await o.alert(`traded ${describe(p)}${racing ? " [race priority]" : ""}: ${xnt(p.xntIn)} XNT in, expected +${xnt(p.profit)}, made ${actual === null ? "?" : `${actual >= 0n ? "+" : ""}${xnt(actual)}`} XNT`
          + `${short ? " (under half the expected: the pools moved before it landed)" : ""}${c.ownShare >= 0.5 ? ` (${Math.round(c.ownShare * 100)}% your own pool)` : ""}. ${sig}`);
      } catch (e) {
        markContested(p);
        o.log(`${describe(p)}: didn't go through${racing ? " (at race priority)" : ""} (nothing traded; only the fee if it landed): ${msg(e).split("\n")[0]}`);
      }
    }));
    return done;
  }

  return { traded, plan, best, bestAll, execute, realized, simulate, send, warm, tripIxs, wrapFor, openAccounts, missingAccounts, ensureAlt, learnFees, ownShare, wxntAta, balanceOf, accountFor, describe };
}
export type Engine = ReturnType<typeof createEngine>;

/** The routes of one token: a triangle per side pool (both directions) and, with `pairs`, every side pool to side pool. */
export function routesFor(t: { mint: PublicKey; symbol: string; main: Snapshot; sides: { name: string; side: Snapshot; quote: Snapshot; quoteMint: PublicKey }[] }, pairs: boolean): Route[] {
  const X = NATIVE_MINT;
  const out: Route[] = [];
  for (const s of t.sides) {
    out.push({ name: `${s.name} buy-side`, mispriced: [s.side.pool.address], hops: [{ snap: s.quote, inMint: X }, { snap: s.side, inMint: s.quoteMint }, { snap: t.main, inMint: t.mint }] });
    out.push({ name: `${s.name} buy-main`, mispriced: [s.side.pool.address], hops: [{ snap: t.main, inMint: X }, { snap: s.side, inMint: t.mint }, { snap: s.quote, inMint: s.quoteMint }] });
  }
  if (pairs) for (const a of t.sides) for (const b of t.sides) {
    if (a === b || a.quoteMint.equals(b.quoteMint) || a.quote.pool.address.equals(b.quote.pool.address)) continue;
    out.push({ name: `${a.name} → ${b.name}`, mispriced: [a.side.pool.address, b.side.pool.address],
      hops: [{ snap: a.quote, inMint: X }, { snap: a.side, inMint: a.quoteMint }, { snap: b.side, inMint: t.mint }, { snap: b.quote, inMint: b.quoteMint }] });
  }
  return out;
}
