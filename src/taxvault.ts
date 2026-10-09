/**
 * Client for the `tax_vault` program (docs/tax-vault-spec.md is the contract): constants,
 * PDAs, the Vault and PaidRecord decoders, instruction builders in the spec's account
 * order, the rewards-list Merkle tree, and a parser for the program's events.
 *
 * The vault's `auth` PDA is the token's withdraw-withheld authority: the program collects
 * the tax, burns, sells, adds liquidity and funds the creator itself. Holders are paid
 * against a published list of cumulative totals, which can only divide the XNT the program
 * set aside for them.
 *
 * v2 (see the spec's "# v2"): the creator reward is swapped on-chain from XNT to the network's
 * reward token (REWARD_MINT) before it goes into the lock NFT's vesting vault; vaults are
 * 552 bytes (a 480-byte v1 vault is brought up to date by `upgrade_vault`); the guardian
 * may cancel at most MAX_CANCELS_IN_ROW lists before one goes live.
 *
 * v3 (the spec's "# v3"): keeps working if the operator disappears. Vaults are 640 bytes and
 * record the last publish time and the list files' IPFS addresses (CIDs); the guardian may
 * appoint a new publisher after APPOINT_AFTER_SECS of silence, and after FALLBACK_AFTER_SECS
 * anyone may pay holders from the last list scaled up to everything funded (pay_fallback).
 *
 * Nothing here signs or sends.
 */
import crypto from "node:crypto";
import bs58 from "bs58";
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { XDEX_PROGRAM_IDS } from "./config.js";
import { MEMO_PROGRAM_ID, lockPda, rewardTokensPda, rewardVaultPda } from "./locker.js";
import { merkleTree, verifyProof } from "./holder-pass.js";
import { poolAddresses, poolAuthority, type Pool } from "./xdex.js";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);

// ---------- constants (mirror the Rust `pub const`s) ----------
/** The deployed tax_vault program (lp-locker/programs/tax_vault); the site reads factory.taxVault.programId. */
export const TAX_VAULT_PROGRAM_ID = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
export const LOCKER_PROGRAM_ID = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
export const MAX_IMPACT_BPS = 300n;
/**
 * A sale's price-impact cap for a token with `taxBps` tax: min(300, tax/2) bps, so a
 * sandwich around the vault's sale costs the attacker more in tax than it can take.
 */
export const sellImpactBps = (taxBps: number) => Math.min(Number(MAX_IMPACT_BPS), Math.floor(taxBps / 2));
/** A wallet holding 0 lamports must receive at least this (rent-exempt minimum of an empty account). */
export const RENT_EXEMPT_EMPTY = 890_880n;
export const OUT_TOLERANCE_BPS = 50n;
export const CRANK_REWARD_BPS = 100n;
export const CRANK_REWARD_CAP = 50_000_000n;
/** 600 s on a normal build; the program's `short-windows` feature (local tests) uses 5. */
export const LIST_DELAY_SECS = 600;
/** A `sell` whose expected output is under this fails with TooSmall. */
export const MIN_SELL_XNT = 2_000_000n;
/** `add_liquidity` needs at least this much XNT set aside. */
export const MIN_LP_XNT = 10_000_000n;
export const CREATOR_BPS = 1000;
export const MAX_BURN_BPS = 5000;
export const MAX_LP_BPS = 5000;
export const MAX_BURN_PLUS_LP_BPS = 5500;
/** v2: the reward swap (XNT -> REWARD_MINT) moves the reward pool's price at most this much... */
export const REWARD_MAX_IMPACT_BPS = 300;
/**
 * ...and at most half the reward pool's trade fee (`trade_fee_rate` in millionths / 200):
 * the pair has no transfer tax, so only the fee makes a sandwich unprofitable. About 15 bps
 * on testnet and 14 on mainnet: a large creator bucket takes several fund_creator calls.
 */
export const rewardImpactBps = (tradeFeeRate: bigint | number) => Math.min(REWARD_MAX_IMPACT_BPS, Math.floor(Number(tradeFeeRate) / 200));
/** v2: the guardian may cancel this many lists in a row; a list going live resets the count. */
export const MAX_CANCELS_IN_ROW = 2;
/** The Vault layout version `init_vault` and `upgrade_vault` write. */
export const VAULT_VERSION = 3;
/**
 * v3 windows, counted from the vault's last_publish_at: the guardian may appoint a new
 * publisher after APPOINT_AFTER_SECS, anyone may pay_fallback after FALLBACK_AFTER_SECS.
 * The program's `short-windows` feature (local tests only) uses 15 s and 30 s; set
 * TAX_VAULT_SHORT_WINDOWS=1 to match such a build.
 */
export const VAULT_WINDOWS = process.env.TAX_VAULT_SHORT_WINDOWS
  ? { appointAfterSecs: 15, fallbackAfterSecs: 30 }
  : { appointAfterSecs: 7 * 86_400, fallbackAfterSecs: 30 * 86_400 };
export type VaultWindows = typeof VAULT_WINDOWS;

/**
 * v2: the creator reward is always paid in the network's reward token (the program's
 * feature `testnet` picks the column), bought on its XNT pool. XNM and USDC.X are both
 * Token-2022 mints without a transfer fee.
 */
export const REWARD_TOKEN: Record<"mainnet" | "testnet", { mint: PublicKey; pool: PublicKey; symbol: string; decimals: number }> = {
  testnet: {
    mint: new PublicKey("AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ"), pool: new PublicKey("6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA"),
    symbol: "XNM", decimals: 9,
  },
  mainnet: {
    mint: new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"), pool: new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR"),
    symbol: "USDC", decimals: 6,
  },
};
export const REWARD_MINT = { testnet: REWARD_TOKEN.testnet.mint, mainnet: REWARD_TOKEN.mainnet.mint };
export const REWARD_POOL = { testnet: REWARD_TOKEN.testnet.pool, mainnet: REWARD_TOKEN.mainnet.pool };
/** Symbol and decimals of a creator-reward mint: the network's reward token or native XNT (v1 vaults); null otherwise. */
export function rewardTokenInfo(network: "mainnet" | "testnet", mint: PublicKey) {
  if (mint.equals(NATIVE_MINT)) return { mint, symbol: "XNT", decimals: 9 };
  const r = REWARD_TOKEN[network];
  return mint.equals(r.mint) ? { mint, symbol: r.symbol, decimals: r.decimals } : null;
}

export const xdexProgramFor = (network: "mainnet" | "testnet") => new PublicKey(XDEX_PROGRAM_IDS[network]);

/** Whether a burn/liquidity split is one the program accepts (holders keep at least 35%). */
export const validSplit = (burnBps: number, lpBps: number) =>
  Number.isInteger(burnBps) && Number.isInteger(lpBps) && burnBps >= 0 && lpBps >= 0
  && burnBps <= MAX_BURN_BPS && lpBps <= MAX_LP_BPS && burnBps + lpBps <= MAX_BURN_PLUS_LP_BPS;

// ---------- discriminators ----------
export const IX = {
  initVault: disc("global:init_vault"),
  collect: disc("global:collect"),
  sell: disc("global:sell"),
  addLiquidity: disc("global:add_liquidity"),
  fundCreator: disc("global:fund_creator"),
  publishList: disc("global:publish_list"),
  cancelList: disc("global:cancel_list"),
  pay: disc("global:pay"),
  upgradeVault: disc("global:upgrade_vault"),
  // v3
  setPublisher: disc("global:set_publisher"),
  appointPublisher: disc("global:appoint_publisher"),
  payFallback: disc("global:pay_fallback"),
  // payout token
  initVaultPayout: disc("global:init_vault_payout"),
  fundHolders: disc("global:fund_holders"),
  payToken: disc("global:pay_token"),
  payFallbackToken: disc("global:pay_fallback_token"),
};
export const VAULT_DISC = disc("account:Vault");
export const PAID_RECORD_DISC = disc("account:PaidRecord");
export const EVENT = {
  Collected: disc("event:Collected"),
  Sold: disc("event:Sold"),
  LiquidityAdded: disc("event:LiquidityAdded"),
  CreatorFunded: disc("event:CreatorFunded"),
  ListPublished: disc("event:ListPublished"),
  ListCancelled: disc("event:ListCancelled"),
  Paid: disc("event:Paid"),
  // v3
  PublisherChanged: disc("event:PublisherChanged"),
  FallbackPaid: disc("event:FallbackPaid"),
  // payout token
  HoldersFunded: disc("event:HoldersFunded"),
};
/** Anchor numbers custom errors from 6000 in declaration order. */
export const ERRORS = [
  "BadMint", "BadAuthority", "BadPool", "BadLock", "BadSplit", "NotPublisher", "NotGuardian", "StaleEpoch",
  "TotalDecreased", "OverFunded", "NoPendingList", "BadProof", "NothingToCollect", "NothingToPay",
  "TooSmall", "Insolvent", "MathOverflow", "WrongAccount", "OneSellPerSlot",
  // v2
  "WrongVersion", "TooManyCancels", "BadRewardMint",
  // v3
  "PublisherActive", "FallbackNotActive",
  // payout token
  "PaysInToken", "PaysInXnt", "BadPayoutMint", "BadPayoutPool",
] as const;
export const errorName = (code: number) => ERRORS[code - 6000] ?? null;
/** The program's error name in a simulation/transaction error ({"Custom":6012} etc.), or null. */
export function errorOf(message: string): string | null {
  const m = /"Custom":(\d+)|custom program error: 0x([0-9a-f]+)/i.exec(message);
  if (!m) return null;
  return errorName(m[1] ? Number(m[1]) : parseInt(m[2], 16));
}

// ---------- PDAs ----------
const pda = (programId: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const vaultPda = (programId: PublicKey, mint: PublicKey) => pda(programId, Buffer.from("vault"), mint.toBuffer());
/** The token's withdraw-withheld authority: a system-owned PDA that holds the vault's accounts and XNT. */
export const vaultAuthPda = (programId: PublicKey, mint: PublicKey) => pda(programId, Buffer.from("auth"), mint.toBuffer());
export const paidRecordPda = (programId: PublicKey, vault: PublicKey, wallet: PublicKey) =>
  pda(programId, Buffer.from("paid"), vault.toBuffer(), wallet.toBuffer());

/** The auth PDA's token accounts: the tax token (Token-2022), wrapped XNT and LP (SPL Token). */
export const authTokenAccount = (auth: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID);
export const authWxntAccount = (auth: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID);
export const authLpAccount = (auth: PublicKey, lpMint: PublicKey) => getAssociatedTokenAddressSync(lpMint, auth, true, TOKEN_PROGRAM_ID);

// ---------- accounts ----------
export interface Vault {
  address: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  creatorNft: PublicKey;
  rewardMint: PublicKey;
  rewardSwapPool: PublicKey;
  publisher: PublicKey;
  guardian: PublicKey;
  burnBps: number;
  lpBps: number;
  creatorBps: number;
  pendingTokens: bigint;
  lpTokens: bigint;
  sellLp: bigint;
  sellCreator: bigint;
  sellHolders: bigint;
  xntLp: bigint;
  xntCreator: bigint;
  holdersFunded: bigint;
  holdersPaid: bigint;
  listEpoch: bigint;
  listRoot: Buffer;
  listTotal: bigint;
  pendingEpoch: bigint;
  pendingRoot: Buffer;
  pendingTotal: bigint;
  pendingActiveAt: number;
  totalCollected: bigint;
  totalBurned: bigint;
  totalLpTokens: bigint;
  totalLpXnt: bigint;
  totalCreatorXnt: bigint;
  totalCrankRewards: bigint;
  createdAt: number;
  bump: number;
  authBump: number;
  /** Slot of the last sale (one sale per slot). */
  lastSellSlot: bigint;
  /** 1 for a 480-byte vault not upgraded yet (the three fields below read as 0), else the stored version. */
  version: number;
  /** Guardian cancels since the last list went live (v2). */
  cancelsInRow: number;
  /** Reward tokens ever deposited for the creator, base units (v2). */
  totalRewardOut: bigint;
  /** Slot of the last reward swap in fund_creator (one per slot, v2). */
  lastRewardSlot: bigint;
  /** Unix time of the last publish_list, or of creation / the v3 upgrade (v3; 0 before). */
  lastPublishAt: number;
  /** IPFS address of the active list file, [codec, sha256 digest] (33 bytes, all zero = none; v3). */
  listCid: Buffer;
  /** IPFS address of the pending list file (v3). */
  pendingCid: Buffer;
  /** Paid by pay_fallback, ever, in the holder pool's unit (v3). */
  fallbackPaid: bigint;
  /**
   * The payout token's XDEX pool against wXNT, fixed at creation (init_vault_payout);
   * PublicKey.default = holders are paid in XNT. With a payout token, holdersFunded /
   * holdersPaid / list totals / PaidRecord.paid are in its base units.
   */
  payoutPool: PublicKey;
  /** Holders' XNT not yet swapped into the payout token (payout-token vaults). */
  xntHolders: bigint;
}
/** Whether the vault pays holders in a payout token (not XNT). */
export const paysInToken = (v: Pick<Vault, "payoutPool">) => !v.payoutPool.equals(PublicKey.default);
const VAULT_KEYS = ["mint", "pool", "creatorNft", "rewardMint", "rewardSwapPool", "publisher", "guardian"] as const;
const VAULT_U64S_A = ["pendingTokens", "lpTokens", "sellLp", "sellCreator", "sellHolders", "xntLp", "xntCreator", "holdersFunded", "holdersPaid", "listEpoch"] as const;
const VAULT_TOTALS = ["totalCollected", "totalBurned", "totalLpTokens", "totalLpXnt", "totalCreatorXnt", "totalCrankRewards"] as const;
/** Discriminator + fields, packed (Anchor borsh): the v1 size (480), also the smallest vault. */
export const VAULT_LEN = 8 + 32 * 7 + 2 * 3 + 8 * 10 + 32 + 8 + 8 + 32 + 8 + 8 + 8 * 6 + 8 + 1 + 1 + 8;
/** v2 appends version (u8), cancels_in_row (u8), total_reward_out (u64), last_reward_slot (u64) and 54 reserved bytes: 552. */
export const VAULT_V2_LEN = VAULT_LEN + 1 + 1 + 8 + 8 + 54;
/** Offsets of the v2 fields. */
export const VAULT_V2_OFFSETS = { version: 480, cancelsInRow: 481, totalRewardOut: 482, lastRewardSlot: 490, reserved: 498 } as const;
/** v3 reuses v2's reserved bytes and grows to 640: last_publish_at, list_cid, pending_cid, fallback_paid, 60 reserved. */
export const VAULT_V3_LEN = 640;
export const VAULT_V3_OFFSETS = { lastPublishAt: 498, listCid: 506, pendingCid: 539, fallbackPaid: 572, reserved: 580 } as const;
/** Payout-token fields, in v3's reserved bytes (zero in older vaults: XNT payouts): pool, unswapped XNT, then 20 reserved. */
export const VAULT_PAYOUT_OFFSETS = { payoutPool: 580, xntHolders: 612, reserved: 620 } as const;
export const CID_LEN = 33;
export const PAID_RECORD_LEN = 8 + 32 + 32 + 8 + 1;

export function decodeVault(address: PublicKey, d: Buffer): Vault {
  if (d.length < VAULT_LEN || !d.subarray(0, 8).equals(VAULT_DISC)) throw new Error("Not a Vault account");
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const u16 = () => { const v = d.readUInt16LE(o); o += 2; return v; };
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const i64 = () => { const v = Number(d.readBigInt64LE(o)); o += 8; return v; };
  const bytes32 = () => { const b = Buffer.from(d.subarray(o, o + 32)); o += 32; return b; };
  const v: Record<string, unknown> = { address };
  for (const k of VAULT_KEYS) v[k] = key();
  v.burnBps = u16(); v.lpBps = u16(); v.creatorBps = u16();
  for (const k of VAULT_U64S_A) v[k] = u64();
  v.listRoot = bytes32(); v.listTotal = u64();
  v.pendingEpoch = u64(); v.pendingRoot = bytes32(); v.pendingTotal = u64(); v.pendingActiveAt = i64();
  for (const k of VAULT_TOTALS) v[k] = u64();
  v.createdAt = i64(); v.bump = d[o]; v.authBump = d[o + 1]; o += 2;
  v.lastSellSlot = u64();
  if (d.length >= VAULT_V2_LEN) {
    v.version = d[VAULT_V2_OFFSETS.version]; v.cancelsInRow = d[VAULT_V2_OFFSETS.cancelsInRow];
    v.totalRewardOut = d.readBigUInt64LE(VAULT_V2_OFFSETS.totalRewardOut);
    v.lastRewardSlot = d.readBigUInt64LE(VAULT_V2_OFFSETS.lastRewardSlot);
  } else {
    v.version = 1; v.cancelsInRow = 0; v.totalRewardOut = 0n; v.lastRewardSlot = 0n;
  }
  // v3 fields; an older (480/552-byte) vault reads them as zero until it's upgraded.
  const o3 = VAULT_V3_OFFSETS;
  const v3 = d.length >= VAULT_V3_LEN && (v.version as number) >= 3;
  v.lastPublishAt = v3 ? Number(d.readBigInt64LE(o3.lastPublishAt)) : 0;
  v.listCid = v3 ? Buffer.from(d.subarray(o3.listCid, o3.listCid + CID_LEN)) : Buffer.alloc(CID_LEN);
  v.pendingCid = v3 ? Buffer.from(d.subarray(o3.pendingCid, o3.pendingCid + CID_LEN)) : Buffer.alloc(CID_LEN);
  v.fallbackPaid = v3 ? d.readBigUInt64LE(o3.fallbackPaid) : 0n;
  const op = VAULT_PAYOUT_OFFSETS;
  v.payoutPool = v3 ? new PublicKey(d.subarray(op.payoutPool, op.payoutPool + 32)) : PublicKey.default;
  v.xntHolders = v3 ? d.readBigUInt64LE(op.xntHolders) : 0n;
  return v as unknown as Vault;
}

/** The inverse of decodeVault (tests and local fixtures): 480 bytes for version 1, 552 for 2, else 640. */
export function encodeVault(v: Omit<Vault, "address">): Buffer {
  const d = Buffer.alloc(v.version >= 3 ? VAULT_V3_LEN : v.version >= 2 ? VAULT_V2_LEN : VAULT_LEN);
  VAULT_DISC.copy(d, 0);
  let o = 8;
  const key = (k: PublicKey) => { k.toBuffer().copy(d, o); o += 32; };
  const u16 = (x: number) => { d.writeUInt16LE(x, o); o += 2; };
  const u64 = (x: bigint) => { d.writeBigUInt64LE(x, o); o += 8; };
  const i64 = (x: number) => { d.writeBigInt64LE(BigInt(x), o); o += 8; };
  const bytes32 = (b: Buffer) => { b.copy(d, o, 0, 32); o += 32; };
  for (const k of VAULT_KEYS) key(v[k]);
  u16(v.burnBps); u16(v.lpBps); u16(v.creatorBps);
  for (const k of VAULT_U64S_A) u64(v[k]);
  bytes32(v.listRoot); u64(v.listTotal);
  u64(v.pendingEpoch); bytes32(v.pendingRoot); u64(v.pendingTotal); i64(v.pendingActiveAt);
  for (const k of VAULT_TOTALS) u64(v[k]);
  i64(v.createdAt); d[o] = v.bump; d[o + 1] = v.authBump; o += 2;
  u64(v.lastSellSlot);
  if (v.version >= 2) {
    d[VAULT_V2_OFFSETS.version] = v.version; d[VAULT_V2_OFFSETS.cancelsInRow] = v.cancelsInRow;
    d.writeBigUInt64LE(v.totalRewardOut, VAULT_V2_OFFSETS.totalRewardOut);
    d.writeBigUInt64LE(v.lastRewardSlot, VAULT_V2_OFFSETS.lastRewardSlot);
  }
  if (v.version >= 3) {
    const o3 = VAULT_V3_OFFSETS;
    d.writeBigInt64LE(BigInt(v.lastPublishAt), o3.lastPublishAt);
    v.listCid.copy(d, o3.listCid, 0, CID_LEN); v.pendingCid.copy(d, o3.pendingCid, 0, CID_LEN);
    d.writeBigUInt64LE(v.fallbackPaid, o3.fallbackPaid);
    (v.payoutPool ?? PublicKey.default).toBuffer().copy(d, VAULT_PAYOUT_OFFSETS.payoutPool);
    d.writeBigUInt64LE(v.xntHolders ?? 0n, VAULT_PAYOUT_OFFSETS.xntHolders);
  }
  return d;
}

export interface PaidRecord { address: PublicKey; vault: PublicKey; wallet: PublicKey; paid: bigint; bump: number }
export function decodePaidRecord(address: PublicKey, d: Buffer): PaidRecord {
  if (d.length < PAID_RECORD_LEN || !d.subarray(0, 8).equals(PAID_RECORD_DISC)) throw new Error("Not a PaidRecord account");
  return { address, vault: new PublicKey(d.subarray(8, 40)), wallet: new PublicKey(d.subarray(40, 72)), paid: d.readBigUInt64LE(72), bump: d[80] };
}
export function encodePaidRecord(r: Omit<PaidRecord, "address">): Buffer {
  const d = Buffer.alloc(PAID_RECORD_LEN);
  PAID_RECORD_DISC.copy(d, 0); r.vault.toBuffer().copy(d, 8); r.wallet.toBuffer().copy(d, 40); d.writeBigUInt64LE(r.paid, 72); d[80] = r.bump;
  return d;
}

/** XNT the holders are owed but not yet paid (the program keeps at least this in auth). */
export const holdersOwed = (v: Pick<Vault, "holdersFunded" | "holdersPaid">) => v.holdersFunded - v.holdersPaid;
/** Lists the guardian may still cancel before one goes live; null for a v1 vault (no limit there). */
export const cancelsLeft = (v: Pick<Vault, "version" | "cancelsInRow">) =>
  (v.version >= 2 ? Math.max(0, MAX_CANCELS_IN_ROW - v.cancelsInRow) : null);
/** Tokens waiting to be sold. */
export const sellBuckets = (v: Pick<Vault, "sellLp" | "sellCreator" | "sellHolders">) => v.sellLp + v.sellCreator + v.sellHolders;

/**
 * The list `pay` verifies against at `nowSec`: a pending list whose time has come becomes
 * the active one inside `pay`, so proofs must be built for it. Null when no list exists.
 */
export function effectiveList(v: Vault, nowSec: number) {
  if (v.pendingEpoch > 0n && nowSec >= v.pendingActiveAt) return { epoch: v.pendingEpoch, root: v.pendingRoot, total: v.pendingTotal, cid: v.pendingCid, pending: true };
  if (v.listEpoch > 0n) return { epoch: v.listEpoch, root: v.listRoot, total: v.listTotal, cid: v.listCid, pending: false };
  return null;
}

// ---------- v3: publisher silence, appointing, fallback ----------
/** When the guardian may appoint a new publisher (unix seconds); null before v3. */
export const appointAllowedAt = (v: Pick<Vault, "version" | "lastPublishAt">, w: VaultWindows = VAULT_WINDOWS) =>
  (v.version >= 3 ? v.lastPublishAt + w.appointAfterSecs : null);
/** When anyone may pay holders from the last list with pay_fallback (unix seconds); null before v3. */
export const fallbackAt = (v: Pick<Vault, "version" | "lastPublishAt">, w: VaultWindows = VAULT_WINDOWS) =>
  (v.version >= 3 ? v.lastPublishAt + w.fallbackAfterSecs : null);
/**
 * Whether pay_fallback works at `nowSec`: a v3 vault, a list active (a due pending list
 * counts: the program activates it first), nothing else pending, and no publish for
 * FALLBACK_AFTER_SECS.
 */
export function fallbackActive(v: Vault, nowSec: number, w: VaultWindows = VAULT_WINDOWS) {
  if (v.version < 3) return false;
  const eff = effectiveList(v, nowSec);
  const stillPending = v.pendingEpoch > 0n && !eff?.pending;
  return !!eff && !stillPending && nowSec >= v.lastPublishAt + w.fallbackAfterSecs;
}
/**
 * What pay_fallback lets a wallet have been paid in all: its list share scaled up to
 * everything funded, floor(cumulative * holders_funded / list_total) (the program's u128
 * maths). The amount paid is this minus its PaidRecord.
 */
export const fallbackEntitled = (cumulative: bigint, holdersFunded: bigint, listTotal: bigint) =>
  (listTotal === 0n ? 0n : (cumulative * holdersFunded) / listTotal);

// ---------- list files on IPFS: CIDs <-> the program's [codec, sha256 digest] ----------
/** Multicodecs a list file's CID may use (the CID is stored, never interpreted, on-chain). */
export const CID_CODEC = { raw: 0x55, dagPb: 0x70 } as const;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648 base32, lowercase, no padding (multibase "b"). */
export function base32Encode(b: Uint8Array) {
  let out = "", bits = 0, acc = 0;
  for (const x of b) {
    acc = (acc << 8) | x; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string) {
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of s.toLowerCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`Invalid base32 character "${ch}"`);
    acc = (acc << 5) | i; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 0xff); bits -= 8; }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}
/**
 * A CID string as the program stores it: 33 bytes, [codec, sha256 digest]. Takes a CIDv1
 * in base32 ("b…", sha2-256, raw or dag-pb) or a CIDv0 ("Qm…", dag-pb).
 */
export function cidToBytes(cid: string): Buffer {
  let codec: number, mh: Buffer;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    codec = CID_CODEC.dagPb; mh = Buffer.from(bs58.decode(cid));
  } else if (/^b[a-z2-7]+$/i.test(cid)) {
    const d = base32Decode(cid.slice(1));
    if (d[0] !== 0x01) throw new Error("Only CIDv1 (or v0) is supported");
    codec = d[1]; mh = d.subarray(2);
  } else throw new Error(`Not a CIDv1 base32 or CIDv0 string: ${cid}`);
  if (codec !== CID_CODEC.raw && codec !== CID_CODEC.dagPb) throw new Error(`Unsupported CID codec 0x${codec.toString(16)}`);
  if (mh.length !== 34 || mh[0] !== 0x12 || mh[1] !== 0x20) throw new Error("The CID's hash must be sha2-256");
  return Buffer.concat([Buffer.from([codec]), mh.subarray(2)]);
}
/** The CIDv1 string (base32 "b…") of a stored [codec, digest]; null for all zeros (no file). */
export function cidFromBytes(b: Uint8Array): string | null {
  if (b.length !== CID_LEN) throw new Error("A stored CID is 33 bytes");
  if (b.every((x) => x === 0)) return null;
  if (b[0] !== CID_CODEC.raw && b[0] !== CID_CODEC.dagPb) throw new Error(`Unsupported CID codec 0x${b[0].toString(16)}`);
  return "b" + base32Encode(Buffer.concat([Buffer.from([0x01, b[0], 0x12, 0x20]), Buffer.from(b.subarray(1))]));
}
/** The CIDv1 of `bytes` stored as one raw block (what IPFS gives a small file with raw leaves). */
export const rawCid = (bytes: Uint8Array) => cidFromBytes(Buffer.concat([Buffer.from([CID_CODEC.raw]), crypto.createHash("sha256").update(bytes).digest()]))!;

// ---------- XDEX accounts the vault's sell and add_liquidity need ----------
export interface VaultPoolAccounts {
  xdexProgram: PublicKey;
  pool: PublicKey;
  ammConfig: PublicKey;
  tokenVault: PublicKey;
  wxntVault: PublicKey;
  observation: PublicKey;
  lpMint: PublicKey;
}
/** From a decoded pool (src/xdex.ts decodePool): the vaults on the token's side and the wXNT side. */
export function poolAccountsFrom(xdexProgram: PublicKey, pool: Pool, mint: PublicKey): VaultPoolAccounts {
  const side = pool.mints.findIndex((m) => m.equals(mint));
  if (side < 0 || !pool.mints[1 - side].equals(NATIVE_MINT)) throw new Error("Pool is not a TOKEN/XNT pool for this mint");
  return {
    xdexProgram, pool: pool.address, ammConfig: pool.ammConfig, tokenVault: pool.vaults[side], wxntVault: pool.vaults[1 - side],
    observation: pool.observation, lpMint: pool.lpMint,
  };
}
/** Derived without reading the chain (the pool XDEX creates for mint + wXNT under ammConfig). */
export function derivePoolAccounts(xdexProgram: PublicKey, ammConfig: PublicKey, mint: PublicKey): VaultPoolAccounts {
  const a = poolAddresses(xdexProgram, ammConfig, mint, NATIVE_MINT);
  const tokenIs0 = a.mint0.equals(mint);
  return {
    xdexProgram, pool: a.pool, ammConfig, tokenVault: tokenIs0 ? a.vault0 : a.vault1, wxntVault: tokenIs0 ? a.vault1 : a.vault0,
    observation: a.observation, lpMint: a.lpMint,
  };
}

/** v2: the reward pool (XNT/REWARD_MINT) accounts `fund_creator` swaps through. */
export interface RewardPoolAccounts {
  xdexProgram: PublicKey;
  pool: PublicKey;
  ammConfig: PublicKey;
  /** The pool's vault of the reward token. */
  rewardVault: PublicKey;
  wxntVault: PublicKey;
  observation: PublicKey;
  rewardMint: PublicKey;
  /** The reward mint's token program (Token-2022 for XNM and USDC.X). */
  rewardTokenProgram: PublicKey;
}
/** From a decoded reward pool (src/xdex.ts decodePool). */
export function rewardPoolAccountsFrom(xdexProgram: PublicKey, pool: Pool, rewardMint: PublicKey): RewardPoolAccounts {
  const side = pool.mints.findIndex((m) => m.equals(rewardMint));
  if (side < 0 || !pool.mints[1 - side].equals(NATIVE_MINT)) throw new Error("Pool is not an XNT pool for the reward token");
  return {
    xdexProgram, pool: pool.address, ammConfig: pool.ammConfig, rewardVault: pool.vaults[side], wxntVault: pool.vaults[1 - side],
    observation: pool.observation, rewardMint, rewardTokenProgram: pool.programs[side],
  };
}
/** Derived without reading the chain (the pool XDEX creates for rewardMint + wXNT under ammConfig). */
export function deriveRewardPoolAccounts(xdexProgram: PublicKey, ammConfig: PublicKey, rewardMint: PublicKey, rewardTokenProgram = TOKEN_2022_PROGRAM_ID): RewardPoolAccounts {
  const a = poolAddresses(xdexProgram, ammConfig, rewardMint, NATIVE_MINT);
  const rewardIs0 = a.mint0.equals(rewardMint);
  return {
    xdexProgram, pool: a.pool, ammConfig, rewardVault: rewardIs0 ? a.vault0 : a.vault1, wxntVault: rewardIs0 ? a.vault1 : a.vault0,
    observation: a.observation, rewardMint, rewardTokenProgram,
  };
}
/** The auth PDA's account of the reward token (the swap's output, deposited from there). */
export const authRewardAccount = (auth: PublicKey, rewardMint: PublicKey, rewardTokenProgram = TOKEN_2022_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(rewardMint, auth, true, rewardTokenProgram);

// ---------- instructions (account order exactly as the spec) ----------
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

/**
 * Create a token's vault. The program accepts it only when `payer` is the mint's metadata
 * update authority (the creator), or when an earlier instruction of the same transaction
 * hands the withdraw authority to auth (migration). The payer also tops auth up to its
 * rent-exempt minimum.
 */
export function initVaultIx(programId: PublicKey, a: {
  payer: PublicKey; mint: PublicKey; pool: PublicKey; creatorNft: PublicKey; burnBps: number; lpBps: number; publisher: PublicKey; guardian: PublicKey;
}) {
  const data = Buffer.alloc(8 + 2 + 2 + 32 + 32);
  IX.initVault.copy(data, 0);
  data.writeUInt16LE(a.burnBps, 8); data.writeUInt16LE(a.lpBps, 10);
  a.publisher.toBuffer().copy(data, 12); a.guardian.toBuffer().copy(data, 44);
  return new TransactionInstruction({
    programId, data,
    keys: [
      m(a.payer, true, true), m(a.mint, false, false), m(vaultPda(programId, a.mint), false, true), m(vaultAuthPda(programId, a.mint), false, true),
      m(a.pool, false, false), m(lockPda(LOCKER_PROGRAM_ID, a.creatorNft), false, false), m(a.creatorNft, false, false),
      m(SystemProgram.programId, false, false), m(SYSVAR_INSTRUCTIONS_PUBKEY, false, false),
    ],
  });
}

/** Harvest `harvest` (token accounts holding withheld tax) into the mint, withdraw, split and burn. */
export function collectIx(programId: PublicKey, caller: PublicKey, mint: PublicKey, harvest: PublicKey[] = []) {
  const auth = vaultAuthPda(programId, mint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.collect),
    keys: [
      m(caller, true, true), m(vaultPda(programId, mint), false, true), m(auth, false, true), m(mint, false, true),
      m(authTokenAccount(auth, mint), false, true), m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      m(SystemProgram.programId, false, false),
      ...harvest.map((h) => m(h, false, true)),
    ],
  });
}

export function sellIx(programId: PublicKey, caller: PublicKey, mint: PublicKey, p: VaultPoolAccounts, maxTokens: bigint) {
  const auth = vaultAuthPda(programId, mint);
  const data = Buffer.alloc(16);
  IX.sell.copy(data, 0); data.writeBigUInt64LE(maxTokens, 8);
  return new TransactionInstruction({
    programId, data,
    keys: [
      m(caller, true, true), m(vaultPda(programId, mint), false, true), m(auth, false, true), m(mint, false, false),
      m(authTokenAccount(auth, mint), false, true), m(authWxntAccount(auth), false, true),
      m(p.pool, false, true), m(p.ammConfig, false, false), m(poolAuthority(p.xdexProgram), false, false),
      m(p.tokenVault, false, true), m(p.wxntVault, false, true), m(p.observation, false, true),
      m(p.xdexProgram, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
      m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false), m(NATIVE_MINT, false, false),
    ],
  });
}

export function addLiquidityIx(programId: PublicKey, caller: PublicKey, mint: PublicKey, p: VaultPoolAccounts) {
  const auth = vaultAuthPda(programId, mint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.addLiquidity),
    keys: [
      m(caller, true, true), m(vaultPda(programId, mint), false, true), m(auth, false, true), m(mint, false, false),
      m(authTokenAccount(auth, mint), false, true), m(authWxntAccount(auth), false, true), m(authLpAccount(auth, p.lpMint), false, true),
      m(p.pool, false, true), m(poolAuthority(p.xdexProgram), false, false), m(p.tokenVault, false, true), m(p.wxntVault, false, true),
      m(p.lpMint, false, true), m(p.xdexProgram, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
      m(MEMO_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
      m(NATIVE_MINT, false, false),
    ],
  });
}

/**
 * v2: swap up to `xnt_creator` for the reward token on the reward pool (impact capped
 * on-chain at rewardImpactBps of the pool's fee; one swap per slot) and deposit auth_reward's
 * whole balance into the lock NFT's 7-day vesting vault on lp_locker. `r` must be the
 * vault's reward_swap_pool for its reward_mint. Needs a compute limit of at least 250k.
 */
/**
 * fund_creator. A payout-token vault also passes its payout pool (`payoutPool`, the vault's
 * payout_pool): the program keeps the holders' tokens when the payout token is the reward token.
 */
export function fundCreatorIx(programId: PublicKey, caller: PublicKey, mint: PublicKey, creatorNft: PublicKey, r: RewardPoolAccounts, payoutPool?: PublicKey) {
  const auth = vaultAuthPda(programId, mint);
  const rewardVault = rewardVaultPda(LOCKER_PROGRAM_ID, creatorNft, r.rewardMint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.fundCreator),
    keys: [
      m(caller, true, true), m(vaultPda(programId, mint), false, true), m(auth, false, true), m(authWxntAccount(auth), false, true),
      m(creatorNft, false, false), m(r.rewardMint, false, false), m(rewardVault, false, true),
      m(rewardTokensPda(LOCKER_PROGRAM_ID, rewardVault), false, true), m(LOCKER_PROGRAM_ID, false, false),
      m(TOKEN_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
      // lp_locker's init_reward_vault (first deposit) needs the lock and Token-2022.
      m(lockPda(LOCKER_PROGRAM_ID, creatorNft), false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
      // v2: the XNT -> reward token swap.
      m(authRewardAccount(auth, r.rewardMint, r.rewardTokenProgram), false, true), m(r.pool, false, true), m(r.ammConfig, false, false),
      m(poolAuthority(r.xdexProgram), false, false), m(r.rewardVault, false, true), m(r.wxntVault, false, true), m(r.observation, false, true),
      m(r.xdexProgram, false, false), m(NATIVE_MINT, false, false), m(r.rewardTokenProgram, false, false),
      ...(payoutPool ? [m(payoutPool, false, false)] : []),
    ],
  });
}

/** A payout token's XDEX pool against wXNT, with the accounts its swap needs. */
export interface PayoutPoolAccounts {
  xdexProgram: PublicKey; pool: PublicKey; ammConfig: PublicKey; payoutMint: PublicKey; payoutTokenProgram: PublicKey;
  payoutVault: PublicKey; wxntVault: PublicKey; observation: PublicKey;
}
/** The payout pool's accounts from its decoded state (the pool must pair the payout mint with wXNT). */
export function payoutPoolAccountsFrom(xdexProgram: PublicKey, pool: Pool): PayoutPoolAccounts {
  if (!pool.mints[0].equals(NATIVE_MINT) && !pool.mints[1].equals(NATIVE_MINT)) throw new Error("The payout pool must be against XNT (wXNT)");
  const wxntSide: 0 | 1 = pool.mints[0].equals(NATIVE_MINT) ? 0 : 1;
  const side: 0 | 1 = wxntSide === 0 ? 1 : 0;
  return {
    xdexProgram, pool: pool.address, ammConfig: pool.ammConfig, payoutMint: pool.mints[side], payoutTokenProgram: pool.programs[side],
    payoutVault: pool.vaults[side], wxntVault: pool.vaults[wxntSide], observation: pool.observation,
  };
}
/** auth's payout-token account (kept open; holds what holders are owed). */
export const authPayoutAccount = (auth: PublicKey, p: Pick<PayoutPoolAccounts, "payoutMint" | "payoutTokenProgram">) =>
  getAssociatedTokenAddressSync(p.payoutMint, auth, true, p.payoutTokenProgram);

/** init_vault for a vault that pays holders in the payout token of `payout` (fixed for good). */
export function initVaultPayoutIx(programId: PublicKey, a: Parameters<typeof initVaultIx>[1] & { payout: Pick<PayoutPoolAccounts, "pool" | "payoutMint" | "payoutTokenProgram"> }) {
  const base = initVaultIx(programId, a);
  base.data.set(IX.initVaultPayout, 0);
  base.keys.push(m(a.payout.payoutMint, false, false), m(a.payout.pool, false, false), m(a.payout.payoutTokenProgram, false, false));
  return base;
}

/**
 * Payout-token vaults: swap up to `xnt_holders` into the payout token (impact capped like the
 * reward swap; shares its one-swap-per-slot rule) into auth's payout account. Needs ~250k CU.
 */
export function fundHoldersIx(programId: PublicKey, caller: PublicKey, mint: PublicKey, p: PayoutPoolAccounts) {
  const auth = vaultAuthPda(programId, mint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.fundHolders),
    keys: [
      m(caller, true, true), m(vaultPda(programId, mint), false, true), m(auth, false, true), m(authWxntAccount(auth), false, true),
      m(p.payoutMint, false, false), m(authPayoutAccount(auth, p), false, true), m(p.pool, false, true), m(p.ammConfig, false, false),
      m(poolAuthority(p.xdexProgram), false, false), m(p.payoutVault, false, true), m(p.wxntVault, false, true), m(p.observation, false, true),
      m(p.xdexProgram, false, false), m(NATIVE_MINT, false, false), m(TOKEN_PROGRAM_ID, false, false), m(p.payoutTokenProgram, false, false),
      m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
    ],
  });
}

function payTokenLikeIx(tag: Buffer, programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[],
  p: Pick<PayoutPoolAccounts, "pool" | "payoutMint" | "payoutTokenProgram">) {
  const vault = vaultPda(programId, mint), auth = vaultAuthPda(programId, mint);
  const data = Buffer.alloc(8 + 8 + 4 + 32 * proof.length);
  tag.copy(data, 0); data.writeBigUInt64LE(cumulative, 8); data.writeUInt32LE(proof.length, 16);
  proof.forEach((x, i) => x.copy(data, 20 + 32 * i));
  return new TransactionInstruction({
    programId, data,
    keys: [
      m(payer, true, true), m(vault, false, true), m(auth, false, true), m(wallet, false, false), m(paidRecordPda(programId, vault, wallet), false, true),
      m(p.pool, false, false), m(p.payoutMint, false, false), m(authPayoutAccount(auth, p), false, true),
      m(getAssociatedTokenAddressSync(p.payoutMint, wallet, true, p.payoutTokenProgram), false, true),
      m(p.payoutTokenProgram, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
    ],
  });
}
/** pay for a payout-token vault: `wallet` gets the token (its account is opened if needed, `payer` paying the rent). */
export const payTokenIx = (programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[], p: Pick<PayoutPoolAccounts, "pool" | "payoutMint" | "payoutTokenProgram">) =>
  payTokenLikeIx(IX.payToken, programId, payer, mint, wallet, cumulative, proof, p);
/** pay_fallback for a payout-token vault. */
export const payFallbackTokenIx = (programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[], p: Pick<PayoutPoolAccounts, "pool" | "payoutMint" | "payoutTokenProgram">) =>
  payTokenLikeIx(IX.payFallbackToken, programId, payer, mint, wallet, cumulative, proof, p);

/** Bring a 480-byte v1 or 552-byte v2 vault up to the 640-byte v3 layout (anyone; `payer` pays the extra rent). */
export function upgradeVaultIx(programId: PublicKey, payer: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.upgradeVault),
    keys: [m(payer, true, true), m(vaultPda(programId, mint), false, true), m(SystemProgram.programId, false, false)],
  });
}

/**
 * v3: publish a list (pending for LIST_DELAY_SECS) with its file's IPFS address `cid` (33
 * bytes from cidToBytes, or all zero for none). Restarts the appoint / fallback clocks.
 */
export function publishListIx(programId: PublicKey, publisher: PublicKey, mint: PublicKey, root: Buffer, epoch: bigint, total: bigint, cid: Buffer) {
  if (root.length !== 32) throw new Error("root must be 32 bytes");
  if (cid.length !== CID_LEN) throw new Error("cid must be 33 bytes");
  const data = Buffer.alloc(8 + 32 + 8 + 8 + CID_LEN);
  IX.publishList.copy(data, 0); root.copy(data, 8); data.writeBigUInt64LE(epoch, 40); data.writeBigUInt64LE(total, 48); cid.copy(data, 56);
  return new TransactionInstruction({ programId, data, keys: [m(publisher, true, false), m(vaultPda(programId, mint), false, true)] });
}

/** v3: the publisher hands its role to `newPublisher` (immediate). */
export function setPublisherIx(programId: PublicKey, publisher: PublicKey, mint: PublicKey, newPublisher: PublicKey) {
  const data = Buffer.concat([IX.setPublisher, newPublisher.toBuffer()]);
  return new TransactionInstruction({ programId, data, keys: [m(publisher, true, false), m(vaultPda(programId, mint), false, true)] });
}

/** v3: the guardian appoints a new publisher; the program refuses (PublisherActive) until appointAllowedAt. */
export function appointPublisherIx(programId: PublicKey, guardian: PublicKey, mint: PublicKey, newPublisher: PublicKey) {
  const data = Buffer.concat([IX.appointPublisher, newPublisher.toBuffer()]);
  return new TransactionInstruction({ programId, data, keys: [m(guardian, true, false), m(vaultPda(programId, mint), false, true)] });
}

export function cancelListIx(programId: PublicKey, guardian: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.cancelList), keys: [m(guardian, true, false), m(vaultPda(programId, mint), false, true)],
  });
}

/** Pay `wallet` up to its `cumulative` total (proved against the list); `payer` creates its PaidRecord if needed. */
export function payIx(programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[]) {
  return payLikeIx(IX.pay, programId, payer, mint, wallet, cumulative, proof);
}

/**
 * v3: in fallback, pay `wallet` up to fallbackEntitled(cumulative, ...) of its entry in the
 * active list. Same data and accounts as `pay`; anyone may send it.
 */
export function payFallbackIx(programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[]) {
  return payLikeIx(IX.payFallback, programId, payer, mint, wallet, cumulative, proof);
}

function payLikeIx(tag: Buffer, programId: PublicKey, payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[]) {
  const vault = vaultPda(programId, mint);
  const data = Buffer.alloc(8 + 8 + 4 + 32 * proof.length);
  tag.copy(data, 0); data.writeBigUInt64LE(cumulative, 8); data.writeUInt32LE(proof.length, 16);
  proof.forEach((p, i) => p.copy(data, 20 + 32 * i));
  return new TransactionInstruction({
    programId, data,
    keys: [
      m(payer, true, true), m(vault, false, true), m(vaultAuthPda(programId, mint), false, true), m(wallet, false, true),
      m(paidRecordPda(programId, vault, wallet), false, true), m(SystemProgram.programId, false, false),
    ],
  });
}

// ---------- rewards list (Merkle tree) ----------
const sha = (...parts: Buffer[]) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
export function vaultLeaf(vault: PublicKey, wallet: PublicKey, cumulative: bigint) {
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(cumulative);
  return sha(Buffer.from("99tax-vault"), vault.toBuffer(), wallet.toBuffer(), amt);
}
/** Root and proofs for every (wallet, cumulative) entry of a vault's list; empty gives an all-zero root. */
export function buildVaultTree(vault: PublicKey, entries: Record<string, bigint | string>) {
  return merkleTree(Object.entries(entries).map(([w, cum]) => ({ key: w, leaf: vaultLeaf(vault, new PublicKey(w), BigInt(cum)) })));
}
export const verifyVaultProof = (proof: Buffer[], root: Buffer, vault: PublicKey, wallet: PublicKey, cumulative: bigint) =>
  verifyProof(proof, root, vaultLeaf(vault, wallet, cumulative));

// ---------- events ----------
export type VaultEvent =
  | { name: "Collected"; vault: string; got: bigint; burned: bigint }
  | { name: "Sold"; vault: string; tokensIn: bigint; xntOut: bigint; toLp: bigint; toCreator: bigint; toHolders: bigint; crankReward: bigint }
  | { name: "LiquidityAdded"; vault: string; tokens: bigint; xnt: bigint; lpBurned: bigint }
  /** v2 `{ vault, xnt_in, reward_out, reward_mint }`; a v1 event `{ vault, amount }` reads as XNT in = out, reward mint native XNT. */
  | { name: "CreatorFunded"; vault: string; xntIn: bigint; rewardOut: bigint; rewardMint: string }
  | { name: "ListPublished"; vault: string; epoch: bigint; root: string; total: bigint; activeAt: number }
  | { name: "ListCancelled"; vault: string; epoch: bigint }
  | { name: "Paid"; vault: string; wallet: string; amount: bigint; cumulative: bigint }
  | { name: "PublisherChanged"; vault: string; old: string; new: string; byGuardian: boolean }
  | { name: "FallbackPaid"; vault: string; wallet: string; amount: bigint; entitled: bigint }
  | { name: "HoldersFunded"; vault: string; xntIn: bigint; payoutOut: bigint; payoutMint: string };

/** Decode one event's bytes (discriminator first); null for anything else. */
export function decodeEvent(d: Buffer): VaultEvent | null {
  if (d.length < 8) return null;
  const tag = d.subarray(0, 8);
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const i64 = () => { const v = Number(d.readBigInt64LE(o)); o += 8; return v; };
  try {
    if (tag.equals(EVENT.Collected)) return { name: "Collected", vault: key(), got: u64(), burned: u64() };
    if (tag.equals(EVENT.Sold)) {
      return { name: "Sold", vault: key(), tokensIn: u64(), xntOut: u64(), toLp: u64(), toCreator: u64(), toHolders: u64(), crankReward: u64() };
    }
    if (tag.equals(EVENT.LiquidityAdded)) return { name: "LiquidityAdded", vault: key(), tokens: u64(), xnt: u64(), lpBurned: u64() };
    if (tag.equals(EVENT.CreatorFunded)) {
      const vault = key();
      if (d.length < 8 + 32 + 8 + 8 + 32) { const amount = u64(); return { name: "CreatorFunded", vault, xntIn: amount, rewardOut: amount, rewardMint: NATIVE_MINT.toBase58() }; }
      return { name: "CreatorFunded", vault, xntIn: u64(), rewardOut: u64(), rewardMint: key() };
    }
    if (tag.equals(EVENT.ListPublished)) {
      const vault = key(), epoch = u64();
      if (d.length < o + 32) return null;
      const root = d.subarray(o, o + 32).toString("hex"); o += 32;
      return { name: "ListPublished", vault, epoch, root, total: u64(), activeAt: i64() };
    }
    if (tag.equals(EVENT.ListCancelled)) return { name: "ListCancelled", vault: key(), epoch: u64() };
    if (tag.equals(EVENT.Paid)) return { name: "Paid", vault: key(), wallet: key(), amount: u64(), cumulative: u64() };
    if (tag.equals(EVENT.PublisherChanged)) {
      const vault = key(), old = key(), nu = key();
      if (o >= d.length) return null;
      return { name: "PublisherChanged", vault, old, new: nu, byGuardian: d[o] === 1 };
    }
    if (tag.equals(EVENT.FallbackPaid)) return { name: "FallbackPaid", vault: key(), wallet: key(), amount: u64(), entitled: u64() };
    if (tag.equals(EVENT.HoldersFunded)) return { name: "HoldersFunded", vault: key(), xntIn: u64(), payoutOut: u64(), payoutMint: key() };
  } catch { /* truncated: not ours */ }
  return null;
}

/**
 * Every vault event in a transaction's logs ("Program data: <base64>" lines from emit!).
 * With `programId`, only lines the tax_vault program itself wrote count (another program in
 * the same transaction could log look-alike bytes), e.g. for transactions the site didn't build.
 */
export function parseEvents(logs: readonly string[], programId?: PublicKey): VaultEvent[] {
  const out: VaultEvent[] = [];
  const stack: string[] = [];
  const id = programId?.toBase58();
  for (const l of logs) {
    const call = /^Program (\w+) invoke \[\d+\]$/.exec(l);
    if (call) { stack.push(call[1]); continue; }
    if (/^Program \w+ (success|failed)/.test(l)) { stack.pop(); continue; }
    const mm = /^Program data: (.+)$/.exec(l);
    if (!mm) continue;
    if (id && stack.at(-1) !== id) continue;
    const e = decodeEvent(Buffer.from(mm[1], "base64"));
    if (e) out.push(e);
  }
  return out;
}

/** The vault as plain JSON (amounts as strings) for the site. */
export function vaultJson(v: Vault) {
  const s = (x: bigint) => x.toString();
  return {
    address: v.address.toBase58(), mint: v.mint.toBase58(), pool: v.pool.toBase58(), creatorNft: v.creatorNft.toBase58(),
    rewardMint: v.rewardMint.toBase58(), rewardSwapPool: v.rewardSwapPool.toBase58(), publisher: v.publisher.toBase58(), guardian: v.guardian.toBase58(),
    version: v.version, cancelsInRow: v.cancelsInRow, cancelsLeft: cancelsLeft(v),
    burnBps: v.burnBps, lpBps: v.lpBps, creatorBps: v.creatorBps,
    buckets: {
      lpTokens: s(v.lpTokens), sellLp: s(v.sellLp), sellCreator: s(v.sellCreator), sellHolders: s(v.sellHolders),
      xntLp: s(v.xntLp), xntCreator: s(v.xntCreator),
    },
    holdersFunded: s(v.holdersFunded), holdersPaid: s(v.holdersPaid), holdersOwed: s(holdersOwed(v)),
    lastSellSlot: s(v.lastSellSlot), lastRewardSlot: s(v.lastRewardSlot),
    list: v.listEpoch > 0n ? { epoch: s(v.listEpoch), root: v.listRoot.toString("hex"), total: s(v.listTotal) } : null,
    pending: v.pendingEpoch > 0n ? { epoch: s(v.pendingEpoch), root: v.pendingRoot.toString("hex"), total: s(v.pendingTotal), activeAt: v.pendingActiveAt } : null,
    totals: {
      collected: s(v.totalCollected), burned: s(v.totalBurned), lpTokens: s(v.totalLpTokens), lpXnt: s(v.totalLpXnt),
      creatorXnt: s(v.totalCreatorXnt), crankRewards: s(v.totalCrankRewards), rewardOut: s(v.totalRewardOut),
    },
    createdAt: v.createdAt,
    // v3: who publishes, when the publisher went silent, and the list files on IPFS.
    lastPublishAt: v.version >= 3 ? v.lastPublishAt : null,
    listCid: v.version >= 3 ? cidFromBytes(v.listCid) : null, pendingCid: v.version >= 3 ? cidFromBytes(v.pendingCid) : null,
    fallbackPaid: s(v.fallbackPaid),
    // Payout token: its pool (null = holders are paid in XNT) and the holders' XNT not yet swapped.
    payoutPool: paysInToken(v) ? v.payoutPool.toBase58() : null, xntHolders: s(v.xntHolders),
  };
}
