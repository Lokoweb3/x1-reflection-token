/**
 * What scripts/quorum-action.ts does (see its header): one Squads member acting on the
 * publisher quorum, with what it signs decoded from the chain first. The checks are pure and
 * the commands take their connection from `deps`, so test/quorum-action.test.ts can run them
 * without a validator. Instructions come from src/squads.ts and src/taxvault.ts, fees and
 * sending from src/tx.ts, the paced connection from src/config.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as squads from "@sqds/multisig";
import { Connection, Keypair, PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { connection, type Config } from "./config.js";
import { decodePublishProposal, type PublishArgs } from "./list-verify.js";
import {
  SQUADS_PROGRAM_IDS, PUBLISHER_VAULT_INDEX, approveIx, decodeVaultTx, executeIx, memberOf, proposalVotes, proposeIxs, readProposal, readQuorum, rejectCutoff, rejectIx,
  squadsTransactionPda, squadsVaultPda, type ProposalInfo, type Quorum, type VaultTx,
} from "./squads.js";
import { IX, TAX_VAULT_PROGRAM_ID, cidFromBytes, decodeVault, errorName, setPublisherIx, vaultPda, type Vault } from "./taxvault.js";
import { sendAndConfirm, sign, withPriority, type Signed } from "./tx.js";

export type Network = "testnet" | "mainnet";
/** Read from the public RPCs on 2026-11-02 and 2026-11-03. */
export const GENESIS_HASH: Record<Network, string> = {
  mainnet: "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN",
  testnet: "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho",
};
export const PUBLIC_RPC: Record<Network, string> = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** A memo proposal is a short note; anything longer isn't this tool's shape. */
export const MAX_MEMO_BYTES = 200;
/** Vault indexes of a multisig counted as "its" vault PDAs for --new-publisher. */
const KNOWN_VAULT_INDEXES = 8;
const MICRO_LAMPORTS = 10_000;
/** X1 bills requested CU (docs: .claude x1-notes, eight live transactions): this many lamports per CU, plus a constant. */
const X1_LAMPORTS_PER_CU = 10, X1_BASE_LAMPORTS = 3_001;
/** Upper limits; src/tx.ts shrinks them to what simulation uses plus headroom. */
const UNITS = { propose: 300_000, vote: 60_000, execute: 200_000 };

export const xntOf = (l: bigint | number) => { const n = BigInt(l), s = n < 0n ? "-" : "", a = n < 0n ? -n : n; return `${s}${a / 1_000_000_000n}.${(a % 1_000_000_000n).toString().padStart(9, "0")}`; };
const short = (k: string | PublicKey) => { const s = typeof k === "string" ? k : k.toBase58(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const sha256Hex = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A check said no: printed as REFUSED, exit code 1, nothing sent. */
export class Refusal extends Error {}
const refuse = (m: string): never => { throw new Refusal(m); };

// ---------- arguments ----------
const VALUE_FLAGS = ["network", "rpc", "multisig", "index", "keypair", "text", "mint", "new-publisher", "expect-new-publisher", "expect-memo-hash", "expect-mint", "memo", "squads-program", "program", "limit", "priority"];
const BOOL_FLAGS = ["execute", "allow-local-rpc", "allow-unknown", "allow-off-curve", "help"];
export const SUBCOMMANDS = ["status", "propose-memo", "propose-set-publisher", "approve", "reject", "execute"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];
export interface Parsed { sub: Subcommand | null; values: Map<string, string>; bools: Set<string> }
/**
 * Strict on purpose: an unknown flag, a repeated one or a flag eating the next flag as its
 * value (`--keypair --execute`) is an error, never a silently different action.
 */
export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { sub: null, values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (out.sub) refuse(`unexpected argument "${a}"`);
      if (!SUBCOMMANDS.includes(a as Subcommand)) refuse(`unknown subcommand "${a}" (${SUBCOMMANDS.join(", ")})`);
      out.sub = a as Subcommand;
      continue;
    }
    const name = a.slice(2);
    if (BOOL_FLAGS.includes(name)) { out.bools.add(name); continue; }
    if (!VALUE_FLAGS.includes(name)) refuse(`unknown flag ${a}`);
    if (out.values.has(name)) refuse(`${a} given twice`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) refuse(`${a} needs a value`);
    out.values.set(name, v);
  }
  return out;
}
const pubkeyArg = (a: Parsed, name: string) => {
  const v = a.values.get(name);
  if (v === undefined) return null;
  try { return new PublicKey(v); } catch { return refuse(`--${name} isn't an address: ${v}`); }
};
const needPubkey = (a: Parsed, name: string) => pubkeyArg(a, name) ?? refuse(`--${name} is required`);
function indexArg(a: Parsed, required: boolean): bigint | null {
  const v = a.values.get("index");
  if (v === undefined) return required ? refuse("--index is required") : null;
  if (!/^[1-9]\d*$/.test(v)) refuse(`--index must be a positive whole number, not ${v}`);
  return BigInt(v);
}

// ---------- network ----------
export function isLocalRpc(url: string) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}
/** Why this RPC can't be used for `network` (its genesis hash decides), or null. */
export function genesisProblem(a: { network: Network; genesis: string; rpc: string; allowLocal: boolean }): string | null {
  const other: Network = a.network === "mainnet" ? "testnet" : "mainnet";
  if (a.genesis === GENESIS_HASH[a.network]) return null;
  if (a.genesis === GENESIS_HASH[other]) return `--network ${a.network}, but ${a.rpc} is X1 ${other} (genesis hash ${a.genesis})`;
  if (!a.allowLocal) return `--network ${a.network}, but ${a.rpc} has genesis hash ${a.genesis}, which is neither X1 network (a local validator needs --allow-local-rpc)`;
  if (!isLocalRpc(a.rpc)) return `--allow-local-rpc is only for a validator on this machine, and ${a.rpc} isn't`;
  return null;
}

// ---------- keys ----------
/** The key from --keypair, refusing a file others can read. An unparseable file's content is never echoed (JSON errors quote their input). */
export function loadMemberKey(file: string): Keypair {
  const p = path.resolve(file);
  let mode: number;
  try { mode = fs.statSync(p).mode; } catch { return refuse(`can't read the key file ${p}`); }
  if (mode & 0o077) refuse(`${p} is readable by group or others (mode ${(mode & 0o777).toString(8)}): chmod 600 it first`);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return refuse(`${p} isn't a keypair file (a JSON array of 64 numbers)`); }
  if (!Array.isArray(raw) || raw.length !== 64) return refuse(`${p} isn't a keypair file (a JSON array of 64 numbers)`);
  try { return Keypair.fromSecretKey(Uint8Array.from(raw as number[])); } catch { return refuse(`${p} isn't a valid keypair`); }
}
export type Right = "initiate" | "vote" | "execute";
/** Why `key` can't do this on the multisig, or null. */
export function rightsProblem(q: Pick<Quorum, "members">, key: PublicKey, what: "propose" | "approve" | "reject" | "execute"): string | null {
  const m = q.members.find((x) => x.key === key.toBase58());
  const who = key.toBase58();
  if (!m) return `${who} isn't a member of this multisig (members: ${q.members.map((x) => short(x.key)).join(", ")})`;
  const need: Right[] = what === "propose" ? ["initiate", "vote"] : what === "execute" ? ["execute"] : ["vote"];
  const missing = need.filter((r) => !m[r]);
  if (!missing.length) return null;
  const extra = what === "propose" && missing.includes("vote") ? " (proposing also casts the proposer's approval)" : "";
  return `${who} is a member but has no ${missing.join(" or ")} permission, so it can't ${what}${extra}`;
}

// ---------- the stored transaction ----------
export type Shape =
  | { kind: "memo"; text: string; hash: string }
  | { kind: "set-publisher"; vault: PublicKey; newPublisher: PublicKey }
  /** Described, but this tool doesn't approve it without --allow-unknown (scripts/cosigner.ts is what checks lists). */
  | { kind: "publish-list"; args: PublishArgs }
  | { kind: "unknown"; reason: string };

export function memoText(data: Buffer): string | null {
  if (data.length < 1 || data.length > MAX_MEMO_BYTES) return null;
  const text = data.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(data)) return null; // not valid UTF-8
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text) ? null : text;
}
/**
 * What a stored vault transaction is, strictly: every field that isn't the known shape makes
 * it "unknown". A vault PDA as the only signer (and the payer of the message), vault index
 * 0, no ephemeral signers, no lookup tables, one instruction, exactly the accounts it needs.
 */
export function classifyVaultTx(tx: VaultTx, vaultPdaKey: PublicKey, taxProgram: PublicKey): Shape {
  const unknown = (reason: string): Shape => ({ kind: "unknown", reason });
  if (tx.vaultIndex !== PUBLISHER_VAULT_INDEX) return unknown(`runs from multisig vault ${tx.vaultIndex}, not ${PUBLISHER_VAULT_INDEX}`);
  if (tx.ephemeralSigners !== 0) return unknown("uses ephemeral signers");
  if (tx.lookups !== 0) return unknown("uses address lookup tables");
  if (tx.instructions.length !== 1) return unknown(`has ${tx.instructions.length} instructions`);
  if (tx.numSigners !== 1 || tx.numWritableSigners !== 1) return unknown(`has ${tx.numSigners} signers (${tx.numWritableSigners} writable)`);
  if (!tx.accountKeys[0]?.equals(vaultPdaKey)) return unknown("its signer isn't the multisig's vault PDA");
  const [ix] = tx.instructions;
  const program = tx.accountKeys[ix.programIdIndex];
  if (!program) return unknown("its program index is out of range");
  if (program.equals(MEMO_PROGRAM_ID)) {
    if (tx.accountKeys.length !== 2 || tx.numWritableNonSigners !== 0 || ix.programIdIndex !== 1) return unknown("a memo carrying other accounts");
    if (ix.accountIndexes.length !== 1 || ix.accountIndexes[0] !== 0) return unknown("a memo not signed by exactly the vault PDA");
    const text = memoText(ix.data);
    if (text === null) return unknown(`a memo that isn't short plain text (${ix.data.length} bytes, at most ${MAX_MEMO_BYTES})`);
    return { kind: "memo", text, hash: sha256Hex(ix.data) };
  }
  if (!program.equals(taxProgram)) return unknown(`calls ${program.toBase58()}, neither the memo nor the tax_vault program`);
  if (ix.data.length === 40 && ix.data.subarray(0, 8).equals(IX.setPublisher)) {
    if (tx.accountKeys.length !== 3 || tx.numWritableNonSigners !== 1 || ix.programIdIndex !== 2) return unknown("a set_publisher carrying other accounts");
    if (ix.accountIndexes.length !== 2 || ix.accountIndexes[0] !== 0 || ix.accountIndexes[1] !== 1) return unknown("a set_publisher with other accounts than [vault PDA, vault]");
    return { kind: "set-publisher", vault: tx.accountKeys[1], newPublisher: new PublicKey(ix.data.subarray(8, 40)) };
  }
  try { return { kind: "publish-list", args: decodePublishProposal(tx, taxProgram, vaultPdaKey) }; } catch (e) { return unknown(`a tax_vault call: ${msgOf(e)}`); }
}

/** One line per account of a stored instruction, with the flags the message gives it. */
export function accountsOf(tx: VaultTx, vaultPdaKey: PublicKey) {
  return tx.instructions.flatMap((ix, n) => {
    const name = (i: number) => {
      const k = tx.accountKeys[i];
      if (!k) return `#${i} (out of range)`;
      const signer = i < tx.numSigners;
      const writable = signer ? i < tx.numWritableSigners : i - tx.numSigners < tx.numWritableNonSigners;
      return `${k.toBase58()}${k.equals(vaultPdaKey) ? " (vault PDA)" : ""}${signer ? " signer" : ""}${writable ? " writable" : ""}`;
    };
    return [`instruction ${n + 1} of ${tx.instructions.length}: program ${tx.accountKeys[ix.programIdIndex]?.toBase58() ?? "?"}, ${ix.data.length} bytes of data`,
      ...ix.accountIndexes.map((i) => `  account ${name(i)}`)];
  });
}

export interface Expectations { newPublisher?: PublicKey | null; memoHash?: string | null; mint?: PublicKey | null; allowUnknown?: boolean }
/**
 * The operator's restatement against what is stored: why this can't be approved or executed,
 * or null. A set_publisher always needs the new publisher restated. `vaultMint` is the mint
 * read from the stored vault account (null if it can't be read).
 */
export function expectationProblem(shape: Shape, e: Expectations, vaultMint: PublicKey | null = null): string | null {
  if (shape.kind === "set-publisher") {
    if (e.memoHash) return "--expect-memo-hash was given, but this proposal is a set_publisher, not a memo";
    if (!e.newPublisher) return `this proposal is a set_publisher: restate the new publisher with --expect-new-publisher <pubkey> (it stores ${shape.newPublisher.toBase58()}; check that against what you agreed, not against this line)`;
    if (!e.newPublisher.equals(shape.newPublisher)) return `--expect-new-publisher is ${e.newPublisher.toBase58()}, but the stored instruction sets ${shape.newPublisher.toBase58()}`;
    if (e.mint && (!vaultMint || !e.mint.equals(vaultMint))) return `--expect-mint is ${e.mint.toBase58()}, but the stored instruction's vault is for ${vaultMint?.toBase58() ?? "a mint that can't be read"}`;
    return null;
  }
  if (shape.kind === "memo") {
    if (e.newPublisher) return "--expect-new-publisher was given, but this proposal is a memo, not a set_publisher";
    if (e.mint) return "--expect-mint was given, but this proposal is a memo, not a set_publisher";
    if (e.memoHash && e.memoHash.toLowerCase() !== shape.hash) return `--expect-memo-hash is ${e.memoHash}, but the stored memo hashes to ${shape.hash}`;
    return null;
  }
  if (e.newPublisher || e.memoHash || e.mint) return `an --expect flag was given, but this proposal is ${shape.kind === "publish-list" ? "a publish_list" : "neither a memo nor a set_publisher"}`;
  if (e.allowUnknown) return null;
  return shape.kind === "publish-list"
    ? "this is a rewards list (publish_list), which this tool doesn't check. scripts/cosigner.ts --once with this key checks a list before approving it; --allow-unknown approves it unchecked"
    : `this isn't one of the two known shapes: it ${shape.reason}. --allow-unknown overrides that`;
}

/**
 * A new publisher this tool won't set: the multisig account itself (Squads signs with the
 * vault PDA, so the role would be lost: the classic mix-up), the current publisher, or an
 * off-curve address that isn't one of this multisig's vault PDAs.
 */
export function newPublisherProblem(a: { newPublisher: PublicKey; multisig: PublicKey; program: PublicKey; currentPublisher: PublicKey | null; allowOffCurve: boolean }): string | null {
  if (a.newPublisher.equals(a.multisig)) return `${a.newPublisher.toBase58()} is the multisig account, which can never sign. Squads signs with the vault PDA (${squadsVaultPda(a.program, a.multisig).toBase58()})`;
  if (a.currentPublisher?.equals(a.newPublisher)) return `${a.newPublisher.toBase58()} is already the vault's publisher`;
  if (PublicKey.isOnCurve(a.newPublisher.toBytes()) || a.allowOffCurve) return null;
  for (let i = 0; i < KNOWN_VAULT_INDEXES; i++) if (squadsVaultPda(a.program, a.multisig, i).equals(a.newPublisher)) return null;
  return `${a.newPublisher.toBase58()} is off-curve (no private key can sign for it) and isn't a vault PDA of this multisig. --allow-off-curve overrides that if it really is another program's PDA`;
}

// ---------- reading a transaction back ----------
export type SendFate = "failed" | "ambiguous";
/** A send error that says the transaction didn't take effect ("failed"); anything else may still land. */
export function sendFate(e: unknown): SendFate {
  return /Transaction \S+ failed:|Simulation failed|Transaction simulation failed/.test(msgOf(e)) ? "failed" : "ambiguous";
}
const ANCHOR_ERRORS: Record<number, string> = { 2000: "ConstraintMut", 2001: "ConstraintHasOne", 2002: "ConstraintSigner", 2003: "ConstraintRaw", 2006: "ConstraintSeeds", 3012: "AccountNotInitialized" };
/**
 * Which program refused, from a failed transaction's logs: tax_vault's and Squads' Anchor
 * codes overlap, so the code alone doesn't say. The first "failed" line is the innermost.
 */
export function explainFailure(logs: string[], squadsProgram: PublicKey, taxProgram: PublicKey): string | null {
  for (const l of logs) {
    const m = /^Program (\S+) failed: (.*)$/.exec(l);
    if (!m) continue;
    const code = /custom program error: 0x([0-9a-f]+)/i.exec(m[2]);
    if (!code) return `${m[1]}: ${m[2]}`;
    const n = parseInt(code[1], 16);
    if (m[1] === squadsProgram.toBase58()) { const err = squads.generated.errorFromCode(n); return `Squads: ${err?.name ?? ANCHOR_ERRORS[n] ?? `error ${n}`}`; }
    if (m[1] === taxProgram.toBase58()) return `tax_vault: ${errorName(n) ?? `error ${n}`}`;
    return `${m[1]}: error ${n}`;
  }
  return null;
}

// ---------- the commands ----------
export interface Deps {
  /** The connection for an RPC URL (tests pass a fake one). */
  connect: (rpc: string) => Connection;
  out: (line: string) => void;
}
/** The repo's paced connection. It honours REFLECT_RPC_URL, so run() refuses that when it disagrees with --rpc. */
export const defaultDeps = (): Deps => ({ connect: (rpc) => connection({ rpcUrl: rpc } as Config), out: (l) => console.log(l) });

interface Ctx {
  a: Parsed; deps: Deps; say: (s: string) => void; conn: Connection; network: Network; rpc: string; local: boolean;
  squadsProgram: PublicKey; taxProgram: PublicKey; ms: PublicKey; q: Quorum; execute: boolean; microLamports: number;
}
export const USAGE = `Usage: npx tsx scripts/quorum-action.ts <subcommand> --network testnet|mainnet --multisig <address> [--rpc <url>] [--execute] ...
  status                 [--index n] [--limit 10]                                     (no keypair)
  propose-memo           --keypair <file> [--text <short>]
  propose-set-publisher  --keypair <file> --mint <mint> --new-publisher <pubkey> [--allow-off-curve]
  approve                --keypair <file> --index n [--expect-new-publisher <pubkey>] [--expect-mint <mint>] [--expect-memo-hash <sha256>] [--allow-unknown] [--allow-off-curve]
  reject                 --keypair <file> --index n [--memo <reason>]
  execute                --keypair <file> --index n [--expect-new-publisher <pubkey>] [--expect-mint <mint>] [--expect-memo-hash <sha256>] [--allow-unknown] [--allow-off-curve]
Local validator only: --allow-local-rpc --rpc http://127.0.0.1:<port> [--squads-program <id>]. Testnet or local only: --program <tax_vault id>.
Without --execute nothing is sent: the transaction is built and simulated. See the script's header.`;

async function setup(a: Parsed, deps: Deps): Promise<Ctx> {
  const say = deps.out;
  const net = a.values.get("network");
  if (!net) refuse("--network testnet|mainnet is required (there is no default)");
  if (net !== "testnet" && net !== "mainnet") refuse(`--network is testnet or mainnet, not ${net}`);
  const network = net as Network;
  const allowLocal = a.bools.has("allow-local-rpc");
  const rpc = a.values.get("rpc") ?? PUBLIC_RPC[network];
  if (allowLocal && !isLocalRpc(rpc)) refuse(`--allow-local-rpc is only for a validator on this machine, and ${rpc} isn't`);
  const envRpc = process.env.REFLECT_RPC_URL;
  if (envRpc && envRpc !== rpc) refuse(`REFLECT_RPC_URL is ${envRpc}, which would override ${rpc}: unset it or pass the same URL`);
  const custom = pubkeyArg(a, "squads-program");
  if (custom && !allowLocal) refuse("--squads-program is only for a local validator (--allow-local-rpc): real networks use the program in src/squads.ts");
  const taxArg = pubkeyArg(a, "program");
  if (taxArg && network === "mainnet" && !allowLocal && !taxArg.equals(TAX_VAULT_PROGRAM_ID)) refuse(`--program on mainnet can only be ${TAX_VAULT_PROGRAM_ID.toBase58()}, the deployed tax_vault`);
  const ms = needPubkey(a, "multisig");
  const conn = deps.connect(rpc);
  const genesis = await conn.getGenesisHash();
  const problem = genesisProblem({ network, genesis, rpc, allowLocal });
  if (problem) refuse(problem);
  const squadsProgram = custom ?? SQUADS_PROGRAM_IDS[network];
  const taxProgram = taxArg ?? TAX_VAULT_PROGRAM_ID;
  const q = await readQuorum(conn, squadsProgram, ms);
  if (!q) refuse(`${ms.toBase58()} isn't a Squads multisig of ${squadsProgram.toBase58()} on ${rpc} (the vault PDA is a different address from the multisig)`);
  const micro = Number(a.values.get("priority") ?? MICRO_LAMPORTS);
  if (!Number.isInteger(micro) || micro < 0) refuse("--priority takes whole microlamports per CU");
  say(`network   ${network}${genesis === GENESIS_HASH[network] ? ` (genesis ${genesis} checked)` : `, LOCAL validator ${rpc} (genesis ${genesis})`}, RPC ${rpc}`);
  say(`Squads    ${squadsProgram.toBase58()}${custom ? " (--squads-program)" : ""}, tax_vault ${taxProgram.toBase58()}`);
  return { a, deps, say, conn, network, rpc, local: genesis !== GENESIS_HASH[network], squadsProgram, taxProgram, ms, q: q!, execute: a.bools.has("execute"), microLamports: micro };
}

function printQuorum(c: Ctx) {
  const { q, say } = c;
  say(`multisig  ${q.multisig.toBase58()}`);
  say(`vault PDA ${q.vault.toBase58()}   <- signs vault transactions; this is the publisher`);
  say(`threshold ${q.threshold} of ${q.voters} voters (rejections that close a proposal: ${rejectCutoff(q)}); time lock ${q.timeLock} s`);
  say(`config authority ${q.configAuthority?.toBase58() ?? "none (autonomous)"}; rent collector ${q.rentCollector?.toBase58() ?? "none"}`);
  say(`transaction index ${q.transactionIndex}, stale up to ${q.staleTransactionIndex}`);
  for (const m of q.members) say(`  member ${m.key}  ${[m.initiate && "initiate", m.vote && "vote", m.execute && "execute"].filter(Boolean).join(", ") || "no permissions"}`);
}

/** The stored transaction of a proposal, decoded from the chain. */
export interface Stored { kindName: string; tx: VaultTx | null; shape: Shape; vault: Vault | null; lines: string[] }
async function readStored(c: Ctx, index: bigint): Promise<Stored> {
  const { conn, squadsProgram, ms, q, taxProgram } = c;
  const info = await conn.getAccountInfo(squadsTransactionPda(squadsProgram, ms, index), "confirmed");
  return storedFrom(c, index, info, q, taxProgram);
}
async function storedFrom(c: Ctx, index: bigint, info: AccountInfo<Buffer> | null, q: Quorum, taxProgram: PublicKey): Promise<Stored> {
  const { conn, squadsProgram, ms } = c;
  if (!info) return { kindName: "none", tx: null, vault: null, shape: { kind: "unknown", reason: "has no transaction account (closed, or never created)" }, lines: ["no transaction account (closed, or never created)"] };
  const tx = decodeVaultTx(squadsProgram, ms, index, info);
  if (!tx) {
    const d = info.data.subarray(0, 8);
    const is = (x: number[]) => d.equals(Buffer.from(x));
    const name = is(squads.generated.configTransactionDiscriminator) ? "a config transaction (changes the multisig itself)" : is(squads.generated.batchDiscriminator) ? "a batch" : "not a vault transaction";
    return { kindName: "other", tx: null, vault: null, shape: { kind: "unknown", reason: `is ${name}` }, lines: [`stored: ${name}`] };
  }
  const shape = classifyVaultTx(tx, q.vault, taxProgram);
  const lines: string[] = [];
  let vault: Vault | null = null;
  if (shape.kind === "memo") {
    lines.push(`does: writes a memo, signed by the vault PDA. Moves nothing.`, `  text ${JSON.stringify(shape.text)}`, `  sha256 ${shape.hash}`);
  } else if (shape.kind === "set-publisher") {
    const vi = await conn.getAccountInfo(shape.vault, "confirmed");
    vault = vi?.owner.equals(taxProgram) ? (() => { try { return decodeVault(shape.vault, vi.data); } catch { return null; } })() : null;
    lines.push(`does: tax_vault set_publisher, signed by the vault PDA`, `  vault account     ${shape.vault.toBase58()}${vault ? ` (mint ${vault.mint.toBase58()})` : " (NOT a readable tax_vault vault)"}`,
      `  current publisher ${vault?.publisher.toBase58() ?? "?"}${vault?.publisher.equals(q.vault) ? " (this multisig's vault PDA)" : vault ? " (NOT this multisig's vault PDA: it would fail)" : ""}`,
      `  NEW publisher     ${shape.newPublisher.toBase58()}`);
  } else if (shape.kind === "publish-list") {
    lines.push(`does: tax_vault publish_list (a rewards list), signed by the vault PDA. Not checked by this tool.`,
      `  vault account ${shape.args.vault.toBase58()}; epoch ${shape.args.epoch}; total ${shape.args.total}; root ${shape.args.root.toString("hex")}; list file ${cidFromBytes(shape.args.cid) ?? "none"}`);
  } else {
    lines.push(`does: UNKNOWN: it ${shape.reason}`);
  }
  lines.push(`stored by ${tx.creator.toBase58()}; vault index ${tx.vaultIndex}, ephemeral signers ${tx.ephemeralSigners}, lookup tables ${tx.lookups}`);
  lines.push(...accountsOf(tx, q.vault));
  return { kindName: "vault", tx, shape, vault, lines };
}
const proposalLine = (q: Quorum, p: ProposalInfo | null, index: bigint) => p
  ? `#${index} ${p.status}: ${p.approved.length} of ${q.threshold} approvals, ${p.rejected.length} of ${rejectCutoff(q)} rejections to close${p.cancelled.length ? `, ${p.cancelled.length} cancels` : ""}${index <= q.staleTransactionIndex ? " (stale: a config change passed it)" : ""}`
  : `#${index}: no proposal account (closed, or never created)`;

async function cmdStatus(c: Ctx) {
  const { say, q, conn, squadsProgram, ms, a } = c;
  printQuorum(c);
  const index = indexArg(a, false);
  if (index !== null) {
    const p = await readProposal(conn, squadsProgram, ms, index);
    say(`\n${proposalLine(q, p, index)}`);
    if (p?.at) say(`  status since ${new Date(p.at * 1000).toISOString()}`);
    for (const [name, keys] of [["approved", p?.approved], ["rejected", p?.rejected], ["cancelled", p?.cancelled]] as const) for (const k of keys ?? []) say(`  ${name} by ${k}`);
    const stored = await readStored(c, index);
    for (const l of stored.lines) say(`  ${l}`);
    if (p) {
      const votes = await proposalVotes(conn, squadsProgram, ms, index).catch(() => []);
      for (const v of votes) if (v.memo) say(`  ${v.vote} memo from ${short(v.member)}: ${JSON.stringify(v.memo)}`);
    }
    if (p?.status === "Active") say(`  needs ${q.threshold - p.approved.length} more approval(s), or ${rejectCutoff(q) - p.rejected.length} more rejection(s) to close`);
    return 0;
  }
  const limit = BigInt(Number(a.values.get("limit") ?? 10) || 10);
  say(`\nrecent proposals (newest first):`);
  if (q.transactionIndex === 0n) say("  none yet");
  for (let i = q.transactionIndex; i >= 1n && i > q.transactionIndex - limit; i--) {
    const [p, s] = await Promise.all([readProposal(conn, squadsProgram, ms, i), readStored(c, i)]);
    const what = s.shape.kind === "memo" ? `memo ${JSON.stringify(s.shape.text)}`
      : s.shape.kind === "set-publisher" ? `set_publisher to ${s.shape.newPublisher.toBase58()}`
      : s.shape.kind === "publish-list" ? `list ${s.shape.args.epoch}` : s.kindName === "none" ? "closed" : `unknown (${s.shape.reason})`;
    say(`  ${proposalLine(q, p, i)}; ${what}`);
  }
  return 0;
}

/** Proposals still open that carry a rewards list (an index the site may be tracking). */
async function openLists(c: Ctx, skip: bigint | null = null) {
  const out: bigint[] = [];
  const { q, conn, squadsProgram, ms } = c;
  for (let i = q.transactionIndex; i >= 1n && i > q.transactionIndex - 10n; i--) {
    if (i === skip) continue;
    const p = await readProposal(conn, squadsProgram, ms, i).catch(() => null);
    if (p?.status !== "Active" && p?.status !== "Approved") continue;
    if ((await readStored(c, i)).shape.kind === "publish-list") out.push(i);
  }
  return out;
}

/**
 * Sign, simulate, report, and only with --execute send (once: src/tx.ts may re-broadcast the
 * same signed bytes while it waits, which can't execute twice; nothing here signs a new one).
 * Returns the signature, or null when it stopped at the dry run.
 */
async function deliver(c: Ctx, me: Keypair, what: string, ixs: TransactionInstruction[], units: number): Promise<{ signature: string } | null> {
  const { conn, say, execute, squadsProgram, taxProgram, microLamports } = c;
  const s: Signed = await sign(conn, withPriority(ixs, microLamports, units), me);
  const limitIx = s.tx.instructions.find((ix) => ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111" && ix.data[0] === 2);
  const requested = limitIx ? limitIx.data.readUInt32LE(1) : units;
  const balance = BigInt(await conn.getBalance(me.publicKey, "confirmed"));
  const sim = await conn.simulateTransaction(s.tx, undefined, [me.publicKey]);
  const quote = await conn.getFeeForMessage(s.tx.compileMessage(), "confirmed").then((r) => r.value).catch(() => null);
  const x1Fee = BigInt(requested) * BigInt(X1_LAMPORTS_PER_CU) + BigInt(X1_BASE_LAMPORTS) + BigInt(Math.ceil((microLamports * requested) / 1_000_000));
  say(`\n${execute ? "SENDING" : "DRY RUN"}: ${what}`);
  say(`  signer and fee payer ${me.publicKey.toBase58()}, balance ${xntOf(balance)} XNT`);
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    say(`  simulation FAILED: ${explainFailure(logs, squadsProgram, taxProgram) ?? JSON.stringify(sim.value.err)}`);
    for (const l of logs.slice(-6)) say(`    ${l}`);
    say("  nothing was sent");
    throw new Refusal(`the simulation failed: ${explainFailure(logs, squadsProgram, taxProgram) ?? JSON.stringify(sim.value.err)}`);
  }
  const after = sim.value.accounts?.[0]?.lamports;
  const moved = after === undefined || after === null ? null : balance - BigInt(after);
  say(`  simulation OK: ${sim.value.unitsConsumed ?? "?"} CU used, ${requested} CU requested`);
  say(`  expected fee: RPC quote ${quote === null ? "not available" : `${xntOf(quote)} XNT`}; X1's billing on requested CU would be about ${xntOf(x1Fee)} XNT`);
  if (moved !== null) say(`  simulated balance change ${xntOf(-moved)} XNT (fee plus any rent this transaction pays)`);
  if (!execute) { say("  nothing was sent; add --execute to send it"); return null; }
  say(`  signature ${s.signature}`);
  try {
    await sendAndConfirm(conn, s);
  } catch (e) {
    if (sendFate(e) === "failed") {
      const m = msgOf(e);
      const st = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      throw new Refusal(`the transaction failed on-chain: ${explainFailure(st?.meta?.logMessages ?? [], squadsProgram, taxProgram) ?? m.split("\n")[0]}`);
    }
    throw new Ambiguous(`the send didn't confirm: ${msgOf(e).split("\n")[0]}. It may still land: run \`status --index n\` before anything else. Nothing was or will be resent automatically (signature ${s.signature}).`);
  }
  const now = BigInt(await conn.getBalance(me.publicKey, "confirmed"));
  say(`  confirmed; this key's balance moved ${xntOf(now - balance)} XNT (now ${xntOf(now)})`);
  return { signature: s.signature };
}
/** The send may or may not have landed: exit code 3, no retry. */
export class Ambiguous extends Error {}

const nextSteps = (c: Ctx, index: bigint, expect: string) => {
  const base = `npx tsx scripts/quorum-action.ts`;
  const common = `--network ${c.network}${c.local ? ` --allow-local-rpc --rpc ${c.rpc}` : ""} --multisig ${c.ms.toBase58()} --index ${index} ${expect}`.trimEnd();
  c.say(`\nNext (each member on its own machine, with its own --keypair; dry run first, then --execute):`);
  c.say(`  ${base} approve ${common} --keypair <another member's file>`);
  c.say(`  ${base} execute ${common} --keypair <a member's file>`);
};

async function readbackProposed(c: Ctx, me: Keypair, index: bigint, want: Shape["kind"]) {
  const { conn, squadsProgram, ms, say, q } = c;
  const p = await readProposal(conn, squadsProgram, ms, index);
  say(`\nread back: ${proposalLine(q, p, index)}`);
  if (!p) throw new Ambiguous(`proposal #${index} doesn't read back yet: run status`);
  const s = await readStored(c, index);
  for (const l of s.lines) say(`  ${l}`);
  if (s.shape.kind !== want) throw new Refusal(`the stored transaction reads back as ${s.shape.kind}, not ${want}: don't approve it`);
  if (!p.approved.includes(me.publicKey.toBase58())) say("  note: this key's approval doesn't show yet");
}

async function memberFor(c: Ctx, what: "propose" | "approve" | "reject" | "execute") {
  const file = c.a.values.get("keypair");
  if (!file) refuse("--keypair <file> is required");
  const me = loadMemberKey(file!);
  const problem = rightsProblem(c.q, me.publicKey, what);
  if (problem) refuse(problem);
  c.say(`member    ${me.publicKey.toBase58()}`);
  return me;
}

/**
 * The next index is read once, and the site's crank proposes lists to the same multisig. If
 * another proposal took it first the program refuses this one (its PDA no longer fits): say so
 * rather than show a seeds error. Nothing is retried: the operator runs it again.
 */
async function deliverProposal(c: Ctx, me: Keypair, index: bigint, ixs: TransactionInstruction[]) {
  try {
    return await deliver(c, me, `propose #${index} and approve it as this member`, ixs, UNITS.propose);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    const now = await readQuorum(c.conn, c.squadsProgram, c.ms).catch(() => null);
    if (now && now.transactionIndex >= index) throw new Refusal(`another proposal took #${index} while this one was being built (the site's crank proposes lists too). This one didn't land: run it again`);
    throw e;
  }
}

async function cmdProposeMemo(c: Ctx) {
  const me = await memberFor(c, "propose");
  const { q, say, squadsProgram, ms } = c;
  const text = c.a.values.get("text") ?? `99tax quorum check ${q.vault.toBase58().slice(0, 8)}`;
  if (memoText(Buffer.from(text, "utf8")) === null) refuse(`--text must be 1 to ${MAX_MEMO_BYTES} bytes of plain text`);
  const index = q.transactionIndex + 1n;
  const memo = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: q.vault, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") });
  const hash = sha256Hex(Buffer.from(text, "utf8"));
  say(`\nproposal #${index}: memo ${JSON.stringify(text)} signed by the vault PDA ${q.vault.toBase58()}; moves nothing`);
  say(`  sha256 ${hash}`);
  const sent = await deliverProposal(c, me, index, proposeIxs(squadsProgram, ms, index, me.publicKey, memo));
  const expect = `--expect-memo-hash ${hash}`;
  if (!sent) return 0;
  await readbackProposed(c, me, index, "memo");
  nextSteps(c, index, expect);
  return 0;
}

async function cmdProposeSetPublisher(c: Ctx) {
  const me = await memberFor(c, "propose");
  const { q, say, squadsProgram, ms, conn, taxProgram, a } = c;
  const mint = needPubkey(a, "mint"), newPublisher = needPubkey(a, "new-publisher");
  const addr = vaultPda(taxProgram, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(taxProgram)) refuse(`no Tax Vault for ${mint.toBase58()} under ${taxProgram.toBase58()}`);
  const v = decodeVault(addr, info!.data);
  const problem = newPublisherProblem({ newPublisher, multisig: ms, program: squadsProgram, currentPublisher: v.publisher, allowOffCurve: a.bools.has("allow-off-curve") });
  if (problem) refuse(problem);
  if (!v.publisher.equals(q.vault)) refuse(`the vault's publisher is ${v.publisher.toBase58()}, not this multisig's vault PDA ${q.vault.toBase58()}: this multisig can't change it`);
  if (v.version < 3) refuse(`vault v${v.version} has no set_publisher; the crank upgrades it to v3 first`);
  const index = q.transactionIndex + 1n;
  say(`\nproposal #${index}: tax_vault set_publisher signed by the vault PDA`);
  say(`  mint              ${mint.toBase58()}`);
  say(`  vault account     ${addr.toBase58()}`);
  say(`  current publisher ${v.publisher.toBase58()} (this multisig's vault PDA)`);
  say(`  NEW publisher     ${newPublisher.toBase58()}`);
  await warnAboutMove(c, newPublisher, null);
  const sent = await deliverProposal(c, me, index, proposeIxs(squadsProgram, ms, index, me.publicKey, setPublisherIx(taxProgram, q.vault, mint, newPublisher)));
  if (!sent) return 0;
  await readbackProposed(c, me, index, "set-publisher");
  nextSteps(c, index, `--expect-new-publisher ${newPublisher.toBase58()} --expect-mint ${mint.toBase58()}`);
  return 0;
}

async function warnAboutMove(c: Ctx, newPublisher: PublicKey, self: bigint | null) {
  const { say, conn, q, squadsProgram, ms } = c;
  if (!PublicKey.isOnCurve(newPublisher.toBytes()) && !newPublisher.equals(q.vault)) say(`  note: the new publisher is off-curve; the site only proposes through vault index ${PUBLISHER_VAULT_INDEX} of the configured multisig`);
  if (PublicKey.isOnCurve(newPublisher.toBytes()) && (await conn.getBalance(newPublisher, "confirmed")) === 0) say("  note: the new publisher holds no XNT; whichever key pays its transactions needs some");
  for (const i of await openLists(c, self)) say(`  note: list proposal #${i} is open. Once the publisher moves it can never execute (NotPublisher); it stays on-chain until ${rejectCutoff(q)} members reject it${await readProposal(conn, squadsProgram, ms, i).then((p) => (p?.status === "Approved" ? " (it's Approved, so a threshold of cancels instead, which this tool doesn't send)" : "")).catch(() => "")}`);
}

/** Everything that must hold before this member signs a vote or an execute of proposal `index`. */
async function vetStored(c: Ctx, index: bigint, statusProblem: string | null) {
  const { a, say, q } = c;
  const stored = await readStored(c, index);
  say(`\nstored on-chain for #${index} (decoded from the transaction account):`);
  for (const l of stored.lines) say(`  ${l}`);
  if (statusProblem) refuse(statusProblem);
  const e: Expectations = { newPublisher: pubkeyArg(a, "expect-new-publisher"), memoHash: a.values.get("expect-memo-hash") ?? null, mint: pubkeyArg(a, "expect-mint"), allowUnknown: a.bools.has("allow-unknown") };
  const shape = stored.shape;
  const problem = expectationProblem(shape, e, stored.vault?.mint ?? null);
  if (problem) refuse(problem);
  if (shape.kind === "set-publisher") {
    if (!stored.vault) refuse(`the stored instruction's vault account ${shape.vault.toBase58()} isn't a tax_vault vault of ${c.taxProgram.toBase58()}`);
    if (!stored.vault!.publisher.equals(q.vault)) refuse(`the vault's publisher is ${stored.vault!.publisher.toBase58()}, not this multisig's vault PDA: this can't run`);
    const bad = newPublisherProblem({ newPublisher: shape.newPublisher, multisig: c.ms, program: c.squadsProgram, currentPublisher: stored.vault!.publisher, allowOffCurve: a.bools.has("allow-off-curve") });
    if (bad) refuse(`the stored new publisher: ${bad}`);
    await warnAboutMove(c, shape.newPublisher, index);
  }
  if (shape.kind === "unknown" || shape.kind === "publish-list") {
    say("");
    say("  ************************************************************************");
    say(`  *  WARNING: --allow-unknown. This is ${shape.kind === "publish-list" ? "a rewards list, NOT CHECKED by this tool" : "NOT a known shape"}.`);
    say("  *  You are signing for whatever the lines above say. Read every account.");
    say("  ************************************************************************");
    say("");
  }
  return stored;
}

async function cmdApprove(c: Ctx) {
  const me = await memberFor(c, "approve");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const p = await readProposal(conn, squadsProgram, ms, index);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index}`);
  await vetStored(c, index, p!.status !== "Active" ? `#${index} is ${p!.status}: only an Active proposal takes votes`
    : index <= q.staleTransactionIndex ? `#${index} is stale (a config change passed it) and can't take votes` : null);
  if (p!.approved.includes(me.publicKey.toBase58())) refuse(`this key already approved #${index}`);
  const memo = a.values.get("memo");
  const sent = await deliver(c, me, `approve #${index}`, [approveIx(squadsProgram, ms, index, me.publicKey, memo)], UNITS.vote);
  if (!sent) return 0;
  const after = await readProposal(conn, squadsProgram, ms, index);
  say(`\nread back: ${proposalLine(q, after, index)}`);
  if (after?.status === "Approved") {
    say(q.timeLock ? `threshold met: it can be executed ${q.timeLock} s from now` : "threshold met: any member with Execute can execute it now");
    say("It has no expiry: until it's executed any ONE member with Execute can run it at any later time, and only a threshold of cancels (which this tool doesn't send) stops it. Execute it now, or don't approve it yet.");
  }
  return 0;
}

async function cmdReject(c: Ctx) {
  const me = await memberFor(c, "reject");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const p = await readProposal(conn, squadsProgram, ms, index);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index}`);
  const stored = await readStored(c, index);
  say(`stored on-chain for #${index} (decoded from the transaction account):`);
  for (const l of stored.lines) say(`  ${l}`);
  if (p!.status === "Approved") refuse(`#${index} is Approved: rejecting is closed, only a threshold of cancels stops it (this tool doesn't send those)`);
  if (p!.status !== "Active") refuse(`#${index} is ${p!.status}: only an Active proposal takes votes`);
  if (p!.rejected.includes(me.publicKey.toBase58())) refuse(`this key already rejected #${index}`);
  if (stored.shape.kind === "publish-list") say("note: one rejection is final for the site's list: it adds its own and builds a new one");
  const sent = await deliver(c, me, `reject #${index}`, [rejectIx(squadsProgram, ms, index, me.publicKey, a.values.get("memo"))], UNITS.vote);
  if (!sent) return 0;
  const after = await readProposal(conn, squadsProgram, ms, index);
  say(`\nread back: ${proposalLine(q, after, index)}`);
  return 0;
}

async function cmdExecute(c: Ctx) {
  const me = await memberFor(c, "execute");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const p = await readProposal(conn, squadsProgram, ms, index);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index} (closed, or never created)`);
  const stored = await vetStored(c, index, p!.status === "Executed" ? `#${index} was already executed`
    : p!.status !== "Approved" ? `#${index} is ${p!.status}, not Approved: ${p!.approved.length} of ${q.threshold} approvals` : null);
  if (q.timeLock && p!.at !== null && Date.now() / 1000 < p!.at + q.timeLock) refuse(`#${index}'s time lock runs until ${new Date((p!.at + q.timeLock) * 1000).toISOString()}`);
  if (!stored.tx) refuse(`#${index} isn't a vault transaction: this tool can't execute it`);
  let ix: TransactionInstruction;
  try { ix = await executeIx(conn, squadsProgram, ms, index, me.publicKey); } catch (e) { return refuse(`can't build the execute: ${msgOf(e).split("\n")[0]}`); }
  const shape = stored.shape;
  const vaultBefore = await conn.getBalance(q.vault, "confirmed");
  const sent = await deliver(c, me, `execute #${index} (${shape.kind})`, [ix], UNITS.execute);
  if (!sent) return 0;
  const after = await readProposal(conn, squadsProgram, ms, index);
  say(`\nread back: ${proposalLine(q, after, index)}`);
  if (after && after.status !== "Executed") throw new Refusal(`#${index} reads back as ${after.status} after a confirmed execute: look at it before anything else`);
  const vaultAfter = await conn.getBalance(q.vault, "confirmed");
  say(`vault PDA balance ${xntOf(vaultBefore)} -> ${xntOf(vaultAfter)} XNT${vaultBefore === vaultAfter ? " (unchanged)" : " (CHANGED)"}`);
  if (shape.kind === "memo") {
    const t = await conn.getTransaction(sent.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    const logs = t?.meta?.logMessages ?? [];
    const signed = logs.some((l) => l.includes(`Signed by ${q.vault.toBase58()}`));
    say(signed ? `the vault PDA signed: the memo program logged "Signed by ${q.vault.toBase58()}"` : "the memo program's log for the vault PDA's signature couldn't be read: check the transaction");
    if (vaultBefore !== vaultAfter) throw new Refusal("the vault PDA's balance changed on a memo");
  }
  if (shape.kind === "set-publisher") {
    const vi = await conn.getAccountInfo(shape.vault, "confirmed");
    const v = vi ? decodeVault(shape.vault, vi.data) : null;
    say(`vault ${shape.vault.toBase58()} publisher reads ${v?.publisher.toBase58() ?? "nothing"}`);
    if (!v?.publisher.equals(shape.newPublisher)) throw new Refusal(`the vault's publisher did NOT change to ${shape.newPublisher.toBase58()}: look at it before anything else`);
    say(`CONFIRMED: the publisher is now ${shape.newPublisher.toBase58()}`);
    say("Next, for the site (scripts/quorum-action.ts header): if that key is factory.taxVault.publisherKeypair the site publishes with it from its next pass; if not, point publisherKeypair at it and restart, or run scripts/crank.ts --publisher. Then remove factory.taxVault.quorum, restart, and stop the co-signer.");
  }
  return 0;
}

/** The whole command; returns the exit code (0 done or dry run, 1 refused or failed, 2 usage, 3 ambiguous send). */
export async function quorumAction(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
  try {
    const a = parseArgs(argv);
    if (a.bools.has("help") || !a.sub) { deps.out(USAGE); return a.bools.has("help") ? 0 : 2; }
    // The key file is checked before any network call, so a bad one can't get as far as signing.
    if (a.sub !== "status" && a.values.has("keypair")) loadMemberKey(a.values.get("keypair")!);
    if (a.sub === "status" && (a.values.has("keypair") || a.bools.has("execute"))) refuse("status is read-only: it takes no --keypair and no --execute");
    const c = await setup(a, deps);
    const run = { status: cmdStatus, "propose-memo": cmdProposeMemo, "propose-set-publisher": cmdProposeSetPublisher, approve: cmdApprove, reject: cmdReject, execute: cmdExecute }[a.sub];
    return await run(c);
  } catch (e) {
    if (e instanceof Refusal) { deps.out(`REFUSED: ${e.message}`); return 1; }
    if (e instanceof Ambiguous) { deps.out(`AMBIGUOUS: ${e.message}`); return 3; }
    deps.out(`ERROR: ${msgOf(e).split("\n")[0]}`);
    return 1;
  }
}
