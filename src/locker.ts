/**
 * Client helpers for the lp_locker program (see lp-locker/programs/lp_locker): account
 * decoding, PDAs, lock discovery and the same fee math the program uses.
 */
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
export const LOCK_IX = disc("global:lock");
export const COLLECT_IX = disc("global:collect_fees");
export const LOCK_TIMED_IX = disc("global:lock_timed");
export const UNLOCK_IX = disc("global:unlock");
const SCHEDULE_ACCOUNT = disc("account:LockSchedule");
const SCHEDULE_LEN = 8 + 32 + 8 + 1;
const LOCK_ACCOUNT = disc("account:Lock");
const LOCK_LEN = 8 + 32 * 4 + 8 + 16 + 8 + 8 + 1 + 1;
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface Lock {
  address: PublicKey;
  nftMint: PublicKey;
  pool: PublicKey;
  lpMint: PublicKey;
  locker: PublicKey;
  lockedLp: bigint;
  principal: bigint;
  feeLpCollected: bigint;
  lockedAt: number;
  /** Unix seconds after which the NFT holder can take the LP back; null = locked forever. */
  unlockAt: number | null;
}

function decodeLock(address: PublicKey, d: Buffer): Lock {
  if (d.length !== LOCK_LEN || !d.subarray(0, 8).equals(LOCK_ACCOUNT)) throw new Error("Not a lock account");
  const key = (i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));
  const o = 8 + 128;
  return {
    address, nftMint: key(0), pool: key(1), lpMint: key(2), locker: key(3),
    lockedLp: d.readBigUInt64LE(o),
    principal: d.readBigUInt64LE(o + 8) + (d.readBigUInt64LE(o + 16) << 64n),
    feeLpCollected: d.readBigUInt64LE(o + 24),
    lockedAt: Number(d.readBigInt64LE(o + 32)),
    unlockAt: null,
  };
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}

/** LP tokens worth of fees, exactly as the program computes it. */
export function pendingFeeLp(lockedLp: bigint, principal: bigint, sqrtK: bigint, supply: bigint) {
  const value = (lockedLp * sqrtK) / supply;
  return value > principal ? ((value - principal) * supply) / sqrtK : 0n;
}

export const lockPda = (programId: PublicKey, nftMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("lock"), nftMint.toBuffer()], programId)[0];
export const schedulePda = (programId: PublicKey, lock: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("schedule"), lock.toBuffer()], programId)[0];
export const vaultPda = (programId: PublicKey, lock: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), lock.toBuffer()], programId)[0];


/** Every lock on `pool`, oldest first. */
export async function listLocks(conn: Connection, programId: PublicKey, pool: PublicKey): Promise<Lock[]> {
  const raw = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: LOCK_LEN }, { memcmp: { offset: 8 + 32, bytes: pool.toBase58() } }],
  });
  const schedules = await conn.getProgramAccounts(programId, { commitment: "confirmed", filters: [{ dataSize: SCHEDULE_LEN }] });
  const unlockAt = new Map<string, number>();
  for (const { account } of schedules) {
    const d = account.data;
    if (!d.subarray(0, 8).equals(SCHEDULE_ACCOUNT)) continue;
    unlockAt.set(new PublicKey(d.subarray(8, 40)).toBase58(), Number(d.readBigInt64LE(40)));
  }
  return raw.map(({ pubkey, account }) => ({ ...decodeLock(pubkey, account.data), unlockAt: unlockAt.get(pubkey.toBase58()) ?? null }))
    .sort((a, b) => a.lockedAt - b.lockedAt);
}

/** LP tokens currently in a lock's vault. */
export async function lockedLp(conn: Connection, programId: PublicKey, lock: PublicKey) {
  const vault = vaultPda(programId, lock);
  const info = await conn.getAccountInfo(vault, "confirmed");
  return info ? unpackAccount(vault, info, TOKEN_PROGRAM_ID).amount : 0n;
}

/** Current holder of a lock NFT (the wallet with the fee rights). */
export async function nftHolder(conn: Connection, nftMint: PublicKey) {
  const largest = await conn.getTokenLargestAccounts(nftMint, "confirmed");
  const acc = largest.value.find((a) => a.amount === "1");
  if (!acc) return null;
  const info = await conn.getAccountInfo(acc.address, "confirmed");
  return { account: acc.address, owner: unpackAccount(acc.address, info, TOKEN_2022_PROGRAM_ID).owner };
}

// ---------- Creator rewards (vesting vault per lock NFT and reward token) ----------

export const INIT_REWARD_VAULT_IX = disc("global:init_reward_vault");
export const DEPOSIT_REWARD_IX = disc("global:deposit_reward");
export const CLAIM_REWARD_IX = disc("global:claim_reward");
const REWARD_VAULT_ACCOUNT = disc("account:RewardVault");
const TRANCHES = 10;
export const REWARD_VAULT_LEN = 8 + 32 + 32 + 8 * 3 + TRANCHES * 16 + 2;

export const rewardVaultPda = (programId: PublicKey, nftMint: PublicKey, rewardMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("reward"), nftMint.toBuffer(), rewardMint.toBuffer()], programId)[0];
export const rewardTokensPda = (programId: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("reward_tokens"), vault.toBuffer()], programId)[0];

export interface RewardVault {
  address: PublicKey;
  nftMint: PublicKey;
  rewardMint: PublicKey;
  claimable: bigint;
  totalDeposited: bigint;
  totalClaimed: bigint;
  tranches: { amount: bigint; unlockAt: number }[];
}

export function decodeRewardVault(address: PublicKey, d: Buffer): RewardVault {
  if (d.length !== REWARD_VAULT_LEN || !d.subarray(0, 8).equals(REWARD_VAULT_ACCOUNT)) throw new Error("Not a reward vault");
  const tranches = [];
  for (let i = 0; i < TRANCHES; i++) {
    const o = 8 + 64 + 24 + i * 16;
    const amount = d.readBigUInt64LE(o);
    if (amount > 0n) tranches.push({ amount, unlockAt: Number(d.readBigInt64LE(o + 8)) });
  }
  return {
    address, nftMint: new PublicKey(d.subarray(8, 40)), rewardMint: new PublicKey(d.subarray(40, 72)),
    claimable: d.readBigUInt64LE(72), totalDeposited: d.readBigUInt64LE(80), totalClaimed: d.readBigUInt64LE(88), tranches,
  };
}

/** What the NFT holder could claim right now, what's still vesting, and when the next part unlocks. */
export function rewardSummary(v: RewardVault, nowSec = Date.now() / 1000) {
  let claimable = v.claimable, vesting = 0n, nextUnlock: number | null = null;
  for (const t of v.tranches) {
    if (t.unlockAt <= nowSec) claimable += t.amount;
    else { vesting += t.amount; nextUnlock = nextUnlock === null ? t.unlockAt : Math.min(nextUnlock, t.unlockAt); }
  }
  // How much vests at nextUnlock (deposits in the same bucket share an unlock time).
  let nextAmount = 0n;
  if (nextUnlock !== null) for (const t of v.tranches) if (t.unlockAt === nextUnlock) nextAmount += t.amount;
  return { claimable, vesting, nextUnlock, nextAmount, totalDeposited: v.totalDeposited, totalClaimed: v.totalClaimed };
}

export async function readRewardVault(conn: Connection, programId: PublicKey, nftMint: PublicKey, rewardMint: PublicKey) {
  const address = rewardVaultPda(programId, nftMint, rewardMint);
  const info = await conn.getAccountInfo(address, "confirmed");
  return info ? decodeRewardVault(address, info.data) : null;
}
