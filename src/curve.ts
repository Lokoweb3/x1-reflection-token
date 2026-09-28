/**
 * Client for the `bonding_curve` program (docs/bonding-curve-spec.md is the contract):
 * constants, PDAs, account decoders, the curve maths mirrored exactly (bigint, same
 * rounding as the program: always in the curve's favour), instruction builders in the
 * spec's account order, and a parser for the program's events in transaction logs.
 *
 * Nothing here signs or sends.
 */
import crypto from "node:crypto";
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { XDEX_CREATE, poolAddresses, poolAuthority } from "./xdex.js";
import { XDEX_PROGRAM_IDS } from "./config.js";
import { lockPda, vaultPda } from "./locker.js";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);

// ---------- constants (mirror the Rust `pub const`s) ----------
export const LOCKER_PROGRAM_ID = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
export const FEE_RECEIVER = new PublicKey("53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy");
export const FEE_BPS = 100n;
export const CURVE_BPS = 8000n;
export const TARGET_XNT = 20_000_000_000n;
export const GRADUATION_DEPOSIT = 300_000_000n;
export const GRADUATE_REWARD = 10_000_000n;
export const SNIPE_WINDOW_SECS = 120;
export const SNIPE_MAX_BPS = 100n;
export const DECIMALS = 9;
export const SUPPLY_MIN = 1_000n;
export const SUPPLY_MAX = 10_000_000_000n;
const BPS = 10_000n;
const U64_MAX = 2n ** 64n - 1n;
const ONE = 10n ** BigInt(DECIMALS);

export const CurveStatus = { Trading: 0, Complete: 1, PoolCreated: 2, Graduated: 3, Finished: 4 } as const;
export const STATUS_NAMES = ["trading", "complete", "pool-created", "graduated", "finished"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

export const xdexIds = (network: "mainnet" | "testnet") => ({
  program: new PublicKey(XDEX_PROGRAM_IDS[network]),
  ammConfig: new PublicKey(XDEX_CREATE[network].ammConfig),
  createPoolFee: new PublicKey(XDEX_CREATE[network].createPoolFee),
});

// ---------- discriminators ----------
export const IX = {
  createCurve: disc("global:create_curve"),
  buy: disc("global:buy"),
  sell: disc("global:sell"),
  graduatePool: disc("global:graduate_pool"),
  graduateLock: disc("global:graduate_lock"),
  deliver: disc("global:deliver"),
};
export const CURVE_DISC = disc("account:Curve");
export const POSITION_DISC = disc("account:Position");
export const EVENT = {
  CurveCreated: disc("event:CurveCreated"),
  Trade: disc("event:Trade"),
  Graduated: disc("event:Graduated"),
  Delivered: disc("event:Delivered"),
};

// ---------- PDAs ----------
const pda = (programId: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const curvePda = (programId: PublicKey, mint: PublicKey) => pda(programId, Buffer.from("curve"), mint.toBuffer());
export const authPda = (programId: PublicKey, mint: PublicKey) => pda(programId, Buffer.from("auth"), mint.toBuffer());
export const positionPda = (programId: PublicKey, curve: PublicKey, owner: PublicKey) =>
  pda(programId, Buffer.from("pos"), curve.toBuffer(), owner.toBuffer());
export const nftMintPda = (programId: PublicKey, curve: PublicKey) => pda(programId, Buffer.from("nft"), curve.toBuffer());

// ---------- accounts ----------
export interface Curve {
  address: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  supply: bigint;
  curveTokens: bigint;
  poolTokensGross: bigint;
  poolTokensNet: bigint;
  targetXnt: bigint;
  virtualXnt: bigint;
  virtualTokens: bigint;
  tokensSold: bigint;
  raisedXnt: bigint;
  createdAt: number;
  status: number;
  positions: number;
  delivered: bigint;
  pool: PublicKey;
  lockNft: PublicKey;
  taxBps: number;
  bump: number;
  authBump: number;
}
/** Bytes the fields take (Anchor may allocate more; the rest is ignored). */
export const CURVE_LEN = 8 + 32 * 2 + 8 * 9 + 8 + 1 + 4 + 8 + 32 * 2 + 2 + 1 + 1;

export function decodeCurve(address: PublicKey, d: Buffer): Curve {
  if (d.length < CURVE_LEN || !d.subarray(0, 8).equals(CURVE_DISC)) throw new Error("Not a curve account");
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)); o += 32; return k; };
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const mint = key(), creator = key();
  const supply = u64(), curveTokens = u64(), poolTokensGross = u64(), poolTokensNet = u64(), targetXnt = u64();
  const virtualXnt = u64(), virtualTokens = u64(), tokensSold = u64(), raisedXnt = u64();
  const createdAt = Number(d.readBigInt64LE(o)); o += 8;
  const status = d[o]; o += 1;
  const positions = d.readUInt32LE(o); o += 4;
  const delivered = u64();
  const pool = key(), lockNft = key();
  const taxBps = d.readUInt16LE(o); o += 2;
  const bump = d[o], authBump = d[o + 1];
  return { address, mint, creator, supply, curveTokens, poolTokensGross, poolTokensNet, targetXnt, virtualXnt, virtualTokens,
    tokensSold, raisedXnt, createdAt, status, positions, delivered, pool, lockNft, taxBps, bump, authBump };
}

export interface Position { address: PublicKey; curve: PublicKey; owner: PublicKey; balance: bigint; deposit: bigint; bump: number }
export const POSITION_LEN = 8 + 32 + 32 + 8 + 8 + 1;
export function decodePosition(address: PublicKey, d: Buffer): Position {
  if (d.length < POSITION_LEN || !d.subarray(0, 8).equals(POSITION_DISC)) throw new Error("Not a position account");
  return {
    address, curve: new PublicKey(d.subarray(8, 40)), owner: new PublicKey(d.subarray(40, 72)),
    balance: d.readBigUInt64LE(72), deposit: d.readBigUInt64LE(80), bump: d[88],
  };
}

// ---------- maths (u128 in the program; bigint here) ----------
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Token-2022 epoch fee on `amount`: min(ceil(amount * bps / 10000), maxFee). */
export function transferFee(amount: bigint, taxBps: bigint | number, maxFee = U64_MAX) {
  const bps = BigInt(taxBps);
  if (bps === 0n || amount === 0n) return 0n;
  const fee = ceilDiv(amount * bps, BPS);
  return fee > maxFee ? maxFee : fee;
}

/** create_curve's setup from the supply (whole tokens) and the mint's tax. */
export function curveSetup(supplyWhole: bigint, taxBps: number, maxFee = U64_MAX, target = TARGET_XNT) {
  const S = supplyWhole * ONE;
  const T = (S * CURVE_BPS) / BPS;
  const Pg = S - T;
  const Pn = Pg - transferFee(Pg, taxBps, maxFee);
  const a = (Pn * T) / (T - Pn);
  const y0 = a + T;
  const x0 = (target * (a - Pn)) / Pn;
  return { S, T, Pg, Pn, a, x0, y0 };
}

/** The part of a curve's state the maths needs (a decoded Curve has all of it). */
export type CurveState = Pick<Curve, "supply" | "curveTokens" | "virtualXnt" | "virtualTokens" | "tokensSold" | "raisedXnt" | "createdAt">;

/** x0 and y0 from the identities in the spec (nothing extra is stored). */
export const x0Of = (c: CurveState) => c.virtualXnt - c.raisedXnt;
export const y0Of = (c: CurveState) => c.virtualTokens + c.tokensSold;
export const k0Of = (c: CurveState) => x0Of(c) * y0Of(c);

export interface BuyQuote {
  xntIn: bigint;   // what the buyer actually pays (less than asked on the last buy)
  fee: bigint;
  net: bigint;     // what goes into the curve
  out: bigint;     // tokens credited to the position
  complete: boolean;
  /** Set when the buy would fail on-chain (the program checks the same things). */
  error?: "zero" | "too-big-early";
  maxEarly: bigint;
}

/** The program's buy maths. `now` (unix seconds) decides the anti-sniping cap. */
export function quoteBuy(c: CurveState, xntIn: bigint, now: number): BuyQuote {
  const k0 = k0Of(c);
  const x = c.virtualXnt, y = c.virtualTokens;
  let fee = ceilDiv(xntIn * FEE_BPS, BPS);
  let net = xntIn - fee;
  let out = y - ceilDiv(k0, x + net);
  let complete = false;
  if (c.tokensSold + out >= c.curveTokens) {
    out = c.curveTokens - c.tokensSold;
    net = ceilDiv(k0, y - out) - x;
    xntIn = ceilDiv(net * BPS, BPS - FEE_BPS);
    fee = xntIn - net;
    complete = true;
  }
  const maxEarly = (c.supply * SNIPE_MAX_BPS) / BPS;
  const q: BuyQuote = { xntIn, fee, net, out, complete, maxEarly };
  if (out <= 0n) q.error = "zero";
  else if (now < c.createdAt + SNIPE_WINDOW_SECS && out > maxEarly) q.error = "too-big-early";
  return q;
}

/** Apply a buy to the state, as the program does. */
export function applyBuy<T extends CurveState>(c: T, q: BuyQuote): T {
  return { ...c, virtualXnt: c.virtualXnt + q.net, virtualTokens: c.virtualTokens - q.out, tokensSold: c.tokensSold + q.out, raisedXnt: c.raisedXnt + q.net };
}

export interface SellQuote { tokensIn: bigint; gross: bigint; fee: bigint; out: bigint; x1: bigint }
export function quoteSell(c: CurveState, tokensIn: bigint): SellQuote {
  const k0 = k0Of(c);
  const x1 = ceilDiv(k0, c.virtualTokens + tokensIn);
  const gross = c.virtualXnt - x1;
  const fee = ceilDiv(gross * FEE_BPS, BPS);
  return { tokensIn, gross, fee, out: gross - fee, x1 };
}
export function applySell<T extends CurveState>(c: T, q: SellQuote): T {
  return { ...c, virtualXnt: q.x1, virtualTokens: c.virtualTokens + q.tokensIn, tokensSold: c.tokensSold - q.tokensIn, raisedXnt: c.raisedXnt - q.gross };
}

/** Spot price, XNT per whole token (both sides have 9 decimals). */
export const priceOf = (c: Pick<CurveState, "virtualXnt" | "virtualTokens">) => Number(c.virtualXnt) / Number(c.virtualTokens);
/** Market cap in lamports: the whole supply at the spot price. */
export const marketCapOf = (c: Pick<CurveState, "virtualXnt" | "virtualTokens" | "supply">) =>
  c.virtualTokens > 0n ? (c.supply * c.virtualXnt) / c.virtualTokens : 0n;
/** Share of the curve's tokens sold, 0..1. */
export const progressOf = (c: Pick<CurveState, "tokensSold" | "curveTokens">) =>
  c.curveTokens > 0n ? Number((c.tokensSold * 1_000_000n) / c.curveTokens) / 1_000_000 : 0;
/** The XDEX pool's opening price (XNT per whole token): TARGET into the pool against the net tokens. */
export const poolOpenPrice = (c: Pick<Curve, "targetXnt" | "poolTokensNet">) => Number(c.targetXnt) / Number(c.poolTokensNet);

// ---------- instructions ----------
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const u64s = (d: Buffer, ...vals: bigint[]) => {
  const b = Buffer.alloc(8 + 8 * vals.length);
  d.copy(b, 0);
  vals.forEach((v, i) => b.writeBigUInt64LE(v, 8 + 8 * i));
  return b;
};

export function createCurveIx(programId: PublicKey, creator: PublicKey, mint: PublicKey, supplyWhole: bigint) {
  return new TransactionInstruction({
    programId, data: u64s(IX.createCurve, supplyWhole),
    keys: [m(creator, true, true), m(mint, false, true), m(curvePda(programId, mint), false, true), m(authPda(programId, mint), false, true),
      m(SystemProgram.programId, false, false)],
  });
}

export function buyIx(programId: PublicKey, buyer: PublicKey, mint: PublicKey, xntIn: bigint, minTokensOut: bigint) {
  const curve = curvePda(programId, mint);
  return new TransactionInstruction({
    programId, data: u64s(IX.buy, xntIn, minTokensOut),
    keys: [m(buyer, true, true), m(curve, false, true), m(authPda(programId, mint), false, true),
      m(positionPda(programId, curve, buyer), false, true), m(FEE_RECEIVER, false, true), m(SystemProgram.programId, false, false)],
  });
}

export function sellIx(programId: PublicKey, seller: PublicKey, mint: PublicKey, tokensIn: bigint, minXntOut: bigint) {
  const curve = curvePda(programId, mint);
  return new TransactionInstruction({
    programId, data: u64s(IX.sell, tokensIn, minXntOut),
    keys: [m(seller, true, true), m(curve, false, true), m(authPda(programId, mint), false, true),
      m(positionPda(programId, curve, seller), false, true), m(FEE_RECEIVER, false, true), m(SystemProgram.programId, false, false)],
  });
}

export function graduatePoolIx(programId: PublicKey, network: "mainnet" | "testnet", caller: PublicKey, mint: PublicKey) {
  const x = xdexIds(network);
  const curve = curvePda(programId, mint), auth = authPda(programId, mint);
  const a = poolAddresses(x.program, x.ammConfig, mint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.graduatePool),
    keys: [
      m(caller, true, true), m(curve, false, true), m(auth, false, true), m(mint, false, true),
      m(getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID), false, true),
      m(getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID), false, true),
      m(getAssociatedTokenAddressSync(a.lpMint, auth, true, TOKEN_PROGRAM_ID), false, true),
      m(x.program, false, false), m(x.ammConfig, false, false), m(poolAuthority(x.program), false, false),
      m(a.pool, false, true), m(a.lpMint, false, true), m(a.vault0, false, true), m(a.vault1, false, true),
      m(x.createPoolFee, false, true), m(a.observation, false, true), m(NATIVE_MINT, false, false),
      m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      m(SystemProgram.programId, false, false), m(SYSVAR_RENT_PUBKEY, false, false),
    ],
  });
}

export function graduateLockIx(programId: PublicKey, network: "mainnet" | "testnet", caller: PublicKey, mint: PublicKey, creator: PublicKey) {
  const x = xdexIds(network);
  const curve = curvePda(programId, mint), auth = authPda(programId, mint);
  const a = poolAddresses(x.program, x.ammConfig, mint);
  const nft = nftMintPda(programId, curve);
  const lock = lockPda(LOCKER_PROGRAM_ID, nft);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.graduateLock),
    keys: [
      m(caller, true, true), m(curve, false, true), m(auth, false, true), m(creator, false, true), m(nft, false, true),
      m(getAssociatedTokenAddressSync(nft, auth, true, TOKEN_2022_PROGRAM_ID), false, true),
      m(getAssociatedTokenAddressSync(nft, creator, true, TOKEN_2022_PROGRAM_ID), false, true),
      m(a.pool, false, false), m(a.vault0, false, false), m(a.vault1, false, false), m(a.lpMint, false, false),
      m(getAssociatedTokenAddressSync(a.lpMint, auth, true, TOKEN_PROGRAM_ID), false, true),
      m(lock, false, true), m(vaultPda(LOCKER_PROGRAM_ID, lock), false, true),
      m(LOCKER_PROGRAM_ID, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
      m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
    ],
  });
}

export function deliverIx(programId: PublicKey, payer: PublicKey, mint: PublicKey, owner: PublicKey, creator: PublicKey) {
  const curve = curvePda(programId, mint);
  return new TransactionInstruction({
    programId, data: Buffer.from(IX.deliver),
    keys: [
      m(payer, true, true), m(curve, false, true), m(authPda(programId, mint), false, true),
      m(positionPda(programId, curve, owner), false, true), m(owner, false, true),
      m(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID), false, true),
      m(mint, false, true), m(creator, false, true),
      m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
    ],
  });
}

// ---------- events ----------
export type CurveEvent =
  | { name: "CurveCreated"; curve: string; mint: string; creator: string; supply: bigint; x0: bigint; y0: bigint; createdAt: number }
  | { name: "Trade"; curve: string; trader: string; isBuy: boolean; xnt: bigint; fee: bigint; tokens: bigint; virtualXnt: bigint;
      virtualTokens: bigint; tokensSold: bigint; raisedXnt: bigint; ts: number }
  | { name: "Graduated"; curve: string; mint: string; pool: string; lockNft: string; raisedXnt: bigint }
  | { name: "Delivered"; curve: string; owner: string; tokens: bigint };

/** Decode one event's bytes (discriminator first); null for anything else. */
export function decodeEvent(d: Buffer): CurveEvent | null {
  if (d.length < 8) return null;
  const tag = d.subarray(0, 8);
  let o = 8;
  const key = () => { const k = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32; return k; };
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const i64 = () => { const v = Number(d.readBigInt64LE(o)); o += 8; return v; };
  try {
    if (tag.equals(EVENT.CurveCreated)) {
      return { name: "CurveCreated", curve: key(), mint: key(), creator: key(), supply: u64(), x0: u64(), y0: u64(), createdAt: i64() };
    }
    if (tag.equals(EVENT.Trade)) {
      const curve = key(), trader = key();
      const isBuy = d[o] === 1; o += 1;
      return { name: "Trade", curve, trader, isBuy, xnt: u64(), fee: u64(), tokens: u64(), virtualXnt: u64(), virtualTokens: u64(),
        tokensSold: u64(), raisedXnt: u64(), ts: i64() };
    }
    if (tag.equals(EVENT.Graduated)) return { name: "Graduated", curve: key(), mint: key(), pool: key(), lockNft: key(), raisedXnt: u64() };
    if (tag.equals(EVENT.Delivered)) return { name: "Delivered", curve: key(), owner: key(), tokens: u64() };
  } catch { /* truncated: not ours */ }
  return null;
}

/** Every curve event in a transaction's logs ("Program data: <base64>" lines from emit!). */
export function parseEvents(logs: readonly string[]): CurveEvent[] {
  const out: CurveEvent[] = [];
  for (const l of logs) {
    const mm = /^Program data: (.+)$/.exec(l);
    if (!mm) continue;
    const e = decodeEvent(Buffer.from(mm[1], "base64"));
    if (e) out.push(e);
  }
  return out;
}
