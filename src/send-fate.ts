/**
 * What became of a transaction we may have broadcast, when a mistake means spending or sending money twice.
 *
 * "No status, and the block height is past its blockhash" is not proof it never landed: a load-balanced RPC can answer
 * each question from a different node, and a node with limited history finds nothing. `fateOfSend` says "never-landed"
 * only when, on finalized state:
 *
 *   1. the finalized block height (at finalized slot S) is past the blockhash, so it can't land from here on;
 *   2. a node at slot S or later has no status for the signature; and
 *   3. the wallet's own signature list, from a node at slot S or later, does not contain it AND reaches back past the
 *      time it was sent (so that node's history covers every block it could have landed in).
 *
 * Anything short of that is "unknown": keep treating the send as if it may have landed. A person may have to decide;
 * callers must offer a way to do that.
 */
import type { Connection, PublicKey } from "@solana/web3.js";

export type SendFate =
  | { fate: "landed"; finalized: boolean }
  | { fate: "failed"; finalized: boolean }
  /** Seen but not yet confirmed, or its blockhash can still land. */
  | { fate: "in-flight"; reason: string }
  /** `provenAt`: the finalized slot the proof holds at, for any further read that must be at least this recent. */
  | { fate: "never-landed"; provenAt: number }
  | { fate: "unknown"; reason: string };

export interface SentTx {
  signature: string;
  lastValidBlockHeight?: number;
  /** The wallet that signed it. */
  wallet: PublicKey;
  /** Milliseconds: at or before signing. Older than the transaction can be. */
  sentAt: number;
}

/** Allowance for this machine's clock against block times. */
export const CLOCK_SKEW_MS = 120_000;
const PAGE = 1_000, PAGES = 5;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

export async function fateOfSend(conn: Connection, s: SentTx): Promise<SendFate> {
  try {
    const first = (await conn.getSignatureStatuses([s.signature], { searchTransactionHistory: true })).value[0];
    if (first) {
      const finalized = first.confirmationStatus === "finalized";
      if (finalized || first.confirmationStatus === "confirmed") return first.err ? { fate: "failed", finalized } : { fate: "landed", finalized };
      return { fate: "in-flight", reason: "seen, not yet confirmed" };
    }
    if (s.lastValidBlockHeight === undefined) return { fate: "unknown", reason: "journaled without its block height" };
    if (!Number.isFinite(s.sentAt)) return { fate: "unknown", reason: "journaled without a usable send time" };

    const slot = await conn.getSlot("finalized");
    const height = await conn.getBlockHeight({ commitment: "finalized", minContextSlot: slot });
    if (height <= s.lastValidBlockHeight) return { fate: "in-flight", reason: "its blockhash isn't expired on finalized state yet" };

    const status = await conn.getSignatureStatuses([s.signature], { searchTransactionHistory: true });
    if (status.value[0]) return { fate: "in-flight", reason: "seen by another node" };
    if (status.context.slot < slot) return { fate: "unknown", reason: `the node answering for its status is behind (slot ${status.context.slot} < ${slot})` };

    let before: string | undefined;
    for (let page = 0; page < PAGES; page++) {
      const list = await conn.getSignaturesForAddress(s.wallet, { limit: PAGE, minContextSlot: slot, ...(before ? { before } : {}) }, "finalized");
      const hit = list.find((x) => x.signature === s.signature);
      if (hit) return hit.err ? { fate: "failed", finalized: true } : { fate: "landed", finalized: true };
      const oldest = list.at(-1);
      if (oldest && typeof oldest.blockTime === "number" && oldest.blockTime * 1000 < s.sentAt - CLOCK_SKEW_MS) return { fate: "never-landed", provenAt: slot };
      if (!oldest || list.length < PAGE) return { fate: "unknown", reason: "the wallet's history on this node stops short of when it was sent" };
      before = oldest.signature;
    }
    return { fate: "unknown", reason: `the wallet's last ${PAGE * PAGES} transactions don't reach back to when it was sent` };
  } catch (e) {
    return { fate: "unknown", reason: msg(e) };
  }
}
