/**
 * Every XDEX pool holding a token, and who holds each pool's liquidity, for the
 * leaderboard's liquidity stats.
 *
 * Pools are found on-chain (any pair, whoever created it). Each pool's other side is
 * valued in XNT through that token's deepest XNT pool. Its LP is split by who can take it
 * out: locked for good (this site's locker with no unlock date, or LP burned: the pool
 * records more LP issued than exists), time-locked (this site's timed locks, or another
 * locker whose lock accounts are known, below) or withdrawable (any other holder).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { listLocks } from "./locker.js";
import { poolAuthority } from "./xdex.js";

const POOL_SIZE = 637;
const MINT_OFFSETS = [8 + 5 * 32, 8 + 6 * 32] as const;
const key = (d: Buffer, i: number) => new PublicKey(d.subarray(8 + i * 32, 40 + i * 32));

/**
 * Other LP lockers on X1, by program: how to read a lock account's unlock time. The
 * 8N4E… locker has no published interface; its 186-byte lock accounts were read from
 * known locks: receipt NFT, pool, LP mint and owner (32 bytes each), then the LP amount,
 * another amount, and the lock and unlock times.
 */
const OTHER_LOCKERS: Record<string, { size: number; disc: string; unlockAt: (d: Buffer) => number }> = {
  "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf": { size: 186, disc: "08ff24cad2163989", unlockAt: (d) => Number(d.readBigInt64LE(176)) },
};

export interface LpShare {
  /** "forever": can never be withdrawn (this site's permanent lock, or burned); "timed": locked until `unlockAt`; "free": withdrawable now. */
  kind: "forever" | "timed" | "free";
  /** Who can withdraw it (or will, after `unlockAt`); null for burned LP. */
  holder: string | null;
  burned?: true;
  /** The locker program holding it, when locked. */
  locker: string | null;
  unlockAt: number | null;
  pct: number;
  valueXnt: number | null;
}
export interface PoolLiquidity {
  pool: string; quoteMint: string; quoteSymbol: string;
  /** Whole tokens and quote tokens in the pool (not counting fees owed to the protocol). */
  tokens: number; quote: number;
  /** XNT per whole quote token, the pool's whole value in XNT, and the token's price it implies. */
  quoteXnt: number | null; valueXnt: number | null; priceXnt: number | null;
  shares: LpShare[];
}

async function tokenAmounts(conn: Connection, accounts: PublicKey[]) {
  const infos = await conn.getMultipleAccountsInfo(accounts);
  return infos.map((i) => (i ? i.data.readBigUInt64LE(64) : 0n));
}

/** Pools of `mint` (on either side), with or without a fixed other side. */
async function poolsWith(conn: Connection, xdex: PublicKey, mint: PublicKey, other?: PublicKey) {
  const out: { address: PublicKey; data: Buffer; side: 0 | 1 }[] = [];
  for (const side of [0, 1] as const) {
    const filters = [{ dataSize: POOL_SIZE }, { memcmp: { offset: MINT_OFFSETS[side], bytes: mint.toBase58() } }];
    if (other) filters.push({ memcmp: { offset: MINT_OFFSETS[1 - side], bytes: other.toBase58() } });
    for (const { pubkey, account } of await conn.getProgramAccounts(xdex, { commitment: "confirmed", filters })) out.push({ address: pubkey, data: account.data, side });
  }
  return out;
}

/** A pool's reserves (vault balances less the protocol and fund fees it owes), token side first. */
async function reserves(conn: Connection, d: Buffer, side: 0 | 1) {
  const [v0, v1] = await tokenAmounts(conn, [key(d, 2), key(d, 3)]);
  const net = [v0 - d.readBigUInt64LE(341) - d.readBigUInt64LE(357), v1 - d.readBigUInt64LE(349) - d.readBigUInt64LE(365)];
  return side === 0 ? [net[0], net[1]] : [net[1], net[0]];
}

/** XNT per whole `mint`, from its deepest XNT pool (null without one). */
async function xntPrice(conn: Connection, xdex: PublicKey, mint: PublicKey, decimals: number) {
  if (mint.equals(NATIVE_MINT)) return 1;
  let best: { xnt: bigint; price: number } | null = null;
  for (const p of await poolsWith(conn, xdex, mint, NATIVE_MINT)) {
    const [tok, xnt] = await reserves(conn, p.data, p.side);
    if (tok > 0n && (!best || xnt > best.xnt)) best = { xnt, price: (Number(xnt) / 1e9) / (Number(tok) / 10 ** decimals) };
  }
  return best?.price ?? null;
}

/** A token's symbol from its Token-2022 metadata ("XNT" for wrapped XNT), else a short address. */
async function symbolOf(conn: Connection, mint: PublicKey) {
  if (mint.equals(NATIVE_MINT)) return "XNT";
  const info = await conn.getParsedAccountInfo(mint).catch(() => null);
  const meta = (info?.value?.data as any)?.parsed?.info?.extensions?.find((e: any) => e.extension === "tokenMetadata")?.state;
  return (meta?.symbol as string | undefined)?.trim() || `${mint.toBase58().slice(0, 4)}…`;
}

export async function tokenPools(conn: Connection, xdex: PublicKey, mint: PublicKey, locker: PublicKey, priceXnt: number | null): Promise<PoolLiquidity[]> {
  const now = Math.floor(Date.now() / 1000);
  const authority = poolAuthority(xdex).toBase58();
  const out: PoolLiquidity[] = [];
  for (const p of await poolsWith(conn, xdex, mint)) {
    const d = p.data;
    const quoteMint = key(d, p.side === 0 ? 6 : 5);
    const [mintInfo, quoteInfo, lpInfo] = await conn.getMultipleAccountsInfo([mint, quoteMint, key(d, 4)]);
    const dec = mintInfo!.data[44], quoteDec = quoteInfo!.data[44];
    const [tokRaw, quoteRaw] = await reserves(conn, d, p.side);
    const tokens = Number(tokRaw) / 10 ** dec, quote = Number(quoteRaw) / 10 ** quoteDec;
    const quoteXnt = await xntPrice(conn, xdex, quoteMint, quoteDec);
    const valueXnt = quoteXnt !== null && priceXnt !== null ? tokens * priceXnt + quote * quoteXnt : null;
    // LP: what the pool has issued, what still exists (the rest was burned), and who holds it.
    const issued = d.readBigUInt64LE(333), live = lpInfo!.data.readBigUInt64LE(36);
    const share = (lp: bigint) => (issued > 0n ? Number(lp) / Number(issued) : 0);
    const shares: LpShare[] = [];
    // A pool's first deposit leaves a tiny minimum burned; only real burns count.
    if (share(issued - live) >= 1e-4) shares.push({ kind: "forever", holder: null, burned: true, locker: null, unlockAt: null, pct: share(issued - live) * 100, valueXnt: valueXnt !== null ? share(issued - live) * valueXnt : null });
    const holders = await conn.getProgramAccounts(lpInfo!.owner, { commitment: "confirmed", filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: key(d, 4).toBase58() } }] });
    const lp = holders.map((h) => ({ owner: new PublicKey(h.account.data.subarray(32, 64)), amount: h.account.data.readBigUInt64LE(64) })).filter((h) => h.amount > 0n);
    const owners = lp.length ? await conn.getMultipleAccountsInfo(lp.map((h) => h.owner)) : [];
    const ours = owners.some((o) => o?.owner.equals(locker)) ? new Map((await listLocks(conn, locker, p.address)).map((l) => [l.address.toBase58(), l])) : new Map();
    lp.forEach((h, i) => {
      const prog = owners[i]?.owner.toBase58();
      const pct = share(h.amount) * 100, value = valueXnt !== null ? share(h.amount) * valueXnt : null;
      let kind: LpShare["kind"] = "free", unlockAt: number | null = null, lockerId: string | null = null, holder: string | null = h.owner.toBase58();
      const mine = ours.get(h.owner.toBase58()), other = prog ? OTHER_LOCKERS[prog] : undefined;
      if (mine) { lockerId = locker.toBase58(); unlockAt = mine.unlockAt; kind = unlockAt === null ? "forever" : "timed"; holder = null; }
      else if (other && owners[i]!.data.length === other.size && owners[i]!.data.subarray(0, 8).toString("hex") === other.disc) {
        lockerId = prog!; unlockAt = other.unlockAt(owners[i]!.data); kind = "timed";
        holder = new PublicKey(owners[i]!.data.subarray(104, 136)).toBase58();
      } else if (h.owner.toBase58() === authority) { kind = "forever"; holder = null; }
      if (kind === "timed" && unlockAt !== null && unlockAt <= now) kind = "free"; // past its unlock date
      shares.push({ kind, holder, locker: lockerId, unlockAt, pct, valueXnt: value });
    });
    shares.sort((a, b) => b.pct - a.pct);
    out.push({ pool: p.address.toBase58(), quoteMint: quoteMint.toBase58(), quoteSymbol: await symbolOf(conn, quoteMint),
      tokens, quote, quoteXnt, valueXnt, priceXnt: quoteXnt !== null && tokens > 0 ? (quote * quoteXnt) / tokens : null, shares });
  }
  return out.sort((a, b) => (b.valueXnt ?? 0) - (a.valueXnt ?? 0));
}
