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
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, type AccountInfo, type Connection } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  GENESIS_HASH, MAX_MEMO_BYTES, MEMO_PROGRAM_ID, Refusal, classifyVaultTx, expectationProblem, explainFailure, genesisProblem, loadMemberKey, newPublisherProblem, parseArgs,
  quorumAction, rightsProblem, sendFate, sha256Hex, type Shape,
} from "../src/quorum-action.js";
import {
  SQUADS_PROGRAM_IDS, Permission, Permissions, decodeVaultTx, squadsProposalPda, squadsTransactionPda, squadsVaultPda, type VaultTx,
} from "../src/squads.js";
import { TAX_VAULT_PROGRAM_ID, VAULT_LEN, encodeVault, publishListIx, setPublisherIx, vaultPda, type Vault } from "../src/taxvault.js";

const SQUADS = SQUADS_PROGRAM_IDS.mainnet;
const TAX = TAX_VAULT_PROGRAM_ID;
const key = () => Keypair.generate().publicKey;
const info = (owner: PublicKey, data: Buffer): AccountInfo<Buffer> => ({ owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 });

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
  assert.ok(VAULT_LEN > 0);
  return encodeVault(v);
}

// ---------- a chain to talk to ----------
const ALL = Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]);
const VOTE_EXEC = Permissions.fromPermissions([Permission.Vote, Permission.Execute]);
function world(network: "mainnet" | "testnet" = "mainnet") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-action-test-"));
  const file = (k: Keypair, name: string, mode = 0o600) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode }); fs.chmodSync(f, mode); return f; };
  const site = Keypair.generate(), cosigner = Keypair.generate(), backup = Keypair.generate(), outsider = Keypair.generate();
  const ms = key(), vault = squadsVaultPda(SQUADS_PROGRAM_IDS[network], ms), mint = key(), target = Keypair.generate().publicKey;
  const program = SQUADS_PROGRAM_IDS[network];
  const accounts = new Map<string, AccountInfo<Buffer>>();
  const put = (k: PublicKey, owner: PublicKey, data: Buffer) => accounts.set(k.toBase58(), info(owner, data));
  put(vaultPda(TAX, mint), TAX, vaultAccount(mint, vault));
  let txIndex = 0n;
  const putMultisig = () => put(ms, program, squads.accounts.Multisig.fromArgs({ createKey: key(), configAuthority: PublicKey.default, threshold: 2, timeLock: 0, transactionIndex: Number(txIndex), staleTransactionIndex: 0,
    rentCollector: site.publicKey, bump: 255, members: [{ key: site.publicKey, permissions: ALL }, { key: cosigner.publicKey, permissions: VOTE_EXEC }, { key: backup.publicKey, permissions: ALL }] }).serialize()[0]);
  putMultisig();
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
  const net = { sends: 0, sims: 0, genesis: GENESIS_HASH[network], simErr: null as unknown, sendError: null as Error | null, onSend: null as (() => void) | null, onSim: null as (() => void) | null, status: { confirmationStatus: "confirmed", err: null } as unknown };
  const conn = {
    getGenesisHash: async () => net.genesis,
    getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null,
    getBalance: async () => 1_000_000_000,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
    simulateTransaction: async () => { net.sims++; net.onSim?.(); return { value: { err: net.simErr, logs: net.simErr ? ["Program x failed: boom"] : [], unitsConsumed: 5_000, accounts: [{ lamports: 999_990_000 }] } }; },
    getFeeForMessage: async () => ({ value: 5_000 }),
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
    getBlockHeight: async () => 1,
    sendRawTransaction: async () => { net.sends++; if (net.sendError) throw net.sendError; net.onSend?.(); return "sig"; },
    getSignatureStatuses: async () => ({ value: [net.status] }),
  };
  const out: string[] = [];
  const run = (...argv: string[]) => quorumAction(argv, { connect: () => conn as unknown as Connection, out: (l) => out.push(l) });
  return { dir, file, site, cosigner, backup, outsider, ms, vault, mint, target, program, propose, net, out, run, put, accounts, text: () => out.join("\n"),
    done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
type World = ReturnType<typeof world>;
const base = (w: World, network = "mainnet") => ["--network", network, "--multisig", w.ms.toBase58()];
const setPub = (w: World, to = w.target) => [setPublisherIx(TAX, w.vault, w.mint, to)];

// ---------- decoding ----------
test("classify: the two known shapes, exactly as this tool stores them", () => {
  const ms = key(), v = squadsVaultPda(SQUADS, ms), mint = key(), np = key();
  const m = classifyVaultTx(stored(ms, 1n, [memoIx(v, "check")]), v, TAX) as Extract<Shape, { kind: "memo" }>;
  assert.equal(m.kind, "memo"); assert.equal(m.text, "check"); assert.equal(m.hash, sha256Hex("check"));
  const s = classifyVaultTx(stored(ms, 2n, [setPublisherIx(TAX, v, mint, np)]), v, TAX) as Extract<Shape, { kind: "set-publisher" }>;
  assert.equal(s.kind, "set-publisher"); assert.ok(s.newPublisher.equals(np)); assert.ok(s.vault.equals(vaultPda(TAX, mint)));
});

test("classify: a list is named, not treated as a known shape", () => {
  const ms = key(), v = squadsVaultPda(SQUADS, ms);
  const s = classifyVaultTx(stored(ms, 1n, [publishListIx(TAX, v, key(), Buffer.alloc(32, 1), 4n, 5n, Buffer.alloc(33, 2))]), v, TAX);
  assert.equal(s.kind, "publish-list");
  assert.ok(expectationProblem(s, {})?.includes("cosigner"));
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
  assert.ok(genesisProblem({ network: "mainnet", genesis: "local", rpc: "http://127.0.0.1.evil.example:9", allowLocal: true }));
});

test("command: --network is required, and a wrong network refuses before anything else", async () => {
  const w = world();
  assert.equal(await w.run("status", "--multisig", w.ms.toBase58()), 1);
  assert.match(w.text(), /--network testnet\|mainnet is required/);
  w.out.length = 0;
  w.net.genesis = GENESIS_HASH.testnet;
  assert.equal(await w.run("status", ...base(w)), 1);
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
  assert.ok(new Refusal("x") instanceof Error);
  assert.throws(() => parseArgs(["approve", "--keypair", "--execute"]), /needs a value/);
  assert.throws(() => parseArgs(["approve", "--index", "1", "--index", "2"]), /twice/);
  assert.throws(() => parseArgs(["vote"]), /unknown subcommand/);
  assert.throws(() => parseArgs(["approve", "reject"]), /unexpected argument/);
  assert.ok(parseArgs(["approve", "--execute", "--index", "2"]).bools.has("execute"));
});

// ---------- keys ----------
test("keys: refuses a readable file; never echoes a bad file's contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-action-key-"));
  const k = Keypair.generate();
  const f = path.join(dir, "k.json");
  fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  assert.ok(loadMemberKey(f).publicKey.equals(k.publicKey));
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
    assert.match(w.text(), /DRY RUN/); assert.match(w.text(), /simulation OK/); assert.match(w.text(), /expected fee/); assert.match(w.text(), /nothing was sent/);
    assert.equal(w.net.sends, 0, `${argv[0]} sent nothing`);
  }
  w.done();
});

test("command: --execute sends once, then a proposal that doesn't read back is ambiguous, not resent", async () => {
  const w = world();
  assert.equal(await w.run("propose-memo", ...base(w), "--keypair", w.file(w.site, "s"), "--text", "hi", "--execute"), 3);
  assert.equal(w.net.sends, 1);
  assert.match(w.text(), /SENDING/); assert.match(w.text(), /doesn't read back yet: run status/);
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
  assert.doesNotMatch(w.text(), /CONFIRMED/);
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
  assert.match(w.text(), /WARNING: --allow-unknown/); assert.match(w.text(), /nothing was sent/);
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
