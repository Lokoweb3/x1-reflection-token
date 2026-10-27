/**
 * Journaling a trade before it is sent (the peg keeper and limit buys, src/peg.ts and src/limit.ts), so a crash or a
 * confirmation that times out can't make the bot forget a trade that landed (and spend its budget twice) or count one
 * that didn't.
 *
 * The caller writes its intent to its state file, then sends inside `whenSigned(hook, ...)`: the engine's send
 * (src/arb-engine.ts) calls `signed(signature, lastValidBlockHeight)` after signing and before broadcasting, so the
 * hook can add the signature to the journaled intent. A later check settles a leftover intent with `settleIntent`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "@solana/web3.js";
import { outcome, type TxOutcome } from "./tx.js";

type Hook = (signature: string, lastValidBlockHeight: number) => void;
const hooks = new AsyncLocalStorage<Hook>();

/** Run `send` with `hook` told each transaction's signature before it is broadcast. */
export const whenSigned = <T>(hook: Hook, send: () => Promise<T>) => hooks.run(hook, send);
/** Called by a sender after signing and before broadcasting. */
export const signed = (signature: string, lastValidBlockHeight: number) => hooks.getStore()?.(signature, lastValidBlockHeight);

export interface Intent { signature?: string; lastValidBlockHeight?: number }

/**
 * What became of a journaled intent: "landed" (count it), "dropped" (it never went out, or failed or expired:
 * forget it) or "pending" (still in flight: don't trade again yet). An intent without a signature was never
 * broadcast: the signature is journaled before the broadcast.
 */
export function intentVerdict(i: Intent, o: TxOutcome | null): "landed" | "dropped" | "pending" {
  if (!i.signature || i.lastValidBlockHeight === undefined) return "dropped";
  if (o === "confirmed") return "landed";
  if (o === "failed" || o === "expired") return "dropped";
  return "pending";
}

export async function settleIntent(conn: Connection, i: Intent) {
  if (!i.signature || i.lastValidBlockHeight === undefined) return intentVerdict(i, null);
  return intentVerdict(i, await outcome(conn, i.signature, i.lastValidBlockHeight));
}
