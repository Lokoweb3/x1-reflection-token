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
 * stays withheld in the holders' token accounts, where nobody can move it. A holder-passes
 * curve launch (testnet trial) is the same under the passes program: after graduation the
 * creator starts the vault, then turns the passes on.
 */
import fs from "node:fs";
import path from "node:path";
import { type AccountInfo, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMintLen,
  getTokenMetadata, getTransferFeeConfig, unpackMint,
} from "@solana/spl-token";
import { createInitializeInstruction, createUpdateFieldInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { Config, FACTORY_DIR, ROOT, fromBaseUnits, keypairPublicKey, toBaseUnits } from "../config.js";
import { type Vault, decodeVault, initVaultIx, initVaultPayoutIx, paysInToken, validSplit, vaultAuthPda, vaultPda } from "../taxvault.js";
import { allocPassBookIx, allocSteps, initPassesIx, passBookPda } from "../passes.js";
import { payoutToken } from "./payout.js";
import { buildCreatePool, decodePool, poolAddresses, snapshot, XDEX_CREATE } from "../xdex.js";
import { ipfsEnabled, pinMetadata } from "./ipfs.js";
import { mkdirDurable, syncFile, writeFileDurable } from "./durable.js";
import { buildLock } from "../locker-tx.js";
import { listLocks } from "../locker.js";
import {
  CurveStatus, LOCKER_PROGRAM_ID, SUPPLY_MAX as CURVE_SUPPLY_MAX, authPda, createCurveIx, curveFromAccount, curvePda, curveSetup, hasPool, isGraduated, isLpBurned, lockNftOf, parseTarget,
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
  /** Tax Vault launches: pay holders in this token (its mint) instead of XNT; fixed for good. */
  payoutMint?: string;
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
  /**
   * The vault program this token's vault is under, when it isn't factory.taxVault.programId:
   * a holder-passes launch (testnet trial) uses factory.taxVault.passesProgramId.
   */
  vaultProgram?: string;
}

/**
 * New XNT-paired launches use the Tax Vault when there's a program and a publisher key to
 * create the vault: on testnet always, on mainnet only once `factory.taxVault.mainnet` is set.
 */
export function vaultLaunches(cfg: Config) {
  const tv = cfg.factory?.taxVault;
  return (cfg.network === "testnet" || tv?.mainnet === true) && !!tv?.programId && !!tv.publisherKeypair;
}
/** Whether a launch with this pair would be a vault launch. */
export const isVaultLaunch = (cfg: Config, pair: Pair) => vaultLaunches(cfg) && !pair.xntPool;

/**
 * The holder-passes vault program (testnet trial), when this server offers it alongside the
 * regular one: factory.taxVault.passesProgramId with factory.taxVault.passes, testnet only.
 */
export function passesProgram(cfg: Config) {
  const tv = cfg.factory?.taxVault;
  return cfg.network === "testnet" && tv?.passes && tv.passesProgramId ? new PublicKey(tv.passesProgramId) : null;
}

/** The vault program a launch's vault is under: its record's, else factory.taxVault.programId. */
export function vaultProgramOf(cfg: Config, r?: Pick<LaunchRecord, "vaultProgram"> | null) {
  const id = r?.vaultProgram ?? cfg.factory?.taxVault?.programId;
  if (!id) throw new Error("This token uses the Tax Vault, which isn't set up on this server (factory.taxVault).");
  return new PublicKey(id);
}

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
  // A curve's creator gets no tokens from it (their own wallet can't buy on it; tokens they buy
  // from other wallets are ordinary holdings), so there's no creator's bag to exclude.
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
  // At 9 decimals u64 holds about 18.4 billion whole tokens; above that the mint amount wraps
  // (spl-token drops the high bits) and the pool step can never be built. Same cap as curves.
  const supply = whole("supply", 1_000n, 10_000_000_000n);
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
  // Checked in full (pool, freeze authority, extensions) by the server before step 1.
  let payoutMint: string | undefined;
  if (raw.payoutMint) {
    try { payoutMint = new PublicKey(String(raw.payoutMint).trim()).toBase58(); } catch { throw new Error("The payout token must be a token (mint) address."); }
    if (quote && quote !== "XNT") throw new Error("Paying holders in another token works with XNT-paired launches.");
  }
  return { creator, name, symbol, description, image, website, twitter, telegram, supply, taxBps, autoLpBps, burnBps, poolTokens, poolXnt, lockDays, quote,
    ...(payoutMint ? { payoutMint } : {}) };
}

const launchDir = (mint: string) => path.join(FACTORY_DIR, "launches", mint);
export const readLaunch = (mint: string): LaunchRecord | null => {
  const key = new PublicKey(mint).toBase58();
  const f = path.join(launchDir(key), "launch.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : pendingLaunches.get(key)?.record ?? null;
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

/** Told after a launch's record is on disk: what a cached view of it shows may have changed. */
let launchSaved: (r: LaunchRecord) => void = () => undefined;
export const onLaunchSaved = (fn: (r: LaunchRecord) => void) => { launchSaved = fn; };

/**
 * Save a launch's record. A launch still in the journal is copied to launches/<mint>/, key first,
 * then step.json (what gcLaunchRecords needs later, kept beside the record and not in it, which
 * the site serves) and record last, each flushed with every directory above it; only then does the journal go. It
 * stays a pending launch until both are on disk, so if a write fails, or the power goes, the
 * journal still holds them and the save is tried again later.
 */
function writeLaunch(r: LaunchRecord) {
  const dir = launchDir(r.mint), journal = pendingDir(r.mint);
  mkdirDurable(dir, FACTORY_DIR);
  const key = path.join(journal, "distributor.json");
  if (fs.existsSync(key)) writeFileDurable(path.join(dir, "distributor.json"), fs.readFileSync(key, "utf8"));
  if (fs.existsSync(stepFile(r.mint))) writeFileDurable(savedStepFile(r.mint), fs.readFileSync(stepFile(r.mint), "utf8"));
  writeFileDurable(path.join(dir, "launch.json"), JSON.stringify(r, null, 2) + "\n");
  pendingLaunches.delete(r.mint);
  // Saved. A leftover journal is only clutter: the GC clears it.
  try { fs.rmSync(journal, { recursive: true, force: true }); } catch (e) { console.error(`launch journal ${r.mint}: ${errText(e)}`); }
  launchSaved(r);
}
export function listLaunches(): LaunchRecord[] {
  const dir = path.join(FACTORY_DIR, "launches");
  const saved = fs.existsSync(dir) ? fs.readdirSync(dir).map((m) => readLaunch(m)).filter((r): r is LaunchRecord => !!r) : [];
  const onDisk = new Set(saved.map((r) => r.mint));
  return [...saved, ...[...pendingLaunches.values()].map((p) => p.record).filter((r) => !onDisk.has(r.mint))]
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
async function buildMintSetup(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string, authorityFor: (mint: PublicKey) => PublicKey | null, vault: PublicKey | null = null) {
  const f = cfg.factory;
  if (!f?.feeReceiver) throw new Error("factory.feeReceiver is not set in config.json");
  const creator = new PublicKey(p.creator);
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  // A vault launch has no distributor wallet: the vault's auth PDA (from the new mint's
  // address) withdraws the tax, and the vault crank pays its own fees.
  const distributor = vault ? null : Keypair.generate();
  const withdrawAuthority = distributor ? distributor.publicKey : vaultAuthPda(vault!, mint);
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
  return { ixs, mintKp, distributor, withdrawAuthority, uri };
}

/**
 * New launches whose first transaction (it creates the mint) hasn't been seen on-chain yet.
 * The record and distributor key (vault launches have none) are written to a journal,
 * factory/pending-launches/<mint>/, before the transaction leaves this server: once the creator
 * holds it, it can land and charge the fee whatever happens here. Only once the mint is on-chain
 * do they move to factory/launches/<mint>/ (persistLaunch, sweepPendingLaunches), so a step 1
 * that's never signed doesn't clutter the launches. Readable meanwhile like any record
 * (readLaunch, listLaunches), so the next steps and the status work as before.
 */
const pendingLaunches = new Map<string, { record: LaunchRecord; at: number }>();
/** A step 1 transaction can't land once its blockhash expires (about a minute): well past that, it stops being listed. */
const PENDING_LAUNCH_MS = 15 * 60_000;
/** A journal stays at least this long after its launch stopped being listed; removing it also takes proof from the chain (provenNeverLanded). */
const PENDING_JOURNAL_MS = 86_400_000;
const pendingRoot = () => path.join(FACTORY_DIR, "pending-launches");
const pendingDir = (mint: string) => path.join(pendingRoot(), mint);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Throws if the journal can't be written: no journal, no transaction. */
function saveNewLaunch(record: LaunchRecord, distributor: Keypair | null) {
  const dir = pendingDir(record.mint);
  try {
    mkdirDurable(dir, FACTORY_DIR);
    if (distributor) writeFileDurable(path.join(dir, "distributor.json"), JSON.stringify(Array.from(distributor.secretKey)));
    writeFileDurable(path.join(dir, "launch.json"), JSON.stringify(record, null, 2) + "\n");
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // never handed out, so nothing can land
    throw e;
  }
  // Few at a time: starts are limited site-wide (rateLimit "launch") and each goes within minutes.
  pendingLaunches.set(record.mint, { record, at: Date.now() });
}
/** What the removal proof needs from step 1: the block height past which it can't land. Saving a launch copies it along. */
const stepFile = (mint: string) => path.join(pendingDir(mint), "step.json");
const savedStepFile = (mint: string) => path.join(launchDir(mint), "step.json");
/**
 * Build the transaction of a just-journalled step 1, which `build` makes and returns. It calls the
 * function it's given with the transaction's last valid block height, recorded before the bytes can
 * leave this server (a failure stops them). If the build fails nothing left, its mint key is gone
 * and no transaction can ever land, so the journal goes too; left behind, it could never be removed.
 */
export async function handOutLaunchStep<T>(mint: string, build: (built: (lastValidBlockHeight: number) => void) => Promise<T>) {
  try {
    return await build((lastValidBlockHeight) => writeFileDurable(stepFile(mint), JSON.stringify({ lastValidBlockHeight }) + "\n"));
  } catch (e) {
    pendingLaunches.delete(mint);
    try { fs.rmSync(pendingDir(mint), { recursive: true, force: true }); } catch (rm) { console.error(`launch journal ${mint}: ${errText(rm)}`); }
    throw e;
  }
}
function stepExpiry(file: string) {
  try {
    const h = JSON.parse(fs.readFileSync(file, "utf8")).lastValidBlockHeight;
    return Number.isSafeInteger(h) && h > 0 ? h as number : null;
  } catch { return null; }
}

/** Whether `mint` is a new launch still waiting for its first transaction. */
export const isPendingLaunch = (mint: string) => pendingLaunches.has(mint);
/**
 * Save a waiting launch's record (its mint is on-chain now). Whether it's saved: a disk error
 * is logged, not thrown, since the journal still holds it and the sweep tries again.
 */
export function persistLaunch(mint: string) {
  const p = pendingLaunches.get(mint);
  if (!p) return true;
  try { writeLaunch(p.record); return true; } catch (e) { console.error(`saving launch ${mint}: ${errText(e)}`); return false; }
}

const LAUNCH_READ_BATCH = 100;
let sweeping: Promise<boolean> | null = null;
/**
 * Save the waiting launches whose mint is on-chain now and stop listing those whose step 1 can
 * no longer land (their journal stays for gcPendingJournal). Only a chain read that answered
 * decides anything: a failed one affects its own batch, which stays as it was. One sweep at a
 * time. Whether everything was read and saved; if not, the caller should try again soon.
 */
export function sweepPendingLaunches(conn: Connection) {
  return (sweeping ??= sweepOnce(conn).finally(() => { sweeping = null; }));
}
async function sweepOnce(conn: Connection) {
  const list = [...pendingLaunches.keys()];
  let ok = true;
  for (let i = 0; i < list.length; i += LAUNCH_READ_BATCH) {
    const chunk = list.slice(i, i + LAUNCH_READ_BATCH);
    let infos;
    try { infos = await conn.getMultipleAccountsInfo(chunk.map((m) => new PublicKey(m)), "confirmed"); }
    catch (e) { ok = false; console.error(`pending launches: ${errText(e)}`); continue; }
    chunk.forEach((mint, j) => {
      // Looked up afresh: while the chain read ran, another path may have saved it and moved on.
      const p = pendingLaunches.get(mint);
      if (!p) return;
      if (infos[j]) { if (!persistLaunch(mint)) ok = false; }
      else if (Date.now() - p.at > PENDING_LAUNCH_MS) pendingLaunches.delete(mint);
    });
  }
  return ok;
}

/**
 * After a restart: every journalled launch back into memory, however long the server was down,
 * so it's readable at once and the sweep settles it against the chain, retrying until the chain
 * answers. Returns how many.
 */
export function recoverPendingLaunches() {
  const root = pendingRoot();
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(root)) {
    const r = readJournal(name);
    if (!r || fs.existsSync(path.join(launchDir(name), "launch.json"))) continue; // the GC tidies these
    const at = Date.parse(r.createdAt);
    pendingLaunches.set(name, { record: r, at: Number.isFinite(at) ? at : Date.now() });
    n++;
  }
  return n;
}
function readJournal(name: string): LaunchRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(pendingDir(name), "launch.json"), "utf8")) as LaunchRecord;
    return r.mint === name ? r : null;
  } catch { return null; }
}

/**
 * A journal whose launch is already saved: its key and step 1's validity if that's all that's
 * left to move, then the journal. The save may have stopped at a flush after its renames, and a restart doesn't know, so
 * nothing is taken as durable for being there: the journal goes only once both files check out
 * and they and every directory above them are flushed. Otherwise it stays for the next GC.
 */
function tidySavedJournal(name: string) {
  const dir = launchDir(name), record = path.join(dir, "launch.json");
  const key = path.join(pendingDir(name), "distributor.json"), dest = path.join(dir, "distributor.json");
  if (fs.existsSync(key)) {
    const secret = fs.readFileSync(key, "utf8");
    if (!fs.existsSync(dest)) writeFileDurable(dest, secret);
    else if (fs.readFileSync(dest, "utf8") !== secret) { console.error(`launch journal ${name}: a different key is already saved; kept`); return; }
  }
  if (fs.existsSync(stepFile(name)) && !fs.existsSync(savedStepFile(name))) writeFileDurable(savedStepFile(name), fs.readFileSync(stepFile(name), "utf8"));
  let saved: LaunchRecord | null = null;
  try { saved = JSON.parse(fs.readFileSync(record, "utf8")); } catch { /* said below */ }
  if (saved?.mint !== name) { console.error(`launch journal ${name}: the saved record is unreadable or another token's; kept`); return; }
  syncFile(record);
  if (fs.existsSync(dest)) syncFile(dest);
  if (fs.existsSync(savedStepFile(name))) syncFile(savedStepFile(name));
  mkdirDurable(dir, FACTORY_DIR);
  fs.rmSync(pendingDir(name), { recursive: true, force: true });
}

const JOURNAL_READ_BATCH = 50; // each is the mint and the distributor wallet
let journalGc: Promise<string[]> | null = null;
/** A launch the proof can be asked about: `expiry` is step 1's recorded last valid block height. */
type Provable = { name: string; mint: PublicKey; wallet: PublicKey | null; expiry: number };
/** The wallet of a distributor key file, or null without one. Its errors can go to a log (keyFileError). */
const walletOfKeyFile = (file: string) => (fs.existsSync(file) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")))).publicKey : null);
/** JSON's own errors quote what they read. */
const keyFileError = (e: unknown) => (e instanceof SyntaxError ? "unreadable key file" : errText(e));
/**
 * Which of these launches are proven to have nothing on-chain, ever. A plain read can come from a
 * lagging node, so a null there proves nothing. The proof: the finalized tip (slot and block height
 * from one answer) is past the height where step 1 stopped being able to land, and one finalized
 * answer, read at that slot or later, has neither the mint nor anything in the wallet. Step 1 can't
 * land after that, and had it landed the read would show it. Without the recorded height (a launch
 * from before it was kept, or a damaged one) the caller has nothing to ask; without such an answer
 * there's no proof. Only an answer that's whole and says "no account" counts for either address.
 */
async function provenNeverLanded(conn: Connection, list: Provable[]) {
  if (!list.length) return [];
  const { absoluteSlot: slot, blockHeight: height } = await conn.getEpochInfo("finalized");
  if (typeof height !== "number" || typeof slot !== "number") throw new Error("the node gave no block height or slot");
  const expired = list.filter((j) => height > j.expiry);
  if (!expired.length) return [];
  const keys = expired.flatMap((j) => [j.mint, j.wallet ?? j.mint]);
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot: slot });
  if (!(context.slot >= slot)) throw new Error(`the node read is behind (slot ${context.slot} < ${slot})`);
  if (value.length !== keys.length) throw new Error(`the node answered for ${value.length} of ${keys.length} accounts`);
  return expired.filter((_, k) => value[2 * k] === null && value[2 * k + 1] === null).map((j) => j.name);
}

/**
 * The journals of launches no longer in memory (past their window). A mint on-chain: saved.
 * Removed only when over a day old and proven never to have landed (provenNeverLanded); anything
 * unclear stays. Calls during a run share it, and a failed read affects its own batch.
 * Returns the mints removed.
 */
export function gcPendingJournal(conn: Connection) {
  return (journalGc ??= gcJournalOnce(conn).finally(() => { journalGc = null; }));
}
async function gcJournalOnce(conn: Connection) {
  const root = pendingRoot();
  if (!fs.existsSync(root)) return [];
  const removed: string[] = [];
  const saved = (name: string) => fs.existsSync(path.join(launchDir(name), "launch.json"));
  const waiting: { name: string; mint: PublicKey; wallet: PublicKey | null }[] = [];
  for (const name of fs.readdirSync(root)) {
    if (pendingLaunches.has(name)) continue;
    let mint: PublicKey;
    try { mint = new PublicKey(name); } catch { continue; }
    try {
      if (saved(name)) { tidySavedJournal(name); continue; }
      // Without the record, the key file is where the wallet's address comes from.
      waiting.push({ name, mint, wallet: walletOfKeyFile(path.join(pendingDir(name), "distributor.json")) });
    } catch (e) { console.error(`launch journal ${name}: ${keyFileError(e)}; kept`); }
  }
  for (let i = 0; i < waiting.length; i += JOURNAL_READ_BATCH) {
    const chunk = waiting.slice(i, i + JOURNAL_READ_BATCH);
    let infos;
    try { infos = await conn.getMultipleAccountsInfo(chunk.flatMap((j) => [j.mint, j.wallet ?? j.mint]), "confirmed"); }
    catch (e) { console.error(`launch journal GC: ${errText(e)}`); continue; }
    const due: Provable[] = [];
    chunk.forEach(({ name, wallet }, k) => {
      const mintInfo = infos[2 * k], walletInfo = wallet ? infos[2 * k + 1] : null;
      try {
        // Decided on what's there now: during that read the launch may have been saved and moved on.
        const dir = pendingDir(name);
        if (pendingLaunches.has(name) || !fs.existsSync(dir)) return;
        if (saved(name)) { tidySavedJournal(name); return; }
        const r = readJournal(name);
        if (mintInfo) {
          if (r) writeLaunch(r);
          else console.error(`launch journal ${name}: the mint is on-chain but the record is missing or unreadable; kept`);
          return;
        }
        const at = r ? Date.parse(r.createdAt) : fs.statSync(dir).mtimeMs;
        if (!(Date.now() - at > PENDING_JOURNAL_MS) || (walletInfo && walletInfo.lamports > 0)) return;
        const expiry = stepExpiry(stepFile(name));
        if (expiry === null) console.error(`launch journal ${name}: no record of when its step 1 stops being able to land; kept`);
        else due.push({ ...chunk[k], expiry });
      } catch (e) { console.error(`launch journal ${name}: ${errText(e)}`); }
    });
    let proven: string[] = [];
    try { proven = await provenNeverLanded(conn, due); }
    catch (e) { console.error(`launch journal GC: no proof, ${due.length} kept: ${errText(e)}`); }
    for (const name of proven) {
      try {
        // Decided on what's there now, as above.
        if (pendingLaunches.has(name) || saved(name) || !fs.existsSync(pendingDir(name))) continue;
        fs.rmSync(pendingDir(name), { recursive: true, force: true });
        removed.push(name);
      } catch (e) { console.error(`launch journal ${name}: ${errText(e)}`); }
    }
  }
  return removed;
}

/** Beside a record that can be removed: a token config or state means it got further. */
const RECORD_FILES = new Set(["launch.json", "distributor.json", "step.json"]);
/** The saved record of launches/<name>/ if it's one that could still be removed: unregistered, its own, over a day old, nothing else beside it. */
function unfinishedRecord(name: string) {
  const dir = launchDir(name);
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, "launch.json"), "utf8")) as LaunchRecord;
    if (r.registeredAt || r.mint !== name || !(Date.now() - Date.parse(r.createdAt) > PENDING_JOURNAL_MS)) return null;
    return fs.readdirSync(dir).every((x) => RECORD_FILES.has(x)) ? r : null;
  } catch { return null; }
}
/** Records only a person can settle: said once per server run, not on every pass of a GC that runs for good. */
const saidKept = new Set<string>();
function keptForGood(name: string, why: string) {
  if (saidKept.has(name)) return;
  saidKept.add(name);
  console.error(`launch record ${name}: ${why}; kept, and it stays until a person checks the chain and decides (its token may well exist)`);
}

/**
 * Remove launch records left by a step 1 that never landed (saved on a read that a dropped fork or
 * a bad node gave, or from before the journal). The record holds a token's only distributor key, so
 * this takes the proof the journals do (provenNeverLanded), from the step.json saved beside it. A
 * record without one, however old, has nothing to prove against: kept, for a person to decide. So
 * is every launch whose token exists, and anything a failed or lagging read leaves unclear; that
 * read only affects its batch.
 * Returns the mints removed.
 */
export async function gcLaunchRecords(conn: Connection) {
  const dir = path.join(FACTORY_DIR, "launches");
  if (!fs.existsSync(dir)) return [];
  const due: Provable[] = [];
  for (const name of fs.readdirSync(dir)) {
    const r = unfinishedRecord(name);
    if (!r) continue;
    try {
      const mint = new PublicKey(name), expiry = stepExpiry(savedStepFile(name));
      if (expiry === null) { keptForGood(name, "no record of when its step 1 stops being able to land"); continue; }
      // Vault launches have no key file, so nothing to look at but the mint.
      const wallet = walletOfKeyFile(path.join(launchDir(name), "distributor.json"));
      if (wallet && wallet.toBase58() !== r.distributor) { keptForGood(name, "its key file isn't the recorded distributor's"); continue; }
      due.push({ name, mint, wallet, expiry });
    } catch (e) { keptForGood(name, keyFileError(e)); }
  }
  const removed: string[] = [];
  for (let i = 0; i < due.length; i += JOURNAL_READ_BATCH) {
    const chunk = due.slice(i, i + JOURNAL_READ_BATCH);
    let proven: string[] = [];
    try { proven = await provenNeverLanded(conn, chunk); }
    catch (e) { console.error(`launch records GC: no proof, ${chunk.length} kept: ${errText(e)}`); }
    for (const name of proven) {
      try {
        // Decided on what's there now: during that read it may have moved on.
        if (!unfinishedRecord(name)) continue;
        fs.rmSync(launchDir(name), { recursive: true, force: true });
        removed.push(name);
      } catch (e) { console.error(`launch record ${name}: ${errText(e)}`); }
    }
  }
  return removed;
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

/**
 * Step 1: new mint + distributor wallet; returns the instructions and the mint keypair to co-sign.
 * `passesProgram`: a holder-passes vault launch, under that program instead of the regular one.
 */
export async function buildTokenStep(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string, passesProgram: PublicKey | null = null) {
  const pair = pairOf(cfg, p);
  const vault = isVaultLaunch(cfg, pair);
  if (passesProgram && !vault) throw new Error("Holder passes need a Tax Vault launch paired with XNT.");
  const program = vault ? passesProgram ?? vaultProgramOf(cfg) : null;
  const { ixs, mintKp, distributor, withdrawAuthority, uri } = await buildMintSetup(conn, cfg, p, publicUrl, () => null, program);
  const mint = mintKp.publicKey;
  const pool = poolAddresses(new PublicKey(cfg.xdex.programId), new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint, pair.mint).pool;
  const record: LaunchRecord = {
    ...p, ...(pair.xntPool ? { quoteMint: pair.mint.toBase58(), quoteXntPool: pair.xntPool.toBase58() } : {}),
    mint: mint.toBase58(), distributor: withdrawAuthority.toBase58(), pool: pool.toBase58(), createdAt: new Date().toISOString(),
    ...(vault ? { taxVault: true } : {}), ...(passesProgram ? { vaultProgram: passesProgram.toBase58() } : {}),
  };
  saveNewLaunch(record, distributor);
  return { ixs, signers: [mintKp], record, uri };
}

/**
 * Curve launches: the same token checks as a normal launch, with the curve's own supply
 * range and a graduation target (`targetXnt`, whole XNT, default 500) recorded as poolXnt.
 */
export function validateCurveParams(raw: Record<string, unknown>, network: "mainnet" | "testnet" = "mainnet"): LaunchParams {
  // The pool fields follow from the curve (the program seeds the pool with the target at
  // graduation), so fill them in before the shared checks.
  const supply = String(raw.supply ?? "").trim();
  const target = parseTarget(raw.targetXnt, network);
  const p = validateParams({ ...raw, poolTokens: supply, poolXnt: target.toString(), lockDays: null, quote: "XNT" });
  if (BigInt(p.supply) > CURVE_SUPPLY_MAX) throw new Error(`Supply must be a whole number from 1,000 to ${CURVE_SUPPLY_MAX.toLocaleString("en-US")}`);
  return p;
}

/**
 * A bonding-curve launch: the same mint (tax, metadata, launch fee, distributor or vault)
 * with minting handed to the curve's auth PDA and nothing minted, then create_curve. The
 * program checks the mint and holds the creator's 0.3 XNT graduation deposit.
 * `passesProgram`: a holder-passes curve launch, its vault under that program.
 */
export async function buildCurveStep(conn: Connection, cfg: Config, p: LaunchParams, publicUrl: string, curveProgram: PublicKey, passesProgram: PublicKey | null = null) {
  // With the Tax Vault set up (curves are always XNT-paired), the vault's auth PDA gets the
  // withdraw authority now; the creator starts the vault after graduation (init_vault needs
  // their signature and the lock NFT). Otherwise the token gets a distributor wallet.
  const vault = vaultLaunches(cfg);
  if (passesProgram && !vault) throw new Error("Holder passes need a Tax Vault launch.");
  // The curve program only takes a token whose tax a tax vault program withdraws (no wallet can).
  if (!vault) throw new Error("Curve launches need the Tax Vault, which isn't set up on this site right now.");
  const { ixs, mintKp, distributor, withdrawAuthority, uri } = await buildMintSetup(conn, cfg, p, publicUrl, (mint) => authPda(curveProgram, mint), vault ? passesProgram ?? vaultProgramOf(cfg) : null);
  const mint = mintKp.publicKey;
  const target = parseTarget(p.poolXnt, cfg.network); // validateCurveParams put the target there
  ixs.push(createCurveIx(curveProgram, cfg.network, new PublicKey(p.creator), mint, BigInt(p.supply), target));
  const setup = curveSetup(BigInt(p.supply), p.taxBps, target);
  const pool = poolAddresses(new PublicKey(cfg.xdex.programId), new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint).pool;
  const record: LaunchRecord = {
    ...p, kind: "curve", curve: curvePda(curveProgram, mint).toBase58(),
    // What the program puts into the pool at graduation (tokens before the transfer fee).
    poolTokens: fromBaseUnits(setup.Pg, DECIMALS), poolXnt: target.toString(), lockDays: null,
    mint: mint.toBase58(), distributor: withdrawAuthority.toBase58(), pool: pool.toBase58(), createdAt: new Date().toISOString(),
    ...(vault ? { taxVault: true } : {}), ...(passesProgram ? { vaultProgram: passesProgram.toBase58() } : {}),
  };
  saveNewLaunch(record, distributor);
  return { ixs, signers: [mintKp], record, uri };
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

/** A curve launch's curve account, or null (not created yet, closed, or the curve feature is off). */
export async function readCurveOf(conn: Connection, cfg: Config, r: LaunchRecord) {
  const id = cfg.factory?.curve?.programId;
  if (r.kind !== "curve" || !id) return null;
  const program = new PublicKey(id);
  const addr = curvePda(program, new PublicKey(r.mint));
  return curveFromAccount(program, addr, await conn.getAccountInfo(addr, "confirmed"));
}

/** Why a curve token whose LP was burned at graduation (graduate_burn) can't go on like the others. */
export const LP_BURNED_ERROR = "This token's LP was burned at graduation because its lock couldn't be made, so it has no lock NFT: its tax vault can't start and it can't be registered.";

/** Whether a vault launch's vault account exists (the creator started it). */
async function vaultStarted(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (!r.vaultProgram && !cfg.factory?.taxVault?.programId) return false;
  return !!(await conn.getAccountInfo(vaultPda(vaultProgramOf(cfg, r), new PublicKey(r.mint)), "confirmed"));
}

/** A pass book set up by init_passes (anyone may grow one beforehand; it's all zeros until then). */
const passBookOn = (info: AccountInfo<Buffer> | null, program: PublicKey) => !!info && info.owner.equals(program) && info.data.subarray(0, 8).some((b) => b !== 0);

/** A holder-passes launch: whether the creator has turned its passes on. */
export async function passesStarted(conn: Connection, cfg: Config, r: LaunchRecord) {
  const program = vaultProgramOf(cfg, r);
  return passBookOn(await conn.getAccountInfo(passBookPda(program, vaultPda(program, new PublicKey(r.mint))), "confirmed"), program);
}

/** Which steps are done, read from the chain. */
export async function launchStatus(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (r.kind === "curve") {
    // The curve program does the pool and the lock itself at graduation.
    const c = await readCurveOf(conn, cfg, r);
    const graduated = !!c && isGraduated(c.status);
    // A curve whose LP was burned (graduate_burn, lp_locker failing) graduated without a lock NFT.
    const nft = c ? lockNftOf(c) : null;
    // No curve but the mint exists: it was closed (the mint and the curve are created together).
    const closed = !c && !!cfg.factory?.curve?.programId && !!(await conn.getAccountInfo(new PublicKey(r.mint), "confirmed"));
    const out = { token: !!c, pool: !!c && hasPool(c.status), lock: !!nft,
      lockNft: nft?.toBase58() ?? null, registered: !!r.registeredAt, curveStatus: c?.status ?? null,
      lpBurned: !!c && isLpBurned(c), curveClosed: closed };
    // A vault curve token: the creator starts the vault once it has graduated (and turns passes on, for a holder-passes one).
    if (!r.taxVault) return out;
    const vault = graduated && (await vaultStarted(conn, cfg, r));
    const passes = r.vaultProgram ? { holderPasses: true, passes: vault && (await passesStarted(conn, cfg, r)) } : {};
    return { ...out, taxVault: true, vault, ...passes };
  }
  const [mintInfo, poolInfo] = await conn.getMultipleAccountsInfo([new PublicKey(r.mint), new PublicKey(r.pool)], "confirmed");
  const token = !!mintInfo;
  const pool = !!poolInfo && poolInfo.owner.equals(new PublicKey(cfg.xdex.programId));
  let lock = false, lockNft: string | null = null;
  if (pool && cfg.locker?.programId) {
    const locks = await listLocks(conn, new PublicKey(cfg.locker.programId), new PublicKey(r.pool));
    const creators = locks.filter((l) => l.locker.toBase58() === r.creator);
    // Before registration, the lock the launch will go on with: the one holding the most LP (if any
    // holds enough alone, this one does). Listed tokens keep the oldest, what an old record without lockNft used.
    const mine = r.registeredAt ? creators[0] : creators.reduce<(typeof creators)[number] | undefined>((best, l) => (!best || lpTakenIn(l) > lpTakenIn(best) ? l : best), undefined);
    lock = !!mine;
    lockNft = mine?.nftMint.toBase58() ?? null;
  }
  // Vault launches have one more creator-signed step: starting the tax vault (init_vault);
  // a holder-passes launch then turns its passes on (the pass book) in the same step.
  if (r.taxVault) {
    const vault = await vaultStarted(conn, cfg, r);
    const passes = r.vaultProgram ? { holderPasses: true, passes: vault && (await passesStarted(conn, cfg, r)) } : {};
    return { token, pool, lock, lockNft, taxVault: true, vault, ...passes, registered: !!r.registeredAt };
  }
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
  const program = vaultProgramOf(cfg, r);
  const mint = new PublicKey(r.mint);
  if (await conn.getAccountInfo(vaultPda(program, mint), "confirmed")) throw new Error("The tax vault is already started.");
  const burnBps = r.burnBps ?? 0, lpBps = r.autoLpBps;
  if (!validSplit(burnBps, lpBps)) throw new Error(`The tax vault can't take this split (burn ${burnBps / 100}%, liquidity ${lpBps / 100}%).`);
  const publisher = keypairPublicKey(tv.publisherKeypair);
  const creator = new PublicKey(r.creator);
  const c = r.kind === "curve" ? await readCurveOf(conn, cfg, r) : null;
  if (r.kind === "curve" && (!c || !isGraduated(c.status))) throw new Error("The curve hasn't graduated yet; the tax vault starts after graduation.");
  if (c && isLpBurned(c)) throw new Error(LP_BURNED_ERROR);
  const pool = c ? c.pool : new PublicKey(r.pool);
  // The vault fixes its lock for good, so what registration will ask of it is asked now. (A curve's
  // lock is the one the program made, of all the pool's LP; the status names it, not the creator's.)
  if (!c) {
    const tax = getTransferFeeConfig(unpackMint(mint, await conn.getAccountInfo(mint, "confirmed"), TOKEN_2022_PROGRAM_ID));
    if (!tax) throw new Error("Token does not match the factory launch (no tax).");
    const problem = await poolLockProblemOf(conn, cfg, r, tax.newerTransferFee.transferFeeBasisPoints, new PublicKey(lockNft));
    if (problem) throw new Error(`The tax vault can't start yet, and nothing was signed: starting it fixes its lock for good. ${problem}${/whole LP/.test(problem) ? LOCK_MORE : ""}`);
  }
  const base = { payer: creator, mint, pool, creatorNft: new PublicKey(lockNft), burnBps, lpBps, publisher, guardian: creator };
  if (r.payoutMint) {
    // Checked again now: the vault fixes the payout pool for good.
    const pt = await payoutToken(conn, cfg, r.payoutMint, r.mint);
    return [initVaultPayoutIx(program, { ...base, payout: { pool: pt.pool, payoutMint: pt.mint, payoutTokenProgram: pt.tokenProgram } })];
  }
  return [initVaultIx(program, base)];
}

/** A holder-passes launch's rules: earning from a millionth of the supply, rounds of 0.05 XNT or more, 5 minutes apart. */
export const PASS_MIN_POT_XNT = "0.05";
export const PASS_MIN_INTERVAL_SECS = 300n;

/**
 * Holder-passes launches, after the vault starts: the creator (its guardian) turns passes on,
 * growing the pass book to full size and setting its rules, in one transaction.
 */
export async function buildPassesStep(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (!r.vaultProgram) throw new Error("This token doesn't use holder passes.");
  const program = vaultProgramOf(cfg, r);
  const mint = new PublicKey(r.mint);
  if (!(await vaultStarted(conn, cfg, r))) throw new Error("Start the tax vault first.");
  const book = await conn.getAccountInfo(passBookPda(program, vaultPda(program, mint)), "confirmed");
  if (passBookOn(book, program)) throw new Error("Holder passes are already on for this token.");
  await refuseListedVault(conn, program, mint);
  const creator = new PublicKey(r.creator);
  const grow = Array.from({ length: allocSteps(book?.data.length ?? 0) }, () => allocPassBookIx(program, creator, mint));
  return [...grow, initPassesIx(program, creator, mint, toBaseUnits(minHoldingFor(r.supply), DECIMALS), toBaseUnits(PASS_MIN_POT_XNT, 9), PASS_MIN_INTERVAL_SECS)];
}

/**
 * Holder passes only go on a vault that never had a payout list (published or waiting): the
 * program would let the list's pay_fallback draw on the passes' money (review C-1).
 */
export async function refuseListedVault(conn: Connection, program: PublicKey, mint: PublicKey) {
  const addr = vaultPda(program, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  const v = info ? decodeVault(addr, info.data) : null;
  if (v && (v.listEpoch > 0n || v.pendingEpoch > 0n)) throw new Error(LISTED_VAULT);
}
export const LISTED_VAULT = "This vault has already had a payout list, so holder passes can't be turned on for it: the list's fallback payouts would come out of the pass holders' share.";

/**
 * Where a started vault differs from the launch it was registered as: the launch's pool (all
 * the crank's sales go through v.pool) and the lock NFT recorded at registration (the creator
 * reward's key). Read from the record alone, because a listed token's lock can honestly change
 * later: a timed lock closes when it's unlocked, and LP added elsewhere shrinks its share.
 * A field the record lacks reads as `unverified`, not wrong: no site path lists a token without
 * either, so only an old or hand-made record lacks one, and a creator can't cause it.
 */
export function vaultBinding(r: Pick<LaunchRecord, "pool" | "lockNft">, v: Pick<Vault, "pool" | "creatorNft">) {
  return {
    poolWrong: !!r.pool && r.pool !== v.pool.toBase58(),
    nftWrong: !!r.lockNft && r.lockNft !== v.creatorNft.toBase58(),
    unverified: [...(r.pool ? [] : ["pool"]), ...(r.lockNft ? [] : ["creator NFT"])],
  };
}
const VAULT_POOL_WRONG = "This token's tax vault doesn't match the launch (it sells through a different pool than the launch's).";
const VAULT_NFT_WRONG = "This token's tax vault doesn't match the launch (its creator NFT isn't the launch's LP lock).";

/**
 * A vault launch's vault must exist with this site's publisher, the creator as guardian, the
 * recorded split and payout token, on the launch's pool. The program only asks for some pool
 * of this mint and a lock naming it, so these are the site's to check. Returns the vault: the
 * first registration also checks that its creator NFT holds the launch's LP (checkPoolAndLock).
 */
async function checkVault(conn: Connection, cfg: Config, r: LaunchRecord) {
  const tv = cfg.factory?.taxVault;
  const program = vaultProgramOf(cfg, r);
  const addr = vaultPda(program, new PublicKey(r.mint));
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(program)) throw new Error("Start the tax vault first (the step after the LP lock).");
  const v = decodeVault(addr, info.data);
  const publisher = tv?.publisherKeypair ? keypairPublicKey(tv.publisherKeypair) : null;
  if (!v.mint.equals(new PublicKey(r.mint)) || !v.guardian.equals(new PublicKey(r.creator)) || (publisher && !v.publisher.equals(publisher))
      || v.burnBps !== (r.burnBps ?? 0) || v.lpBps !== r.autoLpBps) {
    throw new Error("This token's tax vault doesn't match the launch (publisher, guardian or split differ).");
  }
  // The payout token: XNT for a launch without one, else a vault paying through that token's pool.
  if (!r.payoutMint !== !paysInToken(v)) throw new Error("This token's tax vault doesn't match the launch (payout token differs).");
  if (r.payoutMint) {
    const p = decodePool(v.payoutPool, await conn.getAccountInfo(v.payoutPool, "confirmed"), new PublicKey(cfg.xdex.programId));
    if (!p.mints.some((x) => x.toBase58() === r.payoutMint)) throw new Error("This token's tax vault pays in a different token than the launch chose.");
  }
  const bound = vaultBinding(r, v);
  if (bound.poolWrong) throw new Error(VAULT_POOL_WRONG);
  if (bound.nftWrong) throw new Error(VAULT_NFT_WRONG);
  return v;
}

/**
 * Verify the launch on-chain (tax immutable and withdrawable only by our distributor,
 * supply fixed, pool live, LP locked) and register it with the factory distributor.
 */
export async function registerLaunch(conn: Connection, cfg: Config, r: LaunchRecord) {
  if (r.kind === "curve") return registerCurve(conn, cfg, r);
  if (!r.pool) throw new Error("This launch's record has no pool, so it can't be checked.");
  const s = await launchStatus(conn, cfg, r);
  if (!s.token || !s.pool || !s.lock) throw new Error("Launch is not complete yet (token, pool and LP lock are all required).");
  const mint = unpackMint(new PublicKey(r.mint), await conn.getAccountInfo(new PublicKey(r.mint), "confirmed"), TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mint);
  if (!fee || !fee.withdrawWithheldAuthority.equals(withdrawAuthorityOf(cfg, r)) || !fee.transferFeeConfigAuthority.equals(PublicKey.default)
      || mint.mintAuthority !== null) {
    throw new Error("Token does not match the factory launch (fee authorities or mint authority differ).");
  }
  // The creator starts the vault (its own step); registering only checks it, so it can be retried.
  const vault = r.taxVault ? await checkVault(conn, cfg, r) : null;
  if (r.registeredAt) return r;
  await checkPoolAndLock(conn, cfg, r, getTransferFeeConfig(mint)!.newerTransferFee.transferFeeBasisPoints, vault?.creatorNft);
  // The vault's own lock: it's what pays the creator, even if the creator made another lock first.
  return writeTokenConfig(cfg, r, vault?.creatorNft.toBase58() ?? s.lockNft!);
}

/** Floor square root of a bigint. */
export function isqrt(n: bigint) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/**
 * Whether the pool and the lock are the launch the record describes, or why not. Reserves
 * move with every trade, but their product only grows (trading fees, deposits): it starts at
 * about (1 − tax) × supply × pool XNT, since the token's own tax is withheld on its way into
 * the pool. So a pool built with a sliver of the supply, or with most of its liquidity taken
 * out before the lock, falls far short, while trading after launch can't (a creator who kept
 * tokens back could only match it by paying the XNT a buyer would). The locked LP must be
 * about all of the LP the pool started with (√ of that product): a creator who kept LP could
 * take liquidity out later. Margins: 2% on the product, 1% on the LP.
 */
export function poolLockProblem(p: { poolTokens: bigint; poolQuote: bigint; taxBps: number; reserveToken: bigint; reserveQuote: bigint; lockedLp: bigint }): string | null {
  const start = p.poolTokens * p.poolQuote * BigInt(10_000 - p.taxBps) / 10_000n;
  if (p.reserveToken * p.reserveQuote * 100n < start * 98n) return "The pool holds less than the launch put in (it was built with fewer tokens, or liquidity was taken out).";
  if (p.lockedLp * 100n < isqrt(start) * 99n) return "Less LP is locked than the pool started with: the whole LP must be locked.";
  return null;
}

/** LP a lock took in: what it holds plus the fee LP already collected from it. */
const lpTakenIn = (l: { lockedLp: bigint; feeLpCollected: bigint }) => l.lockedLp + l.feeLpCollected;
const LOCK_MORE = " One lock must hold at least 99% of the pool's starting LP: lock the LP you still hold in a single lock, then start the vault. LP already in a smaller lock can't be moved into it, so if too much is in smaller locks, this launch can't be listed.";

/** `vaultNft`: a vault launch's creator NFT. That one lock must hold the LP alone, so a thin lock on the right pool can't stand in. */
async function poolLockProblemOf(conn: Connection, cfg: Config, r: LaunchRecord, taxBps: number, vaultNft?: PublicKey) {
  const pair = pairOf(cfg, r);
  const quoteInfo = pair.xntPool ? await conn.getAccountInfo(pair.mint, "confirmed") : null;
  const quoteDecimals = quoteInfo ? unpackMint(pair.mint, quoteInfo, quoteInfo.owner).decimals : 9;
  const mint = new PublicKey(r.mint), creator = new PublicKey(r.creator);
  const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(r.pool), mint, pair.mint);
  const locks = (await listLocks(conn, new PublicKey(cfg.locker!.programId), new PublicKey(r.pool))).filter((l) => l.locker.equals(creator) && (!vaultNft || l.nftMint.equals(vaultNft)));
  if (vaultNft && !locks.length) return VAULT_NFT_WRONG;
  return poolLockProblem({
    poolTokens: toBaseUnits(r.poolTokens, DECIMALS), poolQuote: toBaseUnits(r.poolXnt, quoteDecimals), taxBps,
    reserveToken: snap.reserveToken, reserveQuote: snap.reserveQuote,
    lockedLp: locks.reduce((t, l) => t + lpTakenIn(l), 0n),
  });
}

async function checkPoolAndLock(conn: Connection, cfg: Config, r: LaunchRecord, taxBps: number, vaultNft?: PublicKey) {
  const problem = await poolLockProblemOf(conn, cfg, r, taxBps, vaultNft);
  if (problem) throw new Error(`This launch can't be listed: ${problem}`);
}

/** Who must be able to withdraw the tax: the vault's auth PDA for a vault token, else its distributor wallet. */
function withdrawAuthorityOf(cfg: Config, r: LaunchRecord) {
  if (!r.taxVault) return new PublicKey(r.distributor);
  return vaultAuthPda(vaultProgramOf(cfg, r), new PublicKey(r.mint));
}

/**
 * Register a graduated curve token with the factory distributor, or as a Tax Vault token.
 * The checks differ from a normal launch: the LP lock is owned by the curve's auth PDA (its
 * NFT went to the creator), the pool is the one the curve recorded, and the mint authority
 * stays with the auth PDA until the last buyer's tokens are delivered (the program then
 * removes it). A vault curve token is registered before its vault exists: the creator
 * starts it after graduation, and the vault crank waits for it (the distributor never
 * serves it). The program doesn't tie that vault to the curve's pool and lock, so the crank
 * compares them with this record each pass (vaultBinding) before it sells.
 */
async function registerCurve(conn: Connection, cfg: Config, r: LaunchRecord) {
  const id = cfg.factory?.curve?.programId;
  if (!id) throw new Error("The bonding curve isn't enabled on this site.");
  const program = new PublicKey(id);
  const mintKey = new PublicKey(r.mint);
  const c = await readCurveOf(conn, cfg, r);
  if (!c || !isGraduated(c.status)) throw new Error("This curve hasn't graduated yet.");
  if (isLpBurned(c)) throw new Error(LP_BURNED_ERROR);
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
  const listed = { ...r, pool: c.pool.toBase58(), lockNft: c.lockNft.toBase58() };
  if (r.taxVault) {
    // The creator may have started the vault already, and could name another pool or lock (the program doesn't stop them).
    const addr = vaultPda(vaultProgramOf(cfg, r), mintKey);
    const info = await conn.getAccountInfo(addr, "confirmed");
    if (info) {
      const bound = vaultBinding(listed, decodeVault(addr, info.data));
      if (bound.poolWrong) throw new Error(VAULT_POOL_WRONG);
      if (bound.nftWrong) throw new Error(VAULT_NFT_WRONG);
    }
  }
  return writeTokenConfig(cfg, listed, c.lockNft.toBase58());
}

/** The token's own distributor config (factory/launches/<mint>/config.json); marks the launch registered. */
function writeTokenConfig(cfg: Config, r: LaunchRecord, lockNft: string) {
  const dir = launchDir(r.mint);
  // A launch not yet moved out of the journal gets its directory and key first.
  if (isPendingLaunch(r.mint)) writeLaunch(r);
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
