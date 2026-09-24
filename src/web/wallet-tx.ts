/**
 * Server side of browser-wallet transactions: build an unsigned transaction for a
 * wallet address (co-signed only by throwaway keys such as a new mint), simulate it,
 * and later broadcast the bytes the wallet signed. The server never holds the
 * wallet's key.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

/**
 * Programs a relayed transaction may call: the basics wallets and our builders use, plus
 * every program in a transaction this server built (XDEX, the locker, ...). Stops
 * /api/send being used as a free relay onto our RPC for anything else.
 */
const RELAY_PROGRAMS = new Set([
  "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95", // Lighthouse (wallet-added guard)
]);

/** Allow a program in relayed transactions before any transaction for it is built (e.g. after a restart). */
export const allowRelayProgram = (id: string) => void RELAY_PROGRAMS.add(id);

export async function unsignedTx(
  conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], extra: Keypair[] = [],
  opts: { microLamports: number; units?: number; noBudget?: boolean } = { microLamports: 10_000 },
) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  // noBudget: leave out the priority-fee instructions to free space (receipt NFT metadata).
  if (!opts.noBudget) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units ?? 400_000 }),
    );
  }
  tx.add(...ixs);
  for (const ix of ixs) RELAY_PROGRAMS.add(ix.programId.toBase58());
  if (extra.length) tx.partialSign(...extra);
  // Catch problems before asking the wallet to approve anything.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ");
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ""}`);
  }
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > 1232) throw new Error(`Transaction too large (${bytes.length} bytes)`);
  return bytes.toString("base64");
}

/**
 * What the network will charge for these instructions (base + priority + X1's per-transaction
 * extras), from the RPC's own fee quote. X1 charges far more than the Solana base fee for
 * busier transactions (e.g. ~0.004 XNT to collect LP fees), so show it before asking.
 */
export async function networkFee(
  conn: Connection, payer: PublicKey, ixs: TransactionInstruction[],
  opts: { microLamports: number; units?: number; noBudget?: boolean } = { microLamports: 10_000 },
) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  if (!opts.noBudget) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units ?? 400_000 }),
    );
  }
  tx.add(...ixs);
  const { value } = await conn.getFeeForMessage(tx.compileMessage(), "confirmed");
  return BigInt(value ?? 0);
}

/** Broadcast a wallet-signed transaction and wait for confirmation. */
export async function sendSigned(conn: Connection, b64: string) {
  const raw = Buffer.from(b64, "base64");
  const tx = Transaction.from(raw);
  if (!tx.verifySignatures()) throw new Error("Transaction is not fully signed");
  const other = tx.instructions.find((ix) => !RELAY_PROGRAMS.has(ix.programId.toBase58()));
  if (other) throw new Error(`This site only sends its own transactions (unexpected program ${other.programId.toBase58()})`);
  const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
  const res = await conn.confirmTransaction(
    { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight ?? (await conn.getBlockHeight()) + 150 },
    "confirmed");
  if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}
