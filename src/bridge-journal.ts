/**
 * When a bridge transfer journaled by scripts/bridge-usdc.ts or scripts/bridge-stock.ts may be marked failed
 * although its transaction was never seen: only once its blockhash has expired (the chain's block height is past
 * the journaled `lastValidBlockHeight`, so it can never land) AND nothing was debited (the bridge's outgoing-event
 * account for its sequence, which the same instruction creates as it takes the tokens, doesn't exist). A transfer
 * journaled before these fields were recorded is never marked failed this way: check it by hand.
 */
export interface BridgeSendSeen {
  /** The signature has a status on chain (landed, failed or not). */
  landed: boolean;
  /** The chain's current block height ("confirmed"). */
  blockHeight: number;
  /** The transfer took the tokens (its outgoing-event account exists); true when that can't be checked. */
  debited: boolean;
}

export function bridgeSendNeverLanded(e: { lastValidBlockHeight?: number }, seen: BridgeSendSeen): boolean {
  if (typeof e.lastValidBlockHeight !== "number") return false;
  return !seen.landed && seen.blockHeight > e.lastValidBlockHeight && !seen.debited;
}
