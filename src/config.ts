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
  /** Token factory (public launchpad). */
  factory?: {
    feeReceiver: string;     // wallet that receives the launch fee
    feeUsdc: string;         // launch fee in USDC, e.g. "1"
    gasXnt?: string;         // XNT the creator pre-funds each token's distributor with
    publicUrl?: string;      // base URL the page is served from (used in metadata URIs)
    port?: number;
    bind?: string;           // listen address; 127.0.0.1 unless you put it behind a proxy
    hosts?: string[];        // extra Host headers to accept, e.g. ["launch.example.com"]
  };
  distribution: {
    minHoldingTokens: string;
    excludeOwners: string[];
    excludeOffCurveOwners: boolean;
    operatingReserveXnt: string;
    minGasXnt?: string;
    minPayoutXnt: string;
    minCycleXnt: string;
    maxSellTokensPerCycle: string;
    maxPriceImpactBps: number;
    slippageBps: number;
    autoLpBps?: number;
    burnBps?: number;
    transfersPerTx: number;
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
  if (lp + burn > 10_000) throw new Error("distribution.autoLpBps + burnBps can't exceed 10000 (100% of the tax)");
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
