import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const CONFIG_PATH = process.env.REFLECT_CONFIG ?? path.join(ROOT, "config.json");
export const STATE_DIR = process.env.REFLECT_STATE_DIR ?? path.join(ROOT, "state");
/** Factory launches: records, per-token distributor keys and state. Secret; gitignored. */
export const FACTORY_DIR = process.env.REFLECT_FACTORY_DIR ?? path.join(ROOT, "factory");

export const XDEX_PROGRAM_IDS: Record<string, string> = {
  mainnet: "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN",
  testnet: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf",
};

export interface Config {
  network: "mainnet" | "testnet";
  rpcUrl: string;
  keypairs: { creator: string; distributor: string };
  token: {
    name: string; symbol: string; uri: string; decimals: number;
    supply: string; feeBps: number; launchGrace: boolean;
  };
  mint: string;
  /** Per-launch config only: the tax is held by the Tax Vault program (the hot-wallet distributor skips it). */
  taxVault?: boolean;
  /**
   * The token's XDEX pool. A token paired with another token than XNT (a factory launch
   * paired with JACK) also names that pair token (`quoteMint`, `quoteSymbol`) and its deep
   * XNT pool (`quoteXntPool`): the distributor sells tax for the pair token and swaps it
   * to XNT there. Without `quoteMint` the pool is TOKEN/XNT.
   */
  xdex: { programId: string; pool: string; quoteMint?: string; quoteSymbol?: string; quoteXntPool?: string };
  /** lp_locker program (LP locked forever behind a fee-claiming NFT). */
  locker?: { programId: string; nftUri?: string };
  /**
   * Where the creator reward goes: the lp_locker vault of this lock NFT. rewardMint
   * defaults to wrapped XNT; for USDC set rewardMint and swapPool (a XNT/USDC XDEX pool).
   */
  creatorReward?: { nftMint: string; rewardMint?: string; swapPool?: string };
  /** Token factory (public launchpad). */
  factory?: {
    feeReceiver: string;     // wallet that receives the launch fee
    feeUsdc: string;         // launch fee in USDC, e.g. "1" (used unless feeToken is set)
    /**
     * Testnet only: a faucet that gives out the fee token so anyone can try a launch.
     * `keypair` is a dedicated wallet you fund with the fee token and a little XNT.
     */
    /** Pinata API key (JWT): logo uploads and token metadata go to IPFS. Or set PINATA_JWT. */
    pinataJwt?: string;
    /** Gateway for IPFS links wallets fetch (default https://gateway.pinata.cloud/ipfs/; or IPFS_GATEWAY). */
    ipfsGateway?: string;
    /** Pinata's upload API (default https://uploads.pinata.cloud/v3/files; or PINATA_API_URL), e.g. a local stand-in. */
    pinataApiUrl?: string;
    faucet?: { keypair: string; amount: string; xntAmount?: string; cooldownHours?: number; dailyCap?: number };
    /** Cloudflare Turnstile keys; when set, faucet claims need the captcha. Keep `secret` out of git. */
    turnstile?: { siteKey: string; secret: string };
    /** Testnet only: pay the launch fee in another token (e.g. XNM). Ignored on mainnet, which always charges USDC. */
    feeToken?: { mint: string; symbol: string; amount: string };
    gasXnt?: string;         // XNT the creator pre-funds each token's distributor with
    tipXnt?: string;         // XNT a holder pays to trigger "Distribute now" (default 0.005)
    publicUrl?: string;      // base URL the page is served from (used in metadata URIs)
    port?: number;
    bind?: string;           // listen address; 127.0.0.1 unless you put it behind a proxy
    hosts?: string[];        // extra Host headers to accept, e.g. ["launch.example.com"]
    /** The same site on the other network, for the header's Mainnet / Testnet toggle. */
    otherNetwork?: { network: "mainnet" | "testnet"; url: string };
    /** Only allow forever LP locks (no timed locks) for new launches. */
    lockForeverOnly?: boolean;
    /** Pause new launches (step 1 and curve creation); unfinished launches can still be completed. */
    launchesPaused?: { message?: string };
    theme?: "receipt" | "arcade" | "lunchbag" | "notebook"; // site look (default receipt); preview with ?theme=arcade
    /**
     * Bonding-curve launches (docs/bonding-curve-spec.md). Without it the Curve pages and
     * routes are off. `crankKeypair`: a wallet that graduates finished curves and delivers
     * buyers' tokens (pays the fees, earns the graduation reward); no crank without it.
     */
    curve?: { programId: string; crankKeypair?: string };
    /**
     * Tax Vault (docs/tax-vault-spec.md), testnet first. Without it nothing changes. With
     * `programId` the site shows vault state; with `publisherKeypair` too, the server runs
     * the vault crank (it pays the fees, publishes rewards lists, earns the crank reward)
     * and new XNT-paired testnet launches hand their tax to the vault instead of a hot wallet.
     * v3: each rewards list file is pinned to IPFS (factory.pinataJwt) before it's published;
     * without a Pinata key no new lists are published (payouts of published lists go on).
     */
    /**
     * allowListRebuild: publish a new list even when the active list's file can't be read
     * (local copy and IPFS both gone). Each wallet then restarts from what it was paid on-chain
     * and amounts allocated but not yet paid are re-split over current holders. Off by default.
     */
    taxVault?: { programId: string; publisherKeypair?: string; allowListRebuild?: boolean };
    /**
     * Tokens a launch may pair with instead of XNT (XNT is always offered and the default).
     * `xntPool` is that token's deep XNT pool on XDEX: the distributor swaps it to XNT there
     * for gas, holder payouts and the creator reward, and the site prices it in XNT. Only
     * tokens without a transfer fee work as a pair.
     */
    quoteTokens?: { mint: string; symbol: string; xntPool: string }[];
  };
  distribution: {
    minHoldingTokens: string;
    excludeOwners: string[];
    excludeOffCurveOwners: boolean;
    operatingReserveXnt: string;
    minGasXnt?: string;
    minPayoutXnt: string;
    minCycleXnt: string;
    /**
     * Skip collecting the tax until it is worth at least this much XNT. X1 charges roughly
     * 0.01–0.015 XNT in network fees for one full cycle (collect, burn, sell, liquidity,
     * creator reward, payout), so collecting less than this would mostly feed fees.
     */
    minHarvestXnt?: string;
    /** Don't sell a batch of collected tax worth less than this (dust). */
    minSellXnt?: string;
    maxSellTokensPerCycle: string;
    maxPriceImpactBps: number;
    slippageBps: number;
    autoLpBps?: number;
    burnBps?: number;
    /** Share of the tax paid to the token's creator (vests 7 days, claimed with the lock NFT). */
    creatorBps?: number;
    /** "Distribute now" clicker reward: share of that run's holder pot (default 100 = 1%)... */
    clickerRewardBps?: number;
    /** ...capped at this much XNT (default 0.05). */
    clickerRewardCapXnt?: string;
    transfersPerTx: number;
    /**
     * How holders get paid. "push" (default): the distributor sends XNT to every holder.
     * "claims": holders mint a Holder Pass; each cycle one Merkle root is posted and pass
     * holders claim their rewards (gas stays flat however many holders there are).
     */
    holderRewards?: "push" | "claims";
    priorityMicroLamports: number;
  };
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  if (!(cfg.network in XDEX_PROGRAM_IDS)) throw new Error(`network must be "mainnet" or "testnet"`);
  if (cfg.xdex.programId !== XDEX_PROGRAM_IDS[cfg.network]) {
    throw new Error(`xdex.programId does not match the known XDEX program for ${cfg.network}: ${XDEX_PROGRAM_IDS[cfg.network]}`);
  }
  const bps = cfg.token.feeBps;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("token.feeBps must be 0..10000");
  const lp = cfg.distribution.autoLpBps ?? 0;
  if (!Number.isInteger(lp) || lp < 0 || lp > 10_000) throw new Error("distribution.autoLpBps must be 0..10000");
  const burn = cfg.distribution.burnBps ?? 0;
  if (!Number.isInteger(burn) || burn < 0 || burn > 10_000) throw new Error("distribution.burnBps must be 0..10000");
  const creator = cfg.distribution.creatorBps ?? 0;
  if (!Number.isInteger(creator) || creator < 0 || creator > 10_000) throw new Error("distribution.creatorBps must be 0..10000");
  if (lp + burn + creator > 10_000) throw new Error("distribution.autoLpBps + burnBps + creatorBps can't exceed 10000 (100% of the tax)");
  if (creator > 0 && !cfg.creatorReward?.nftMint) throw new Error("creatorBps needs creatorReward.nftMint (the lock NFT that claims it)");
  if (cfg.xdex.quoteMint && !cfg.xdex.quoteXntPool) throw new Error("xdex.quoteMint needs xdex.quoteXntPool (its XNT pool, where it is swapped to XNT)");
  for (const q of cfg.factory?.quoteTokens ?? []) {
    if (!q.mint || !q.symbol || !q.xntPool || q.symbol.toUpperCase() === "XNT") throw new Error("factory.quoteTokens entries need mint, symbol (not XNT) and xntPool");
  }
  return cfg;
}

/** Update a single top-level string field in config.json without disturbing the rest. */
export function saveConfigField(key: "mint", value: string) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  raw[key] = value;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + "\n");
}

export function loadKeypair(file: string): Keypair {
  const resolved = file.startsWith("~") ? path.join(os.homedir(), file.slice(1)) : path.resolve(ROOT, file);
  const secret = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/**
 * RPC connection that is gentle with rate-limited public endpoints: requests from this
 * process are spaced out (REFLECT_RPC_GAP_MS, default 150 ms), and a "429 Too Many
 * Requests" waits (the server's Retry-After, or 1.5 s doubling) and retries for up to
 * about 45 s instead of failing a payout cycle halfway.
 */
export function connection(cfg: Config) {
  return new Connection(process.env.REFLECT_RPC_URL ?? cfg.rpcUrl, { commitment: "confirmed", fetch: patientFetch, disableRetryOnRateLimit: true });
}
const RPC_GAP_MS = Number(process.env.REFLECT_RPC_GAP_MS ?? 150);
let nextSlot = 0;
async function patientFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    const now = Date.now(), at = Math.max(now, nextSlot);
    nextSlot = at + RPC_GAP_MS;
    if (at > now) await sleep(at - now);
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 5) return res;
    const hint = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(hint) && hint > 0 ? Math.min(hint * 1000, 30_000) : 1500 * 2 ** attempt;
    nextSlot = Math.max(nextSlot, Date.now() + wait); // everyone in this process backs off together
    await sleep(wait);
  }
}

export function requireMint(cfg: Config): PublicKey {
  if (!cfg.mint) throw new Error("config.mint is empty; run `npm run create-token` first.");
  return new PublicKey(cfg.mint);
}

/** Parse a decimal string ("1.5") into base units without floating point. */
export function toBaseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid amount: ${value}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) throw new Error(`Too many decimals in ${value}`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n; const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${v / base}${frac ? "." + frac : ""}`;
}

export const XNT_DECIMALS = 9;
export const xnt = (lamports: bigint) => `${fromBaseUnits(lamports, XNT_DECIMALS)} XNT`;

/** Default tax-collection threshold (see distribution.minHarvestXnt). */
export const DEFAULT_MIN_HARVEST_XNT = "0.05";
/** Default smallest sale (see distribution.minSellXnt). */
export const DEFAULT_MIN_SELL_XNT = "0.002";
