/**
 * Checks a proposed rewards list before a publisher quorum lets it go on-chain
 * (docs/tax-vault-spec.md "Publisher quorum"): scripts/cosigner.ts runs them on every
 * pending Squads proposal, the tests run them on hand-made lists.
 *
 *   decodePublishProposal  the vault transaction is exactly one publish_list of the tax_vault
 *                          program, signed by the multisig's vault PDA, nothing else
 *   verifyList             pure: the file (by its CID) gives the instruction's root; totals fit
 *                          the vault; nobody drops below the previous list or what they were
 *                          paid; the entries equal the allocation recomputed from the file's
 *                          inputs with its rules; no excluded wallet earns; the stated
 *                          balances match the chain (within a tolerance)
 *   checkProposal          fetches everything verifyList needs (vault, list files, paid
 *                          records, today's balances) for one proposal and runs it
 *
 * Errors fail the list (the co-signer rejects it); flags are reported (and fail it only with
 * `strict`).
 */
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { BURN_OWNERS, eligibleBalances, scanTokenAccounts } from "./holders.js";
import {
  CID_CODEC, CID_LEN, IX, buildVaultTree, cidFromBytes, decodeVault, effectiveList, vaultAuthPda, type Vault,
} from "./taxvault.js";
import {
  ACTIVATION_MARGIN_SECS, type ListFileJson, type RulesJson, defaultRules, eligibilityFor, listFromInputs, parseListFile, publisherExclusion,
  readPaidRecords, rulesFromJson,
} from "./vault-crank.js";
import { readQuorum, readVaultTx, squadsVaultPda, type VaultTx } from "./squads.js";
import { fetchFromGateways } from "./factory/ipfs.js";

export interface VerifyOptions {
  /** A wallet whose balance differs from the stated one by more than this share of it (bps) is "moved". */
  toleranceBps: number;
  /** More than this share (bps) of the stated weight moved: the snapshot doesn't match the chain. */
  maxMovedBps: number;
  /** A wallet new to the list getting more than this share (bps) of the pot is flagged. */
  largeShareBps: number;
  /** A snapshot older than this many slots is flagged (~1 h at 400 ms). */
  maxSnapshotAgeSlots: number;
  /** Accept eligibility rules that differ from the previous list's. */
  allowRuleChange: boolean;
  /** Accept a list that doesn't build on the previous one (its file was lost; see REVIEW.md D). */
  allowRebuild: boolean;
  /** Flags fail the list too. */
  strict: boolean;
}
export const DEFAULT_VERIFY: VerifyOptions = {
  toleranceBps: 500, maxMovedBps: 1000, largeShareBps: 2500, maxSnapshotAgeSlots: 9000, allowRuleChange: false, allowRebuild: false, strict: false,
};

/** publish_list's arguments. */
export interface PublishArgs { vault: PublicKey; root: Buffer; epoch: bigint; total: bigint; cid: Buffer }

/**
 * The vault transaction must be exactly one `publish_list` of `taxProgram`, accounts
 * [publisher PDA (signer), vault], run from vault index 0 with no ephemeral signers, lookup
 * tables or other account keys. Returns its arguments or throws with the reason.
 */
export function decodePublishProposal(tx: VaultTx, taxProgram: PublicKey, publisher: PublicKey): PublishArgs {
  if (tx.vaultIndex !== 0) throw new Error(`runs from multisig vault ${tx.vaultIndex}, not 0`);
  if (tx.ephemeralSigners !== 0) throw new Error("uses ephemeral signers");
  if (tx.lookups !== 0) throw new Error("uses address lookup tables");
  if (tx.instructions.length !== 1) throw new Error(`has ${tx.instructions.length} instructions; only a single publish_list is accepted`);
  const [ix] = tx.instructions;
  const program = tx.accountKeys[ix.programIdIndex];
  if (!program?.equals(taxProgram)) throw new Error(`calls ${program?.toBase58() ?? "?"}, not the tax_vault program`);
  if (ix.data.length !== 8 + 32 + 8 + 8 + CID_LEN || !ix.data.subarray(0, 8).equals(IX.publishList)) throw new Error("isn't publish_list");
  if (ix.accountIndexes.length !== 2) throw new Error("publish_list with other accounts than [publisher, vault]");
  const [pi, vi] = ix.accountIndexes;
  if (!tx.accountKeys[pi]?.equals(publisher) || pi >= tx.numSigners) throw new Error("the publisher isn't the multisig's vault (signer)");
  if (tx.accountKeys.length !== 3) throw new Error(`carries ${tx.accountKeys.length} account keys; publish_list needs 3`);
  const vault = tx.accountKeys[vi];
  if (!vault || vault.equals(publisher) || vault.equals(taxProgram)) throw new Error("bad vault account");
  const d = ix.data;
  return { vault, root: Buffer.from(d.subarray(8, 40)), epoch: d.readBigUInt64LE(40), total: d.readBigUInt64LE(48), cid: Buffer.from(d.subarray(56, 56 + CID_LEN)) };
}

export interface VerifyInput {
  taxProgram: PublicKey;
  /** The vault account now (its publisher must be `publisher`). */
  vault: Vault;
  publisher: PublicKey;
  /** The XDEX program (its pool authority never earns). */
  xdex: PublicKey;
  ix: PublishArgs;
  /** The proposed list file's bytes, as fetched by `ix.cid`. */
  file: Buffer;
  /** The on-chain effective list's file (checked against its root by the caller), null if there is none or it can't be read. */
  prevList: { wallets: Record<string, string>; rules?: RulesJson } | null;
  /** PaidRecords now. */
  paid: Map<string, bigint>;
  /** Eligible balances now, under the file's rules (null: not compared). */
  balancesNow: Map<string, bigint> | null;
  slotNow: number | null;
  /** Unix seconds (for the pending list's time). */
  now: number;
  opts?: Partial<VerifyOptions>;
}
export interface VerifyResult {
  ok: boolean;
  errors: string[];
  flags: string[];
  summary: { mint: string; epoch: string; total: string; wallets: number; pot: string | null; newXnt: string | null; prevEpoch: string | null; moved: number; cid: string | null };
}

const max = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a), 0n);
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2)}%`;
const isAmount = (x: unknown): x is string => typeof x === "string" && /^\d{1,20}$/.test(x) && BigInt(x) < 2n ** 64n;
const isKey = (w: unknown) => { try { return typeof w === "string" && new PublicKey(w).toBase58() === w; } catch { return false; } };
/** Pairs sorted by wallet, unique, valid keys and u64 amounts; null if not. */
function pairsOk(p: unknown): p is [string, string][] {
  if (!Array.isArray(p)) return false;
  for (let i = 0; i < p.length; i++) {
    const e = p[i];
    if (!Array.isArray(e) || e.length !== 2 || !isKey(e[0]) || !isAmount(e[1])) return false;
    if (i && !(p[i - 1][0] < e[0])) return false;
  }
  return true;
}

/** Every check on one proposed list (see the header); pure. */
export function verifyList(a: VerifyInput): VerifyResult {
  const o = { ...DEFAULT_VERIFY, ...a.opts };
  const errors: string[] = [], flags: string[] = [];
  const v = a.vault;
  const summary: VerifyResult["summary"] = { mint: v.mint.toBase58(), epoch: a.ix.epoch.toString(), total: a.ix.total.toString(), wallets: 0, pot: null, newXnt: null,
    prevEpoch: null, moved: 0, cid: cidFromBytes(a.ix.cid) };
  const done = () => {
    if (o.strict && flags.length) errors.push(...flags.map((f) => `(strict) ${f}`));
    return { ok: errors.length === 0, errors, flags, summary };
  };

  // --- the instruction and the vault ---
  if (!a.ix.vault.equals(v.address)) errors.push("the instruction's vault isn't the vault read");
  if (!v.publisher.equals(a.publisher)) errors.push(`the vault's publisher is ${v.publisher.toBase58()}, not the multisig's vault`);
  if (v.version < 3) errors.push(`vault v${v.version}: lists need v3`);
  const onChainEpoch = max(v.listEpoch, v.pendingEpoch);
  if (a.ix.epoch <= onChainEpoch) errors.push(`stale: epoch ${a.ix.epoch} isn't above the vault's ${onChainEpoch}`);
  const pendingWaiting = v.pendingEpoch > 0n && a.now < v.pendingActiveAt + ACTIVATION_MARGIN_SECS;
  if (pendingWaiting) errors.push(`list ${v.pendingEpoch} is pending until ${new Date(v.pendingActiveAt * 1000).toISOString()}: a new list would replace it`);
  const minTotal = max(v.listTotal, v.pendingTotal, v.holdersPaid);
  if (a.ix.total < minTotal) errors.push(`total ${a.ix.total} is under max(list_total, pending_total, holders_paid) = ${minTotal}`);
  if (a.ix.total > v.holdersFunded) errors.push(`total ${a.ix.total} is above holders_funded ${v.holdersFunded}`);

  // --- the file: its CID, its root, its fields ---
  if (a.ix.cid.every((b) => b === 0)) { errors.push("the instruction carries no list CID"); return done(); }
  if (a.ix.cid[0] === CID_CODEC.raw) {
    if (!crypto.createHash("sha256").update(a.file).digest().equals(a.ix.cid.subarray(1))) { errors.push("the file's bytes don't hash to the instruction's CID"); return done(); }
  } else {
    flags.push(`CID codec 0x${a.ix.cid[0].toString(16)} (not raw): the bytes can't be hash-checked here; checked against the root instead`);
  }
  let f: ListFileJson;
  try { f = JSON.parse(a.file.toString("utf8")); } catch { errors.push("the list file isn't JSON"); return done(); }
  if (f.vault !== v.address.toBase58()) errors.push("the file is for another vault");
  if (f.mint !== v.mint.toBase58()) errors.push("the file is for another mint");
  if (f.epoch !== a.ix.epoch.toString()) errors.push(`the file's epoch ${f.epoch} isn't the instruction's ${a.ix.epoch}`);
  if (f.total !== a.ix.total.toString()) errors.push(`the file's total ${f.total} isn't the instruction's ${a.ix.total}`);
  if (f.root !== a.ix.root.toString("hex")) errors.push("the file's root field isn't the instruction's root");
  if (!pairsOk(f.entries)) { errors.push("the file's entries aren't sorted, unique wallets with u64 amounts"); return done(); }
  const entries = new Map(f.entries.map(([w, c]) => [w, BigInt(c)] as [string, bigint]));
  summary.wallets = entries.size;
  if (!buildVaultTree(v.address, Object.fromEntries(f.entries)).root.equals(a.ix.root)) { errors.push("the file's entries don't give the instruction's Merkle root"); return done(); }
  let sum = 0n;
  for (const c of entries.values()) sum += c;
  if (sum !== a.ix.total) errors.push(`the entries add up to ${sum}, not the total ${a.ix.total}`);

  // --- nobody drops ---
  const eff = effectiveList(v, a.now);
  const prevEntries = a.prevList ? new Map(Object.entries(a.prevList.wallets).map(([w, c]) => [w, BigInt(c)] as [string, bigint])) : null;
  if (eff && !prevEntries) {
    (o.allowRebuild ? flags : errors).push(`the previous list ${eff.epoch}'s file couldn't be read: can't check that nobody's total drops${o.allowRebuild ? " (allowed: rebuild)" : ""}`);
  }
  if (prevEntries) {
    const lower = [...prevEntries].filter(([w, c]) => (entries.get(w) ?? 0n) < c);
    if (lower.length) errors.push(`${lower.length} wallet(s) below their total in the previous list: ${lower.slice(0, 5).map(([w, c]) => `${short(w)} ${entries.get(w) ?? 0n} < ${c}`).join(", ")}`);
  }
  const underPaid = [...a.paid].filter(([w, p]) => (entries.get(w) ?? 0n) < p);
  if (underPaid.length) errors.push(`${underPaid.length} wallet(s) below what they were already paid: ${underPaid.slice(0, 5).map(([w, p]) => `${short(w)} ${entries.get(w) ?? 0n} < ${p}`).join(", ")}`);

  // --- the inputs and the recomputed allocation ---
  const inp = f.inputs;
  if (!inp) { errors.push("the file has no inputs (balances, pot, previous list): it can't be checked"); return done(); }
  if (!isAmount(inp.slot) || !isAmount(inp.holdersFunded) || !isAmount(inp.floor) || !isAmount(inp.pot) || !pairsOk(inp.paid) || !pairsOk(inp.balances)) {
    errors.push("the file's inputs are malformed"); return done();
  }
  summary.pot = inp.pot;
  if (eff) {
    summary.prevEpoch = eff.epoch.toString();
    if (!inp.prev) (o.allowRebuild ? flags : errors).push(`the list doesn't build on the active list ${eff.epoch} (a rebuild)`);
    else if (inp.prev.epoch !== eff.epoch.toString() || inp.prev.root !== eff.root.toString("hex") || (cidFromBytes(eff.cid) ?? null) !== (inp.prev.cid ?? null)) {
      errors.push(`the list builds on list ${inp.prev.epoch}, not the vault's list ${eff.epoch} (root/CID)`);
    }
  } else if (inp.prev) errors.push("the list names a previous list but the vault has none");
  const statedPaid = new Map(inp.paid.map(([w, x]) => [w, BigInt(x)] as [string, bigint]));
  for (const [w, x] of statedPaid) if (x > (a.paid.get(w) ?? 0n)) errors.push(`stated paid ${x} for ${short(w)} is above its PaidRecord ${a.paid.get(w) ?? 0n}`);
  const prevForCalc = inp.prev && a.prevList ? a.prevList.wallets : null;
  const start = new Map<string, bigint>();
  for (const [w, c] of Object.entries(prevForCalc ?? {})) start.set(w, BigInt(c));
  for (const [w, p] of statedPaid) if (p > (start.get(w) ?? 0n)) start.set(w, p);
  let startSum = 0n;
  for (const x of start.values()) startSum += x;
  const funded = BigInt(inp.holdersFunded), pot = BigInt(inp.pot), floor = BigInt(inp.floor);
  if (funded > v.holdersFunded) errors.push(`stated holders_funded ${funded} is above the vault's ${v.holdersFunded}`);
  const wantPot = funded > startSum ? funded - startSum : 0n;
  if (pot !== wantPot) errors.push(`stated pot ${pot} isn't holders_funded ${funded} minus the wallets' starting totals ${startSum} (= ${wantPot})`);
  if (floor < v.listTotal || floor > minTotal) errors.push(`stated floor ${floor} is outside [list_total ${v.listTotal}, ${minTotal}]`);
  const re = listFromInputs(prevForCalc, inp);
  summary.newXnt = re.allocated.toString();
  const diffs: string[] = [];
  for (const w of new Set([...entries.keys(), ...Object.keys(re.wallets)])) {
    const got = entries.get(w) ?? 0n, want = BigInt(re.wallets[w] ?? "0");
    if (got !== want) diffs.push(`${short(w)} ${got} (recomputed ${want})`);
  }
  if (diffs.length) errors.push(`${diffs.length} entr${diffs.length === 1 ? "y differs" : "ies differ"} from the allocation recomputed from the inputs: ${diffs.slice(0, 5).join(", ")}`);

  // --- eligibility ---
  if (!f.rules) errors.push("the file carries no payout rules");
  const rules = rulesFromJson(f.rules, defaultRules(0n));
  const excluded = eligibilityFor(rules, vaultAuthPda(a.taxProgram, v.mint), a.xdex, [...publisherExclusion(a.publisher), a.publisher.toBase58()]).excluded;
  for (const b of BURN_OWNERS) excluded.add(b);
  const bad: string[] = [];
  for (const [w, b] of inp.balances) {
    const x = BigInt(b);
    if (excluded.has(w)) bad.push(`${short(w)} is excluded`);
    else if (x === 0n || x < rules.minHolding) bad.push(`${short(w)} holds ${x} < minHolding ${rules.minHolding}`);
    else if (rules.excludeOffCurve && !PublicKey.isOnCurve(new PublicKey(w).toBytes())) bad.push(`${short(w)} is off-curve`);
  }
  if (bad.length) errors.push(`${bad.length} stated balance(s) not eligible under the rules: ${bad.slice(0, 5).join(", ")}`);
  const gained = (w: string) => (entries.get(w) ?? 0n) - (start.get(w) ?? 0n);
  const paidExcluded = [...excluded].filter((w) => gained(w) > 0n);
  if (paidExcluded.length) errors.push(`excluded wallet(s) get XNT: ${paidExcluded.map(short).join(", ")}`);
  if (a.prevList?.rules && f.rules) {
    const p = rulesFromJson(a.prevList.rules, rules);
    const changed = p.minHolding !== rules.minHolding || p.excludeOffCurve !== rules.excludeOffCurve
      || [...p.excludeOwners].sort().join(",") !== [...rules.excludeOwners].sort().join(",");
    if (changed) (o.allowRuleChange ? flags : errors).push("the eligibility rules (minHolding, excludeOwners, excludeOffCurve) differ from the previous list's");
  }

  // --- the stated balances vs the chain now ---
  if (a.balancesNow) {
    const stated = new Map(inp.balances.map(([w, b]) => [w, BigInt(b)] as [string, bigint]));
    let weight = 0n, moved = 0n;
    const movedWallets: string[] = [];
    for (const x of stated.values()) weight += x;
    for (const w of new Set([...stated.keys(), ...a.balancesNow.keys()])) {
      const s = stated.get(w) ?? 0n, n = a.balancesNow.get(w) ?? 0n;
      const d = s > n ? s - n : n - s;
      const tol = max((s * BigInt(o.toleranceBps)) / 10_000n, rules.minHolding);
      if (d > tol) { moved += d; movedWallets.push(`${short(w)} ${s} -> ${n}`); }
    }
    summary.moved = movedWallets.length;
    if (movedWallets.length) flags.push(`${movedWallets.length} wallet(s) moved since the snapshot: ${movedWallets.slice(0, 10).join(", ")}`);
    if (weight > 0n && moved * 10_000n > weight * BigInt(o.maxMovedBps)) {
      errors.push(`the stated balances don't match the chain: ${pct((moved * 10_000n) / weight)} of the stated weight differs (limit ${pct(o.maxMovedBps)})`);
    } else if (weight === 0n && a.balancesNow.size) errors.push("no balances stated but the chain has eligible holders");
  }
  if (a.slotNow !== null) {
    const slot = BigInt(inp.slot);
    if (slot > BigInt(a.slotNow)) errors.push(`the snapshot slot ${slot} is in the future`);
    else if (BigInt(a.slotNow) - slot > BigInt(o.maxSnapshotAgeSlots)) flags.push(`the snapshot is ${BigInt(a.slotNow) - slot} slots old`);
  }

  // --- unusually large shares for wallets new to the list ---
  if (pot > 0n) {
    for (const [w] of entries) {
      if (prevEntries?.has(w) || a.paid.has(w)) continue;
      const g = gained(w);
      if (g * 10_000n > pot * BigInt(o.largeShareBps)) flags.push(`new wallet ${short(w)} gets ${pct((g * 10_000n) / pot)} of the pot`);
    }
  }
  return done();
}

// ---------- fetching what verifyList needs ----------
export interface ProposalCheck {
  index: bigint;
  result: VerifyResult | null;
  /** Why the proposal isn't a list at all (not a single publish_list, unknown vault ...). */
  refused: string | null;
  /** Something that may pass later (a list file not on the gateways yet): check again. */
  wait: string | null;
  args: PublishArgs | null;
  /** The list file's bytes (for a second pin). */
  file: Buffer | null;
}
/**
 * Check proposal `index` of multisig `ms`: decode its vault transaction, read the vault, the
 * list files (by CID from `gateways`), the paid records and today's balances, and verify.
 */
export async function checkProposal(conn: Connection, a: { squadsProgram: PublicKey; ms: PublicKey; index: bigint; taxProgram: PublicKey; gateways: string[];
  opts?: Partial<VerifyOptions> }): Promise<ProposalCheck> {
  const out: ProposalCheck = { index: a.index, result: null, refused: null, wait: null, args: null, file: null };
  const q = await readQuorum(conn, a.squadsProgram, a.ms);
  if (!q) { out.refused = "the multisig can't be read"; return out; }
  const tx = await readVaultTx(conn, a.squadsProgram, a.ms, a.index);
  if (!tx) { out.refused = "no vault transaction for this proposal"; return out; }
  const publisher = squadsVaultPda(a.squadsProgram, a.ms);
  try { out.args = decodePublishProposal(tx, a.taxProgram, publisher); } catch (e) { out.refused = `the transaction ${e instanceof Error ? e.message : e}`; return out; }
  const info = await conn.getAccountInfo(out.args.vault, "confirmed");
  if (!info || !info.owner.equals(a.taxProgram)) { out.refused = "the vault account isn't the tax_vault program's"; return out; }
  let v: Vault;
  try { v = decodeVault(out.args.vault, info.data); } catch { out.refused = "the vault account doesn't decode"; return out; }
  const cid = cidFromBytes(out.args.cid);
  if (!cid) { out.refused = "the instruction carries no list CID"; return out; }
  try { out.file = await fetchFromGateways(a.gateways, cid); } catch (e) { out.wait = `the list file ${cid} can't be fetched yet (${e instanceof Error ? e.message : e})`; return out; }
  const now = Math.floor(Date.now() / 1000);
  const eff = effectiveList(v, now);
  let prevList: VerifyInput["prevList"] = null;
  if (eff) {
    const pc = cidFromBytes(eff.cid);
    if (pc) {
      let bytes: Buffer;
      try { bytes = await fetchFromGateways(a.gateways, pc); } catch (e) { out.wait = `the previous list's file ${pc} can't be fetched yet (${e instanceof Error ? e.message : e})`; return out; }
      try {
        const { file, wallets } = parseListFile(bytes, v.address, eff.root, eff.cid);
        prevList = { wallets, rules: file.rules };
      } catch { /* a file that doesn't match its root: verifyList reports the missing previous list */ }
    }
  }
  const pool = await conn.getAccountInfo(v.pool, "confirmed");
  if (!pool) { out.refused = "the vault's pool doesn't exist"; return out; }
  const xdex = pool.owner;
  let rules = defaultRules(0n);
  try { rules = rulesFromJson((JSON.parse(out.file.toString("utf8")) as ListFileJson).rules, rules); } catch { /* verifyList reports it */ }
  const [paid, slotNow, rows] = await Promise.all([readPaidRecords(conn, a.taxProgram, v.address), conn.getSlot("confirmed"), scanTokenAccounts(conn, v.mint)]);
  const balancesNow = eligibleBalances(rows, eligibilityFor(rules, vaultAuthPda(a.taxProgram, v.mint), xdex, publisherExclusion(publisher)));
  out.result = verifyList({ taxProgram: a.taxProgram, vault: v, publisher, xdex, ix: out.args, file: out.file, prevList, paid, balancesNow, slotNow, now, opts: a.opts });
  return out;
}
