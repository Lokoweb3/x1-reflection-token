/**
 * A Squads v4 multisig as a Tax Vault's publisher (docs/tax-vault-spec.md "Publisher quorum"):
 * the vault's `publisher` is the multisig's vault PDA (index 0), so `publish_list` only runs
 * once a quorum approved it. This module reads the multisig, its proposals and vault
 * transactions, and builds the instructions the site crank, scripts/cosigner.ts and
 * scripts/setup-publisher-quorum.ts send, all through the official SDK (@sqds/multisig)
 * with X1's program id passed explicitly (the SDK's default is Solana's).
 */
import crypto from "node:crypto";
import * as squads from "@sqds/multisig";
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, type AccountInfo } from "@solana/web3.js";

/** Squads v4 on X1: testnet's own deployment, mainnet the official one. */
export const SQUADS_PROGRAM_IDS = {
  testnet: new PublicKey("DDL3Xp6ie85DXgiPkXJ7abUyS2tGv4CGEod2DeQXQ941"),
  mainnet: new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"),
} as const;
/** The multisig vault that is the publisher. */
export const PUBLISHER_VAULT_INDEX = 0;
export const { Permission, Permissions } = squads.types;

export const squadsVaultPda = (program: PublicKey, ms: PublicKey, index = PUBLISHER_VAULT_INDEX) =>
  squads.getVaultPda({ multisigPda: ms, index, programId: program })[0];
export const squadsMultisigPda = (program: PublicKey, createKey: PublicKey) => squads.getMultisigPda({ createKey, programId: program })[0];
export const squadsProposalPda = (program: PublicKey, ms: PublicKey, index: bigint) =>
  squads.getProposalPda({ multisigPda: ms, transactionIndex: index, programId: program })[0];
export const squadsTransactionPda = (program: PublicKey, ms: PublicKey, index: bigint) =>
  squads.getTransactionPda({ multisigPda: ms, index, programId: program })[0];
export const squadsProgramConfigPda = (program: PublicKey) => squads.getProgramConfigPda({ programId: program })[0];

const big = (x: unknown) => BigInt(String(x));
const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const has = (data: Buffer, d: number[]) => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from(d));

// ---------- the multisig ----------
export interface QuorumMember { key: string; initiate: boolean; vote: boolean; execute: boolean }
export interface Quorum {
  program: PublicKey;
  multisig: PublicKey;
  /** The publisher: the multisig's vault PDA, index 0. */
  vault: PublicKey;
  threshold: number;
  members: QuorumMember[];
  /** Members with the vote permission (the threshold counts these). */
  voters: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  /** null: autonomous (changes need the multisig itself). */
  configAuthority: PublicKey | null;
  timeLock: number;
  rentCollector: PublicKey | null;
}
export function decodeQuorum(program: PublicKey, ms: PublicKey, info: AccountInfo<Buffer> | null): Quorum | null {
  if (!info || !info.owner.equals(program) || !has(info.data, squads.generated.multisigDiscriminator)) return null;
  const [m] = squads.accounts.Multisig.fromAccountInfo(info);
  const members = m.members.map((x) => ({
    key: x.key.toBase58(), initiate: Permissions.has(x.permissions, Permission.Initiate),
    vote: Permissions.has(x.permissions, Permission.Vote), execute: Permissions.has(x.permissions, Permission.Execute),
  }));
  return {
    program, multisig: ms, vault: squadsVaultPda(program, ms), threshold: m.threshold, members, voters: members.filter((x) => x.vote).length,
    transactionIndex: big(m.transactionIndex), staleTransactionIndex: big(m.staleTransactionIndex),
    configAuthority: m.configAuthority.equals(PublicKey.default) ? null : m.configAuthority, timeLock: m.timeLock,
    rentCollector: m.rentCollector ?? null,
  };
}
export async function readQuorum(conn: Connection, program: PublicKey, ms: PublicKey) {
  return decodeQuorum(program, ms, await conn.getAccountInfo(ms, "confirmed"));
}
export const memberOf = (q: Quorum, key: PublicKey) => q.members.find((m) => m.key === key.toBase58()) ?? null;
/** "2 of 3" and the members for the pages. */
export const quorumJson = (q: Quorum) => ({
  program: q.program.toBase58(), multisig: q.multisig.toBase58(), vault: q.vault.toBase58(), threshold: q.threshold, voters: q.voters,
  members: q.members, autonomous: !q.configAuthority, timeLock: q.timeLock,
});

// ---------- proposals ----------
export type ProposalStatus = "Draft" | "Active" | "Rejected" | "Approved" | "Executing" | "Executed" | "Cancelled";
export interface ProposalInfo {
  index: bigint;
  address: PublicKey;
  status: ProposalStatus;
  /** Unix seconds of the status change (none for Executing). */
  at: number | null;
  approved: string[];
  rejected: string[];
  cancelled: string[];
}
export function decodeProposal(program: PublicKey, ms: PublicKey, index: bigint, info: AccountInfo<Buffer> | null): ProposalInfo | null {
  if (!info || !info.owner.equals(program) || !has(info.data, squads.generated.proposalDiscriminator)) return null;
  const [p] = squads.accounts.Proposal.fromAccountInfo(info);
  if (!p.multisig.equals(ms) || big(p.transactionIndex) !== index) return null;
  const st = p.status as { __kind: ProposalStatus; timestamp?: unknown };
  return {
    index, address: squadsProposalPda(program, ms, index), status: st.__kind, at: st.timestamp !== undefined ? Number(big(st.timestamp)) : null,
    approved: p.approved.map((k) => k.toBase58()), rejected: p.rejected.map((k) => k.toBase58()), cancelled: p.cancelled.map((k) => k.toBase58()),
  };
}
export async function readProposal(conn: Connection, program: PublicKey, ms: PublicKey, index: bigint) {
  return decodeProposal(program, ms, index, await conn.getAccountInfo(squadsProposalPda(program, ms, index), "confirmed"));
}
/** Rejections that close a proposal: voters − threshold + 1 (Squads' cutoff). */
export const rejectCutoff = (q: Pick<Quorum, "voters" | "threshold">) => q.voters - q.threshold + 1;

// ---------- vault transactions ----------
/** A stored vault transaction, decoded (the message as the multisig will execute it). */
export interface VaultTx {
  index: bigint;
  creator: PublicKey;
  vaultIndex: number;
  ephemeralSigners: number;
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: PublicKey[];
  instructions: { programIdIndex: number; accountIndexes: number[]; data: Buffer }[];
  lookups: number;
}
export function decodeVaultTx(program: PublicKey, ms: PublicKey, index: bigint, info: AccountInfo<Buffer> | null): VaultTx | null {
  if (!info || !info.owner.equals(program) || !has(info.data, squads.generated.vaultTransactionDiscriminator)) return null;
  const [t] = squads.accounts.VaultTransaction.fromAccountInfo(info);
  if (!t.multisig.equals(ms) || big(t.index) !== index) return null;
  const m = t.message;
  return {
    index, creator: t.creator, vaultIndex: t.vaultIndex, ephemeralSigners: t.ephemeralSignerBumps.length,
    numSigners: m.numSigners, numWritableSigners: m.numWritableSigners, numWritableNonSigners: m.numWritableNonSigners,
    accountKeys: m.accountKeys, lookups: m.addressTableLookups.length,
    instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: [...i.accountIndexes], data: Buffer.from(i.data) })),
  };
}
export async function readVaultTx(conn: Connection, program: PublicKey, ms: PublicKey, index: bigint) {
  return decodeVaultTx(program, ms, index, await conn.getAccountInfo(squadsTransactionPda(program, ms, index), "confirmed"));
}

// ---------- instructions ----------
/**
 * Propose `ix` (to run with the multisig's vault PDA as signer) as transaction `index`, and
 * approve it as `member`: vault_transaction_create, proposal_create, proposal_approve.
 */
export function proposeIxs(program: PublicKey, ms: PublicKey, index: bigint, member: PublicKey, ix: TransactionInstruction, memo?: string) {
  const message = new TransactionMessage({ payerKey: squadsVaultPda(program, ms), recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] });
  return [
    squads.instructions.vaultTransactionCreate({ multisigPda: ms, transactionIndex: index, creator: member, vaultIndex: PUBLISHER_VAULT_INDEX, ephemeralSigners: 0,
      transactionMessage: message, memo, programId: program }),
    squads.instructions.proposalCreate({ multisigPda: ms, transactionIndex: index, creator: member, programId: program }),
    squads.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member, programId: program }),
  ];
}
export const approveIx = (program: PublicKey, ms: PublicKey, index: bigint, member: PublicKey, memo?: string) =>
  squads.instructions.proposalApprove({ multisigPda: ms, transactionIndex: index, member, memo, programId: program });
/** A rejection vote; `memo` (the reason) is kept in the transaction for anyone to read. */
export const rejectIx = (program: PublicKey, ms: PublicKey, index: bigint, member: PublicKey, memo?: string) =>
  squads.instructions.proposalReject({ multisigPda: ms, transactionIndex: index, member, memo: memo?.slice(0, 400), programId: program });
/** vault_transaction_execute of an Approved proposal (reads the stored message for its accounts). */
export async function executeIx(conn: Connection, program: PublicKey, ms: PublicKey, index: bigint, member: PublicKey) {
  const { instruction, lookupTableAccounts } = await squads.instructions.vaultTransactionExecute({ connection: conn, multisigPda: ms, transactionIndex: index, member, programId: program });
  if (lookupTableAccounts.length) throw new Error("vault transactions with lookup tables aren't used here");
  return instruction;
}
/** Close a finished (executed / rejected / cancelled / stale) proposal and its transaction; rent to the rent collector. */
export const closeIx = (program: PublicKey, ms: PublicKey, index: bigint, rentCollector: PublicKey) =>
  squads.instructions.vaultTransactionAccountsClose({ multisigPda: ms, transactionIndex: index, rentCollector, programId: program });

/** multisig_create_v2: `threshold` of `members`, no config authority (autonomous), no time lock. */
export async function createMultisigIx(conn: Connection, program: PublicKey, a: {
  creator: PublicKey; createKey: PublicKey; threshold: number; members: { key: PublicKey; permissions: Permission[] }[]; rentCollector: PublicKey | null;
}) {
  const configPda = squadsProgramConfigPda(program);
  const info = await conn.getAccountInfo(configPda, "confirmed");
  if (!info) throw new Error(`Squads program config ${configPda.toBase58()} not found (is ${program.toBase58()} Squads v4?)`);
  const [config] = squads.accounts.ProgramConfig.fromAccountInfo(info);
  return squads.instructions.multisigCreateV2({
    treasury: config.treasury, creator: a.creator, createKey: a.createKey, multisigPda: squadsMultisigPda(program, a.createKey),
    configAuthority: null, threshold: a.threshold, timeLock: 0, rentCollector: a.rentCollector,
    members: a.members.map((m) => ({ key: m.key, permissions: Permissions.fromPermissions(m.permissions) })), programId: program,
  });
}
export type Permission = (typeof Permission)[keyof typeof Permission];

// ---------- reading votes back ----------
const REJECT_DISC = disc("global:proposal_reject");
const APPROVE_DISC = disc("global:proposal_approve");
/** The memo of a proposal_approve / proposal_reject instruction's data (ProposalVoteArgs: Option<String>). */
export function voteMemo(data: Buffer): { vote: "approve" | "reject"; memo: string | null } | null {
  const vote = data.subarray(0, 8).equals(REJECT_DISC) ? "reject" : data.subarray(0, 8).equals(APPROVE_DISC) ? "approve" : null;
  if (!vote) return null;
  if (data.length < 9 || data[8] !== 1) return { vote, memo: null };
  const len = data.readUInt32LE(9);
  return { vote, memo: data.subarray(13, 13 + len).toString("utf8") };
}
/**
 * The votes cast on a proposal with their memos (a co-signer puts its reason there), newest
 * first, read from the proposal account's recent transactions.
 */
export async function proposalVotes(conn: Connection, program: PublicKey, ms: PublicKey, index: bigint, limit = 10) {
  const pda = squadsProposalPda(program, ms, index);
  const sigs = await conn.getSignaturesForAddress(pda, { limit }, "confirmed");
  const out: { signature: string; member: string; vote: "approve" | "reject"; memo: string | null }[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!tx) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    for (const ci of tx.transaction.message.compiledInstructions) {
      if (!keys.get(ci.programIdIndex)?.equals(program)) continue;
      const v = voteMemo(Buffer.from(ci.data));
      // proposal_approve / proposal_reject accounts: multisig, member, proposal.
      if (v && keys.get(ci.accountKeyIndexes[2])?.equals(pda)) out.push({ signature: s.signature, member: keys.get(ci.accountKeyIndexes[1])!.toBase58(), ...v });
    }
  }
  return out;
}
