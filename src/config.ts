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
  xdex: { programId: string; pool: string };
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
    faucet?: { keypair: string; amount: string; xntAmount?: string; cooldownHours?: number; dailyCap?: number };
    /** Testnet only: pay the launch fee in another token (e.g. XNM). Ignored on mainnet, which always charges USDC. */
    feeToken?: { mint: string; symbol: string; amount: string };
    gasXnt?: string;         // XNT the creator pre-funds each token's distributor with
    tipXnt?: string;         // XNT a holder pays to trigger "Distribute now" (default 0.005)
    publicUrl?: string;      // base URL the page is served from (used in metadata URIs)
    port?: number;
    bind?: string;           // listen address; 127.0.0.1 unless you put it behind a proxy
    hosts?: string[];        // extra Host headers to accept, e.g. ["launch.example.com"]
    theme?: "receipt" | "arcade" | "lunchbag" | "notebook"; // site look (default receipt); preview with ?theme=arcade
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

export function connection(cfg: Config) {
  return new Connection(process.env.REFLECT_RPC_URL ?? cfg.rpcUrl, "confirmed");
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
