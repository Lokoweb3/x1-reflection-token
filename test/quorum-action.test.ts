/**
 * scripts/quorum-action.ts without a validator: the pure checks, and the whole command against a
 * fake connection that holds real Squads and vault account bytes and counts what is sent.
 * scripts/quorum-action-rehearsal.ts runs the same refusals against the real program.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as squads from "@sqds/multisig";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  GENESIS_HASH, MAX_MEMO_BYTES, MEMO_PROGRAM_ID, Refusal, classifyVaultTx, expectationProblem, explainFailure, genesisProblem, loadMemberKey, newPublisherProblem, parseArgs,
  SQUADS_PINS, defaultDeps, openProposalsFor, plannedMessageHash, printable, quorumAction, redactRpc, rightsProblem, sameEndpoint, squadsBinaryProblem, storedMessageHash, sendFate, sha256Hex, type Shape,
} from "../src/quorum-action.js";
import {
  SQUADS_PROGRAM_IDS, Permission, Permissions, decodeVaultTx, readQuorum, squadsMultisigPda, squadsProposalPda, squadsTransactionPda, squadsVaultPda, type VaultTx,
} from "../src/squads.js";
import { mockRpc } from "./helpers/mock-rpc.js";
import { TAX_VAULT_PROGRAM_ID, VAULT_LEN, cidFromBytes, cidToBytes, encodeVault, publishListIx, rawCid, setPublisherIx, vaultPda, type Vault } from "../src/taxvault.js";

const SQUADS = SQUADS_PROGRAM_IDS.mainnet;
const TAX = TAX_VAULT_PROGRAM_ID;
const key = () => Keypair.generate().publicKey;
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 });

// Every assert.ok here has a message: a failing one without makes Node re-parse this file for its
// own message (node:internal/assert parseCode, acorn), which spins instead of failing.

// ---------- real account bytes ----------
function storedBytes(ms: PublicKey, index: bigint, ixs: TransactionInstruction[], o: { vaultIndex?: number; ephemeral?: number; payer?: PublicKey } = {}) {
  const vault = o.payer ?? squadsVaultPda(SQUADS, ms, o.vaultIndex ?? 0);
  const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }), vaultPda: vault,
  });
  const [m] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const message = { ...m, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: Uint8Array.from(i.accountIndexes), data: Uint8Array.from(i.data) })),
    addressTableLookups: m.addressTableLookups.map((l) => ({ accountKey: l.accountKey, writableIndexes: Uint8Array.from(l.writableIndexes), readonlyIndexes: Uint8Array.from(l.readonlyIndexes) })) };
  const [data] = squads.accounts.VaultTransaction.fromArgs({ multisig: ms, creator: key(), index: Number(index), bump: 255, vaultIndex: o.vaultIndex ?? 0, vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(o.ephemeral ?? 0), message }).serialize();
  return data;
}
const stored = (ms: PublicKey, index: bigint, ixs: TransactionInstruction[], o: Parameters<typeof storedBytes>[3] = {}): VaultTx =>
  decodeVaultTx(SQUADS, ms, index, info(SQUADS, storedBytes(ms, index, ixs, o)))!;
const memoIx = (signer: PublicKey, text = "hello") => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text) });
function vaultAccount(mint: PublicKey, publisher: PublicKey): Buffer {
  const v: Vault = {
    address: vaultPda(TAX, mint), mint, pool: key(), creatorNft: key(), rewardMint: NATIVE_MINT, rewardSwapPool: key(), publisher, guardian: key(),
    burnBps: 2500, lpBps: 2500, creatorBps: 1000, pendingTokens: 0n, lpTokens: 0n, sellLp: 0n, sellCreator: 0n, sellHolders: 0n, xntLp: 0n, xntCreator: 0n,
    holdersFunded: 0n, holdersPaid: 0n, listEpoch: 3n, listRoot: Buffer.alloc(32), listTotal: 0n, pendingEpoch: 0n, pendingRoot: Buffer.alloc(32), pendingTotal: 0n, pendingActiveAt: 0,
    totalCollected: 0n, totalBurned: 0n, totalLpTokens: 0n, totalLpXnt: 0n, totalCreatorXnt: 0n, totalCrankRewards: 0n,
    createdAt: 1_780_000_000, bump: 255, authBump: 255, lastSellSlot: 0n, version: 3, cancelsInRow: 0, totalRewardOut: 0n, lastRewardSlot: 0n,
    lastPublishAt: 1_790_000_000, listCid: Buffer.alloc(33), pendingCid: Buffer.alloc(33), fallbackPaid: 0n, payoutPool: PublicKey.default, xntHolders: 0n,
  };
  assert.ok(VAULT_LEN > 0, "VAULT_LEN > 0");
  return encodeVault(v);
}

// ---------- a chain to talk to ----------
const ALL = Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]);
const VOTE_EXEC = Permissions.fromPermissions([Permission.Vote, Permission.Execute]);
function world(network: "mainnet" | "testnet" = "testnet", msKey?: PublicKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-action-test-"));
  const file = (k: Keypair, name: string, mode = 0o600) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode }); fs.chmodSync(f, mode); return f; };
  const site = Keypair.generate(), cosigner = Keypair.generate(), backup = Keypair.generate(), outsider = Keypair.generate();
  const ms = msKey ?? key(), vault = squadsVaultPda(SQUADS_PROGRAM_IDS[network], ms), mint = key(), target = Keypair.generate().publicKey;
  const program = SQUADS_PROGRAM_IDS[network];
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const put = (k: PublicKey, owner: PublicKey, data: Buffer) => accounts.set(k.toBase58(), info(owner, data));
  put(vaultPda(TAX, mint), TAX, vaultAccount(mint, vault));
  let txIndex = 0n, staleIndex = 0n;
  const putMultisig = () => put(ms, program, squads.accounts.Multisig.fromArgs({ createKey: key(), configAuthority: PublicKey.default, threshold: 2, timeLock: 0, transactionIndex: Number(txIndex), staleTransactionIndex: Number(staleIndex),
    rentCollector: site.publicKey, bump: 255, members: [{ key: site.publicKey, permissions: ALL }, { key: cosigner.publicKey, permissions: VOTE_EXEC }, { key: backup.publicKey, permissions: ALL }] }).serialize()[0]);
  putMultisig();
  const setStale = (n: bigint) => { staleIndex = n; putMultisig(); };
  const propose = (index: bigint, ix: TransactionInstruction[] | Buffer, status: string, approved: PublicKey[] = [], rejected: PublicKey[] = []) => {
    txIndex = index > txIndex ? index : txIndex; putMultisig();
    put(squadsTransactionPda(program, ms, index), program, Buffer.isBuffer(ix) ? ix : storedFor(index, ix));
    put(squadsProposalPda(program, ms, index), program, squads.accounts.Proposal.fromArgs({ multisig: ms, transactionIndex: Number(index), status: { __kind: status, timestamp: 1_790_000_000 } as never, bump: 255,
      approved, rejected, cancelled: [] }).serialize()[0]);
  };
  const storedFor = (index: bigint, ixs: TransactionInstruction[]) => {
    const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({ message: new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }), vaultPda: vault });
    const [m] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
    const message = { ...m, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: Uint8Array.from(i.accountIndexes), data: Uint8Array.from(i.data) })), addressTableLookups: [] };
    return squads.accounts.VaultTransaction.fromArgs({ multisig: ms, creator: site.publicKey, index: Number(index), bump: 255, vaultIndex: 0, vaultBump: 255, ephemeralSignerBumps: new Uint8Array(), message }).serialize()[0];
  };
  const net = { getTx: null as unknown, slot: 100, sends: 0, sims: 0, genesis: GENESIS_HASH[network], simErr: null as unknown, sendError: null as Error | null, onSend: null as (() => void) | null, onSim: null as (() => void) | null, status: { confirmationStatus: "confirmed", err: null } as unknown };
  const seen = { sims: [] as unknown[], txReads: 0 };
  const hostile = { txPda: null as PublicKey | null, later: null as Buffer | null, failAfterSend: false };
  const read = (k: PublicKey) => {
    if (hostile.failAfterSend && net.sends > 0) throw new Error("fetch failed");
    if (hostile.txPda?.equals(k) && hostile.later && seen.txReads++ > 0) return info(program, hostile.later);
    return accounts.get(k.toBase58()) ?? null;
  };
  const conn = {
    getGenesisHash: async () => net.genesis,
    getAccountInfo: async (k: PublicKey) => read(k),
    getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({ context: { slot: net.slot }, value: ks.map(read) }),
    getBalance: async () => { if (hostile.failAfterSend && net.sends > 0) throw new Error("fetch failed"); return 1_000_000_000; },
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
    simulateTransaction: async (tx: unknown) => { net.sims++; seen.sims.push(tx); net.onSim?.(); return { value: { err: net.simErr, logs: net.simErr ? ["Program x failed: boom"] : [], unitsConsumed: 5_000, accounts: [{ lamports: 999_990_000 }] } }; },
    getFeeForMessage: async () => ({ value: 5_000 }),
    getSignaturesForAddress: async () => [],
    getTransaction: async () => net.getTx,
    getBlockHeight: async () => 1,
    sendRawTransaction: async () => { net.sends++; if (net.sendError) throw net.sendError; net.onSend?.(); return "sig"; },
    getSignatureStatuses: async () => ({ value: [net.status] }),
  };
  const out: string[] = [];
  const verify = { genesis: null as string | null, slot: null as number | null, over: new Map<string, AccountInfo<Buffer>>() };
  const read2 = (k: PublicKey) => verify.over.get(k.toBase58()) ?? accounts.get(k.toBase58()) ?? null;
  const second = {
    ...conn, getGenesisHash: async () => verify.genesis ?? net.genesis, getAccountInfo: async (k: PublicKey) => read2(k),
    getMultipleAccountsInfoAndContext: async (ks: PublicKey[]) => ({ context: { slot: verify.slot ?? net.slot }, value: ks.map(read2) }),
  };
  const run = (...argv: string[]) => quorumAction(argv, { connect: (u) => (u === VERIFY_URL ? second : conn) as unknown as Connection, out: (l) => out.push(l) });
  return { setStale, network, verify, seen, hostile, conn, storedFor, dir, file, site, cosigner, backup, outsider, ms, vault, mint, target, program, propose, net, out, run, put, accounts, text: () => out.join("\n"),
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
type World = ReturnType<typeof world>;
const VERIFY_URL = "https://verify.example";
const base = (w: World, network: string = w.network) => ["--network", network, "--multisig", w.ms.toBase58()];
const setPub = (w: World, to = w.target) => [setPublisherIx(TAX, w.vault, w.mint, to)];

// ---------- decoding ----------
test("classify: the two known shapes, exactly as this tool stores them", () => {
  const ms = key(), v = squadsVaultPda(SQUADS, ms), mint = key(), np = key();
  const m = classifyVaultTx(stored(ms, 1n, [memoIx(v, "check")]), v, TAX) as Extract<Shape, { kind: "memo" }>;
  assert.equal(m.kind, "memo"); assert.equal(m.text, "check"); assert.equal(m.hash, sha256Hex("check"));
  const s = classifyVaultTx(stored(ms, 2n, [setPublisherIx(TAX, v, mint, np)]), v, TAX) as Extract<Shape, { kind: "set-publisher" }>;
  assert.equal(s.kind, "set-publisher"); assert.ok(s.newPublisher.equals(np), "s.newPublisher.equals(np)"); assert.ok(s.vault.equals(vaultPda(TAX, mint)), "s.vault.equals(vaultPda(TAX, mint))");
});

test("classify: a list is named, not treated as a known shape", () => {
  const ms = key(), v = squadsVaultPda(SQUADS, ms);
  const s = classifyVaultTx(stored(ms, 1n, [publishListIx(TAX, v, key(), Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 2))]), v, TAX);
  assert.equal(s.kind, "publish-list");
  assert.ok(expectationProblem(s, {})?.includes("cosigner"), "names the co-signer route");
  assert.equal(expectationProblem(s, { allowUnknown: true }), null);
});

test("classify: anything else is unknown, whatever it looks like", () => {
  const ms = key(), v = squadsVaultPda(SQUADS, ms), other = key(), mint = key();
  const cases: [string, VaultTx][] = [
    ["a transfer out of the vault", stored(ms, 1n, [SystemProgram.transfer({ fromPubkey: v, toPubkey: other, lamports: 1 })])],
    ["two instructions", stored(ms, 1n, [memoIx(v), memoIx(v)])],
    ["memo + set_publisher", stored(ms, 1n, [memoIx(v), setPublisherIx(TAX, v, mint, other)])],
    ["memo with an extra signer", stored(ms, 1n, [new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: v, isSigner: true, isWritable: false }, { pubkey: other, isSigner: true, isWritable: false }], data: Buffer.from("x") })])],
    ["memo with a writable account", stored(ms, 1n, [new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: v, isSigner: true, isWritable: false }, { pubkey: other, isSigner: false, isWritable: true }], data: Buffer.from("x") })])],
    ["memo signed by nobody", stored(ms, 1n, [new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from("x") })])],
    ["memo too long", stored(ms, 1n, [memoIx(v, "x".repeat(MAX_MEMO_BYTES + 1))])],
    ["memo with control characters", stored(ms, 1n, [memoIx(v, "x\u001b[2Jy")])],
    ["set_publisher of another program", stored(ms, 1n, [setPublisherIx(key(), v, mint, other)])],
    ["set_publisher with an extra account", stored(ms, 1n, [new TransactionInstruction({ ...setPublisherIx(TAX, v, mint, other), keys: [...setPublisherIx(TAX, v, mint, other).keys, { pubkey: other, isSigner: false, isWritable: false }] })])],
    ["set_publisher with short data", stored(ms, 1n, [new TransactionInstruction({ ...setPublisherIx(TAX, v, mint, other), data: setPublisherIx(TAX, v, mint, other).data.subarray(0, 39) })])],
    ["ephemeral signers", stored(ms, 1n, [memoIx(v)], { ephemeral: 1 })],
  ];
  for (const [name, tx] of cases) {
    const s = classifyVaultTx(tx, v, TAX);
    assert.equal(s.kind, "unknown", name);
    assert.ok(expectationProblem(s, {}), `${name}: refused without --allow-unknown`);
    assert.equal(expectationProblem(s, { allowUnknown: true }), null, `${name}: allowed with it`);
  }
  // Crafted messages the SDK's compiler wouldn't produce: a key no instruction uses, a stray writable flag.
  for (const tx of [stored(ms, 1n, [memoIx(v)]), stored(ms, 1n, [setPublisherIx(TAX, v, mint, other)])]) {
    const extraKey: VaultTx = { ...tx, accountKeys: [...tx.accountKeys, other] };
    const extraWritable: VaultTx = { ...tx, numWritableNonSigners: tx.numWritableNonSigners + 1 };
    assert.equal(classifyVaultTx(extraKey, v, TAX).kind, "unknown", "an unused account key");
    assert.equal(classifyVaultTx(extraWritable, v, TAX).kind, "unknown", "a stray writable flag");
  }
  // From another vault index of the multisig (its signer isn't the publisher).
  const v1 = squadsVaultPda(SQUADS, ms, 1);
  assert.equal(classifyVaultTx(stored(ms, 1n, [memoIx(v1)], { vaultIndex: 1 }), v, TAX).kind, "unknown");
  // Stored by another multisig's vault.
  const otherMs = key(), ov = squadsVaultPda(SQUADS, otherMs);
  assert.equal(classifyVaultTx(stored(ms, 1n, [memoIx(ov)], { payer: ov }), v, TAX).kind, "unknown");
});

// ---------- expectations ----------
test("expectations: a set_publisher needs the new publisher restated, and it must match", () => {
  const np = key(), mint = key();
  const s: Shape = { kind: "set-publisher", vault: vaultPda(TAX, mint), newPublisher: np };
  assert.match(expectationProblem(s, {})!, /restate the new publisher/);
  assert.match(expectationProblem(s, { allowUnknown: true })!, /restate the new publisher/, "--allow-unknown doesn't excuse it");
  assert.match(expectationProblem(s, { newPublisher: key() })!, /stored instruction sets/);
  assert.equal(expectationProblem(s, { newPublisher: np }), null);
  assert.match(expectationProblem(s, { newPublisher: np, memoHash: "ab" })!, /not a memo/);
  assert.match(expectationProblem(s, { newPublisher: np, mint: key() }, mint)!, /--expect-mint/);
  assert.match(expectationProblem(s, { newPublisher: np, mint }, null)!, /--expect-mint/, "an unreadable vault doesn't pass the mint check");
  assert.equal(expectationProblem(s, { newPublisher: np, mint }, mint), null);
});

test("expectations: a memo's hash is checked when given; flags for the other shape refuse", () => {
  const m: Shape = { kind: "memo", text: "x", hash: sha256Hex("x") };
  assert.equal(expectationProblem(m, {}), null);
  assert.equal(expectationProblem(m, { memoHash: sha256Hex("x") }), null);
  assert.equal(expectationProblem(m, { memoHash: sha256Hex("x").toUpperCase() }), null);
  assert.match(expectationProblem(m, { memoHash: sha256Hex("y") })!, /hashes to/);
  assert.match(expectationProblem(m, { newPublisher: key() })!, /not a set_publisher/);
  assert.match(expectationProblem({ kind: "unknown", reason: "r" }, { newPublisher: key(), allowUnknown: true })!, /--expect flag/);
});

test("new publisher: not the multisig, not the current one, off-curve only if it's this multisig's vault", () => {
  const ms = key(), program = SQUADS, vault = squadsVaultPda(program, ms);
  const chk = (newPublisher: PublicKey, currentPublisher: PublicKey | null = vault, allowOffCurve = false) => newPublisherProblem({ newPublisher, multisig: ms, program, currentPublisher, allowOffCurve });
  assert.match(chk(ms)!, /is the multisig account/);
  assert.match(chk(ms, vault, true)!, /is the multisig account/, "--allow-off-curve doesn't excuse the classic mix-up");
  assert.match(chk(vault)!, /already the vault's publisher/);
  assert.equal(chk(key()), null);
  const foreign = squadsVaultPda(program, key());
  assert.match(chk(foreign)!, /off-curve/);
  assert.equal(chk(foreign, vault, true), null);
  assert.equal(chk(squadsVaultPda(program, ms, 1)), null, "another vault index of this multisig is known");
});

// ---------- genesis ----------
test("genesis: must match --network; only a local URL with --allow-local-rpc may differ", () => {
  const rpc = "https://rpc.example";
  assert.equal(genesisProblem({ network: "mainnet", genesis: GENESIS_HASH.mainnet, rpc, allowLocal: false }), null);
  assert.equal(genesisProblem({ network: "testnet", genesis: GENESIS_HASH.testnet, rpc, allowLocal: false }), null);
  assert.match(genesisProblem({ network: "mainnet", genesis: GENESIS_HASH.testnet, rpc, allowLocal: false })!, /is X1 testnet/);
  assert.match(genesisProblem({ network: "testnet", genesis: GENESIS_HASH.mainnet, rpc, allowLocal: false })!, /is X1 mainnet/);
  assert.match(genesisProblem({ network: "mainnet", genesis: GENESIS_HASH.testnet, rpc: "http://127.0.0.1:9", allowLocal: true })!, /is X1 testnet/, "--allow-local-rpc doesn't excuse the other real network");
  assert.match(genesisProblem({ network: "mainnet", genesis: "local", rpc: "http://127.0.0.1:9", allowLocal: false })!, /--allow-local-rpc/);
  assert.match(genesisProblem({ network: "mainnet", genesis: "local", rpc, allowLocal: true })!, /isn't/);
  assert.equal(genesisProblem({ network: "mainnet", genesis: "local", rpc: "http://127.0.0.1:9", allowLocal: true }), null);
  assert.equal(genesisProblem({ network: "mainnet", genesis: "local", rpc: "http://localhost:9", allowLocal: true }), null);
  assert.ok(genesisProblem({ network: "mainnet", genesis: "local", rpc: "http://127.0.0.1.evil.example:9", allowLocal: true }), "genesisProblem({ network: mainnet, genesis: local, rpc: http");
});

test("command: --network is required, and a wrong network refuses before anything else", async () => {
  const w = world("mainnet");
  assert.equal(await w.run("status", "--multisig", w.ms.toBase58()), 1);
  assert.match(w.text(), /--network testnet\|mainnet is required/);
  w.out.length = 0;
  w.net.genesis = GENESIS_HASH.testnet;
  assert.equal(await w.run("status", ...base(w, "mainnet")), 1);
  assert.match(w.text(), /REFUSED: --network mainnet, but .* is X1 testnet/);
  assert.equal(w.net.sends + w.net.sims, 0);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w), "--squads-program", key().toBase58()), 1);
  assert.match(w.text(), /only for a local validator/);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w), "--program", key().toBase58()), 1);
  assert.match(w.text(), /--program on mainnet/);
  w.done();
});

test("command: the network routes the Squads program; a multisig of the other deployment doesn't read", async () => {
  const w = world("mainnet");
  assert.equal(await w.run("status", ...base(w)), 0);
  assert.match(w.text(), new RegExp(`Squads    ${SQUADS_PROGRAM_IDS.mainnet.toBase58()}`));
  w.out.length = 0;
  w.net.genesis = GENESIS_HASH.testnet;
  assert.equal(await w.run("status", ...base(w, "testnet")), 1);
  assert.match(w.text(), new RegExp(`isn't a Squads multisig of ${SQUADS_PROGRAM_IDS.testnet.toBase58()}`));
  w.done();
});

// ---------- arguments ----------
test("arguments: strict about what would otherwise change the action", () => {
  assert.throws(() => parseArgs(["approve", "--excute"]), /unknown flag/);
  assert.ok(new Refusal("x") instanceof Error, "new Refusal(x) instanceof Error");
  assert.throws(() => parseArgs(["approve", "--keypair", "--execute"]), /needs a value/);
  assert.throws(() => parseArgs(["approve", "--index", "1", "--index", "2"]), /twice/);
  assert.throws(() => parseArgs(["vote"]), /unknown subcommand/);
  assert.throws(() => parseArgs(["approve", "reject"]), /unexpected argument/);
  assert.ok(parseArgs(["approve", "--execute", "--index", "2"]).bools.has("execute"), "parseArgs([approve, --execute, --index, 2]).bools.has(execut");
});

// ---------- keys ----------
test("keys: refuses a readable file; never echoes a bad file's contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-action-key-"));
  const k = Keypair.generate();
  const f = path.join(dir, "k.json");
  fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  assert.ok(loadMemberKey(f).publicKey.equals(k.publicKey), "loadMemberKey(f).publicKey.equals(k.publicKey)");
  for (const mode of [0o640, 0o604, 0o660, 0o644]) {
    fs.chmodSync(f, mode);
    assert.throws(() => loadMemberKey(f), /readable by group or others/, mode.toString(8));
  }
  fs.chmodSync(f, 0o600);
  const secret = "SECRETCONTENTS";
  fs.writeFileSync(f, `[${secret}`);
  assert.throws(() => loadMemberKey(f), (e: Error) => !e.message.includes(secret) && /isn't a keypair file/.test(e.message));
  fs.writeFileSync(f, JSON.stringify(Array.from(Buffer.alloc(64, 1))));
  assert.throws(() => loadMemberKey(f), /isn't a valid keypair/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("command: a group-readable key is refused before any RPC call", async () => {
  const w = world();
  let connected = false;
  const code = await quorumAction(["approve", ...base(w), "--index", "1", "--keypair", w.file(w.site, "loose", 0o644)], { connect: () => { connected = true; throw new Error("no"); }, out: (l) => w.out.push(l) });
  assert.equal(code, 1); assert.equal(connected, false);
  assert.match(w.text(), /readable by group or others/);
  w.done();
});

// ---------- member rights ----------
test("rights: named per action", () => {
  const me = key();
  const q = (p: Partial<{ initiate: boolean; vote: boolean; execute: boolean }>) => ({ members: [{ key: me.toBase58(), initiate: false, vote: false, execute: false, ...p }] });
  assert.match(rightsProblem(q({}), key(), "approve")!, /isn't a member/);
  assert.match(rightsProblem(q({ vote: true }), me, "propose")!, /no initiate/);
  assert.match(rightsProblem(q({ initiate: true }), me, "propose")!, /no vote.*also casts/);
  assert.equal(rightsProblem(q({ initiate: true, vote: true }), me, "propose"), null);
  assert.match(rightsProblem(q({ initiate: true, execute: true }), me, "approve")!, /no vote/);
  assert.match(rightsProblem(q({ initiate: true, execute: true }), me, "reject")!, /no vote/);
  assert.equal(rightsProblem(q({ vote: true }), me, "approve"), null);
  assert.match(rightsProblem(q({ vote: true, initiate: true }), me, "execute")!, /no execute/);
  assert.equal(rightsProblem(q({ execute: true }), me, "execute"), null);
});

test("command: non-members and the co-signer's missing Initiate are refused with nothing simulated", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  for (const [args, re] of [
    [["propose-memo", "--keypair", w.file(w.outsider, "o")], /isn't a member/],
    [["propose-memo", "--keypair", w.file(w.cosigner, "c")], /no initiate/],
    [["approve", "--index", "1", "--keypair", w.file(w.outsider, "o2")], /isn't a member/],
    [["reject", "--index", "1", "--keypair", w.file(w.outsider, "o3")], /isn't a member/],
    [["execute", "--index", "1", "--keypair", w.file(w.outsider, "o4")], /isn't a member/],
  ] as [string[], RegExp][]) {
    w.out.length = 0;
    assert.equal(await w.run(args[0], ...base(w), ...args.slice(1)), 1, args.join(" "));
    assert.match(w.text(), re);
  }
  assert.equal(w.net.sims + w.net.sends, 0);
  w.done();
});

// ---------- dry run / sending ----------
test("command: without --execute nothing is sent, for every subcommand, and the simulation is reported", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault, "m")], "Active", [w.site.publicKey]);
  w.propose(2n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  const site = w.file(w.site, "s"), backup = w.file(w.backup, "b");
  const dry: string[][] = [
    ["propose-memo", ...base(w), "--keypair", site],
    ["propose-set-publisher", ...base(w), "--keypair", site, "--mint", w.mint.toBase58(), "--new-publisher", w.target.toBase58()],
    ["approve", ...base(w), "--keypair", backup, "--index", "1"],
    ["reject", ...base(w), "--keypair", backup, "--index", "1"],
    ["execute", ...base(w), "--keypair", backup, "--index", "2", "--expect-new-publisher", w.target.toBase58()],
  ];
  for (const argv of dry) {
    w.out.length = 0;
    const sims = w.net.sims;
    assert.equal(await w.run(...argv), 0, `${argv[0]}: ${w.text()}`);
    assert.ok(w.net.sims > sims, `${argv[0]} simulated`);
    assert.match(w.text(), /DRY RUN/); assert.match(w.text(), /simulation OK/); assert.match(w.text(), /expected fee/); assert.match(w.text(), /nothing was signed or sent/);
    assert.equal(w.net.sends, 0, `${argv[0]} sent nothing`);
  }
  w.done();
});

test("command: --execute sends once, then a proposal that doesn't read back is unverified, not resent", async () => {
  const w = world();
  assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.site, "s"), "--text", "hi", "--execute"), 4);
  assert.equal(w.net.sends, 1);
  assert.match(w.text(), /SENDING/); assert.match(w.text(), /doesn't read back/); assert.match(w.text(), /Do NOT re-propose/);
  w.done();
});

test("command: an executed set_publisher is confirmed from the vault, and a vault that didn't change is an error", async () => {
  const w = world();
  w.propose(1n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  const args = ["execute", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--expect-new-publisher", w.target.toBase58(), "--execute"];
  // The chain: the proposal becomes Executed but the vault's publisher stays.
  w.net.onSend = () => w.propose(1n, setPub(w), "Executed", [w.site.publicKey, w.backup.publicKey]);
  assert.equal(await w.run(...args), 1);
  assert.match(w.text(), /did NOT change/);
  assert.doesNotMatch(w.text(), /CONFIRMED: the publisher/);
  // And when it does change.
  w.out.length = 0;
  w.propose(1n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.net.onSend = () => { w.propose(1n, setPub(w), "Executed", [w.site.publicKey, w.backup.publicKey]); w.put(vaultPda(TAX, w.mint), TAX, vaultAccount(w.mint, w.target)); };
  assert.equal(await w.run(...args), 0, w.text());
  assert.match(w.text(), new RegExp(`CONFIRMED: the publisher is now ${w.target.toBase58()}`));
  assert.match(w.text(), /publisherKeypair/, "says what the site needs");
  assert.equal(w.net.sends, 2);
  w.done();
});

test("command: an approve reads back and says when the threshold is met", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  w.net.onSend = () => w.propose(1n, [memoIx(w.vault)], "Approved", [w.site.publicKey, w.backup.publicKey]);
  assert.equal(await w.run("approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--execute"), 0, w.text());
  assert.match(w.text(), /read back: #1 Approved: 2 of 2/); assert.match(w.text(), /threshold met/);
  w.done();
});

test("command: a failing simulation sends nothing, even with --execute", async () => {
  const w = world();
  w.net.simErr = { InstructionError: [0, { Custom: 6000 }] };
  assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.site, "s"), "--execute"), 1);
  assert.match(w.text(), /simulation FAILED/);
  assert.equal(w.net.sends, 0);
  w.done();
});

test("command: another proposal taking the index is named, and nothing is sent", async () => {
  const w = world();
  w.net.simErr = { InstructionError: [2, { Custom: 2006 }] };
  w.net.onSim = () => w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.backup, "b"), "--execute"), 1);
  assert.match(w.text(), /another proposal took #1/); assert.match(w.text(), /run it again/);
  assert.equal(w.net.sends, 0);
  w.done();
});

test("command: an ambiguous send says so, exits 3, and doesn't resend", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  w.net.sendError = new Error("fetch failed: ECONNRESET");
  assert.equal(await w.run("approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--execute"), 3);
  assert.match(w.text(), /AMBIGUOUS: .*It may still land: run `status --index n`/);
  assert.match(w.text(), /Nothing was or will be resent/);
  assert.equal(w.net.sends, 1);
  w.done();
});

test("sendFate: only an explicit failure counts as failed", () => {
  assert.equal(sendFate(new Error("Transaction abc failed: {\"InstructionError\":[0,\"x\"]}")), "failed");
  assert.equal(sendFate(new Error("Simulation failed: {}")), "failed");
  assert.equal(sendFate(new Error("Transaction abc expired before it confirmed")), "ambiguous");
  assert.equal(sendFate(new Error("Transaction abc not confirmed within 120s (it may still land)")), "ambiguous");
  assert.equal(sendFate(new Error("fetch failed")), "ambiguous");
});

test("explainFailure: names the program that refused (the Anchor codes overlap)", () => {
  const ms = SQUADS, tax = TAX;
  const inner = [`Program ${ms} invoke [1]`, `Program ${tax} invoke [2]`, `Program ${tax} failed: custom program error: 0x1771`, `Program ${ms} failed: custom program error: 0x1771`];
  assert.match(explainFailure(inner, ms, tax)!, /^tax_vault: /);
  const outer = [`Program ${ms} failed: custom program error: 0x1771`];
  assert.match(explainFailure(outer, ms, tax)!, /^Squads: /);
  assert.equal(explainFailure(["nothing"], ms, tax), null);
  assert.equal(explainFailure([`Program ${ms} failed: custom program error: 0x7d6`], ms, tax), "Squads: ConstraintSeeds", "Anchor's own codes are named too");
});

// ---------- approve and execute against stored transactions ----------
test("command: approve and execute refuse an unknown shape; --allow-unknown warns loudly", async () => {
  const w = world();
  const transfer = SystemProgram.transfer({ fromPubkey: w.vault, toPubkey: w.outsider.publicKey, lamports: 1 });
  w.propose(1n, [transfer], "Active", [w.site.publicKey]);
  w.propose(2n, [transfer], "Approved", [w.site.publicKey, w.cosigner.publicKey]);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "1"), 1);
  assert.match(w.text(), /stored on-chain for #1/); assert.match(w.text(), /11111111111111111111111111111111/, "it prints the stored program");
  assert.match(w.text(), /REFUSED: this isn't one of the two known shapes/);
  w.out.length = 0;
  assert.equal(await w.run("execute", ...base(w), "--keypair", backup, "--index", "2"), 1);
  assert.match(w.text(), /REFUSED: this isn't one of the two known shapes/);
  assert.equal(w.net.sims, 0);
  w.out.length = 0;
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "1", "--allow-unknown"), 0);
  assert.match(w.text(), /WARNING: --allow-unknown/);
  w.out.length = 0;
  assert.equal(await w.run("execute", ...base(w), "--keypair", backup, "--index", "2", "--allow-unknown"), 0, w.text());
  assert.match(w.text(), /WARNING: --allow-unknown/); assert.match(w.text(), /nothing was signed or sent/);
  assert.equal(w.net.sends, 0);
  w.done();
});

test("command: approve and execute of a set_publisher require and check --expect-new-publisher", async () => {
  const w = world();
  w.propose(1n, setPub(w), "Active", [w.site.publicKey]);
  w.propose(2n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  const backup = w.file(w.backup, "b");
  for (const [sub, index] of [["approve", "1"], ["execute", "2"]]) {
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", index), 1);
    assert.match(w.text(), /restate the new publisher/);
    assert.match(w.text(), new RegExp(`NEW publisher     ${w.target.toBase58()}`), "the stored one is decoded and printed");
    assert.match(w.text(), new RegExp(`current publisher ${w.vault.toBase58()}`));
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", index, "--expect-new-publisher", key().toBase58()), 1);
    assert.match(w.text(), /stored instruction sets/);
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", index, "--expect-new-publisher", w.target.toBase58()), 0, w.text());
  }
  assert.equal(w.net.sends, 0);
  w.done();
});

test("command: a stored set_publisher to the multisig itself or off-curve is refused at the vote too", async () => {
  const w = world();
  w.propose(1n, setPub(w, w.ms), "Active", [w.site.publicKey]);
  const foreign = squadsVaultPda(w.program, key());
  w.propose(2n, setPub(w, foreign), "Active", [w.site.publicKey]);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "1", "--expect-new-publisher", w.ms.toBase58()), 1);
  assert.match(w.text(), /is the multisig account/);
  w.out.length = 0;
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "2", "--expect-new-publisher", foreign.toBase58()), 1);
  assert.match(w.text(), /off-curve/);
  w.out.length = 0;
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "2", "--expect-new-publisher", foreign.toBase58(), "--allow-off-curve"), 0);
  w.done();
});

test("command: propose-set-publisher refuses the multisig, the current publisher, a vault it doesn't publish", async () => {
  const w = world();
  const site = w.file(w.site, "s");
  const go = (to: string, mint = w.mint.toBase58()) => w.run("propose-set-publisher", ...base(w), "--keypair", site, "--mint", mint, "--new-publisher", to);
  assert.equal(await go(w.ms.toBase58()), 1); assert.match(w.text(), /is the multisig account/);
  w.out.length = 0;
  assert.equal(await go(w.vault.toBase58()), 1); assert.match(w.text(), /already the vault's publisher/);
  w.out.length = 0;
  assert.equal(await go(w.target.toBase58(), key().toBase58()), 1); assert.match(w.text(), /no Tax Vault/);
  w.out.length = 0;
  const other = key();
  w.put(vaultPda(TAX, other), TAX, vaultAccount(other, key()));
  assert.equal(await go(w.target.toBase58(), other.toBase58()), 1); assert.match(w.text(), /this multisig can't change it/);
  assert.equal(w.net.sims, 0);
  w.done();
});

test("command: status of proposals: execute before threshold, double execute, closed, votes by the wrong status", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  w.propose(2n, [memoIx(w.vault)], "Executed", [w.site.publicKey, w.backup.publicKey]);
  w.propose(3n, [memoIx(w.vault)], "Rejected", [w.site.publicKey], [w.cosigner.publicKey, w.backup.publicKey]);
  const site = w.file(w.site, "s"), backup = w.file(w.backup, "b");
  const go = async (...a: string[]) => { w.out.length = 0; return w.run(...a); };
  assert.equal(await go("execute", ...base(w), "--keypair", backup, "--index", "1"), 1); assert.match(w.text(), /is Active, not Approved: 1 of 2/);
  assert.equal(await go("execute", ...base(w), "--keypair", backup, "--index", "2"), 1); assert.match(w.text(), /already executed/);
  assert.equal(await go("execute", ...base(w), "--keypair", backup, "--index", "9"), 1); assert.match(w.text(), /no proposal #9/);
  assert.equal(await go("approve", ...base(w), "--keypair", backup, "--index", "3"), 1); assert.match(w.text(), /is Rejected: only an Active/);
  assert.equal(await go("approve", ...base(w), "--keypair", site, "--index", "1"), 1); assert.match(w.text(), /already approved/);
  assert.equal(await go("reject", ...base(w), "--keypair", backup, "--index", "2"), 1); assert.match(w.text(), /is Executed: only an Active/);
  assert.equal(w.net.sims, 0);
  w.done();
});

test("command: status needs no keypair and describes each shape; refuses --keypair and --execute", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault, "proof")], "Executed", [w.site.publicKey, w.backup.publicKey]);
  w.propose(2n, setPub(w), "Active", [w.site.publicKey], [w.cosigner.publicKey]);
  w.propose(3n, [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))], "Active", [w.site.publicKey]);
  w.propose(4n, [SystemProgram.transfer({ fromPubkey: w.vault, toPubkey: w.outsider.publicKey, lamports: 1 })], "Active", [w.site.publicKey]);
  assert.equal(await w.run("status", ...base(w)), 0);
  const t = w.text();
  assert.match(t, /threshold 2 of 3 voters \(rejections that close a proposal: 2\)/);
  assert.match(t, new RegExp(`vault PDA ${w.vault.toBase58()}`));
  assert.match(t, /config authority none/); assert.match(t, /time lock 0 s/);
  assert.match(t, /#1 Executed: 2 of 2 approvals.*memo "proof"/);
  assert.match(t, new RegExp(`#2 Active: 1 of 2 approvals, 1 of 2 rejections.*set_publisher to ${w.target.toBase58()}`));
  assert.match(t, /#3 Active.*list 4/);
  assert.match(t, /#4 Active.*unknown/);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w), "--index", "2"), 0);
  assert.match(w.text(), /approved by/); assert.match(w.text(), /rejected by/); assert.match(w.text(), /NEW publisher/); assert.match(w.text(), /needs 1 more approval/);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w), "--execute"), 1);
  assert.equal(await w.run("status", ...base(w), "--keypair", "/nope"), 1);
  assert.equal(w.net.sends, 0);
  w.done();
});

// ---------- the review's claims ----------
const sigsOf = (tx: unknown): Uint8Array[] => {
  const t = tx as { signatures: (Uint8Array | { signature: Uint8Array | null })[] };
  return t.signatures.map((x) => (x instanceof Uint8Array ? x : x.signature ?? new Uint8Array(64)));
};
const allZero = (b: Uint8Array) => b.every((x) => x === 0);

test("claim 1: a dry run hands the RPC nothing signed (fake chain)", async () => {
  const w = world("mainnet");
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  assert.equal(await w.run("approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--single-rpc-accepted"), 0, w.text());
  assert.ok(w.seen.sims.length > 0, "it simulated");
  for (const tx of w.seen.sims) for (const sig of sigsOf(tx)) assert.ok(allZero(sig), "no usable signature in a simulation");
  w.done();
});

/** A JSON-RPC server over the fake chain's accounts, for the real Connection and its wire format. */
async function realPathRpc(w: World) {
  const wire = { simulated: [] as string[], simOptions: [] as Record<string, unknown>[], sent: [] as string[] };
  const enc = (a: AccountInfo<Buffer> | undefined) => (a ? { data: [a.data.toString("base64"), "base64"], executable: false, lamports: a.lamports, owner: a.owner.toBase58(), rentEpoch: 0, space: a.data.length } : null);
  const ctx = (value: unknown) => ({ context: { slot: 100, apiVersion: "2.0.0" }, value });
  const rpc = await mockRpc((method, params) => {
    if (method === "getGenesisHash") return w.net.genesis;
    if (method === "getAccountInfo") return ctx(enc(w.accounts.get(params[0])));
    if (method === "getMultipleAccounts") return ctx((params[0] as string[]).map((k) => enc(w.accounts.get(k))));
    if (method === "getBalance") return ctx(1_000_000_000);
    if (method === "getLatestBlockhash") return ctx({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1000 });
    if (method === "getFeeForMessage") return ctx(5000);
    if (method === "getBlockHeight") return 1;
    if (method === "getSignatureStatuses") return ctx([{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }]);
    if (method === "getSignaturesForAddress") return [];
    if (method === "getTransaction") return null;
    if (method === "simulateTransaction") { wire.simulated.push(params[0]); wire.simOptions.push(params[1]); return ctx({ err: null, logs: [], unitsConsumed: 5000, accounts: [{ lamports: 999_990_000, owner: "11111111111111111111111111111111", data: ["", "base64"], executable: false, rentEpoch: 0 }] }); }
    if (method === "sendTransaction") { wire.sent.push(params[0]); return "1".repeat(64); }
    return undefined;
  });
  return { rpc, wire };
}
const wireSigs = (b64: string) => { const b = Buffer.from(b64, "base64"); const n = b[0]; return Array.from({ length: n }, (_, i) => b.subarray(1 + 64 * i, 65 + 64 * i)); };

test("claim 1: the real path: simulateTransaction on the wire carries only zero signatures; --execute sends one signed transaction", async () => {
  const w = world("testnet");
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  const { rpc, wire } = await realPathRpc(w);
  const out: string[] = [];
  const deps = { connect: defaultDeps().connect, out: (l: string) => out.push(l) };
  const args = ["approve", "--network", "testnet", "--rpc", rpc.url, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1"];
  assert.equal(await quorumAction(args, deps), 0, out.join("\n"));
  assert.ok(wire.simulated.length > 0, "it simulated over the wire");
  for (const t of wire.simulated) for (const sig of wireSigs(t)) assert.ok(allZero(sig), "a simulation carried a real signature");
  for (const o of wire.simOptions) assert.equal(o.sigVerify, false, "simulated without signature checks");
  assert.equal(wire.sent.length, 0, "the dry run sent nothing");
  wire.simulated.length = 0;
  assert.equal(await quorumAction([...args, "--execute"], deps), 0, out.join("\n"));
  for (const t of wire.simulated) for (const sig of wireSigs(t)) assert.ok(allZero(sig), "--execute's own simulations are unsigned too");
  assert.equal(wire.sent.length, 1, "--execute sends once");
  assert.ok(!allZero(wireSigs(wire.sent[0])[0]), "and that one is signed");
  await rpc.close();
  w.done();
});

test("claim 2: on mainnet approve and execute need a second read, or a loud acceptance", async () => {
  const w = world("mainnet");
  w.propose(1n, setPub(w), "Active", [w.site.publicKey]);
  w.propose(2n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  const backup = w.file(w.backup, "b"), e = ["--expect-new-publisher", w.target.toBase58()];
  for (const [sub, i] of [["approve", "1"], ["execute", "2"]]) {
    w.out.length = 0;
    const sims = w.net.sims;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", i, ...e), 1, `${sub} with one RPC on mainnet`);
    assert.match(w.text(), /--verify-rpc/);
    assert.equal(w.net.sims, sims, "refused before simulating");
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", i, ...e, "--single-rpc-accepted"), 0, w.text());
    assert.match(w.text(), /WARNING: --single-rpc-accepted/);
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", i, ...e, "--verify-rpc", VERIFY_URL), 0, w.text());
    assert.match(w.text(), /second read OK: https:\/\/verify\.example/);
    assert.doesNotMatch(w.text(), /WARNING: --single-rpc-accepted/);
  }
  w.done();
});

test("claim 2: a second read that differs refuses; the checks on what makes it a second read", async () => {
  const w = world();
  w.propose(1n, setPub(w), "Active", [w.site.publicKey]);
  const txKey = squadsTransactionPda(w.program, w.ms, 1n), propKey = squadsProposalPda(w.program, w.ms, 1n);
  const backup = w.file(w.backup, "b");
  const go = async (...more: string[]) => { w.out.length = 0; return w.run("approve", ...base(w), "--keypair", backup, "--index", "1", "--expect-new-publisher", w.target.toBase58(), ...more); };
  const second = ["--verify-rpc", VERIFY_URL];
  assert.equal(await go(...second), 0, w.text());
  // The classic: the same accounts, another target in the data.
  w.verify.over.set(txKey.toBase58(), info(w.program, w.storedFor(1n, setPub(w, key()))));
  const sims = w.net.sims;
  assert.equal(await go(...second), 1); assert.match(w.text(), /disagree about the stored transaction's bytes/);
  assert.equal(w.net.sims, sims, "refused before simulating");
  w.verify.over.clear();
  // Proposal state.
  w.verify.over.set(propKey.toBase58(), info(w.program, squads.accounts.Proposal.fromArgs({ multisig: w.ms, transactionIndex: 1, status: { __kind: "Rejected", timestamp: 1 } as never, bump: 255, approved: [], rejected: [], cancelled: [] }).serialize()[0]));
  assert.equal(await go(...second), 1); assert.match(w.text(), /disagree about the proposal's state/);
  w.verify.over.clear();
  // The multisig: another threshold.
  w.verify.over.set(w.ms.toBase58(), info(w.program, squads.accounts.Multisig.fromArgs({ createKey: key(), configAuthority: PublicKey.default, threshold: 1, timeLock: 0, transactionIndex: 1, staleTransactionIndex: 0, rentCollector: null, bump: 255, members: [] }).serialize()[0]));
  assert.equal(await go(...second), 1); assert.match(w.text(), /disagree about the multisig's members/);
  w.verify.over.clear();
  // The vault's publisher.
  w.verify.over.set(vaultPda(TAX, w.mint).toBase58(), info(TAX, vaultAccount(w.mint, key())));
  assert.equal(await go(...second), 1); assert.match(w.text(), /disagree about the vault's publisher/);
  w.verify.over.clear();
  // Behind the first read.
  w.verify.slot = 99;
  assert.equal(await go(...second), 1); assert.match(w.text(), /is behind/);
  w.verify.slot = 101;
  assert.equal(await go(...second), 0, "ahead of the first read is fine");
  w.verify.slot = null;
  // Another chain.
  w.verify.genesis = GENESIS_HASH.mainnet;
  assert.equal(await go(...second), 1); assert.match(w.text(), /--verify-rpc: .*is X1 mainnet/);
  w.verify.genesis = null;
  // Not a second opinion.
  assert.equal(await go("--verify-rpc", "https://rpc.testnet.x1.xyz/other?key=1"), 1); assert.match(w.text(), /same host and port/);
  assert.equal(await go(...second, "--single-rpc-accepted"), 1); assert.match(w.text(), /contradict/);
  // REFLECT_RPC_URL would redirect the second connection to the first.
  process.env.REFLECT_RPC_URL = "https://rpc.testnet.x1.xyz";
  try { assert.equal(await go(...second), 1); assert.match(w.text(), /wouldn't reach a second RPC/); } finally { delete process.env.REFLECT_RPC_URL; }
  w.done();
});

test("claim 2: the message hash is what the proposer built, and --expect-message-hash checks it", async () => {
  const w = world();
  const ix = setPub(w)[0];
  w.propose(1n, [ix], "Active", [w.site.publicKey]);
  const stored = w.accounts.get(squadsTransactionPda(w.program, w.ms, 1n).toBase58())!;
  const planned = plannedMessageHash(w.ms, w.vault, ix, w.program, 1n);
  assert.equal(storedMessageHash(stored, w.ms, 1n), planned, "stored and locally built agree");
  assert.notEqual(plannedMessageHash(w.ms, w.vault, setPub(w, key())[0], w.program, 1n), planned, "another target, another hash");
  const backup = w.file(w.backup, "b");
  const args = ["approve", ...base(w), "--keypair", backup, "--index", "1", "--expect-new-publisher", w.target.toBase58()];
  assert.equal(await w.run(...args, "--expect-message-hash", planned), 0, w.text());
  assert.match(w.text(), new RegExp(`message hash ${planned}`));
  w.out.length = 0;
  assert.equal(await w.run(...args, "--expect-message-hash", "ab".repeat(32)), 1);
  assert.match(w.text(), /--expect-message-hash is/);
  w.done();
});

test("claim 2: execute refuses when the SDK's own read differs from the snapshot that was checked", async () => {
  const w = world("testnet");
  w.propose(1n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.hostile.txPda = squadsTransactionPda(w.program, w.ms, 1n);
  w.hostile.later = w.storedFor(1n, setPub(w, key()));
  assert.equal(await w.run("execute", ...base(w, "testnet"), "--keypair", w.file(w.backup, "b"), "--index", "1", "--expect-new-publisher", w.target.toBase58()), 1, w.text());
  assert.match(w.text(), /changed between|differs from/);
  assert.equal(w.net.sims, 0);
  w.done();
});

test("claim 3: --allow-unknown shows the whole payload, with accounts resolved", async () => {
  const w = world("testnet");
  const data = Buffer.alloc(300, 0xab);
  const other = key();
  const weird = new TransactionInstruction({ programId: other, keys: [{ pubkey: w.vault, isSigner: true, isWritable: true }, { pubkey: w.target, isSigner: false, isWritable: true }], data });
  w.propose(1n, [weird], "Active", [w.site.publicKey]);
  assert.equal(await w.run("approve", ...base(w, "testnet"), "--keypair", w.file(w.backup, "b"), "--index", "1", "--allow-unknown"), 0, w.text());
  assert.ok(w.text().includes(`data ${data.toString("hex")}`), "the instruction's data is printed in full, by instruction");
  assert.match(w.text(), /complete stored message [0-9a-f]{600,}/, "and the whole stored message");
  assert.match(w.text(), new RegExp(`${w.target.toBase58()} writable`), "accounts are resolved");
  assert.match(w.text(), /message hash [0-9a-f]{64}/, "a fingerprint is printed");
  w.done();
});

test("claim 4: local-only overrides are refused when the endpoint reports a real network, even at localhost", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const w = world(network);
    const local = ["--allow-local-rpc", "--rpc", "http://127.0.0.1:9"];
    assert.equal(await w.run("status", "--network", network, "--multisig", w.ms.toBase58(), ...local, "--squads-program", w.program.toBase58()), 1, `${network} --squads-program: ${w.text()}`);
    assert.match(w.text(), /reports X1|is X1/);
    w.out.length = 0;
    assert.equal(await w.run("status", "--network", network, "--multisig", w.ms.toBase58(), ...local), 1, `${network} --allow-local-rpc alone: ${w.text()}`);
    w.done();
  }
  const m = world();
  assert.equal(await m.run("status", "--network", "mainnet", "--multisig", m.ms.toBase58(), "--allow-local-rpc", "--rpc", "http://127.0.0.1:9", "--program", key().toBase58()), 1, m.text());
  m.done();
});

test("claim 5: a read failing after a confirmed send reports the confirmation first, with a distinct exit code", async () => {
  const w = world("testnet");
  w.hostile.failAfterSend = true;
  const code = await w.run("propose-memo", ...base(w, "testnet"), "--keypair", w.file(w.site, "s"), "--text", "hi", "--execute");
  assert.equal(code, 4, w.text());
  assert.match(w.text(), /CONFIRMED/); assert.match(w.text(), /proposal #1/); assert.match(w.text(), /verification unavailable/i);
  assert.match(w.text(), /do NOT (re-?propose|resend|send it again)/i);
  assert.doesNotMatch(w.text(), /^ERROR/m);
  assert.equal(w.net.sends, 1);
  w.done();
});

test("claim 6: the open-list note doesn't say a stranded list can never execute", async () => {
  const w = world("testnet");
  w.propose(1n, [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))], "Active", [w.site.publicKey]);
  assert.equal(await w.run("propose-set-publisher", ...base(w, "testnet"), "--keypair", w.file(w.backup, "b"), "--mint", w.mint.toBase58(), "--new-publisher", w.target.toBase58()), 0, w.text());
  assert.match(w.text(), /note: list proposal #1 is open/);
  assert.doesNotMatch(w.text(), /never execute/);
  assert.match(w.text(), /while the publisher differs/);
  assert.match(w.text(), /before .*(returns|restor)/);
  w.done();
});

test("claim 8: an RPC URL's secret never reaches the output, including errors", async () => {
  const secret = "SECRETKEY123", url = `https://user:${secret}@rpc.example/v1/${secret}?api-key=${secret}`;
  const w = world("mainnet");
  // a refusal naming the URL: wrong genesis
  w.net.genesis = "local";
  assert.equal(await w.run("status", ...base(w), "--rpc", url), 1);
  assert.ok(!w.text().includes(secret), w.text());
  assert.match(w.text(), /rpc\.example/);
  // an error from the connection quoting it
  w.out.length = 0;
  const code = await quorumAction(["status", ...base(w), "--rpc", url], { connect: () => { throw new Error(`request to ${url} failed`); }, out: (l) => w.out.push(l) });
  assert.equal(code, 1);
  assert.ok(!w.text().includes(secret), w.text());
  // the env override's value
  w.out.length = 0;
  process.env.REFLECT_RPC_URL = `https://other.example/${secret}`;
  try { assert.equal(await w.run("status", ...base(w), "--rpc", url), 1); } finally { delete process.env.REFLECT_RPC_URL; }
  assert.ok(!w.text().includes(secret), w.text());
  // and a successful run's header
  w.out.length = 0; w.net.genesis = GENESIS_HASH.mainnet;
  assert.equal(await w.run("status", ...base(w), "--rpc", url), 0, w.text());
  assert.ok(!w.text().includes(secret), w.text());
  w.done();
});

test("--allow-unknown refuses what can't be shown in full: another kind of account, or lookup tables", async () => {
  const w = world();
  const cfg = squads.accounts.ConfigTransaction.fromArgs({ multisig: w.ms, creator: w.site.publicKey, index: 1, bump: 255, actions: [] }).serialize()[0];
  w.propose(1n, cfg, "Active", [w.site.publicKey]);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "1", "--allow-unknown"), 1, w.text());
  assert.match(w.text(), /config transaction.*even with --allow-unknown/);
  w.out.length = 0;
  // A vault transaction with a lookup table.
  const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({ message: new TransactionMessage({ payerKey: w.vault, recentBlockhash: PublicKey.default.toBase58(), instructions: [memoIx(w.vault)] }), vaultPda: w.vault });
  const [m] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const message = { ...m, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: Uint8Array.from(i.accountIndexes), data: Uint8Array.from(i.data) })),
    addressTableLookups: [{ accountKey: key(), writableIndexes: new Uint8Array([1]), readonlyIndexes: new Uint8Array() }] };
  const tx = squads.accounts.VaultTransaction.fromArgs({ multisig: w.ms, creator: w.site.publicKey, index: 2, bump: 255, vaultIndex: 0, vaultBump: 255, ephemeralSignerBumps: new Uint8Array(), message }).serialize()[0];
  w.propose(2n, tx, "Active", [w.site.publicKey]);
  assert.equal(await w.run("approve", ...base(w), "--keypair", backup, "--index", "2", "--allow-unknown"), 1, w.text());
  assert.match(w.text(), /lookup tables.*even with --allow-unknown/);
  assert.equal(w.net.sims, 0);
  w.done();
});

test("claim 5: an execute whose read-back fails is confirmed-but-unverified, exit 4", async () => {
  const w = world();
  w.propose(1n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.hostile.failAfterSend = true;
  assert.equal(await w.run("execute", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--expect-new-publisher", w.target.toBase58(), "--execute"), 4, w.text());
  assert.match(w.text(), /CONFIRMED: execute #1/); assert.match(w.text(), /VERIFICATION UNAVAILABLE/); assert.match(w.text(), /Do NOT re-propose or send it again/);
  assert.doesNotMatch(w.text(), /publisher is now/);
  assert.equal(w.net.sends, 1);
  w.done();
});

test("cancel: only an Approved proposal, once per member, a voting member only", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  w.propose(2n, [memoIx(w.vault)], "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.propose(3n, [memoIx(w.vault)], "Cancelled", [w.site.publicKey, w.backup.publicKey]);
  const backup = w.file(w.backup, "b");
  const go = async (k: string, i: string) => { w.out.length = 0; return w.run("cancel", ...base(w), "--keypair", k, "--index", i); };
  assert.equal(await go(backup, "1"), 1); assert.match(w.text(), /is Active: use reject/);
  assert.equal(await go(backup, "3"), 1); assert.match(w.text(), /is Cancelled/);
  assert.equal(await go(w.file(w.outsider, "o"), "2"), 1); assert.match(w.text(), /isn't a member/);
  assert.equal(w.net.sims, 0);
  assert.equal(await go(backup, "2"), 0, w.text()); assert.match(w.text(), /DRY RUN: cancel #2 \(1 of 2 cancels\)/); assert.match(w.text(), /nothing was signed or sent/);
  w.done();
});

test("open proposals for a vault: Active or Approved naming it, not what's finished or elsewhere", async () => {
  const w = world();
  const conn = { ...w.conn, getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map((k) => w.accounts.get(k.toBase58()) ?? null) } as unknown as Connection;
  const list = [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))];
  w.propose(1n, list, "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.propose(2n, setPub(w), "Active", [w.site.publicKey]);
  w.propose(3n, list, "Executed", [w.site.publicKey, w.backup.publicKey]);
  w.propose(4n, [memoIx(w.vault)], "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.propose(5n, [publishListIx(TAX, w.vault, key(), Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))], "Active", [w.site.publicKey]);
  const q = (await readQuorum(conn, w.program, w.ms))!;
  assert.deepEqual((await openProposalsFor(conn, w.program, w.ms, q, vaultPda(TAX, w.mint))).map((x) => [x.index, x.status]), [[1n, "Approved"], [2n, "Active"]]);
  w.done();
});

test("claim 7: the pinned Squads executable: length and hash both checked", () => {
  const header = Buffer.alloc(45);
  const pin = { ...SQUADS_PINS.mainnet };
  assert.equal(pin.sha256.length, 64);
  assert.match(squadsBinaryProblem("mainnet", Buffer.concat([header, Buffer.alloc(10, 1)]))!, /is 10 bytes, pinned at 979505/);
  assert.match(squadsBinaryProblem("mainnet", Buffer.concat([header, Buffer.alloc(pin.length, 1)]))!, /hashes to/);
  assert.match(squadsBinaryProblem("testnet", Buffer.concat([header, Buffer.alloc(pin.length, 1)]))!, /is 979505 bytes, pinned at 842489/);
});

test("redaction: scheme and host only; same endpoint compares host and port", () => {
  assert.equal(redactRpc("https://u:p@rpc.example:8899/v1/key?api-key=k"), "https://rpc.example:8899/…?…");
  assert.equal(redactRpc("https://rpc.mainnet.x1.xyz"), "https://rpc.mainnet.x1.xyz");
  assert.equal(redactRpc("http://127.0.0.1:9601/"), "http://127.0.0.1:9601");
  assert.ok(!redactRpc("not a url secret").includes("secret"), "an unparseable value isn't echoed");
  assert.ok(sameEndpoint("https://a.example/x?k=1", "https://A.EXAMPLE/y"), "paths and keys don't make it independent");
  assert.ok(!sameEndpoint("http://127.0.0.1:1", "http://127.0.0.1:2"), "another port is another endpoint");
});

// ---------- second review of 40e4c2c ----------
const scanConn = (w: World, o: { fail?: boolean; short?: boolean } = {}) => ({ ...w.conn, getMultipleAccountsInfo: async (ks: PublicKey[]) => {
  if (o.fail) throw new Error("fetch failed");
  const out = ks.map((k) => w.accounts.get(k.toBase58()) ?? null);
  return o.short ? [] : out;
} }) as unknown as Connection;
const noProposal = (w: World, i: bigint) => w.accounts.delete(squadsProposalPda(w.program, w.ms, i).toBase58());

test("open proposals: an Approved one below the stale index still counts, from index 1, past the first pages", async () => {
  const w = world();
  const list = [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))];
  w.propose(1n, list, "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.propose(2n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.propose(130n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.setStale(200n);
  w.propose(201n, setPub(w), "Active", [w.site.publicKey]);
  const q = (await readQuorum(scanConn(w), w.program, w.ms))!;
  assert.equal(q.staleTransactionIndex, 200n);
  assert.deepEqual((await openProposalsFor(scanConn(w), w.program, w.ms, q, vaultPda(TAX, w.mint), { gapMs: 0 })).map((x) => [x.index, x.status]),
    [[1n, "Approved"], [2n, "Approved"], [130n, "Approved"], [201n, "Active"]]);
  w.done();
});

test("open proposals: what the real binaries let run is open; what they refuse below the stale index isn't", async () => {
  const w = world();
  // Rehearsed on both pinned binaries: below the stale index these can't get votes, a proposal or activation.
  w.propose(1n, setPub(w), "Active", [w.site.publicKey]);
  w.propose(2n, setPub(w), "Draft");
  w.propose(3n, setPub(w), "Active", [w.site.publicKey]); noProposal(w, 3n);
  // A config transaction Approved before going stale: the program refuses to run it.
  const cfg = () => squads.accounts.ConfigTransaction.fromArgs({ multisig: w.ms, creator: w.site.publicKey, index: 4, bump: 255, actions: [] }).serialize()[0];
  w.propose(4n, cfg(), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.setStale(4n);
  // Above it: a Draft can be activated and a stored transaction with no proposal can be given one.
  w.propose(5n, setPub(w), "Draft");
  w.propose(6n, setPub(w), "Active", [w.site.publicKey]); noProposal(w, 6n);
  w.propose(7n, setPub(w), "Executing");
  const q = (await readQuorum(scanConn(w), w.program, w.ms))!;
  assert.deepEqual((await openProposalsFor(scanConn(w), w.program, w.ms, q, vaultPda(TAX, w.mint), { gapMs: 0 })).map((x) => [x.index, x.status]),
    [[5n, "Draft"], [6n, "no proposal yet"], [7n, "Executing"]]);
  w.done();
});

test("open proposals: a scan that can't finish fails closed, never reporting none", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Executed");
  const q = (await readQuorum(scanConn(w), w.program, w.ms))!;
  const v = vaultPda(TAX, w.mint), scan = (c: Connection, o = {}) => openProposalsFor(c, w.program, w.ms, q, v, { gapMs: 0, ...o });
  assert.deepEqual(await scan(scanConn(w)), [], "the fixture is clean when the scan finishes");
  await assert.rejects(scan(scanConn(w, { fail: true })), /can't tell which proposals are open/);
  await assert.rejects(scan(scanConn(w, { short: true })), /can't tell which proposals are open/);
  await assert.rejects(scan(scanConn(w), { maxIndexes: 0n }), /more than the 0 indexes/);
  // An account at a proposal's address that doesn't decode isn't "no proposal".
  w.put(squadsProposalPda(w.program, w.ms, 1n), w.program, Buffer.alloc(64, 7));
  await assert.rejects(scan(scanConn(w)), /#1/);
  w.done();
});

test("read-back: a confirmed vote whose proposal reads back null or undecodable is exit 4, signature kept, for every subcommand", async () => {
  for (const [sub, status, shape] of [["approve", "Active", "memo"], ["reject", "Active", "memo"], ["cancel", "Approved", "memo"], ["execute", "Approved", "memo"], ["execute", "Approved", "set"]] as const) {
    for (const bad of ["null", "garbage", "bad-disc"] as const) {
      const w = world();
      const ixs = shape === "set" ? setPub(w) : [memoIx(w.vault)];
      w.propose(1n, ixs, status, status === "Approved" ? [w.site.publicKey, w.backup.publicKey] : [w.site.publicKey]);
      const pda = squadsProposalPda(w.program, w.ms, 1n);
      w.net.onSend = () => {
        if (bad === "null") w.accounts.delete(pda.toBase58());
        else if (bad === "garbage") w.put(pda, w.program, Buffer.concat([Buffer.from(squads.generated.proposalDiscriminator), Buffer.alloc(3, 9)]));
        else w.put(pda, w.program, Buffer.alloc(80, 7));
      };
      const code = await w.run(sub, ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", ...(shape === "set" ? ["--expect-new-publisher", w.target.toBase58()] : []), "--execute");
      assert.equal(code, 4, `${sub} ${shape} ${bad}: ${w.text()}`);
      assert.match(w.text(), /VERIFICATION UNAVAILABLE/); assert.match(w.text(), /CONFIRMED \(signature \w+\)/); assert.match(w.text(), /Do NOT re-propose or send it again/);
      assert.doesNotMatch(w.text(), /read back: #1: no proposal account/);
      assert.equal(w.net.sends, 1);
      w.done();
    }
  }
});

test("read-back: a proposal whose transaction is missing or undecodable is exit 4, a decoded mismatch stays a refusal", async () => {
  for (const bad of ["missing", "garbage", "config"] as const) {
    const w = world();
    w.net.onSend = () => {
      w.propose(1n, [memoIx(w.vault, "hi")], "Active", [w.site.publicKey]);
      const pda = squadsTransactionPda(w.program, w.ms, 1n);
      if (bad === "missing") w.accounts.delete(pda.toBase58());
      else w.put(pda, w.program, bad === "garbage" ? Buffer.alloc(80, 7) : squads.accounts.ConfigTransaction.fromArgs({ multisig: w.ms, creator: w.site.publicKey, index: 1, bump: 255, actions: [] }).serialize()[0]);
    };
    assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.site, "s"), "--text", "hi", "--execute"), 4, `${bad}: ${w.text()}`);
    assert.match(w.text(), /VERIFICATION UNAVAILABLE/); assert.match(w.text(), /CONFIRMED \(signature/);
    assert.equal(w.net.sends, 1);
    w.done();
  }
  const w = world();
  w.net.onSend = () => w.propose(1n, [memoIx(w.vault, "another memo")], "Active", [w.site.publicKey]);
  assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.site, "s"), "--text", "hi", "--execute"), 1, w.text());
  assert.match(w.text(), /stored message hash/);
  w.done();
});

test("read-back: an executed set_publisher whose vault is missing or undecodable is exit 4; a memo's log is required", async () => {
  for (const bad of ["null", "garbage"] as const) {
    const w = world();
    w.propose(1n, setPub(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
    w.net.onSend = () => {
      w.propose(1n, setPub(w), "Executed", [w.site.publicKey, w.backup.publicKey]);
      if (bad === "null") w.accounts.delete(vaultPda(TAX, w.mint).toBase58()); else w.put(vaultPda(TAX, w.mint), TAX, Buffer.alloc(9, 1));
    };
    // The vault must read while it's checked before sending, so only the read after the send differs.
    assert.equal(await w.run("execute", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--expect-new-publisher", w.target.toBase58(), "--execute"), 4, w.text());
    assert.match(w.text(), /VERIFICATION UNAVAILABLE/); assert.doesNotMatch(w.text(), /did NOT change/);
    w.done();
  }
  const m = world();
  m.propose(1n, [memoIx(m.vault)], "Approved", [m.site.publicKey, m.backup.publicKey]);
  m.net.onSend = () => m.propose(1n, [memoIx(m.vault)], "Executed", [m.site.publicKey, m.backup.publicKey]);
  const args = ["execute", ...base(m), "--keypair", m.file(m.backup, "b"), "--index", "1", "--execute"];
  assert.equal(await m.run(...args), 4, m.text());
  assert.match(m.text(), /memo program's log/);
  m.out.length = 0;
  m.propose(1n, [memoIx(m.vault)], "Approved", [m.site.publicKey, m.backup.publicKey]);
  m.net.getTx = { meta: { logMessages: [`Program log: Signed by ${m.vault.toBase58()}`] } };
  assert.equal(await m.run(...args), 0, m.text());
  assert.match(m.text(), /the vault PDA signed/);
  m.done();
});

/** A real HTTP endpoint for the real web3.js failure paths: `fail` says how a method fails, otherwise it answers from `inner`. */
async function failingRpc(inner: string, fail: (method: string) => { status: number; statusText?: string; body: string } | null) {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", async () => {
      const j = JSON.parse(body), f = fail(j.method);
      // web3.js only takes a JSON-RPC error whose id is the string it sent; "id":1 would be a wrong-form answer instead.
      if (f) { res.writeHead(f.status, f.statusText ?? "", { "content-type": "text/plain", ...(f.status === 429 ? { "retry-after": "1" } : {}) }); res.end(f.body.replace('"id":1,', `"id":${JSON.stringify(j.id)},`)); return; }
      const r = await fetch(inner, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(200, { "content-type": "application/json" }); res.end(await r.text());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((r) => server.close(r)) };
}
const SECRET = "s3cr3t+Key/42=x", ENC = encodeURIComponent(SECRET);
const leaks = (t: string) => [SECRET, ENC, ENC.toLowerCase(), "s3cr3t", Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url"), Buffer.from(`alice:${SECRET}`).toString("base64")].filter((x) => t.includes(x));
const secretPath = `/v1/${ENC}?api-key=${ENC}`;

test("redaction: real web3.js failures on the primary RPC print no credential, in any form, and no response body", async () => {
  const bodies = [
    { status: 403, statusText: "Forbidden", body: `invalid api-key ${SECRET} for /v1/${ENC} (${Buffer.from(SECRET).toString("base64")}) short-token-abc` },
    { status: 200, body: `not json ${SECRET} short-token-abc` },
    { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `bad key ${SECRET} short-token-abc` } }) },
    { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { wrong: `${SECRET} short-token-abc` } }) },
  ];
  for (const b of bodies) {
    const w = world("testnet");
    const { rpc } = await realPathRpc(w);
    const f = await failingRpc(rpc.url, () => b);
    const out: string[] = [];
    const code = await quorumAction(["status", "--network", "testnet", "--rpc", `${f.base}${secretPath}`, "--multisig", w.ms.toBase58()], { connect: defaultDeps().connect, out: (l) => out.push(l) });
    assert.equal(code, 1, out.join("\n"));
    assert.deepEqual(leaks(out.join("\n")), [], out.join("\n"));
    assert.doesNotMatch(out.join("\n"), /short-token-abc/, "the untrusted body isn't printed, whatever is in it");
    if (b.status === 403) assert.match(out.join("\n"), /403 Forbidden/, "the status still is");
    await f.close(); await rpc.close(); w.done();
  }
});

test("redaction: real web3.js failures on the verification RPC, and on a read-back after a send", async () => {
  const w = world("testnet");
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  const { rpc } = await realPathRpc(w);
  const body = `invalid api-key ${SECRET} for /v1/${ENC} short-token-abc`;
  const v = await failingRpc(rpc.url, () => ({ status: 403, statusText: "Forbidden", body }));
  const out: string[] = [];
  const deps = { connect: defaultDeps().connect, out: (l: string) => out.push(l) };
  const code = await quorumAction(["approve", "--network", "testnet", "--rpc", rpc.url, "--verify-rpc", `${v.base}${secretPath}`, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1"], deps);
  assert.equal(code, 1, out.join("\n"));
  assert.match(out.join("\n"), /--verify-rpc couldn't be read: .*403 Forbidden/);
  assert.deepEqual(leaks(out.join("\n")), [], out.join("\n")); assert.doesNotMatch(out.join("\n"), /short-token-abc/);
  await v.close();
  // After a confirmed send the primary starts refusing: exit 4, same rule.
  out.length = 0;
  let sent = false;
  const p = await failingRpc(rpc.url, (m) => { if (m === "sendTransaction") { sent = true; return null; } return sent && m === "getAccountInfo" ? { status: 403, statusText: "Forbidden", body } : null; });
  const code2 = await quorumAction(["approve", "--network", "testnet", "--rpc", `${p.base}${secretPath}`, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1", "--execute"], deps);
  assert.equal(code2, 4, out.join("\n"));
  assert.deepEqual(leaks(out.join("\n")), [], out.join("\n")); assert.doesNotMatch(out.join("\n"), /short-token-abc/);
  await p.close(); await rpc.close(); w.done();
});

test("redaction: parsed credentials and their encodings are scrubbed from any line; ordinary words and addresses aren't", async () => {
  const w = world("testnet");
  const url = `https://alice:${ENC}@rpc.example/rpc/v1/mainnet/${ENC}?commitment=confirmed&api-key=${ENC}#${ENC}`;
  const text = [`decoded ${SECRET}`, `encoded ${ENC}`, `lower ${ENC.toLowerCase()}`, `b64 ${Buffer.from(SECRET).toString("base64")}`, `basic ${Buffer.from(`alice:${SECRET}`).toString("base64")}`, `url ${url}`].join(" | ");
  const out: string[] = [];
  const code = await quorumAction(["status", "--network", "mainnet", "--rpc", url, "--multisig", w.ms.toBase58()], { connect: () => { throw new Error(text); }, out: (l) => out.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(leaks(out.join("\n")), [], out.join("\n"));
  // A flag this tool doesn't know, carrying a URL, isn't echoed either.
  out.length = 0;
  await quorumAction([`--rpc=${url}`], { connect: () => { throw new Error("no"); }, out: (l) => out.push(l) });
  assert.deepEqual(leaks(out.join("\n")), [], out.join("\n"));
  // Words from a generic URL path survive, so the tool's own output stays readable.
  const w2 = world("testnet");
  const { rpc } = await realPathRpc(w2);
  w2.propose(1n, [memoIx(w2.vault)], "Active", [w2.site.publicKey]);
  const o2: string[] = [];
  assert.equal(await quorumAction(["status", "--network", "testnet", "--rpc", `${rpc.url}/rpc/testnet?commitment=confirmed`, "--multisig", w2.ms.toBase58(), "--index", "1"], { connect: defaultDeps().connect, out: (l) => o2.push(l) }), 0, o2.join("\n"));
  assert.match(o2.join("\n"), /network   testnet/);
  assert.match(o2.join("\n"), new RegExp(w2.vault.toBase58()));
  await rpc.close(); w.done(); w2.done();
});

const listIxOf = (w: World) => [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 0))];
test("reject: says how many rejections remain on-chain, and doesn't promise what the site does", async () => {
  const w = world();
  w.propose(1n, listIxOf(w), "Active", [w.site.publicKey]);
  assert.equal(await w.run("reject", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1"), 0, w.text());
  assert.doesNotMatch(w.text(), /one rejection is final/i);
  assert.match(w.text(), /rejection 1 of the 2 that close #1/); assert.match(w.text(), /1 more after it/);
  assert.match(w.text(), /only if .*tracking/i, "the site's reaction is qualified");
  assert.match(w.text(), /own key/);
  w.done();
});

test("reject and cancel: cleared only on a terminal status", async () => {
  const w = world();
  const backup = w.file(w.backup, "b");
  w.propose(1n, listIxOf(w), "Active", [w.site.publicKey]);
  w.net.onSend = () => w.propose(1n, listIxOf(w), "Active", [w.site.publicKey], [w.backup.publicKey]);
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1", "--execute"), 0, w.text());
  assert.match(w.text(), /still Active, NOT cleared: 1 more rejection/);
  assert.doesNotMatch(w.text(), /closed on-chain/);
  w.out.length = 0;
  w.propose(1n, listIxOf(w), "Active", [w.site.publicKey], [w.cosigner.publicKey]);
  w.net.onSend = () => w.propose(1n, listIxOf(w), "Rejected", [w.site.publicKey], [w.cosigner.publicKey, w.backup.publicKey]);
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1", "--execute"), 0, w.text());
  assert.match(w.text(), /rejection 2 of the 2 that close #1/); assert.match(w.text(), /#1 is Rejected: closed on-chain/);
  assert.doesNotMatch(w.text(), /NOT cleared/);
  w.out.length = 0;
  w.propose(2n, listIxOf(w), "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.net.onSend = null;
  assert.equal(await w.run("cancel", ...base(w), "--keypair", backup, "--index", "2", "--execute"), 0, w.text());
  assert.match(w.text(), /still Approved, NOT cleared/); assert.match(w.text(), /still run it/);
  w.done();
});

test("message hash: bound to the multisig and index, so a hash can't be replayed against another proposal", async () => {
  const w = world("mainnet");
  const a = setPub(w)[0];
  const hi = plannedMessageHash(w.ms, w.vault, a, w.program, 1n);
  assert.notEqual(hi, plannedMessageHash(w.ms, w.vault, a, w.program, 2n), "another index, another hash");
  assert.notEqual(hi, plannedMessageHash(key(), w.vault, a, w.program, 1n), "another multisig, another hash");
  // Codex's scenario: colluding RPCs report the honest A message at index j, where the chain stores B. The hash the honest proposer gave for #1 doesn't fit #2.
  w.propose(1n, [a], "Active", [w.site.publicKey]);
  w.propose(2n, [a], "Active", [w.site.publicKey]);
  const args = ["approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "2", "--expect-new-publisher", w.target.toBase58(), "--single-rpc-accepted"];
  assert.equal(await w.run(...args, "--expect-message-hash", hi), 1, w.text());
  assert.match(w.text(), /--expect-message-hash is/);
  // What it doesn't help with: a hash for #2 from whoever chose #2 passes, whatever the chain stores. Stated in the header.
  w.out.length = 0;
  assert.equal(await w.run(...args, "--expect-message-hash", plannedMessageHash(w.ms, w.vault, a, w.program, 2n)), 0, w.text());
  w.done();
});

test("wording: the single-RPC warning and the mainnet refusal say plainly what isn't detected", async () => {
  const w = world("mainnet");
  w.propose(1n, setPub(w), "Active", [w.site.publicKey]);
  const args = ["approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--expect-new-publisher", w.target.toBase58()];
  assert.equal(await w.run(...args), 1, "still refused by default on mainnet");
  assert.match(w.text(), /--single-rpc-accepted/);
  w.out.length = 0;
  assert.equal(await w.run(...args, "--single-rpc-accepted"), 0, w.text());
  assert.match(w.text(), /WARNING: --single-rpc-accepted/); assert.match(w.text(), /different set_publisher/); assert.match(w.text(), /nothing in this tool detects it/i);
  w.done();
});

test("setup-publisher-quorum: refuses a stale Approved proposal; a scan that can't finish refuses even with --allow-open-proposals; only public keys for members", async () => {
  const { spawn } = await import("node:child_process");
  const createKey = Keypair.generate(), program = SQUADS_PROGRAM_IDS.testnet;
  const w = world("testnet", squadsMultisigPda(program, createKey.publicKey));
  const payer = Keypair.generate(), mint = key();
  w.put(vaultPda(TAX, mint), TAX, vaultAccount(mint, payer.publicKey));
  const { rpc, wire } = await realPathRpc(w);
  const f = await failingRpc(rpc.url, (m) => (m === "getMultipleAccounts" ? { status: 403, statusText: "Forbidden", body: `invalid api-key ${SECRET} short-token-abc` } : null));
  const run = async (url: string, ...more: string[]) => {
    const child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/setup-publisher-quorum.ts", "--rpc", url, "--network", "testnet", "--keypair", w.file(payer, "payer"), "--create-key", w.file(createKey, "create"),
      "--site", w.site.publicKey.toBase58(), "--cosigner", w.cosigner.publicKey.toBase58(), "--backup", w.backup.publicKey.toBase58(), "--mint", mint.toBase58(), "--program", TAX.toBase58(), ...more], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    return { code, out };
  };
  const sets = () => wire.simulated.length + wire.sent.length;
  // Below the stale index and Approved: the old scan started above it and saw nothing.
  const vaultAddr = squadsVaultPda(program, w.ms);
  w.propose(1n, [setPublisherIx(TAX, vaultAddr, mint, w.target)], "Approved", [w.site.publicKey, w.backup.publicKey]);
  w.setStale(1n);
  const seen = await run(rpc.url);
  assert.equal(seen.code, 1, seen.out);
  assert.match(seen.out, /#1 Approved \(stale, still executable\)/); assert.match(seen.out, /Not moving this vault/);
  assert.equal(sets(), 0, "nothing simulated or sent for a vault it refused");
  // The scan can't finish: refused, and the flag for what was seen doesn't cover it. No credential or body printed.
  for (const more of [[], ["--allow-open-proposals"]]) {
    const r = await run(`${f.base}${secretPath}`, ...more);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /can't tell which proposals are open/); assert.match(r.out, /Not moving this vault/); assert.match(r.out, /403 Forbidden/);
    assert.deepEqual(leaks(r.out), [], r.out); assert.doesNotMatch(r.out, /short-token-abc/);
    assert.equal(sets(), 0, "nothing simulated or sent when the scan didn't finish");
  }
  // With nothing open it goes on to the simulation, and the backup was only ever a public key.
  w.propose(1n, [setPublisherIx(TAX, vaultAddr, mint, w.target)], "Cancelled", [w.site.publicKey, w.backup.publicKey]);
  const clear = await run(rpc.url);
  assert.equal(clear.code, 0, clear.out);
  assert.match(clear.out, /0 can still act on this vault/);
  assert.ok(sets() > 0, "it reached the simulation");
  await f.close(); await rpc.close(); w.done();
});

// ---------- third review of 26c7534: bodies withheld on every path, by allowlist ----------
const BODY = "bad api-key abc for /v1/abc zz-body-marker";
const SHORT_URL = "/v1/abc?api-key=abc";
const rpcErrorBody = { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: BODY } }) };
const noBody = (t: string) => { assert.doesNotMatch(t, /zz-body-marker|api-key abc|\/v1\/abc/, t); };
/** A healthy chain behind a real HTTP endpoint that fails `method`s after `from` sends (0: always). */
async function chainThatFails(w: World, methods: string[], how: { status: number; statusText?: string; body: string } = rpcErrorBody, afterSend = false) {
  const { rpc } = await realPathRpc(w);
  let sent = false;
  const f = await failingRpc(rpc.url, (m) => { if (m === "sendTransaction") sent = true; return methods.includes(m) && (!afterSend || sent) ? how : null; });
  return { url: `${f.base}${SHORT_URL}`, plain: rpc.url, close: async () => { await f.close(); await rpc.close(); } };
}
const realDeps = (out: string[]) => ({ connect: defaultDeps().connect, out: (l: string) => out.push(l) });

test("withheld: JSON-RPC failures after genesis on the primary RPC, through real web3.js, keep the operation and class only", async () => {
  for (const [method, sub, op] of [
    ["getAccountInfo", "status", /failed to get info about account.*JSON-RPC/],
    ["getMultipleAccounts", "approve", /failed to get info for accounts.*JSON-RPC error -32005/],
    ["getBalance", "approve", /failed to get balance of account.*JSON-RPC/],
    ["simulateTransaction", "approve", /failed to simulate transaction/],
    ["getLatestBlockhash", "approve", /failed to get recent blockhash.*JSON-RPC/],
  ] as const) {
    const w = world("testnet");
    w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
    const c = await chainThatFails(w, [method]);
    const out: string[] = [];
    const args = sub === "status" ? ["status"] : ["approve", "--keypair", w.file(w.backup, "b"), "--index", "1"];
    const code = await quorumAction([args[0], "--network", "testnet", "--rpc", c.url, "--multisig", w.ms.toBase58(), ...args.slice(1)], realDeps(out));
    assert.equal(code, 1, `${method}: ${out.join("\n")}`);
    noBody(out.join("\n"));
    assert.match(out.join("\n"), op, `${method}: ${out.join("\n")}`);
    await c.close(); w.done();
  }
});

test("withheld: JSON-RPC failures on the verification RPC, through real web3.js", async () => {
  for (const method of ["getMultipleAccounts", "getAccountInfo"]) {
    const w = world("testnet");
    w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
    const v = await chainThatFails(w, [method]);
    const out: string[] = [];
    const { rpc } = await realPathRpc(w);
    const code = await quorumAction(["approve", "--network", "testnet", "--rpc", rpc.url, "--verify-rpc", v.url, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1"], realDeps(out));
    assert.equal(code, 1, out.join("\n"));
    assert.match(out.join("\n"), /--verify-rpc couldn't be read: failed to get info .*JSON-RPC/);
    noBody(out.join("\n"));
    await rpc.close(); await v.close(); w.done();
  }
});

test("withheld: a confirmed send whose read-backs fail by JSON-RPC, and a send refused by JSON-RPC", async () => {
  const w = world("testnet");
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  const c = await chainThatFails(w, ["getAccountInfo", "getBalance"], rpcErrorBody, true);
  const out: string[] = [];
  const args = (url: string) => ["approve", "--network", "testnet", "--rpc", url, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1", "--execute"];
  assert.equal(await quorumAction(args(c.url), realDeps(out)), 4, out.join("\n"));
  assert.match(out.join("\n"), /VERIFICATION UNAVAILABLE.*failed to get info about account/);
  noBody(out.join("\n"));
  await c.close();
  out.length = 0;
  const s = await chainThatFails(w, ["sendTransaction"]);
  const code = await quorumAction(args(s.url), realDeps(out));
  assert.ok(code === 1 || code === 3, `exit ${code}: ${out.join("\n")}`);
  noBody(out.join("\n"));
  await s.close(); w.done();
});

test("withheld: an HTTP reason phrase is the server's words too; only the standard name for the code prints", async () => {
  const w = world("testnet");
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  const out: string[] = [];
  const c = await chainThatFails(w, ["getBalance"], { status: 403, statusText: "api-key abc zz-body-marker", body: BODY });
  const code = await quorumAction(["approve", "--network", "testnet", "--rpc", c.url, "--multisig", w.ms.toBase58(), "--keypair", w.file(w.backup, "b"), "--index", "1"], realDeps(out));
  assert.equal(code, 1, out.join("\n"));
  noBody(out.join("\n"));
  assert.match(out.join("\n"), /failed to get balance of account.*HTTP 403 Forbidden/);
  await c.close(); w.done();
});

test("withheld: printable is an allowlist: unknown text never prints, the known safe forms do", () => {
  const body = "zz-body-marker abc";
  for (const e of [new Error(body), new Error(`failed to frobnicate: ${body}`), new TypeError(body), body, new Error(`500 ${body}: ${body}`), new SyntaxError(`Unexpected token ${body}`),
    new Error(`failed to simulate transaction: ${body}`), new Error(`failed to get balance of account X: ${body}`), Object.assign(new Error(`failed to get genesis hash: ${body}`), { name: "SolanaJSONRPCError", code: `${body}` }),
    Object.assign(new Error(`${body}`), { name: "SolanaJSONRPCError", code: -1 }), Object.assign(new Error("fetch failed"), { cause: { code: body } }), Object.assign(new Error(body), { name: body })]) {
    assert.doesNotMatch(printable(e), /zz-body-marker/, String(e));
  }
  assert.equal(printable(new Error("fetch failed")), "fetch failed");
  assert.equal(printable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), "fetch failed (ECONNREFUSED)");
  const sig = "1".repeat(64);
  assert.equal(printable(new Error(`Transaction ${sig} failed: {"InstructionError":[0,"${body}"]}`)), `Transaction ${sig} failed`);
  assert.equal(printable(new Error(`Transaction ${sig} expired before it confirmed`)), `Transaction ${sig} expired before it confirmed`);
  assert.equal(printable(new Error(`Transaction ${sig} not confirmed within 120s (it may still land)`)), `Transaction ${sig} not confirmed within 120s (it may still land)`);
  assert.equal(printable(new Error(`Simulation failed. \nMessage: ${body}`)), "Simulation failed");
  assert.match(printable(new Error(`403 Forbidden: ${body}`)), /^HTTP 403 Forbidden /);
  assert.match(printable(new Error(`failed to get balance of account X: Error: 503 ${body}: ${body}`)), /^failed to get balance of account: HTTP 503 Service Unavailable /);
  assert.match(printable(new Error(`failed to get balance of account X: SolanaJSONRPCError: failed to get balance: ${body}`)), /^failed to get balance of account: JSON-RPC error /);
  assert.match(printable(new TypeError("boom")), /^unexpected TypeError /);
  assert.match(printable(Object.assign(new Error("ENOENT: /secret/path"), { code: "ENOENT" })), /^system error ENOENT/);
});

test("setup-publisher-quorum: uncaught RPC failures go through the same withholding, including a raw 429 reason", async () => {
  const { spawn } = await import("node:child_process");
  const createKey = Keypair.generate(), program = SQUADS_PROGRAM_IDS.testnet, payer = Keypair.generate();
  const w = world("testnet", squadsMultisigPda(program, createKey.publicKey));
  const setup = async (url: string) => {
    const child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/setup-publisher-quorum.ts", "--rpc", url, "--network", "testnet", "--keypair", w.file(payer, "payer"), "--create-key", w.file(createKey, "create"),
      "--site", w.site.publicKey.toBase58(), "--cosigner", w.cosigner.publicKey.toBase58(), "--backup", w.backup.publicKey.toBase58(), "--program", TAX.toBase58()], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    return { code, out };
  };
  for (const [how, re] of [[rpcErrorBody, /failed to get info about account.*JSON-RPC/], [{ status: 403, statusText: "api-key abc zz-body-marker", body: BODY }, /HTTP 403 Forbidden/], [{ status: 200, body: BODY }, /wasn't JSON/]] as const) {
    const c = await chainThatFails(w, ["getAccountInfo"], how);
    const r = await setup(c.url);
    assert.equal(r.code, 1, r.out);
    noBody(r.out);
    assert.match(r.out, re, r.out);
    assert.doesNotMatch(r.out, /^\s+at /m, "no stack trace");
    await c.close();
  }
  // web3's own retry logs a 429's reason phrase; the setup's connection must not take that path.
  const c = await chainThatFails(w, ["getAccountInfo"], { status: 429, statusText: "api-key abc zz-body-marker", body: BODY });
  const r = await setup(c.url);
  noBody(r.out);
  await c.close(); w.done();
});

// ---------- a stored proposal that can't be fully decoded ----------
const BAD_CID = Buffer.alloc(33, 2);
const listWith = (w: World, cid: Buffer) => [publishListIx(TAX, w.vault, w.mint, Buffer.alloc(32, 1), 4n, 5n, cid)];
const goodCid = () => cidToBytes(rawCid(Buffer.from("a list file"))!);
const junk = (disc: number[]) => Buffer.from([...disc, 1, 2, 3]);
const putJunkTx = (w: World, index: bigint) => w.put(squadsTransactionPda(w.program, w.ms, index), w.program, junk(squads.generated.vaultTransactionDiscriminator));
const putJunkProposal = (w: World, index: bigint) => w.put(squadsProposalPda(w.program, w.ms, index), w.program, junk(squads.generated.proposalDiscriminator));
const fine = (w: World) => assert.doesNotMatch(w.text(), /^ERROR:|Unsupported CID codec|unexpected .*Error/m, "no thrown error reaches the output");

test("bad CID: cidFromBytes still throws for its other callers", () => {
  assert.throws(() => cidFromBytes(BAD_CID), /Unsupported CID codec 0x2/);
  assert.equal(cidFromBytes(Buffer.alloc(33)), null);
});
test("bad CID: status shows it as invalid, in raw hex and never as a list file, by index and in the list", async () => {
  const w = world();
  w.propose(1n, listWith(w, BAD_CID), "Active", [w.site.publicKey]);
  assert.equal(await w.run("status", ...base(w), "--index", "1"), 0, w.text());
  assert.match(w.text(), new RegExp(`list file INVALID.*${"02".repeat(33)}`));
  assert.match(w.text(), /does: tax_vault publish_list/);
  fine(w);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w)), 0, w.text());
  assert.match(w.text(), /#1 Active.*list 4.*list file INVALID/);
  fine(w);
  w.done();
});
test("bad CID: approve and execute refuse, even with --allow-unknown, exit 1, nothing sent", async () => {
  const w = world();
  w.propose(1n, listWith(w, BAD_CID), "Active", [w.site.publicKey]);
  w.propose(2n, listWith(w, BAD_CID), "Approved", [w.site.publicKey, w.cosigner.publicKey]);
  const backup = w.file(w.backup, "b");
  for (const args of [["approve", "--index", "1"], ["execute", "--index", "2"]]) for (const extra of [[], ["--allow-unknown"], ["--allow-unknown", "--execute"]]) {
    w.out.length = 0;
    assert.equal(await w.run(args[0], ...base(w), "--keypair", backup, ...args.slice(1), ...extra), 1, w.text());
    assert.match(w.text(), /REFUSED: .*list file.*invalid/i);
    fine(w);
  }
  assert.equal(w.net.sends, 0);
  w.done();
});
test("bad CID: reject and cancel work, and their votes are sent", async () => {
  const w = world();
  w.propose(1n, listWith(w, BAD_CID), "Active", [w.site.publicKey]);
  w.propose(2n, listWith(w, BAD_CID), "Approved", [w.site.publicKey, w.cosigner.publicKey]);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1"), 0, w.text());
  assert.equal(w.net.sends, 0, "a dry run first");
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1", "--execute"), 0, w.text());
  assert.equal(w.net.sends, 1);
  assert.equal(await w.run("cancel", ...base(w), "--keypair", backup, "--index", "2", "--execute"), 0, w.text());
  assert.equal(w.net.sends, 2);
  assert.match(w.text(), /list file INVALID/);
  fine(w);
  w.done();
});
test("no CID: a list that names no file is shown as none, and approve and execute refuse it too", async () => {
  const w = world();
  w.propose(1n, listWith(w, Buffer.alloc(33)), "Active", [w.site.publicKey]);
  w.propose(2n, listWith(w, Buffer.alloc(33)), "Approved", [w.site.publicKey, w.cosigner.publicKey]);
  assert.equal(await w.run("status", ...base(w), "--index", "1"), 0);
  assert.match(w.text(), /list file none/);
  const backup = w.file(w.backup, "b");
  for (const args of [["approve", "--index", "1"], ["execute", "--index", "2"]]) {
    w.out.length = 0;
    assert.equal(await w.run(args[0], ...base(w), "--keypair", backup, ...args.slice(1), "--allow-unknown", "--execute"), 1, w.text());
    assert.match(w.text(), /REFUSED: .*names no list file/);
  }
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1", "--execute"), 0, w.text());
  assert.equal(w.net.sends, 1);
  w.done();
});
test("good CID: a real list still prints its file and passes with --allow-unknown", async () => {
  const w = world();
  w.propose(1n, listWith(w, goodCid()), "Active", [w.site.publicKey]);
  assert.equal(await w.run("approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "1", "--allow-unknown", "--execute"), 0, w.text());
  assert.match(w.text(), new RegExp(`list file ${rawCid(Buffer.from("a list file"))}`));
  assert.equal(w.net.sends, 1);
  w.done();
});
test("undecodable: a stored transaction that doesn't decode: status says so; approve and execute refuse; reject and cancel work", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  w.propose(2n, [memoIx(w.vault)], "Approved", [w.site.publicKey, w.cosigner.publicKey]);
  putJunkTx(w, 1n); putJunkTx(w, 2n);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("status", ...base(w), "--index", "1"), 0, w.text());
  assert.match(w.text(), /doesn't decode \(11 bytes, sha256 [0-9a-f]{64}\)/);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w)), 0, w.text());
  fine(w);
  for (const args of [["approve", "--index", "1"], ["execute", "--index", "2"]]) for (const extra of [[], ["--allow-unknown", "--execute"]]) {
    w.out.length = 0;
    assert.equal(await w.run(args[0], ...base(w), "--keypair", backup, ...args.slice(1), ...extra), 1, w.text());
    assert.match(w.text(), /REFUSED: #\d can't be approved or executed, even with --allow-unknown: the stored transaction doesn't decode/);
    fine(w);
  }
  assert.equal(w.net.sends, 0);
  assert.equal(await w.run("reject", ...base(w), "--keypair", backup, "--index", "1", "--execute"), 0, w.text());
  assert.equal(await w.run("cancel", ...base(w), "--keypair", backup, "--index", "2", "--execute"), 0, w.text());
  assert.equal(w.net.sends, 2);
  w.done();
});
test("undecodable: a proposal account that doesn't decode: status says so; every vote and execute refuses clearly", async () => {
  const w = world();
  w.propose(1n, [memoIx(w.vault)], "Active", [w.site.publicKey]);
  putJunkProposal(w, 1n);
  const backup = w.file(w.backup, "b");
  assert.equal(await w.run("status", ...base(w), "--index", "1"), 0, w.text());
  assert.match(w.text(), /#1: the proposal account doesn't decode/);
  fine(w);
  w.out.length = 0;
  assert.equal(await w.run("status", ...base(w)), 0, w.text());
  assert.match(w.text(), /#1: the proposal account doesn't decode/);
  fine(w);
  for (const sub of ["approve", "reject", "cancel", "execute"]) {
    w.out.length = 0;
    assert.equal(await w.run(sub, ...base(w), "--keypair", backup, "--index", "1", "--allow-unknown", "--execute"), 1, `${sub}: ${w.text()}`);
    assert.match(w.text(), /REFUSED: .*proposal account doesn't decode/, sub);
    fine(w);
  }
  assert.equal(w.net.sends, 0);
  w.done();
});
test("bad CID: one open bad list doesn't stop work on another proposal", async () => {
  const w = world();
  w.propose(1n, listWith(w, BAD_CID), "Active", [w.site.publicKey]);
  w.propose(2n, setPub(w), "Active", [w.site.publicKey]);
  assert.equal(await w.run("approve", ...base(w), "--keypair", w.file(w.backup, "b"), "--index", "2", "--expect-new-publisher", w.target.toBase58()), 0, w.text());
  assert.match(w.text(), /note: list proposal #1 is open/);
  fine(w);
  w.done();
});
