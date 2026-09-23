/**
 * Instruction builders for lp_locker `lock` and `collect_fees`, shared by the CLI
 * (src/lp-lock.ts, signs with a local keypair) and the dashboard (the viewer's browser
 * wallet signs). Nothing here signs or sends except the fresh NFT mint keypair that
 * `buildLock` returns for the caller to add as a signer.
 */
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE,
  calculateEpochFee, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createInitializeAccount3Instruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  getAssociatedTokenAddressSync, getMintLen, unpackAccount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { Config, requireMint } from "./config.js";
import { poolAuthority, snapshot } from "./xdex.js";
import {
  COLLECT_IX, LOCK_IX, LOCK_TIMED_IX, Lock, MEMO_PROGRAM_ID, UNLOCK_IX, isqrt, listLocks, lockPda, lockedLp, nftHolder,
  pendingFeeLp, schedulePda, vaultPda,
} from "./locker.js";

const LP_TEMP_SEED = "reflect-lock-fees-v1";
/** Fees worth less than this (0.00001 XNT) aren't worth a transaction. */
export const DUST_LAMPORTS = 10_000n;

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

/** Which pool/token to act on; defaults to the ones in config.json. */
export interface Target { pool: PublicKey; mint: PublicKey; symbol: string }

export function lockerIds(cfg: Config, target?: Target) {
  if (!cfg.locker?.programId) throw new Error("Set locker.programId in config.json to the deployed lp_locker program.");
  if (!cfg.xdex.pool) throw new Error("xdex.pool is not set");
  return {
    programId: new PublicKey(cfg.locker.programId), xdex: new PublicKey(cfg.xdex.programId),
    pool: target?.pool ?? new PublicKey(cfg.xdex.pool), mint: target?.mint ?? requireMint(cfg),
  };
}

/** LP tokens `owner` holds in their wallet (the withdrawable kind). */
export async function walletLp(conn: Connection, cfg: Config, owner: PublicKey) {
  const ids = lockerIds(cfg);
  const snap = await snapshot(conn, ids.xdex, ids.pool, ids.mint);
  const ata = getAssociatedTokenAddressSync(snap.pool.lpMint, owner, false, TOKEN_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata, "confirmed");
  return { amount: info ? unpackAccount(ata, info, TOKEN_PROGRAM_ID).amount : 0n, decimals: snap.pool.lpDecimals, supply: snap.pool.lpSupply };
}

/**
 * Lock `amount` (or all) of `owner`'s LP and mint them the fee NFT. With `unlockAt`
 * (unix seconds) the NFT holder can take the LP back after that time; without it the
 * lock is forever.
 */
export async function buildLock(
  conn: Connection, cfg: Config, owner: PublicKey, amount: bigint | "all", unlockAt?: number, target?: Target,
) {
  const ids = lockerIds(cfg, target);
  const snap = await snapshot(conn, ids.xdex, ids.pool, ids.mint);
  const pool = snap.pool;
  const ownerLp = getAssociatedTokenAddressSync(pool.lpMint, owner, false, TOKEN_PROGRAM_ID);
  const lpInfo = await conn.getAccountInfo(ownerLp, "confirmed");
  const held = lpInfo ? unpackAccount(ownerLp, lpInfo, TOKEN_PROGRAM_ID).amount : 0n;
  const lp = amount === "all" ? held : amount;
  if (lp <= 0n || lp > held) throw new Error(`Wallet holds ${held} LP base units; cannot lock ${amount}.`);

  const nft = Keypair.generate();
  const lock = lockPda(ids.programId, nft.publicKey);
  const vault = vaultPda(ids.programId, lock);
  const ownerNft = getAssociatedTokenAddressSync(nft.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
  const name = `${target?.symbol ?? cfg.token.symbol} LP Lock`.slice(0, 32);
  const symbol = "LPLOCK";
  const uri = cfg.locker?.nftUri ?? "";
  const metadata: TokenMetadata = { mint: nft.publicKey, name, symbol, uri, updateAuthority: owner, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);

  if (unlockAt !== undefined && !(unlockAt > Date.now() / 1000)) throw new Error("Unlock time must be in the future.");
  const data = Buffer.alloc(unlockAt === undefined ? 16 : 24);
  (unlockAt === undefined ? LOCK_IX : LOCK_TIMED_IX).copy(data, 0);
  data.writeBigUInt64LE(lp, 8);
  if (unlockAt !== undefined) data.writeBigInt64LE(BigInt(Math.floor(unlockAt)), 16);
  const timedKeys = unlockAt === undefined ? [] : [meta(schedulePda(ids.programId, lock), false, true), meta(SystemProgram.programId, false, false)];
  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: owner, newAccountPubkey: nft.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(nft.publicKey, owner, nft.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(nft.publicKey, 0, owner, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: nft.publicKey, updateAuthority: owner,
      mint: nft.publicKey, mintAuthority: owner, name, symbol, uri,
    }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ownerNft, owner, nft.publicKey, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({
      programId: ids.programId, data,
      keys: [
        meta(owner, true, true), meta(ids.pool, false, false),
        meta(pool.vaults[0], false, false), meta(pool.vaults[1], false, false),
        meta(pool.lpMint, false, false), meta(ownerLp, false, true),
        meta(nft.publicKey, false, true), meta(ownerNft, false, true),
        meta(lock, false, true), meta(vault, false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false),
        ...timedKeys,
      ],
    }),
  ];
  return {
    ixs, signers: [nft],
    summary: { lp, held, lpDecimals: pool.lpDecimals, lpSupply: pool.lpSupply, nftMint: nft.publicKey, lock, vault, unlockAt: unlockAt ?? null },
  };
}

/** After a timed lock expires, return all its LP to the NFT holder and burn the NFT. */
export async function buildUnlock(conn: Connection, cfg: Config, holder: PublicKey, nftMint: PublicKey) {
  const ids = lockerIds(cfg);
  const target = (await listLocks(conn, ids.programId, ids.pool)).find((l) => l.nftMint.equals(nftMint));
  if (!target) throw new Error("Lock not found.");
  if (target.unlockAt === null) throw new Error("This lock is forever; it can never be unlocked.");
  if (target.unlockAt > Date.now() / 1000) throw new Error(`Still locked until ${new Date(target.unlockAt * 1000).toLocaleString()}.`);
  const nftAcc = await nftHolder(conn, nftMint);
  if (!nftAcc?.owner.equals(holder)) throw new Error(`That lock's NFT is held by ${nftAcc?.owner.toBase58() ?? "nobody"}, not this wallet.`);
  const holderLp = getAssociatedTokenAddressSync(target.lpMint, holder, false, TOKEN_PROGRAM_ID);
  const lp = await lockedLp(conn, ids.programId, target.address);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(holder, holderLp, holder, target.lpMint, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: ids.programId, data: Buffer.from(UNLOCK_IX),
      keys: [
        meta(holder, true, true), meta(target.address, false, true), meta(schedulePda(ids.programId, target.address), false, true),
        meta(nftMint, false, true), meta(nftAcc.account, false, true),
        meta(vaultPda(ids.programId, target.address), false, true), meta(holderLp, false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false),
      ],
    }),
  ];
  return { ixs, summary: { lock: target.address, lp } };
}

/**
 * Collect the trading fees of the lock whose NFT `holder` holds (or of `nftMint`).
 * Returns null fees when there is nothing, or only dust, to collect.
 */
export async function buildCollect(conn: Connection, cfg: Config, holder: PublicKey, nftMint?: PublicKey, force = false) {
  const ids = lockerIds(cfg);
  const locks = await listLocks(conn, ids.programId, ids.pool);
  let target: Lock | undefined;
  if (nftMint) target = locks.find((l) => l.nftMint.equals(nftMint));
  else for (const l of locks) if ((await nftHolder(conn, l.nftMint))?.owner.equals(holder)) { target = l; break; }
  if (!target) throw new Error("No lock found whose NFT this wallet holds.");
  const nftAcc = await nftHolder(conn, target.nftMint);
  if (!nftAcc?.owner.equals(holder)) throw new Error(`That lock's NFT is held by ${nftAcc?.owner.toBase58() ?? "nobody"}, not this wallet.`);

  const snap = await snapshot(conn, ids.xdex, ids.pool, ids.mint);
  const pool = snap.pool;
  const reserves = snap.side === 0 ? [snap.reserveToken, snap.reserveXnt] : [snap.reserveXnt, snap.reserveToken];
  const lp = await lockedLp(conn, ids.programId, target.address);
  const fee = pendingFeeLp(lp, target.principal, isqrt(reserves[0] * reserves[1]), pool.lpSupply);

  // Expected withdrawal, net of the Token-2022 transfer fee on our token's side.
  const slip = BigInt(cfg.distribution.slippageBps);
  const outs = reserves.map((r, i) => {
    const gross = (fee * r) / pool.lpSupply;
    const net = i === snap.side ? gross - calculateEpochFee(snap.feeCfg, snap.epoch, gross) : gross;
    return { net, min: (net * (10_000n - slip)) / 10_000n };
  });
  const xntOut = outs[1 - snap.side].net, tokenOut = outs[snap.side].net;
  const worth = xntOut + (tokenOut * snap.reserveXnt) / snap.reserveToken;
  const summary = { lock: target.address, nftMint: target.nftMint, feeLp: fee, lpDecimals: pool.lpDecimals, xntOut, tokenOut, worth };
  if (fee <= 0n || (worth < DUST_LAMPORTS && !force)) return { ixs: null, summary };

  const wxntProgram = pool.programs[1 - snap.side];
  const temp = await PublicKey.createWithSeed(holder, LP_TEMP_SEED, wxntProgram);
  if (await conn.getAccountInfo(temp)) throw new Error(`Temporary account ${temp.toBase58()} exists from an earlier attempt; close it first.`);
  const tokenAta = getAssociatedTokenAddressSync(ids.mint, holder, false, TOKEN_2022_PROGRAM_ID);
  const dest = snap.side === 0 ? [tokenAta, temp] : [temp, tokenAta];
  const rent = await conn.getMinimumBalanceForRentExemption(165);

  const data = Buffer.alloc(24);
  COLLECT_IX.copy(data, 0);
  data.writeBigUInt64LE(outs[0].min, 8);
  data.writeBigUInt64LE(outs[1].min, 16);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(holder, tokenAta, holder, ids.mint, TOKEN_2022_PROGRAM_ID),
    SystemProgram.createAccountWithSeed({
      fromPubkey: holder, newAccountPubkey: temp, basePubkey: holder,
      seed: LP_TEMP_SEED, lamports: rent, space: 165, programId: wxntProgram,
    }),
    createInitializeAccount3Instruction(temp, NATIVE_MINT, holder, wxntProgram),
    new TransactionInstruction({
      programId: ids.programId, data,
      keys: [
        meta(holder, true, true), meta(target.address, false, true), meta(nftAcc.account, false, false),
        meta(vaultPda(ids.programId, target.address), false, true), meta(ids.pool, false, true), meta(poolAuthority(ids.xdex), false, false),
        meta(dest[0], false, true), meta(dest[1], false, true),
        meta(pool.vaults[0], false, true), meta(pool.vaults[1], false, true),
        meta(TOKEN_PROGRAM_ID, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false),
        meta(pool.mints[0], false, false), meta(pool.mints[1], false, false),
        meta(pool.lpMint, false, true), meta(MEMO_PROGRAM_ID, false, false), meta(ids.xdex, false, false),
      ],
    }),
    // Unwrap the XNT side straight into the wallet.
    createCloseAccountInstruction(temp, holder, holder, [], wxntProgram),
  ];
  return { ixs, summary };
}
