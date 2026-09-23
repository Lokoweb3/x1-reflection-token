/**
 * Token factory launch: a creator's wallet signs three transactions, built here.
 *
 *   1. token   create the Token-2022 mint (tax fixed forever, withdraw authority = the
 *              token's own distributor wallet), mint the supply to the creator, revoke
 *              the mint authority, pay the launch fee in USDC and pre-fund the
 *              distributor's gas
 *   2. pool    create the TOKEN/XNT pool on XDEX with the creator's tokens and XNT
 *   3. lock    lock all the creator's LP in an lp_locker NFT (forever or until a date)
 *
 * Each launch is recorded under factory/launches/<mint>/. The distributor keypair is
 * generated here and never leaves the server; once all three steps are verified
 * on-chain the launch is registered and the factory distributor starts serving it.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMintLen,
  getTransferFeeConfig, unpackMint,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { Config, FACTORY_DIR, ROOT, toBaseUnits } from "../config.js";
import { buildCreatePool, poolAddresses, XDEX_CREATE } from "../xdex.js";
import { buildLock } from "../locker-tx.js";
import { listLocks } from "../locker.js";

const U64_MAX = 2n ** 64n - 1n;
export const DECIMALS = 9;

/** USDC used for the launch fee (mainnet: USDC.X; testnet: the USDC with an XDEX testnet pool). */
export const FEE_USDC: Record<"mainnet" | "testnet", string> = {
  mainnet: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
  testnet: "4dr9zMDzp4TY3ikZmsqF2ikSkmtWiCwWYJ9xJx1h2KsU",
};

export interface LaunchParams {
  creator: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  supply: string;        // whole tokens
  taxBps: number;        // 100..1000 (1–10%)
  autoLpBps: number;     // 0..5000 share of the tax that goes to auto-LP
  burnBps: number;       // 0..5000 share of the tax that is burned (auto-LP + burn <= 90%)
  poolTokens: string;    // whole tokens seeded into the pool
  poolXnt: string;       // XNT seeded into the pool
  lockDays: number | null; // null = forever
}

export interface LaunchRecord extends LaunchParams {
  mint: string;
  distributor: string;
  pool: string;
  createdAt: string;
  registeredAt?: string;
}

/** Validate and normalise untrusted launch input. */
export function validateParams(raw: Record<string, unknown>): LaunchParams {
  const str = (k: string, max: number, re?: RegExp) => {
    const v = String(raw[k] ?? "").trim();
    if (!v || v.length > max || (re && !re.test(v))) throw new Error(`Invalid ${k}`);
    return v;
  };
  const creator = new PublicKey(String(raw.creator)).toBase58();
  const name = str("name", 32);
  const symbol = str("symbol", 10, /^[A-Za-z0-9$._-]+$/);
  const description = String(raw.description ?? "").trim().slice(0, 500);
  const image = String(raw.image ?? "").trim();
  if (image && !/^(https:\/\/|ipfs:\/\/)[^\s"'<>]{3,300}$/.test(image)) throw new Error("Image must be an https:// or ipfs:// URL");
  const whole = (k: string, min: bigint, max: bigint) => {
    const v = String(raw[k] ?? "").trim();
    if (!/^\d+$/.test(v) || BigInt(v) < min || BigInt(v) > max) throw new Error(`Invalid ${k}`);
    return v;
  };
  const supply = whole("supply", 1_000n, 1_000_000_000_000n);
  const poolTokens = whole("poolTokens", 1n, BigInt(supply));
  const poolXnt = String(raw.poolXnt ?? "").trim();
  if (!/^\d+(\.\d{1,9})?$/.test(poolXnt) || !(Number(poolXnt) >= 0.01)) throw new Error("Pool XNT must be at least 0.01");
  const int = (k: string, min: number, max: number) => {
    const v = Number(raw[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid ${k}`);
    return v;
  };
  const taxBps = int("taxBps", 100, 1000);
  const autoLpBps = int("autoLpBps", 0, 5000);
  const burnBps = raw.burnBps === undefined ? 0 : int("burnBps", 0, 5000);
  if (autoLpBps + burnBps > 9000) throw new Error("Liquidity + burn can't exceed 90% of the tax (holders keep at least 10%)");
  const lockDays = raw.lockDays === null || raw.lockDays === "forever" ? null : int("lockDays", 1, 3650);
  return { creator, name, symbol, description, image, supply, taxBps, autoLpBps, burnBps, poolTokens, poolXnt, lockDays };
}

const launchDir = (mint: string) => path.join(FACTORY_DIR, "launches", mint);
export const readLaunch = (mint: string): LaunchRecord | null => {
  const f = path.join(launchDir(new PublicKey(mint).toBase58()), "launch.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
function writeLaunch(r: LaunchRecord) {
  fs.mkdirSync(launchDir(r.mint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(launchDir(r.mint), "launch.json"), JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
}
export function listLaunches(): LaunchRecord[] {
  const dir = path.join(FACTORY_DIR, "launches");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((m) => readLaunch(m)).filter((r): r is LaunchRecord => !!r)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const registeredLaunches = () => listLaunches().filter((r) => r.registeredAt);

/** Step 1: new mint + distributor wallet; returns the instructions and the mint keypair to co-sign. */
export async function buildTokenStep(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string) {
  const f = cfg.factory;
  if (!f?.feeReceiver) throw new Error("factory.feeReceiver is not set in config.json");
  const creator = new PublicKey(p.creator);
  const mintKp = Keypair.generate();
  const distributor = Keypair.generate();
  const mint = mintKp.publicKey;

  const uri = `${publicUrl.replace(/\/$/, "")}/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name: p.name, symbol: p.symbol, uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const supply = toBaseUnits(p.supply, DECIMALS);
  const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);

  // Launch fee in USDC.
  const usdc = new PublicKey(FEE_USDC[cfg.network]);
  const usdcInfo = await conn.getAccountInfo(usdc);
  if (!usdcInfo) throw new Error("Fee USDC mint not found on this network");
  const usdcProgram = usdcInfo.owner;
  const usdcMint = unpackMint(usdc, usdcInfo, usdcProgram);
  const fee = toBaseUnits(f.feeUsdc, usdcMint.decimals);
  const receiver = new PublicKey(f.feeReceiver);
  const fromUsdc = getAssociatedTokenAddressSync(usdc, creator, false, usdcProgram);
  const toUsdc = getAssociatedTokenAddressSync(usdc, receiver, false, usdcProgram);
  const fromInfo = await conn.getAccountInfo(fromUsdc);
  const balance = fromInfo ? (await conn.getTokenAccountBalance(fromUsdc)).value.amount : "0";
  if (BigInt(balance) < fee) throw new Error(`The launch fee is ${f.feeUsdc} USDC; this wallet has ${Number(balance) / 10 ** usdcMint.decimals}.`);

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    // No fee-config authority: the tax can never be changed. The token's distributor
    // wallet is the only one that can withdraw collected tax.
    createInitializeTransferFeeConfigInstruction(mint, null, distributor.publicKey, p.taxBps, U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, creator, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, mint, mintAuthority: creator,
      name: p.name, symbol: p.symbol, uri,
    }),
    createAssociatedTokenAccountIdempotentInstruction(creator, creatorAta, creator, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, creatorAta, creator, supply, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(creator, toUsdc, receiver, usdc, usdcProgram),
    createTransferCheckedInstruction(fromUsdc, usdc, toUsdc, creator, fee, usdcMint.decimals, [], usdcProgram),
    SystemProgram.transfer({ fromPubkey: creator, toPubkey: distributor.publicKey, lamports: toBaseUnits(f.gasXnt ?? "0.05", 9) }),
  ];

  const pool = poolAddresses(new PublicKey(cfg.xdex.programId), new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint).pool;
  const record: LaunchRecord = { ...p, mint: mint.toBase58(), distributor: distributor.publicKey.toBase58(), pool: pool.toBase58(), createdAt: new Date().toISOString() };
  writeLaunch(record);
  fs.writeFileSync(path.join(launchDir(record.mint), "distributor.json"), JSON.stringify(Array.from(distributor.secretKey)), { mode: 0o600 });
  return { ixs, signers: [mintKp], record };
}

/** Step 2: create the XDEX pool with the creator's tokens and XNT. */
export function buildPoolStep(cfg: Config, r: LaunchRecord) {
  return buildCreatePool(new PublicKey(cfg.xdex.programId), cfg.network, new PublicKey(r.creator), new PublicKey(r.mint),
    toBaseUnits(r.poolTokens, DECIMALS), toBaseUnits(r.poolXnt, 9));
}

/** Step 3: lock all the creator's LP for this pool in an lp_locker NFT. */
export async function buildLockStep(conn: Connection, cfg: Config, r: LaunchRecord) {
  const unlockAt = r.lockDays === null ? undefined : Math.floor(Date.now() / 1000 + r.lockDays * 86_400);
  return buildLock(conn, cfg, new PublicKey(r.creator), "all", unlockAt,
    { pool: new PublicKey(r.pool), mint: new PublicKey(r.mint), symbol: r.symbol });
}

/** Which steps are done, read from the chain. */
export async function launchStatus(conn: Connection, cfg: Config, r: LaunchRecord) {
  const [mintInfo, poolInfo] = await conn.getMultipleAccountsInfo([new PublicKey(r.mint), new PublicKey(r.pool)], "confirmed");
  const token = !!mintInfo;
  const pool = !!poolInfo && poolInfo.owner.equals(new PublicKey(cfg.xdex.programId));
  let lock = false;
  if (pool && cfg.locker?.programId) {
    const locks = await listLocks(conn, new PublicKey(cfg.locker.programId), new PublicKey(r.pool));
    lock = locks.some((l) => l.locker.toBase58() === r.creator);
  }
  return { token, pool, lock, registered: !!r.registeredAt };
}

/**
 * Verify the launch on-chain (tax immutable and withdrawable only by our distributor,
 * supply fixed, pool live, LP locked) and register it with the factory distributor.
 */
export async function registerLaunch(conn: Connection, cfg: Config, r: LaunchRecord) {
  const s = await launchStatus(conn, cfg, r);
  if (!s.token || !s.pool || !s.lock) throw new Error("Launch is not complete yet (token, pool and LP lock are all required).");
  const mint = unpackMint(new PublicKey(r.mint), await conn.getAccountInfo(new PublicKey(r.mint), "confirmed"), TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mint);
  if (!fee || !fee.withdrawWithheldAuthority.equals(new PublicKey(r.distributor)) || !fee.transferFeeConfigAuthority.equals(PublicKey.default)
      || mint.mintAuthority !== null) {
    throw new Error("Token does not match the factory launch (fee authorities or mint authority differ).");
  }
  if (r.registeredAt) return r;
  const dir = launchDir(r.mint);
  const tokenCfg: Config = {
    ...cfg,
    token: { name: r.name, symbol: r.symbol, uri: "", decimals: DECIMALS, supply: r.supply, feeBps: r.taxBps, launchGrace: false },
    mint: r.mint,
    keypairs: { ...cfg.keypairs, distributor: path.relative(ROOT, path.join(dir, "distributor.json")) },
    xdex: { ...cfg.xdex, pool: r.pool },
    distribution: { ...cfg.distribution, autoLpBps: r.autoLpBps, burnBps: r.burnBps ?? 0, excludeOwners: [] },
  };
  delete (tokenCfg as Partial<Config>).factory;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(tokenCfg, null, 2) + "\n", { mode: 0o600 });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
  const done = { ...r, registeredAt: new Date().toISOString() };
  writeLaunch(done);
  return done;
}
