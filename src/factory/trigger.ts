/**
 * "Distribute now": anyone can pay a small XNT tip to a token's distributor wallet and
 * have that token's distribution cycle run immediately. The tip becomes the
 * distributor's gas. The cycle is the same one the scheduled distributor runs, except
 * that the wallet that paid the tip earns the clicker reward: 1% of that run's holder
 * payout, capped at 0.05 XNT (distribution.clickerRewardBps / clickerRewardCapXnt).
 *
 * Works for the main token in config.json (RFLT) and every registered factory launch.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { CONFIG_PATH, Config, DEFAULT_MIN_HARVEST_XNT, FACTORY_DIR, ROOT, STATE_DIR, loadKeypair, toBaseUnits } from "../config.js";
import { BURN_OWNERS, eligibleBalances, scanTokenAccounts } from "../holders.js";
import { poolAuthority } from "../xdex.js";
import { snapshot } from "../xdex.js";
import { registeredLaunches } from "./launch.js";

export const COOLDOWN_MS = 10 * 60_000;
const TIP_MAX_AGE_S = 15 * 60;
const USED_TIPS = path.join(FACTORY_DIR, "used-tips.txt");

export interface Target {
  mint: string;
  symbol: string;
  name: string;
  pool: string;
  distributor: string;
  configPath: string;
  stateDir: string;
}

/** Every token a holder can trigger: the main token plus registered factory launches. */
export function targets(cfg: Config): Target[] {
  const out: Target[] = [];
  if (cfg.mint && cfg.xdex.pool) {
    out.push({
      mint: cfg.mint, symbol: cfg.token.symbol, name: cfg.token.name, pool: cfg.xdex.pool,
      distributor: loadKeypair(cfg.keypairs.distributor).publicKey.toBase58(), configPath: CONFIG_PATH, stateDir: STATE_DIR,
    });
  }
  for (const r of registeredLaunches()) {
    const dir = path.join(FACTORY_DIR, "launches", r.mint);
    out.push({ mint: r.mint, symbol: r.symbol, name: r.name, pool: r.pool, distributor: r.distributor, configPath: path.join(dir, "config.json"), stateDir: path.join(dir, "state") });
  }
  return out;
}

export function findTarget(cfg: Config, mint: string) {
  const t = targets(cfg).find((x) => x.mint === mint);
  if (!t) throw new Error("Unknown token");
  return t;
}

const lastRun = new Map<string, { at: number; ok?: boolean; summary?: string[] }>();
const running = new Set<string>();

/** True while a scheduled or triggered cycle holds this token's lock. */
function lockHeld(t: Target) {
  const lock = path.join(t.stateDir, "distributor.lock");
  if (!fs.existsSync(lock)) return false;
  try { process.kill(Number(fs.readFileSync(lock, "utf8")), 0); return true; } catch { return false; }
}

/** Tax waiting to be collected, its value in XNT, and whether a triggered run is allowed now. */
export async function readiness(conn: Connection, cfg: Config, t: Target) {
  const mint = new PublicKey(t.mint);
  const [rows, mintInfo] = await Promise.all([scanTokenAccounts(conn, mint), conn.getAccountInfo(mint, "confirmed")]);
  const m = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const waiting = rows.reduce((a, r) => a + r.withheld, 0n) + (getTransferFeeConfig(m)?.withheldAmount ?? 0n);
  const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(t.pool), mint);
  const worth = (waiting * snap.reserveXnt) / snap.reserveToken;
  // Same eligibility rules the distributor uses, from this token's own config.
  const dc = (JSON.parse(fs.readFileSync(t.configPath, "utf8")) as Config).distribution;
  const holders = eligibleBalances(rows, {
    excluded: new Set([...dc.excludeOwners, ...BURN_OWNERS, t.distributor, poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58()]),
    excludeOffCurve: dc.excludeOffCurveOwners, minHolding: toBaseUnits(dc.minHoldingTokens, m.decimals),
  }).size;
  // The token's own collection threshold (each launch has its own config).
  const min = toBaseUnits(dc.minHarvestXnt ?? DEFAULT_MIN_HARVEST_XNT, 9);
  const last = lastRun.get(t.mint);
  const cooldown = last ? Math.max(0, last.at + COOLDOWN_MS - Date.now()) : 0;
  let reason: string | null = null;
  if (running.has(t.mint) || lockHeld(t)) reason = "A distribution is running right now.";
  else if (cooldown > 0) reason = `Distributed recently; try again in ${Math.ceil(cooldown / 60_000)} min.`;
  else if (worth < min) reason = "Not enough tax waiting yet to be worth a run.";
  else if (holders === 0) reason = "No holders qualify for payouts yet.";
  return {
    mint: t.mint, symbol: t.symbol, name: t.name, decimals: m.decimals,
    waiting: waiting.toString(), worthLamports: worth.toString(), thresholdLamports: min.toString(), holders, ready: reason === null, reason,
    lastRun: last ? { at: new Date(last.at).toISOString(), ok: last.ok ?? null, summary: last.summary ?? [] } : null,
  };
}

/** The tip transaction's instruction: payer -> the token's distributor. */
export function tipInstruction(payer: PublicKey, t: Target, tipLamports: bigint) {
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(t.distributor), lamports: tipLamports });
}

/**
 * Check a confirmed, recent, unused tip of at least `tipLamports` to this token's
 * distributor. Returns the wallet that paid it (it earns the clicker reward).
 */
export async function verifyTip(conn: Connection, t: Target, signature: string, tipLamports: bigint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw new Error("Invalid signature");
  fs.mkdirSync(FACTORY_DIR, { recursive: true });
  const used = fs.existsSync(USED_TIPS) ? new Set(fs.readFileSync(USED_TIPS, "utf8").split("\n")) : new Set<string>();
  if (used.has(signature)) throw new Error("This tip was already used");
  const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) throw new Error("Tip transaction not found or failed");
  if (!tx.blockTime || Date.now() / 1000 - tx.blockTime > TIP_MAX_AGE_S) throw new Error("Tip is too old");
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const i = keys.keySegments().flat().findIndex((k) => k.toBase58() === t.distributor);
  if (i < 0) throw new Error("Tip wasn't sent to this token's distributor");
  const received = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
  if (received < tipLamports) throw new Error("Tip is smaller than required");
  fs.appendFileSync(USED_TIPS, signature + "\n", { mode: 0o600 });
  return keys.get(0)!.toBase58(); // fee payer = the wallet that approved the tip
}

/** Run one real cycle for `t` in the background; the result is kept for the status endpoint. */
export function runCycle(t: Target, clicker?: string) {
  if (running.has(t.mint)) throw new Error("A distribution is already running");
  running.add(t.mint);
  const entry: { at: number; ok?: boolean; summary?: string[] } = { at: Date.now(), summary: [] };
  lastRun.set(t.mint, entry);
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "distribute.ts"), "--execute",
    ...(clicker ? ["--clicker", new PublicKey(clicker).toBase58()] : [])], {
    cwd: ROOT, env: { ...process.env, REFLECT_CONFIG: t.configPath, REFLECT_STATE_DIR: t.stateDir },
  });
  const keep = (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      // Keep the human-readable milestones for the page.
      if (/^\[(withdraw|burn|sell|auto-lp|creator|clicker-reward|allocate|payout)\]|^(Payouts due|No holder|Tax waiting|Cycle failed)/.test(line)) {
        entry.summary!.push(line.replace(/\s+[1-9A-HJ-NP-Za-km-z]{80,90}$/, ""));
      }
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60_000);
  child.on("close", (code) => { clearTimeout(timer); entry.ok = code === 0; running.delete(t.mint); });
}
