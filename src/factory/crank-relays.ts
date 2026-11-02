/**
 * "Run the vault now" transactions: which token each planned transaction belongs to, and the
 * signatures /api/send relayed for them. crank-result only reads those from the chain, so it
 * can't be asked to look up any number of others.
 *
 * A plan is recognised by what it does (fee payer, blockhash and its instructions), so two
 * tokens' plans with the same payer and blockhash stay apart and an unrelated transaction
 * doesn't pass for one. Instructions a wallet may add or change (priority fees, a Lighthouse
 * guard: the ones RELAY_PROGRAMS lets through for that reason) don't count.
 */
import crypto from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";

const WALLET_PROGRAMS = new Set(["ComputeBudget111111111111111111111111111111", "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"]);
const PLAN_MS = 600_000;

/** The identity of a serialized transaction, or null if it can't be read. */
export function planIdentity(b64: string) {
  try {
    const msg = VersionedTransaction.deserialize(Buffer.from(b64, "base64")).message;
    const keys = msg.staticAccountKeys;
    const ixs = msg.compiledInstructions.map((ix) => {
      // A lookup table's accounts can't be named here; a plan never uses them.
      const accounts = ix.accountKeyIndexes.map((i) => keys[i]?.toBase58());
      const program = keys[ix.programIdIndex]?.toBase58();
      if (!program || accounts.some((a) => !a)) throw new Error("not a plan");
      return { program, accounts, data: Buffer.from(ix.data).toString("base64") };
    }).filter((ix) => !WALLET_PROGRAMS.has(ix.program));
    return crypto.createHash("sha256").update(JSON.stringify([keys[0]?.toBase58(), msg.recentBlockhash, ixs])).digest("hex");
  } catch { return null; }
}

export function crankRelayBook() {
  const plans = new Map<string, { at: number; mint: string }>();
  const relays = new Map<string, { at: number; mint: string }>();
  return {
    /** Remember a planned transaction of `mint`. */
    planned(b64: string, mint: string) {
      const id = planIdentity(b64);
      if (id) plans.set(id, { at: Date.now(), mint });
    },
    /** /api/send relayed this transaction: if it's a planned one, its signature can be looked up. */
    relayed(b64: string, signature: string) {
      const id = planIdentity(b64);
      const plan = id ? plans.get(id) : null;
      if (plan) relays.set(signature, { at: Date.now(), mint: plan.mint });
    },
    /** Of these signatures, the ones relayed for `mint`; each is only given out once. */
    take(signatures: string[], mint: string) {
      const sigs = signatures.filter((sig) => relays.get(sig)?.mint === mint);
      for (const sig of sigs) relays.delete(sig);
      return sigs;
    },
    prune() {
      const now = Date.now();
      for (const [k, p] of plans) if (now - p.at > PLAN_MS) plans.delete(k);
      for (const [k, p] of relays) if (now - p.at > PLAN_MS) relays.delete(k);
    },
  };
}
