/**
 * Server side of browser-wallet transactions: build an unsigned transaction for a
 * wallet address (co-signed only by throwaway keys such as a new mint), simulate it,
 * and later broadcast the bytes the wallet signed. The server never holds the
 * wallet's key.
 */
import crypto from "node:crypto";
import { confirmByPolling, fitComputeLimit } from "../tx.js";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";

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
  opts: { microLamports: number; units?: number; noBudget?: boolean; simulate?: boolean; tables?: AddressLookupTableAccount[] } = { microLamports: 10_000 },
) {
  // noBudget: leave out the priority-fee instructions to free space (receipt NFT metadata).
  let all = opts.noBudget ? ixs : [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units ?? 400_000 }),
    ...ixs,
  ];
  // X1 bills the requested compute units: ask for what this uses (a transaction that counts
  // on an earlier one of its batch can't be measured yet and keeps the caller's limit).
  if (!opts.noBudget && opts.simulate !== false) all = await fitComputeLimit(conn, all, payer, opts.tables);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  if (opts.tables?.length) {
    // v0: accounts come from address lookup tables (wallets that follow Wallet Standard sign these as-is).
    if (extra.length) throw new Error("A v0 transaction here takes no extra signers");
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message(opts.tables));
    for (const ix of ixs) RELAY_PROGRAMS.add(ix.programId.toBase58());
    const sim0 = opts.simulate === false ? null : await conn.simulateTransaction(v0, { sigVerify: false, commitment: "confirmed" });
    if (sim0?.value.err) {
      const logs = (sim0.value.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ");
      throw new Error(`Simulation failed: ${JSON.stringify(sim0.value.err)}${logs ? ` — ${logs}` : ""}`);
    }
    const raw = Buffer.from(v0.serialize());
    if (raw.length > 1232) throw new Error(`Transaction too large (${raw.length} bytes)`);
    return raw.toString("base64");
  }
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  tx.add(...all);
  for (const ix of ixs) RELAY_PROGRAMS.add(ix.programId.toBase58());
  if (extra.length) tx.partialSign(...extra);
  // Catch problems before asking the wallet to approve anything. (simulate: false for a
  // transaction that counts on an earlier one of the same batch landing first.)
  const sim = opts.simulate === false ? null : await conn.simulateTransaction(tx);
  if (sim?.value.err) {
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
  const all = opts.noBudget ? ixs : await fitComputeLimit(conn, [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.units ?? 400_000 }),
    ...ixs,
  ], payer);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...all);
  const { value } = await conn.getFeeForMessage(tx.compileMessage(), "confirmed");
  return BigInt(value ?? 0);
}

/** Broadcast a wallet-signed transaction and wait for confirmation. */
/** Whether serialized transaction bytes are a versioned (v0) transaction: its message starts with the high bit set. */
const isVersioned = (raw: Buffer) => raw.length > 1 + raw[0] * 64 && (raw[1 + raw[0] * 64] & 0x80) !== 0;

export async function sendSigned(conn: Connection, b64: string) {
  const raw = Buffer.from(b64, "base64");
  if (isVersioned(raw)) {
    const v0 = VersionedTransaction.deserialize(raw);
    const msg = v0.message;
    const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures);
    const body = msg.serialize();
    const ed25519 = (k: PublicKey) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), k.toBuffer()]), format: "der", type: "spki" });
    if (!signers.every((k, i) => v0.signatures[i] && crypto.verify(null, body, ed25519(k), v0.signatures[i]))) throw new Error("Transaction is not fully signed");
    // Programs are always static keys (never from a lookup table).
    const other = msg.compiledInstructions.map((ix) => msg.staticAccountKeys[ix.programIdIndex]).find((p) => !p || !RELAY_PROGRAMS.has(p.toBase58()));
    if (other !== undefined) throw new Error(`This site only sends its own transactions (unexpected program ${other?.toBase58() ?? "from a lookup table"})`);
    const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
    await confirmByPolling(conn, raw, signature, (await conn.getBlockHeight("confirmed")) + 150);
    return signature;
  }
  const tx = Transaction.from(raw);
  if (!tx.verifySignatures()) throw new Error("Transaction is not fully signed");
  const other = tx.instructions.find((ix) => !RELAY_PROGRAMS.has(ix.programId.toBase58()));
  if (other) throw new Error(`This site only sends its own transactions (unexpected program ${other.programId.toBase58()})`);
  const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
  await confirmByPolling(conn, raw, signature, tx.lastValidBlockHeight ?? (await conn.getBlockHeight()) + 150);
  return signature;
}
