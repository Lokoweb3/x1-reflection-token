/**
 * What scripts/quorum-action.ts does (see its header): one Squads member acting on the
 * publisher quorum, with what it signs decoded from the chain first. The checks are pure and
 * the commands take their connection from `deps`, so test/quorum-action.test.ts can run them
 * without a validator. Instructions come from src/squads.ts and src/taxvault.ts, fees and
 * sending from src/tx.ts, the paced connection from src/config.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { STATUS_CODES } from "node:http";
import path from "node:path";
import * as squads from "@sqds/multisig";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { connection, type Config } from "./config.js";
import { decodePublishProposal, type PublishArgs } from "./list-verify.js";
import {
  SQUADS_PROGRAM_IDS, PUBLISHER_VAULT_INDEX, approveIx, decodeProposal, decodeVaultTx, executeIx, proposalVotes, proposeIxs, readProposal, readQuorum, rejectCutoff, rejectIx,
  squadsProposalPda, squadsTransactionPda, squadsVaultPda, type ProposalInfo, type Quorum, type VaultTx,
} from "./squads.js";
import { IX, TAX_VAULT_PROGRAM_ID, cidFromBytes, decodeVault, errorName, setPublisherIx, vaultPda, type Vault } from "./taxvault.js";
import { fitComputeLimit, sendAndConfirm, sign, withPriority } from "./tx.js";

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
const WITHHELD = "(the details aren't printed: an RPC's words can repeat an API key)";
/** The web3.js operations this tool and the setup script call. Only these names are printed from a wrapped failure. */
const RPC_OPERATIONS = ["failed to get info about account", "failed to get info for accounts", "failed to get balance of account", "failed to get balance for", "failed to get genesis hash", "failed to get latest blockhash",
  "failed to get fee for message", "failed to get signature status", "failed to get signatures for address", "failed to get transaction", "failed to get block height", "failed to simulate transaction", "failed to send transaction", "failed to get recent blockhash"];
/** Errors written by this repo, which carry no RPC words: whole-message matches. */
const SAFE_LOCAL = [/^fetch failed$/, /^Invalid public key input$/, /^Non-base58 character$/, /^Endpoint URL must start with `http:` or `https:`\.$/, /^vault transactions with lookup tables aren't used here$/,
  /^Squads program config [1-9A-HJ-NP-Za-km-z]+ not found \(is [1-9A-HJ-NP-Za-km-z]+ Squads v4\?\)$/, /^the multisig doesn't exist: not moving any publisher to it$/, /^the new multisig doesn't read back as expected$/];
const httpPart = (code: string) => { const name = STATUS_CODES[code]; return `HTTP ${code}${name ? ` ${name}` : ""}`; };
/**
 * An error as it may be printed. An allowlist, because whatever an RPC server wrote is untrusted
 * and can quote a credential too short to scrub: its message text, its HTTP reason phrase, a
 * body in a parse error. Only the forms below print, and of those only the parts this repo or
 * web3.js wrote: the operation, the class, a numeric code. Everything else is withheld.
 */
export function printable(e: unknown): string {
  const first = msgOf(e).split("\n")[0];
  const name = e instanceof Error ? e.name : "";
  const op = RPC_OPERATIONS.find((o) => first === o || first.startsWith(`${o} `) || first.startsWith(`${o}:`));
  const inner = op && first.includes(": ") ? first.slice(first.indexOf(": ") + 2) : null;
  const says = (what: string) => `${op ? `${op}: ` : ""}${what} ${WITHHELD}`;
  if (name === "SolanaJSONRPCError") {
    const code = (e as { code?: unknown }).code;
    return says(Number.isInteger(code) ? `JSON-RPC error ${code}` : "JSON-RPC error");
  }
  const http = /^(?:Error: )?([1-5]\d\d)\b/.exec(inner ?? first);
  if (http) return says(httpPart(http[1]));
  if (op) {
    if (inner?.startsWith("SolanaJSONRPCError:")) return says("JSON-RPC error");
    if (inner?.startsWith("TypeError: fetch failed")) return says("fetch failed");
    if (inner?.startsWith("SyntaxError:")) return says("the answer wasn't JSON");
    if (inner?.startsWith("StructError:")) return says("the answer wasn't in the expected form");
    return says("the RPC refused or failed");
  }
  const tx = /^Transaction [1-9A-HJ-NP-Za-km-z]{32,88} (?:failed|expired before it confirmed|not confirmed within \d+s \(it may still land\)|resulted in an error\.)/.exec(first);
  if (tx) return tx[0];
  if (/^Simulation failed\b/.test(first)) return "Simulation failed";
  if (e instanceof SyntaxError) return `an answer or a file wasn't JSON ${WITHHELD}`;
  if (name === "StructError") return `an answer wasn't in the expected form ${WITHHELD}`;
  if (SAFE_LOCAL.some((r) => r.test(first))) {
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof cause === "string" && /^[A-Z][A-Z0-9_]*$/.test(cause) ? `${first} (${cause})` : first;
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return `system error ${code} ${WITHHELD}`;
  return `unexpected ${/^[A-Za-z]*Error$/.test(name) ? name : "error"} ${WITHHELD}`;
}
export const sha256Hex = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A check said no: printed as REFUSED, exit code 1, nothing sent. */
export class Refusal extends Error {}
const refuse = (m: string): never => { throw new Refusal(m); };

// ---------- arguments ----------
const VALUE_FLAGS = ["network", "rpc", "multisig", "index", "keypair", "text", "mint", "new-publisher", "expect-new-publisher", "expect-memo-hash", "expect-mint", "memo", "squads-program", "program", "limit", "priority", "verify-rpc", "expect-message-hash"];
const BOOL_FLAGS = ["execute", "allow-local-rpc", "allow-unknown", "allow-off-curve", "single-rpc-accepted", "help"];
export const SUBCOMMANDS = ["status", "propose-memo", "propose-set-publisher", "approve", "reject", "cancel", "execute"] as const;
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

/** An RPC URL as it may be printed: scheme and host only (API keys sit in the user info, the path or the query). */
export function redactRpc(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== "/" ? "/…" : ""}${u.search ? "?…" : ""}`;
  } catch { return "<an RPC URL that doesn't parse>"; }
}
/** Same host and port: not a second opinion, whatever the path or key says. */
export function sameEndpoint(a: string, b: string) {
  try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase(); } catch { return a === b; }
}
/** Parts of an RPC URL that say nothing secret, and would otherwise be scrubbed from the tool's own words. */
const GENERIC_URL_PART = /^(rpc|api|apis|v\d+|mainnet|testnet|devnet|x1|solana|http|https|ws|wss|public|node|confirmed|finalized|processed|true|false)$/i;
const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** A URL's credentials, every way an error or a server's answer might quote them. */
function secretsOf(url: string): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return []; }
  const parts = [u.username, u.password, ...u.pathname.split("/"), ...u.search.slice(1).split("&").map((x) => x.slice(x.indexOf("=") + 1)), u.hash.slice(1)];
  const out = parts.filter((x) => x.length >= 4 && !GENERIC_URL_PART.test(x)).flatMap((x) => {
    const d = decoded(x), e = encodeURIComponent(d);
    return [x, lowerHex(x), x.toLowerCase(), d, d.toLowerCase(), e, lowerHex(e), e.toLowerCase(), encodeURI(d), encodeURIComponent(e), Buffer.from(d).toString("base64"), Buffer.from(d).toString("base64url")];
  });
  if (u.username || u.password) out.push(Buffer.from(`${decoded(u.username)}:${decoded(u.password)}`).toString("base64"));
  return out;
}
/**
 * Every RPC URL on the command line and in the environment is replaced in all output, then each
 * credential inside it on its own. Parts under 4 characters aren't scrubbed (they'd eat pieces
 * of addresses): printable() is why a server can't echo those.
 */
export function scrubber(argv: string[]) {
  const raw = [...argv.flatMap((x, i) => [...(x.match(/[a-z][a-z0-9+.-]*:\/\/\S+/gi) ?? []), ...(["--rpc", "--verify-rpc"].includes(argv[i - 1]) ? [x] : [])]), process.env.REFLECT_RPC_URL ?? ""].filter(Boolean);
  const whole = raw.flatMap((u) => {
    let href = u;
    try { href = new URL(u).href; } catch { /* the raw form is all there is */ }
    return [[u, redactRpc(u)], [href, redactRpc(u)]];
  });
  const secrets = [...new Set(raw.flatMap(secretsOf))].filter(Boolean).map((x) => [x, "<redacted>"]);
  const pairs = [...whole.sort((x, y) => y[0].length - x[0].length), ...secrets.sort((x, y) => y[0].length - x[0].length)];
  return (line: string) => pairs.reduce((l, [from, to]) => l.split(from).join(to), line);
}

/**
 * The Squads executables this code was rehearsed against, read 2026-11-03: length and sha256
 * of the program data with trailing zeros trimmed (`solana program dump` keeps the padding).
 */
export const SQUADS_PINS: Record<Network, { length: number; sha256: string }> = {
  mainnet: { length: 979_505, sha256: "e39338bd363dba6671e91c888fd9b1c2dea256e1e8ec24e5865bcc5d94f90eec" },
  testnet: { length: 842_489, sha256: "72ae1dd5044da38a965730eeee0adbeb698cff619c9f0f8b54039264082c5f7d" },
};
/** Why this program-data account (45-byte header, then the executable) isn't the pinned deployment, or null. */
export function squadsBinaryProblem(deployment: Network, programData: Buffer): string | null {
  const bin = programData.subarray(45);
  let end = bin.length;
  while (end > 0 && bin[end - 1] === 0) end--;
  const sha256 = sha256Hex(bin.subarray(0, end)), pin = SQUADS_PINS[deployment];
  if (end !== pin.length) return `the ${deployment} Squads executable is ${end} bytes, pinned at ${pin.length}`;
  if (sha256 !== pin.sha256) return `the ${deployment} Squads executable hashes to ${sha256}, pinned at ${pin.sha256}`;
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
export function rightsProblem(q: Pick<Quorum, "members">, key: PublicKey, what: "propose" | "approve" | "reject" | "cancel" | "execute"): string | null {
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

/** Vault index, ephemeral signer count and the message exactly as the account stores it. */
function storedMessageBytes(info: AccountInfo<Buffer>): Buffer {
  const [, end] = squads.accounts.VaultTransaction.fromAccountInfo(info);
  const d = info.data, at = 8 + 32 + 32 + 8 + 1; // discriminator, multisig, creator, index, bump
  const ephemeral = d.readUInt32LE(at + 2);
  return Buffer.concat([d.subarray(at, at + 1), Buffer.from([ephemeral]), d.subarray(at + 2 + 4 + ephemeral, end)]);
}
const HASH_DOMAIN = "99tax-quorum-message-v2\0";
/**
 * The fingerprint two members compare out of band: which proposal (multisig and index, as asked
 * for, not as the account says) and what will run. A proposer prints it from what it built
 * itself. A hash for one proposal can't be replayed against another. It's compared with what an
 * RPC reports, not with the chain, and no vote is tied to it: see the script's header.
 */
export function storedMessageHash(info: AccountInfo<Buffer>, ms: PublicKey, index: bigint) {
  const at = Buffer.alloc(8);
  at.writeBigUInt64LE(index);
  return sha256Hex(Buffer.concat([Buffer.from(HASH_DOMAIN), ms.toBuffer(), at, storedMessageBytes(info)]));
}
/** The same fingerprint for an instruction this machine is about to propose as `index`. */
export function plannedMessageHash(ms: PublicKey, vaultPdaKey: PublicKey, ix: TransactionInstruction, program: PublicKey, index: bigint) {
  const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: new TransactionMessage({ payerKey: vaultPdaKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }), vaultPda: vaultPdaKey,
  });
  const [m] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const message = { ...m, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: Uint8Array.from(i.accountIndexes), data: Uint8Array.from(i.data) })),
    addressTableLookups: m.addressTableLookups.map((l) => ({ accountKey: l.accountKey, writableIndexes: Uint8Array.from(l.writableIndexes), readonlyIndexes: Uint8Array.from(l.readonlyIndexes) })) };
  const [data] = squads.accounts.VaultTransaction.fromArgs({ multisig: ms, creator: PublicKey.default, index: 0, bump: 0, vaultIndex: PUBLISHER_VAULT_INDEX, vaultBump: 0, ephemeralSignerBumps: new Uint8Array(), message }).serialize();
  return storedMessageHash({ owner: program, data, lamports: 0, executable: false, rentEpoch: 0 }, ms, index);
}

/** One line per account of a stored instruction, with the flags the message gives it, and its data in full. */
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
      ...ix.accountIndexes.map((i) => `  account ${name(i)}`), `  data ${ix.data.toString("hex")}`];
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
    ? "this is a rewards list (publish_list), which this tool doesn't check. scripts/cosigner.ts --once --dry-run with this key checks it, but without --dry-run that script also rejects every other open proposal this key hasn't voted on and executes whatever this key approved (see this script's header). --allow-unknown approves it unchecked"
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
  a: Parsed; deps: Deps; say: (s: string) => void; conn: Connection; network: Network; rpc: string; genesis: string; local: boolean;
  squadsProgram: PublicKey; taxProgram: PublicKey; ms: PublicKey; q: Quorum; execute: boolean; microLamports: number;
}
export const USAGE = `Usage: npx tsx scripts/quorum-action.ts <subcommand> --network testnet|mainnet --multisig <address> [--rpc <url>] [--execute] ...
  status                 [--index n] [--limit 10]                                     (no keypair)
  propose-memo           --keypair <file> [--text <short>]
  propose-set-publisher  --keypair <file> --mint <mint> --new-publisher <pubkey> [--allow-off-curve]
  approve                --keypair <file> --index n [--expect-new-publisher <pubkey>] [--expect-mint <mint>] [--expect-memo-hash <sha256>] [--allow-unknown] [--allow-off-curve]
  reject                 --keypair <file> --index n [--memo <reason>]
  cancel                 --keypair <file> --index n [--memo <reason>]                 (an Approved proposal; a threshold of cancels stops it)
  execute                --keypair <file> --index n [--expect-new-publisher <pubkey>] [--expect-mint <mint>] [--expect-memo-hash <sha256>] [--allow-unknown] [--allow-off-curve]
approve and execute also take --verify-rpc <url> (a second, different RPC) or --single-rpc-accepted (one of the two is required on mainnet) and --expect-message-hash <sha256>.
Setup: site key + co-signer + hardware backup, 2-of-3. A hardware key can't sign through this tool yet (--keypair is a file): see the script's header.
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
  // src/config.ts lets that variable override every connection, which would make the second read a copy of the first.
  if (envRpc && a.values.has("verify-rpc")) refuse("REFLECT_RPC_URL overrides every connection in this process, so --verify-rpc wouldn't reach a second RPC: unset it");
  const custom = pubkeyArg(a, "squads-program");
  if (custom && !allowLocal) refuse("--squads-program is only for a local validator (--allow-local-rpc): real networks use the program in src/squads.ts");
  const taxArg = pubkeyArg(a, "program");
  if (taxArg && network === "mainnet" && !allowLocal && !taxArg.equals(TAX_VAULT_PROGRAM_ID)) refuse(`--program on mainnet can only be ${TAX_VAULT_PROGRAM_ID.toBase58()}, the deployed tax_vault`);
  const ms = needPubkey(a, "multisig");
  const conn = deps.connect(rpc);
  const genesis = await conn.getGenesisHash();
  const problem = genesisProblem({ network, genesis, rpc, allowLocal });
  if (problem) refuse(problem);
  // A real network behind a local URL (a tunnel, a port forward) gets no local-only overrides.
  if (genesis === GENESIS_HASH[network]) {
    if (allowLocal) refuse(`--allow-local-rpc was given, but ${rpc} reports X1 ${network}: drop the local-only flags for a real network`);
    if (taxArg && network === "mainnet" && !taxArg.equals(TAX_VAULT_PROGRAM_ID)) refuse(`--program on mainnet can only be ${TAX_VAULT_PROGRAM_ID.toBase58()}, the deployed tax_vault`);
  }
  const squadsProgram = custom ?? SQUADS_PROGRAM_IDS[network];
  const taxProgram = taxArg ?? TAX_VAULT_PROGRAM_ID;
  const q = await readQuorum(conn, squadsProgram, ms);
  if (!q) refuse(`${ms.toBase58()} isn't a Squads multisig of ${squadsProgram.toBase58()} on ${rpc} (the vault PDA is a different address from the multisig)`);
  const micro = Number(a.values.get("priority") ?? MICRO_LAMPORTS);
  if (!Number.isInteger(micro) || micro < 0) refuse("--priority takes whole microlamports per CU");
  say(`network   ${network}${genesis === GENESIS_HASH[network] ? ` (genesis ${genesis} checked)` : `, LOCAL validator ${rpc} (genesis ${genesis})`}, RPC ${rpc}`);
  say(`Squads    ${squadsProgram.toBase58()}${custom ? " (--squads-program)" : ""}, tax_vault ${taxProgram.toBase58()}`);
  return { a, deps, say, conn, network, rpc, genesis, local: genesis !== GENESIS_HASH[network], squadsProgram, taxProgram, ms, q: q!, execute: a.bools.has("execute"), microLamports: micro };
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
export interface Stored { kindName: string; tx: VaultTx | null; shape: Shape; vault: Vault | null; lines: string[]; messageHash?: string; info?: AccountInfo<Buffer> }
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
  const messageHash = storedMessageHash(info, ms, index);
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
  lines.push(`message hash ${messageHash} (of this proposal; compare it with the proposer's out of band: --expect-message-hash)`);
  lines.push(`stored by ${tx.creator.toBase58()}; vault index ${tx.vaultIndex}, ephemeral signers ${tx.ephemeralSigners}, lookup tables ${tx.lookups}`);
  lines.push(...accountsOf(tx, q.vault));
  if (shape.kind === "unknown" || shape.kind === "publish-list") lines.push(`complete stored message ${storedMessageBytes(info).toString("hex")}`);
  return { kindName: "vault", tx, shape, vault, lines, messageHash, info };
}
const proposalLine = (q: Quorum, p: ProposalInfo | null, index: bigint) => p
  ? `#${index} ${p.status}: ${p.approved.length} of ${q.threshold} approvals, ${p.rejected.length} of ${rejectCutoff(q)} rejections to close${p.cancelled.length ? `, ${p.cancelled.length} cancels` : ""}${index <= q.staleTransactionIndex ? (p.status === "Approved" ? " (stale: a config change passed it, but an Approved vault transaction can STILL execute until cancelled)" : " (stale: a config change passed it)") : ""}`
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
    if (p?.status === "Active" && index > q.staleTransactionIndex) say(`  needs ${q.threshold - p.approved.length} more approval(s), or ${rejectCutoff(q) - p.rejected.length} more rejection(s) to close`);
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

/** The stored transaction and proposal from one read at one slot: what every check below uses. */
interface Snapshot { slot: number; tx: AccountInfo<Buffer> | null; proposal: AccountInfo<Buffer> | null }
async function readSnapshot(conn: Connection, c: Ctx, index: bigint): Promise<Snapshot> {
  const { context, value } = await conn.getMultipleAccountsInfoAndContext([squadsTransactionPda(c.squadsProgram, c.ms, index), squadsProposalPda(c.squadsProgram, c.ms, index)], "confirmed");
  return { slot: context.slot, tx: value[0], proposal: value[1] };
}
const sameAccount = (a: AccountInfo<Buffer> | null, b: AccountInfo<Buffer> | null) => (!a && !b) || (!!a && !!b && a.owner.equals(b.owner) && a.data.equals(b.data));
const quorumFacts = (q: Quorum | null) => (q ? JSON.stringify([q.threshold, q.members, q.timeLock, q.configAuthority?.toBase58() ?? null, q.staleTransactionIndex.toString(), q.rentCollector?.toBase58() ?? null]) : "none");

/**
 * The second read: a different RPC, the same chain, at or past the first read's slot, with the
 * same stored bytes, proposal, multisig and (for a set_publisher) vault publisher. A signature
 * approves a proposal, not its bytes, so this and the out-of-band hash are all that can be done
 * off-chain, and it isn't proof of what the chain stores: see the script's header.
 */
async function secondRead(c: Ctx, index: bigint, first: Snapshot, stored: Stored) {
  const { a, say, deps, rpc } = c;
  const url = a.values.get("verify-rpc");
  if (!url) {
    const realMainnet = c.network === "mainnet" && !c.local;
    if (realMainnet && !a.bools.has("single-rpc-accepted")) refuse("on mainnet, approve and execute read the stored transaction from two RPCs: pass --verify-rpc <a different RPC>, or --single-rpc-accepted to rely on one (a lying RPC can then show you a different set_publisher than the chain stores, and nothing in this tool detects it)");
    if (a.bools.has("single-rpc-accepted")) {
      say("");
      say("  ************************************************************************");
      say("  *  WARNING: --single-rpc-accepted. Only one RPC was read. If it lies, it can");
      say("  *  show a different set_publisher than the one stored.");
      say("  *  Nothing in this tool detects it: you approve the proposal, not the lines above.");
      say("  *  --expect-message-hash helps only if the hash came from a machine you trust.");
      say("  ************************************************************************");
      say("");
    } else say("  one RPC read: --verify-rpc <a different RPC> checks it against a second");
    return;
  }
  if (a.bools.has("single-rpc-accepted")) refuse("--verify-rpc and --single-rpc-accepted contradict each other");
  if (sameEndpoint(url, rpc)) refuse("--verify-rpc is the same host and port as --rpc: that's not a second read");
  const conn2 = deps.connect(url);
  let second: Snapshot | null = null, q2: Quorum | null = null;
  try {
    const genesis = await conn2.getGenesisHash();
    const problem = genesisProblem({ network: c.network, genesis, rpc: url, allowLocal: a.bools.has("allow-local-rpc") });
    if (problem) refuse(`--verify-rpc: ${problem}`);
    if (genesis !== c.genesis) refuse(`--verify-rpc reports genesis ${genesis}, but --rpc reports ${c.genesis}: they aren't the same chain`);
    for (let i = 0; i < 8; i++) {
      second = await readSnapshot(conn2, c, index);
      if (second.slot >= first.slot) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    q2 = await readQuorum(conn2, c.squadsProgram, c.ms);
    if (second!.slot < first.slot) refuse(`--verify-rpc is behind: it's at slot ${second!.slot}, and the first read was at slot ${first.slot}`);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    refuse(`--verify-rpc couldn't be read: ${printable(e)}`);
  }
  const differs: string[] = [];
  if (!sameAccount(first.tx, second!.tx)) differs.push("the stored transaction's bytes");
  if (!sameAccount(first.proposal, second!.proposal)) differs.push("the proposal's state");
  if (quorumFacts(c.q) !== quorumFacts(q2)) differs.push("the multisig's members or settings");
  if (stored.shape.kind === "set-publisher") {
    const vi = await conn2.getAccountInfo(stored.shape.vault, "confirmed").catch(() => null);
    const v = vi?.owner.equals(c.taxProgram) ? (() => { try { return decodeVault(stored.shape.kind === "set-publisher" ? stored.shape.vault : PublicKey.default, vi.data); } catch { return null; } })() : null;
    if (!v || !stored.vault || !v.publisher.equals(stored.vault.publisher) || !v.mint.equals(stored.vault.mint)) differs.push("the vault's publisher or mint");
  }
  if (differs.length) refuse(`the two RPCs disagree about ${differs.join(", ")}. A vote landing between the reads does this too, so run it again once; if it stays different, one RPC is lying: don't sign`);
  say(`  second read OK: ${url} at slot ${second!.slot} (first read at slot ${first.slot}): stored transaction, proposal and multisig are identical`);
}

/** The scan couldn't look at everything, so it can't say nothing is open. */
export class ScanIncomplete extends Error {}
/** At 50 indexes a call, 400 calls. A multisig past this fails closed: one with fewer proposals is a new --create-key away. */
export const MAX_SCAN_INDEXES = 20_000n;
/**
 * Proposals still able to act on this vault if its publisher is (or returns to) this multisig's
 * vault PDA. Nothing but executing or clearing them ends that: they have no expiry, and an
 * Approved one needs only one more signer. Every index from 1, because a config change doesn't
 * end what's Approved. What both pinned binaries do below the stale index (scripts/quorum-action-rehearsal.ts,
 * section T): an Approved vault transaction still executes, by one key, and cancels still work on it;
 * an Approved config transaction can't execute; a Draft, an Active one and a stored transaction
 * with no proposal can't get activated, voted on or a proposal, so they're dead and don't count.
 * Throws ScanIncomplete rather than return a list it can't vouch for.
 */
export async function openProposalsFor(conn: Connection, program: PublicKey, ms: PublicKey, q: Quorum, vaultAccount: PublicKey, o: { maxIndexes?: bigint; gapMs?: number } = {}) {
  const max = o.maxIndexes ?? MAX_SCAN_INDEXES, gap = o.gapMs ?? 120;
  const cant = (why: string) => new ScanIncomplete(`can't tell which proposals are open: ${why}`);
  if (q.transactionIndex > max) throw cant(`this multisig has ${q.transactionIndex} indexes, more than the ${max} indexes this scan reads`);
  const out: { index: bigint; status: string }[] = [];
  for (let from = 1n; from <= q.transactionIndex; from += 50n) {
    if (from > 1n && gap) await new Promise((r) => setTimeout(r, gap));
    const indexes: bigint[] = [];
    for (let i = from; i < from + 50n && i <= q.transactionIndex; i++) indexes.push(i);
    let infos: (AccountInfo<Buffer> | null)[];
    try { infos = await conn.getMultipleAccountsInfo(indexes.flatMap((i) => [squadsProposalPda(program, ms, i), squadsTransactionPda(program, ms, i)]), "confirmed"); }
    catch (e) { throw cant(`reading #${from} onwards failed: ${printable(e)}`); }
    if (infos?.length !== indexes.length * 2) throw cant(`the RPC answered ${infos?.length ?? 0} accounts for ${indexes.length * 2}`);
    indexes.forEach((i, n) => {
      const pInfo = infos[2 * n], txInfo = infos[2 * n + 1];
      if (!pInfo && !txInfo) return;
      const stale = i <= q.staleTransactionIndex;
      let status: string, tx: VaultTx | null;
      try {
        const p = decodeProposal(program, ms, i, pInfo);
        if (pInfo && !p) throw new Error("not a proposal of this multisig");
        status = p?.status ?? "no proposal yet";
        tx = decodeVaultTx(program, ms, i, txInfo);
      } catch (e) { throw cant(`the accounts of #${i} don't decode: ${printable(e)}`); }
      if (status === "Rejected" || status === "Executed" || status === "Cancelled") return;
      const isConfig = !!txInfo && txInfo.data.subarray(0, 8).equals(Buffer.from(squads.generated.configTransactionDiscriminator));
      if (stale && (status !== "Approved" && status !== "Executing" || isConfig)) return;
      if (tx ? tx.lookups > 0 || tx.accountKeys.some((k) => k.equals(vaultAccount)) : !!txInfo) out.push({ index: i, status });
    });
  }
  return out;
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
 * Build and simulate UNSIGNED, report, and only past the --execute gate sign and send (once:
 * src/tx.ts may re-broadcast the same signed bytes while it waits, which can't execute twice;
 * nothing here signs a new one). A dry run never gives the RPC a signature it could relay.
 * Returns the signature, or null when it stopped at the dry run.
 */
async function deliver(c: Ctx, me: Keypair, what: string, ixs: TransactionInstruction[], units: number): Promise<{ signature: string } | null> {
  const { conn, say, execute, squadsProgram, taxProgram, microLamports } = c;
  const fitted = await fitComputeLimit(conn, withPriority(ixs, microLamports, units), me.publicKey);
  const limitIx = fitted.find((ix) => ix.programId.toBase58() === "ComputeBudget111111111111111111111111111111" && ix.data[0] === 2);
  const requested = limitIx ? limitIx.data.readUInt32LE(1) : units;
  const balance = BigInt(await conn.getBalance(me.publicKey, "confirmed"));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: me.publicKey, recentBlockhash: blockhash, instructions: fitted }).compileToLegacyMessage();
  const sim = await conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [me.publicKey.toBase58()] } });
  const quote = await conn.getFeeForMessage(message, "confirmed").then((r) => r.value).catch(() => null);
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
  say(`  simulation OK (unsigned): ${sim.value.unitsConsumed ?? "?"} CU used, ${requested} CU requested`);
  say(`  expected fee: RPC quote ${quote === null ? "not available" : `${xntOf(quote)} XNT`}; X1's billing on requested CU would be about ${xntOf(x1Fee)} XNT`);
  if (moved !== null) say(`  simulated balance change ${xntOf(-moved)} XNT (fee plus any rent this transaction pays)`);
  if (!execute) { say("  nothing was signed or sent; add --execute to send it"); return null; }
  const s = await sign(conn, fitted, me);
  say(`  signature ${s.signature}`);
  try {
    await sendAndConfirm(conn, s);
  } catch (e) {
    if (sendFate(e) === "failed") {
      const st = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      throw new Refusal(`the transaction failed on-chain: ${explainFailure(st?.meta?.logMessages ?? [], squadsProgram, taxProgram) ?? printable(e)}`);
    }
    throw new Ambiguous(`the send didn't confirm: ${printable(e)}. It may still land: run \`status --index n\` before anything else. Nothing was or will be resent automatically (signature ${s.signature}).`);
  }
  say(`  CONFIRMED: ${what}, signature ${s.signature}`);
  await conn.getBalance(me.publicKey, "confirmed").then((n) => say(`  this key's balance moved ${xntOf(BigInt(n) - balance)} XNT (now ${xntOf(n)})`)).catch(() => say("  this key's balance couldn't be read back"));
  return { signature: s.signature };
}
const unverified = (what: string, signature: string, why: string, index: bigint | string = "n") =>
  new Unverified(`${what} is CONFIRMED (signature ${signature}), but ${why}. Verification unavailable. Do NOT re-propose or send it again: run \`status --index ${index}\` when the RPC answers.`);
/**
 * Everything after a confirmed send: a read failing here says nothing about the transaction,
 * which landed. Refusals are things actually seen on-chain and stay refusals.
 */
async function reading<T>(what: string, signature: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof Refusal || e instanceof Unverified) throw e;
    throw unverified(what, signature, `reading the result back failed: ${printable(e)}`);
  }
}
/** A required read-back: an account that's missing or doesn't decode proves nothing, so it's never reported as a result. */
async function proposalAfter(c: Ctx, what: string, signature: string, index: bigint) {
  return reading(what, signature, async () => {
    const p = await readProposal(c.conn, c.squadsProgram, c.ms, index);
    if (!p) throw unverified(what, signature, `proposal #${index} doesn't read back (its account is missing or doesn't decode)`, index);
    c.say(`\nread back: ${proposalLine(c.q, p, index)}`);
    return p;
  });
}
/** Confirmed, but the result couldn't be read back: exit code 4, no retry. */
export class Unverified extends Error {}
/** The send may or may not have landed: exit code 3, no retry. */
export class Ambiguous extends Error {}

const nextSteps = (c: Ctx, index: bigint, expect: string) => {
  const base = `npx tsx scripts/quorum-action.ts`;
  const common = `--network ${c.network}${c.local ? ` --allow-local-rpc --rpc ${c.rpc}` : ""} --multisig ${c.ms.toBase58()} --index ${index} ${expect}`.trimEnd();
  c.say(`\nNext (each member on its own machine, with its own --keypair; dry run first, then --execute):`);
  c.say(`  ${base} approve ${common} --keypair <another member's file>`);
  c.say(`  ${base} execute ${common} --keypair <a member's file>`);
  if (c.network === "mainnet" && !c.local) c.say("  On mainnet each also needs --single-rpc-accepted or --verify-rpc <url>: see the script's header for what each does and doesn't catch.");
};

async function readbackProposed(c: Ctx, me: Keypair, index: bigint, want: Shape["kind"], planned: string, signature: string) {
  const what = `proposal #${index}`;
  const p = await proposalAfter(c, what, signature, index);
  const s = await readStored(c, index);
  for (const l of s.lines) c.say(`  ${l}`);
  if (!s.tx) throw unverified(what, signature, `its stored transaction doesn't read back (${s.lines[0]})`, index);
  if (s.shape.kind !== want) throw new Refusal(`#${index} landed (signature ${signature}), but the stored transaction reads back as ${s.shape.kind}, not ${want}: don't approve it`);
  if (s.messageHash !== planned) throw new Refusal(`#${index} landed (signature ${signature}), but the stored message hash ${s.messageHash} isn't the ${planned} this machine built: don't approve it, and check this RPC`);
  if (!p.approved.includes(me.publicKey.toBase58())) c.say("  note: this key's approval doesn't show yet");
}

async function memberFor(c: Ctx, what: "propose" | "approve" | "reject" | "cancel" | "execute") {
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
  const planned = plannedMessageHash(ms, q.vault, memo, squadsProgram, index);
  say(`  message hash ${planned} (from what this machine built: give it to the other members out of band)`);
  const sent = await deliverProposal(c, me, index, proposeIxs(squadsProgram, ms, index, me.publicKey, memo));
  if (!sent) return 0;
  await reading(`proposal #${index}`, sent.signature, () => readbackProposed(c, me, index, "memo", planned, sent.signature));
  nextSteps(c, index, `--expect-memo-hash ${hash} --expect-message-hash ${planned}`);
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
  const ix = setPublisherIx(taxProgram, q.vault, mint, newPublisher);
  const planned = plannedMessageHash(ms, q.vault, ix, squadsProgram, index);
  say(`  message hash      ${planned} (from what this machine built: give it to the other members out of band)`);
  await warnAboutMove(c, newPublisher, null);
  const sent = await deliverProposal(c, me, index, proposeIxs(squadsProgram, ms, index, me.publicKey, ix));
  if (!sent) return 0;
  await reading(`proposal #${index}`, sent.signature, () => readbackProposed(c, me, index, "set-publisher", planned, sent.signature));
  nextSteps(c, index, `--expect-new-publisher ${newPublisher.toBase58()} --expect-mint ${mint.toBase58()} --expect-message-hash ${planned}`);
  return 0;
}

async function warnAboutMove(c: Ctx, newPublisher: PublicKey, self: bigint | null) {
  const { say, conn, q, squadsProgram, ms } = c;
  if (!PublicKey.isOnCurve(newPublisher.toBytes()) && !newPublisher.equals(q.vault)) say(`  note: the new publisher is off-curve; the site only proposes through vault index ${PUBLISHER_VAULT_INDEX} of the configured multisig`);
  if (PublicKey.isOnCurve(newPublisher.toBytes()) && (await conn.getBalance(newPublisher, "confirmed")) === 0) say("  note: the new publisher holds no XNT; whichever key pays its transactions needs some");
  for (const i of await openLists(c, self)) say(`  note: list proposal #${i} is open. It's blocked only while the publisher differs (NotPublisher): if the publisher ever returns to this vault PDA it can run again, if its epoch and total still fit. Clear it before the publisher returns: ${rejectCutoff(q)} rejections if Active, ${q.threshold} cancels if Approved`);
}

/** Everything that must hold before this member signs a vote or an execute of proposal `index`, all from one snapshot. */
async function vetStored(c: Ctx, index: bigint, snap: Snapshot, statusProblem: string | null) {
  const { a, say, q } = c;
  const stored = await storedFrom(c, index, snap.tx, q, c.taxProgram);
  say(`\nstored on-chain for #${index} at slot ${snap.slot} (decoded from the transaction account):`);
  for (const l of stored.lines) say(`  ${l}`);
  if (statusProblem) refuse(statusProblem);
  const e: Expectations = { newPublisher: pubkeyArg(a, "expect-new-publisher"), memoHash: a.values.get("expect-memo-hash") ?? null, mint: pubkeyArg(a, "expect-mint"), allowUnknown: a.bools.has("allow-unknown") };
  const shape = stored.shape;
  const problem = expectationProblem(shape, e, stored.vault?.mint ?? null);
  if (problem) refuse(problem);
  const expectHash = a.values.get("expect-message-hash");
  if (expectHash && expectHash.toLowerCase() !== stored.messageHash) refuse(`--expect-message-hash is ${expectHash}, but the stored message hashes to ${stored.messageHash ?? "nothing (no vault transaction)"}`);
  // --allow-unknown means reading all of it, so what can't be shown in full can't be allowed.
  if (!stored.tx) refuse(`#${index} ${shape.kind === "unknown" ? shape.reason : "isn't a vault transaction"}: its payload can't be shown and resolved here, so this tool won't sign for it, even with --allow-unknown`);
  if (stored.tx!.lookups > 0) refuse(`#${index} uses address lookup tables: its accounts can't be resolved from the message, so this tool won't sign for it, even with --allow-unknown`);
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
    say("  *  You are signing for whatever the lines above say. Read every account and");
    say(`  *  the data, and compare the message hash: ${stored.messageHash}`);
    say("  ************************************************************************");
    say("");
  }
  await secondRead(c, index, snap, stored);
  return stored;
}

async function cmdApprove(c: Ctx) {
  const me = await memberFor(c, "approve");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const snap = await readSnapshot(conn, c, index);
  const p = decodeProposal(squadsProgram, ms, index, snap.proposal);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index}`);
  await vetStored(c, index, snap, p!.status !== "Active" ? `#${index} is ${p!.status}: only an Active proposal takes votes`
    : index <= q.staleTransactionIndex ? `#${index} is stale (a config change passed it) and can't take votes` : null);
  if (p!.approved.includes(me.publicKey.toBase58())) refuse(`this key already approved #${index}`);
  const memo = a.values.get("memo");
  const sent = await deliver(c, me, `approve #${index}`, [approveIx(squadsProgram, ms, index, me.publicKey, memo)], UNITS.vote);
  if (!sent) return 0;
  const after = await proposalAfter(c, `the approval of #${index}`, sent.signature, index);
  if (!after.approved.includes(me.publicKey.toBase58())) say("note: this key's approval doesn't show yet");
  if (after.status === "Approved") {
    say(q.timeLock ? `threshold met: it can be executed ${q.timeLock} s from now` : "threshold met: any member with Execute can execute it now");
    say("It has no expiry: until it's executed any ONE member with Execute can run it at any later time, and only a threshold of cancels stops it. Execute it now, or don't approve it yet.");
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
  if (p!.status === "Approved") refuse(`#${index} is Approved: rejecting is closed, only a threshold of cancels stops it (the cancel subcommand)`);
  if (p!.status !== "Active") refuse(`#${index} is ${p!.status}: only an Active proposal takes votes`);
  if (p!.rejected.includes(me.publicKey.toBase58())) refuse(`this key already rejected #${index}`);
  const cutoff = rejectCutoff(q), nth = p!.rejected.length + 1;
  say(`this is rejection ${nth} of the ${cutoff} that close #${index} on-chain: ${nth >= cutoff ? "it closes it" : `${cutoff - nth} more after it, and until then #${index} stays Active and can still be approved`}`);
  if (stored.shape.kind === "publish-list") say(`note: a rewards list. Only if it's the list the site is tracking right now, and this isn't the site's own key, does the site react: its next pass adds its own rejection and builds a new list. It ignores every other index, and a rejection from its own key changes nothing. This tool can't see what the site tracks: check \`status --index ${index}\` afterwards`);
  const sent = await deliver(c, me, `reject #${index}`, [rejectIx(squadsProgram, ms, index, me.publicKey, a.values.get("memo"))], UNITS.vote);
  if (!sent) return 0;
  const after = await proposalAfter(c, `the rejection of #${index}`, sent.signature, index);
  if (!after.rejected.includes(me.publicKey.toBase58())) say("note: this key's rejection doesn't show yet");
  say(after.status === "Rejected" ? `#${index} is Rejected: closed on-chain, nothing can approve or run it`
    : after.status === "Active" ? `#${index} is still Active, NOT cleared: ${rejectCutoff(q) - after.rejected.length} more rejection(s) close it, and until then it can still be approved`
    : `#${index} reads as ${after.status}, NOT cleared by this rejection: look at it before anything else`);
  return 0;
}

/** A cancel vote on an Approved proposal: a threshold of them makes it Cancelled, and nothing can run it then. */
async function cmdCancel(c: Ctx) {
  const me = await memberFor(c, "cancel");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const p = await readProposal(conn, squadsProgram, ms, index);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index}`);
  const stored = await readStored(c, index);
  say(`stored on-chain for #${index} (decoded from the transaction account):`);
  for (const l of stored.lines) say(`  ${l}`);
  if (p!.status === "Active") refuse(`#${index} is Active: use reject (cancel is for an Approved proposal)`);
  if (p!.status !== "Approved") refuse(`#${index} is ${p!.status}: only an Approved proposal can be cancelled`);
  if (p!.cancelled.includes(me.publicKey.toBase58())) refuse(`this key already cancelled #${index}`);
  const ix = squads.instructions.proposalCancel({ multisigPda: ms, transactionIndex: index, member: me.publicKey, memo: a.values.get("memo"), programId: squadsProgram });
  const sent = await deliver(c, me, `cancel #${index} (${p!.cancelled.length + 1} of ${q.threshold} cancels)`, [ix], UNITS.vote);
  if (!sent) return 0;
  const after = await proposalAfter(c, `the cancel of #${index}`, sent.signature, index);
  if (!after.cancelled.includes(me.publicKey.toBase58())) say("note: this key's cancel doesn't show yet");
  say(after.status === "Cancelled" ? `#${index} is Cancelled: nothing can run it`
    : after.status === "Approved" ? `#${index} is still Approved, NOT cleared: any one member with Execute can still run it; ${q.threshold - after.cancelled.length} more cancel(s) stop it`
    : `#${index} reads as ${after.status}, NOT cleared by this cancel: look at it before anything else`);
  return 0;
}

async function cmdExecute(c: Ctx) {
  const me = await memberFor(c, "execute");
  const { q, say, conn, squadsProgram, ms, a } = c;
  const index = indexArg(a, true)!;
  const snap = await readSnapshot(conn, c, index);
  const p = decodeProposal(squadsProgram, ms, index, snap.proposal);
  say(`\n${proposalLine(q, p, index)}`);
  if (!p) refuse(`no proposal #${index} (closed, or never created)`);
  const stored = await vetStored(c, index, snap, p!.status === "Executed" ? `#${index} was already executed`
    : p!.status !== "Approved" ? `#${index} is ${p!.status}, not Approved: ${p!.approved.length} of ${q.threshold} approvals` : null);
  if (q.timeLock && p!.at !== null && Date.now() / 1000 < p!.at + q.timeLock) refuse(`#${index}'s time lock runs until ${new Date((p!.at + q.timeLock) * 1000).toISOString()}`);
  if (!stored.tx) refuse(`#${index} isn't a vault transaction: this tool can't execute it`);
  // The SDK reads the transaction again to build the instruction. Watch that read: what it sees must be what was checked.
  const txPda = squadsTransactionPda(squadsProgram, ms, index);
  let sdkRead: AccountInfo<Buffer> | null | undefined;
  const watched: Connection = Object.create(conn);
  watched.getAccountInfo = async (k: PublicKey, cfg?: Parameters<Connection["getAccountInfo"]>[1]) => {
    const info = await conn.getAccountInfo(k, cfg);
    if (k.equals(txPda)) sdkRead = info;
    return info;
  };
  let ix: TransactionInstruction;
  try { ix = await executeIx(watched, squadsProgram, ms, index, me.publicKey); } catch (e) { return refuse(`can't build the execute: ${printable(e)}`); }
  if (sdkRead === undefined) refuse("the SDK built the execute without a read this tool could compare: not signing it");
  if (!sameAccount(sdkRead!, snap.tx)) refuse(`the stored transaction changed between the checks above and the SDK's own read (slot ${snap.slot}). It can't change on-chain, so this RPC is answering differently: don't trust it`);
  const tail = ix.keys.slice(-stored.tx!.accountKeys.length).map((m) => m.pubkey);
  if (tail.length !== stored.tx!.accountKeys.length || tail.some((k, i) => !k.equals(stored.tx!.accountKeys[i]))) refuse("the execute instruction's accounts differ from the transaction that was checked: not signing it");
  const shape = stored.shape;
  const vaultBefore = await conn.getBalance(q.vault, "confirmed");
  const sent = await deliver(c, me, `execute #${index} (${shape.kind})`, [ix], UNITS.execute);
  if (!sent) return 0;
  const what = `the execute of #${index}`;
  const after = await proposalAfter(c, what, sent.signature, index);
  if (after.status !== "Executed") throw new Refusal(`#${index} reads back as ${after.status} after a confirmed execute (signature ${sent.signature}): look at it before anything else`);
  await reading(what, sent.signature, async () => {
    const vaultAfter = await conn.getBalance(q.vault, "confirmed");
    say(`vault PDA balance ${xntOf(vaultBefore)} -> ${xntOf(vaultAfter)} XNT${vaultBefore === vaultAfter ? " (unchanged)" : " (CHANGED)"}`);
    if (shape.kind === "memo") {
      if (vaultBefore !== vaultAfter) throw new Refusal("the vault PDA's balance changed on a memo");
      let logs: string[] | null = null;
      for (let i = 0; i < 3 && !logs; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1_000));
        logs = (await conn.getTransaction(sent.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null))?.meta?.logMessages ?? null;
      }
      if (!logs?.some((l) => l.includes(`Signed by ${q.vault.toBase58()}`))) throw unverified(what, sent.signature, `the memo program's log ${logs ? "doesn't show the vault PDA's signature" : "couldn't be read"}`, index);
      say(`the vault PDA signed: the memo program logged "Signed by ${q.vault.toBase58()}"`);
    }
    if (shape.kind === "set-publisher") {
      const vi = await conn.getAccountInfo(shape.vault, "confirmed");
      if (!vi || !vi.owner.equals(c.taxProgram)) throw unverified(what, sent.signature, `the vault account ${shape.vault.toBase58()} doesn't read back`, index);
      const v = decodeVault(shape.vault, vi.data);
      say(`vault ${shape.vault.toBase58()} publisher reads ${v.publisher.toBase58()}`);
      if (!v.publisher.equals(shape.newPublisher)) throw new Refusal(`the vault's publisher did NOT change to ${shape.newPublisher.toBase58()}: look at it before anything else`);
      say(`CONFIRMED: the publisher is now ${shape.newPublisher.toBase58()}`);
      say("Next, for the site (scripts/quorum-action.ts header): if that key is factory.taxVault.publisherKeypair the site publishes with it from its next pass; if not, point publisherKeypair at it and restart, or run scripts/crank.ts --publisher. Then remove factory.taxVault.quorum, restart, and stop the co-signer.");
    }
  });
  return 0;
}

/** The whole command; returns the exit code (0 done or dry run, 1 refused or failed, 2 usage, 3 ambiguous send, 4 confirmed but not verified). */
export async function quorumAction(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
  const scrub = scrubber(argv);
  const d: Deps = { ...deps, out: (l) => deps.out(scrub(l)) };
  try {
    const a = parseArgs(argv);
    if (a.bools.has("help") || !a.sub) { d.out(USAGE); return a.bools.has("help") ? 0 : 2; }
    // The key file is checked before any network call, so a bad one can't get as far as signing.
    if (a.sub !== "status" && a.values.has("keypair")) loadMemberKey(a.values.get("keypair")!);
    if (a.sub === "status" && (a.values.has("keypair") || a.bools.has("execute"))) refuse("status is read-only: it takes no --keypair and no --execute");
    const c = await setup(a, d);
    const run = { status: cmdStatus, "propose-memo": cmdProposeMemo, "propose-set-publisher": cmdProposeSetPublisher, approve: cmdApprove, reject: cmdReject, cancel: cmdCancel, execute: cmdExecute }[a.sub];
    return await run(c);
  } catch (e) {
    if (e instanceof Refusal) { d.out(`REFUSED: ${e.message}`); return 1; }
    if (e instanceof Ambiguous) { d.out(`AMBIGUOUS: ${e.message}`); return 3; }
    if (e instanceof Unverified) { d.out(`VERIFICATION UNAVAILABLE: ${e.message}`); return 4; }
    d.out(`ERROR: ${printable(e)}`);
    return 1;
  }
}
