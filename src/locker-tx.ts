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
  createSyncNativeInstruction, getAssociatedTokenAddressSync, getMintLen, getTokenMetadata, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { receiptData, receiptUri } from "./web/receipt.js";
import { Config, requireMint } from "./config.js";
import { poolAuthority, snapshot } from "./xdex.js";
import {
  CLAIM_REWARD_IX, COLLECT_IX, DEPOSIT_REWARD_IX, INIT_REWARD_VAULT_IX, LOCK_IX, LOCK_TIMED_IX, Lock, MEMO_PROGRAM_ID,
  UNLOCK_IX, isqrt, listLocks, lockPda, lockedLp, nftHolder, pendingFeeLp, readRewardVault, rewardSummary, rewardTokensPda,
  rewardVaultPda, schedulePda, vaultPda,
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
  // Pre-fund room for the receipt (buildReceipt) so printing it needs no rent top-up.
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length + RECEIPT_ROOM);

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

const RECEIPT_ROOM = 1_000;

/**
 * Print the lock's receipt into its NFT: sets the metadata `uri` to a data: URI holding
 * the JSON and SVG image, so the artwork lives on-chain with nothing hosted. Run after the
 * lock confirms, so it shows the real on-chain lock time. Only the NFT's update authority
 * (the wallet that locked) can sign it. Tops up rent if the mint wasn't pre-funded.
 */
export async function buildReceipt(conn: Connection, cfg: Config, authority: PublicKey, nftMint: PublicKey) {
  const d = await receiptData(conn, cfg, nftMint);
  if (!d) throw new Error("Lock not found for that NFT.");
  const info = await conn.getAccountInfo(nftMint, "confirmed");
  if (!info) throw new Error("NFT mint not found.");
  const current = await getTokenMetadata(conn, nftMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!current) throw new Error("This NFT has no metadata.");
  if (!current.updateAuthority?.equals(authority)) {
    throw new Error(`Only the wallet that locked (${current.updateAuthority?.toBase58() ?? "nobody"}) can print this receipt.`);
  }
  const uri = receiptUri(d);
  const ixs: TransactionInstruction[] = [];
  const newLen = info.data.length + Buffer.byteLength(uri) - Buffer.byteLength(current.uri);
  const need = BigInt(await conn.getMinimumBalanceForRentExemption(newLen)) - BigInt(info.lamports);
  if (need > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: authority, toPubkey: nftMint, lamports: need }));
  ixs.push(createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: nftMint, updateAuthority: authority, field: "uri", value: uri }));
  return { ixs, receipt: d, printed: current.uri === uri };
}

/** The receipt image (data: URI) stored in an NFT's metadata, or null if none was printed. */
export function receiptImage(uri: string) {
  const prefix = "data:application/json,";
  if (!uri.startsWith(prefix)) return null;
  try { const img = JSON.parse(decodeURIComponent(uri.slice(prefix.length))).image; return typeof img === "string" && img.startsWith("data:image/svg+xml,") ? img : null; }
  catch { return null; }
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
export async function buildCollect(conn: Connection, cfg: Config, holder: PublicKey, nftMint?: PublicKey, force = false, where?: Target) {
  const ids = lockerIds(cfg, where);
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

// ---------- Creator rewards ----------

/**
 * Deposit `amount` of `rewardMint` from `depositor`'s account into the vesting vault of
 * lock NFT `nftMint`, creating the vault first if needed. For wrapped XNT (the native
 * mint) the XNT is wrapped into the depositor's wrapped-XNT account in the same
 * transaction.
 */
export async function buildDepositReward(
  conn: Connection, cfg: Config, depositor: PublicKey, nftMint: PublicKey, rewardMint: PublicKey, amount: bigint,
) {
  const ids = lockerIds(cfg);
  const mintInfo = await conn.getAccountInfo(rewardMint);
  if (!mintInfo) throw new Error("Reward mint not found");
  const rewardProgram = mintInfo.owner;
  const vault = rewardVaultPda(ids.programId, nftMint, rewardMint);
  const vaultTokens = rewardTokensPda(ids.programId, vault);
  const from = getAssociatedTokenAddressSync(rewardMint, depositor, false, rewardProgram);
  const ixs: TransactionInstruction[] = [];
  if (!(await conn.getAccountInfo(vault))) {
    ixs.push(new TransactionInstruction({
      programId: ids.programId, data: Buffer.from(INIT_REWARD_VAULT_IX),
      keys: [
        meta(depositor, true, true), meta(nftMint, false, false), meta(lockPda(ids.programId, nftMint), false, false),
        meta(rewardMint, false, false), meta(vault, false, true), meta(vaultTokens, false, true),
        meta(rewardProgram, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false),
      ],
    }));
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(depositor, from, depositor, rewardMint, rewardProgram));
  if (rewardMint.equals(NATIVE_MINT)) {
    ixs.push(SystemProgram.transfer({ fromPubkey: depositor, toPubkey: from, lamports: amount }), createSyncNativeInstruction(from, rewardProgram));
  }
  const data = Buffer.alloc(16);
  DEPOSIT_REWARD_IX.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  ixs.push(new TransactionInstruction({
    programId: ids.programId, data,
    keys: [
      meta(depositor, true, false), meta(vault, false, true), meta(vaultTokens, false, true),
      meta(rewardMint, false, false), meta(from, false, true), meta(rewardProgram, false, false),
    ],
  }));
  return { ixs, vault };
}

/**
 * Claim every vested creator reward for lock NFT `nftMint` to `holder` (who must hold
 * the NFT). Wrapped XNT is unwrapped straight into the wallet.
 */
export async function buildClaimReward(conn: Connection, cfg: Config, holder: PublicKey, nftMint: PublicKey, rewardMint: PublicKey) {
  const ids = lockerIds(cfg);
  const vaultState = await readRewardVault(conn, ids.programId, nftMint, rewardMint);
  if (!vaultState) throw new Error("No creator rewards have been deposited for this NFT yet.");
  const s = rewardSummary(vaultState);
  if (s.claimable === 0n) {
    throw new Error(s.vesting > 0n && s.nextUnlock
      ? `Nothing has vested yet; the next part unlocks ${new Date(s.nextUnlock * 1000).toLocaleString()}.`
      : "Nothing to claim.");
  }
  const nftAcc = await nftHolder(conn, nftMint);
  if (!nftAcc?.owner.equals(holder)) throw new Error(`The NFT is held by ${nftAcc?.owner.toBase58() ?? "nobody"}, not this wallet.`);
  const rewardProgram = (await conn.getAccountInfo(rewardMint))!.owner;
  const native = rewardMint.equals(NATIVE_MINT);
  const to = native
    ? await PublicKey.createWithSeed(holder, LP_TEMP_SEED + "-r", rewardProgram)
    : getAssociatedTokenAddressSync(rewardMint, holder, false, rewardProgram);
  const ixs: TransactionInstruction[] = [];
  if (native) {
    if (await conn.getAccountInfo(to)) throw new Error(`Temporary account ${to.toBase58()} exists from an earlier attempt; close it first.`);
    ixs.push(
      SystemProgram.createAccountWithSeed({
        fromPubkey: holder, newAccountPubkey: to, basePubkey: holder, seed: LP_TEMP_SEED + "-r",
        lamports: await conn.getMinimumBalanceForRentExemption(165), space: 165, programId: rewardProgram,
      }),
      createInitializeAccount3Instruction(to, NATIVE_MINT, holder, rewardProgram),
    );
  } else {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(holder, to, holder, rewardMint, rewardProgram));
  }
  ixs.push(new TransactionInstruction({
    programId: ids.programId, data: Buffer.from(CLAIM_REWARD_IX),
    keys: [
      meta(holder, true, false), meta(vaultState.address, false, true), meta(rewardTokensPda(ids.programId, vaultState.address), false, true),
      meta(rewardMint, false, false), meta(nftAcc.account, false, false), meta(to, false, true),
      meta(rewardProgram, false, false), meta(TOKEN_2022_PROGRAM_ID, false, false),
    ],
  }));
  if (native) ixs.push(createCloseAccountInstruction(to, holder, holder, [], rewardProgram));
  return { ixs, amount: s.claimable };
}
