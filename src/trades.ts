/**
 * Holder cost basis from on-chain trades, for the leaderboard.
 *
 * Every XDEX swap on a token's pool is read once and kept in `<stateDir>/trades.json`;
 * later refreshes only read newer transactions. For each swap the signer's token change
 * and XNT change are taken from the transaction's own balance records (network fee, and
 * the rent of a token account opened by the swap, are added back so they don't count as
 * price). Liquidity moves (deposit, withdraw, pool creation) aren't trades and are
 * skipped, and so are the pool and the token's distributor (its tax sales).
 *
 * Positions use the average-cost method: a buy adds its XNT to the cost; a sell removes
 * cost in proportion to the tokens sold and books realized profit.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";

export interface Trade { sig: string; at: number; wallet: string; tokens: string; xnt: string }
interface Index { version: 1; newest: string | null; trades: Trade[]; since?: number }

const ACCOUNT_RENT = 2_039_280n; // a token account opened during the swap: account cost, not price
const MAX_NEW_PER_REFRESH = 3_000;

const indexFile = (stateDir: string) => path.join(stateDir, "trades.json");
function loadIndex(stateDir: string): Index {
  const f = indexFile(stateDir);
  if (!fs.existsSync(f)) return { version: 1, newest: null, trades: [] };
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

/** The signer's token and XNT change in one swap, or null if it isn't a swap. */
export function parseSwap(tx: VersionedTransactionResponse, mint: string): Omit<Trade, "sig" | "at"> | null {
  if (!tx.meta || tx.meta.err) return null;
  const logs = tx.meta.logMessages ?? [];
  if (!logs.some((l) => /Instruction: Swap(BaseInput|BaseOutput)/.test(l))) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const wallet = keys.get(0)!.toBase58();
  const sum = (arr: typeof tx.meta.preTokenBalances, m: string) =>
    (arr ?? []).filter((b) => b.owner === wallet && b.mint === m).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const tokens = sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  if (tokens === 0n) return null;
  // XNT: lamports (plus any wrapped XNT) changed, ignoring the network fee and rent for
  // token accounts the swap opened for this wallet.
  let xnt = BigInt(tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee)
    + sum(tx.meta.postTokenBalances, NATIVE_MINT.toBase58()) - sum(tx.meta.preTokenBalances, NATIVE_MINT.toBase58());
  const before = new Set((tx.meta.preTokenBalances ?? []).filter((b) => b.owner === wallet).map((b) => b.accountIndex));
  for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === wallet && !before.has(b.accountIndex) && b.mint !== NATIVE_MINT.toBase58()) xnt += ACCOUNT_RENT;
  return { wallet, tokens: tokens.toString(), xnt: xnt.toString() };
}

/** Read swaps newer than the last refresh and add them to the index. */
export async function refreshTrades(conn: Connection, pool: PublicKey, mint: string, stateDir: string) {
  const idx = loadIndex(stateDir);
  const fresh: { signature: string; blockTime?: number | null; err: unknown }[] = [];
  // RPCs drop old history, so the last-seen signature can vanish; then `until` fails and
  // we page back without it, stopping at trades already indexed or older than the last one.
  let until = idx.newest ?? undefined;
  const known = new Set(idx.trades.map((t) => t.sig));
  const lastAt = idx.trades.at(-1)?.at ?? 0;
  let before: string | undefined;
  while (fresh.length < MAX_NEW_PER_REFRESH) {
    let page: typeof fresh;
    try {
      page = await conn.getSignaturesForAddress(pool, { limit: 1000, before, until }, "confirmed");
    } catch (e) {
      if (!until || !/not found/i.test(String(e))) throw e;
      until = undefined;
      continue;
    }
    const seenOld = page.findIndex((s) => s.signature === idx.newest || known.has(s.signature) || (s.blockTime ?? Infinity) < lastAt);
    fresh.push(...(seenOld < 0 ? page : page.slice(0, seenOld)));
    if (page.length < 1000 || seenOld >= 0) break;
    before = page.at(-1)!.signature;
  }
  idx.since ??= Math.floor(Date.now() / 1000) - 86_400; // RPCs keep about a day; older trades can't be read
  if (!fresh.length) { saveIndex(stateDir, idx); return idx; }
  const ok = fresh.filter((s) => !s.err);
  for (let i = 0; i < ok.length; i += 50) {
    const batch = ok.slice(i, i + 50);
    const txs = await conn.getTransactions(batch.map((s) => s.signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    txs.forEach((tx, j) => {
      const t = tx && parseSwap(tx, mint);
      if (t) idx.trades.push({ sig: batch[j].signature, at: tx!.blockTime ?? batch[j].blockTime ?? 0, ...t });
    });
  }
  idx.newest = fresh[0].signature;
  idx.trades.sort((a, b) => a.at - b.at || a.sig.localeCompare(b.sig));
  if (idx.trades.length && idx.trades[0].at < idx.since!) idx.since = idx.trades[0].at;
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
