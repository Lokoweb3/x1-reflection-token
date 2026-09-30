/**
 * Token factory launch: a creator's wallet signs three transactions, built here.
 *
 *   1. token   create the Token-2022 mint (tax fixed forever, withdraw authority = the
 *              token's own distributor wallet), mint the supply to the creator, revoke
 *              the mint authority, pay the launch fee in USDC and pre-fund the
 *              distributor's gas
 *   2. pool    create the TOKEN/XNT pool on XDEX with the creator's tokens and XNT (or,
 *              when the creator picks another allowed pair such as JACK, the TOKEN/JACK
 *              pool with their JACK; XDEX's pool fee is still paid in XNT)
 *   3. lock    lock all the creator's LP in an lp_locker NFT (forever or until a date)
 *
 * Each launch is recorded under factory/launches/<mint>/. The distributor keypair is
 * generated here and never leaves the server; once all three steps are verified
 * on-chain the launch is registered and the factory distributor starts serving it.
 *
 * Tax Vault launches (testnet, XNT pair, factory.taxVault with a publisher key): the
 * withdraw authority is the vault program's `auth` PDA for the new mint instead of a
 * distributor wallet, so there is no distributor key and no gas to pre-fund. After the lock
 * the creator signs one more transaction, init_vault (step 4, "Start the tax vault");
 * registration checks the vault and the server's vault crank serves the token.
 *
 * Curve launches on such a site are vault launches too: the mint's withdraw authority is
 * the vault's auth PDA from the start (the curve program doesn't check it). The curve
 * crank registers the token at graduation; the creator then starts the vault with the same
 * init_vault transaction (their lock NFT only exists after graduation). Until then the tax
 * stays withheld in the holders' token accounts, where nobody can move it.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMintLen,
  getTokenMetadata, getTransferFeeConfig, unpackMint,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { Config, FACTORY_DIR, ROOT, fromBaseUnits, loadKeypair, toBaseUnits } from "../config.js";
import { decodeVault, initVaultIx, validSplit, vaultAuthPda, vaultPda } from "../taxvault.js";
import { buildCreatePool, poolAddresses, XDEX_CREATE } from "../xdex.js";
import { ipfsEnabled, pinMetadata } from "./ipfs.js";
import { buildLock } from "../locker-tx.js";
import { listLocks } from "../locker.js";
import {
  CurveStatus, LOCKER_PROGRAM_ID, SUPPLY_MAX as CURVE_SUPPLY_MAX, authPda, createCurveIx, curvePda, curveSetup, decodeCurve, parseTarget,
} from "../curve.js";

const U64_MAX = 2n ** 64n - 1n;
export const DECIMALS = 9;
/** Every factory token pays its creator this share of the tax (vests 7 days, claimed with the lock NFT). */
export const CREATOR_BPS = 1000;
/** Liquidity + burn cap: with the creator's share, holders always get at least 35% of the tax. */
export const MAX_LP_PLUS_BURN_BPS = 6500 - CREATOR_BPS;
/** Creator rewards are paid in USDC.X on mainnet (swapped on this XNT/USDC.X pool) and in XNT on testnet. */
export const CREATOR_REWARD: Record<"mainnet" | "testnet", { rewardMint?: string; swapPool?: string }> = {
  mainnet: { rewardMint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", swapPool: "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR" },
  testnet: {},
};

/** USDC used for the launch fee (mainnet: USDC.X; testnet: the USDC with an XDEX testnet pool). */
export const FEE_USDC: Record<"mainnet" | "testnet", string> = {
  mainnet: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
  testnet: "4dr9zMDzp4TY3ikZmsqF2ikSkmtWiCwWYJ9xJx1h2KsU",
};

/**
 * The launch fee. Mainnet always charges factory.feeUsdc in USDC (USDC.X). factory.feeToken
 * (e.g. XNM) is a testnet-only override and is ignored on mainnet, so switching the
 * network can't leave the site charging a testnet token.
 */
export function launchFee(cfg: Config) {
  const f = cfg.factory!;
  if (cfg.network === "testnet" && f.feeToken) return f.feeToken;
  return { mint: FEE_USDC[cfg.network], symbol: "USDC", amount: f.feeUsdc };
}

/**
 * A token's metadata JSON, in the shape X1's own tokens use: name, symbol, description,
 * image, showName, createdOn (this site) and any social links the creator gave.
 */
export function tokenMetadataJson(p: Pick<LaunchParams, "name" | "symbol" | "description" | "image" | "website" | "twitter" | "telegram">, publicUrl: string) {
  const out: Record<string, string | boolean> = { name: p.name, symbol: p.symbol };
  if (p.description) out.description = p.description;
  if (p.image) out.image = p.image;
  out.showName = true;
  // Credit the site, but only once it has a public address (a local one means nothing to others).
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(publicUrl)) out.createdOn = publicUrl.replace(/\/$/, "");
  if (p.twitter) out.twitter = p.twitter;
  if (p.telegram) out.telegram = p.telegram;
  if (p.website) out.website = p.website;
  return out;
}

/** Smallest balance that earns payouts: one millionth of the supply (RFLT: 1,000 of 1B). */
export const minHoldingFor = (supply: string) => fromBaseUnits(toBaseUnits(supply, DECIMALS) / 1_000_000n, DECIMALS);

export interface LaunchParams {
  creator: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  /** Optional links shown by wallets and screeners (X1 metadata fields). */
  website?: string;
  twitter?: string;
  telegram?: string;
  supply: string;        // whole tokens
  taxBps: number;        // 100..1000 (1–10%)
  autoLpBps: number;     // 0..5000 share of the tax that goes to auto-LP
  burnBps: number;       // 0..5000 share of the tax that is burned (auto-LP + burn <= 65%)
  poolTokens: string;    // whole tokens seeded into the pool; always the whole supply
  /**
   * Amount of the pair token seeded into the pool: XNT, or e.g. JACK for a JACK pair. The
   * name stays poolXnt so existing launch records keep working.
   */
  poolXnt: string;
  lockDays: number | null; // null = forever
  /** Pair token symbol: "XNT" (default) or one of factory.quoteTokens. */
  quote?: string;
}

/** A launch's pair token: XNT, or an entry of factory.quoteTokens (JACK). */
export interface Pair { symbol: string; mint: PublicKey; xntPool: PublicKey | null }
export const XNT_PAIR: Pair = { symbol: "XNT", mint: NATIVE_MINT, xntPool: null };

/** The pair token a launch (or launch request) uses; records without `quote` are XNT. */
export function pairOf(cfg: Config, r: { quote?: string; quoteMint?: string; quoteXntPool?: string }): Pair {
  if (!r.quote || r.quote === "XNT") return XNT_PAIR;
  // A recorded launch keeps its own pair even if the allowlist changes later.
  if (r.quoteMint && r.quoteXntPool) return { symbol: r.quote, mint: new PublicKey(r.quoteMint), xntPool: new PublicKey(r.quoteXntPool) };
  const q = (cfg.factory?.quoteTokens ?? []).find((t) => t.symbol === r.quote);
  if (!q) throw new Error(`${r.quote} isn't a pair offered on this site`);
  return { symbol: q.symbol, mint: new PublicKey(q.mint), xntPool: new PublicKey(q.xntPool) };
}

export interface LaunchRecord extends LaunchParams {
  /** Pair token (non-XNT pairs only): its mint and its XNT pool, fixed at launch. */
  quoteMint?: string;
  quoteXntPool?: string;
  mint: string;
  distributor: string;
  pool: string;
  /** The creator's launch lock NFT: the key for claiming creator rewards. */
  lockNft?: string;
  createdAt: string;
  registeredAt?: string;
  /** "curve": sold on the bonding curve first; the program creates the pool and lock at graduation. */
  kind?: "curve";
  /** The curve account (curve launches). */
  curve?: string;
  /**
   * The tax is held by the Tax Vault program (withdraw authority = its auth PDA). For a new
   * vault launch `distributor` is that auth PDA; a migrated token keeps its old distributor.
   */
  taxVault?: boolean;
}

/** New XNT-paired launches use the Tax Vault: testnet only, and only with a program and a publisher key to create the vault. */
export function vaultLaunches(cfg: Config) {
  const tv = cfg.factory?.taxVault;
  return cfg.network === "testnet" && !!tv?.programId && !!tv.publisherKeypair;
}
/** Whether a launch with this pair would be a vault launch. */
export const isVaultLaunch = (cfg: Config, pair: Pair) => vaultLaunches(cfg) && !pair.xntPool;

/** Whether the vault program handles this launch's tax: its record or its per-launch config says so. */
export function vaultManaged(r: Pick<LaunchRecord, "mint" | "taxVault">) {
  if (r.taxVault) return true;
  const f = path.join(launchDir(new PublicKey(r.mint).toBase58()), "config.json");
  try { return fs.existsSync(f) && (JSON.parse(fs.readFileSync(f, "utf8")) as Config).taxVault === true; } catch { return false; }
}

/**
 * A creator who keeps part of the supply (puts less than 100% into the pool) doesn't
 * also earn holder rewards: their wallet is excluded from that token's payouts.
 */
export const creatorExcluded = (r: Pick<LaunchParams, "poolTokens" | "supply"> & { kind?: string }) =>
  // A curve's creator can't buy on it and gets no tokens, so there's no bag to exclude.
  r.kind === "curve" ? false : BigInt(r.poolTokens) < BigInt(r.supply);

/**
 * Validate and normalise untrusted launch input. `quoteSymbols` are the pair tokens the
 * site offers besides XNT (factory.quoteTokens); anything else is refused.
 */
export function validateParams(raw: Record<string, unknown>, quoteSymbols: string[] = []): LaunchParams {
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
  // Token logos must be PNG, JPG, WebP or GIF: many wallets won't show SVG (it can carry scripts).
  if (image && /\.svgz?(?:[?#].*)?$/i.test(image)) throw new Error("The logo can't be an SVG; use a PNG, JPG, WebP or GIF.");
  // Optional social links, same fields X1's own token metadata uses.
  const link = (k: string, host: RegExp | null, label: string) => {
    const v = String(raw[k] ?? "").trim();
    if (!v) return undefined;
    let u: URL;
    try { u = new URL(v); } catch { throw new Error(`${label} must be a full https:// link`); }
    if (u.protocol !== "https:" || v.length > 200 || /["'<>\s]/.test(v)) throw new Error(`${label} must be a full https:// link`);
    if (host && !host.test(u.hostname)) throw new Error(`${label} must be a ${label === "X" ? "x.com or twitter.com" : "t.me"} link`);
    return u.toString();
  };
  const website = link("website", null, "Website");
  const twitter = link("twitter", /^(www\.)?(x|twitter)\.com$/i, "X");
  const telegram = link("telegram", /^(www\.)?(t\.me|telegram\.me)$/i, "Telegram");
  const whole = (k: string, min: bigint, max: bigint) => {
    const v = String(raw[k] ?? "").trim();
    if (!/^\d+$/.test(v) || BigInt(v) < min || BigInt(v) > max) {
      throw new Error(`${k === "supply" ? "Supply" : `Invalid ${k}:`} must be a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`);
    }
    return v;
  };
  const supply = whole("supply", 1_000n, 1_000_000_000_000n);
  // The whole supply always goes into the pool: creators start with no tokens.
  const poolTokens = whole("poolTokens", 1n, BigInt(supply));
  if (poolTokens !== supply) throw new Error("The whole supply must go into the pool (100%)");
  const quote = String(raw.quote ?? "XNT").trim() || "XNT";
  if (quote !== "XNT" && !quoteSymbols.includes(quote)) throw new Error(`${quote.slice(0, 20)} isn't a pair offered on this site`);
  const poolXnt = String(raw.poolXnt ?? "").trim();
  if (quote === "XNT") {
    if (!/^\d+(\.\d{1,9})?$/.test(poolXnt) || !(Number(poolXnt) >= 0.01)) throw new Error("Pool XNT must be at least 0.01");
  } else if (!/^\d+(\.\d{1,9})?$/.test(poolXnt) || !(Number(poolXnt) > 0)) {
    // Its XNT value is checked by the server (at least 0.01 XNT at the pair's price).
    throw new Error(`Pool ${quote} must be a positive amount (up to 9 decimals)`);
  }
  const int = (k: string, min: number, max: number) => {
    const v = Number(raw[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid ${k}`);
    return v;
  };
  const taxBps = int("taxBps", 100, 1000);
  const autoLpBps = int("autoLpBps", 0, 5000);
  const burnBps = raw.burnBps === undefined ? 0 : int("burnBps", 0, 5000);
  // Holders always keep at least 35% of the tax.
  if (autoLpBps + burnBps > MAX_LP_PLUS_BURN_BPS) {
    throw new Error("Liquidity + burn can't exceed 55% of the tax (10% goes to the creator; holders keep at least 35%)");
  }
  const lockDays = raw.lockDays === null || raw.lockDays === "forever" ? null : int("lockDays", 1, 3650);
  return { creator, name, symbol, description, image, website, twitter, telegram, supply, taxBps, autoLpBps, burnBps, poolTokens, poolXnt, lockDays, quote };
}

const launchDir = (mint: string) => path.join(FACTORY_DIR, "launches", mint);
export const readLaunch = (mint: string): LaunchRecord | null => {
  const f = path.join(launchDir(new PublicKey(mint).toBase58()), "launch.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
/**
 * Change a launched token's logo, description and social links: pin new metadata to IPFS
 * and build the instruction that points the token's on-chain link at it. The creator
 * (the token's metadata update authority) signs. The launch record is only changed after
 * that transaction confirms (applyMetadataUpdate), so nobody else can edit it.
 */
export async function buildMetadataUpdate(conn: Connection, cfg: Config, r: LaunchRecord, raw: Record<string, unknown>, publicUrl: string) {
  if (!ipfsEnabled(cfg)) throw new Error("Metadata updates need IPFS uploads set up on this site.");
  // poolTokens: a curve launch records the pool's share, but the shared checks want the whole supply.
  const p = validateParams({ ...r, poolTokens: r.supply, image: raw.image, description: raw.description, website: raw.website, twitter: raw.twitter, telegram: raw.telegram },
    r.quote ? [r.quote] : []);
  const next = { image: p.image, description: p.description, website: p.website, twitter: p.twitter, telegram: p.telegram };
  const mint = new PublicKey(r.mint);
  const creator = new PublicKey(r.creator);
  const [info, current] = await Promise.all([
    conn.getAccountInfo(mint, "confirmed"),
    getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID),
  ]);
  if (!info || !current) throw new Error("Token not found on-chain.");
  if (!current.updateAuthority?.equals(creator)) throw new Error("Only the token's metadata authority can update it.");
  const uri = await pinMetadata(cfg, tokenMetadataJson({ ...r, ...next }, publicUrl), `${r.symbol} ${r.mint} update`);
  const ixs: TransactionInstruction[] = [];
  const newLen = info.data.length + Buffer.byteLength(uri) - Buffer.byteLength(current.uri);
  const need = BigInt(await conn.getMinimumBalanceForRentExemption(newLen)) - BigInt(info.lamports);
  if (need > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: creator, toPubkey: mint, lamports: need }));
  ixs.push(createUpdateFieldInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, field: "uri", value: uri }));
  return { ixs, uri, next };
}
export function applyMetadataUpdate(r: LaunchRecord, next: Partial<LaunchRecord>) {
  writeLaunch({ ...r, ...next });
}

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

/**
 * The Token-2022 mint every launch starts with (tax fixed forever, withdraw authority =
 * the token's own distributor wallet, metadata pinned to IPFS or served by the site),
 * plus the launch fee and the distributor's gas. The creator is the mint authority at
 * first (Token-2022 needs the mint authority to sign the metadata); `mintAuthority`
 * says what happens to it next:
 *   null       mint the whole supply to the creator, then revoke minting (normal launch)
 *   a PDA      mint nothing and hand minting to that address (a bonding curve's auth PDA,
 *              which depends on the new mint's address, hence a function of it)
 */
async function buildMintSetup(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string, authorityFor: (mint: PublicKey) => PublicKey | null, vault = false) {
  const f = cfg.factory;
  if (!f?.feeReceiver) throw new Error("factory.feeReceiver is not set in config.json");
  const creator = new PublicKey(p.creator);
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  // A vault launch has no distributor wallet: the vault's auth PDA (from the new mint's
  // address) withdraws the tax, and the vault crank pays its own fees.
  const distributor = vault ? null : Keypair.generate();
  const withdrawAuthority = distributor ? distributor.publicKey : vaultAuthPda(new PublicKey(f.taxVault!.programId), mint);
  const mintAuthority = authorityFor(mint);

  // Metadata on IPFS when uploads are set up (the token then doesn't depend on this
  // server); otherwise served by the site from the launch record.
  const uri = ipfsEnabled(cfg)
    ? await pinMetadata(cfg, tokenMetadataJson(p, publicUrl), `${p.symbol} ${mint.toBase58()}`)
    : `${publicUrl.replace(/\/$/, "")}/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name: p.name, symbol: p.symbol, uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const supply = toBaseUnits(p.supply, DECIMALS);
  const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);

  // Launch fee (USDC, or factory.feeToken such as XNM).
  const lf = launchFee(cfg);
  const usdc = new PublicKey(lf.mint);
  const usdcInfo = await conn.getAccountInfo(usdc);
  if (!usdcInfo) throw new Error(`Fee token ${lf.symbol} not found on this network`);
  const usdcProgram = usdcInfo.owner;
  const usdcMint = unpackMint(usdc, usdcInfo, usdcProgram);
  const fee = toBaseUnits(lf.amount, usdcMint.decimals);
  const receiver = new PublicKey(f.feeReceiver);
  const fromUsdc = getAssociatedTokenAddressSync(usdc, creator, false, usdcProgram);
  const toUsdc = getAssociatedTokenAddressSync(usdc, receiver, false, usdcProgram);
  const fromInfo = await conn.getAccountInfo(fromUsdc);
  const balance = fromInfo ? (await conn.getTokenAccountBalance(fromUsdc)).value.amount : "0";
  if (BigInt(balance) < fee) throw new Error(`The launch fee is ${lf.amount} ${lf.symbol}; this wallet has ${Number(balance) / 10 ** usdcMint.decimals}.`);

  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    // No fee-config authority: the tax can never be changed. The token's distributor
    // wallet (or, for a vault launch, the vault program) is the only one that can withdraw
    // collected tax.
    createInitializeTransferFeeConfigInstruction(mint, null, withdrawAuthority, p.taxBps, U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, creator, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, mint, mintAuthority: creator,
      name: p.name, symbol: p.symbol, uri,
    }),
    ...(mintAuthority === null ? [
      createAssociatedTokenAccountIdempotentInstruction(creator, creatorAta, creator, mint, TOKEN_2022_PROGRAM_ID),
      createMintToCheckedInstruction(mint, creatorAta, creator, supply, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    ] : []),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, mintAuthority, [], TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(creator, toUsdc, receiver, usdc, usdcProgram),
    createTransferCheckedInstruction(fromUsdc, usdc, toUsdc, creator, fee, usdcMint.decimals, [], usdcProgram),
    ...(distributor ? [SystemProgram.transfer({ fromPubkey: creator, toPubkey: distributor.publicKey, lamports: toBaseUnits(f.gasXnt ?? "0.05", 9) })] : []),
  ];
  return { ixs, mintKp, distributor, withdrawAuthority };
}

/** Save a new launch record and its distributor key (factory/launches/<mint>/); vault launches have none. */
function saveNewLaunch(record: LaunchRecord, distributor: Keypair | null) {
  writeLaunch(record);
  if (distributor) fs.writeFileSync(path.join(launchDir(record.mint), "distributor.json"), JSON.stringify(Array.from(distributor.secretKey)), { mode: 0o600 });
}

/** Mark a token as vault-managed in its launch record and per-launch config (the migration script). */
export function markTaxVault(mint: string) {
  const r = readLaunch(mint);
  if (r) writeLaunch({ ...r, taxVault: true });
  const f = path.join(launchDir(new PublicKey(mint).toBase58()), "config.json");
  if (fs.existsSync(f)) {
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    fs.writeFileSync(f, JSON.stringify({ ...c, taxVault: true }, null, 2) + "\n", { mode: 0o600 });
  }
}

/** Step 1: new mint + distributor wallet; returns the instructions and the mint keypair to co-sign. */
export async function buildTokenStep(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string) {
  const pair = pairOf(cfg, p);
  const vault = isVaultLaunch(cfg, pair);
  const { ixs, mintKp, distributor, withdrawAuthority } = await buildMintSetup(conn, cfg, p, publicUrl, () => null, vault);
  const mint = mintKp.publicKey;
  const pool = poolAddresses(new PublicKey(cfg.xdex.programId), new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint, pair.mint).pool;
  const record: LaunchRecord = {
    ...p, ...(pair.xntPool ? { quoteMint: pair.mint.toBase58(), quoteXntPool: pair.xntPool.toBase58() } : {}),
    mint: mint.toBase58(), distributor: withdrawAuthority.toBase58(), pool: pool.toBase58(), createdAt: new Date().toISOString(),
    ...(vault ? { taxVault: true } : {}),
  };
  saveNewLaunch(record, distributor);
  return { ixs, signers: [mintKp], record };
}

/**
 * Curve launches: the same token checks as a normal launch, with the curve's own supply
 * range and a graduation target (`targetXnt`, whole XNT, default 500) recorded as poolXnt.
 */
export function validateCurveParams(raw: Record<string, unknown>): LaunchParams {
  // The pool fields follow from the curve (the program seeds the pool with the target at
  // graduation), so fill them in before the shared checks.
  const supply = String(raw.supply ?? "").trim();
  const target = parseTarget(raw.targetXnt);
  const p = validateParams({ ...raw, poolTokens: supply, poolXnt: target.toString(), lockDays: null, quote: "XNT" });
  if (BigInt(p.supply) > CURVE_SUPPLY_MAX) throw new Error(`Supply must be a whole number from 1,000 to ${CURVE_SUPPLY_MAX.toLocaleString("en-US")}`);
  return p;
}

/**
 * A bonding-curve launch: the same mint (tax, metadata, launch fee, distributor or vault)
 * with minting handed to the curve's auth PDA and nothing minted, then create_curve. The
 * program checks the mint and holds the creator's 0.3 XNT graduation deposit.
 */
export async function buildCurveStep(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string, curveProgram: PublicKey) {
  // With the Tax Vault set up (curves are always XNT-paired), the vault's auth PDA gets the
  // withdraw authority now; the creator starts the vault after graduation (init_vault needs
  // their signature and the lock NFT). Otherwise the token gets a distributor wallet.
  const vault = vaultLaunches(cfg);
  const { ixs, mintKp, distributor, withdrawAuthority } = await buildMintSetup(conn, cfg, p, publicUrl, (mint) => authPda(curveProgram, mint), vault);
  const mint = mintKp.publicKey;
  const target = parseTarget(p.poolXnt); // validateCurveParams put the target there
  ixs.push(createCurveIx(curveProgram, new PublicKey(p.creator), mint, BigInt(p.supply), target));
  const setup = curveSetup(BigInt(p.supply), p.taxBps, target);
  const pool = poolAddresses(new PublicKey(cfg.xdex.programId), new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint).pool;
  const record: LaunchRecord = {
    ...p, kind: "curve", curve: curvePda(curveProgram, mint).toBase58(),
    // What the program puts into the pool at graduation (tokens before the transfer fee).
    poolTokens: fromBaseUnits(setup.Pg, DECIMALS), poolXnt: target.toString(), lockDays: null,
    mint: mint.toBase58(), distributor: withdrawAuthority.toBase58(), pool: pool.toBase58(), createdAt: new Date().toISOString(),
    ...(vault ? { taxVault: true } : {}),
  };
  saveNewLaunch(record, distributor);
  return { ixs, signers: [mintKp], record };
}

/** Step 2: create the XDEX pool with the creator's tokens and XNT (or their pair token, e.g. JACK). */
export async function buildPoolStep(conn: Connection, cfg: Config, r: LaunchRecord) {
  const pair = pairOf(cfg, r);
  if (!pair.xntPool) {
    return buildCreatePool(new PublicKey(cfg.xdex.programId), cfg.network, new PublicKey(r.creator), new PublicKey(r.mint),
      toBaseUnits(r.poolTokens, DECIMALS), toBaseUnits(r.poolXnt, 9));
  }
  const info = await conn.getAccountInfo(pair.mint, "confirmed");
  if (!info) throw new Error(`${pair.symbol} not found on this network`);
  const decimals = unpackMint(pair.mint, info, info.owner).decimals;
  return buildCreatePool(new PublicKey(cfg.xdex.programId), cfg.network, new PublicKey(r.creator), new PublicKey(r.mint),
    toBaseUnits(r.poolTokens, DECIMALS), toBaseUnits(r.poolXnt, decimals), pair.mint, info.owner);
}

/** Step 3: lock all the creator's LP for this pool in an lp_locker NFT. */
export async function buildLockStep(conn: Connection, cfg: Config, r: LaunchRecord) {
  const unlockAt = r.lockDays === null ? undefined : Math.floor(Date.now() / 1000 + r.lockDays * 86_400);
  return buildLock(conn, cfg, new PublicKey(r.creator), "all", unlockAt,
    { pool: new PublicKey(r.pool), mint: new PublicKey(r.mint), symbol: r.symbol });
}

/** A curve launch's curve account, or null (not created yet, or the curve feature is off). */
export async function readCurveOf(conn: Connection, cfg: Config, r: LaunchRecord) {
  const id = cfg.factory?.curve?.programId;
  if (r.kind !== "curve" || !id) return null;
  const addr = curvePda(new PublicKey(id), new PublicKey(r.mint));
  const info = await conn.getAccountInfo(addr, "confirmed");
  return info ? decodeCurve(addr, info.data) : null;
}

/** Whether a vault launch's vault account exists (the creator started it). */
async function vaultStarted(conn: Connection, cfg: Config, r: LaunchRecord) {
  const id = cfg.factory?.taxVault?.programId;
  return !!id && !!(await conn.getAccountInfo(vaultPda(new PublicKey(id), new PublicKey(r.mint)), "confirmed"));
}

/** Which steps are done, read from the chain. */
export async function launchStatus(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (r.kind === "curve") {
    // The curve program does the pool and the lock itself at graduation.
    const c = await readCurveOf(conn, cfg, r);
    const graduated = !!c && c.status >= CurveStatus.Graduated;
    const out = { token: !!c, pool: !!c && c.status >= CurveStatus.PoolCreated, lock: graduated,
      lockNft: graduated ? c!.lockNft.toBase58() : null, registered: !!r.registeredAt, curveStatus: c?.status ?? null };
    // A vault curve token: the creator starts the vault once it has graduated.
    return r.taxVault ? { ...out, taxVault: true, vault: graduated && (await vaultStarted(conn, cfg, r)) } : out;
  }
  const [mintInfo, poolInfo] = await conn.getMultipleAccountsInfo([new PublicKey(r.mint), new PublicKey(r.pool)], "confirmed");
  const token = !!mintInfo;
  const pool = !!poolInfo && poolInfo.owner.equals(new PublicKey(cfg.xdex.programId));
  let lock = false, lockNft: string | null = null;
  if (pool && cfg.locker?.programId) {
    const locks = await listLocks(conn, new PublicKey(cfg.locker.programId), new PublicKey(r.pool));
    const mine = locks.find((l) => l.locker.toBase58() === r.creator);
    lock = !!mine;
    lockNft = mine?.nftMint.toBase58() ?? null;
  }
  // Vault launches have one more creator-signed step: starting the tax vault (init_vault).
  if (r.taxVault) return { token, pool, lock, lockNft, taxVault: true, vault: await vaultStarted(conn, cfg, r), registered: !!r.registeredAt };
  return { token, pool, lock, lockNft, registered: !!r.registeredAt };
}

/**
 * Vault launches, after the lock: init_vault signed and paid by the creator (the program
 * only takes the mint's metadata authority, so nobody can front-run it with their own
 * publisher). It doesn't fit in the lock transaction (about 1,240–1,370 bytes together), so
 * it's its own step. Publisher = this site's crank key, guardian = the creator. A curve
 * token's is the same transaction after graduation, with the pool the curve created.
 */
export async function buildVaultStep(conn: Connection, cfg: Config, r: LaunchRecord, lockNft: string) {
  const tv = cfg.factory?.taxVault;
  if (!r.taxVault) throw new Error("This token doesn't use the Tax Vault.");
  if (!tv?.programId || !tv.publisherKeypair) throw new Error("The Tax Vault isn't set up on this server right now; try again later.");
  const program = new PublicKey(tv.programId);
  const mint = new PublicKey(r.mint);
  if (await conn.getAccountInfo(vaultPda(program, mint), "confirmed")) throw new Error("The tax vault is already started.");
  const burnBps = r.burnBps ?? 0, lpBps = r.autoLpBps;
  if (!validSplit(burnBps, lpBps)) throw new Error(`The tax vault can't take this split (burn ${burnBps / 100}%, liquidity ${lpBps / 100}%).`);
  const publisher = loadKeypair(tv.publisherKeypair).publicKey;
  const creator = new PublicKey(r.creator);
  const c = r.kind === "curve" ? await readCurveOf(conn, cfg, r) : null;
  if (r.kind === "curve" && (!c || c.status < CurveStatus.Graduated)) throw new Error("The curve hasn't graduated yet; the tax vault starts after graduation.");
  const pool = c ? c.pool : new PublicKey(r.pool);
  return [initVaultIx(program, { payer: creator, mint, pool, creatorNft: new PublicKey(lockNft), burnBps, lpBps, publisher, guardian: creator })];
}

/** A vault launch's vault must exist with this site's publisher, the creator as guardian and the recorded split. */
async function checkVault(conn: Connection, cfg: Config, r: LaunchRecord) {
  const tv = cfg.factory?.taxVault;
  if (!tv?.programId) throw new Error("This token uses the Tax Vault, which isn't set up on this server (factory.taxVault).");
  const program = new PublicKey(tv.programId);
  const addr = vaultPda(program, new PublicKey(r.mint));
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(program)) throw new Error("Start the tax vault first (the step after the LP lock).");
  const v = decodeVault(addr, info.data);
  const publisher = tv.publisherKeypair ? loadKeypair(tv.publisherKeypair).publicKey : null;
  if (!v.mint.equals(new PublicKey(r.mint)) || !v.guardian.equals(new PublicKey(r.creator)) || (publisher && !v.publisher.equals(publisher))
      || v.burnBps !== (r.burnBps ?? 0) || v.lpBps !== r.autoLpBps) {
    throw new Error("This token's tax vault doesn't match the launch (publisher, guardian or split differ).");
  }
}

/**
 * Verify the launch on-chain (tax immutable and withdrawable only by our distributor,
 * supply fixed, pool live, LP locked) and register it with the factory distributor.
 */
export async function registerLaunch(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (r.kind === "curve") return registerCurve(conn, cfg, r);
  const s = await launchStatus(conn, cfg, r);
  if (!s.token || !s.pool || !s.lock) throw new Error("Launch is not complete yet (token, pool and LP lock are all required).");
  const mint = unpackMint(new PublicKey(r.mint), await conn.getAccountInfo(new PublicKey(r.mint), "confirmed"), TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mint);
  if (!fee || !fee.withdrawWithheldAuthority.equals(withdrawAuthorityOf(cfg, r)) || !fee.transferFeeConfigAuthority.equals(PublicKey.default)
      || mint.mintAuthority !== null) {
    throw new Error("Token does not match the factory launch (fee authorities or mint authority differ).");
  }
  // The creator starts the vault (its own step); registering only checks it, so it can be retried.
  if (r.taxVault) await checkVault(conn, cfg, r);
  if (r.registeredAt) return r;
  return writeTokenConfig(cfg, r, s.lockNft!);
}

/** Who must be able to withdraw the tax: the vault's auth PDA for a vault token, else its distributor wallet. */
function withdrawAuthorityOf(cfg: Config, r: LaunchRecord) {
  if (!r.taxVault) return new PublicKey(r.distributor);
  const id = cfg.factory?.taxVault?.programId;
  if (!id) throw new Error("This token uses the Tax Vault, which isn't set up on this server (factory.taxVault).");
  return vaultAuthPda(new PublicKey(id), new PublicKey(r.mint));
}

/**
 * Register a graduated curve token with the factory distributor, or as a Tax Vault token.
 * The checks differ from a normal launch: the LP lock is owned by the curve's auth PDA (its
 * NFT went to the creator), the pool is the one the curve recorded, and the mint authority
 * stays with the auth PDA until the last buyer's tokens are delivered (the program then
 * removes it). A vault curve token is registered before its vault exists: the creator
 * starts it after graduation, and the vault crank waits for it (the distributor never
 * serves it).
 */
async function registerCurve(conn: Connection, cfg: Config, r: LaunchRecord) {
  const id = cfg.factory?.curve?.programId;
  if (!id) throw new Error("The bonding curve isn't enabled on this site.");
  const program = new PublicKey(id);
  const mintKey = new PublicKey(r.mint);
  const c = await readCurveOf(conn, cfg, r);
  if (!c || c.status < CurveStatus.Graduated) throw new Error("This curve hasn't graduated yet.");
  const auth = authPda(program, mintKey);
  const locks = await listLocks(conn, LOCKER_PROGRAM_ID, c.pool);
  const lock = locks.find((l) => l.nftMint.equals(c.lockNft) && l.locker.equals(auth));
  if (!lock) throw new Error("The curve's LP lock wasn't found.");
  const mint = unpackMint(mintKey, await conn.getAccountInfo(mintKey, "confirmed"), TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mint);
  if (!fee || !fee.withdrawWithheldAuthority.equals(withdrawAuthorityOf(cfg, r)) || !fee.transferFeeConfigAuthority.equals(PublicKey.default)
      || !(mint.mintAuthority === null || mint.mintAuthority.equals(auth))) {
    throw new Error("Token does not match the curve launch (fee authorities or mint authority differ).");
  }
  if (r.registeredAt) return r;
  return writeTokenConfig(cfg, { ...r, pool: c.pool.toBase58() }, c.lockNft.toBase58());
}

/** The token's own distributor config (factory/launches/<mint>/config.json); marks the launch registered. */
function writeTokenConfig(cfg: Config, r: LaunchRecord, lockNft: string) {
  const dir = launchDir(r.mint);
  const pair = pairOf(cfg, r);
  const tokenCfg: Config = {
    ...cfg,
    token: { name: r.name, symbol: r.symbol, uri: "", decimals: DECIMALS, supply: r.supply, feeBps: r.taxBps, launchGrace: false },
    mint: r.mint,
    keypairs: { ...cfg.keypairs, distributor: path.relative(ROOT, path.join(dir, "distributor.json")) },
    // A JACK pair tells the distributor to sell for JACK and swap it to XNT on JACK's XNT pool.
    xdex: { ...cfg.xdex, pool: r.pool,
      ...(pair.xntPool ? { quoteMint: pair.mint.toBase58(), quoteSymbol: pair.symbol, quoteXntPool: pair.xntPool.toBase58() } : {}) },
    distribution: {
      ...cfg.distribution, autoLpBps: r.autoLpBps, burnBps: r.burnBps ?? 0, creatorBps: CREATOR_BPS,
      minHoldingTokens: minHoldingFor(r.supply),
      excludeOwners: creatorExcluded(r) ? [r.creator] : [],
    },
    // The creator's share goes to the vesting vault of their launch lock NFT.
    creatorReward: { nftMint: lockNft, ...CREATOR_REWARD[cfg.network] },
    // The vault program holds the tax; the hot-wallet distributor leaves this token alone.
    ...(r.taxVault ? { taxVault: true } : {}),
  };
  delete (tokenCfg as Partial<Config>).factory;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(tokenCfg, null, 2) + "\n", { mode: 0o600 });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
  const done = { ...r, lockNft, registeredAt: new Date().toISOString() };
  writeLaunch(done);
  return done;
}
