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
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { FACTORY_DIR, ROOT, connection, loadConfig } from "./config.js";
import { allowRelayProgram, networkFee, sendSigned, unsignedTx } from "./web/wallet-tx.js";
import {
  CREATOR_BPS, CREATOR_REWARD, applyMetadataUpdate, buildLockStep, buildMetadataUpdate, launchFee, tokenMetadataJson, buildPoolStep, buildTokenStep, creatorExcluded, launchStatus, listLaunches,
  readLaunch, registerLaunch,
  registeredLaunches, validateParams,
} from "./factory/launch.js";
import { XDEX_CREATE } from "./xdex.js";
import { readRewardVault, rewardSummary } from "./locker.js";
import { DUST_LAMPORTS, buildClaimReward, buildCollect, buildReceipt, receiptImage } from "./locker-tx.js";
import { receiptData, receiptSvg, receiptUri } from "./web/receipt.js";
import { isqrt, listLocks, lockPda, lockedLp, nftHolder, pendingFeeLp } from "./locker.js";
import { snapshot } from "./xdex.js";
import { positions, refreshTrades } from "./trades.js";
import { checkCaptcha, faucetClaim, faucetFundIxs, faucetStatus } from "./factory/faucet.js";
import { MAX_LOGO_BYTES, ipfsEnabled, pinLogo } from "./factory/ipfs.js";
import { buildMintPass, buildTree, claimPassIx, decodePass, listPasses, passPda, readHolderPool } from "./holder-pass.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { findTarget, readiness, runCycle, targets, tipInstruction, verifyTip } from "./factory/trigger.js";
import { Config, toBaseUnits } from "./config.js";
import { BURN_OWNERS, eligibleBalances, scanTokenAccounts } from "./holders.js";
import { poolAuthority } from "./xdex.js";
import { unpackMint } from "@solana/spl-token";


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
/** Serve a page; without a faucet (e.g. mainnet), leave its "Faucet" tab out. */
function page(file: string) {
  const html = fs.readFileSync(file, "utf8");
  return faucetOn() ? html : html.replace(/\s*<a href="\/faucet"[^>]*>Faucet<\/a>/g, "");
}
const faucetOn = () => cfg.network === "testnet" && !!cfg.factory?.faucet && !!cfg.factory?.feeToken
  && fs.existsSync(path.isAbsolute(cfg.factory.faucet.keypair) ? cfg.factory.faucet.keypair : path.join(ROOT, cfg.factory.faucet.keypair));
/** Site themes: each file holds its fonts and colour tokens, then (after the AFTER BASE marker) extras. */
const THEMES = ["receipt", "arcade", "lunchbag", "notebook"] as const;
function themeCss(name: string) {
  const [head, extra = ""] = fs.readFileSync(path.join(ROOT, "src", "web", `theme-${name}.css`), "utf8").split("/* AFTER BASE */");
  return head + fs.readFileSync(path.join(ROOT, "src", "web", "theme-base.css"), "utf8") + extra;
}
const WALLET_JS = path.join(ROOT, "src", "web", "wallet.js");
const COUNTDOWN_JS = path.join(ROOT, "src", "web", "countdown.js");
const WEB3_BUNDLE = path.join(ROOT, "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
const opts = { microLamports: cfg.distribution.priorityMicroLamports };

const rewardMint = new PublicKey(CREATOR_REWARD[cfg.network].rewardMint ?? NATIVE_MINT);
const rewardSymbol = CREATOR_REWARD[cfg.network].rewardMint ? "USDC" : "XNT";
const rewardDecimals = CREATOR_REWARD[cfg.network].rewardMint ? 6 : 9;

/** Creator rewards for a launch's lock NFT, in whole reward-token units. */
async function creatorRewards(lockNft: string | null | undefined) {
  if (!lockNft) return null;
  const v = await readRewardVault(conn, new PublicKey(cfg.locker!.programId), new PublicKey(lockNft), rewardMint);
  if (!v) return { claimable: "0", vesting: "0", claimed: "0", nextUnlock: null, nextAmount: "0", symbol: rewardSymbol, decimals: rewardDecimals };
  const s = rewardSummary(v);
  return { claimable: s.claimable.toString(), vesting: s.vesting.toString(), claimed: s.totalClaimed.toString(), nextUnlock: s.nextUnlock,
    nextAmount: s.nextAmount.toString(), symbol: rewardSymbol, decimals: rewardDecimals };
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

/** The launch record for `mint`, checked to belong to `creator`. */
function ownLaunch(body: Record<string, unknown>) {
  const r = readLaunch(String(body.mint));
  if (!r) throw new Error("Unknown launch");
  if (r.creator !== new PublicKey(String(body.creator)).toBase58()) throw new Error("This launch belongs to another wallet");
  return r;
}

async function post(url: string, body: Record<string, unknown>, ip: string) {
  if (url === "/api/launch/token") {
    rateLimit("launch", ip, "launches started");
    const p = validateParams(body);
    const { ixs, signers, record } = await buildTokenStep(conn, cfg, p, publicUrl);
    return { tx: await unsignedTx(conn, new PublicKey(p.creator), ixs, signers, opts), mint: record.mint };
  }
  if (url === "/api/launch/pool") {
    const r = ownLaunch(body);
    const s = await launchStatus(conn, cfg, r);
    if (!s.token) throw new Error("Step 1 (token) hasn't confirmed yet.");
    if (s.pool) throw new Error("The pool already exists.");
    const { ixs } = buildPoolStep(cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], opts) };
  }
  if (url === "/api/launch/lock") {
    const r = ownLaunch(body);
    const s = await launchStatus(conn, cfg, r);
    if (!s.pool) throw new Error("Step 2 (pool) hasn't confirmed yet.");
    if (s.lock) throw new Error("The LP is already locked.");
    const { ixs, signers } = await buildLockStep(conn, cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, signers, opts) };
  }
  if (url === "/api/launch/receipt") {
    // Write the lock receipt (JSON + SVG) into the NFT's on-chain metadata.
    const r = ownLaunch(body);
    const nft = r.lockNft ?? (await launchStatus(conn, cfg, r)).lockNft;
    if (!nft) throw new Error("The LP isn't locked yet.");
    const { ixs } = await buildReceipt(conn, cfg, new PublicKey(r.creator), new PublicKey(nft));
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
    const { ixs } = await buildReceipt(conn, cfg, authority, new PublicKey(String(body.nftMint)));
    return { tx: await unsignedTx(conn, authority, ixs, [], { ...opts, noBudget: true }) };
  }
  if (url === "/api/nft/collect" || url === "/api/nft/claim") {
    const nft = new PublicKey(String(body.nftMint));
    const holder = new PublicKey(String(body.holder));
    await requireNftHolder(nft, holder);
    if (url === "/api/nft/claim") {
      const { ixs } = await buildClaimReward(conn, cfg, holder, nft, rewardMint);
      return { tx: await unsignedTx(conn, holder, ixs, [], opts) };
    }
    const d = await receiptData(conn, cfg, nft);
    if (!d) throw new Error("That isn't an LP-lock NFT from this locker.");
    const { ixs, summary } = await buildCollect(conn, cfg, holder, nft, false, nftTarget(d));
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
    const { ixs } = await buildClaimReward(conn, cfg, holder, new PublicKey(nft), rewardMint);
    return { tx: await unsignedTx(conn, holder, ixs, [], opts) };
  }
  if (url === "/api/distribute/tip") {
    const t = findTarget(cfg, String(body.mint));
    const r = await readiness(conn, cfg, t);
    if (!r.ready) throw new Error(r.reason ?? "Not ready");
    const payer = new PublicKey(String(body.payer));
    return { tx: await unsignedTx(conn, payer, [tipInstruction(payer, t, tipLamports)], [], opts), tipXnt };
  }
  if (url === "/api/distribute/run") {
    const t = findTarget(cfg, String(body.mint));
    const clicker = await verifyTip(conn, t, String(body.signature), tipLamports);
    const r = await readiness(conn, cfg, t);
    if (r.reason && !/Not enough tax/.test(r.reason)) throw new Error(`${r.reason} Your tip was added to this token's gas.`);
    runCycle(t, clicker);
    readinessCache.delete(t.mint);
    return { started: true };
  }
  if (url === "/api/send") rateLimit("send", ip, "transactions");
  if (url === "/api/send") return { signature: await sendSigned(conn, String(body.tx)) };
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
  const onChain = meta ? receiptImage(meta.uri) : null;
  // Trading fees this NFT's liquidity has earned, as its current holder would collect them.
  const fees = holder ? await collectQuote(holder.owner, nft, nftTarget(d)).catch(() => null) : null;
  return {
    fees, rewards: await creatorRewards(mintStr),
    ...d, explorer, name: meta?.name ?? `${d.symbol} LP Lock`,
    image: onChain ?? `data:image/svg+xml,${encodeURIComponent(receiptSvg(d))}`, printed: !!onChain,
    // False once the design or the numbers (e.g. pool share) have moved on since it was printed.
    upToDate: !!onChain && onChain === receiptImage(receiptUri(d)),
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
async function collectFeeEstimate(sample: { holder: PublicKey; nft: PublicKey; where: { pool: PublicKey; mint: PublicKey; symbol: string } }) {
  if (collectFeeCache && Date.now() - collectFeeCache.at < 600_000) return collectFeeCache.fee;
  const q = await collectQuote(sample.holder, sample.nft, sample.where).catch(() => null);
  collectFeeCache = { at: Date.now(), fee: q?.networkFee ? BigInt(q.networkFee) : null };
  return collectFeeCache.fee;
}

async function buildNfts() {
  const programId = new PublicKey(cfg.locker!.programId);
  // Every token, and every lock within it, is read in parallel.
  const perToken = await Promise.all(targets(cfg).map(async (t) => {
    const [snap, locks] = await Promise.all([
      snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), new PublicKey(t.mint)),
      listLocks(conn, programId, new PublicKey(t.pool)),
    ]);
    const supply = snap.pool.lpSupply;
    const lpXnt = (lp: bigint) => (supply > 0n ? (lp * 2n * snap.reserveXnt) / supply : 0n);
    const sqrtK = isqrt(snap.reserveToken * snap.reserveXnt);
    const where = { pool: new PublicKey(t.pool), mint: new PublicKey(t.mint), symbol: t.symbol };
    return Promise.all(locks.map(async (l) => {
      const [lp, holder, meta, rw] = await Promise.all([
        lockedLp(conn, programId, l.address), nftHolder(conn, l.nftMint),
        getTokenMetadata(conn, l.nftMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null), creatorRewards(l.nftMint.toBase58()),
      ]);
      const ready = pendingFeeLp(lp, l.principal, sqrtK, supply);
      const feesCollected = lpXnt(l.feeLpCollected), feesReady = lpXnt(ready);
      const fee = holder ? await collectFeeEstimate({ holder: holder.owner, nft: l.nftMint, where }) : null;
      const rewards = rw ? { claimed: rw.claimed, ready: rw.claimable, vesting: rw.vesting, nextUnlock: rw.nextUnlock, nextAmount: rw.nextAmount, symbol: rw.symbol, decimals: rw.decimals } : null;
      // Rewards are XNT on testnet; on mainnet (USDC) they're listed separately, not added in.
      const rewardXnt = rw && rw.symbol === "XNT" ? BigInt(rw.claimed) + BigInt(rw.claimable) + BigInt(rw.vesting) : 0n;
      return {
        nftMint: l.nftMint.toBase58(), symbol: t.symbol, tokenName: t.name, tokenMint: t.mint,
        name: meta?.name ?? `${t.symbol} LP Lock`, receipt: meta ? receiptImage(meta.uri) : null,
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
async function collectQuote(holder: PublicKey, nft: PublicKey, where: { pool: PublicKey; mint: PublicKey; symbol: string }) {
  const { ixs, summary: s } = await buildCollect(conn, cfg, holder, nft, true, where);
  const fee = ixs ? await networkFee(conn, holder, ixs, opts).catch(() => null) : null;
  return {
    xnt: s.xntOut.toString(), tokens: s.tokenOut.toString(), worth: s.worth.toString(),
    networkFee: fee === null ? null : fee.toString(),
    collectable: s.feeLp > 0n && s.worth >= DUST_LAMPORTS && (fee === null || s.worth > fee),
  };
}

const nftTarget = (d: { pool: string; tokenMint: string; symbol: string }) =>
  ({ pool: new PublicKey(d.pool), mint: new PublicKey(d.tokenMint), symbol: d.symbol });

async function get(url: URL) {
  if (url.pathname === "/api/nfts") return allNfts();
  const nftApi = /^\/api\/nft\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (nftApi) return nftView(nftApi[1]);
  if (url.pathname === "/api/info") {
    const ammInfo = await conn.getAccountInfo(new PublicKey(XDEX_CREATE[cfg.network].ammConfig));
    return {
      logoUpload: ipfsEnabled(cfg), maxLogoBytes: MAX_LOGO_BYTES, network: cfg.network, explorer, feeAmount: launchFee(cfg).amount, feeSymbol: launchFee(cfg).symbol, feeMint: launchFee(cfg).mint, feeReceiver: f!.feeReceiver,
      creatorBps: CREATOR_BPS, creatorRewardSymbol: rewardSymbol,
      gasXnt: f!.gasXnt ?? "0.05", poolCreateFeeXnt: ammInfo ? Number(ammInfo.data.readBigUInt64LE(36)) / 1e9 : null,
      lockerProgram: cfg.locker!.programId, xdexProgram: cfg.xdex.programId,
    };
  }
  if (url.pathname === "/api/launches") {
    const creator = new PublicKey(url.searchParams.get("creator") ?? "").toBase58();
    const mine = listLaunches().filter((r) => r.creator === creator).slice(0, 20);
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
          const q = await collectQuote(holder.owner, new PublicKey(nft), { pool: new PublicKey(r.pool), mint: new PublicKey(r.mint), symbol: r.symbol }).catch(() => null);
          if (q) fees = { ...q, holder: holder.owner.toBase58() };
        }
      }
      return { ...publicView(r), status, lockNft: nft, receipt: nftMeta ? receiptImage(nftMeta.uri) : null, rewards: await creatorRewards(nft), fees, nftHolder: nftHolderAddr };
    }));
  }
  if (url.pathname === "/api/tokens") return registeredLaunches().map((r) => ({ ...publicView(r), paid: tokenPayouts(r.mint) }));
  if (url.pathname === "/api/stats") return stats();
  if (url.pathname === "/api/token-list") return tokenList();
  const lb = /^\/api\/leaderboard\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (lb) return leaderboard(lb[1]);
  if (url.pathname === "/api/faucet") return faucetStatus(conn, cfg, url.searchParams.get("wallet") ?? undefined);
  const wp = /^\/api\/passes\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (wp) return walletPasses(new PublicKey(wp[1]).toBase58());
  const wv = /^\/api\/wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (wv) return walletView(wv[1]);
  const ts = /^\/api\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})\/stats$/.exec(url.pathname);
  if (ts) return tokenStats(ts[1]);
  if (url.pathname === "/api/analytics") return analytics();
  if (url.pathname === "/api/distribute/list") {
    const list = await Promise.all(targets(cfg).map((t) => cachedReadiness(t.mint)));
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

/** Totals from one token's event log, in base units. */
function eventTotals(events: Record<string, any>[]) {
  const t = { holdersXnt: 0n, liquidityXnt: 0n, creatorXnt: 0n, clickerXnt: 0n, burned: 0n, payouts: 0, wallets: new Set<string>(), lastRun: null as string | null };
  for (const e of events) {
    if (e.kind === "payout") { t.holdersXnt += BigInt(e.total ?? 0); t.payouts++; for (const [w] of e.payments ?? []) t.wallets.add(w); }
    else if (e.kind === "auto-lp") t.liquidityXnt += BigInt(e.xnt ?? 0);
    else if (e.kind === "creator-reward") t.creatorXnt += BigInt(e.amount ?? 0);
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
    const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), new PublicKey(t.mint)).catch(() => null);
    const e = eventTotals(tokenEvents(t.stateDir));
    const st = await (tokenStats(t.mint) as Promise<{ yield: ReturnType<typeof holderYield> }>).catch(() => null);
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, pool: t.pool, ...info, yield: st?.yield ?? null, holderPass: claimsOn(t),
      priceXnt: snap && snap.reserveToken > 0n ? Number(snap.reserveXnt) / Number(snap.reserveToken) : null,
      liquidityXnt: snap ? (2n * snap.reserveXnt).toString() : null,
      holdersXnt: e.holdersXnt.toString(), liquidityAddedXnt: e.liquidityXnt.toString(), creatorXnt: e.creatorXnt.toString(),
      burned: e.burned.toString(), walletsPaid: e.wallets.size, payouts: e.payouts, lastRun: e.lastRun,
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
      else if (x.kind === "creator-reward") b.creator += BigInt(x.amount ?? 0);
      days.set(hour, b);
      if (["payout", "auto-lp", "burn", "creator-reward", "clicker-reward"].includes(x.kind)) {
        recent.push({ at: x.at, kind: x.kind, symbol: t.symbol, signature: x.signature ?? null,
          xnt: x.kind === "payout" ? String(x.total ?? 0) : x.kind === "creator-reward" ? String(x.amount ?? 0) : x.xnt ?? null,
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
    const [rows, mintInfo, snap] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed"),
      snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), mint).catch(() => null)]);
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
    const minHolding = toBaseUnits(dc.minHoldingTokens, m.decimals);
    const earning = eligibleBalances(rows, { excluded, excludeOffCurve: dc.excludeOffCurveOwners, minHolding });

    const perOwner = new Map<string, bigint>();
    for (const r of rows) if (r.amount > 0n) perOwner.set(r.owner, (perOwner.get(r.owner) ?? 0n) + r.amount);
    for (const w of paid.keys()) if (!perOwner.has(w)) perOwner.set(w, 0n); // sold out, but was paid
    let earningTotal = 0n;
    for (const b of earning.values()) earningTotal += b;
    const valueOf = (bal: bigint) => (snap && snap.reserveToken > 0n ? (bal * snap.reserveXnt) / snap.reserveToken : 0n);
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
    const priceXnt = snap && snap.reserveToken > 0n ? Number(snap.reserveXnt) / Number(snap.reserveToken) : null;
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
      marketCapXnt: snap && snap.reserveToken > 0n ? ((m.supply * snap.reserveXnt) / snap.reserveToken).toString() : null,
      poolXnt: snap ? (2n * snap.reserveXnt).toString() : null,
      launchPriceXnt: launch && Number(launch.poolTokens) > 0 ? Number(launch.poolXnt) / Number(launch.poolTokens) : null,
      // Where the original supply sits now.
      breakdown: {
        pool: poolTokens.toString(), earning: earningTotal.toString(),
        other: (m.supply > poolTokens + earningTotal ? m.supply - poolTokens - earningTotal : 0n).toString(),
      },
      payoutSeries,
      burned: burnedTotal.toString(), burnedPct: original > 0n ? Number((burnedTotal * 1_000_000n) / original) / 10_000 : 0, taxBurned: e.burned.toString(),
      liquidityXnt: e.liquidityXnt.toString(), holdersXnt: e.holdersXnt.toString(), creatorXnt: e.creatorXnt.toString(),
      payouts: e.payouts, walletsPaid: e.wallets.size, earning: earning.size, minHolding: dc.minHoldingTokens, lastRun: e.lastRun,
      holders,
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
      payoutSharePct: h.payoutSharePct, priceXnt: s.priceXnt, yield: s.yield, minHolding: s.minHolding,
      estPerDayXnt: h.status === "earning" && s.yield ? (s.yield.per1000PerDay / 1000) * bal : 0,
    });
  }
  const nfts = ((await allNfts()) as any[]).filter((n) => n.holder === owner);
  return { wallet: owner, explorer, tokens, nfts };
}

/**
 * Holder leaderboard for one token: every holder's average cost (XNT per token) from
 * their swaps, what their holding is worth now, and profit/loss. Trades are indexed
 * incrementally; results are cached for a minute.
 */
const boardCache = new Map<string, { at: number; data: Promise<unknown> }>();
function leaderboard(mintStr: string) {
  const hit = boardCache.get(mintStr);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const data = (async () => {
    const t = findTarget(cfg, mintStr);
    const [idx, st] = await Promise.all([
      refreshTrades(conn, new PublicKey(t.pool), t.mint, t.stateDir),
      tokenStats(t.mint) as Promise<any>,
    ]);
    const skip = new Set([t.distributor, poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58(), ...BURN_OWNERS]);
    const pos = positions(idx.trades, skip);
    const dec = 10 ** st.decimals;
    const price: number | null = st.priceXnt;
    const x = (v: bigint) => Number(v) / 1e9;
    const rows: any[] = [];
    const seen = new Set<string>();
    for (const h of st.holders) {
      if (skip.has(h.owner)) continue;
      seen.add(h.owner);
      const p = pos.get(h.owner);
      const bal = Number(BigInt(h.balance)) / dec;
      const heldFromBuys = p ? Math.min(bal, Number(p.held) / dec) : 0; // the rest arrived by transfer
      const avg = p && p.held > 0n ? x(p.cost) / (Number(p.held) / dec) : null;
      const costKnown = avg !== null ? avg * heldFromBuys : 0;
      const value = price !== null ? bal * price : null;
      const pnl = value !== null && avg !== null && price !== null ? price * heldFromBuys - costKnown : null;
      rows.push({
        wallet: h.owner, label: h.label, status: h.status, balance: bal, pctSupply: h.pct,
        avgCost: avg, value, costBasis: costKnown, pnl, pnlPct: pnl !== null && costKnown > 0 ? (pnl / costKnown) * 100 : null,
        unknownCost: bal - heldFromBuys > 1e-9 ? bal - heldFromBuys : 0,
        bought: p ? Number(p.bought) / dec : 0, sold: p ? Number(p.sold) / dec : 0,
        spent: p ? x(p.spent) : 0, received: p ? x(p.received) : 0, realized: p ? x(p.realized) : 0,
        trades: p?.trades ?? 0, firstAt: p?.firstAt ?? null, lastAt: p?.lastAt ?? null,
      });
    }
    // Wallets that traded and no longer hold any.
    for (const p of pos.values()) {
      if (seen.has(p.wallet)) continue;
      rows.push({
        wallet: p.wallet, label: null, status: "sold", balance: 0, pctSupply: 0, avgCost: null, value: 0, costBasis: 0, pnl: null, pnlPct: null, unknownCost: 0,
        bought: Number(p.bought) / dec, sold: Number(p.sold) / dec, spent: x(p.spent), received: x(p.received), realized: x(p.realized),
        trades: p.trades, firstAt: p.firstAt, lastAt: p.lastAt,
      });
    }
    const priced = rows.filter((r) => r.balance > 0 && r.avgCost !== null);
    const tokensKnown = priced.reduce((a, r) => a + (r.balance - r.unknownCost), 0);
    const costKnown = priced.reduce((a, r) => a + r.costBasis, 0);
    return {
      mint: t.mint, symbol: t.symbol, name: t.name, price,
      summary: {
        holders: rows.filter((r) => r.balance > 0).length, traders: pos.size, trades: idx.trades.length, trackedSince: idx.since ?? null,
        avgCost: tokensKnown > 0 ? costKnown / tokensKnown : null,
        inProfit: priced.filter((r) => (r.pnl ?? 0) > 0).length, inLoss: priced.filter((r) => (r.pnl ?? 0) < 0).length,
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
function stats() {
  if (statsCache && Date.now() - statsCache.at < 30_000) return statsCache.data;
  const tokens = registeredLaunches();
  let xntPaid = 0n, xntToLiquidity = 0n, launchXnt = 0, wallets = 0, payouts = 0;
  for (const t of tokens) {
    const p = tokenPayouts(t.mint);
    xntPaid += BigInt(p.xntPaid); xntToLiquidity += BigInt(p.xntToLiquidity);
    wallets += p.wallets; payouts += p.payouts; launchXnt += Number(t.poolXnt);
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
    lockNft: r.lockNft ?? null, creatorExcluded: creatorExcluded(r) };
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
      const out = await post(url.pathname, await readJson(req, url.pathname === "/api/upload-logo" ? Math.ceil(MAX_LOGO_BYTES * 1.4) + 2_000 : 64_000), ip);
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
    if (url.pathname === "/launch") { send(res, 200, page(PAGE), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/theme.js") {
      send(res, 200, `const SITE_THEME = ${JSON.stringify(f!.theme ?? "receipt")};\n` + fs.readFileSync(path.join(ROOT, "src", "web", "theme.js"), "utf8"), "text/javascript; charset=utf-8");
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
    await refreshTrades(conn, new PublicKey(t.pool), t.mint, t.stateDir)
      .catch((e) => console.error(`Trade index for ${t.symbol} failed: ${e instanceof Error ? e.message : e}`));
  }
}
setTimeout(() => indexAllTrades(), 5_000);
setInterval(() => indexAllTrades(), 10 * 60_000).unref();

// Keep the Locked NFTs list warm so visitors never wait for its chain reads.
setTimeout(() => allNfts().catch(() => undefined), 2_000);
setInterval(() => allNfts().catch(() => undefined), 60_000).unref();
server.listen(port, bind, () => console.log(`Token factory (${cfg.network}): http://${bind}:${port}  (metadata URIs use ${publicUrl})`));
