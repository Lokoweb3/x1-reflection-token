import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as squads from "@sqds/multisig";
import { Keypair, PublicKey, TransactionMessage, type AccountInfo } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  TAX_VAULT_PROGRAM_ID, buildVaultTree, cidToBytes, publishListIx, rawCid, setPublisherIx, vaultAuthPda, vaultPda, type Vault,
} from "../src/taxvault.js";
import { composeList, listFileText, listFromInputs, type ListInputsJson, type RulesJson } from "../src/vault-crank.js";
import { decodePublishProposal, verifyList, type VerifyInput } from "../src/list-verify.js";
import { SQUADS_PROGRAM_IDS, decodeVaultTx, proposeIxs, squadsTransactionPda, squadsVaultPda, voteMemo, type VaultTx } from "../src/squads.js";
import { poolAuthority } from "../src/xdex.js";

const key = () => Keypair.generate().publicKey;
const TAX = TAX_VAULT_PROGRAM_ID;
const SQUADS = SQUADS_PROGRAM_IDS.testnet;
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const RULES: RulesJson = { minHarvest: "50000000", minPayout: "1000000", minCycle: "10000000", minHolding: "1000", excludeOwners: [], excludeOffCurve: true };

/**
 * A vault published by a multisig, an active list 3 (A, B, C), A and B partly paid, and a
 * proposed list 4 built from the chain exactly as the site builds it.
 */
function scenario() {
  const ms = key(), publisher = squadsVaultPda(SQUADS, ms), mint = key(), vault = vaultPda(TAX, mint);
  const [A, B, C, D] = [key(), key(), key(), key()].map((k) => k.toBase58());
  const prevWallets = { [A]: "100000", [B]: "50000", [C]: "20000" };
  const prevRoot = buildVaultTree(vault, prevWallets).root;
  const prevText = listFileText({ mint: mint.toBase58(), vault: vault.toBase58(), epoch: "3", root: prevRoot.toString("hex"), total: "170000", wallets: prevWallets, rules: RULES });
  const prevCid = cidToBytes(rawCid(Buffer.from(prevText)));
  const v: Vault = {
    address: vault, mint, pool: key(), creatorNft: key(), rewardMint: NATIVE_MINT, rewardSwapPool: key(), publisher, guardian: key(),
    burnBps: 2500, lpBps: 2500, creatorBps: 1000, pendingTokens: 0n, lpTokens: 0n, sellLp: 0n, sellCreator: 0n, sellHolders: 0n, xntLp: 0n, xntCreator: 0n,
    holdersFunded: 1_170_000n, holdersPaid: 140_000n, listEpoch: 3n, listRoot: prevRoot, listTotal: 170_000n,
    pendingEpoch: 0n, pendingRoot: Buffer.alloc(32), pendingTotal: 0n, pendingActiveAt: 0,
    totalCollected: 0n, totalBurned: 0n, totalLpTokens: 0n, totalLpXnt: 0n, totalCreatorXnt: 0n, totalCrankRewards: 0n,
    createdAt: 1_780_000_000, bump: 255, authBump: 255, lastSellSlot: 0n, version: 3, cancelsInRow: 0, totalRewardOut: 0n, lastRewardSlot: 0n,
    lastPublishAt: 1_790_000_000, listCid: prevCid, pendingCid: Buffer.alloc(33), fallbackPaid: 0n,
  };
  const paid = new Map([[A, 100_000n], [B, 40_000n]]);
  const balances = new Map([[A, 5_000_000n], [B, 3_000_000n], [D, 2_000_000n]]); // C sold out
  const inputs: ListInputsJson = {
    slot: "1000", holdersFunded: v.holdersFunded.toString(), floor: "170000", pot: (v.holdersFunded - 170_000n).toString(),
    prev: { epoch: "3", root: prevRoot.toString("hex"), cid: rawCid(Buffer.from(prevText)) }, paid: [],
    balances: [...balances].map(([w, b]) => [w, b.toString()] as [string, string]).sort(([x], [y]) => (x < y ? -1 : 1)),
  };
  /** The list file and publish_list args for `wallets` (default: the honest list). */
  const make = (o: { wallets?: Record<string, string>; inputs?: ListInputsJson; rules?: RulesJson; epoch?: bigint } = {}) => {
    const inp = o.inputs ?? inputs;
    const wallets = o.wallets ?? listFromInputs(prevWallets, inp).wallets;
    const total = Object.values(wallets).reduce((a, x) => a + BigInt(x), 0n);
    const root = buildVaultTree(vault, wallets).root;
    const epoch = o.epoch ?? 4n;
    const text = listFileText({ mint: mint.toBase58(), vault: vault.toBase58(), epoch: epoch.toString(), root: root.toString("hex"), total: total.toString(), wallets, rules: o.rules ?? RULES, inputs: inp });
    const file = Buffer.from(text);
    return { wallets, file, ix: { vault, root, epoch, total, cid: cidToBytes(rawCid(file)) } };
  };
  const input = (m: ReturnType<typeof make>, over: Partial<VerifyInput> = {}): VerifyInput => ({
    taxProgram: TAX, vault: v, publisher, xdex: XDEX, ix: m.ix, file: m.file, prevList: { wallets: prevWallets, rules: RULES }, paid,
    balancesNow: new Map(balances), slotNow: 1100, now: 1_790_000_100, ...over,
  });
  return { ms, publisher, mint, vault, v, A, B, C, D, prevWallets, paid, balances, inputs, make, input };
}

test("list inputs: the builder's list is recomputed exactly and passes every check", () => {
  const s = scenario();
  const m = s.make();
  // A keeps its 100000 and gets 5/10 of the new 1,000,000; C keeps 20000 though it sold.
  assert.equal(m.wallets[s.A], String(100_000n + 500_000n));
  assert.equal(m.wallets[s.C], "20000");
  const r = verifyList(s.input(m));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.flags, []);
  assert.ok(r.ok);
  assert.equal(r.summary.wallets, 4);
  assert.equal(r.summary.newXnt, "1000000");
  // The file's new fields don't break old readers: entries/rules still where they were.
  const f = JSON.parse(m.file.toString());
  assert.deepEqual(Object.keys(f), ["version", "mint", "vault", "epoch", "root", "total", "entries", "rules", "inputs"]);
});

test("list inputs: the top-up to the floor goes to the largest share, ties to the smaller address", () => {
  const [x, y] = [key().toBase58(), key().toBase58()].sort();
  const r = composeList(null, new Map(), new Map([[y, 5n], [x, 5n]]), 11n);
  assert.equal(r.wallets[x], "6");
  assert.equal(r.wallets[y], "5");
  assert.deepEqual(composeList(null, new Map(), new Map([[x, 5n], [y, 5n]]), 11n).wallets, r.wallets);
});

test("verify: a wallet whose total drops below the previous list (or its payment) fails", () => {
  const s = scenario();
  const honest = s.make().wallets;
  // B goes from 50000 (previous list) to 30000, the difference to D.
  const w = { ...honest, [s.B]: String(BigInt(honest[s.B]) - BigInt(honest[s.B]) + 30_000n) };
  w[s.D] = String(BigInt(honest[s.D]) + BigInt(honest[s.B]) - 30_000n);
  const r = verifyList(s.input(s.make({ wallets: w })));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /below their total in the previous list/.test(e)), r.errors.join("\n"));
  assert.ok(r.errors.some((e) => /below what they were already paid/.test(e)));
  assert.ok(r.errors.some((e) => /recomputed from the inputs/.test(e)));
});

test("verify: totals must add up and fit the vault", () => {
  const s = scenario();
  const m = s.make();
  const r1 = verifyList(s.input(m, { ix: { ...m.ix, total: m.ix.total + 1n } }));
  assert.ok(r1.errors.some((e) => /add up to/.test(e)) && r1.errors.some((e) => /file's total/.test(e)), r1.errors.join("\n"));
  // More than was ever funded for holders.
  const r2 = verifyList(s.input(m, { vault: { ...s.v, holdersFunded: m.ix.total - 1n } }));
  assert.ok(r2.errors.some((e) => /above holders_funded/.test(e)));
  // Below what was already paid out.
  const r3 = verifyList(s.input(m, { vault: { ...s.v, holdersPaid: m.ix.total + 1n } }));
  assert.ok(r3.errors.some((e) => /is under max\(list_total/.test(e)));
  // Stale: the vault already has this epoch.
  const r4 = verifyList(s.input(m, { vault: { ...s.v, listEpoch: 4n } }));
  assert.ok(r4.errors.some((e) => /^stale/.test(e)));
});

test("verify: an excluded wallet (pool authority, vault auth, the multisig) paid is refused", () => {
  const s = scenario();
  for (const bad of [poolAuthority(XDEX).toBase58(), vaultAuthPda(TAX, s.mint).toBase58(), s.publisher.toBase58(), "1nc1nerator11111111111111111111111111111111"]) {
    // A consistent list: the excluded wallet is in the stated balances and gets its pro-rata share.
    const inputs = { ...s.inputs, balances: [...s.inputs.balances, [bad, "4000000"] as [string, string]].sort(([x], [y]) => (x < y ? -1 : 1)) };
    const r = verifyList(s.input(s.make({ inputs }), { balancesNow: null }));
    assert.equal(r.ok, false, bad);
    assert.ok(r.errors.some((e) => /not eligible/.test(e)), r.errors.join("\n"));
    assert.ok(r.errors.some((e) => /excluded wallet\(s\) get XNT/.test(e)), r.errors.join("\n"));
  }
  // An excluded owner from the rules too.
  const rules = { ...RULES, excludeOwners: [s.D] };
  const r = verifyList(s.input(s.make({ rules }), { prevList: { wallets: s.prevWallets, rules } }));
  assert.ok(r.errors.some((e) => /excluded/.test(e)));
});

test("verify: an attacker's made-up balance doesn't match the chain; a large new share is flagged", () => {
  const s = scenario();
  const attacker = key().toBase58();
  const inputs = { ...s.inputs, balances: [...s.inputs.balances, [attacker, "90000000"] as [string, string]].sort(([x], [y]) => (x < y ? -1 : 1)) };
  const r = verifyList(s.input(s.make({ inputs })));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /don't match the chain/.test(e)), r.errors.join("\n"));
  assert.ok(r.flags.some((f) => /moved since the snapshot/.test(f)));
  assert.ok(r.flags.some((f) => /new wallet .* gets 9\d\.\d\d% of the pot/.test(f)), r.flags.join("\n"));
  // A small move within the tolerance is fine; strict turns flags into failures.
  const now = new Map(s.balances); now.set(s.A, 5_100_000n);
  assert.ok(verifyList(s.input(s.make(), { balancesNow: now })).ok);
  now.set(s.A, 6_000_000n);
  const moved = verifyList(s.input(s.make(), { balancesNow: now }));
  assert.ok(moved.ok && moved.flags.length === 1, moved.errors.join("\n"));
  assert.equal(verifyList(s.input(s.make(), { balancesNow: now, opts: { strict: true } })).ok, false);
});

test("verify: a file that isn't the instruction's (root, CID, vault) or has no inputs fails", () => {
  const s = scenario();
  const m = s.make();
  const wrongRoot = verifyList(s.input(m, { ix: { ...m.ix, root: crypto.randomBytes(32) } }));
  assert.ok(wrongRoot.errors.some((e) => /Merkle root/.test(e)), wrongRoot.errors.join("\n"));
  const other = s.make({ wallets: { ...m.wallets, [s.D]: String(BigInt(m.wallets[s.D]) - 1n) } });
  const wrongCid = verifyList(s.input(m, { ix: { ...m.ix, cid: other.ix.cid } }));
  assert.ok(wrongCid.errors.some((e) => /don't hash to the instruction's CID/.test(e)));
  const noCid = verifyList(s.input(m, { ix: { ...m.ix, cid: Buffer.alloc(33) } }));
  assert.ok(noCid.errors.some((e) => /no list CID/.test(e)));
  const f = JSON.parse(m.file.toString()); delete f.inputs;
  const bare = Buffer.from(JSON.stringify(f));
  const noInputs = verifyList(s.input(m, { file: bare, ix: { ...m.ix, cid: cidToBytes(rawCid(bare)) } }));
  assert.ok(noInputs.errors.some((e) => /no inputs/.test(e)));
  // Built on another list than the vault's active one.
  const inputs = { ...s.inputs, prev: { ...s.inputs.prev!, root: crypto.randomBytes(32).toString("hex") } };
  assert.ok(verifyList(s.input(s.make({ inputs }))).errors.some((e) => /builds on list/.test(e)));
  // The previous list's file unreadable: refused unless a rebuild is accepted.
  assert.ok(verifyList(s.input(m, { prevList: null })).errors.some((e) => /couldn't be read/.test(e)));
  // Changed eligibility rules need --allow-rule-change.
  const rules = { ...RULES, minHolding: "2000" };
  const changed = s.make({ rules });
  assert.ok(verifyList(s.input(changed)).errors.some((e) => /rules/.test(e)));
  assert.ok(verifyList(s.input(changed, { opts: { allowRuleChange: true } })).ok);
});

/** A stored vault transaction as Squads writes it, from `ixs` (through the SDK's own message encoding). */
function storedVaultTx(ms: PublicKey, index: bigint, ixs: Parameters<typeof proposeIxs>[4][]): VaultTx {
  const vaultPdaKey = squadsVaultPda(SQUADS, ms);
  const bytes = squads.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: new TransactionMessage({ payerKey: vaultPdaKey, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }), vaultPda: vaultPdaKey,
  });
  // The instruction carries the compact message; the account stores it with borsh vectors.
  const [m] = squads.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const message = { ...m, instructions: m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountIndexes: Uint8Array.from(i.accountIndexes), data: Uint8Array.from(i.data) })),
    addressTableLookups: m.addressTableLookups.map((l) => ({ accountKey: l.accountKey, writableIndexes: Uint8Array.from(l.writableIndexes), readonlyIndexes: Uint8Array.from(l.readonlyIndexes) })) };
  const [data] = squads.accounts.VaultTransaction.fromArgs({ multisig: ms, creator: key(), index: Number(index), bump: 255, vaultIndex: 0, vaultBump: 255,
    ephemeralSignerBumps: new Uint8Array(), message }).serialize();
  const info: AccountInfo<Buffer> = { owner: SQUADS, data, lamports: 1, executable: false, rentEpoch: 0 };
  assert.ok(squadsTransactionPda(SQUADS, ms, index));
  return decodeVaultTx(SQUADS, ms, index, info)!;
}

test("vault transaction: only a single publish_list of the tax_vault program, signed by the multisig's vault", () => {
  const s = scenario();
  const m = s.make();
  const publish = publishListIx(TAX, s.publisher, s.mint, m.ix.root, m.ix.epoch, m.ix.total, m.ix.cid);
  const ok = decodePublishProposal(storedVaultTx(s.ms, 5n, [publish]), TAX, s.publisher);
  assert.ok(ok.vault.equals(s.vault) && ok.root.equals(m.ix.root) && ok.epoch === 4n && ok.total === m.ix.total && ok.cid.equals(m.ix.cid));
  // What the site proposes decodes the same way (vault_transaction_create carries the message).
  assert.equal(proposeIxs(SQUADS, s.ms, 5n, key(), publish).length, 3);
  const refuse = (ixs: Parameters<typeof proposeIxs>[4][], re: RegExp) => assert.throws(() => decodePublishProposal(storedVaultTx(s.ms, 5n, ixs), TAX, s.publisher), re);
  refuse([publish, publishListIx(TAX, s.publisher, key(), m.ix.root, 9n, 1n, m.ix.cid)], /2 instructions/);
  refuse([setPublisherIx(TAX, s.publisher, s.mint, key())], /isn't publish_list/);
  refuse([publishListIx(key(), s.publisher, s.mint, m.ix.root, m.ix.epoch, m.ix.total, m.ix.cid)], /not the tax_vault program/);
  // An extra account slipped into the instruction.
  const extra = publishListIx(TAX, s.publisher, s.mint, m.ix.root, m.ix.epoch, m.ix.total, m.ix.cid);
  extra.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
  refuse([extra], /other accounts/);
  // Signed by another key than the multisig's vault.
  const other = publishListIx(TAX, key(), s.mint, m.ix.root, m.ix.epoch, m.ix.total, m.ix.cid);
  assert.throws(() => decodePublishProposal({ ...storedVaultTx(s.ms, 5n, [other]) }, TAX, s.publisher), /publisher isn't the multisig's vault|account keys/);
  assert.throws(() => decodePublishProposal({ ...storedVaultTx(s.ms, 5n, [publish]), vaultIndex: 1 }, TAX, s.publisher), /vault 1/);
  assert.throws(() => decodePublishProposal({ ...storedVaultTx(s.ms, 5n, [publish]), ephemeralSigners: 1 }, TAX, s.publisher), /ephemeral/);
});

test("votes: the co-signer's reason is read back from proposal_reject's memo", () => {
  const ix = squads.instructions.proposalReject({ multisigPda: key(), transactionIndex: 3n, member: key(), memo: "99tax co-signer: a wallet dropped", programId: SQUADS });
  assert.deepEqual(voteMemo(ix.data), { vote: "reject", memo: "99tax co-signer: a wallet dropped" });
  const ap = squads.instructions.proposalApprove({ multisigPda: key(), transactionIndex: 3n, member: key(), programId: SQUADS });
  assert.deepEqual(voteMemo(ap.data), { vote: "approve", memo: null });
  assert.equal(voteMemo(Buffer.alloc(16)), null);
});
