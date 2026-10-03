/**
 * Holder cost basis from on-chain trades, for the leaderboard.
 *
 * Every transaction that changes a wallet's balance of the token is read once and kept in
 * `<stateDir>/trades.json`; later refreshes only read newer transactions. They're found
 * through the token's mint, which every transfer of it names, so a buy routed through
 * another pool (e.g. a TOKEN/JACK pool someone created, XNT -> JACK -> TOKEN) counts too;
 * the price is the signer's own XNT change. For each swap the signer's token change and
 * XNT change are taken from the transaction's own balance records (network fee, and the
 * rent of accounts opened by the swap, are added back so they don't count as price). A
 * swap paid or settled in another token (no XNT moved) is "unpriced", and a limit-order
 * fill ("order") shows no payment either: both are valued at the token's market price at
 * the time (the nearest priced swaps), marked as estimated. Every other balance change is
 * kept too, without a price: transfers ("move") and liquidity deposits and withdrawals
 * ("lp"), so tokens that leave a wallet take their share of its cost with them and tokens
 * that arrive have no known cost. The pool and the token's distributor (its tax sales) are
 * skipped when positions are built.
 *
 * Positions use the average-cost method: a buy adds its XNT to the cost; tokens leaving (a
 * sale or a move) remove cost in proportion, and a sale books realized profit on the part
 * with a known cost.
 *
 * A token paired with JACK is priced in JACK instead: each trade's `xnt` field then holds
 * the signer's JACK change (the leaderboard labels it), since a JACK/XNT price at the time
 * of each old trade isn't available.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

export interface Trade {
  sig: string; at: number; wallet: string; tokens: string; xnt: string;
  /**
   * Absent: a swap priced by `xnt`. "unpriced": a swap paid or settled in another token.
   * "order": the signer collecting a filled limit order. "move": tokens moved without a
   * trade (a transfer). "lp": into or out of a pool's liquidity. Only swaps carry an `xnt` amount.
   */
  kind?: "unpriced" | "order" | "move" | "lp";
  /** Read by an older version; replaced when its transaction is read again. */
  legacy?: true;
}
interface Index {
  version: 1 | 2 | 3 | 4; newest: string | null; trades: Trade[]; since?: number;
  /** Reading the mint's older history still to do (newest first); null when done. */
  backfill?: { before: string | null } | null;
}

const ACCOUNT_RENT = 2_039_280n; // a plain token account, when the opened account's balance isn't in the record
const MAX_NEW_PER_REFRESH = 3_000;
/** Older transactions read per refresh while backfilling, and per batch (with a pause between batches). */
const BACKFILL_PER_REFRESH = 400;
const BATCH = 25, BATCH_PAUSE_MS = 1_200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const indexFile = (stateDir: string) => path.join(stateDir, "trades.json");
function loadIndex(stateDir: string): Index {
  const f = indexFile(stateDir);
  // A new index reads the whole history once (backfill), newest first.
  if (!fs.existsSync(f)) return { version: 4, newest: null, trades: [], backfill: { before: null } };
  const idx = JSON.parse(fs.readFileSync(f, "utf8")) as Index;
  // Versions 1 and 2 kept swaps only, and 3 didn't tell order fills from transfers: read the
  // whole history again. The old entries stay (marked legacy) until their transactions are
  // read again, and for good if the RPC no longer has them.
  if (idx.version !== 4) {
    idx.version = 4; idx.newest = null; idx.backfill = { before: null }; delete idx.since;
    for (const t of idx.trades) t.legacy = true;
  }
  return idx;
}

const LP_LOG = /^Program log: Instruction: (Deposit|Withdraw|Initialize)$/;
const ORDER_LOG = /^Program log: Instruction: WithdrawOrderTokens$/;

/**
 * The signer's token and XNT change in one swap, or null if it isn't a swap. With a
 * `quoteMint` other than XNT (JACK) the second amount is the signer's JACK change. A swap
 * paid or settled in another token comes back "unpriced" (its `xnt` is 0).
 */
export function parseSwap(tx: VersionedTransactionResponse, mint: string, quoteMint?: string): Omit<Trade, "sig" | "at"> | null {
  if (!tx.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages ?? [];
  if (!logs.some((l) => /Instruction: Swap(BaseInput|BaseOutput)/.test(l))) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const wallet = keys.get(0)!.toBase58();
  const sum = (arr: typeof tx.meta.preTokenBalances, m: string) =>
    (arr ?? []).filter((b) => b.owner === wallet && b.mint === m).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const change = (m: string) => sum(tx.meta!.postTokenBalances, m) - sum(tx.meta!.preTokenBalances, m);
  const tokens = change(mint);
  if (tokens === 0n) return null;
  const unpriced = { wallet, tokens: tokens.toString(), xnt: "0", kind: "unpriced" as const };
  if (quoteMint && quoteMint !== NATIVE_MINT.toBase58()) {
    const quote = change(quoteMint);
    // No JACK moved: routed through another pool in the same transaction, so the price is unknown.
    if (quote === 0n) return unpriced;
    return { wallet, tokens: tokens.toString(), xnt: quote.toString() };
  }
  // Paid with (or sold for) another token the wallet holds: no XNT price.
  const otherMints = new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
    .filter((b) => b.owner === wallet && b.mint !== mint && b.mint !== NATIVE_MINT.toBase58()).map((b) => b.mint));
  for (const m of otherMints) if (change(m) !== 0n) return unpriced;
  // XNT: lamports (plus any wrapped XNT) changed, ignoring the network fee and the rent of
  // token accounts the swap opened for this wallet (their own balance: a Token-2022 account
  // with extensions costs more than a plain one).
  let xnt = BigInt(tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee) + change(NATIVE_MINT.toBase58());
  const before = new Set((tx.meta.preTokenBalances ?? []).filter((b) => b.owner === wallet).map((b) => b.accountIndex));
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner !== wallet || before.has(b.accountIndex) || b.mint === NATIVE_MINT.toBase58()) continue;
    const rent = tx.meta.postBalances[b.accountIndex];
    xnt += rent ? BigInt(rent) : ACCOUNT_RENT;
  }
  // A buy that didn't cost XNT, or a sale that didn't pay any: the price is elsewhere.
  if ((tokens > 0n && xnt >= 0n) || (tokens < 0n && xnt <= 0n)) return unpriced;
  return { wallet, tokens: tokens.toString(), xnt: xnt.toString() };
}

/**
 * Every wallet's token change in one transaction: the signer's swap (priced or not), and
 * any other change as a move ("lp" for the signer's own liquidity deposit or withdrawal,
 * "order" for tokens the signer collects from a filled limit order).
 */
export function parseTx(tx: VersionedTransactionResponse, mint: string, quoteMint?: string): Omit<Trade, "sig" | "at">[] {
  if (!tx.meta || tx.meta.err) return [];
  const change = new Map<string, bigint>();
  for (const [arr, sign] of [[tx.meta.postTokenBalances, 1n], [tx.meta.preTokenBalances, -1n]] as const) {
    for (const b of arr ?? []) if (b.mint === mint && b.owner) change.set(b.owner, (change.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  }
  const swap = parseSwap(tx, mint, quoteMint);
  const signer = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).get(0)!.toBase58();
  const logs = tx.meta.logMessages ?? [];
  const lp = logs.some((l) => LP_LOG.test(l)), order = logs.some((l) => ORDER_LOG.test(l));
  const out: Omit<Trade, "sig" | "at">[] = swap ? [swap] : [];
  for (const [wallet, tokens] of change) {
    if (tokens === 0n || (swap && wallet === swap.wallet)) continue;
    const kind = wallet !== signer ? "move" : lp ? "lp" : order && tokens > 0n ? "order" : "move";
    out.push({ wallet, tokens: tokens.toString(), xnt: "0", kind });
  }
  return out;
}

/** Parse `sigs` (unknown ones only) into the index, in paced batches; a read replaces its legacy entries. */
async function addSwaps(conn: Connection, idx: Index, sigs: string[], mint: string, quoteMint?: string) {
  const known = new Set(idx.trades.filter((t) => !t.legacy).map((t) => t.sig));
  const todo = sigs.filter((x) => !known.has(x));
  for (let i = 0; i < todo.length; i += BATCH) {
    if (i) await sleep(BATCH_PAUSE_MS);
    const batch = todo.slice(i, i + BATCH);
    const txs = await conn.getTransactions(batch, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const read = new Set<string>();
    const add: Trade[] = [];
    txs.forEach((tx, j) => {
      if (!tx) return;
      read.add(batch[j]);
      for (const t of parseTx(tx, mint, quoteMint)) add.push({ sig: batch[j], at: tx.blockTime ?? 0, ...t });
    });
    idx.trades = idx.trades.filter((t) => !(t.legacy && read.has(t.sig))).concat(add);
  }
}

/**
 * Read swaps newer than the last refresh (found through the token's `mint`) and add them to
 * the index; while a backfill is due, also read the next stretch of older history.
 */
export async function refreshTrades(conn: Connection, mint: string, stateDir: string, quoteMint?: string) {
  const idx = loadIndex(stateDir);
  const mintKey = new PublicKey(mint);
  const fresh: { signature: string; blockTime?: number | null; err: unknown }[] = [];
  // RPCs can drop old history, so the last-seen signature can vanish; then `until` fails and
  // we page back without it, stopping at a signature already seen.
  let until = idx.newest ?? undefined;
  const known = new Set(idx.trades.filter((t) => !t.legacy).map((t) => t.sig));
  let before: string | undefined;
  // Without a `newest` yet, the backfill reads everything: just take the newest signature.
  const limit = idx.newest ? 1000 : 1;
  while (fresh.length < MAX_NEW_PER_REFRESH) {
    let page: typeof fresh;
    try {
      page = await conn.getSignaturesForAddress(mintKey, { limit, before, until }, "confirmed");
    } catch (e) {
      if (!until || !/not found/i.test(String(e))) throw e;
      until = undefined;
      continue;
    }
    const seenOld = page.findIndex((x) => x.signature === idx.newest || known.has(x.signature));
    fresh.push(...(seenOld < 0 ? page : page.slice(0, seenOld)));
    if (!idx.newest || page.length < 1000 || seenOld >= 0) break;
    before = page.at(-1)!.signature;
  }
  if (fresh.length) {
    await addSwaps(conn, idx, fresh.filter((x) => !x.err).map((x) => x.signature), mint, quoteMint);
    idx.newest = fresh[0].signature;
  }
  // Older history, a stretch per refresh (newest first), until it runs out.
  if (idx.backfill) {
    const page = await conn.getSignaturesForAddress(mintKey, { limit: BACKFILL_PER_REFRESH, before: idx.backfill.before ?? undefined }, "confirmed");
    await addSwaps(conn, idx, page.filter((x) => !x.err).map((x) => x.signature), mint, quoteMint);
    idx.backfill = page.length < BACKFILL_PER_REFRESH ? null : { before: page.at(-1)!.signature };
  }
  // While older history is still being read, `since` is how far back the trades go so far.
  idx.since = idx.backfill ? (idx.since ?? Math.floor(Date.now() / 1000)) : 0;
  idx.trades.sort((a, b) => a.at - b.at || a.sig.localeCompare(b.sig));
  if (idx.trades.length && idx.since && idx.trades[0].at < idx.since) idx.since = idx.trades[0].at;
  saveIndex(stateDir, idx);
  return idx;
}
function saveIndex(stateDir: string, idx: Index) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(indexFile(stateDir), JSON.stringify(idx));
}

export interface Position {
  wallet: string; bought: bigint; spent: bigint; sold: bigint; received: bigint;
  /** Tokens from buys with a known or estimated price (what `spent` paid for). */
  boughtPriced: bigint;
  /** Parts of `spent` and `received` valued at the market price (paid in another token, or a limit order). */
  spentEstimated: bigint; receivedEstimated: bigint;
  /** Tokens still held from buys with a known or estimated price, and what they cost (average-cost method). */
  held: bigint; cost: bigint;
  /** Tokens still held with no known cost: transferred in, from the LP, or bought when no market price was near. */
  unknown: bigint;
  /** Tokens moved out without a sale: to other wallets, and into liquidity (`lpOut`). */
  movedOut: bigint; lpOut: bigint;
  /** Cost that left with tokens moved out or sold without a price (no XNT came back for it). */
  movedCost: bigint;
  realized: bigint; trades: number; firstAt: number | null; lastAt: number | null;
}

/** How far the nearest priced swap may be from a trade to value it at the market price. */
const ESTIMATE_WITHIN_S = 24 * 3600;

/**
 * The market price (XNT per base unit) near `at`: the nearest priced swap on the same side
 * (buys and sells differ by the tax), else on either side; null when none is close enough.
 */
function marketPrice(swaps: { at: number; buy: boolean; price: number }[], at: number, buy: boolean) {
  const nearest = (same: boolean) => {
    let best: { at: number; price: number } | null = null;
    for (const s of swaps) if ((!same || s.buy === buy) && (!best || Math.abs(s.at - at) < Math.abs(best.at - at))) best = s;
    return best && Math.abs(best.at - at) <= ESTIMATE_WITHIN_S ? best.price : null;
  };
  return nearest(true) ?? nearest(false);
}

/** Each wallet's position from its trades and moves, in order. */
export function positions(trades: Trade[], skip: Set<string>) {
  // A swap with its XNT on the right side has a price; an older entry without one was paid
  // or settled in another token.
  const isPriced = (t: Trade) => t.kind === undefined && (BigInt(t.tokens) > 0n ? BigInt(t.xnt) < 0n : BigInt(t.xnt) > 0n);
  const swaps = trades.filter(isPriced).map((t) => {
    const tokens = BigInt(t.tokens), xnt = BigInt(t.xnt);
    return { at: t.at, buy: tokens > 0n, price: Math.abs(Number(xnt) / Number(tokens)) };
  });
  const out = new Map<string, Position>();
  for (const t of trades) {
    if (skip.has(t.wallet)) continue;
    const p = out.get(t.wallet) ?? { wallet: t.wallet, bought: 0n, boughtPriced: 0n, spent: 0n, sold: 0n, received: 0n, spentEstimated: 0n, receivedEstimated: 0n,
      held: 0n, cost: 0n, unknown: 0n, movedOut: 0n, lpOut: 0n, movedCost: 0n, realized: 0n, trades: 0, firstAt: null, lastAt: null };
    out.set(t.wallet, p);
    const tokens = BigInt(t.tokens);
    const trade = t.kind === undefined || t.kind === "unpriced" || t.kind === "order";
    // XNT paid (negative) or received; for a trade without one, its value at the market price.
    let xnt: bigint | null = isPriced(t) ? BigInt(t.xnt) : null, estimated = false;
    if (xnt === null && trade) {
      const price = marketPrice(swaps, t.at, tokens > 0n);
      if (price !== null) { xnt = BigInt(Math.round(-price * Number(tokens))); estimated = true; } // a buy pays, a sale gets
    }
    if (trade) { p.trades++; p.firstAt ??= t.at; p.lastAt = t.at; }
    if (tokens > 0n) {
      if (trade) p.bought += tokens;
      if (xnt !== null && xnt < 0n) {
        p.spent += -xnt; p.boughtPriced += tokens; p.held += tokens; p.cost += -xnt;
        if (estimated) p.spentEstimated += -xnt;
      } else p.unknown += tokens;
      continue;
    }
    // Tokens leaving take their share of the known-cost and unknown-cost tokens; anything
    // beyond what's tracked (history not read yet) comes from neither.
    const amount = -tokens;
    const total = p.held + p.unknown;
    const tracked = amount < total ? amount : total;
    const fromHeld = total > 0n ? (tracked * p.held) / total : 0n;
    const removed = p.held > 0n ? (p.cost * fromHeld) / p.held : 0n;
    p.held -= fromHeld; p.cost -= removed; p.unknown -= tracked - fromHeld;
    if (trade) p.sold += amount;
    else if (t.kind === "lp") p.lpOut += amount;
    else p.movedOut += amount;
    if (xnt !== null && xnt > 0n) {
      p.received += xnt; p.realized += (xnt * fromHeld) / amount - removed;
      if (estimated) p.receivedEstimated += xnt;
    } else p.movedCost += removed;
  }
  return out;
}
