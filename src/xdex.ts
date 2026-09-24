/**
 * Minimal XDEX (Raydium CP-swap fork) client: read a TOKEN/XNT pool, quote and build a
 * token->XNT sale and a TOKEN+XNT liquidity deposit, both accounting for the Token-2022
 * transfer fee. Pool layout matches ../lp-profit-bot for X1 mainnet and testnet; the
 * deposit accounts and data match real XDEX mainnet `Deposit` transactions.
 */
import crypto from "node:crypto";
import {
  AccountInfo, Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TransferFeeConfig, calculateEpochFee,
  createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction,
  createCloseAccountInstruction, createInitializeAccount3Instruction, createSyncNativeInstruction, getAssociatedTokenAddressSync,
  getEpochFee, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const POOL_DISC = disc("account:PoolState");
const CONFIG_DISC = disc("account:AmmConfig");
const SWAP_BASE_INPUT = disc("global:swap_base_input");
const DEPOSIT = disc("global:deposit");
const TEMP_SEED = "reflect-xnt-out-v1";
const LP_TEMP_SEED = "reflect-xnt-lp-v1";
const FEE_DENOM = 1_000_000n;

export interface Pool {
  address: PublicKey;
  ammConfig: PublicKey;
  vaults: [PublicKey, PublicKey];
  mints: [PublicKey, PublicKey];
  programs: [PublicKey, PublicKey];
  observation: PublicKey;
  lpMint: PublicKey;
  lpSupply: bigint;
  lpDecimals: number;
  depositsPaused: boolean;
  protocolFees: [bigint, bigint];
  fundFees: [bigint, bigint];
}

export function decodePool(address: PublicKey, info: AccountInfo<Buffer> | null, programId: PublicKey): Pool {
  if (!info || !info.owner.equals(programId)) throw new Error("Pool account is missing or not owned by XDEX");
  const d = info.data;
  if (d.length !== 637 || !d.subarray(0, 8).equals(POOL_DISC)) throw new Error("Unsupported XDEX pool layout");
  const key = (i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));
  if (d[329] & 4) throw new Error("Pool swaps are paused");
  const u64 = (o: number) => d.readBigUInt64LE(o);
  if (u64(373) > BigInt(Math.floor(Date.now() / 1000))) throw new Error("Pool is not open yet");
  return {
    address, ammConfig: key(0), vaults: [key(2), key(3)], mints: [key(5), key(6)],
    programs: [key(7), key(8)], observation: key(9),
    lpMint: key(4), lpSupply: u64(333), lpDecimals: d[330], depositsPaused: (d[329] & 1) !== 0,
    protocolFees: [u64(341), u64(349)], fundFees: [u64(357), u64(365)],
  };
}

export const poolAuthority = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], programId)[0];

export interface SellQuote {
  pool: Pool;
  side: number;              // index of our token in pool.mints
  amountIn: bigint;          // tokens leaving our account
  transferFee: bigint;       // withheld by Token-2022 on the way into the vault
  expectedOut: bigint;       // lamports of XNT
  minimumOut: bigint;
  priceImpactBps: bigint;
}

/** Pure CPMM math (exported for tests). */
export function cpmmOut(netIn: bigint, reserveIn: bigint, reserveOut: bigint, tradeFeeRate: bigint) {
  const fee = (netIn * tradeFeeRate + FEE_DENOM - 1n) / FEE_DENOM;
  const afterFee = netIn - fee;
  return (afterFee * reserveOut) / (reserveIn + afterFee);
}

/** Largest pre-transfer-fee input whose price impact stays within maxImpactBps. */
export function maxInputForImpact(reserveIn: bigint, maxImpactBps: bigint, transferFeeBps: bigint) {
  if (maxImpactBps <= 0n || maxImpactBps >= 10_000n || transferFeeBps >= 10_000n) return 0n;
  const net = (reserveIn * maxImpactBps) / (10_000n - maxImpactBps);
  return (net * 10_000n) / (10_000n - transferFeeBps);
}

interface Snapshot {
  pool: Pool;
  side: number;
  reserveToken: bigint;
  reserveXnt: bigint;
  tradeFeeRate: bigint;
  feeCfg: TransferFeeConfig;
  epoch: bigint;
}

/** Pool, reserves (net of protocol and fund fees) and the mint's current transfer fee. */
export async function snapshot(conn: Connection, programId: PublicKey, poolAddr: PublicKey, mint: PublicKey): Promise<Snapshot> {
  const [poolInfo] = await conn.getMultipleAccountsInfo([poolAddr]);
  const pool = decodePool(poolAddr, poolInfo, programId);
  const side = pool.mints.findIndex((m) => m.equals(mint));
  if (side < 0 || !pool.mints[1 - side].equals(NATIVE_MINT)) throw new Error("Pool is not a TOKEN/XNT pool for this mint");
  if (!pool.programs[side].equals(TOKEN_2022_PROGRAM_ID)) throw new Error("Pool token program mismatch");

  const [cfgInfo, vIn, vOut, mintInfo] = await conn.getMultipleAccountsInfo(
    [pool.ammConfig, pool.vaults[side], pool.vaults[1 - side], mint]);
  if (!cfgInfo || !cfgInfo.owner.equals(programId) || cfgInfo.data.length !== 236
      || !cfgInfo.data.subarray(0, 8).equals(CONFIG_DISC)) throw new Error("Invalid XDEX fee config");
  const tradeFeeRate = cfgInfo.data.readBigUInt64LE(12);
  if (tradeFeeRate >= FEE_DENOM) throw new Error("Invalid XDEX trade fee");

  const vaultIn = unpackAccount(pool.vaults[side], vIn, pool.programs[side]);
  const vaultOut = unpackAccount(pool.vaults[1 - side], vOut, pool.programs[1 - side]);
  const reserveToken = vaultIn.amount - pool.protocolFees[side] - pool.fundFees[side];
  const reserveXnt = vaultOut.amount - pool.protocolFees[1 - side] - pool.fundFees[1 - side];
  if (reserveToken <= 0n || reserveXnt <= 0n) throw new Error("Pool has no liquidity");

  const mintState = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(mintState);
  if (!feeCfg) throw new Error("Mint has no transfer fee config");
  const { epoch } = await conn.getEpochInfo();
  return { pool, side, reserveToken, reserveXnt, tradeFeeRate, feeCfg, epoch: BigInt(epoch) };
}

export async function quoteSell(
  conn: Connection, programId: PublicKey, poolAddr: PublicKey, mint: PublicKey,
  wanted: bigint, opts: { maxImpactBps: number; slippageBps: number },
): Promise<SellQuote | null> {
  const { pool, side, reserveToken: reserveIn, reserveXnt: reserveOut, tradeFeeRate, feeCfg, epoch } =
    await snapshot(conn, programId, poolAddr, mint);
  const active = getEpochFee(feeCfg, epoch);

  const cap = maxInputForImpact(reserveIn, BigInt(opts.maxImpactBps), BigInt(active.transferFeeBasisPoints));
  const amountIn = wanted < cap ? wanted : cap;
  if (amountIn <= 0n) return null;
  const transferFee = calculateEpochFee(feeCfg, epoch, amountIn);
  const netIn = amountIn - transferFee;
  const expectedOut = cpmmOut(netIn, reserveIn, reserveOut, tradeFeeRate);
  if (expectedOut <= 0n) return null;
  return {
    pool, side, amountIn, transferFee, expectedOut,
    minimumOut: (expectedOut * BigInt(10_000 - opts.slippageBps)) / 10_000n,
    priceImpactBps: (netIn * 10_000n) / (reserveIn + netIn),
  };
}

export function tempXntAccount(owner: PublicKey, wxntProgram: PublicKey) {
  return PublicKey.createWithSeed(owner, TEMP_SEED, wxntProgram);
}

/** Sell `q.amountIn` tokens for native XNT, unwrapping into `owner`'s wallet. */
export async function buildSell(
  conn: Connection, programId: PublicKey, owner: Keypair, mint: PublicKey, q: SellQuote,
): Promise<TransactionInstruction[]> {
  const { pool, side } = q;
  const wxntProgram = pool.programs[1 - side];
  if (!wxntProgram.equals(TOKEN_PROGRAM_ID) && !wxntProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Unexpected wrapped XNT token program");
  }
  const temp = await tempXntAccount(owner.publicKey, wxntProgram);
  if (await conn.getAccountInfo(temp)) throw new Error(`Temporary XNT account ${temp.toBase58()} already exists; close it before retrying`);
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  const source = getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT.copy(data, 0);
  data.writeBigUInt64LE(q.amountIn, 8);
  data.writeBigUInt64LE(q.minimumOut, 16);
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey, newAccountPubkey: temp, basePubkey: owner.publicKey,
      seed: TEMP_SEED, lamports: rent, space: 165, programId: wxntProgram,
    }),
    createInitializeAccount3Instruction(temp, NATIVE_MINT, owner.publicKey, wxntProgram),
    new TransactionInstruction({
      programId,
      data,
      keys: [
        m(owner.publicKey, true, true),
        m(poolAuthority(programId), false, false),
        m(pool.ammConfig, false, false),
        m(pool.address, false, true),
        m(source, false, true),
        m(temp, false, true),
        m(pool.vaults[side], false, true),
        m(pool.vaults[1 - side], false, true),
        m(pool.programs[side], false, false),
        m(wxntProgram, false, false),
        m(mint, false, false),
        m(NATIVE_MINT, false, false),
        m(pool.observation, false, true),
      ],
    }),
    // Closing the temporary wrapped account unwraps proceeds + rent back to the wallet.
    createCloseAccountInstruction(temp, owner.publicKey, owner.publicKey, [], wxntProgram),
  ];
}

/** Token-2022 inverse fee: the fee on a transfer that must deliver `net` (mirrors calculate_inverse_epoch_fee). */
export function inverseTransferFee(net: bigint, bps: bigint, maxFee: bigint): bigint {
  if (bps === 0n || net === 0n) return 0n;
  let pre = net + maxFee;
  if (bps < 10_000n) {
    const raw = (net * 10_000n + (10_000n - bps) - 1n) / (10_000n - bps);
    if (raw - net < maxFee) pre = raw;
  }
  const fee = (pre * bps + 9_999n) / 10_000n;
  return fee < maxFee ? fee : maxFee;
}

/** Token and XNT the pool takes for `lp` LP tokens, rounded up as CP-swap does. */
export function depositAmounts(lp: bigint, reserveToken: bigint, reserveXnt: bigint, lpSupply: bigint) {
  const ceil = (a: bigint) => (a + lpSupply - 1n) / lpSupply;
  return { token: ceil(lp * reserveToken), xnt: ceil(lp * reserveXnt) };
}

/** Largest LP amount whose deposit, transfer fee included, fits within `tokens` and `xnt`. */
export function maxLpFor(
  tokens: bigint, xnt: bigint, reserveToken: bigint, reserveXnt: bigint, lpSupply: bigint,
  feeBps: bigint, maxFee: bigint,
): bigint {
  if (feeBps >= 10_000n || lpSupply <= 0n) return 0n;
  const netTokens = (tokens * (10_000n - feeBps)) / 10_000n;
  const byToken = (netTokens * lpSupply) / reserveToken;
  const byXnt = (xnt * lpSupply) / reserveXnt;
  let lp = byToken < byXnt ? byToken : byXnt;
  // The estimate can overshoot by a unit or two of rounding; step down until it fits.
  for (let i = 0; i < 64 && lp > 0n; i++) {
    const need = depositAmounts(lp, reserveToken, reserveXnt, lpSupply);
    if (need.token + inverseTransferFee(need.token, feeBps, maxFee) <= tokens && need.xnt <= xnt) return lp;
    lp -= lp / 1_000_000n + 1n;
  }
  return 0n;
}

/**
 * How many of `total` auto-LP tokens to keep (the rest is sold) so the deposit is
 * balanced: kept tokens, after the transfer fee, worth the same as `xnt` already set
 * aside plus what selling the rest brings in after the transfer and trade fees.
 * Price impact is ignored; any small remainder is rebalanced next cycle.
 * Solves K*f*p = X + (L-K)*p*f*(1-t) for K, clamped to [0, L].
 */
export function lpKeepForBalance(
  total: bigint, xnt: bigint, reserveToken: bigint, reserveXnt: bigint, feeBps: bigint, tradeFeeRate: bigint,
): bigint {
  if (total <= 0n || reserveToken <= 0n || reserveXnt <= 0n || feeBps >= 10_000n) return 0n;
  const f = 10_000n - feeBps;                    // x 1e4
  const keepSold = FEE_DENOM - tradeFeeRate;     // (1 - t) x 1e6
  const num = xnt * reserveToken * 10_000n * FEE_DENOM + total * reserveXnt * f * keepSold;
  const den = reserveXnt * f * (2n * FEE_DENOM - tradeFeeRate);
  const k = num / den;
  return k > total ? total : k;
}

export interface DepositQuote {
  pool: Pool;
  side: number;
  lp: bigint;           // LP tokens minted (and then burned)
  tokenIn: bigint;      // tokens leaving our account, transfer fee included
  xntIn: bigint;        // lamports of XNT
  maxTokens: bigint;    // slippage bounds passed to the program
  maxXnt: bigint;
}

/**
 * Quote a deposit of up to `tokens` + `xnt`. The LP amount is sized against
 * (1 - slippage) of each budget, and the full budgets are the program's maximums,
 * so the deposit still lands if the price moves by up to `slippageBps`.
 */
export async function quoteDeposit(
  conn: Connection, programId: PublicKey, poolAddr: PublicKey, mint: PublicKey,
  tokens: bigint, xnt: bigint, slippageBps: number,
): Promise<DepositQuote | null> {
  const { pool, side, reserveToken, reserveXnt, feeCfg, epoch } = await snapshot(conn, programId, poolAddr, mint);
  if (pool.depositsPaused) throw new Error("Pool deposits are paused");
  const fee = getEpochFee(feeCfg, epoch);
  const bps = BigInt(fee.transferFeeBasisPoints);
  const budget = (v: bigint) => (v * BigInt(10_000 - slippageBps)) / 10_000n;
  const lp = maxLpFor(budget(tokens), budget(xnt), reserveToken, reserveXnt, pool.lpSupply, bps, fee.maximumFee);
  if (lp <= 0n) return null;
  const need = depositAmounts(lp, reserveToken, reserveXnt, pool.lpSupply);
  return {
    pool, side, lp, tokenIn: need.token + inverseTransferFee(need.token, bps, fee.maximumFee), xntIn: need.xnt,
    maxTokens: tokens, maxXnt: xnt,
  };
}

/**
 * Deposit `q` from `owner`'s token account and a temporary wrapped-XNT account, then
 * burn the LP tokens received so the added liquidity is locked in the pool for good.
 * Unused XNT comes back to the wallet when the temporary account is closed.
 */
export async function buildDepositAndBurn(
  conn: Connection, programId: PublicKey, owner: Keypair, mint: PublicKey, q: DepositQuote,
): Promise<TransactionInstruction[]> {
  const { pool, side } = q;
  const wxntProgram = pool.programs[1 - side];
  if (!wxntProgram.equals(TOKEN_PROGRAM_ID) && !wxntProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error("Unexpected wrapped XNT token program");
  }
  const lpProgram = (await conn.getAccountInfo(pool.lpMint))?.owner;
  if (!lpProgram || !(lpProgram.equals(TOKEN_PROGRAM_ID) || lpProgram.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new Error("Unexpected LP mint owner");
  }
  const temp = await PublicKey.createWithSeed(owner.publicKey, LP_TEMP_SEED, wxntProgram);
  if (await conn.getAccountInfo(temp)) throw new Error(`Temporary XNT account ${temp.toBase58()} already exists; close it before retrying`);
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  const tokenAccount = getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const lpAccount = getAssociatedTokenAddressSync(pool.lpMint, owner.publicKey, false, lpProgram);
  const [account0, account1] = side === 0 ? [tokenAccount, temp] : [temp, tokenAccount];

  const data = Buffer.alloc(32);
  DEPOSIT.copy(data, 0);
  data.writeBigUInt64LE(q.lp, 8);
  data.writeBigUInt64LE(side === 0 ? q.maxTokens : q.maxXnt, 16);
  data.writeBigUInt64LE(side === 0 ? q.maxXnt : q.maxTokens, 24);
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey, newAccountPubkey: temp, basePubkey: owner.publicKey,
      seed: LP_TEMP_SEED, lamports: rent + Number(q.maxXnt), space: 165, programId: wxntProgram,
    }),
    createInitializeAccount3Instruction(temp, NATIVE_MINT, owner.publicKey, wxntProgram),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, lpAccount, owner.publicKey, pool.lpMint, lpProgram),
    new TransactionInstruction({
      programId,
      data,
      keys: [
        m(owner.publicKey, true, true),
        m(poolAuthority(programId), false, false),
        m(pool.address, false, true),
        m(lpAccount, false, true),
        m(account0, false, true),
        m(account1, false, true),
        m(pool.vaults[0], false, true),
        m(pool.vaults[1], false, true),
        m(TOKEN_PROGRAM_ID, false, false),
        m(TOKEN_2022_PROGRAM_ID, false, false),
        m(pool.mints[0], false, false),
        m(pool.mints[1], false, false),
        m(pool.lpMint, false, true),
      ],
    }),
    createBurnCheckedInstruction(lpAccount, pool.lpMint, owner.publicKey, q.lp, pool.lpDecimals, [], lpProgram),
    createCloseAccountInstruction(temp, owner.publicKey, owner.publicKey, [], wxntProgram),
  ];
}

/** Per-network constants for creating XDEX pools (verified against real pool-creation transactions). */
export const XDEX_CREATE: Record<"mainnet" | "testnet", { ammConfig: string; createPoolFee: string }> = {
  // 0.28% trade fee tier used by most mainnet pools; fee receiver seen in every mainnet Initialize.
  mainnet: { ammConfig: "2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c", createPoolFee: "SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1" },
  // 0.3% tier and fee receiver from the RFLT testnet pool's Initialize.
  testnet: { ammConfig: "3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY", createPoolFee: "DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS" },
};
const INITIALIZE = disc("global:initialize");

/** Addresses of the TOKEN/XNT pool XDEX creates for `mint` under `ammConfig` (PDAs verified on testnet). */
export function poolAddresses(programId: PublicKey, ammConfig: PublicKey, mint: PublicKey) {
  const [mint0, mint1] = Buffer.compare(NATIVE_MINT.toBuffer(), mint.toBuffer()) < 0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const pool = pda(Buffer.from("pool"), ammConfig.toBuffer(), mint0.toBuffer(), mint1.toBuffer());
  return {
    pool, mint0, mint1,
    lpMint: pda(Buffer.from("pool_lp_mint"), pool.toBuffer()),
    vault0: pda(Buffer.from("pool_vault"), pool.toBuffer(), mint0.toBuffer()),
    vault1: pda(Buffer.from("pool_vault"), pool.toBuffer(), mint1.toBuffer()),
    observation: pda(Buffer.from("observation"), pool.toBuffer()),
  };
}

/**
 * Create a TOKEN/XNT pool seeded with `tokenAmount` of a Token-2022 `mint` and
 * `xntAmount` lamports, both from `creator`. The XNT is wrapped into the creator's
 * wrapped-XNT account first. XDEX mints the LP tokens to the creator.
 */
export function buildCreatePool(
  programId: PublicKey, network: "mainnet" | "testnet", creator: PublicKey, mint: PublicKey,
  tokenAmount: bigint, xntAmount: bigint,
): { ixs: TransactionInstruction[]; pool: PublicKey; lpMint: PublicKey } {
  const net = XDEX_CREATE[network];
  const ammConfig = new PublicKey(net.ammConfig);
  const a = poolAddresses(programId, ammConfig, mint);
  const wxnt = getAssociatedTokenAddressSync(NATIVE_MINT, creator, false, TOKEN_PROGRAM_ID);
  const tokenAcc = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
  const tokenIs0 = a.mint0.equals(mint);
  const lpAcc = getAssociatedTokenAddressSync(a.lpMint, creator, false, TOKEN_PROGRAM_ID);

  const data = Buffer.alloc(32);
  INITIALIZE.copy(data, 0);
  data.writeBigUInt64LE(tokenIs0 ? tokenAmount : xntAmount, 8);
  data.writeBigUInt64LE(tokenIs0 ? xntAmount : tokenAmount, 16);
  data.writeBigUInt64LE(0n, 24); // open immediately
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const prog0 = tokenIs0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const prog1 = tokenIs0 ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  return {
    pool: a.pool, lpMint: a.lpMint,
    ixs: [
      createAssociatedTokenAccountIdempotentInstruction(creator, wxnt, creator, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: creator, toPubkey: wxnt, lamports: xntAmount }),
      createSyncNativeInstruction(wxnt, TOKEN_PROGRAM_ID),
      new TransactionInstruction({
        programId, data,
        keys: [
          m(creator, true, true), m(ammConfig, false, false), m(poolAuthority(programId), false, false),
          m(a.pool, false, true), m(a.mint0, false, false), m(a.mint1, false, false), m(a.lpMint, false, true),
          m(tokenIs0 ? tokenAcc : wxnt, false, true), m(tokenIs0 ? wxnt : tokenAcc, false, true), m(lpAcc, false, true),
          m(a.vault0, false, true), m(a.vault1, false, true), m(new PublicKey(net.createPoolFee), false, true),
          m(a.observation, false, true), m(TOKEN_PROGRAM_ID, false, false), m(prog0, false, false), m(prog1, false, false),
          m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false), m(SYSVAR_RENT_PUBKEY, false, false),
        ],
      }),
    ],
  };
}

export interface BuyQuote {
  pool: Pool;
  xntSide: number;          // index of wrapped XNT in pool.mints
  outMint: PublicKey;
  amountIn: bigint;         // lamports of XNT spent
  expectedOut: bigint;      // output token base units received (after any transfer fee)
  minimumOut: bigint;
  priceImpactBps: bigint;
}

/**
 * Quote buying `outMint` with up to `xntIn` lamports on an XNT/<token> pool, capped so
 * the price impact stays within `maxImpactBps`. Handles an output token with a
 * Token-2022 transfer fee (USDC.X has none).
 */
export async function quoteBuy(
  conn: Connection, programId: PublicKey, poolAddr: PublicKey, outMint: PublicKey, xntIn: bigint,
  slippageBps: number, maxImpactBps = 300,
): Promise<BuyQuote> {
  const [poolInfo] = await conn.getMultipleAccountsInfo([poolAddr]);
  const pool = decodePool(poolAddr, poolInfo, programId);
  const xntSide = pool.mints.findIndex((m) => m.equals(NATIVE_MINT));
  if (xntSide < 0 || !pool.mints[1 - xntSide].equals(outMint)) throw new Error("Pool is not an XNT pool for the reward token");
  const [cfgInfo, vIn, vOut, mintInfo] = await conn.getMultipleAccountsInfo(
    [pool.ammConfig, pool.vaults[xntSide], pool.vaults[1 - xntSide], outMint]);
  if (!cfgInfo || !cfgInfo.data.subarray(0, 8).equals(CONFIG_DISC)) throw new Error("Invalid XDEX fee config");
  const tradeFeeRate = cfgInfo.data.readBigUInt64LE(12);
  const reserveIn = unpackAccount(pool.vaults[xntSide], vIn, pool.programs[xntSide]).amount - pool.protocolFees[xntSide] - pool.fundFees[xntSide];
  const reserveOut = unpackAccount(pool.vaults[1 - xntSide], vOut, pool.programs[1 - xntSide]).amount - pool.protocolFees[1 - xntSide] - pool.fundFees[1 - xntSide];
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("Pool has no liquidity");
  const cap = maxInputForImpact(reserveIn, BigInt(maxImpactBps), 0n);
  const amountIn = xntIn < cap ? xntIn : cap;
  if (amountIn <= 0n) throw new Error("Pool too shallow to swap within the price-impact limit");
  let out = cpmmOut(amountIn, reserveIn, reserveOut, tradeFeeRate);
  const outProgram = pool.programs[1 - xntSide];
  if (outProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const feeCfg = getTransferFeeConfig(unpackMint(outMint, mintInfo, TOKEN_2022_PROGRAM_ID));
    if (feeCfg) out -= calculateEpochFee(feeCfg, BigInt((await conn.getEpochInfo()).epoch), out);
  }
  if (out <= 0n) throw new Error("Swap amount too small");
  return {
    pool, xntSide, outMint, amountIn, expectedOut: out,
    minimumOut: (out * BigInt(10_000 - slippageBps)) / 10_000n,
    priceImpactBps: (amountIn * 10_000n) / (reserveIn + amountIn),
  };
}

/** Buy `q.outMint` with XNT: wrap into a temporary account, swap into the owner's token account, close the temp. */
export async function buildBuy(conn: Connection, programId: PublicKey, owner: Keypair, q: BuyQuote): Promise<TransactionInstruction[]> {
  const { pool, xntSide } = q;
  const wxntProgram = pool.programs[xntSide];
  const outProgram = pool.programs[1 - xntSide];
  const temp = await PublicKey.createWithSeed(owner.publicKey, TEMP_SEED + "-buy", wxntProgram);
  if (await conn.getAccountInfo(temp)) throw new Error(`Temporary XNT account ${temp.toBase58()} already exists; close it before retrying`);
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  const out = getAssociatedTokenAddressSync(q.outMint, owner.publicKey, false, outProgram);
  const data = Buffer.alloc(24);
  SWAP_BASE_INPUT.copy(data, 0);
  data.writeBigUInt64LE(q.amountIn, 8);
  data.writeBigUInt64LE(q.minimumOut, 16);
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: owner.publicKey, newAccountPubkey: temp, basePubkey: owner.publicKey,
      seed: TEMP_SEED + "-buy", lamports: rent + Number(q.amountIn), space: 165, programId: wxntProgram,
    }),
    createInitializeAccount3Instruction(temp, NATIVE_MINT, owner.publicKey, wxntProgram),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, out, owner.publicKey, q.outMint, outProgram),
    new TransactionInstruction({
      programId, data,
      keys: [
        m(owner.publicKey, true, true), m(poolAuthority(programId), false, false), m(pool.ammConfig, false, false),
        m(pool.address, false, true), m(temp, false, true), m(out, false, true),
        m(pool.vaults[xntSide], false, true), m(pool.vaults[1 - xntSide], false, true),
        m(wxntProgram, false, false), m(outProgram, false, false), m(NATIVE_MINT, false, false), m(q.outMint, false, false),
        m(pool.observation, false, true),
      ],
    }),
    createCloseAccountInstruction(temp, owner.publicKey, owner.publicKey, [], wxntProgram),
  ];
}
