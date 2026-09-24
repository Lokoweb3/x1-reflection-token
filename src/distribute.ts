/**
 * One reflection cycle:
 *   1. finish any payout batches or journaled transactions left over from an interrupted run
 *   2. harvest withheld transfer fees from all holder accounts into the mint,
 *      then withdraw them to the distributor's token account; burnBps of them are
 *      set aside to burn and autoLpBps for auto-LP (half kept as tokens, half to be
 *      sold for XNT)
 *   2b. burn the tokens set aside to burn (the supply shrinks)
 *   3. sell the collected tokens for XNT on XDEX (price-impact capped)
 *   4. auto-LP: deposit the set-aside tokens + XNT into the pool and burn the LP tokens
 *   5. allocate new XNT pro-rata to eligible holders
 *   6. pay every holder whose accumulated share is at least minPayoutXnt
 *
 *   npm run distribute                 # dry run: shows what would happen
 *   npm run distribute -- --execute    # send transactions
 *   npm run distribute -- --execute --loop 60   # repeat every 60 minutes
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction, createHarvestWithheldTokensToMintInstruction, createWithdrawWithheldTokensFromMintInstruction,
  getAssociatedTokenAddressSync, getEpochFee, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  Config, DEFAULT_MIN_HARVEST_XNT, DEFAULT_MIN_SELL_XNT, connection, fromBaseUnits, loadConfig, loadKeypair, requireMint, toBaseUnits, xnt, XNT_DECIMALS,
} from "./config.js";
import { BURN_OWNERS, allocate, clickerReward, eligibleBalances, scanTokenAccounts, splitTax } from "./holders.js";
import {
  Inflight, State, acquireLock, addCreator, addLp, addOwed, loadState, logEvent, record, reservedXnt, saveState, totalOwed,
} from "./state.js";
import { outcome, run, sendAndConfirm, sign, simulate, withPriority } from "./tx.js";
import {
  buildBuy, buildDepositAndBurn, buildSell, lpKeepForBalance, poolAuthority, quoteBuy, quoteDeposit, quoteSell, snapshot,
} from "./xdex.js";
import { buildDepositReward } from "./locker-tx.js";
import { nftHolder } from "./locker.js";
import { listPasses } from "./holder-pass.js";
import { PASS, claimsMode, lockerProgram, publishRoot, reconcileRoot } from "./claims.js";

const HARVEST_CHUNK = 20;

/**
 * The distributor pays its own transaction fees. XNT not owed to holders or set aside
 * for auto-LP is its gas money. It is topped up from sale proceeds up to
 * operatingReserveXnt before anything new is allocated to holders, so after one small
 * initial funding it refills itself.
 */
async function gas(ctx: Ctx, s: State) {
  const dc = ctx.cfg.distribution;
  const balance = BigInt(await ctx.conn.getBalance(ctx.distributor.publicKey, "confirmed")) + ctx.projected.xnt;
  return {
    balance,
    free: balance - reservedXnt(s),
    reserve: toBaseUnits(dc.operatingReserveXnt, XNT_DECIMALS),
    min: toBaseUnits(dc.minGasXnt ?? "0.005", XNT_DECIMALS),
  };
}

interface Ctx {
  cfg: Config;
  conn: Connection;
  mint: PublicKey;
  distributor: Keypair;
  execute: boolean;
  decimals: number;
  /** Dry run only: tokens and XNT a real run would have collected or raised by this point. */
  projected: { tokens: bigint; xnt: bigint };
  /** Wallet that triggered this run with "Distribute now" (earns the clicker reward). */
  clicker?: PublicKey;
}

async function resolvePending(ctx: Ctx, s: State): Promise<boolean> {
  if (!s.pending) return true;
  for (const b of s.pending.batches) {
    if (b.status !== "sent") continue;
    const o = await outcome(ctx.conn, b.signature!, b.lastValidBlockHeight!);
    if (o === "confirmed") {
      settle(s, b);
      record(s, "payout", `recovered confirmed batch of ${b.payments.length}`, b.signature);
    } else if (o === "pending") {
      console.log(`Batch ${b.signature} is still in flight; try again shortly.`);
      saveState(s);
      return false;
    } else {
      record(s, "payout", `batch ${o}; will re-send`, b.signature);
      b.status = "unsent"; delete b.signature; delete b.lastValidBlockHeight;
    }
    saveState(s);
  }
  return true;
}

function settle(s: State, b: Batch) {
  for (const [owner, lamports] of b.payments) addOwed(s, owner, -BigInt(lamports));
  b.status = "confirmed";
  logEvent({
    kind: "payout", signature: b.signature, payments: b.payments,
    total: b.payments.reduce((a, [, v]) => a + BigInt(v), 0n).toString(),
  });
}
type Batch = NonNullable<State["pending"]>["batches"][number];

/**
 * Sign, simulate, journal the signature, then broadcast. The transaction's effect on
 * the auto-LP counters is applied by `reconcile` from the confirmed transaction, so a
 * crash at any point is repaired on the next run.
 */
async function sendJournaled(
  ctx: Ctx, s: State, ixs: TransactionInstruction[], units: number,
  entry: Omit<Inflight, "signature" | "lastValidBlockHeight">,
) {
  const { conn, distributor, cfg } = ctx;
  const signed = await sign(conn, withPriority(ixs, cfg.distribution.priorityMicroLamports, units), distributor);
  await simulate(conn, signed.tx);
  s.inflight = { ...entry, signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight };
  saveState(s); // journal before broadcasting
  try {
    await sendAndConfirm(conn, signed);
  } catch (e) {
    console.error(`${entry.kind} send error: ${e instanceof Error ? e.message : e}`);
  }
  const r = await reconcile(ctx, s);
  if (r === "wait") throw new Error(`${entry.kind} transaction ${signed.signature} unresolved; rerun later to reconcile.`);
  if (r === "dropped") throw new Error(`${entry.kind} transaction did not land; rerun to retry.`);
}

/** Resolve a journaled transaction and apply its effect to the auto-LP counters. */
async function reconcile(ctx: Ctx, s: State): Promise<"done" | "dropped" | "wait"> {
  const f = s.inflight;
  if (!f) return "done";
  const { conn, mint, distributor, decimals: d } = ctx;
  if (!ctx.execute) {
    console.log(`A ${f.kind} transaction (${f.signature}) is awaiting reconciliation; run with --execute.`);
    return "wait";
  }
  const o = await outcome(conn, f.signature, f.lastValidBlockHeight);
  if (o === "pending") { console.log(`${f.kind} transaction ${f.signature} is still in flight; try again shortly.`); return "wait"; }
  if (o !== "confirmed") {
    record(s, f.kind, `transaction ${o}; nothing changed`, f.signature);
    s.inflight = null; saveState(s);
    return "dropped";
  }

  let tx = null;
  for (let i = 0; i < 5 && !tx?.meta; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2_000));
    tx = await conn.getTransaction(f.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  }
  const meta = tx?.meta;
  if (!tx || !meta) { console.log(`${f.kind} transaction ${f.signature} confirmed but not retrievable yet; rerun to reconcile.`); return "wait"; }
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses }).keySegments().flat();
  const payer = keys.findIndex((k) => k.equals(distributor.publicKey));
  // Change in the distributor's XNT, excluding the network fee it paid.
  const xntDelta = BigInt(meta.postBalances[payer]) - BigInt(meta.preBalances[payer]) + BigInt(meta.fee);

  if (f.kind === "withdraw") {
    addLp(s, "tokens", BigInt(f.lpTokens ?? "0"));
    addLp(s, "sellTokens", BigInt(f.lpSellTokens ?? "0"));
    s.burn.pending = (BigInt(s.burn.pending) + BigInt(f.burnTokens ?? "0")).toString();
    addCreator(s, "sellTokens", BigInt(f.creatorSellTokens ?? "0"));
    logEvent({ kind: "withdraw", signature: f.signature, tokens: f.amount ?? "0",
      lpTokens: (BigInt(f.lpTokens ?? "0") + BigInt(f.lpSellTokens ?? "0")).toString() });
    record(s, "withdraw", `set aside ${fromBaseUnits(BigInt(f.lpTokens ?? "0") + BigInt(f.lpSellTokens ?? "0"), d)} tokens for auto-LP`, f.signature);
  } else if (f.kind === "burn") {
    const burned = BigInt(f.burnTokens ?? "0");
    const left = BigInt(s.burn.pending) - burned;
    s.burn.pending = (left > 0n ? left : 0n).toString();
    s.burn.burned = (BigInt(s.burn.burned) + burned).toString();
    logEvent({ kind: "burn", signature: f.signature, tokens: burned.toString() });
    record(s, "burn", `burned ${fromBaseUnits(burned, d)} tokens`, f.signature);
  } else if (f.kind === "creator-swap") {
    const spent = BigInt(f.creatorXnt ?? "0");
    const rewardMint = new PublicKey(ctx.cfg.creatorReward!.rewardMint!);
    const i = keys.findIndex((k) => k.equals(getAssociatedTokenAddressSync(rewardMint, distributor.publicKey, false, TOKEN_2022_PROGRAM_ID)));
    const bal = (list: typeof meta.preTokenBalances) => BigInt(list?.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0");
    const got = bal(meta.postTokenBalances) - bal(meta.preTokenBalances);
    addCreator(s, "xnt", -spent);
    addCreator(s, "rewardTokens", got);
    record(s, "creator-swap", `swapped ${xnt(spent)} for ${got} reward base units`, f.signature);
  } else if (f.kind === "creator") {
    const amount = BigInt(f.rewardAmount ?? "0");
    addCreator(s, "xnt", -BigInt(f.creatorXnt ?? "0"));
    addCreator(s, "rewardTokens", -(f.creatorXnt ? 0n : amount));
    addCreator(s, "deposited", amount);
    logEvent({ kind: "creator-reward", signature: f.signature, amount: amount.toString(), rewardMint: ctx.cfg.creatorReward?.rewardMint ?? "XNT" });
    record(s, "creator", `deposited ${amount} reward base units into the creator's 7-day vesting vault`, f.signature);
  } else if (f.kind === "sell") {
    const amountIn = BigInt(f.amountIn ?? "0");
    const lpPart = BigInt(f.lpSellTokens ?? "0");
    const lpXnt = amountIn > 0n ? (xntDelta * lpPart) / amountIn : 0n;
    addLp(s, "xnt", lpXnt);
    addLp(s, "sellTokens", -lpPart);
    const creatorPart = BigInt(f.creatorSellTokens ?? "0");
    const creatorXnt = amountIn > 0n ? (xntDelta * creatorPart) / amountIn : 0n;
    addCreator(s, "xnt", creatorXnt);
    addCreator(s, "sellTokens", -creatorPart);
    logEvent({ kind: "sell", signature: f.signature, tokens: amountIn.toString(), xnt: xntDelta.toString(), lpXnt: lpXnt.toString() });
    record(s, "sell", `${fromBaseUnits(amountIn, d)} tokens for ${xnt(xntDelta)} (${xnt(lpXnt)} to auto-LP)`, f.signature);
  } else {
    const ata = getAssociatedTokenAddressSync(mint, distributor.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const i = keys.findIndex((k) => k.equals(ata));
    const bal = (list: typeof meta.preTokenBalances) => BigInt(list?.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0");
    const tokensUsed = bal(meta.preTokenBalances) - bal(meta.postTokenBalances);
    const xntUsed = -xntDelta;
    addLp(s, "tokens", -tokensUsed);
    addLp(s, "xnt", -xntUsed); // anything left over is rebalanced next cycle
    logEvent({ kind: "auto-lp", signature: f.signature, tokens: tokensUsed.toString(), xnt: xntUsed.toString(), lp: f.lp ?? "0" });
    record(s, "auto-lp", `added ${fromBaseUnits(tokensUsed, d)} tokens + ${xnt(xntUsed)} and burned the LP tokens`, f.signature);
  }
  s.inflight = null; saveState(s);
  return "done";
}

/** Collect withheld fees. Returns, in a dry run, the tokens a real run would collect. */
async function harvest(ctx: Ctx, s: State) {
  const { conn, mint, distributor, cfg } = ctx;
  const rows = await scanTokenAccounts(conn, mint);
  const withheld = rows.filter((r) => r.withheld > 0n);
  const heldTotal = withheld.reduce((a, r) => a + r.withheld, 0n);
  console.log(`Holder accounts: ${rows.length}; ${withheld.length} with withheld fees totalling ${fromBaseUnits(heldTotal, ctx.decimals)}`);
  // Don't spend gas collecting dust: wait until the tax waiting to be collected is worth
  // at least minHarvestXnt at the pool price (collection never loses anything; it waits).
  const mintNow = unpackMint(mint, await conn.getAccountInfo(mint), TOKEN_2022_PROGRAM_ID);
  const waiting = heldTotal + (getTransferFeeConfig(mintNow)?.withheldAmount ?? 0n);
  if (cfg.xdex.pool && waiting > 0n) {
    const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(cfg.xdex.pool), mint);
    const worth = (waiting * snap.reserveXnt) / snap.reserveToken;
    const min = toBaseUnits(cfg.distribution.minHarvestXnt ?? DEFAULT_MIN_HARVEST_XNT, XNT_DECIMALS);
    if (worth < min) {
      console.log(`Tax waiting is worth ~${xnt(worth)}, under minHarvestXnt (${xnt(min)}); collecting later.`);
      return;
    }
  }
  const lpBps = cfg.distribution.autoLpBps ?? 0;
  const burnBps = cfg.distribution.burnBps ?? 0;
  const creatorBps = cfg.distribution.creatorBps ?? 0;

  if (!ctx.execute) {
    // Dry run: act on in-memory state as if the fees had been collected. Never saved.
    const mintState = unpackMint(mint, await conn.getAccountInfo(mint), TOKEN_2022_PROGRAM_ID);
    const total = heldTotal + (getTransferFeeConfig(mintState)?.withheldAmount ?? 0n);
    const { burn, keep, sell, creator } = splitTax(total, lpBps, burnBps, creatorBps);
    addLp(s, "tokens", keep); addLp(s, "sellTokens", sell);
    s.burn.pending = (BigInt(s.burn.pending) + burn).toString();
    addCreator(s, "sellTokens", creator);
    ctx.projected.tokens += total;
    return;
  }

  for (let i = 0; i < withheld.length; i += HARVEST_CHUNK) {
    const chunk = withheld.slice(i, i + HARVEST_CHUNK).map((r) => r.address);
    const sig = await run(conn, withPriority(
      [createHarvestWithheldTokensToMintInstruction(mint, chunk, TOKEN_2022_PROGRAM_ID)],
      cfg.distribution.priorityMicroLamports), distributor);
    console.log(`  harvested ${chunk.length} accounts  ${sig}`);
  }

  const mintState = unpackMint(mint, await conn.getAccountInfo(mint), TOKEN_2022_PROGRAM_ID);
  const inMint = getTransferFeeConfig(mintState)?.withheldAmount ?? 0n;
  if (inMint === 0n) return;
  const ata = getAssociatedTokenAddressSync(mint, distributor.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const { burn, keep, sell, creator } = splitTax(inMint, lpBps, burnBps, creatorBps);
  await sendJournaled(ctx, s, [
    createAssociatedTokenAccountIdempotentInstruction(distributor.publicKey, ata, distributor.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createWithdrawWithheldTokensFromMintInstruction(mint, ata, distributor.publicKey, [], TOKEN_2022_PROGRAM_ID),
  ], 100_000, {
    kind: "withdraw", amount: inMint.toString(), lpTokens: keep.toString(), lpSellTokens: sell.toString(), burnTokens: burn.toString(),
    creatorSellTokens: creator.toString(),
  });
  console.log(`  withdrew ${fromBaseUnits(inMint, ctx.decimals)} tokens to ${ata.toBase58()}`);
}

/**
 * Split the auto-LP tokens (kept + awaiting sale) so that, after the sale, the kept
 * tokens and the XNT are worth the same at the pool price. XNT left over from an
 * earlier cycle is matched by keeping more tokens instead of sitting idle.
 */
async function balanceLp(ctx: Ctx, s: State) {
  const { conn, mint, cfg } = ctx;
  const total = BigInt(s.lp.tokens) + BigInt(s.lp.sellTokens);
  if (!cfg.xdex.pool || total === 0n) return;
  const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(cfg.xdex.pool), mint);
  const keep = lpKeepForBalance(total, BigInt(s.lp.xnt), snap.reserveToken, snap.reserveXnt,
    BigInt(getEpochFee(snap.feeCfg, snap.epoch).transferFeeBasisPoints), snap.tradeFeeRate);
  if (keep.toString() === s.lp.tokens) return;
  const d = ctx.decimals;
  console.log(`Auto-LP balance: keep ${fromBaseUnits(keep, d)} tokens, sell ${fromBaseUnits(total - keep, d)} `
    + `to pair with ${xnt(BigInt(s.lp.xnt))} already set aside`);
  s.lp.tokens = keep.toString();
  s.lp.sellTokens = (total - keep).toString();
  if (ctx.execute) saveState(s);
}

/** Burn the collected tax set aside for burning, so the supply shrinks. */
async function burnTax(ctx: Ctx, s: State) {
  const pending = BigInt(s.burn.pending);
  if (pending === 0n) return;
  const held = await heldTokens(ctx);
  const amount = pending < held ? pending : held;
  if (amount === 0n) return;
  console.log(`Burn ${fromBaseUnits(amount, ctx.decimals)} tokens of collected tax`);
  if (!ctx.execute) {
    s.burn.pending = (pending - amount).toString();
    ctx.projected.tokens -= amount;
    return;
  }
  const { mint, distributor } = ctx;
  const ata = getAssociatedTokenAddressSync(mint, distributor.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await sendJournaled(ctx, s, [
    createBurnCheckedInstruction(ata, mint, distributor.publicKey, amount, ctx.decimals, [], TOKEN_2022_PROGRAM_ID),
  ], 60_000, { kind: "burn", burnTokens: amount.toString() });
}

/** Tokens in the distributor's account (plus, in a dry run, those it would have collected). */
async function heldTokens(ctx: Ctx) {
  const ata = getAssociatedTokenAddressSync(ctx.mint, ctx.distributor.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const info = await ctx.conn.getAccountInfo(ata);
  return (info ? unpackAccount(ata, info, TOKEN_2022_PROGRAM_ID).amount : 0n) + ctx.projected.tokens;
}

async function sell(ctx: Ctx, s: State) {
  const { conn, mint, distributor, cfg } = ctx;
  if (!cfg.xdex.pool) { console.log("xdex.pool not set; skipping sale."); return; }
  // Tokens kept for the auto-LP token side or waiting to be burned are not for sale.
  const held = await heldTokens(ctx);
  const kept = BigInt(s.lp.tokens) + BigInt(s.burn.pending);
  const sellable = held > kept ? held - kept : 0n;
  let balance = sellable;
  const cap = cfg.distribution.maxSellTokensPerCycle;
  if (cap) { const c = toBaseUnits(cap, ctx.decimals); if (balance > c) balance = c; }
  if (balance === 0n) { console.log("No collected tokens to sell."); return; }

  const programId = new PublicKey(cfg.xdex.programId);
  const q = await quoteSell(conn, programId, new PublicKey(cfg.xdex.pool), mint, balance, {
    maxImpactBps: cfg.distribution.maxPriceImpactBps, slippageBps: cfg.distribution.slippageBps,
  });
  if (!q) { console.log("Pool too shallow to sell within the price-impact limit."); return; }
  if (q.expectedOut < toBaseUnits(cfg.distribution.minSellXnt ?? DEFAULT_MIN_SELL_XNT, XNT_DECIMALS)) {
    console.log(`Tokens to sell are worth only ~${xnt(q.expectedOut)}; selling later.`);
    return;
  }
  // The auto-LP and creator shares of this sale, pro-rata to their share of everything awaiting sale.
  const lpSell = BigInt(s.lp.sellTokens);
  const lpPart = ((lpSell < sellable ? lpSell : sellable) * q.amountIn) / sellable;
  const creatorSell = BigInt(s.creator.sellTokens);
  const creatorPart = ((creatorSell < sellable ? creatorSell : sellable) * q.amountIn) / sellable;
  const d = ctx.decimals;
  console.log(`Sell ${fromBaseUnits(q.amountIn, d)} (of ${fromBaseUnits(sellable, d)}) -> ~${xnt(q.expectedOut)}`
    + ` (min ${xnt(q.minimumOut)}, impact ${Number(q.priceImpactBps) / 100}%, transfer fee ${fromBaseUnits(q.transferFee, d)})`
    + (lpPart > 0n ? `; ${fromBaseUnits(lpPart, d)} of it for auto-LP` : "")
    + (creatorPart > 0n ? `; ${fromBaseUnits(creatorPart, d)} for the creator` : ""));

  if (!ctx.execute) {
    addLp(s, "xnt", (q.expectedOut * lpPart) / q.amountIn);
    addLp(s, "sellTokens", -lpPart);
    addCreator(s, "xnt", (q.expectedOut * creatorPart) / q.amountIn);
    addCreator(s, "sellTokens", -creatorPart);
    ctx.projected.tokens -= q.amountIn;
    ctx.projected.xnt += q.expectedOut;
    return;
  }
  await sendJournaled(ctx, s, await buildSell(conn, programId, distributor, mint, q), 250_000,
    { kind: "sell", amountIn: q.amountIn.toString(), lpSellTokens: lpPart.toString(), creatorSellTokens: creatorPart.toString() });
}

/**
 * Creator reward: deposit the XNT set aside for the creator into the lock NFT's 7-day
 * vesting vault. With wrapped XNT as the reward it is wrapped and deposited directly;
 * with another reward token (USDC) it is first swapped on the configured XDEX pool.
 */
async function creatorReward(ctx: Ctx, s: State) {
  const { conn, cfg, distributor } = ctx;
  const cr = cfg.creatorReward;
  if (!cr?.nftMint || !(cfg.distribution.creatorBps ?? 0) && BigInt(s.creator.xnt) === 0n && BigInt(s.creator.rewardTokens) === 0n) return;
  const nftMint = new PublicKey(cr.nftMint);
  const rewardMint = cr.rewardMint ? new PublicKey(cr.rewardMint) : NATIVE_MINT;
  const pending = BigInt(s.creator.xnt);
  const min = toBaseUnits(cfg.distribution.minCycleXnt, XNT_DECIMALS);

  if (rewardMint.equals(NATIVE_MINT)) {
    if (pending < min) { if (pending > 0n) console.log(`Creator reward: holding ${xnt(pending)} until at least minCycleXnt.`); return; }
    console.log(`Creator reward: deposit ${xnt(pending)} into the lock NFT's vesting vault (claimable in 7 days)`);
    if (!ctx.execute) { s.creator.xnt = "0"; ctx.projected.xnt -= pending; return; }
    const { ixs } = await buildDepositReward(conn, cfg, distributor.publicKey, nftMint, NATIVE_MINT, pending);
    await sendJournaled(ctx, s, ixs, 120_000, { kind: "creator", creatorXnt: pending.toString(), rewardAmount: pending.toString() });
    return;
  }

  // Another reward token (USDC): swap the creator's XNT on the XNT/USDC pool, then deposit.
  if (!cr.swapPool) throw new Error("creatorReward.swapPool is required for a non-XNT reward token");
  if (pending >= min) {
    const q = await quoteBuy(conn, new PublicKey(cfg.xdex.programId), new PublicKey(cr.swapPool), rewardMint, pending,
      cfg.distribution.slippageBps, cfg.distribution.maxPriceImpactBps);
    console.log(`Creator reward: swap ${xnt(pending)} for ~${q.expectedOut} reward base units (impact ${Number(q.priceImpactBps) / 100}%)`);
    if (!ctx.execute) { s.creator.xnt = "0"; ctx.projected.xnt -= pending; return; }
    await sendJournaled(ctx, s, await buildBuy(conn, new PublicKey(cfg.xdex.programId), distributor, q), 250_000,
      { kind: "creator-swap", creatorXnt: q.amountIn.toString() });
  }
  const rewardTokens = BigInt(s.creator.rewardTokens);
  if (rewardTokens > 0n && ctx.execute) {
    const { ixs } = await buildDepositReward(conn, cfg, distributor.publicKey, nftMint, rewardMint, rewardTokens);
    await sendJournaled(ctx, s, ixs, 120_000, { kind: "creator", rewardAmount: rewardTokens.toString() });
  }
}

/** Pair the set-aside tokens with the set-aside XNT in the pool and burn the LP tokens. */
async function autoLp(ctx: Ctx, s: State) {
  const { conn, mint, distributor, cfg } = ctx;
  const tokens = BigInt(s.lp.tokens);
  const lpXnt = BigInt(s.lp.xnt);
  if (!cfg.xdex.pool || (tokens === 0n && lpXnt === 0n)) return;
  const d = ctx.decimals;
  const waiting = `${fromBaseUnits(tokens, d)} tokens + ${xnt(lpXnt)}`;
  if (tokens === 0n || lpXnt < toBaseUnits(cfg.distribution.minCycleXnt, XNT_DECIMALS)) {
    console.log(`Auto-LP: holding ${waiting} until both sides are ready (at least minCycleXnt of XNT).`);
    return;
  }
  const held = await heldTokens(ctx);
  const programId = new PublicKey(cfg.xdex.programId);
  const q = await quoteDeposit(conn, programId, new PublicKey(cfg.xdex.pool), mint,
    tokens < held ? tokens : held, lpXnt, cfg.distribution.slippageBps);
  if (!q) { console.log(`Auto-LP: ${waiting} is too small to deposit yet.`); return; }
  console.log(`Auto-LP: deposit ~${fromBaseUnits(q.tokenIn, d)} tokens + ~${xnt(q.xntIn)} (of ${waiting}), `
    + `mint and burn ${fromBaseUnits(q.lp, q.pool.lpDecimals)} LP tokens`);

  if (!ctx.execute) {
    addLp(s, "tokens", -q.tokenIn); addLp(s, "xnt", -q.xntIn);
    ctx.projected.tokens -= q.tokenIn;
    ctx.projected.xnt -= q.xntIn;
    return;
  }
  await sendJournaled(ctx, s, await buildDepositAndBurn(conn, programId, distributor, mint, q), 300_000, { kind: "lp", lp: q.lp.toString() });
}

async function allocateNew(ctx: Ctx, s: State) {
  const { conn, mint, distributor, cfg } = ctx;
  const dc = cfg.distribution;
  const g = await gas(ctx, s);
  const pot = g.free - g.reserve;
  console.log(`Distributor balance ${xnt(g.balance)}; owed to holders ${xnt(totalOwed(s))}; set aside for auto-LP ${xnt(BigInt(s.lp.xnt))}; `
    + `gas ${xnt(g.free)} of ${xnt(g.reserve)} target; new pot for holders ${xnt(pot > 0n ? pot : 0n)}`);
  if (pot <= 0n) { console.log("All free XNT is refilling the gas reserve this cycle; nothing new for holders."); return; }
  if (pot < toBaseUnits(dc.minCycleXnt, XNT_DECIMALS)) { console.log("Pot below minCycleXnt; carrying over."); return; }

  const excluded = new Set([
    ...dc.excludeOwners, ...BURN_OWNERS, distributor.publicKey.toBase58(),
    poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58(),
  ]);
  const rows = await scanTokenAccounts(conn, mint);
  const balances = eligibleBalances(rows, {
    excluded, excludeOffCurve: dc.excludeOffCurveOwners, minHolding: toBaseUnits(dc.minHoldingTokens, ctx.decimals),
  });
  // Claims mode: only wallets holding a pass earn, and each wallet counts once (its
  // oldest pass gets the share; extra passes in the same wallet earn nothing).
  const passOf = new Map<string, string>();
  if (claimsMode(cfg)) {
    for (const p of await listPasses(conn, lockerProgram(cfg), mint)) {
      const h = await nftHolder(conn, p.passMint);
      const owner = h?.owner.toBase58();
      if (owner && balances.has(owner) && !passOf.has(owner)) passOf.set(owner, p.passMint.toBase58());
    }
    for (const owner of [...balances.keys()]) if (!passOf.has(owner)) balances.delete(owner);
    console.log(`Holder passes: ${passOf.size} eligible wallet(s) hold one.`);
  }
  // Whoever pressed "Distribute now" earns a small cut of this run's holder pot, but
  // only when there are holders to pay.
  const reward = ctx.clicker && balances.size > 0
    ? clickerReward(pot, dc.clickerRewardBps ?? 100, toBaseUnits(dc.clickerRewardCapXnt ?? "0.05", XNT_DECIMALS))
    : 0n;
  const shares = allocate(balances, pot - reward);
  let allocated = 0n;
  for (const v of shares.values()) allocated += v;
  console.log(`Eligible holders: ${balances.size}; allocating ${xnt(allocated)}`
    + (reward > 0n ? `; clicker reward ${xnt(reward)} to ${ctx.clicker!.toBase58()}` : ""));
  if (!ctx.execute || allocated === 0n) return;
  if (reward > 0n) {
    addOwed(s, ctx.clicker!.toBase58(), reward);
    record(s, "clicker-reward", `${xnt(reward)} to ${ctx.clicker!.toBase58()} for triggering this run`);
    logEvent({ kind: "clicker-reward", xnt: reward.toString(), wallet: ctx.clicker!.toBase58() });
  }
  for (const [owner, v] of shares) addOwed(s, passOf.size ? PASS + passOf.get(owner)! : owner, v);
  record(s, "allocate", `${xnt(allocated)} across ${shares.size} holders`);
  logEvent({ kind: "allocate", xnt: allocated.toString(), holders: shares.size });
  saveState(s);
}

async function planPayouts(ctx: Ctx, s: State) {
  if (s.pending) return;
  const { conn, cfg } = ctx;
  const minPayout = toBaseUnits(cfg.distribution.minPayoutXnt, XNT_DECIMALS);
  const due = Object.entries(s.owed).filter(([o]) => !o.startsWith(PASS)).map(([o, v]) => [o, BigInt(v)] as const).filter(([, v]) => v >= minPayout);
  if (due.length === 0) { console.log("No holder has reached minPayoutXnt yet."); return; }
  const g = await gas(ctx, s);
  if (g.free < g.min) {
    console.log(`Holding payouts: only ${xnt(g.free)} gas left (need ${xnt(g.min)}); the next sale will refill it.`);
    return;
  }

  // A payment to a wallet that doesn't exist yet must cover its rent-exempt minimum.
  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const payable: [string, bigint][] = [];
  for (let i = 0; i < due.length; i += 100) {
    const chunk = due.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map(([o]) => new PublicKey(o)));
    chunk.forEach(([o, v], j) => { if (infos[j] || v >= rentMin) payable.push([o, v]); });
  }
  const per = cfg.distribution.transfersPerTx;
  const batches: Batch[] = [];
  for (let i = 0; i < payable.length; i += per) {
    batches.push({ status: "unsent", payments: payable.slice(i, i + per).map(([o, v]) => [o, v.toString()]) });
  }
  const sum = payable.reduce((a, [, v]) => a + v, 0n);
  console.log(`Payouts due: ${payable.length} holders, ${xnt(sum)} in ${batches.length} transaction(s)`);
  if (!ctx.execute || batches.length === 0) return;
  s.pending = { createdAt: new Date().toISOString(), batches };
  saveState(s);
}

async function sendPayouts(ctx: Ctx, s: State) {
  if (!s.pending || !ctx.execute) return;
  const { conn, distributor, cfg } = ctx;
  for (const b of s.pending.batches) {
    if (b.status !== "unsent") continue;
    const ixs = b.payments.map(([owner, lamports]) => SystemProgram.transfer({
      fromPubkey: distributor.publicKey, toPubkey: new PublicKey(owner), lamports: BigInt(lamports),
    }));
    const signed = await sign(conn, withPriority(ixs, cfg.distribution.priorityMicroLamports), distributor);
    await simulate(conn, signed.tx);
    b.status = "sent"; b.signature = signed.signature; b.lastValidBlockHeight = signed.lastValidBlockHeight;
    saveState(s); // journal before broadcasting
    try {
      await sendAndConfirm(conn, signed);
    } catch (e) {
      console.error(`Batch send error: ${e instanceof Error ? e.message : e}`);
      if (!(await resolvePending(ctx, s))) throw new Error("Payout batch unresolved; rerun later to reconcile.");
      if ((b.status as Batch["status"]) === "unsent") throw new Error("Payout batch did not land; rerun to retry.");
      continue;
    }
    settle(s, b);
    record(s, "payout", `${b.payments.length} holders`, signed.signature);
    saveState(s);
  }
  if (s.pending.batches.every((b) => b.status === "confirmed")) { s.pending = null; saveState(s); }
}

async function cycle(ctx: Ctx) {
  const s = loadState(ctx.mint.toBase58());
  ctx.projected = { tokens: 0n, xnt: 0n };
  console.log(`\n=== Reflection cycle ${new Date().toISOString()} (${ctx.execute ? "EXECUTE" : "dry run"}) ===`);
  if (!(await resolvePending(ctx, s))) return;
  if ((await reconcile(ctx, s)) === "wait") return;
  if ((await reconcileRoot(ctx, s)) === "wait") return;
  await sendPayouts(ctx, s); // finish a plan interrupted mid-way before collecting more
  if (s.pending) return;
  const g = await gas(ctx, s);
  if (g.free < g.min) {
    console.log(`Distributor has ${xnt(g.free)} free for fees, below minGasXnt (${xnt(g.min)}). `
      + `Send it at least ${xnt(g.reserve)} once: ${ctx.distributor.publicKey.toBase58()}. `
      + `After that, sale proceeds keep it topped up automatically.`);
    if (ctx.execute) return;
  }
  await harvest(ctx, s);
  await burnTax(ctx, s);
  await balanceLp(ctx, s);
  await sell(ctx, s);
  try {
    await autoLp(ctx, s);
  } catch (e) {
    if (s.inflight) throw e; // unresolved deposit: stop until it is reconciled
    console.error(`Auto-LP skipped this cycle: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await creatorReward(ctx, s);
  } catch (e) {
    if (s.inflight) throw e;
    console.error(`Creator reward skipped this cycle: ${e instanceof Error ? e.message : e}`);
  }
  await allocateNew(ctx, s);
  await planPayouts(ctx, s);
  await sendPayouts(ctx, s);
  await publishRoot(ctx, s);
}

async function main() {
  const cfg = loadConfig();
  const conn = connection(cfg);
  const mint = requireMint(cfg);
  const distributor = loadKeypair(cfg.keypairs.distributor);
  const decimals = unpackMint(mint, await conn.getAccountInfo(mint), TOKEN_2022_PROGRAM_ID).decimals;
  const args = process.argv.slice(2);
  const valued = new Set(["--loop", "--clicker"]);
  const unknown = args.filter((a, i) => a !== "--execute" && !valued.has(a) && !valued.has(args[i - 1]));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Use --execute, --loop <minutes>, --clicker <wallet>.`);
  const clickerIdx = args.indexOf("--clicker");
  const clicker = clickerIdx >= 0 ? new PublicKey(args[clickerIdx + 1]) : undefined;
  const execute = args.includes("--execute");
  const loopIdx = process.argv.indexOf("--loop");
  const loopMinutes = loopIdx > 0 ? Number(process.argv[loopIdx + 1]) : 0;
  if (loopIdx > 0 && !(loopMinutes >= 1)) throw new Error("--loop needs a number of minutes >= 1");
  const ctx: Ctx = { cfg, conn, mint, distributor, execute, decimals, projected: { tokens: 0n, xnt: 0n }, clicker };

  // The lock is held only while a cycle runs, so a holder-triggered run ("Distribute
  // now") can happen between scheduled cycles without the two ever overlapping.
  let release = () => {};
  const stop = () => { release(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  for (;;) {
    try {
      if (execute) {
        try { release = acquireLock(); } catch (e) {
          if (!loopMinutes) throw e;
          console.log(`Skipping this cycle: ${e instanceof Error ? e.message : e}`);
          await new Promise((r) => setTimeout(r, loopMinutes * 60_000));
          continue;
        }
      }
      await cycle(ctx);
    } catch (e) {
      console.error(`Cycle failed: ${e instanceof Error ? e.message : e}`);
      if (!loopMinutes) { release(); throw e; }
    } finally {
      release();
      release = () => {};
    }
    if (!loopMinutes) break;
    await new Promise((r) => setTimeout(r, loopMinutes * 60_000));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
