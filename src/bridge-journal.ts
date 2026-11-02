/**
 * Whether a bridge transfer journaled by scripts/bridge-usdc.ts or scripts/bridge-stock.ts, whose transaction shows no
 * status, may be marked failed, which releases the next transfer. A wrong "failed" repeats a bridge, so it takes:
 *
 *   - proof from src/send-fate.ts on finalized state: the blockhash has expired, and the wallet's history covers the
 *     time it was sent and doesn't contain it; and
 *   - the bridge's outgoing-event account for its sequence, which the same instruction creates as it takes the tokens,
 *     absent on a read at least as recent as that proof. Samples of those accounts from months back still exist on both
 *     chains (read 2026-11-02), but nothing guarantees they stay, which is why this isn't enough by itself.
 *
 * Otherwise the transfer stays pending and blocks the next, however long that takes. Print the reason: a person
 * resolves it. An entry journaled without these fields is never marked failed this way.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { fateOfSend } from "./send-fate.js";

export interface BridgeSend { signature: string; createdAt: string; lastValidBlockHeight?: number; outgoing?: string }
export type BridgeFate = { kind: "landed" } | { kind: "failed" } | { kind: "never-landed" } | { kind: "wait"; reason: string };

export async function bridgeSendFate(conn: Connection, e: BridgeSend, wallet: PublicKey): Promise<BridgeFate> {
  if (e.lastValidBlockHeight === undefined || !e.outgoing) return { kind: "wait", reason: "journaled without its block height or outgoing account" };
  const f = await fateOfSend(conn, { signature: e.signature, lastValidBlockHeight: e.lastValidBlockHeight, wallet, sentAt: Date.parse(e.createdAt) });
  if (f.fate === "landed" || f.fate === "failed") return f.finalized ? { kind: f.fate } : { kind: "wait", reason: `${f.fate}, not yet finalized` };
  if (f.fate !== "never-landed") return { kind: "wait", reason: f.reason };
  try {
    const marker = await conn.getAccountInfoAndContext(new PublicKey(e.outgoing), { commitment: "finalized", minContextSlot: f.provenAt });
    if (marker.context.slot < f.provenAt) return { kind: "wait", reason: `the node read for the outgoing account is behind (slot ${marker.context.slot} < ${f.provenAt})` };
    if (marker.value) return { kind: "wait", reason: `the outgoing account ${e.outgoing} exists, so the tokens were taken, though the transaction can't be found` };
    return { kind: "never-landed" };
  } catch (err) {
    return { kind: "wait", reason: (err instanceof Error ? err.message : String(err)).split("\n")[0] };
  }
}
