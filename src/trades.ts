/**
 * Holder cost basis from on-chain trades, for the leaderboard.
 *
 * Every swap that changes a wallet's balance of the token is read once and kept in
 * `<stateDir>/trades.json`; later refreshes only read newer transactions. Swaps are found
 * through the token's mint, which every transfer of it names, so a buy routed through
 * another pool (e.g. a TOKEN/JACK pool someone created, XNT -> JACK -> TOKEN) counts too;
 * the price is the signer's own XNT change. An index built from the main pool only
 * (version 1) is completed from the mint's whole history, a few hundred transactions per
 * refresh (the public RPC's rate limit). For each swap the signer's token change
 * and XNT change are taken from the transaction's own balance records (network fee, and
 * the rent of a token account opened by the swap, are added back so they don't count as
 * price). Liquidity moves (deposit, withdraw, pool creation) aren't trades and are
 * skipped, and so are the pool and the token's distributor (its tax sales).
 *
 * Positions use the average-cost method: a buy adds its XNT to the cost; a sell removes
 * cost in proportion to the tokens sold and books realized profit.
 *
 * A token paired with JACK is priced in JACK instead: each trade's `xnt` field then holds
 * the signer's JACK change (the leaderboard labels it), since a JACK/XNT price at the time
 * of each old trade isn't available.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

export interface Trade { sig: string; at: number; wallet: string; tokens: string; xnt: string }
interface Index {
  version: 1 | 2; newest: string | null; trades: Trade[]; since?: number;
  /** Version 2: reading the mint's older history still to do (newest first); null when done. */
  backfill?: { before: string | null } | null;
}

const ACCOUNT_RENT = 2_039_280n; // a token account opened during the swap: account cost, not price
const MAX_NEW_PER_REFRESH = 3_000;
/** Older transactions read per refresh while backfilling, and per batch (with a pause between batches). */
const BACKFILL_PER_REFRESH = 400;
const BATCH = 25, BATCH_PAUSE_MS = 1_200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const indexFile = (stateDir: string) => path.join(stateDir, "trades.json");
function loadIndex(stateDir: string): Index {
  const f = indexFile(stateDir);
  // A new index reads the whole history once (backfill), newest first.
  if (!fs.existsSync(f)) return { version: 2, newest: null, trades: [], backfill: { before: null } };
  const idx = JSON.parse(fs.readFileSync(f, "utf8")) as Index;
  // Version 1 read only the main pool: keep its trades and complete them from the mint's history.
  if (idx.version !== 2) { idx.version = 2; idx.backfill = { before: null }; }
  return idx;
}

/**
 * The signer's token and XNT change in one swap, or null if it isn't a swap. With a
 * `quoteMint` other than XNT (JACK) the second amount is the signer's JACK change.
 */
export function parseSwap(tx: VersionedTransactionResponse, mint: string, quoteMint?: string): Omit<Trade, "sig" | "at"> | null {
  if (!tx.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages ?? [];
  if (!logs.some((l) => /Instruction: Swap(BaseInput|BaseOutput)/.test(l))) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const wallet = keys.get(0)!.toBase58();
  const sum = (arr: typeof tx.meta.preTokenBalances, m: string) =>
    (arr ?? []).filter((b) => b.owner === wallet && b.mint === m).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const tokens = sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  if (tokens === 0n) return null;
  if (quoteMint && quoteMint !== NATIVE_MINT.toBase58()) {
    const quote = sum(tx.meta.postTokenBalances, quoteMint) - sum(tx.meta.preTokenBalances, quoteMint);
    // No JACK moved: routed through another pool in the same transaction, so the price is
    // unknown; leave it out (those tokens count as "cost unknown").
    if (quote === 0n) return null;
    return { wallet, tokens: tokens.toString(), xnt: quote.toString() };
  }
  // XNT: lamports (plus any wrapped XNT) changed, ignoring the network fee and rent for
  // token accounts the swap opened for this wallet.
  let xnt = BigInt(tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee)
    + sum(tx.meta.postTokenBalances, NATIVE_MINT.toBase58()) - sum(tx.meta.preTokenBalances, NATIVE_MINT.toBase58());
  const before = new Set((tx.meta.preTokenBalances ?? []).filter((b) => b.owner === wallet).map((b) => b.accountIndex));
  for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === wallet && !before.has(b.accountIndex) && b.mint !== NATIVE_MINT.toBase58()) xnt += ACCOUNT_RENT;
  return { wallet, tokens: tokens.toString(), xnt: xnt.toString() };
}

/** Parse `sigs` (unknown ones only) as swaps of `mint` into the index, in paced batches. */
async function addSwaps(conn: Connection, idx: Index, sigs: string[], mint: string, quoteMint?: string) {
  const known = new Set(idx.trades.map((t) => t.sig));
  const todo = sigs.filter((x) => !known.has(x));
  for (let i = 0; i < todo.length; i += BATCH) {
    if (i) await sleep(BATCH_PAUSE_MS);
    const batch = todo.slice(i, i + BATCH);
    const txs = await conn.getTransactions(batch, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    txs.forEach((tx, j) => {
      const t = tx && parseSwap(tx, mint, quoteMint);
      if (t) idx.trades.push({ sig: batch[j], at: tx!.blockTime ?? 0, ...t });
    });
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
  const known = new Set(idx.trades.map((t) => t.sig));
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
  /** Tokens still held from buys, and what they cost (average-cost method). */
  held: bigint; cost: bigint; realized: bigint; trades: number; firstAt: number; lastAt: number;
}

/** Each wallet's position from its trades, in order. */
export function positions(trades: Trade[], skip: Set<string>) {
  const out = new Map<string, Position>();
  for (const t of trades) {
    if (skip.has(t.wallet)) continue;
    const p = out.get(t.wallet) ?? { wallet: t.wallet, bought: 0n, spent: 0n, sold: 0n, received: 0n, held: 0n, cost: 0n, realized: 0n, trades: 0, firstAt: t.at, lastAt: t.at };
    const tokens = BigInt(t.tokens), xnt = BigInt(t.xnt);
    if (tokens > 0n) { // buy
      const paid = xnt < 0n ? -xnt : 0n;
      p.bought += tokens; p.spent += paid; p.held += tokens; p.cost += paid;
    } else { // sell
      const out = -tokens, got = xnt > 0n ? xnt : 0n;
      p.sold += out; p.received += got;
      const fromBuys = out > p.held ? p.held : out; // tokens sold beyond what was bought came from transfers (no known cost)
      const removed = p.held > 0n ? (p.cost * fromBuys) / p.held : 0n;
      p.realized += (fromBuys === out ? got : (got * fromBuys) / out) - removed;
      p.held -= fromBuys; p.cost -= removed;
    }
    p.trades++; p.lastAt = t.at;
    out.set(t.wallet, p);
  }
  return out;
}
