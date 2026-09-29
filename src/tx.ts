import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

export interface Signed {
  tx: Transaction;
  signature: string;
  lastValidBlockHeight: number;
}

export function withPriority(ixs: TransactionInstruction[], microLamports: number, units?: number) {
  const budget = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  if (units) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  return [...budget, ...ixs];
}

/** Compute units a limit leaves above what the simulation used (state can move before it lands). */
const LIMIT_HEADROOM = 1.2;
const LIMIT_EXTRA = 3_000;
const MAX_UNITS = 1_400_000;
const isLimit = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;
const isBudget = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);

/**
 * X1 charges for the compute units a transaction *requests* (about 0.01 XNT per million,
 * used or not, for anything beyond a plain transfer), so a generous limit costs real XNT.
 * When `ixs` carry compute-budget instructions, simulate them and set the limit to what
 * they use plus headroom (never above the limit asked for). Unchanged if the simulation
 * fails (the caller's own simulation then reports why) or there's no budget instruction.
 */
export async function fitComputeLimit(conn: Connection, ixs: TransactionInstruction[], payer: PublicKey): Promise<TransactionInstruction[]> {
  if (!ixs.some(isBudget)) return ixs;
  const asked = ixs.filter(isLimit).map((ix) => ix.data.readUInt32LE(1))[0] ?? MAX_UNITS;
  const probe = [...ixs.filter((ix) => !isLimit(ix)), ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_UNITS })];
  try {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: probe }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const used = sim.value.unitsConsumed;
    if (sim.value.err || !used) return ixs;
    const units = Math.min(asked, MAX_UNITS, Math.ceil(used * LIMIT_HEADROOM) + LIMIT_EXTRA);
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units });
    // Keep the budget instructions first, where the caller put them.
    const out = ixs.filter((ix) => !isLimit(ix));
    const at = out.findIndex((ix) => !isBudget(ix));
    out.splice(at < 0 ? out.length : at, 0, limit);
    return out;
  } catch {
    return ixs;
  }
}

/** Build and sign without sending, so the caller can journal the signature first. */
export async function sign(conn: Connection, ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[] = []): Promise<Signed> {
  ixs = await fitComputeLimit(conn, ixs, payer.publicKey);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(payer, ...extra);
  return { tx, signature: bs58.encode(tx.signature!), lastValidBlockHeight };
}

export async function simulate(conn: Connection, tx: Transaction) {
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  }
  return sim.value;
}

/** Send a signed transaction and wait until it is confirmed or its blockhash expires. */
export async function sendAndConfirm(conn: Connection, s: Signed): Promise<void> {
  const raw = s.tx.serialize();
  await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
  await confirmByPolling(conn, raw, s.signature, s.lastValidBlockHeight);
}

/**
 * Wait for `signature` by polling its status over HTTP (public RPCs often refuse the
 * websocket that confirmTransaction relies on), re-sending the transaction now and then
 * until it confirms, fails, or its blockhash expires.
 */
export async function confirmByPolling(conn: Connection, raw: Buffer | Uint8Array, signature: string, lastValidBlockHeight: number) {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; ; i++) {
    await sleep(1500);
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    if (i % 4 === 3) {
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error(`Transaction ${signature} expired before it confirmed`);
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }
}

export async function run(conn: Connection, ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[] = []) {
  const s = await sign(conn, ixs, payer, extra);
  await simulate(conn, s.tx);
  await sendAndConfirm(conn, s);
  return s.signature;
}

export type TxOutcome = "confirmed" | "failed" | "expired" | "pending";

/** Resolve what happened to a previously journaled signature. */
export async function outcome(conn: Connection, signature: string, lastValidBlockHeight: number): Promise<TxOutcome> {
  const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (st) {
    if (st.err) return "failed";
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return "confirmed";
    return "pending";
  }
  const height = await conn.getBlockHeight("confirmed");
  return height > lastValidBlockHeight ? "expired" : "pending";
}
