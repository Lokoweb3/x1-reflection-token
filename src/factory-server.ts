/**
 * Token factory: a launch page where anyone connects a wallet and launches a tax token
 * whose tax pays holders in XNT (with auto-LP), with its launch LP locked in an NFT.
 *
 *   npm run factory                     # http://127.0.0.1:8124 (factory.port in config.json)
 *
 * "/" is the 99 + Tax landing page, "/launch" the launch app.
 *
 * The creator's wallet signs every transaction; the server only builds them, co-signs
 * with the new mint's throwaway key, and broadcasts what the wallet signed. Each token
 * gets its own distributor wallet, generated and kept here (factory/launches/<mint>/),
 * which `npm run factory:distribute` uses to collect, sell and pay out that token's tax.
 *
 * It listens on 127.0.0.1 by default. To make it public, put it behind a reverse proxy
 * (HTTPS) and list the public host name in factory.hosts.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, calculateEpochFee } from "@solana/spl-token";
import { FACTORY_DIR, ROOT, connection, loadConfig } from "./config.js";
import { pinnedRecoveryFile, recoveryUrl } from "./recovery/pinned.js";
import { payoutToken, payoutTokenJson, payoutTokensOn } from "./factory/payout.js";
import { allowRelayProgram, networkFee, sendSigned, unsignedTx } from "./web/wallet-tx.js";
import {
  CREATOR_BPS, CREATOR_REWARD, XNT_PAIR, type Pair, pairOf, applyMetadataUpdate, buildLockStep, buildMetadataUpdate, launchFee, tokenMetadataJson, buildPoolStep, buildTokenStep, creatorExcluded, launchStatus, listLaunches,
  readLaunch, registerLaunch,
  registeredLaunches, validateParams,
} from "./factory/launch.js";
import { XDEX_CREATE } from "./xdex.js";
import { readRewardVault, rewardSummary } from "./locker.js";
import { DUST_LAMPORTS, buildClaimReward, buildCollect, buildReceipt, buildReceiptIpfs, nftArt, receiptHash, receiptImage } from "./locker-tx.js";
import { receiptData, receiptSvg, receiptUri } from "./web/receipt.js";
import { isqrt, listLocks, lockPda, lockedLp, nftHolder, pendingFeeLp } from "./locker.js";
import { cpmmOut, snapshot, spotValue } from "./xdex.js";
import { positions, refreshTrades, type Position } from "./trades.js";
import { tokenPools } from "./pools.js";
import { checkCaptcha, faucetClaim, faucetFundIxs, faucetStatus } from "./factory/faucet.js";
import { MAX_LOGO_BYTES, MAX_RECEIPT_PNG_BYTES, ipfsEnabled, pinLogo } from "./factory/ipfs.js";
import { buildMintPass, buildTree, claimPassIx, decodePass, listPasses, passPda, readHolderPool } from "./holder-pass.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getTokenMetadata, getTransferFeeConfig, unpackAccount } from "@solana/spl-token";
import { findTarget, readiness, runCycle, targets, tipInstruction, verifyTip } from "./factory/trigger.js";
import { Config, fromBaseUnits, toBaseUnits } from "./config.js";
import { BURN_OWNERS, eligibleBalances, scanTokenAccounts } from "./holders.js";
import { poolAuthority } from "./xdex.js";
import { unpackMint } from "@solana/spl-token";
import { buildCurveStep, validateCurveParams } from "./factory/launch.js";
import { curveService } from "./factory/curve.js";
import { DEFAULT_TARGET_XNT, targetsFor } from "./curve.js";
import { vaultService } from "./factory/vault.js";
import { buildVaultStep, isVaultLaunch } from "./factory/launch.js";
import { REWARD_TOKEN, rewardTokenInfo } from "./taxvault.js";


const cfg = loadConfig();
const conn = connection(cfg);
const f = cfg.factory;
if (cfg.network === "mainnet" && f?.feeToken) {
  console.warn(`factory.feeToken (${f.feeToken.symbol}) is testnet-only and is ignored on mainnet; the launch fee is ${f.feeUsdc} USDC.`);
}
if (!f?.feeReceiver) throw new Error("Set factory.feeReceiver (and factory.feeUsdc) in config.json.");
if (!cfg.locker?.programId) throw new Error("Set locker.programId in config.json.");
const port = f.port ?? 8124;
const bind = f.bind ?? "127.0.0.1";
const publicUrl = f.publicUrl ?? `http://127.0.0.1:${port}`;
const explorer = `https://explorer.${cfg.network}.x1.xyz`;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(f.hosts ?? [])]);
for (const id of [cfg.xdex.programId, cfg.locker?.programId]) if (id) allowRelayProgram(id);
const LANDING = path.join(ROOT, "src", "landing.html");
const PAGE = path.join(ROOT, "src", "factory.html");
const NFT_PAGE = path.join(ROOT, "src", "nft.html");
const TOKENS_PAGE = path.join(ROOT, "src", "tokens.html");
const ANALYTICS_PAGE = path.join(ROOT, "src", "analytics.html");
const WALLET_PAGE = path.join(ROOT, "src", "wallet.html");
const FAUCET_PAGE = path.join(ROOT, "src", "faucet.html");
const LEADERBOARD_PAGE = path.join(ROOT, "src", "leaderboard.html");
const CURVE_PAGE = path.join(ROOT, "src", "curve.html");
/** Serve a page; without a faucet (e.g. mainnet), leave its "Faucet" tab out, and the "Curve" tab without the curve program. */
function page(file: string) {
  let html = fs.readFileSync(file, "utf8");
  if (!faucetOn()) html = html.replace(/\s*<a href="\/faucet"[^>]*>Faucet<\/a>/g, "");
  if (!curves) html = html.replace(/\s*<a href="\/curve"[^>]*>Curve<\/a>/g, "");
  return html;
}
/** Bonding-curve launches: on only when factory.curve.programId is set. */
const curves = f.curve?.programId ? curveService(conn, cfg, { microLamports: cfg.distribution.priorityMicroLamports }) : null;
if (curves) allowRelayProgram(curves.program.toBase58());
const faucetOn = () => cfg.network === "testnet" && !!cfg.factory?.faucet && !!cfg.factory?.feeToken
  && fs.existsSync(path.isAbsolute(cfg.factory.faucet.keypair) ? cfg.factory.faucet.keypair : path.join(ROOT, cfg.factory.faucet.keypair));
/** Site themes: each file holds its fonts and colour tokens, then (after the AFTER BASE marker) extras. */
const THEMES = ["receipt", "arcade", "lunchbag", "notebook", "space", "desert", "casino"] as const;
function themeCss(name: string) {
  const [head, extra = ""] = fs.readFileSync(path.join(ROOT, "src", "web", `theme-${name}.css`), "utf8").split("/* AFTER BASE */");
  return head + fs.readFileSync(path.join(ROOT, "src", "web", "theme-base.css"), "utf8") + extra;
}
const WALLET_JS = path.join(ROOT, "src", "web", "wallet.js");
const COUNTDOWN_JS = path.join(ROOT, "src", "web", "countdown.js");
const I18N_JS = path.join(ROOT, "src", "web", "i18n.js");
const WEB3_BUNDLE = path.join(ROOT, "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
const opts = { microLamports: cfg.distribution.priorityMicroLamports };
/** Tax Vault: on only when factory.taxVault.programId is set (the crank also needs publisherKeypair). */
const vaults = f.taxVault?.programId ? vaultService(conn, cfg, opts) : null;
if (vaults) allowRelayProgram(vaults.program.toBase58());
/** The vault's auth PDA for a vault token (holds its collected tax; never a holder), else null. */
const vaultAuthFor = (mint: string) => (vaults?.isVaultMint(mint) ? vaults.authOf(mint).toBase58() : null);

/** Legacy (hot-wallet distributor) tokens: the network's configured creator reward (native XNT on testnet, USDC.X on mainnet). */
const rewardMint = new PublicKey(CREATOR_REWARD[cfg.network].rewardMint ?? NATIVE_MINT);
const rewardSymbol = CREATOR_REWARD[cfg.network].rewardMint ? "USDC" : "XNT";
const rewardDecimals = CREATOR_REWARD[cfg.network].rewardMint ? 6 : 9;
const rewardMeta = (mint: PublicKey) => (mint.equals(rewardMint) ? { symbol: rewardSymbol, decimals: rewardDecimals }
  : rewardTokenInfo(cfg.network, mint) ?? { symbol: `${mint.toBase58().slice(0, 4)}…`, decimals: 9 });

/**
 * The reward mints a token's lock NFT may hold creator rewards in, the one it's paid in now
 * first. A Tax Vault token is paid in its vault's reward mint (XNM on testnet); its creator
 * may still have an older XNT vault from before the vault's upgrade. Other tokens: the
 * configured one only.
 */
async function rewardMintsFor(tokenMint: string | null | undefined): Promise<PublicKey[]> {
  if (!tokenMint || !vaults?.isVaultMint(tokenMint)) return [rewardMint];
  const out: PublicKey[] = [];
  for (const m of [await vaults.rewardMintOf(tokenMint), NATIVE_MINT, rewardMint]) if (!out.some((x) => x.equals(m))) out.push(m);
  return out;
}

/** One reward vault of a lock NFT, in reward-token base units. */
async function rewardVaultView(lockNft: PublicKey, mint: PublicKey) {
  const { symbol, decimals } = rewardMeta(mint);
  const v = await readRewardVault(conn, new PublicKey(cfg.locker!.programId), lockNft, mint);
  if (!v) return { claimable: "0", vesting: "0", claimed: "0", nextUnlock: null as number | null, nextAmount: "0", symbol, decimals, mint: mint.toBase58() };
  const s = rewardSummary(v);
  return { claimable: s.claimable.toString(), vesting: s.vesting.toString(), claimed: s.totalClaimed.toString(), nextUnlock: s.nextUnlock,
    nextAmount: s.nextAmount.toString(), symbol, decimals, mint: mint.toBase58() };
}

/**
 * Creator rewards for a launch's lock NFT: the reward token it's paid in now, plus
 * `others`, any other reward vault of the NFT still holding something (a vault token's
 * older XNT rewards). Amounts in the reward token's base units.
 */
async function creatorRewards(lockNft: string | null | undefined, tokenMint?: string | null) {
  if (!lockNft) return null;
  const nft = new PublicKey(lockNft);
  const [main, ...rest] = await Promise.all((await rewardMintsFor(tokenMint)).map((m) => rewardVaultView(nft, m)));
  return { ...main, others: rest.filter((r) => BigInt(r.claimable) + BigInt(r.vesting) > 0n) };
}

/** The reward mint a claim asks for (`body.rewardMint`), which must be one this NFT's token pays in; else the current one. */
async function claimMint(tokenMint: string | null | undefined, asked: unknown) {
  const allowed = await rewardMintsFor(tokenMint);
  if (asked === undefined || asked === null || asked === "") return allowed[0];
  const m = new PublicKey(String(asked));
  if (!allowed.some((x) => x.equals(m))) throw new Error("This NFT's creator rewards aren't paid in that token.");
  return m;
}

// ---------- Pair tokens (launches paired with JACK instead of XNT) ----------

/** Pair tokens a launch may choose besides XNT (factory.quoteTokens). */
const quoteTokens = f.quoteTokens ?? [];
const xdexId = new PublicKey(cfg.xdex.programId);

/** A token's pair: from its launch record, or config.json for the main token; XNT otherwise. */
function pairForMint(mint: string): Pair {
  let r = null;
  try { r = readLaunch(mint); } catch { /* not a launch */ }
  if (r) return pairOf(cfg, r);
  if (cfg.mint === mint && cfg.xdex.quoteMint) {
    return { symbol: cfg.xdex.quoteSymbol ?? "pair", mint: new PublicKey(cfg.xdex.quoteMint), xntPool: new PublicKey(cfg.xdex.quoteXntPool!) };
  }
  return XNT_PAIR;
}

/**
 * Values a pair token in XNT at its XNT pool's spot price (cached 30 s). For XNT itself
 * the identity. `xntPer` is XNT per whole pair token.
 */
const pairPriceCache = new Map<string, { at: number; snap: Promise<{ reserveToken: bigint; reserveQuote: bigint; decimals: number }> }>();
async function pairValue(pair: Pair) {
  if (!pair.xntPool) return { symbol: "XNT", toXnt: (v: bigint) => v, xntPer: 1 };
  const key = pair.xntPool.toBase58();
  let hit = pairPriceCache.get(key);
  if (!hit || Date.now() - hit.at > 30_000) {
    const snap = Promise.all([snapshot(conn, xdexId, pair.xntPool, pair.mint), conn.getAccountInfo(pair.mint)]).then(([sn, info]) => ({
      reserveToken: sn.reserveToken, reserveQuote: sn.reserveQuote, decimals: unpackMint(pair.mint, info, info!.owner).decimals,
    }));
    hit = { at: Date.now(), snap };
    snap.catch(() => pairPriceCache.delete(key));
    pairPriceCache.set(key, hit);
  }
  const sn = await hit.snap;
  return {
    symbol: pair.symbol, toXnt: (v: bigint) => spotValue(v, sn),
    xntPer: (Number(sn.reserveQuote) / 1e9) / (Number(sn.reserveToken) / 10 ** sn.decimals),
  };
}

/** Which pool/token buildCollect acts on, with the pair valued in XNT for non-XNT pools. */
async function whereFor(pool: string, mint: string, symbol: string) {
  const pair = pairForMint(mint);
  const base = { pool: new PublicKey(pool), mint: new PublicKey(mint), symbol, quoteSymbol: pair.symbol };
  return pair.xntPool ? { ...base, quoteToXnt: (await pairValue(pair)).toXnt } : base;
}

/** Refuse early, in plain words, when a wallet holds less than `amount` of the pair token. */
async function requirePairTokens(wallet: PublicKey, pair: Pair, amount: string, what: string) {
  const info = await conn.getAccountInfo(pair.mint);
  if (!info) throw new Error(`${pair.symbol} not found on this network`);
  const m = unpackMint(pair.mint, info, info.owner);
  // Pool maths and the distributor assume the pair token arrives in full.
  if (getTransferFeeConfig(m)) throw new Error(`${pair.symbol} has a transfer fee, so it can't be used as a pair.`);
  const ata = getAssociatedTokenAddressSync(pair.mint, wallet, false, info.owner);
  const acc = await conn.getAccountInfo(ata);
  const have = acc ? unpackAccount(ata, acc, info.owner).amount : 0n;
  if (have < toBaseUnits(amount, m.decimals)) {
    throw new Error(`${what} needs ${amount} ${pair.symbol} in this wallet; it has ${fromBaseUnits(have, m.decimals)}. Get ${pair.symbol} first (it trades on XDEX), or use less for the pool.`);
  }
}

/** Metadata updates waiting for their on-chain transaction (applied by /api/launch/metadata/confirm). */
const pendingMeta = new Map<string, { uri: string; next: Record<string, unknown>; at: number }>();
/**
 * Request limits. Each is per client address and also site-wide, since addresses can be
 * rotated: the site-wide cap is the safety net for what costs us (RPC calls, the
 * Pinata quota, files on disk).
 */
class RateLimited extends Error {}
const buckets = new Map<string, number[]>();
function limit(name: string, key: string, max: number, windowMs: number, message: string) {
  const now = Date.now();
  const id = `${name}:${key}`;
  const hits = (buckets.get(id) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw new RateLimited(message);
  hits.push(now);
  buckets.set(id, hits);
}
const LIMITS = {
  // name: [per address, site-wide (0: none), window ms]. Plain reads get no site-wide cap
  // (that would let one client lock everyone out); they're served from caches.
  get: [120, 0, 60_000], post: [30, 0, 60_000], send: [20, 300, 60_000],
  launch: [10, 60, 3_600_000], upload: [20, 200, 3_600_000], faucet: [5, 200, 3_600_000],
} as const;
function rateLimit(kind: keyof typeof LIMITS, ip: string, what = "requests") {
  if (ip === "127.0.0.1" || ip === "::1") return; // this machine, not through the proxy (local use)
  const [perIp, total, windowMs] = LIMITS[kind];
  limit(kind, ip, perIp, windowMs, `Too many ${what} from this address; try again later.`);
  if (total) limit(kind, "*", total, windowMs, `The site is getting too many ${what} right now; try again in a few minutes.`);
}
setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of buckets) if (!hits.some((t) => now - t < 3_600_000)) buckets.delete(id);
}, 600_000).unref();

function readJson(req: http.IncomingMessage, max = 64_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > max) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); } });
  });
}

/** Only the wallet holding a lock NFT may collect or claim with it (the locker checks too; this gives a clear message). */
async function requireNftHolder(nft: PublicKey, wallet: PublicKey) {
  const h = await nftHolder(conn, nft);
  if (!h || !h.owner.equals(wallet)) throw new Error(`Only the wallet holding this LP-lock NFT${h ? ` (${h.owner.toBase58().slice(0, 4)}…${h.owner.toBase58().slice(-4)})` : ""} can collect or claim.`);
}

/** Refuse early, in plain words, when a wallet can't cover `need` XNT (pool, XDEX's fee, gas and network fees). */
async function requireXnt(wallet: PublicKey, need: number, what: string, forWhat?: string) {
  const have = (await conn.getBalance(wallet)) / 1e9;
  if (have < need) {
    const f2 = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    throw new Error(forWhat
      ? `${what} needs about ${f2(need)} XNT in this wallet (${forWhat}); it has ${f2(have)}. Add XNT.`
      : `${what} needs about ${f2(need)} XNT in this wallet (the pool's XNT, XDEX's pool fee and network fees); it has ${f2(have)}. Add XNT, or use less XNT for the pool.`);
  }
}

/** The launch record for `mint`, checked to belong to `creator`. */
function ownLaunch(body: Record<string, unknown>) {
  const r = readLaunch(String(body.mint));
  if (!r) throw new Error("Unknown launch");
  if (r.creator !== new PublicKey(String(body.creator)).toBase58()) throw new Error("This launch belongs to another wallet");
  return r;
}

/** Receipt printing: to IPFS when a PNG came with the request and uploads are on, else on-chain. */
function receiptIxs(authority: PublicKey, nftMint: PublicKey, png: unknown, ip: string) {
  if (typeof png === "string" && png && ipfsEnabled(cfg)) {
    rateLimit("upload", ip, "receipt uploads");
    return buildReceiptIpfs(conn, cfg, authority, nftMint, Buffer.from(png, "base64"), `${publicUrl.replace(/\/$/, "")}/nft/${nftMint.toBase58()}`);
  }
  return buildReceipt(conn, cfg, authority, nftMint);
}

async function post(url: string, body: Record<string, unknown>, ip: string) {
  if (url === "/api/launch/token") {
    if (f!.launchesPaused) throw new Error(f!.launchesPaused.message ?? "New launches are paused for a short while. Launches already started can still be finished.");
    rateLimit("launch", ip, "launches started");
    const p = validateParams(body, quoteTokens.map((q) => q.symbol));
    if (f!.lockForeverOnly && p.lockDays !== null) throw new Error("Launches on this site lock their liquidity forever.");
    // Check the wallet can afford the whole launch before step 1 charges the fee: otherwise
    // a creator pays the launch fee and then gets stuck at the pool step.
    const pair = pairOf(cfg, p);
    if (!pair.xntPool) {
      // A Tax Vault launch has no distributor wallet to pre-fund.
      const gas = isVaultLaunch(cfg, pair) ? 0 : Number(f!.gasXnt ?? "0.05");
      await requireXnt(new PublicKey(p.creator), Number(p.poolXnt) + ((await poolCreateFee()) ?? 0.1) + gas + 0.05,
        `Launching with ${p.poolXnt} XNT in the pool`);
    } else {
      // A JACK pair: the pool's JACK from the creator's JACK, everything else (XDEX's pool fee, gas, fees) in XNT.
      const worth = Number(p.poolXnt) * (await pairValue(pair)).xntPer;
      if (!(worth >= 0.01)) throw new Error(`Pool ${pair.symbol} must be worth at least 0.01 XNT (${p.poolXnt} ${pair.symbol} ≈ ${worth.toPrecision(3)} XNT).`);
      await requirePairTokens(new PublicKey(p.creator), pair, p.poolXnt, `Launching with ${p.poolXnt} ${pair.symbol} in the pool`);
      await requireXnt(new PublicKey(p.creator), ((await poolCreateFee()) ?? 0.1) + Number(f!.gasXnt ?? "0.05") + 0.05,
        `Launching with a ${pair.symbol} pool`, `XDEX's pool fee, the distributor's gas and network fees`);
    }
    // A payout token: checked in full now (pool, freeze authority, extensions), before step 1 charges the fee.
    if (p.payoutMint) {
      if (!isVaultLaunch(cfg, pair)) throw new Error("Paying holders in another token needs a Tax Vault launch.");
      await payoutToken(conn, cfg, p.payoutMint);
    }
    const { ixs, signers, record } = await buildTokenStep(conn, cfg, p, publicUrl);
    return { tx: await unsignedTx(conn, new PublicKey(p.creator), ixs, signers, opts), mint: record.mint };
  }
  if (url === "/api/launch/pool") {
    const r = ownLaunch(body);
    if (r.kind === "curve") throw new Error("A curve token's pool is created by the curve when it graduates.");
    const s = await launchStatus(conn, cfg, r);
    if (!s.token) throw new Error("Step 1 (token) hasn't confirmed yet.");
    if (s.pool) throw new Error("The pool already exists.");
    const pair = pairOf(cfg, r);
    if (!pair.xntPool) {
      await requireXnt(new PublicKey(r.creator), Number(r.poolXnt) + ((await poolCreateFee()) ?? 0.1) + 0.03, `Creating the pool with ${r.poolXnt} XNT`);
    } else {
      await requirePairTokens(new PublicKey(r.creator), pair, r.poolXnt, `Creating the pool with ${r.poolXnt} ${pair.symbol}`);
      await requireXnt(new PublicKey(r.creator), ((await poolCreateFee()) ?? 0.1) + 0.03, `Creating the ${pair.symbol} pool`, `XDEX's pool fee and network fees`);
    }
    const { ixs } = await buildPoolStep(conn, cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], opts) };
  }
  if (url === "/api/launch/lock") {
    const r = ownLaunch(body);
    if (r.kind === "curve") throw new Error("A curve token's LP is locked by the curve when it graduates.");
    const s = await launchStatus(conn, cfg, r);
    if (!s.pool) throw new Error("Step 2 (pool) hasn't confirmed yet.");
    if (s.lock) throw new Error("The LP is already locked.");
    const { ixs, signers } = await buildLockStep(conn, cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, signers, opts) };
  }
  if (url === "/api/launch/vault") {
    // Tax Vault launches, after the lock (a curve token: after graduation): the creator starts the vault (init_vault).
    const r = ownLaunch(body);
    const s = await launchStatus(conn, cfg, r);
    if (!s.lock || !s.lockNft) throw new Error(r.kind === "curve" ? "The curve hasn't graduated yet; the tax vault starts after graduation." : "Step 3 (LP lock) hasn't confirmed yet.");
    const ixs = await buildVaultStep(conn, cfg, r, s.lockNft);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], { ...opts, units: 200_000 }) };
  }
  if (url === "/api/launch/receipt") {
    // Print the lock receipt into the NFT: a PNG + metadata JSON on IPFS when the browser sent
    // the PNG (what wallets show), else the JSON + SVG in the on-chain metadata.
    const r = ownLaunch(body);
    const nft = r.lockNft ?? (await launchStatus(conn, cfg, r)).lockNft;
    if (!nft) throw new Error("The LP isn't locked yet.");
    const { ixs } = await receiptIxs(new PublicKey(r.creator), new PublicKey(nft), body.png, ip);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], { ...opts, noBudget: true }) };
  }
  // Withdraw from a lock NFT (any lock, RFLT or a launch): the NFT holder's wallet signs.
  if (url === "/api/faucet") {
    rateLimit("faucet", ip, "faucet claims");
    await checkCaptcha(cfg, body.captcha, ip);
    return faucetClaim(conn, cfg, String(body.wallet), ip);
  }
  if (url === "/api/upload-logo") {
    // Straight through to IPFS; nothing is kept here. Limited per IP to protect the Pinata quota.
    rateLimit("upload", ip, "logo uploads");
    const bytes = Buffer.from(String(body.data ?? ""), "base64");
    return pinLogo(cfg, bytes, String(body.name ?? "logo"));
  }
  if (url === "/api/faucet/fund") {
    const from = new PublicKey(String(body.wallet));
    const ixs = await faucetFundIxs(conn, cfg, from.toBase58(), String(body.tokens ?? ""), String(body.xnt ?? ""));
    return { tx: await unsignedTx(conn, from, ixs, [], opts) };
  }
  if (url === "/api/pass/mint") {
    const owner = new PublicKey(String(body.owner));
    const t = findTarget(cfg, String(body.tokenMint));
    if (!claimsOn(t)) throw new Error("This token pays holders directly; it doesn't use holder passes.");
    const programId = new PublicKey(cfg.locker!.programId);
    if (!(await readHolderPool(conn, programId, new PublicKey(t.mint)))) throw new Error("This token's pass pool isn't set up yet; it's created on the next distribution cycle.");
    const { ixs, signers, passMint } = await buildMintPass(conn, programId, owner, new PublicKey(t.mint), t.symbol);
    return { tx: await unsignedTx(conn, owner, ixs, signers, opts), passMint: passMint.toBase58() };
  }
  if (url === "/api/pass/claim") {
    const holder = new PublicKey(String(body.holder));
    const passMint = new PublicKey(String(body.passMint));
    const programId = new PublicKey(cfg.locker!.programId);
    const info = await conn.getAccountInfo(passPda(programId, passMint), "confirmed");
    if (!info) throw new Error("That isn't a holder pass.");
    const pass = decodePass(passPda(programId, passMint), info.data);
    const t = findTarget(cfg, pass.tokenMint.toBase58());
    const cumulative: Record<string, string> = tokenState(t.stateDir).claims?.cumulative ?? {};
    const earned = BigInt(cumulative[passMint.toBase58()] ?? "0");
    if (earned <= pass.claimed) throw new Error("Nothing to claim yet: new rewards are added at the next distribution cycle.");
    const { root, proofs } = buildTree(cumulative);
    const pool = await readHolderPool(conn, programId, pass.tokenMint);
    if (!pool || !pool.root.equals(root)) throw new Error("The rewards list is being updated right now; try again in a minute.");
    const ix = claimPassIx(programId, holder, pass.tokenMint, passMint, earned, proofs[passMint.toBase58()]);
    return { tx: await unsignedTx(conn, holder, [ix], [], opts), amount: (earned - pass.claimed).toString() };
  }
  if (url === "/api/nft/receipt") {
    // Print or refresh the receipt in any lock NFT; only its update authority can sign.
    const authority = new PublicKey(String(body.authority));
    const { ixs } = await receiptIxs(authority, new PublicKey(String(body.nftMint)), body.png, ip);
    return { tx: await unsignedTx(conn, authority, ixs, [], { ...opts, noBudget: true }) };
  }
  if (url === "/api/nft/collect" || url === "/api/nft/claim") {
    const nft = new PublicKey(String(body.nftMint));
    const holder = new PublicKey(String(body.holder));
    await requireNftHolder(nft, holder);
    if (url === "/api/nft/claim") {
      const tokenMint = (await receiptData(conn, cfg, nft))?.tokenMint ?? null;
      const { ixs } = await buildClaimReward(conn, cfg, holder, nft, await claimMint(tokenMint, body.rewardMint));
      return { tx: await unsignedTx(conn, holder, ixs, [], opts) };
    }
    const d = await receiptData(conn, cfg, nft);
    if (!d) throw new Error("That isn't an LP-lock NFT from this locker.");
    const { ixs, summary } = await buildCollect(conn, cfg, holder, nft, false, await nftTarget(d));
    if (!ixs) throw new Error(summary.feeLp > 0n ? "Fees ready are still dust; wait for more trading." : "No trading fees to collect yet.");
    return { tx: await unsignedTx(conn, holder, ixs, [], opts) };
  }
  // Update a launched token's logo / description / links. The launch record only changes
  // once the creator-signed transaction is on-chain (see /api/launch/metadata/confirm).
  if (url === "/api/launch/metadata") {
    const r = ownLaunch(body);
    const { ixs, uri, next } = await buildMetadataUpdate(conn, cfg, r, body, publicUrl);
    pendingMeta.set(r.mint, { uri, next, at: Date.now() });
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], opts), uri };
  }
  if (url === "/api/launch/metadata/confirm") {
    const r = readLaunch(String(body.mint));
    const p = r && pendingMeta.get(r.mint);
    if (!r || !p) throw new Error("No metadata update waiting for this token.");
    const md = await getTokenMetadata(conn, new PublicKey(r.mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    if (md?.uri !== p.uri) throw new Error("The token's on-chain link doesn't show the update yet.");
    applyMetadataUpdate(r, p.next);
    pendingMeta.delete(r.mint);
    tokenListCache = null;
    return { updated: true };
  }
  if (url === "/api/launch/register") {
    const r = await registerLaunch(conn, cfg, ownLaunch(body));
    return { registered: !!r.registeredAt };
  }
  if (url === "/api/launch/claim-reward") {
    const r = readLaunch(String(body.mint));
    if (!r) throw new Error("Unknown launch");
    const holder = new PublicKey(String(body.holder));
    const nft = r.lockNft ?? (await launchStatus(conn, cfg, r)).lockNft;
    if (!nft) throw new Error("This launch has no lock NFT yet.");
    await requireNftHolder(new PublicKey(nft), holder);
    const { ixs } = await buildClaimReward(conn, cfg, holder, new PublicKey(nft), await claimMint(r.mint, body.rewardMint));
    return { tx: await unsignedTx(conn, holder, ixs, [], opts) };
  }
  if (url === "/api/distribute/tip") {
    const t = findTarget(cfg, String(body.mint));
    if (vaultAuthFor(t.mint)) throw new Error("This token's tax is handled by the Tax Vault program; its crank runs on its own, no tip needed.");
    const r = await readiness(conn, cfg, t);
    if (!r.ready) throw new Error(r.reason ?? "Not ready");
    const payer = new PublicKey(String(body.payer));
    return { tx: await unsignedTx(conn, payer, [tipInstruction(payer, t, tipLamports)], [], opts), tipXnt };
  }
  if (url === "/api/distribute/run") {
    const t = findTarget(cfg, String(body.mint));
    if (vaultAuthFor(t.mint)) throw new Error("This token's tax is handled by the Tax Vault program; its crank runs on its own.");
    const clicker = await verifyTip(conn, t, String(body.signature), tipLamports);
    const r = await readiness(conn, cfg, t);
    if (r.reason && !/Not enough tax/.test(r.reason)) throw new Error(`${r.reason} Your tip was added to this token's gas.`);
    runCycle(t, clicker);
    readinessCache.delete(t.mint);
    return { started: true };
  }
  if (url.startsWith("/api/vault/")) return vaults ? vaultPost(url, body) : null;
  if (url.startsWith("/api/curve/")) return curves ? curvePost(url, body, ip) : null;
  if (url === "/api/send") rateLimit("send", ip, "transactions");
  if (url === "/api/send") {
    const signature = await sendSigned(conn, String(body.tx));
    // A curve trade: show it on the next page load instead of after the cache expires.
    if (curves && typeof body.curveMint === "string") { try { curves.invalidate(new PublicKey(body.curveMint).toBase58()); } catch { /* ignore */ } }
    // A creator just started a tax vault: the pages show it at once.
    if (vaults && typeof body.vaultMint === "string") { try { vaults.forget(new PublicKey(body.vaultMint).toBase58()); } catch { /* ignore */ } }
    return { signature };
  }
  return null;
}

/**
 * Tax Vault actions for a visitor's wallet (unsigned transactions; the wallet signs):
 *   crank-tx      "Run the vault now": the permissionless steps due now (collect, sell, add
 *                 liquidity, creator reward, pay / pay_fallback a few wallets), in order, paid
 *                 by `caller`, with the crank reward the sale would earn it
 *   crank-result  what those transactions did (read from the chain) and the reward received
 *   appoint-tx    v3: the guardian (creator) appoints a new publisher once allowed
 */
async function vaultPost(url: string, body: Record<string, unknown>) {
  const v = vaults!;
  const m = /^\/api\/vault\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(crank-tx|crank-result|appoint-tx)$/.exec(url);
  if (!m) return null;
  const [, mint, action] = m;
  if (action === "crank-tx") {
    const caller = new PublicKey(String(body.caller));
    const plan = await v.crankPlan(mint, caller);
    if (!plan.steps.length) throw new Error(`Nothing to run right now: no tax to collect or sell, and nobody is owed a payout.${plan.notes.length ? ` ${plan.notes.join(" ")}` : ""}`);
    // Only the first is simulated here: later ones count on the earlier ones landing (the sale sells what collect adds).
    const txs = [];
    for (const [i, s] of plan.steps.entries()) {
      txs.push({ kind: s.kind, label: s.label, tx: await unsignedTx(conn, caller, s.ixs, [], { ...opts, units: s.units, simulate: i === 0 }) });
    }
    // The fee X1 quotes for exactly these transactions (it bills the compute units each one requests).
    const fees = await Promise.all(txs.map((t) => conn.getFeeForMessage(Transaction.from(Buffer.from(t.tx, "base64")).compileMessage(), "confirmed")
      .then((r) => BigInt(r.value ?? 0)).catch(() => 0n)));
    const fee = fees.reduce((a, b) => a + b, 0n);
    await requireXnt(caller, Number(fee + plan.recordsRent) / 1e9 + 0.002, "Running the vault", "network fees and the payment records' rent");
    return { txs, crankRewardLamports: plan.rewardLamports.toString(), recordsRentLamports: plan.recordsRent.toString(), networkFeeLamports: fee.toString(), notes: plan.notes };
  }
  if (action === "crank-result") {
    const sigs = Array.isArray(body.signatures) ? body.signatures.map(String) : [];
    return v.crankResult(mint, sigs);
  }
  const guardian = new PublicKey(String(body.guardian));
  let newPublisher: PublicKey;
  try { newPublisher = new PublicKey(String(body.newPublisher ?? "").trim()); } catch { throw new Error("The new publisher must be a wallet address."); }
  const ixs = await v.appointIxs(mint, guardian, newPublisher);
  return { tx: await unsignedTx(conn, guardian, ixs, [], opts) };
}

/** Curve launches, buys and sells: unsigned transactions for the viewer's wallet. */
async function curvePost(url: string, body: Record<string, unknown>, ip: string) {
  const c = curves!;
  if (url === "/api/curve/create") {
    if (f!.launchesPaused) throw new Error(f!.launchesPaused.message ?? "New launches are paused for a short while. Launches already started can still be finished.");
    rateLimit("launch", ip, "launches started");
    const p = validateCurveParams(body, cfg.network);
    // A payout token: checked now (pool, freeze authority, extensions); the creator's vault uses it after graduation.
    if (p.payoutMint) {
      if (!isVaultLaunch(cfg, XNT_PAIR)) throw new Error("Paying holders in another token needs a Tax Vault launch.");
      await payoutToken(conn, cfg, p.payoutMint);
    }
    const { ixs, signers, record } = await buildCurveStep(conn, cfg, p, publicUrl, c.program);
    c.invalidate();
    return { tx: await unsignedTx(conn, new PublicKey(p.creator), ixs, signers, opts), mint: record.mint };
  }
  if (url === "/api/curve/buy" || url === "/api/curve/sell") {
    const { ixs, payer, quote } = await (url === "/api/curve/buy" ? c.buildBuy(body) : c.buildSell(body));
    return { tx: await unsignedTx(conn, payer, ixs, [], { ...opts, units: 200_000 }), quote };
  }
  return null;
}

/** One lock NFT for the viewer page: its on-chain receipt image (or a preview) and live lock details. */
async function nftView(mintStr: string) {
  const nft = new PublicKey(mintStr);
  const d = await receiptData(conn, cfg, nft);
  if (!d) throw new Error("That address isn't an LP-lock NFT from this locker.");
  const [meta, holder] = await Promise.all([
    getTokenMetadata(conn, nft, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null), nftHolder(conn, nft),
  ]);
  const art = meta ? await nftArt(cfg, meta.uri) : null;
  const fresh = `data:image/svg+xml,${encodeURIComponent(receiptSvg(d))}`;
  // Trading fees this NFT's liquidity has earned, as its current holder would collect them.
  const fees = holder ? await collectQuote(holder.owner, nft, await nftTarget(d)).catch(() => null) : null;
  return {
    fees, rewards: await creatorRewards(mintStr, d.tokenMint),
    ...d, explorer, name: meta?.name ?? `${d.symbol} LP Lock`,
    image: art?.image ?? fresh, printed: !!art, onIpfs: !!art?.ipfs,
    // The receipt as it should look now, for the browser to draw as a PNG when (re)printing.
    freshReceipt: fresh, receiptPng: ipfsEnabled(cfg),
    // False once the design or the numbers (e.g. pool share) have moved on since it was
    // printed, or (with uploads on) while it's still the old inline-SVG receipt wallets can't show.
    upToDate: !!art && (art.ipfs ? art.hash === receiptHash(d) : !ipfsEnabled(cfg) && art.image === receiptImage(receiptUri(d))),
    holder: holder?.owner.toBase58() ?? null, authority: meta?.updateAuthority?.toBase58() ?? null,
    lock: lockPda(new PublicKey(cfg.locker!.programId), nft).toBase58(),
  };
}

/**
 * Every lock NFT (RFLT and all launches) with what it has earned, in XNT at current pool
 * prices: trading fees already collected, trading fees ready now, and creator rewards
 * (claimed, ready and still vesting). One LP unit is worth 2 x reserveXnt / lpSupply.
 */
let nftsCache: { at: number; data: unknown } | null = null;
let nftsBuilding: Promise<unknown> | null = null;
/**
 * The list is served from the latest copy and refreshed in the background (every minute,
 * and warmed at start-up), so a visitor never waits for the chain reads. Only the very
 * first request after a restart, before the warm-up finishes, waits for it.
 */
function allNfts() {
  const fresh = nftsCache && Date.now() - nftsCache.at < 60_000;
  if (!fresh && !nftsBuilding) {
    nftsBuilding = buildNfts()
      .then((data) => { nftsCache = { at: Date.now(), data }; return data; })
      .catch((e) => { console.error(`NFT list refresh failed: ${e instanceof Error ? e.message : e}`); if (!nftsCache) throw e; return nftsCache.data; })
      .finally(() => { nftsBuilding = null; });
  }
  return nftsCache ? Promise.resolve(nftsCache.data) : nftsBuilding!;
}

/** What X1 charges to collect LP fees. Every collect has the same shape, so quote once per 10 minutes. */
let collectFeeCache: { at: number; fee: bigint | null } | null = null;
async function collectFeeEstimate(sample: { holder: PublicKey; nft: PublicKey; where: Where }) {
  if (collectFeeCache && Date.now() - collectFeeCache.at < 600_000) return collectFeeCache.fee;
  const q = await collectQuote(sample.holder, sample.nft, sample.where).catch(() => null);
  collectFeeCache = { at: Date.now(), fee: q?.networkFee ? BigInt(q.networkFee) : null };
  return collectFeeCache.fee;
}

async function buildNfts() {
  const programId = new PublicKey(cfg.locker!.programId);
  // Every token, and every lock within it, is read in parallel.
  const perToken = await Promise.all(targets(cfg).map(async (t) => {
    const pair = pairForMint(t.mint);
    const [snap, locks, value, where] = await Promise.all([
      snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), new PublicKey(t.mint), pair.mint),
      listLocks(conn, programId, new PublicKey(t.pool)),
      pairValue(pair), whereFor(t.pool, t.mint, t.symbol),
    ]);
    const supply = snap.pool.lpSupply;
    // In XNT: a JACK pool's JACK side is valued at the JACK/XNT pool price.
    const lpXnt = (lp: bigint) => (supply > 0n ? value.toXnt((lp * 2n * snap.reserveQuote) / supply) : 0n);
    const sqrtK = isqrt(snap.reserveToken * snap.reserveQuote);
    return Promise.all(locks.map(async (l) => {
      const [lp, holder, meta, rw] = await Promise.all([
        lockedLp(conn, programId, l.address), nftHolder(conn, l.nftMint),
        getTokenMetadata(conn, l.nftMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null), creatorRewards(l.nftMint.toBase58(), t.mint),
      ]);
      const ready = pendingFeeLp(lp, l.principal, sqrtK, supply);
      const feesCollected = lpXnt(l.feeLpCollected), feesReady = lpXnt(ready);
      const fee = holder ? await collectFeeEstimate({ holder: holder.owner, nft: l.nftMint, where }) : null;
      const view = (x: NonNullable<typeof rw>["others"][number]) => ({ claimed: x.claimed, ready: x.claimable, vesting: x.vesting, nextUnlock: x.nextUnlock,
        nextAmount: x.nextAmount, symbol: x.symbol, decimals: x.decimals, mint: x.mint });
      const rewards = rw ? { ...view(rw), others: rw.others.map(view) } : null;
      // XNT rewards are added in; other reward tokens (XNM, USDC) are listed separately.
      let rewardXnt = 0n;
      for (const x of rw ? [rw, ...rw.others] : []) if (x.symbol === "XNT") rewardXnt += BigInt(x.claimed) + BigInt(x.claimable) + BigInt(x.vesting);
      return {
        nftMint: l.nftMint.toBase58(), symbol: t.symbol, tokenName: t.name, tokenMint: t.mint,
        name: meta?.name ?? `${t.symbol} LP Lock`, receipt: meta ? (await nftArt(cfg, meta.uri))?.image ?? null : null,
        holder: holder?.owner.toBase58() ?? null, lockedAt: l.lockedAt, unlockAt: l.unlockAt,
        lp: lp.toString(), lpSharePct: supply > 0n ? Number((lp * 1_000_000n) / supply) / 10_000 : 0, valueXnt: lpXnt(lp).toString(),
        earned: { feesCollectedXnt: feesCollected.toString(), feesReadyXnt: feesReady.toString(), rewards, totalXnt: (feesCollected + feesReady + rewardXnt).toString(),
          collectFeeXnt: fee === null ? null : fee.toString(),
          collectable: ready > 0n && feesReady >= DUST_LAMPORTS && (fee === null || feesReady > fee) },
      };
    }));
  }));
  return perToken.flat().sort((a, b) => Number(BigInt(b.earned.totalXnt) - BigInt(a.earned.totalXnt)));
}

/**
 * Trading fees an NFT's holder could collect now, the network fee to collect them, and
 * whether collecting is worth it (fees ready > network fee).
 */
type Where = Awaited<ReturnType<typeof whereFor>>;
async function collectQuote(holder: PublicKey, nft: PublicKey, where: Where) {
  const { ixs, summary: s } = await buildCollect(conn, cfg, holder, nft, true, where);
  const fee = ixs ? await networkFee(conn, holder, ixs, opts).catch(() => null) : null;
  return {
    // For a JACK pool: `quoteAmount` is the JACK side, and `xnt` / `worth` are XNT values.
    xnt: s.xntOut.toString(), tokens: s.tokenOut.toString(), worth: s.worth.toString(),
    quote: where.quoteSymbol, quoteAmount: s.quoteOut.toString(),
    networkFee: fee === null ? null : fee.toString(),
    collectable: s.feeLp > 0n && s.worth >= DUST_LAMPORTS && (fee === null || s.worth > fee),
  };
}

const nftTarget = (d: { pool: string; tokenMint: string; symbol: string }) => whereFor(d.pool, d.tokenMint, d.symbol);

/**
 * A chain read that rarely changes, cached for an hour. If a refresh fails (public RPCs
 * rate-limit), the last good value is kept, so pages like /launch never break on it.
 */
function sticky<T>(read: () => Promise<T>, fallback: T, ttlMs = 3_600_000) {
  let value: T | undefined, at = 0, pending: Promise<T> | null = null;
  return (): Promise<T> => {
    if (value !== undefined && Date.now() - at < ttlMs) return Promise.resolve(value);
    pending ??= read().then((v) => { value = v; at = Date.now(); return v; })
      .catch(() => { at = Date.now() - ttlMs + 60_000; return value ?? fallback; }) // retry in a minute
      .finally(() => { pending = null; });
    return value !== undefined ? Promise.resolve(value) : pending;
  };
}
/** Who can still upgrade lp_locker (null once immutable); "unknown" if never read, so the site never claims more permanence than it can show. */
const lockerUpgradeAuthority = sticky<string | null>(async () => {
  const prog = await conn.getAccountInfo(new PublicKey(cfg.locker!.programId));
  if (!prog || prog.data.length < 36) throw new Error("locker program not found");
  const pd = await conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
  if (!pd || pd.data.length < 45) throw new Error("program data not found");
  return pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
}, "unknown");
/** XDEX's pool-creation fee in XNT, from its AmmConfig account. */
const poolCreateFee = sticky<number | null>(async () => {
  const a = await conn.getAccountInfo(new PublicKey(XDEX_CREATE[cfg.network].ammConfig));
  if (!a) throw new Error("amm config not found");
  return Number(a.data.readBigUInt64LE(36)) / 1e9;
}, null);

const balanceCache = new Map<string, { at: number; data: { network: string; xnt: number } }>();
/**
 * Stale-while-revalidate for read-only views. Public RPCs rate-limit (mainnet's hard), so
 * a view that answered once keeps its last good answer: after `freshMs` it's refreshed in
 * the background and the old answer is served meanwhile, and if the refresh fails the old
 * answer stays. Only a view that has never succeeded can return an error.
 */
const swrStore = new Map<string, { at: number; val: unknown; pending: Promise<unknown> | null; startedAt: number; gen: number }>();
/** A refresh still running after this long is abandoned, so one hung chain read can't freeze a view for good. */
const SWR_STUCK_MS = 120_000;
function swr(key: string, freshMs: number, fn: () => Promise<unknown>): Promise<unknown> {
  let e = swrStore.get(key);
  if (!e) { if (swrStore.size > 3_000) swrStore.clear(); e = { at: 0, val: undefined, pending: null, startedAt: 0, gen: 0 }; swrStore.set(key, e); }
  const entry = e;
  if (entry.pending && Date.now() - entry.startedAt > SWR_STUCK_MS) {
    console.error(`refresh ${key}: no answer after ${SWR_STUCK_MS / 1000} s, starting a new one`);
    entry.pending = null;
  }
  const refresh = () => {
    if (entry.pending) return entry.pending;
    const gen = ++entry.gen;
    entry.startedAt = Date.now();
    // Only the newest refresh may store its answer or clear the slot (an abandoned one may still finish later).
    return (entry.pending = fn()
      .then((v) => { if (gen === entry.gen) { entry.val = v; entry.at = Date.now(); } return v; })
      .finally(() => { if (gen === entry.gen) entry.pending = null; }));
  };
  if (entry.val !== undefined) {
    if (Date.now() - entry.at > freshMs) refresh().catch((err) => console.error(`refresh ${key}: ${err instanceof Error ? err.message.slice(0, 120) : err}`));
    return Promise.resolve(entry.val);
  }
  return refresh();
}
// Read-only views served through swr() (not per-action flows like launches, curves or the faucet).
const SWR_ROUTES = /^\/api\/(nft\/|nfts$|token\/|token-list$|analytics$|wallet\/|leaderboard\/|stats$|tokens$|vault\/)/;

async function get(url: URL) {
  if (SWR_ROUTES.test(url.pathname)) return swr(url.pathname + url.search, 30_000, () => getView(url));
  return getView(url);
}
async function getView(url: URL) {
  if (url.pathname === "/api/nfts") return allNfts();
  if (url.pathname === "/api/curves") return curves ? curves.list() : null;
  // The launch form checks a payout token as it's typed: its XNT pool, freeze authority and extensions.
  if (url.pathname === "/api/payout-token") return payoutTokenJson(await payoutToken(conn, cfg, url.searchParams.get("mint") ?? ""));
  const cv = /^\/api\/curve\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (cv) {
    if (!curves) return null;
    // A Tax Vault curve token: whether its creator has started the vault (after graduation).
    const [view, vault] = await Promise.all([curves.view(cv[1], url.searchParams.get("wallet")),
      vaults ? vaults.badge(new PublicKey(cv[1]).toBase58()).catch(() => null) : null]);
    return { ...view, vault };
  }
  const nftApi = /^\/api\/nft\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (nftApi) return nftView(nftApi[1]);
  const va = /^\/api\/vault\/([1-9A-HJ-NP-Za-km-z]{32,44})(\/list)?$/.exec(url.pathname);
  if (va) return vaults ? (va[2] ? vaults.listView(va[1]) : vaults.view(va[1])) : null;
  if (url.pathname === "/api/info") {
    const [poolCreateFeeXnt, lockerAuthority] = await Promise.all([poolCreateFee(), lockerUpgradeAuthority()]);
    return {
      logoUpload: ipfsEnabled(cfg), maxLogoBytes: MAX_LOGO_BYTES, network: cfg.network, explorer, feeAmount: launchFee(cfg).amount, feeSymbol: launchFee(cfg).symbol, feeMint: launchFee(cfg).mint, feeReceiver: f!.feeReceiver,
      creatorBps: CREATOR_BPS, creatorRewardSymbol: rewardSymbol,
      gasXnt: f!.gasXnt ?? "0.05", poolCreateFeeXnt,
      lockerProgram: cfg.locker!.programId, xdexProgram: cfg.xdex.programId,
      // Until the locker is made immutable, pages say so next to "locked forever" claims.
      lockerUpgradeable: lockerAuthority !== null, lockerAuthority,
      lockForeverOnly: !!f!.lockForeverOnly,
      launchesPaused: f!.launchesPaused ? (f!.launchesPaused.message ?? "New launches are paused for a short while while we upgrade how the tax is held. Launches already started can still be finished below.") : null,
      // Bonding curve (false when off): the graduation targets a creator may pick, whole XNT.
      curve: curves ? { targetsXnt: targetsFor(cfg.network).map(String), defaultTargetXnt: String(DEFAULT_TARGET_XNT) } : false,
      creatorRewardMint: CREATOR_REWARD[cfg.network].rewardMint ?? null, creatorRewardPool: CREATOR_REWARD[cfg.network].swapPool ?? null,
      // Pair tokens a launch may choose besides XNT, with their price (XNT per whole token) for the form.
      quoteTokens: await Promise.all(quoteTokens.map(async (q) => ({
        symbol: q.symbol, mint: q.mint, xntPool: q.xntPool,
        priceXnt: (await pairValue({ symbol: q.symbol, mint: new PublicKey(q.mint), xntPool: new PublicKey(q.xntPool) }).catch(() => null))?.xntPer ?? null,
      }))),
      sourceUrl: "https://github.com/Lokoweb3/x1-reflection-token",
      // New XNT launches hand their tax to the Tax Vault program (no distributor gas to pre-fund).
      // Their creator reward is swapped on-chain into the network's reward token (XNM on testnet).
      ...(vaults ? { taxVault: { programId: vaults.program.toBase58(), launches: isVaultLaunch(cfg, XNT_PAIR),
        rewardSymbol: REWARD_TOKEN[cfg.network].symbol, rewardMint: REWARD_TOKEN[cfg.network].mint.toBase58(), beta: cfg.factory?.taxVault?.beta === true, payoutTokens: payoutTokensOn(cfg), recoveryUrl: recoveryUrl(cfg.network), recoveryPath: RECOVERY_FILE ? "/recovery" : null } } : {}),
    };
  }
  if (url.pathname === "/api/launches") {
    const creator = new PublicKey(url.searchParams.get("creator") ?? "").toBase58();
    const mine = listLaunches().filter((r) => r.creator === creator && !(r as { hidden?: boolean }).hidden).slice(0, 20);
    return Promise.all(mine.map(async (r) => {
      const status = await launchStatus(conn, cfg, r);
      const nft = r.lockNft ?? status.lockNft;
      const nftMeta = nft ? await getTokenMetadata(conn, new PublicKey(nft), "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null) : null;
      // Trading fees the lock NFT can collect now, and who holds it (only they can collect).
      let fees = null, nftHolderAddr: string | null = null;
      if (nft) {
        const holder = await nftHolder(conn, new PublicKey(nft));
        nftHolderAddr = holder?.owner.toBase58() ?? null;
        if (holder) {
          const q = await collectQuote(holder.owner, new PublicKey(nft), await whereFor(r.pool, r.mint, r.symbol)).catch(() => null);
          if (q) fees = { ...q, holder: holder.owner.toBase58() };
        }
      }
      return { ...publicView(r), status, lockNft: nft, receipt: nftMeta ? (await nftArt(cfg, nftMeta.uri))?.image ?? null : null, rewards: await creatorRewards(nft, r.mint), fees, nftHolder: nftHolderAddr };
    }));
  }
  if (url.pathname === "/api/tokens") return registeredLaunches().map((r) => ({ ...publicView(r), paid: tokenPayouts(r.mint) }));
  if (url.pathname === "/api/stats") return stats();
  if (url.pathname === "/api/token-list") return tokenList();
  const lb = /^\/api\/leaderboard\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (lb) return leaderboard(lb[1]);
  if (url.pathname === "/api/faucet") return faucetStatus(conn, cfg, url.searchParams.get("wallet") ?? undefined);
  // A wallet's XNT on this site's network (the wrong-network hint in wallet.js). Cached 30 s.
  const bal = /^\/api\/balance\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (bal) {
    const hit = balanceCache.get(bal[1]);
    if (hit && Date.now() - hit.at < 30_000) return hit.data;
    const data = { network: cfg.network, xnt: (await conn.getBalance(new PublicKey(bal[1]))) / 1e9 };
    balanceCache.set(bal[1], { at: Date.now(), data });
    if (balanceCache.size > 5_000) balanceCache.clear();
    return data;
  }
  const wp = /^\/api\/passes\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (wp) return walletPasses(new PublicKey(wp[1]).toBase58());
  const wv = /^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (wv) return walletView(wv[1]);
  const ts = /^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})\/stats$/.exec(url.pathname);
  if (ts) return tokenStats(ts[1]);
  if (url.pathname === "/api/analytics") return analytics();
  if (url.pathname === "/api/distribute/list") {
    // Tax Vault tokens run on the vault crank, not "Distribute now".
    const list = await Promise.all(targets(cfg).filter((t) => !vaultAuthFor(t.mint)).map((t) => cachedReadiness(t.mint)));
    return { tipXnt, rewardPct: (cfg.distribution.clickerRewardBps ?? 100) / 100, rewardCapXnt: cfg.distribution.clickerRewardCapXnt ?? "0.05", cooldownMinutes: 10, tokens: list };
  }
  if (url.pathname === "/api/distribute/status") {
    const t = findTarget(cfg, url.searchParams.get("mint") ?? "");
    return readiness(conn, cfg, t);
  }
  return null;
}

const tipXnt = f.tipXnt ?? "0.005";
const tipLamports = toBaseUnits(tipXnt, 9);
// Readiness scans every holder account, so cache it briefly per token.
const readinessCache = new Map<string, { at: number; data: Promise<Awaited<ReturnType<typeof readiness>>> }>();
function cachedReadiness(mint: string) {
  const hit = readinessCache.get(mint);
  if (hit && Date.now() - hit.at < 20_000) return hit.data;
  const data = readiness(conn, cfg, findTarget(cfg, mint)).catch((e) => {
    readinessCache.delete(mint);
    return { mint, symbol: "?", name: "?", decimals: 9, waiting: "0", worthLamports: "0", thresholdLamports: "0", holders: 0, ready: false, reason: String(e instanceof Error ? e.message : e), lastRun: null };
  });
  readinessCache.set(mint, { at: Date.now(), data });
  return data;
}

/** Totals from one launched token's distributor activity log. */
function tokenPayouts(mint: string) {
  const file = path.join(FACTORY_DIR, "launches", mint, "state", "events.jsonl");
  const out = { xntPaid: 0n, xntToLiquidity: 0n, burned: 0n, wallets: new Set<string>(), payouts: 0 };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === "payout") { out.xntPaid += BigInt(e.total ?? 0); out.payouts++; for (const [w] of e.payments ?? []) out.wallets.add(w); }
        if (e.kind === "auto-lp") out.xntToLiquidity += BigInt(e.xnt ?? 0);
        if (e.kind === "burn") out.burned += BigInt(e.tokens ?? 0);
      } catch { /* skip a torn line */ }
    }
  }
  return { xntPaid: out.xntPaid.toString(), xntToLiquidity: out.xntToLiquidity.toString(), burned: out.burned.toString(), wallets: out.wallets.size, payouts: out.payouts };
}

// ---------- Holder passes ----------

/** A token's distributor state file (published pass totals live here). */
function tokenState(stateDir: string): any {
  const f = path.join(stateDir, "distributor-state.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}
const tokenConfig = (t: ReturnType<typeof targets>[number]) => JSON.parse(fs.readFileSync(t.configPath, "utf8")) as Config;
const claimsOn = (t: ReturnType<typeof targets>[number]) => tokenConfig(t).distribution.holderRewards === "claims";

/**
 * A wallet's holder passes across every claims-mode token: what each has earned in the
 * latest published root, claimed so far, claimable now, and credited but not yet published.
 * Also lists claims-mode tokens the wallet could mint a pass for.
 */
async function walletPasses(owner: string) {
  const programId = new PublicKey(cfg.locker!.programId);
  const out = { passes: [] as any[], mintable: [] as any[] };
  for (const t of targets(cfg)) {
    if (!claimsOn(t)) continue;
    const mint = new PublicKey(t.mint);
    const pool = await readHolderPool(conn, programId, mint).catch(() => null);
    const st = tokenState(t.stateDir);
    const published: Record<string, string> = st.claims?.cumulative ?? {};
    const owed: Record<string, string> = st.owed ?? {};
    const mine = [];
    for (const p of await listPasses(conn, programId, mint)) {
      const h = await nftHolder(conn, p.passMint);
      if (h?.owner.toBase58() !== owner) continue;
      const key = p.passMint.toBase58();
      const earned = BigInt(published[key] ?? "0");
      mine.push({
        tokenMint: t.mint, symbol: t.symbol, name: t.name, passMint: key,
        earned: earned.toString(), claimed: p.claimed.toString(), claimable: (earned > p.claimed ? earned - p.claimed : 0n).toString(),
        pending: owed["pass:" + key] ?? "0", mintedAt: p.createdAt,
      });
    }
    out.passes.push(...mine);
    if (!mine.length) out.mintable.push({ tokenMint: t.mint, symbol: t.symbol, name: t.name, poolReady: !!pool });
  }
  return out;
}

/** Every event a token's distributor logged (payouts, auto-LP, burns, rewards…). */
function tokenEvents(stateDir: string): Record<string, any>[] {
  const file = path.join(stateDir, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

/** Tax split for any target: a launch's own record, or config.json for the main token. */
function targetInfo(t: ReturnType<typeof targets>[number]) {
  const r = readLaunch(t.mint);
  if (r) {
    const liquidity = r.autoLpBps / 100, burn = (r.burnBps ?? 0) / 100, creator = CREATOR_BPS / 100;
    return { taxPct: r.taxBps / 100, split: { holders: 100 - liquidity - burn - creator, liquidity, burn, creator }, supply: r.supply,
      image: r.image || null, description: r.description || "", lockNft: r.lockNft ?? null, createdAt: r.registeredAt ?? r.createdAt, launched: true,
      links: { website: r.website ?? null, twitter: r.twitter ?? null, telegram: r.telegram ?? null } };
  }
  const d = cfg.distribution;
  const liquidity = (d.autoLpBps ?? 0) / 100, burn = (d.burnBps ?? 0) / 100, creator = (d.creatorBps ?? 0) / 100;
  return { taxPct: cfg.token.feeBps / 100, split: { holders: 100 - liquidity - burn - creator, liquidity, burn, creator }, supply: cfg.token.supply,
    image: null, description: "", lockNft: cfg.creatorReward?.nftMint ?? null, createdAt: null, launched: false,
    links: { website: null, twitter: null, telegram: null } };
}

/**
 * XNT a `creator-reward` event stands for: the Tax Vault's events record the XNT swapped
 * (`xnt`) next to the reward tokens bought (`reward`); the distributor's record `amount`.
 */
const creatorXntOf = (e: Record<string, any>) => BigInt(e.xnt ?? e.amount ?? 0);

/** Totals from one token's event log, in base units. */
function eventTotals(events: Record<string, any>[]) {
  const t = { holdersXnt: 0n, liquidityXnt: 0n, creatorXnt: 0n, clickerXnt: 0n, burned: 0n, payouts: 0, wallets: new Set<string>(), lastRun: null as string | null };
  for (const e of events) {
    if (e.kind === "payout") { t.holdersXnt += BigInt(e.total ?? 0); t.payouts++; for (const [w] of e.payments ?? []) t.wallets.add(w); }
    else if (e.kind === "auto-lp") t.liquidityXnt += BigInt(e.xnt ?? 0);
    else if (e.kind === "creator-reward") t.creatorXnt += creatorXntOf(e);
    else if (e.kind === "clicker-reward") t.clickerXnt += BigInt(e.xnt ?? 0);
    else if (e.kind === "burn") t.burned += BigInt(e.tokens ?? 0);
    if (e.at && (!t.lastRun || e.at > t.lastRun)) t.lastRun = e.at;
  }
  return t;
}

/** The Tokens page: every token with live price and liquidity plus what it has paid out. */
let tokenListCache: { at: number; data: Promise<unknown> } | null = null;
function tokenList() {
  if (tokenListCache && Date.now() - tokenListCache.at < 30_000) return tokenListCache.data;
  const data = Promise.all(targets(cfg).map(async (t) => {
    const info = targetInfo(t);
    const pair = pairForMint(t.mint);
    const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), new PublicKey(t.mint), pair.mint).catch(() => null);
    const value = await pairValue(pair).catch(() => null);
    const e = eventTotals(tokenEvents(t.stateDir));
    const st = await (tokenStats(t.mint) as Promise<{ yield: ReturnType<typeof holderYield> }>).catch(() => null);
    const vault = vaults ? await vaults.badge(t.mint).catch(() => null) : null;
    const priceQuote = snap && snap.reserveToken > 0n ? Number(snap.reserveQuote) / Number(snap.reserveToken) : null;
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, pool: t.pool, ...info, yield: st?.yield ?? null, holderPass: claimsOn(t),
      // Price and pool depth in XNT (a JACK pool's JACK valued at the JACK/XNT price), plus
      // the same in the pair token for JACK pools.
      quote: pair.symbol, priceQuote, liquidityQuote: snap ? (2n * snap.reserveQuote).toString() : null,
      priceXnt: priceQuote !== null && value ? priceQuote * value.xntPer : null,
      liquidityXnt: snap && value ? value.toXnt(2n * snap.reserveQuote).toString() : null,
      holdersXnt: e.holdersXnt.toString(), liquidityAddedXnt: e.liquidityXnt.toString(), creatorXnt: e.creatorXnt.toString(),
      burned: e.burned.toString(), walletsPaid: e.wallets.size, payouts: e.payouts, lastRun: e.lastRun,
      ...(vault ? { vault } : {}),
    };
  }));
  data.catch(() => { tokenListCache = null; });
  tokenListCache = { at: Date.now(), data };
  return data;
}

/** The Analytics page: platform totals, activity per day, per-token breakdown, recent events. */
let analyticsCache: { at: number; data: unknown } | null = null;
function analytics() {
  if (analyticsCache && Date.now() - analyticsCache.at < 30_000) return analyticsCache.data;
  const days = new Map<string, { holders: bigint; liquidity: bigint; creator: bigint }>();
  const wallets = new Set<string>();
  const perToken = [];
  const recent: Record<string, unknown>[] = [];
  const total = { holdersXnt: 0n, liquidityXnt: 0n, creatorXnt: 0n, clickerXnt: 0n, payouts: 0, burns: 0 };
  for (const t of targets(cfg)) {
    const events = tokenEvents(t.stateDir);
    const e = eventTotals(events);
    for (const w of e.wallets) wallets.add(w);
    total.holdersXnt += e.holdersXnt; total.liquidityXnt += e.liquidityXnt; total.creatorXnt += e.creatorXnt; total.clickerXnt += e.clickerXnt;
    total.payouts += e.payouts; total.burns += events.filter((x) => x.kind === "burn").length;
    perToken.push({ symbol: t.symbol, mint: t.mint, holdersXnt: e.holdersXnt.toString(), liquidityXnt: e.liquidityXnt.toString(),
      creatorXnt: e.creatorXnt.toString(), burned: e.burned.toString(), walletsPaid: e.wallets.size, payouts: e.payouts, lastRun: e.lastRun });
    for (const x of events) {
      if (!x.at) continue;
      const hour = String(x.at).slice(0, 13); // YYYY-MM-DDTHH; the page groups by day for long spans
      const b = days.get(hour) ?? { holders: 0n, liquidity: 0n, creator: 0n };
      if (x.kind === "payout") b.holders += BigInt(x.total ?? 0);
      else if (x.kind === "auto-lp") b.liquidity += BigInt(x.xnt ?? 0);
      else if (x.kind === "creator-reward") b.creator += creatorXntOf(x);
      days.set(hour, b);
      if (["payout", "auto-lp", "burn", "creator-reward", "clicker-reward"].includes(x.kind)) {
        recent.push({ at: x.at, kind: x.kind, symbol: t.symbol, signature: x.signature ?? null,
          xnt: x.kind === "payout" ? String(x.total ?? 0) : x.kind === "creator-reward" ? creatorXntOf(x).toString() : x.xnt ?? null,
          tokens: x.kind === "burn" ? String(x.tokens ?? 0) : null, wallets: x.kind === "payout" ? (x.payments ?? []).length : null });
      }
    }
  }
  const data = {
    tokens: perToken.length, launches: registeredLaunches().length, walletsPaid: wallets.size,
    holdersXnt: total.holdersXnt.toString(), liquidityXnt: total.liquidityXnt.toString(), creatorXnt: total.creatorXnt.toString(),
    clickerXnt: total.clickerXnt.toString(), payouts: total.payouts, burns: total.burns,
    hourly: [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, v]) => ({ hour, holders: v.holders.toString(), liquidity: v.liquidity.toString(), creator: v.creator.toString() })),
    perToken: perToken.sort((a, b) => Number(BigInt(b.holdersXnt) - BigInt(a.holdersXnt))),
    recent: recent.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 20),
  };
  analyticsCache = { at: Date.now(), data };
  return data;
}

/**
 * Holder yield: XNT paid to holders over the last 7 days (or since the first activity,
 * if newer; never less than one day), spread over the tokens that earn payouts now.
 * Gives XNT per 1,000 tokens per day and a simple (non-compounding) yearly % at today's
 * price. It is a trailing estimate, not a promise: payouts follow trading volume.
 */
const YIELD_WINDOW_DAYS = 7;
function holderYield(events: Record<string, any>[], eligible: bigint, decimals: number, priceXnt: number | null, since: string | null) {
  const now = Date.now();
  const first = [since, ...events.map((e) => e.at)].filter(Boolean).map((a) => Date.parse(a as string)).filter(Number.isFinite);
  const start = Math.max(now - YIELD_WINDOW_DAYS * 86_400_000, first.length ? Math.min(...first) : now);
  const days = Math.max(1, (now - start) / 86_400_000);
  let paid = 0n;
  for (const e of events) if (e.kind === "payout" && e.at && Date.parse(e.at) >= start) paid += BigInt(e.total ?? 0);
  const xntPerDay = Number(paid) / 1e9 / days;
  const eligibleTokens = Number(eligible) / 10 ** decimals;
  const perTokenPerDay = eligibleTokens > 0 ? xntPerDay / eligibleTokens : 0;
  return {
    windowDays: Math.round(days * 10) / 10, paidXnt: paid.toString(), xntPerDay,
    per1000PerDay: perTokenPerDay * 1000,
    aprPct: priceXnt && priceXnt > 0 && perTokenPerDay > 0 ? (perTokenPerDay * 365 / priceXnt) * 100 : null,
  };
}

/**
 * One token's stats for the NFT page: supply burned, liquidity added, payouts, and every
 * holder with balance, share, XNT received and whether they currently earn payouts.
 */
const tokenStatsCache = new Map<string, { at: number; data: Promise<unknown> }>();
function tokenStats(mintStr: string) {
  const hit = tokenStatsCache.get(mintStr);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const data = (async () => {
    const t = findTarget(cfg, mintStr);
    const mint = new PublicKey(t.mint);
    const info = targetInfo(t);
    const dc = (JSON.parse(fs.readFileSync(t.configPath, "utf8")) as Config).distribution;
    const pair = pairForMint(t.mint);
    const [rows, mintInfo, snap, value] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed"),
      snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), mint, pair.mint).catch(() => null),
      pairValue(pair).catch(() => null)]);
    // XNT values; a JACK pool's JACK is valued at the JACK/XNT pool price.
    const toXnt = (v: bigint) => (value ? value.toXnt(v) : 0n);
    const m = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
    const events = tokenEvents(t.stateDir);
    const e = eventTotals(events);
    // XNT each wallet has received from payouts.
    const paid = new Map<string, bigint>();
    for (const x of events) if (x.kind === "payout") for (const [w, amt] of x.payments ?? []) paid.set(w, (paid.get(w) ?? 0n) + BigInt(amt));

    // "Distribute now" rewards each wallet has earned.
    const clicker = new Map<string, bigint>();
    for (const x of events) if (x.kind === "clicker-reward" && x.wallet) clicker.set(x.wallet, (clicker.get(x.wallet) ?? 0n) + BigInt(x.xnt ?? 0));
    const pool = poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58();
    const launch = readLaunch(t.mint);
    const labels = new Map<string, string>([[pool, "XDEX pool"], [t.distributor, "Distributor"], ...BURN_OWNERS.map((b) => [b, "Burn address"] as [string, string])]);
    if (launch) labels.set(launch.creator, "Creator");
    const excluded = new Set([...dc.excludeOwners, ...BURN_OWNERS, t.distributor, pool]);
    // A vault token's collected tax sits with the vault's auth PDA: never a holder.
    const vaultAuth = vaultAuthFor(t.mint);
    if (vaultAuth) {
      labels.set(vaultAuth, "Tax vault"); excluded.add(vaultAuth);
      // A migrated token's hot wallet lost its withdraw authority to the vault; it only holds dust now.
      // (A token launched on the vault, curve ones included, records the auth PDA itself there.)
      if (t.distributor && t.distributor !== vaultAuth) labels.set(t.distributor, "Old distributor (retired)");
    }
    const vault = vaults ? await vaults.badge(t.mint).catch(() => null) : null;
    const minHolding = toBaseUnits(dc.minHoldingTokens, m.decimals);
    const earning = eligibleBalances(rows, { excluded, excludeOffCurve: dc.excludeOffCurveOwners, minHolding });

    const perOwner = new Map<string, bigint>();
    for (const r of rows) if (r.amount > 0n) perOwner.set(r.owner, (perOwner.get(r.owner) ?? 0n) + r.amount);
    for (const w of paid.keys()) if (!perOwner.has(w)) perOwner.set(w, 0n); // sold out, but was paid
    let earningTotal = 0n;
    for (const b of earning.values()) earningTotal += b;
    const valueOf = (bal: bigint) => (snap && snap.reserveToken > 0n ? toXnt((bal * snap.reserveQuote) / snap.reserveToken) : 0n);
    const holders = [...perOwner.entries()].map(([owner, bal]) => {
      const offCurve = !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
      const status = earning.has(owner) ? "earning"
        : excluded.has(owner) ? "excluded"
        : bal === 0n ? "sold"
        : offCurve && dc.excludeOffCurveOwners ? "program"
        : "below-minimum";
      return { owner, label: labels.get(owner) ?? null, balance: bal.toString(), pct: m.supply > 0n ? Number((bal * 1_000_000n) / m.supply) / 10_000 : 0,
        paidXnt: (paid.get(owner) ?? 0n).toString(), status, valueXnt: valueOf(bal).toString(),
        // Share of the next payout: payouts split by eligible balance.
        payoutSharePct: earning.has(owner) && earningTotal > 0n ? Number((earning.get(owner)! * 1_000_000n) / earningTotal) / 10_000 : 0,
        clickerXnt: (clicker.get(owner) ?? 0n).toString() };
    }).sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));

    const original = toBaseUnits(info.supply, m.decimals);
    const priceQuote = snap && snap.reserveToken > 0n ? Number(snap.reserveQuote) / Number(snap.reserveToken) : null;
    const priceXnt = priceQuote !== null && value ? priceQuote * value.xntPer : null;
    const yieldInfo = holderYield(events, earningTotal, m.decimals, priceXnt, info.createdAt);
    const poolTokens = perOwner.get(pool) ?? 0n;
    const payoutSeries = events.filter((x) => x.kind === "payout" && x.at).map((x) => ({ at: x.at, xnt: String(x.total ?? 0) }))
      .sort((a, b) => a.at.localeCompare(b.at));
    const burnedTotal = original > m.supply ? original - m.supply : 0n; // every burn, tax or otherwise
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, decimals: m.decimals, taxPct: info.taxPct, split: info.split,
      supply: m.supply.toString(), originalSupply: original.toString(),
      // Spot price from the pool reserves (XNT per whole token), market cap and pool depth.
      priceXnt, yield: yieldInfo,
      marketCapXnt: snap && snap.reserveToken > 0n && value ? toXnt((m.supply * snap.reserveQuote) / snap.reserveToken).toString() : null,
      poolXnt: snap && value ? toXnt(2n * snap.reserveQuote).toString() : null,
      // The pair token (XNT or JACK); for JACK the pool and prices in JACK too (priceQuote per whole token).
      quote: pair.symbol, priceQuote, poolQuote: snap ? (2n * snap.reserveQuote).toString() : null, pairXnt: value?.xntPer ?? null,
      launchPriceXnt: launch && !pair.xntPool && Number(launch.poolTokens) > 0 ? Number(launch.poolXnt) / Number(launch.poolTokens) : null,
      launchPriceQuote: launch && Number(launch.poolTokens) > 0 ? Number(launch.poolXnt) / Number(launch.poolTokens) : null,
      // Where the original supply sits now.
      breakdown: {
        pool: poolTokens.toString(), earning: earningTotal.toString(),
        other: (m.supply > poolTokens + earningTotal ? m.supply - poolTokens - earningTotal : 0n).toString(),
      },
      payoutSeries,
      // Every tax burn, oldest first: time, tokens (base units) and its transaction.
      burnSeries: events.filter((x) => x.kind === "burn" && x.at).map((x) => ({ at: x.at, tokens: String(x.tokens ?? 0), sig: x.signature ?? null }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      burned: burnedTotal.toString(), burnedPct: original > 0n ? Number((burnedTotal * 1_000_000n) / original) / 10_000 : 0, taxBurned: e.burned.toString(),
      liquidityXnt: e.liquidityXnt.toString(), holdersXnt: e.holdersXnt.toString(), creatorXnt: e.creatorXnt.toString(),
      payouts: e.payouts, walletsPaid: e.wallets.size, earning: earning.size, minHolding: dc.minHoldingTokens, lastRun: e.lastRun,
      holders,
      ...(vault ? { vault } : {}),
    };
  })();
  data.catch(() => tokenStatsCache.delete(mintStr));
  tokenStatsCache.set(mintStr, { at: Date.now(), data });
  return data;
}

/**
 * Everything one wallet has earned across every token: holdings, XNT received, clicker
 * rewards, estimated earnings per day at the current yield, and lock NFTs it holds with
 * fees and creator rewards waiting.
 */
async function walletView(addr: string) {
  const owner = new PublicKey(addr).toBase58();
  const tokens = [];
  for (const t of targets(cfg)) {
    const s = await (tokenStats(t.mint) as Promise<any>).catch(() => null);
    if (!s) continue;
    const h = s.holders.find((x: any) => x.owner === owner);
    if (!h) continue;
    const bal = Number(BigInt(h.balance)) / 10 ** s.decimals;
    tokens.push({
      mint: t.mint, symbol: t.symbol, name: t.name, lockNft: targetInfo(t).lockNft, decimals: s.decimals,
      balance: h.balance, pct: h.pct, valueXnt: h.valueXnt, paidXnt: h.paidXnt, clickerXnt: h.clickerXnt, status: h.status,
      payoutSharePct: h.payoutSharePct, priceXnt: s.priceXnt, quote: s.quote, priceQuote: s.priceQuote, yield: s.yield, minHolding: s.minHolding,
      estPerDayXnt: h.status === "earning" && s.yield ? (s.yield.per1000PerDay / 1000) * bal : 0,
    });
  }
  const nfts = ((await allNfts()) as any[]).filter((n) => n.holder === owner);
  const xntBalance = await conn.getBalance(new PublicKey(owner)).then((l) => l / 1e9).catch(() => null);
  return { wallet: owner, explorer, xntBalance, tokens, nfts };
}

/**
 * Holder leaderboard for one token: every holder's average cost (XNT per token) from
 * their swaps, what their holding is worth now, profit/loss, and the XNT rewards each
 * wallet has received (holder payouts plus "Distribute now" rewards). Trades are indexed
 * incrementally; results are cached for a minute.
 *
 * A JACK-paired token's trades are in JACK, so its prices, costs and profit/loss are in
 * JACK (`quote` says so); rewards are always XNT, and `returnXnt` values the JACK profit
 * at today's JACK/XNT price before adding them.
 */
const boardCache = new Map<string, { at: number; data: Promise<unknown> }>();
/** Every pool holding a token and who holds its liquidity: chain-wide scans, so read every 10 minutes (the last good answer stays). */
const poolsCache = new Map<string, { at: number; data: Awaited<ReturnType<typeof tokenPools>> | null; pending?: Promise<unknown> }>();
function liquidityOf(mint: string, priceXnt: number | null) {
  const hit = poolsCache.get(mint);
  if (hit && (Date.now() - hit.at < 600_000 || hit.pending)) return hit.data;
  const entry = { at: hit?.at ?? 0, data: hit?.data ?? null, pending: undefined as Promise<unknown> | undefined };
  entry.pending = tokenPools(conn, new PublicKey(cfg.xdex.programId), new PublicKey(mint), new PublicKey(cfg.locker!.programId), priceXnt)
    .then((data) => { entry.data = data; entry.at = Date.now(); })
    .catch((e) => { console.error(`Pools for ${mint} failed: ${e instanceof Error ? e.message : e}`); entry.at = Date.now() - 480_000; }) // retry in 2 min
    .finally(() => { entry.pending = undefined; });
  poolsCache.set(mint, entry);
  return entry.data;
}
function leaderboard(mintStr: string) {
  const hit = boardCache.get(mintStr);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = (async () => {
    const t = findTarget(cfg, mintStr);
    const pair = pairForMint(t.mint);
    const [idx, st, pairVal] = await Promise.all([
      refreshTrades(conn, t.mint, t.stateDir, pair.xntPool ? pair.mint.toBase58() : undefined),
      tokenStats(t.mint) as Promise<any>,
      pairValue(pair).catch(() => null),
    ]);
    // XNT each wallet received: holder payouts plus "Distribute now" clicker rewards.
    const rewards = new Map<string, bigint>();
    for (const e of tokenEvents(t.stateDir)) {
      if (e.kind === "payout") for (const [w, amt] of e.payments ?? []) rewards.set(w, (rewards.get(w) ?? 0n) + BigInt(amt));
      else if (e.kind === "clicker-reward" && e.wallet) rewards.set(e.wallet, (rewards.get(e.wallet) ?? 0n) + BigInt(e.xnt ?? 0));
    }
    const rewardOf = (w: string) => Number(rewards.get(w) ?? 0n) / 1e9;
    // Profit in the price unit (XNT, or JACK) to XNT, for the total return.
    const perUnitXnt = pair.xntPool ? pairVal?.xntPer ?? null : 1;
    // Tokens with no known cost add nothing: their profit is unknown, so it's left out (and a
    // wallet with only those still shows its rewards).
    const totalReturn = (pnl: number | null, realized: number, rewardsXnt: number) =>
      perUnitXnt !== null ? ((pnl ?? 0) + realized) * perUnitXnt + rewardsXnt : !pnl && !realized ? rewardsXnt : null;
    // Not holders in the leaderboard's sense: the pool, burn address, distributor, and
    // wallets the token's settings exclude from rewards (excludeOwners).
    const skip = new Set([t.distributor, poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58(), ...BURN_OWNERS,
      ...(tokenConfig(t).distribution.excludeOwners ?? [])]);
    const vaultAuth = vaultAuthFor(t.mint);
    if (vaultAuth) skip.add(vaultAuth);
    const pos = positions(idx.trades, skip);
    const dec = 10 ** st.decimals;
    // Price per whole token in the unit trades are recorded in: XNT, or JACK for a JACK pool.
    const price: number | null = pair.xntPool ? st.priceQuote : st.priceXnt;
    const x = (v: bigint) => Number(v) / 1e9;
    // "If sold now": what selling a whole balance in one go returns from the pool right now,
    // after the token's own tax and the pool's fee and price impact (in the price unit).
    const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), new PublicKey(t.mint), pair.mint).catch(() => null);
    const sellAll = (amount: bigint) => {
      if (!snap || amount <= 0n) return null;
      const net = amount - calculateEpochFee(snap.feeCfg, snap.epoch, amount);
      return net > 0n ? x(cpmmOut(net, snap.reserveToken, snap.reserveQuote, snap.tradeFeeRate)) : 0;
    };
    // A balance worth less than this (XNT) is dust left after selling: shown as sold out.
    const DUST_XNT = 0.001;
    // XNT per token across a wallet's buys (`spent` / the tokens it paid for).
    const avgBuy = (p: Position | undefined) => p && p.boughtPriced > 0n ? x(p.spent) / (Number(p.boughtPriced) / dec) : null;
    const estimates = (p: Position | undefined) => ({ spentEstimated: p ? x(p.spentEstimated) : 0, receivedEstimated: p ? x(p.receivedEstimated) : 0 });
    const rows: any[] = [];
    const seen = new Set<string>();
    for (const h of st.holders) {
      if (skip.has(h.owner)) continue;
      seen.add(h.owner);
      const p = pos.get(h.owner);
      const bal = Number(BigInt(h.balance)) / dec;
      // Tokens from priced buys, and what they cost. If the tracked total is more than the
      // balance (a move not read yet), both parts shrink to fit; any extra has no known cost.
      const tracked = p ? Number(p.held + p.unknown) / dec : 0;
      const fit = tracked > bal && tracked > 0 ? bal / tracked : 1;
      const heldFromBuys = p ? (Number(p.held) / dec) * fit : 0;
      const avg = p && p.held > 0n ? x(p.cost) / (Number(p.held) / dec) : null;
      const costKnown = p ? x(p.cost) * fit : 0;
      const value = price !== null ? bal * price : null;
      const pnl = value !== null && avg !== null && price !== null ? price * heldFromBuys - costKnown : null;
      const rewardsXnt = rewardOf(h.owner);
      const soldNow = sellAll(BigInt(h.balance));
      // Profit if sold now, on the tokens with a known cost (their share of the sale).
      const pnlIfSold = soldNow !== null && avg !== null && bal > 0 ? (soldNow * heldFromBuys) / bal - costKnown : null;
      // Whole-position profit (worth now + XNT received − XNT spent), counting cost that left
      // with tokens moved out (or no longer in the balance) as gone at cost.
      const costIn = p ? x(p.spent) - x(p.movedCost) - (x(p.cost) - costKnown) : 0;
      const whole = (open: number | null) => p && p.spent > 0n ? (open ?? 0) + x(p.realized) : null;
      const pl = whole(pnl), plIfSold = whole(pnlIfSold);
      const pctOf = (v: number | null) => v !== null && costIn > 1e-12 ? (v / costIn) * 100 : null;
      const dust = value !== null && perUnitXnt !== null && value * perUnitXnt < DUST_XNT && !!p?.sold;
      rows.push({
        wallet: h.owner, label: h.label, status: dust ? "sold" : h.status, balance: bal, pctSupply: h.pct, avgBuy: avgBuy(p), ...estimates(p),
        avgCost: avg, value, costBasis: costKnown, pnl, pnlPct: pnl !== null && costKnown > 0 ? (pnl / costKnown) * 100 : null,
        soldNow, pnlIfSold, pnlIfSoldPct: pnlIfSold !== null && costKnown > 0 ? (pnlIfSold / costKnown) * 100 : null,
        pl, plPct: pctOf(pl), plIfSold, plIfSoldPct: pctOf(plIfSold),
        rewardsXnt, returnXnt: totalReturn(pnl, p ? x(p.realized) : 0, rewardsXnt),
        unknownCost: bal - heldFromBuys > 1e-9 ? bal - heldFromBuys : 0,
        bought: p ? Number(p.bought) / dec : 0, sold: p ? Number(p.sold) / dec : 0,
        movedOut: p ? Number(p.movedOut) / dec : 0, lpOut: p ? Number(p.lpOut) / dec : 0, movedCost: p ? x(p.movedCost) : 0,
        spent: p ? x(p.spent) : 0, received: p ? x(p.received) : 0, realized: p ? x(p.realized) : 0,
        trades: p?.trades ?? 0, firstAt: p?.firstAt ?? null, lastAt: p?.lastAt ?? null,
      });
    }
    // Wallets that traded and no longer hold any (not ones that only received and passed tokens on).
    for (const p of pos.values()) {
      if (seen.has(p.wallet) || !p.trades) continue;
      const pl = p.spent > 0n ? x(p.realized) : null, costIn = x(p.spent) - x(p.movedCost) - x(p.cost);
      rows.push({
        wallet: p.wallet, label: null, status: "sold", balance: 0, pctSupply: 0, avgBuy: avgBuy(p), ...estimates(p), avgCost: null, value: 0, costBasis: 0, pnl: null, pnlPct: null, unknownCost: 0,
        // Sold out: nothing left to value, so the result is realized profit plus rewards.
        pl, plPct: pl !== null && costIn > 1e-12 ? (pl / costIn) * 100 : null, plIfSold: pl, plIfSoldPct: null,
        rewardsXnt: rewardOf(p.wallet), returnXnt: totalReturn(0, x(p.realized), rewardOf(p.wallet)),
        bought: Number(p.bought) / dec, sold: Number(p.sold) / dec, movedOut: Number(p.movedOut) / dec, lpOut: Number(p.lpOut) / dec, movedCost: x(p.movedCost),
        spent: x(p.spent), received: x(p.received), realized: x(p.realized),
        trades: p.trades, firstAt: p.firstAt, lastAt: p.lastAt,
      });
    }
    const priced = rows.filter((r) => r.balance > 0 && r.avgCost !== null);
    const tokensKnown = priced.reduce((a, r) => a + (r.balance - r.unknownCost), 0);
    const costKnown = priced.reduce((a, r) => a + r.costBasis, 0);
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, price, quote: pair.symbol, quoteXnt: perUnitXnt,
      // Every pool holding the token (null until first read); values in XNT.
      liquidity: liquidityOf(t.mint, st.priceXnt ?? null),
      summary: {
        rewardsPaid: rows.reduce((a, r) => a + r.rewardsXnt, 0),
        holders: rows.filter((r) => r.balance > 0).length,
        traders: [...pos.values()].filter((p) => p.trades).length, trades: idx.trades.filter((t) => !t.kind || t.kind === "unpriced").length, trackedSince: idx.since || null, tradesComplete: !idx.backfill,
        avgCost: tokensKnown > 0 ? costKnown / tokensKnown : null,
        inProfit: priced.filter((r) => (r.pl ?? 0) > 0).length, inLoss: priced.filter((r) => (r.pl ?? 0) < 0).length,
        realized: rows.reduce((a, r) => a + r.realized, 0), unrealized: priced.reduce((a, r) => a + (r.pnl ?? 0), 0),
      },
      rows: rows.sort((a, b) => b.balance - a.balance || b.bought - a.bought),
    };
  })();
  data.catch(() => boardCache.delete(mintStr));
  boardCache.set(mintStr, { at: Date.now(), data });
  return data;
}

/** Headline numbers for the landing page, across every launched token. */
let statsCache: { at: number; data: unknown } | null = null;
async function stats() {
  if (statsCache && Date.now() - statsCache.at < 30_000) return statsCache.data;
  const tokens = registeredLaunches();
  let xntPaid = 0n, xntToLiquidity = 0n, launchXnt = 0, wallets = 0, payouts = 0;
  for (const t of tokens) {
    const p = tokenPayouts(t.mint);
    xntPaid += BigInt(p.xntPaid); xntToLiquidity += BigInt(p.xntToLiquidity);
    wallets += p.wallets; payouts += p.payouts;
    // A JACK launch's pool amount is JACK: count its XNT value at today's JACK price.
    const pair = pairOf(cfg, t);
    launchXnt += Number(t.poolXnt) * (pair.xntPool ? (await pairValue(pair).catch(() => null))?.xntPer ?? 0 : 1);
  }
  const data = {
    tokens: tokens.length, xntPaid: xntPaid.toString(), xntToLiquidity: xntToLiquidity.toString(),
    walletsPaid: wallets, payouts, launchLiquidityXnt: launchXnt,
    lockedForever: tokens.filter((t) => t.lockDays === null).length,
  };
  statsCache = { at: Date.now(), data };
  return data;
}

/** A launch without anything secret (the record never holds keys, but be explicit). */
function publicView(r: ReturnType<typeof listLaunches>[number]) {
  const { mint, name, symbol, description, image, supply, taxBps, autoLpBps, poolTokens, poolXnt, lockDays, pool, creator, createdAt, registeredAt, distributor } = r;
  const burnBps = r.burnBps ?? 0;
  return { mint, name, symbol, description, image, website: r.website, twitter: r.twitter, telegram: r.telegram, supply, taxBps, autoLpBps, burnBps, poolTokens, poolXnt, lockDays, pool, creator, createdAt, registeredAt, distributor,
    lockNft: r.lockNft ?? null, creatorExcluded: creatorExcluded(r), kind: r.kind ?? "launch",
    // The pair token the pool was seeded with (poolXnt is that token's amount).
    quote: r.quote ?? "XNT", quoteMint: r.quoteMint ?? null };
}

const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json") =>
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(type === "application/json" ? JSON.stringify(body) : body as string);

/**
 * The visitor's address. X-Forwarded-For is only believed when the request comes from this
 * machine (the local Caddy, which sets it: it replaces a client's own value, or in Vercel
 * mode passes on the one Vercel sets). Anyone else could write any address into it.
 */
function clientIp(req: http.IncomingMessage) {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const fwd = req.headers["x-forwarded-for"];
  if ((peer === "127.0.0.1" || peer === "::1") && typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return peer;
}

/**
 * Sent with every response. frame-ancestors/X-Frame-Options stop other sites framing the
 * pages to trick people into approving a transaction; the CSP limits scripts to this site
 * (plus Cloudflare's captcha on the faucet) and fetches to this site.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'", "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:", "connect-src 'self'", "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join("; "),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

const RECOVERY_FILE = pinnedRecoveryFile(ROOT, cfg.network);
const RECOVERY_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data: https:",
  "connect-src https: http://127.0.0.1:* http://localhost:*", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  const url = new URL(req.url ?? "/", "http://localhost");
  const ip = clientIp(req);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    if (url.pathname.startsWith("/api/")) rateLimit(req.method === "POST" ? "post" : "get", ip);
    if (req.method === "POST") {
      const origin = req.headers.origin ?? "";
      if (![...allowedHosts].some((h) => origin === `http://${h}` || origin === `https://${h}`)) { res.writeHead(403).end("Forbidden origin"); return; }
      const out = await post(url.pathname, await readJson(req, url.pathname === "/api/upload-logo" ? Math.ceil(MAX_LOGO_BYTES * 1.4) + 2_000
        : url.pathname === "/api/nft/receipt" || url.pathname === "/api/launch/receipt" ? Math.ceil(MAX_RECEIPT_PNG_BYTES * 1.4) + 2_000 : 64_000), ip);
      if (!out) { res.writeHead(404).end("Not found"); return; }
      send(res, 200, out);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") { send(res, 200, page(LANDING), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/tokens") { send(res, 200, page(TOKENS_PAGE), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/wallet" || /^\/wallet\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname)) {
      send(res, 200, page(WALLET_PAGE), "text/html; charset=utf-8"); return;
    }
    if (url.pathname === "/analytics") { send(res, 200, page(ANALYTICS_PAGE), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/nft" || /^\/nft\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname)) {
      send(res, 200, page(NFT_PAGE), "text/html; charset=utf-8"); return;
    }
    if (url.pathname === "/leaderboard" || /^\/leaderboard\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname)) {
      send(res, 200, page(LEADERBOARD_PAGE), "text/html; charset=utf-8"); return;
    }
    if (url.pathname === "/faucet") { send(res, 200, page(FAUCET_PAGE), "text/html; charset=utf-8"); return; }
    if (curves && (url.pathname === "/curve" || /^\/curve\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(url.pathname))) {
      send(res, 200, page(CURVE_PAGE), "text/html; charset=utf-8"); return;
    }
    if (url.pathname === "/launch") { send(res, 200, page(PAGE), "text/html; charset=utf-8"); return; }
    // The pinned recovery page, byte-identical to its IPFS copy (checked by sha256 at start).
    // It talks to X1 RPCs and IPFS gateways itself, so it gets its own connect-src.
    if (url.pathname === "/recovery" && RECOVERY_FILE) {
      res.setHeader("content-security-policy", RECOVERY_CSP);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" }).end(RECOVERY_FILE);
      return;
    }
    if (url.pathname === "/theme.js") {
      send(res, 200, `const SITE_THEME = ${JSON.stringify(f!.theme ?? "receipt")};\n`
        + `const SITE_NET = ${JSON.stringify({ network: cfg.network, other: f!.otherNetwork ?? null })};\n` + fs.readFileSync(path.join(ROOT, "src", "web", "theme.js"), "utf8"), "text/javascript; charset=utf-8");
      return;
    }
    const themeReq = /^\/theme(?:-(\w+))?\.css$/.exec(url.pathname);
    if (themeReq) {
      const name = themeReq[1] ?? f!.theme ?? "receipt";
      if (!(THEMES as readonly string[]).includes(name)) { res.writeHead(404).end("Not found"); return; }
      send(res, 200, themeCss(name), "text/css; charset=utf-8"); return;
    }
    const brand = /^\/brand\/(logo-(?:512|192|64|32|wide-120)\.png)$/.exec(url.pathname);
    if (brand || url.pathname === "/favicon.ico") {
      const file = path.join(ROOT, "src", "web", "brand", brand ? brand[1] : "logo-64.png");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }).end(fs.readFileSync(file));
      return;
    }
    // Page translations: the language helper, and one dictionary per language (src/web/i18n/<lang>.js).
    if (url.pathname === "/i18n.js") { send(res, 200, fs.readFileSync(I18N_JS, "utf8"), "text/javascript; charset=utf-8"); return; }
    const dict = /^\/i18n\/([a-z]{2})\.js$/.exec(url.pathname);
    if (dict) {
      const file = path.join(ROOT, "src", "web", "i18n", `${dict[1]}.js`);
      if (!fs.existsSync(file)) { res.writeHead(404).end("Not found"); return; }
      // ~120 KB, so browsers keep it a few minutes; a stale copy only leaves new strings in English.
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }).end(fs.readFileSync(file, "utf8"));
      return;
    }
    if (url.pathname === "/countdown.js") { send(res, 200, fs.readFileSync(COUNTDOWN_JS, "utf8"), "text/javascript"); return; }
    if (url.pathname === "/wallet.js") { send(res, 200, fs.readFileSync(WALLET_JS, "utf8"), "text/javascript"); return; }
    if (url.pathname === "/vendor/web3.js") { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" }).end(fs.readFileSync(WEB3_BUNDLE)); return; }
    const meta = /^\/meta\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(url.pathname);
    if (meta) {
      const r = readLaunch(meta[1]);
      if (!r) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=300" })
        .end(JSON.stringify(tokenMetadataJson(r, publicUrl)));
      return;
    }
    const out = await get(url);
    if (!out) { res.writeHead(404).end("Not found"); return; }
    send(res, 200, out);
  } catch (e) {
    send(res, e instanceof RateLimited ? 429 : 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use; set factory.port in config.json.` : e.message);
  process.exit(1);
});
// Index every token's swaps every 10 minutes: public RPCs only keep about a day of
// history, so trades have to be saved before they age out (the leaderboard needs them).
async function indexAllTrades() {
  for (const t of targets(cfg)) {
    await refreshTrades(conn, t.mint, t.stateDir, t.quote?.mint)
      .catch((e) => console.error(`Trade index for ${t.symbol} failed: ${e instanceof Error ? e.message : e}`));
  }
}
setTimeout(() => indexAllTrades(), 5_000);
setInterval(() => indexAllTrades(), 10 * 60_000).unref();

// Warm the main read-only views (one at a time, gentle on the RPC) so the first visitor
// after a restart doesn't wait on rate-limited chain reads.
async function warmViews() {
  const paths = ["/api/tokens", "/api/token-list", "/api/stats"];
  for (const r of registeredLaunches()) {
    paths.push(`/api/token/${r.mint}/stats`, `/api/leaderboard/${r.mint}`);
    if (r.lockNft) paths.push(`/api/nft/${r.lockNft}`);
  }
  for (const p of paths) await get(new URL(p, "http://localhost")).catch(() => undefined);
}
setTimeout(() => warmViews(), 15_000);
setInterval(() => warmViews(), 300_000).unref();

// Keep the Locked NFTs list warm so visitors never wait for its chain reads.
setTimeout(() => allNfts().catch(() => undefined), 2_000);
setInterval(() => allNfts().catch(() => undefined), 180_000).unref(); // every 3 min: public RPCs rate-limit
// Curve crank: graduate complete curves, deliver buyers' tokens, register graduated
// tokens with the distributor. Transactions only go out with factory.curve.crankKeypair.
if (curves) {
  if (!curves.crankOn()) console.log("Curve crank: no factory.curve.crankKeypair, so curves are not graduated or delivered by this server.");
  setTimeout(() => curves.crankOnce().catch(() => undefined), 8_000);
  setInterval(() => curves.crankOnce().catch(() => undefined), 20_000).unref();
}
// Tax Vault crank: collect, sell, add liquidity, fund creators, publish rewards lists and
// pay holders for every vault token. Transactions only go out with factory.taxVault.publisherKeypair.
if (vaults) {
  if (vaults.crankOn() && !ipfsEnabled(cfg)) console.log("Tax vault crank: no Pinata key (factory.pinataJwt), so no new rewards lists are published (their files must be on IPFS); payouts of published lists go on.");
  if (!vaults.crankOn()) {
    console.log("Tax vault crank: no factory.taxVault.publisherKeypair, so vault tokens are not cranked by this server.");
    // Still look for vaults on-chain (read-only) so vault tokens show as such.
    setTimeout(() => vaults.discover(), 5_000);
    setInterval(() => vaults.discover(), 600_000).unref();
  } else {
    setTimeout(() => vaults.crankOnce().catch(() => undefined), 12_000);
    setInterval(() => vaults.crankOnce().catch(() => undefined), vaults.passMs).unref();
  }
  // Each vault's network fees for the token pages' "Cost to run" (read-only, every 10 minutes).
  setTimeout(() => vaults.refreshCosts().catch(() => undefined), 30_000);
  setInterval(() => vaults.refreshCosts().catch(() => undefined), 600_000).unref();
}
server.listen(port, bind, () => console.log(`Token factory (${cfg.network}): http://${bind}:${port}  (metadata URIs use ${publicUrl})`));
