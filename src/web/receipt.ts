/**
 * The lock NFT's artwork: a "99 + TAX" receipt filled in with that launch's details and
 * the time it was locked. Built from on-chain data (the lock, its schedule, the pool and
 * the token) plus the factory's launch record when there is one. The whole thing (JSON and
 * SVG image) is stored in the NFT's on-chain metadata `uri` as a data: URI.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { Config, fromBaseUnits } from "../config.js";
import { listLocks, lockPda, lockedLp } from "../locker.js";
import { decodePool } from "../xdex.js";
import { launchFee, listLaunches } from "../factory/launch.js";

export interface ReceiptData {
  nftMint: string;
  lock: string;
  tokenName: string;
  symbol: string;
  tokenMint: string;
  pool: string;
  supply: string;
  taxPct: number;
  split: { holders: number; liquidity: number; burn: number; creator: number } | null;
  poolTokens: string | null;
  poolXnt: string | null;
  lockedLp: string;
  lpSharePct: number;
  term: string;           // "FOREVER" or "UNTIL 2026-09-30 04:30 UTC"
  unlockAt: number | null; // unix seconds; null = locked forever
  launchFee: string | null;       // "1 USDC"
  lockedAt: string;       // "2026-09-23 04:06:06 UTC"
  network: string;
}

const fmtTime = (unix: number) => new Date(unix * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
const group = (v: string) => { const [i, f] = v.split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f.slice(0, 4) : ""); };
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export async function receiptData(conn: Connection, cfg: Config, nftMint: PublicKey): Promise<ReceiptData | null> {
  if (!cfg.locker?.programId) return null;
  const programId = new PublicKey(cfg.locker.programId);
  const lockAddr = lockPda(programId, nftMint);
  const info = await conn.getAccountInfo(lockAddr, "confirmed");
  if (!info) return null;
  // Decode through listLocks so the unlock schedule is included.
  const poolKey = new PublicKey(info.data.subarray(8 + 32, 8 + 64));
  const lock = (await listLocks(conn, programId, poolKey)).find((l) => l.address.equals(lockAddr));
  if (!lock) return null;

  const pool = decodePool(poolKey, await conn.getAccountInfo(poolKey, "confirmed"), new PublicKey(cfg.xdex.programId));
  const tokenMint = pool.mints.find((m) => !m.equals(new PublicKey("So11111111111111111111111111111111111111112")))!;
  const mintState = unpackMint(tokenMint, await conn.getAccountInfo(tokenMint, "confirmed"), TOKEN_2022_PROGRAM_ID);
  const meta = await getTokenMetadata(conn, tokenMint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null);
  const fee = getTransferFeeConfig(mintState);
  const lp = await lockedLp(conn, programId, lockAddr);

  const launch = listLaunches().find((r) => r.lockNft === nftMint.toBase58() || (r.pool === poolKey.toBase58() && r.creator === lock.locker.toBase58()));
  let split: ReceiptData["split"] = null;
  if (launch) {
    const creator = 10, liquidity = launch.autoLpBps / 100, burn = (launch.burnBps ?? 0) / 100;
    split = { holders: 100 - creator - liquidity - burn, liquidity, burn, creator };
  } else if (cfg.mint === tokenMint.toBase58()) {
    const d = cfg.distribution;
    const liquidity = (d.autoLpBps ?? 0) / 100, burn = (d.burnBps ?? 0) / 100, creator = (d.creatorBps ?? 0) / 100;
    split = { holders: 100 - liquidity - burn - creator, liquidity, burn, creator };
  }
  return {
    nftMint: nftMint.toBase58(), lock: lockAddr.toBase58(),
    tokenName: meta?.name ?? launch?.name ?? "Token", symbol: meta?.symbol ?? launch?.symbol ?? "?",
    tokenMint: tokenMint.toBase58(), pool: poolKey.toBase58(), supply: group(fromBaseUnits(mintState.supply, mintState.decimals)),
    taxPct: fee ? fee.newerTransferFee.transferFeeBasisPoints / 100 : 0, split,
    poolTokens: launch ? group(launch.poolTokens) : null, poolXnt: launch ? group(launch.poolXnt) : null,
    lockedLp: group(fromBaseUnits(lp, pool.lpDecimals)),
    lpSharePct: pool.lpSupply > 0n ? Number((lp * 1_000_000n) / pool.lpSupply) / 10_000 : 0,
    unlockAt: lock.unlockAt,
    term: lock.unlockAt === null ? "FOREVER" : `UNTIL ${fmtTime(lock.unlockAt).replace(/:\d\d UTC$/, " UTC")}`,
    launchFee: launch && cfg.factory ? `${launchFee(cfg).amount} ${launchFee(cfg).symbol}` : null,
    lockedAt: fmtTime(lock.lockedAt), network: cfg.network,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "", "'": "" }[c]!));
/** Creator-chosen text (the symbol) can't carry "%" or "#" into the data: URI. */
const clean = (s: string) => s.replace(/[%#]/g, "");

/** "LABEL.......value" padded with dot leaders to the receipt's width. */
const W = 27;
const row = (label: string, value: string) => {
  const v = value.slice(0, W - label.length - 1);
  return label + ".".repeat(Math.max(1, W - label.length - v.length)) + v;
};

/** "97.4679" as is; drop trailing zeros, and the decimals only if the number is too long. */
const fitLp = (v: string, room: number) => {
  const trimmed = v.includes(".") ? v.replace(/\.?0+$/, "") : v;
  return trimmed.length <= room ? trimmed : trimmed.replace(/\.\d+$/, "");
};

/**
 * The receipt as a compact SVG (~750 bytes) so it fits inside the NFT's on-chain
 * metadata, which one transaction can write only about 1000 bytes of. Named colours keep
 * "#" out; the only "%" signs are ours (clean strips them from the symbol), and
 * receiptUri escapes those.
 */
export function receiptSvg(d: ReceiptData) {
  const lines = [
    row("TOKEN", clean(d.symbol)),
    row("TAX", `${d.taxPct}%`),
    ...(d.split ? [row("H/LP/BURN/DEV", `${d.split.holders}/${d.split.liquidity}/${d.split.burn}/${d.split.creator}`)] : []),
    row("LP LOCKED", fitLp(d.lockedLp, W - "LP LOCKED".length - 1)),
    row("POOL SHARE", `${d.lpSharePct.toFixed(2)}%`),
    d.term === "FOREVER" ? row("LOCK", "FOREVER") : row("UNLOCKS", d.term.replace(/^UNTIL | UTC$/g, "")),
    row("LOCKED", d.lockedAt.replace(/ UTC$/, "")),
  ];
  const end = 150 + lines.length * 28;
  return `<svg xmlns='http://www.w3.org/2000/svg' width='340' viewBox='0 0 340 ${end + 60}' font-family='monospace' font-size='16'>`
    + `<rect x='5' y='5' width='330' height='${end + 50}' fill='ivory' stroke='deeppink' stroke-width='6'/>`
    + `<g text-anchor='middle' font-size='13'><text x='170' y='60' font-size='38' fill='deeppink'>99 + TAX</text>`
    + `<text x='170' y='88'>LP LOCK RECEIPT UTC</text>`
    + `<text x='170' y='${end + 26}'>* THANK YOU *</text></g>`
    + `<path d='M24 108H316M24 ${end - 10}H316' stroke='black' stroke-dasharray='6'/>`
    + `<g transform='translate(24)'>${lines.map((l, i) => `<text y='${140 + i * 28}'>${esc(l)}</text>`).join("")}</g></svg>`;
}

const pct = (s: string) => s.replace(/%/g, "%25");

/**
 * The NFT's full metadata JSON as a data: URI, image included; nothing hosted. Each "%"
 * is escaped once for the image URI and again for the outer JSON URI (so "%" -> "%2525").
 */
export function receiptUri(d: ReceiptData) {
  const json = JSON.stringify({
    name: `${d.symbol} LP Lock`.slice(0, 32),
    image: `data:image/svg+xml,${pct(receiptSvg(d))}`,
  });
  return `${RECEIPT_PREFIX}${pct(json)}`;
}
export const RECEIPT_PREFIX = "data:application/json,";
