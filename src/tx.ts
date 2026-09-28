import {
  ComputeBudgetProgram, Connection, Keypair, Transaction, TransactionInstruction,
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

/** Build and sign without sending, so the caller can journal the signature first. */
export async function sign(conn: Connection, ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[] = []): Promise<Signed> {
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
