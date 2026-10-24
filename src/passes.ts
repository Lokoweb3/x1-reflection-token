/**
 * Holder passes (vault "v4", X1 testnet trial): the holders' share is split on-chain over
 * registered wallets' live balances instead of a Merkle list. Client side of the tax_vault
 * instructions init_passes, register_pass, snapshot_batch, close_round, pay_passes and
 * remove_pass (lp-locker/programs/tax_vault, feature passes-testnet).
 *
 * Registering needs REGISTER_HOLDING_MULT times the reward minimum in the wallet. A round:
 * snapshot_batch(0) opens it and reads the first wallets' balances, later batches continue
 * in book order, all within MAX_BATCH_SLOTS; close_round splits the waiting pot once every
 * pass is read (all of it for a round read in one batch, otherwise capped at
 * POT_CAP_PCT_OF_TAX of the tax rate on the eligible tokens' value); pay_passes sends each
 * pass's wallet what it is owed. The crank keeps an address lookup table of the book's
 * accounts (passLookupAddresses) so its rounds take fewer, larger transactions.
 */
import crypto from "node:crypto";
import { AddressLookupTableAccount, AddressLookupTableProgram, Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { VAULT_PAYOUT_OFFSETS, vaultAuthPda, vaultPda } from "./taxvault.js";

/** The testnet trial's program (its own ID, so the live testnet vault program is untouched). */
export const PASSES_PROGRAM_ID = new PublicKey("Aqt57qzgBy9cJLiygL6V8fHK7Sov7DwXeQFAm8aphxc8");
/** Vault byte that marks holder passes (Vault::reserved[PASS_MODE_BYTE]). */
export const PASS_MODE_OFFSET = VAULT_PAYOUT_OFFSETS.reserved;
export const MAX_PASSES = 256;
/** A full book's account size (8 + PassBook: a 120-byte head, then 88 bytes per pass). */
export const PASS_BOOK_LEN = 120 + 88 * MAX_PASSES;
/** Most an instruction may grow an account (alloc_pass_book's step). */
export const ALLOC_STEP = 10_240;
/** alloc_pass_book calls that take a book of `len` bytes (0: none yet) to its full size. */
export const allocSteps = (len: number) => Math.max(0, Math.ceil((PASS_BOOK_LEN - len) / ALLOC_STEP));
export const MAX_BATCH_SLOTS = 150;
/** Token accounts per snapshot batch without a lookup table (fits the 1,232-byte transaction). */
export const SNAPSHOT_BATCH = 24;
/** Wallets per pay_passes transaction. */
export const PAY_BATCH = 20;
/** With a lookup table, under X1's 64 accounts per transaction (5 fixed + programs). */
export const SNAPSHOT_BATCH_LUT = 56;
export const PAY_BATCH_LUT = 50;
/** Closing a round pays its caller 1% of it, at most 0.05 XNT (ROUND_REWARD_BPS / _CAP). */
export const roundReward = (alloc: bigint) => { const r = alloc / 100n; return r > 50_000_000n ? 50_000_000n : r; };
/**
 * Compute-unit limits for a visitor's round (X1 bills the units a transaction asks for):
 * measured on testnet (~33k for 56 reads, ~131k to close 256 passes, ~134k to pay 50) plus a margin.
 */
export const passUnits = {
  read: (n: number) => 12_000 + 600 * n,
  close: (passes: number) => 25_000 + 600 * passes,
  pay: (n: number) => 12_000 + 3_000 * n,
};
/** Registering needs this many times the book's min_holding (the program's REGISTER_HOLDING_MULT). */
export const REGISTER_HOLDING_MULT = 2n;
/** A multi-batch round pays at most this % of the tax rate on the eligible value (POT_CAP_PCT_OF_TAX). */
export const POT_CAP_PCT_OF_TAX = 80;
/** The balance a wallet needs to register (never zero). */
export const registerMinimum = (minHolding: bigint) => (minHolding * REGISTER_HOLDING_MULT > 0n ? minHolding * REGISTER_HOLDING_MULT : 1n);

const disc = (name: string) => crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };

export const passBookPda = (program: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("passes"), vault.toBuffer()], program)[0];
export const passPda = (program: PublicKey, vault: PublicKey, wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pass"), vault.toBuffer(), wallet.toBuffer()], program)[0];
export const holderTokenAccount = (wallet: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, wallet, true, TOKEN_2022_PROGRAM_ID);

/** Holder passes are on for this raw vault account. */
export const passModeOn = (vaultData: Buffer) => vaultData.length > PASS_MODE_OFFSET && vaultData[PASS_MODE_OFFSET] === 1;

export interface PassEntry { index: number; wallet: PublicKey; tokenAccount: PublicKey; weight: bigint; owed: bigint; paid: bigint }
export interface PassBook {
  address: PublicKey; vault: PublicKey; minHolding: bigint; minPot: bigint; minInterval: number;
  allocated: bigint; rounds: bigint; roundStartSlot: bigint; roundWeight: bigint; lastRoundAt: number;
  count: number; roundNext: number; roundOpen: boolean; roundBatches: number; entries: PassEntry[];
}

/** Decode a PassBook account (zero-copy layout: see PassBook in the program). */
export function decodePassBook(address: PublicKey, d: Buffer): PassBook {
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const r64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const ri64 = () => { const v = Number(d.readBigInt64LE(o)); o += 8; return v; };
  const vault = key();
  const minHolding = r64(), minPot = r64(), minInterval = ri64(), allocated = r64(), rounds = r64();
  const roundStartSlot = r64(), roundWeight = r64(), lastRoundAt = ri64();
  const count = d.readUInt32LE(o), roundNext = d.readUInt32LE(o + 4); o += 8;
  const roundOpen = d[o] === 1, roundBatches = d[o + 2]; o += 8;
  const entries: PassEntry[] = [];
  for (let i = 0; i < count; i++) {
    const wallet = key(), tokenAccount = key();
    entries.push({ index: i, wallet, tokenAccount, weight: r64(), owed: r64(), paid: r64() });
  }
  return { address, vault, minHolding, minPot, minInterval, allocated, rounds, roundStartSlot, roundWeight, lastRoundAt, count, roundNext, roundOpen, roundBatches, entries };
}

/** Anyone adds `lamports` of XNT to an XNT vault's holders' share (sponsor_holders). */
export function sponsorHoldersIx(program: PublicKey, sponsor: PublicKey, mint: PublicKey, lamports: bigint) {
  return new TransactionInstruction({
    programId: program, data: Buffer.concat([disc("sponsor_holders"), u64(lamports)]),
    keys: [m(sponsor, true, true), m(vaultPda(program, mint), false, true), m(vaultAuthPda(program, mint), false, true), m(SystemProgram.programId, false, false)],
  });
}

/** Create or grow the pass book by one step (anyone may pay; init_passes needs the full size). */
export function allocPassBookIx(program: PublicKey, payer: PublicKey, mint: PublicKey) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program, data: disc("alloc_pass_book"),
    keys: [m(payer, true, true), m(vault, false, false), m(passBookPda(program, vault), false, true), m(SystemProgram.programId, false, false)],
  });
}

export function initPassesIx(program: PublicKey, guardian: PublicKey, mint: PublicKey, minHolding: bigint, minPot: bigint, minIntervalSecs: bigint) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program,
    data: Buffer.concat([disc("init_passes"), u64(minHolding), u64(minPot), i64(minIntervalSecs)]),
    keys: [m(guardian, true, true), m(vault, false, true), m(passBookPda(program, vault), false, true), m(SystemProgram.programId, false, false)],
  });
}

export function registerPassIx(program: PublicKey, wallet: PublicKey, mint: PublicKey) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program, data: disc("register_pass"),
    keys: [m(wallet, true, true), m(vault, false, false), m(passBookPda(program, vault), false, true),
      m(passPda(program, vault, wallet), false, true), m(holderTokenAccount(wallet, mint), false, false), m(SystemProgram.programId, false, false)],
  });
}

export function snapshotBatchIx(program: PublicKey, caller: PublicKey, mint: PublicKey, start: number, tokenAccounts: PublicKey[]) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program, data: Buffer.concat([disc("snapshot_batch"), u32(start)]),
    keys: [m(caller, true, false), m(vault, false, false), m(passBookPda(program, vault), false, true),
      ...tokenAccounts.map((a) => m(a, false, false))],
  });
}

export function closeRoundIx(program: PublicKey, caller: PublicKey, mint: PublicKey, pool: PublicKey, tokenVault: PublicKey, wxntVault: PublicKey) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program, data: disc("close_round"),
    keys: [m(caller, true, true), m(vault, false, true), m(mint, false, false), m(passBookPda(program, vault), false, true),
      m(pool, false, false), m(tokenVault, false, false), m(wxntVault, false, false),
      m(vaultAuthPda(program, mint), false, true), m(SystemProgram.programId, false, false)],
  });
}

export function payPassesIx(program: PublicKey, caller: PublicKey, mint: PublicKey, entries: Pick<PassEntry, "index" | "wallet">[]) {
  const vault = vaultPda(program, mint);
  const idx = Buffer.concat([u32(entries.length), ...entries.map((e) => u32(e.index))]);
  return new TransactionInstruction({
    programId: program, data: Buffer.concat([disc("pay_passes"), idx]),
    keys: [m(caller, true, false), m(vault, false, true), m(passBookPda(program, vault), false, true),
      m(vaultAuthPda(program, mint), false, true), m(SystemProgram.programId, false, false),
      ...entries.map((e) => m(e.wallet, false, true))],
  });
}

/**
 * remove_pass for the pass at `index` (anyone may send it once the wallet holds less than
 * the book's minimum and is owed nothing): the book's last pass moves into its place, and
 * the pass account's rent goes back to its wallet. `tables`: whether the book's lookup-table
 * record exists (the program then keeps its `indexed` count right; leave it out and it
 * isn't). An omitted optional account is passed as the program's own ID (Anchor's rule).
 */
export function removePassIx(program: PublicKey, caller: PublicKey, mint: PublicKey, book: Pick<PassBook, "count" | "entries">, index: number, tables: boolean) {
  const vault = vaultPda(program, mint);
  const e = book.entries[index], last = book.entries[book.count - 1];
  return new TransactionInstruction({
    programId: program, data: disc("remove_pass"),
    keys: [m(caller, true, false), m(vault, false, false), m(passBookPda(program, vault), false, true),
      m(passPda(program, vault, e.wallet), false, true), m(e.wallet, false, true), m(e.tokenAccount, false, false),
      index === book.count - 1 ? m(program, false, false) : m(passPda(program, vault, last.wallet), false, true),
      tables ? m(passTablesPda(program, vault), false, true) : m(program, false, false)],
  });
}

/** The tax-token balance remove_pass and snapshots count: the account's amount, or 0 unless it is `wallet`'s Token-2022 account of `mint`. */
export function heldBy(info: { owner: PublicKey; data: Buffer } | null, mint: PublicKey, wallet: PublicKey): bigint {
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID) || info.data.length < 165) return 0n;
  if (!info.data.subarray(0, 32).equals(mint.toBuffer()) || !info.data.subarray(32, 64).equals(wallet.toBuffer())) return 0n;
  return info.data.readBigUInt64LE(64);
}

/** The wallets whose pass remove_pass accepts now: holding under the book's minimum and owed nothing. */
export async function removablePasses(conn: Connection, mint: PublicKey, book: PassBook): Promise<Set<string>> {
  const out = new Set<string>();
  const candidates = book.entries.filter((e) => e.owed === e.paid);
  for (let i = 0; i < candidates.length; i += 100) {
    const part = candidates.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(part.map((e) => e.tokenAccount), "confirmed");
    part.forEach((e, j) => { if (heldBy(infos[j], mint, e.wallet) < book.minHolding) out.add(e.wallet.toBase58()); });
  }
  return out;
}

/**
 * remove_pass calls (one per transaction, sent in order) for up to `max` of `wallets`,
 * each against the book as the earlier ones leave it (the last pass moves into a removed
 * one's place).
 */
export function removalPlan(program: PublicKey, caller: PublicKey, mint: PublicKey, book: PassBook, wallets: Set<string>, tables: boolean, max = 10) {
  const entries = book.entries.map((e) => ({ ...e }));
  const out: { wallet: PublicKey; ix: TransactionInstruction }[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    if (!wallets.has(entries[i].wallet.toBase58())) continue;
    out.push({ wallet: entries[i].wallet, ix: removePassIx(program, caller, mint, { count: entries.length, entries }, i, tables) });
    const last = entries.pop()!;
    if (i < entries.length) entries[i] = { ...last, index: i };
  }
  return out;
}

export const ALT_PROGRAM_ID = AddressLookupTableProgram.programId;
export const INDEX_BATCH = 25;
export const MAX_PASS_TABLES = 4;
export const passTablesPda = (program: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pass_tables"), vault.toBuffer()], program)[0];
export const tableAuthPda = (program: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pass_lut"), vault.toBuffer()], program)[0];

/** The program's lookup-table record for a book (PassTables), or null before index_passes made it. */
export interface PassTablesRecord { tables: PublicKey[]; lens: number[]; indexed: number; headDone: boolean }
export function decodePassTables(d: Buffer): PassTablesRecord {
  let o = 8 + 32;
  const all = Array.from({ length: MAX_PASS_TABLES }, () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; });
  const lens = Array.from({ length: MAX_PASS_TABLES }, () => { const v = d.readUInt16LE(o); o += 2; return v; });
  const n = d[o]; o += 1;
  const indexed = d.readUInt32LE(o); o += 4;
  const headDone = d[o] === 1;
  return { tables: all.slice(0, n), lens: lens.slice(0, n), indexed, headDone };
}
export async function readPassTables(conn: Connection, program: PublicKey, mint: PublicKey): Promise<PassTablesRecord | null> {
  const info = await conn.getAccountInfo(passTablesPda(program, vaultPda(program, mint)), "confirmed");
  return info ? decodePassTables(info.data) : null;
}

export function indexPassesIx(program: PublicKey, payer: PublicKey, mint: PublicKey, table: PublicKey, recentSlot: bigint, maxPasses = INDEX_BATCH) {
  const vault = vaultPda(program, mint);
  return new TransactionInstruction({
    programId: program, data: Buffer.concat([disc("index_passes"), u64(recentSlot), Buffer.from([maxPasses])]),
    keys: [m(payer, true, true), m(vault, false, false), m(passBookPda(program, vault), false, false), m(passTablesPda(program, vault), false, true),
      m(tableAuthPda(program, vault), false, false), m(table, false, true), m(ALT_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false)],
  });
}

/**
 * The index_passes calls (one per transaction, sent in order) that bring the program's
 * lookup tables up to date with the book, replaying the program's own rule for when a new
 * table starts. Each new table needs a distinct recent slot that has a block; they're taken
 * from the chain's latest finalized blocks.
 */
export async function indexPlan(conn: Connection, program: PublicKey, mint: PublicKey, book: PassBook, payer: PublicKey): Promise<TransactionInstruction[]> {
  const rec = (await readPassTables(conn, program, mint)) ?? { tables: [], lens: [], indexed: 0, headDone: false };
  const tables = [...rec.tables], lens = [...rec.lens];
  let { indexed, headDone } = rec;
  const out: TransactionInstruction[] = [];
  let slots: number[] | null = null;
  const auth = tableAuthPda(program, vaultPda(program, mint));
  while (indexed < book.count || !headDone) {
    const batch = Math.min(INDEX_BATCH, book.count - indexed);
    const add = (headDone ? 0 : 3) + 2 * batch;
    if (!add) break;
    let table: PublicKey, slot = 0n;
    if (!tables.length || lens[lens.length - 1] + add > 256) {
      if (tables.length >= MAX_PASS_TABLES) break;
      if (!slots) { const fin = await conn.getSlot("finalized"); slots = (await conn.getBlocks(Math.max(0, fin - 120), fin)).reverse(); }
      const sl = slots.shift();
      if (sl === undefined) break;
      slot = BigInt(sl);
      const sb = Buffer.alloc(8); sb.writeBigUInt64LE(slot);
      table = PublicKey.findProgramAddressSync([auth.toBuffer(), sb], ALT_PROGRAM_ID)[0];
      tables.push(table); lens.push(0);
    } else table = tables[tables.length - 1];
    out.push(indexPassesIx(program, payer, mint, table, slot, batch || 1));
    lens[lens.length - 1] += add; indexed += batch; headDone = true;
  }
  return out;
}

/**
 * What a book's lookup table holds: the vault, its book and auth (index 0 is the vault, so
 * the crank can find its table again), then every pass's token account and wallet.
 */
export function passLookupAddresses(program: PublicKey, mint: PublicKey, book: PassBook): PublicKey[] {
  const vault = vaultPda(program, mint);
  return [vault, passBookPda(program, vault), vaultAuthPda(program, mint), ...book.entries.flatMap((e) => [e.tokenAccount, e.wallet])];
}

/**
 * The lookup tables `authority` (the crank; any, when not given) keeps for a vault's book
 * (each starts with the vault), when together they hold every address passLookupAddresses
 * lists, keeping only the tables needed for that; else [] (rounds
 * then use plain transactions). The program checks every account, so a table can only make
 * a transaction shorter, never point it elsewhere.
 */
export async function passTablesFor(conn: Connection, program: PublicKey, mint: PublicKey, book: PassBook, authority?: PublicKey): Promise<AddressLookupTableAccount[]> {
  const vault = vaultPda(program, mint);
  // The program's own tables first, when they cover the whole book.
  const rec = await readPassTables(conn, program, mint).catch(() => null);
  if (rec && rec.tables.length && rec.indexed >= book.count) {
    const own = (await Promise.all(rec.tables.map((k) => conn.getAddressLookupTable(k, { commitment: "confirmed" }).then((r) => r.value).catch(() => null))))
      .filter((t): t is AddressLookupTableAccount => !!t && t.isActive());
    const have = new Set(own.flatMap((t) => t.state.addresses.map((a) => a.toBase58())));
    if (own.length === rec.tables.length && passLookupAddresses(program, mint, book).every((a) => have.has(a.toBase58()))) return own;
  }
  // Without an authority (a page with no server), any table that starts with the vault will do.
  const found = await conn.getProgramAccounts(AddressLookupTableProgram.programId, {
    commitment: "confirmed", dataSlice: { offset: 0, length: 0 },
    filters: [...(authority ? [{ memcmp: { offset: 22, bytes: authority.toBase58() } }] : []), { memcmp: { offset: 56, bytes: vault.toBase58() } }],
  }).catch(() => []);
  const tables = (await Promise.all(found.map((f) => conn.getAddressLookupTable(f.pubkey, { commitment: "confirmed" }).then((r) => r.value).catch(() => null))))
    .filter((t): t is AddressLookupTableAccount => !!t && t.isActive());
  // Fewest tables first-fit: the largest that add something new (others may be strays).
  const want = new Set(passLookupAddresses(program, mint, book).map((a) => a.toBase58()));
  const chosen: AddressLookupTableAccount[] = [];
  for (const t of tables.sort((a, b) => b.state.addresses.length - a.state.addresses.length)) {
    if (!want.size) break;
    const adds = t.state.addresses.filter((a) => want.has(a.toBase58()));
    if (!adds.length) continue;
    chosen.push(t);
    for (const a of adds) want.delete(a.toBase58());
  }
  return want.size ? [] : chosen;
}

/** Split a round's reads into snapshot batches, in book order. */
export function snapshotBatches(book: PassBook, size = SNAPSHOT_BATCH): { start: number; accounts: PublicKey[] }[] {
  const out: { start: number; accounts: PublicKey[] }[] = [];
  for (let s = 0; s < book.count; s += size) out.push({ start: s, accounts: book.entries.slice(s, s + size).map((e) => e.tokenAccount) });
  return out;
}

/** Passes owed something, grouped for pay_passes transactions. */
export function payBatches(book: PassBook, size = PAY_BATCH): PassEntry[][] {
  const owed = book.entries.filter((e) => e.owed > e.paid);
  const out: PassEntry[][] = [];
  for (let i = 0; i < owed.length; i += size) out.push(owed.slice(i, i + size));
  return out;
}

/** The waiting pot: the holders' share not yet allocated to passes. */
export const passPot = (holdersFunded: bigint, book: Pick<PassBook, "allocated">) =>
  holdersFunded > book.allocated ? holdersFunded - book.allocated : 0n;
