/**
 * Bonding-curve launches on the factory site: the list and detail data, buy/sell
 * transactions for the viewer's wallet to sign, and the crank that graduates finished
 * curves and delivers buyers' tokens.
 *
 * Read-only views are cached briefly (public RPCs rate-limit). The crank signs with
 * factory.curve.crankKeypair, a hot wallet that pays the fees and earns the graduation
 * reward; without it nothing is sent, and graduation is left to anyone else (it is
 * permissionless on-chain).
 *
 * At graduation the crank registers the token: with the distributor, or (a Tax Vault curve
 * token, see src/factory/launch.ts) as a vault token whose vault the creator then starts.
 */
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ExtensionType, TOKEN_2022_PROGRAM_ID, getAccountLen, getTokenMetadata } from "@solana/spl-token";
import { Config, loadKeypair, toBaseUnits } from "../config.js";
import { sendAndConfirm, sign, simulate, withPriority } from "../tx.js";
import {
  CURVE_BPS, CURVE_DISC, CurveStatus, DECIMALS, FEE_BPS, GRADUATE_REWARD, GRADUATION_DEPOSIT, POSITION_DISC, POSITION_LEN, SNIPE_MAX_BPS, SNIPE_WINDOW_SECS,
  DEFAULT_TARGET_XNT, STATUS_NAMES, SUPPLY_MAX, SUPPLY_MIN, TARGETS_XNT, buyIx, curvePda, decodeCurve, decodePosition, deliverIx, graduateLockIx, graduatePoolIx,
  marketCapOf, parseEvents, positionPda, priceOf, progressOf, quoteBuy, quoteSell, sellIx, x0Of, y0Of, type Curve, type Position,
} from "../curve.js";
import { readLaunch, registerLaunch } from "./launch.js";

const s = (v: bigint) => v.toString();
const nowSecs = () => Math.floor(Date.now() / 1000);
/** Most deliveries batched into one crank transaction (also capped by transaction size). */
const MAX_DELIVERS_PER_TX = 6;

export interface CurveTrade { sig: string; ts: number; trader: string; isBuy: boolean; xnt: string; fee: string; tokens: string; priceAfter: number; raisedXnt: string }

export function curveService(conn: Connection, cfg: Config, opts: { microLamports: number }) {
  const program = new PublicKey(cfg.factory!.curve!.programId);

  // ---------- reads ----------
  async function allCurves(): Promise<Curve[]> {
    const raw = await conn.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(CURVE_DISC) } }] });
    const out: Curve[] = [];
    for (const { pubkey, account } of raw) {
      try { out.push(decodeCurve(pubkey, account.data)); } catch { /* not a curve */ }
    }
    return out;
  }
  async function positionsOf(curve: PublicKey): Promise<Position[]> {
    const raw = await conn.getProgramAccounts(program, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISC) } }, { memcmp: { offset: 8, bytes: curve.toBase58() } }],
    });
    const out: Position[] = [];
    for (const { pubkey, account } of raw) {
      try { out.push(decodePosition(pubkey, account.data)); } catch { /* skip */ }
    }
    return out;
  }
  async function readCurve(mint: PublicKey) {
    const addr = curvePda(program, mint);
    const info = await conn.getAccountInfo(addr, "confirmed");
    if (!info || !info.owner.equals(program)) throw new Error("That isn't a curve token on this site.");
    return decodeCurve(addr, info.data);
  }

  /** Name, symbol and logo: the launch record when this site made it, else the token's on-chain metadata. */
  const metaCache = new Map<string, { name: string; symbol: string }>();
  async function describe(mint: string) {
    const r = readLaunch(mint);
    if (r) {
      return { name: r.name, symbol: r.symbol, image: r.image || null, description: r.description || "",
        links: { website: r.website ?? null, twitter: r.twitter ?? null, telegram: r.telegram ?? null }, registered: !!r.registeredAt };
    }
    let m = metaCache.get(mint);
    if (!m) {
      const md = await getTokenMetadata(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
      m = { name: md?.name || "Unnamed", symbol: md?.symbol || "?" };
      if (md) metaCache.set(mint, m);
    }
    return { ...m, image: null, description: "", links: { website: null, twitter: null, telegram: null }, registered: false };
  }

  function summary(c: Curve) {
    return {
      mint: c.mint.toBase58(), curve: c.address.toBase58(), creator: c.creator.toBase58(),
      status: STATUS_NAMES[c.status] ?? "unknown", statusCode: c.status,
      progress: progressOf(c), tokensSold: s(c.tokensSold), curveTokens: s(c.curveTokens),
      raisedXnt: s(c.raisedXnt), targetXnt: s(c.targetXnt), priceXnt: priceOf(c), marketCapXnt: s(marketCapOf(c)),
      supply: s(c.supply), taxBps: c.taxBps, createdAt: c.createdAt, positions: c.positions,
      pool: c.status >= CurveStatus.PoolCreated ? c.pool.toBase58() : null,
      lockNft: c.status >= CurveStatus.Graduated ? c.lockNft.toBase58() : null,
    };
  }

  /** What a first buy costs on top of the price: the position account and the token-account deposit (refunded at delivery if unused). */
  let firstBuyCost: bigint | null = null;
  async function firstBuyExtra() {
    if (firstBuyCost !== null) return firstBuyCost;
    const [pos, ata] = await Promise.all([
      conn.getMinimumBalanceForRentExemption(POSITION_LEN),
      conn.getMinimumBalanceForRentExemption(getAccountLen([ExtensionType.ImmutableOwner, ExtensionType.TransferFeeAmount])),
    ]);
    firstBuyCost = BigInt(pos + ata);
    return firstBuyCost;
  }

  // Each curve's own target is `targetXnt` in its summary (lamports); these are the choices for a new one (whole XNT).
  const params = () => ({
    programId: program.toBase58(), targetsXnt: TARGETS_XNT.map(s), defaultTargetXnt: s(DEFAULT_TARGET_XNT), feeBps: Number(FEE_BPS), curveBps: Number(CURVE_BPS),
    depositXnt: s(GRADUATION_DEPOSIT), rewardXnt: s(GRADUATE_REWARD), snipeWindowSecs: SNIPE_WINDOW_SECS, snipeMaxBps: Number(SNIPE_MAX_BPS),
    supplyMin: s(SUPPLY_MIN), supplyMax: s(SUPPLY_MAX), decimals: DECIMALS, now: nowSecs(),
  });

  let listCache: { at: number; data: Promise<unknown> } | null = null;
  /** GET /api/curves: every curve with its progress, price and market cap. Cached 15 s. */
  function list() {
    if (listCache && Date.now() - listCache.at < 15_000) return listCache.data;
    const data = (async () => {
      const curves = await allCurves();
      const rows = await Promise.all(curves.map(async (c) => ({ ...summary(c), ...(await describe(c.mint.toBase58())) })));
      rows.sort((a, b) => b.progress - a.progress);
      return { params: params(), curves: rows };
    })();
    data.catch(() => { listCache = null; });
    listCache = { at: Date.now(), data };
    return data;
  }

  /** Trades from the curve's Trade events, newest first; each transaction is read once. */
  const tradeCache = new Map<string, { at: number; trades: CurveTrade[]; seen: Set<string>; pending?: Promise<CurveTrade[]> }>();
  async function trades(curve: PublicKey): Promise<CurveTrade[]> {
    const key = curve.toBase58();
    const hit = tradeCache.get(key) ?? { at: 0, trades: [], seen: new Set<string>() };
    tradeCache.set(key, hit);
    if (Date.now() - hit.at < 15_000) return hit.trades;
    hit.pending ??= (async () => {
      const sigs = (await conn.getSignaturesForAddress(curve, { limit: 50 }, "confirmed")).filter((x) => !x.err && !hit.seen.has(x.signature));
      for (let i = 0; i < sigs.length; i += 10) {
        const batch = sigs.slice(i, i + 10);
        const txs = await conn.getTransactions(batch.map((x) => x.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        txs.forEach((tx, j) => {
          const sig = batch[j].signature;
          if (!tx) return; // not available yet; try again next refresh
          hit.seen.add(sig);
          for (const e of parseEvents(tx.meta?.logMessages ?? [])) {
            if (e.name !== "Trade" || e.curve !== key) continue;
            hit.trades.push({ sig, ts: e.ts, trader: e.trader, isBuy: e.isBuy, xnt: s(e.xnt), fee: s(e.fee), tokens: s(e.tokens),
              priceAfter: Number(e.virtualXnt) / Number(e.virtualTokens), raisedXnt: s(e.raisedXnt) });
          }
        });
      }
      hit.trades.sort((a, b) => b.ts - a.ts || a.sig.localeCompare(b.sig));
      hit.trades.splice(200);
      hit.at = Date.now();
      return hit.trades;
    })().catch((e) => {
      // Served stale (or empty) rather than failing the page; retried on the next view.
      console.error(`Curve trades for ${key} failed: ${e instanceof Error ? e.message : e}`);
      return hit.trades;
    }).finally(() => { hit.pending = undefined; });
    return hit.trades.length ? hit.trades : hit.pending;
  }

  const viewCache = new Map<string, { at: number; data: Promise<Record<string, unknown>> }>();
  /** GET /api/curve/<mint>: full state, recent trades, holders, and (with ?wallet) that wallet's position. */
  async function view(mintStr: string, wallet?: string | null) {
    const mint = new PublicKey(mintStr);
    let hit = viewCache.get(mint.toBase58());
    if (!hit || Date.now() - hit.at > 10_000) {
      const data = (async () => {
        const c = await readCurve(mint);
        const [meta, tr, pos, extra] = await Promise.all([
          describe(mint.toBase58()), trades(c.address).catch(() => [] as CurveTrade[]), positionsOf(c.address).catch(() => [] as Position[]),
          firstBuyExtra().catch(() => null),
        ]);
        const holders = pos.filter((p) => p.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
          .map((p) => ({ owner: p.owner.toBase58(), balance: s(p.balance),
            pctSupply: c.supply > 0n ? Number((p.balance * 1_000_000n) / c.supply) / 10_000 : 0 }));
        return {
          ...summary(c), ...meta, params: params(), firstBuyExtraXnt: extra === null ? null : s(extra),
          state: {
            supply: s(c.supply), curveTokens: s(c.curveTokens), poolTokensGross: s(c.poolTokensGross), poolTokensNet: s(c.poolTokensNet),
            targetXnt: s(c.targetXnt), virtualXnt: s(c.virtualXnt), virtualTokens: s(c.virtualTokens), tokensSold: s(c.tokensSold),
            raisedXnt: s(c.raisedXnt), x0: s(x0Of(c)), y0: s(y0Of(c)), createdAt: c.createdAt, status: c.status,
            positions: c.positions, delivered: s(c.delivered),
          },
          trades: tr.slice(0, 50), holders, holderCount: holders.length,
        };
      })();
      data.catch(() => viewCache.delete(mint.toBase58()));
      hit = { at: Date.now(), data };
      viewCache.set(mint.toBase58(), hit);
      if (viewCache.size > 500) viewCache.clear();
    }
    const out: Record<string, unknown> = { ...(await hit.data), params: params() };
    if (wallet) {
      const owner = new PublicKey(wallet);
      const addr = positionPda(program, curvePda(program, mint), owner);
      const [info, lamports] = await Promise.all([conn.getAccountInfo(addr, "confirmed"), conn.getBalance(owner, "confirmed")]);
      const p = info ? decodePosition(addr, info.data) : null;
      out.wallet = { address: owner.toBase58(), balance: p ? s(p.balance) : "0", hasPosition: !!p, xnt: String(lamports) };
    }
    return out;
  }

  // ---------- buy / sell (the viewer's wallet signs) ----------
  const slippage = (raw: unknown) => {
    const v = raw === undefined || raw === null || raw === "" ? 100 : Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 5000) throw new Error("Slippage must be 0 to 50%.");
    return BigInt(v);
  };
  async function buildBuy(body: Record<string, unknown>) {
    const buyer = new PublicKey(String(body.wallet));
    const mint = new PublicKey(String(body.mint));
    const xntIn = toBaseUnits(String(body.xnt ?? "").trim(), 9);
    if (xntIn <= 0n) throw new Error("Enter how much XNT to spend.");
    const slip = slippage(body.slippageBps);
    const c = await readCurve(mint);
    if (c.status !== CurveStatus.Trading) throw new Error("This curve is finished; it's graduating to its XDEX pool.");
    if (c.creator.equals(buyer)) throw new Error("The creator can't buy on their own curve.");
    const q = quoteBuy(c, xntIn, nowSecs());
    if (q.error === "zero") throw new Error("That amount is too small to buy any tokens.");
    if (q.error === "too-big-early") {
      throw new Error(`For the first ${SNIPE_WINDOW_SECS / 60} minutes one buy can take at most 1% of the supply. Try a smaller amount.`);
    }
    const minOut = (q.out * (10_000n - slip)) / 10_000n;
    const ix = buyIx(program, buyer, mint, xntIn, minOut);
    return { ixs: [ix], payer: buyer, quote: { xntIn: s(q.xntIn), fee: s(q.fee), tokensOut: s(q.out), minTokensOut: s(minOut), completes: q.complete } };
  }
  async function buildSell(body: Record<string, unknown>) {
    const seller = new PublicKey(String(body.wallet));
    const mint = new PublicKey(String(body.mint));
    const slip = slippage(body.slippageBps);
    const c = await readCurve(mint);
    if (c.status !== CurveStatus.Trading) throw new Error("Selling back to the curve stops once it's complete; your tokens arrive at graduation.");
    const addr = positionPda(program, c.address, seller);
    const info = await conn.getAccountInfo(addr, "confirmed");
    const balance = info ? decodePosition(addr, info.data).balance : 0n;
    const raw = String(body.tokens ?? "").trim();
    const tokensIn = raw === "all" ? balance : toBaseUnits(raw, DECIMALS);
    if (tokensIn <= 0n) throw new Error("Enter how many tokens to sell.");
    if (tokensIn > balance) throw new Error("That's more than your curve balance.");
    const q = quoteSell(c, tokensIn);
    if (q.out <= 0n) throw new Error("That amount is too small to sell.");
    const minOut = (q.out * (10_000n - slip)) / 10_000n;
    return { ixs: [sellIx(program, seller, mint, tokensIn, minOut)], payer: seller,
      quote: { tokensIn: s(tokensIn), gross: s(q.gross), fee: s(q.fee), xntOut: s(q.out), minXntOut: s(minOut) } };
  }

  /** Forget cached views after a trade so the page shows it on the next load. */
  function invalidate(mint?: string) {
    listCache = null;
    if (mint) { viewCache.delete(mint); const c = curvePda(program, new PublicKey(mint)).toBase58(); const t = tradeCache.get(c); if (t) t.at = 0; }
  }

  // ---------- crank ----------
  let crank: Keypair | null = null;
  const crankPath = cfg.factory?.curve?.crankKeypair;
  if (crankPath) {
    try { crank = loadKeypair(crankPath); } catch (e) { console.error(`Curve crank off: can't read factory.curve.crankKeypair (${e instanceof Error ? e.message : e})`); }
  }

  async function send(label: string, ixs: TransactionInstruction[], units: number) {
    const signed = await sign(conn, withPriority(ixs, opts.microLamports, units), crank!);
    await simulate(conn, signed.tx);
    await sendAndConfirm(conn, signed);
    console.log(`[curve crank] ${label}: ${signed.signature}`);
  }

  /** Fits in one transaction? (Size only; the compute limit is covered by MAX_DELIVERS_PER_TX.) */
  function fits(ixs: TransactionInstruction[]) {
    const tx = new Transaction({ feePayer: crank!.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(...withPriority(ixs, opts.microLamports, 1_400_000));
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  }

  async function deliverAll(c: Curve) {
    const open = await positionsOf(c.address);
    const ixs = open.map((p) => ({ owner: p.owner, ix: deliverIx(program, crank!.publicKey, c.mint, p.owner, c.creator) }));
    while (ixs.length) {
      const batch: typeof ixs = [];
      while (ixs.length && batch.length < MAX_DELIVERS_PER_TX && fits([...batch, ixs[0]].map((b) => b.ix))) batch.push(ixs.shift()!);
      if (!batch.length) batch.push(ixs.shift()!); // a single delivery always fits
      try {
        await send(`deliver ${batch.length} to ${c.mint.toBase58().slice(0, 4)}…`, batch.map((b) => b.ix), 1_400_000);
      } catch (e) {
        if (batch.length === 1) { console.error(`[curve crank] deliver to ${batch[0].owner.toBase58()} failed: ${e instanceof Error ? e.message : e}`); continue; }
        // One bad delivery shouldn't hold up the rest: retry them one by one.
        for (const b of batch) {
          await send(`deliver to ${b.owner.toBase58().slice(0, 4)}…`, [b.ix], 400_000)
            .catch((err) => console.error(`[curve crank] deliver to ${b.owner.toBase58()} failed: ${err instanceof Error ? err.message : err}`));
        }
      }
    }
  }

  /**
   * One pass: move every finished curve along (pool, lock, deliveries) and register graduated
   * ones (pool and lock NFT recorded) with the distributor, or as vault tokens.
   */
  let cranking = false;
  async function crankOnce() {
    if (cranking) return;
    cranking = true;
    try {
      for (let c of await allCurves()) {
        const mint = c.mint.toBase58();
        try {
          if (crank && c.status === CurveStatus.Complete) {
            await send(`graduate_pool ${mint}`, [graduatePoolIx(program, cfg.network, crank.publicKey, c.mint)], 1_000_000);
            c = await readCurve(c.mint);
          }
          if (crank && c.status === CurveStatus.PoolCreated) {
            await send(`graduate_lock ${mint}`, [graduateLockIx(program, cfg.network, crank.publicKey, c.mint, c.creator)], 1_000_000);
            c = await readCurve(c.mint);
          }
          if (crank && c.status === CurveStatus.Graduated) {
            await deliverAll(c);
            c = await readCurve(c.mint);
          }
          // Start paying holders once the token trades on XDEX (the lock NFT keys the creator's reward).
          // A vault token waits for its creator to start the vault; the vault crank serves it from then on.
          const r = readLaunch(mint);
          if (r && !r.registeredAt && c.status >= CurveStatus.Graduated) {
            await registerLaunch(conn, cfg, r);
            console.log(r.taxVault
              ? `[curve crank] registered ${r.symbol} (${mint}) as a Tax Vault token; the creator starts its vault`
              : `[curve crank] registered ${r.symbol} (${mint}) with the distributor`);
          }
          if (c.status >= CurveStatus.Complete) invalidate(mint);
        } catch (e) {
          console.error(`[curve crank] ${mint}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.error(`[curve crank] listing curves failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      cranking = false;
    }
  }

  return { program, list, view, buildBuy, buildSell, invalidate, crankOnce, crankOn: () => !!crank };
}
