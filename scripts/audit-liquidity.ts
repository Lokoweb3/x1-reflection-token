/**
 * Who can take a token's pool liquidity out: every XDEX pool holding the mint, every holder of each pool's LP tokens,
 * and for each holder whether its LP is locked forever (lp_locker `lock`), locked until a date (`lock_timed`), or free
 * to withdraw (a wallet or another program). Evidence and a report go to <out>/<date>/.
 *
 *   npx tsx scripts/audit-liquidity.ts [--mint <mint>] [--rpc <url>] [--out audits/liquidity]
 *
 * How the pieces fit: XDEX (a Raydium CP-Swap fork) pays a withdrawal its share of the pool's own `lp_supply`, which
 * a plain token burn doesn't reduce. So LP the tax vault burns (and the 100 LP XDEX keeps at creation) is counted by
 * the pool but held by nobody: that liquidity can never leave. Shares below are of the pool's `lp_supply`.
 * lp_locker keeps a lock's principal (in sqrt(k) units) forever; its NFT holder can
 * withdraw the LP that trading fees added on top (`collect_fees`), and the holder of a timed lock gets everything
 * back once `unlock_at` passes. Programs that can be upgraded can change all of this: their upgrade authorities are
 * listed, not judged.
 */
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const RPC = arg("rpc", "https://rpc.mainnet.x1.xyz")!;
const MINT = arg("mint", "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz")!; // TEST
const OUT = arg("out", path.join(import.meta.dirname, "..", "audits", "liquidity"))!;
const XDEX = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
const LOCKER = "5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C";
const TAX_VAULT = "D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const BURN_OWNERS = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);
// Another X1 locker (no published interface): 186-byte lock accounts, owner at 104, LP amount at 136, unlock time at 176 (src/pools.ts).
const LOCKER_8N4E = "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf";
const KNOWN: Record<string, string> = { So11111111111111111111111111111111111111112: "XNT", B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq: "USDC.X", E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5: "GOOGL.X", [MINT]: "TEST" };

async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
      return r.result;
    } catch (e) { if (i >= 6) throw e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
}
const pda = (seeds: Buffer[], program: string) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
const pk = (s: string) => new PublicKey(s).toBuffer();
const et = (unix: number) => new Date(unix * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";
async function symbol(mint: string) { // Token-2022 TokenMetadata extension (type 19), else a short address
  if (KNOWN[mint]) return KNOWN[mint];
  const d = Buffer.from((await rpc("getAccountInfo", [mint, { encoding: "base64" }])).value.data[0], "base64");
  for (let o = 166; o + 4 <= d.length;) {
    const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2);
    if (type === 19) { const n = d.readUInt32LE(o + 68); const sl = d.readUInt32LE(o + 72 + n); return (KNOWN[mint] = d.subarray(o + 76 + n, o + 76 + n + sl).toString()); }
    if (!type && !len) break; o += 4 + len;
  }
  return (KNOWN[mint] = mint.slice(0, 4) + "…");
}
const decimalsCache = new Map<string, number>();
async function decimals(mint: string) {
  if (!decimalsCache.has(mint)) { const a = await rpc("getAccountInfo", [mint, { encoding: "base64" }]); decimalsCache.set(mint, Buffer.from(a.value.data[0], "base64")[44]); }
  return decimalsCache.get(mint)!;
}
const ui = (x: bigint, dec: number) => Number(x) / 10 ** dec;
const num = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: x < 10 ? 4 : 0 });

const slot: number = await rpc("getSlot", [{ commitment: "confirmed" }]);
const now = Math.floor(Date.now() / 1000);
const xdexAuthority = pda([Buffer.from("vault_and_lp_mint_auth_seed")], XDEX);
const vaultAuth = pda([Buffer.from("auth"), pk(MINT)], TAX_VAULT);
console.log(`Liquidity for ${MINT} at slot ${slot}`);

// ---- programs and their upgrade authorities ----
const programs: any[] = [];
for (const [name, id] of [["XDEX", XDEX], ["lp_locker", LOCKER], ["tax_vault", TAX_VAULT]]) {
  const a = await rpc("getAccountInfo", [id, { encoding: "base64" }]);
  let authority: string | null = null;
  if (a.value.owner === UPGRADEABLE_LOADER) {
    const pd = bs58.encode(Buffer.from(a.value.data[0], "base64").subarray(4, 36));
    const p = Buffer.from((await rpc("getAccountInfo", [pd, { encoding: "base64", dataSlice: { offset: 0, length: 45 } }])).value.data[0], "base64");
    authority = p[12] ? bs58.encode(p.subarray(13, 45)) : null;
  }
  programs.push({ name, id, upgradeable: !!authority, authority });
  console.log(`  ${name.padEnd(10)} ${id}: ${authority ? `upgradeable by ${authority}` : "immutable"}`);
}

// ---- pools ----
const poolAccs: any[] = [];
for (const offset of [168, 200]) // token_0_mint, token_1_mint
  poolAccs.push(...await rpc<any[]>("getProgramAccounts", [XDEX, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 637 }, { memcmp: { offset, bytes: MINT } }] }]));
const report: any[] = [];
for (const p of poolAccs) {
  const d = Buffer.from(p.account.data[0], "base64");
  const key = (i: number) => bs58.encode(d.subarray(8 + i * 32, 40 + i * 32));
  const pool = { address: p.pubkey, vaults: [key(2), key(3)], lpMint: key(4), mints: [key(5), key(6)], lpSupply: d.readBigUInt64LE(333), lpDecimals: d[330],
    fees: [d.readBigUInt64LE(341) + d.readBigUInt64LE(357), d.readBigUInt64LE(349) + d.readBigUInt64LE(365)] };
  const vaults = await rpc<any>("getMultipleAccounts", [pool.vaults, { encoding: "base64", dataSlice: { offset: 64, length: 8 } }]);
  const reserves = vaults.value.map((v: any, i: number) => Buffer.from(v.data[0], "base64").readBigUInt64LE(0) - pool.fees[i]);
  const side = pool.mints[0] === MINT ? 0 : 1, other = pool.mints[1 - side];
  const lpMintInfo = Buffer.from((await rpc("getAccountInfo", [pool.lpMint, { encoding: "base64" }])).value.data[0], "base64");
  const mintSupply = lpMintInfo.readBigUInt64LE(36);
  const mintAuthority = lpMintInfo.readUInt32LE(0) ? bs58.encode(lpMintInfo.subarray(4, 36)) : null;

  // every LP token account, classified by who controls it
  const lpAccs = await rpc<any[]>("getProgramAccounts", [TOKEN, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: pool.lpMint } }] }]);
  const holders: any[] = [];
  for (const a of lpAccs) {
    const x = Buffer.from(a.account.data[0], "base64");
    const owner = bs58.encode(x.subarray(32, 64)), amount = x.readBigUInt64LE(64);
    if (!amount) continue;
    const ownerInfo = (await rpc("getAccountInfo", [owner, { encoding: "base64" }])).value;
    let kind = "wallet (free to withdraw)", detail: any = {};
    if (BURN_OWNERS.has(owner)) kind = "burn address";
    else if (owner === vaultAuth) kind = "tax vault auth (burns what it adds)";
    else if (ownerInfo?.owner === LOCKER) {
      const l = Buffer.from(ownerInfo.data[0], "base64");
      const nftMint = bs58.encode(l.subarray(8, 40));
      const lock = { nftMint, pool: bs58.encode(l.subarray(40, 72)), lpMint: bs58.encode(l.subarray(72, 104)), locker: bs58.encode(l.subarray(104, 136)),
        lockedLp: l.readBigUInt64LE(136), feeLpCollected: l.readBigUInt64LE(160), lockedAt: Number(l.readBigInt64LE(168)) };
      const vaultOk = a.pubkey === pda([Buffer.from("vault"), pk(owner)], LOCKER) && owner === pda([Buffer.from("lock"), pk(nftMint)], LOCKER) && lock.lpMint === pool.lpMint;
      const sched = (await rpc("getAccountInfo", [pda([Buffer.from("schedule"), pk(owner)], LOCKER), { encoding: "base64" }])).value;
      const unlockAt = sched ? Number(Buffer.from(sched.data[0], "base64").readBigInt64LE(40)) : null;
      const nftHolder = (await rpc<any>("getTokenLargestAccounts", [nftMint])).value.find((h: any) => h.amount === "1")?.address;
      const nftOwner = nftHolder ? bs58.encode(Buffer.from((await rpc("getAccountInfo", [nftHolder, { encoding: "base64" }])).value.data[0], "base64").subarray(32, 64)) : null;
      kind = !vaultOk ? "lp_locker account that doesn't check out" : unlockAt === null ? "locked forever (lp_locker)" : unlockAt > now ? "timed lock (lp_locker)" : "timed lock, expired: withdrawable";
      detail = { lock: owner, ...lock, unlockAt, nftOwner };
    } else if (ownerInfo?.owner === LOCKER_8N4E && Buffer.from(ownerInfo.data[0], "base64").length === 186) {
      const l = Buffer.from(ownerInfo.data[0], "base64");
      const unlockAt = Number(l.readBigInt64LE(176));
      kind = unlockAt > now ? "timed lock (8N4E locker)" : "timed lock, expired: withdrawable";
      detail = { lock: owner, locker8n4e: true, lockOwner: bs58.encode(l.subarray(104, 136)), lockedLp: l.readBigUInt64LE(136), unlockAt };
    } else if (ownerInfo && ownerInfo.owner !== "11111111111111111111111111111111") kind = `program account (${ownerInfo.owner})`;
    else if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes())) kind = "off-curve, no account (a program's PDA)";
    holders.push({ tokenAccount: a.pubkey, owner, amount, kind, ...detail });
  }
  holders.sort((a, b) => (b.amount > a.amount ? 1 : -1));
  const held = holders.reduce((s, h) => s + h.amount, 0n);
  const [decT, decO] = [await decimals(MINT), await decimals(other)];
  const issued = pool.lpSupply || 1n; // what XDEX divides a withdrawal by
  const share = (amt: bigint) => ({ pct: Number((amt * 1_000_000n) / issued) / 10_000, test: ui((reserves[side] * amt) / issued, decT), other: ui((reserves[1 - side] * amt) / issued, decO) });
  const byKind = new Map<string, bigint>(); for (const h of holders) byKind.set(h.kind, (byKind.get(h.kind) ?? 0n) + h.amount);
  if (held !== mintSupply) throw new Error(`${pool.address}: token accounts hold ${held} LP but the mint says ${mintSupply}`);
  const burned = pool.lpSupply - mintSupply; // counted by the pool, held by nobody: 100 at creation plus every LP burn
  if (burned > 0n) byKind.set("burned (the pool still counts it; nobody can withdraw it)", burned);
  const name = `TEST/${await symbol(other)}`;
  console.log(`\n${name} ${pool.address}: ${num(ui(reserves[side], decT))} TEST + ${num(ui(reserves[1 - side], decO))} ${await symbol(other)}, LP supply ${mintSupply} (pool says ${pool.lpSupply}), mint authority ${mintAuthority === xdexAuthority ? "XDEX" : mintAuthority}`);
  for (const [k, amt] of [...byKind].sort((a, b) => (b[1] > a[1] ? 1 : -1))) { const s = share(amt); console.log(`  ${s.pct.toFixed(2).padStart(6)}%  ${k}  (${num(s.test)} TEST + ${num(s.other)} ${await symbol(other)})`); }
  for (const h of holders) if (h.lock) console.log(`          lock ${h.lock.slice(0, 6)}… ${share(h.amount).pct.toFixed(2)}%: ${h.locker8n4e ? `8N4E lock of ${h.lockOwner.slice(0, 6)}…` : `locked ${et(h.lockedAt)} by ${h.locker.slice(0, 6)}…`}, ${h.unlockAt ? `unlocks ${et(h.unlockAt)}` : "no unlock"}${h.nftOwner ? `, fee NFT held by ${h.nftOwner.slice(0, 6)}…` : ""}`);
  for (const h of holders.filter((h) => h.kind.startsWith("wallet") || h.kind.includes("expired"))) console.log(`          free: ${h.owner} ${share(h.amount).pct.toFixed(2)}%`);
  report.push({ name, pool, reserves, other, mintSupply, mintAuthority, mintAuthorityIsXdex: mintAuthority === xdexAuthority, holders, byKind: Object.fromEntries(byKind),
    foreverPct: share([...byKind].filter(([k]) => k.startsWith("locked forever") || k.startsWith("burned") || k === "burn address").reduce((s, [, a]) => s + a, 0n)).pct,
    timedPct: share([...byKind].filter(([k]) => k.startsWith("timed lock (")).reduce((s, [, a]) => s + a, 0n)).pct,
    freePct: share([...byKind].filter(([k]) => k.startsWith("wallet") || k.includes("expired")).reduce((s, [, a]) => s + a, 0n)).pct });
}

// ---- evidence ----
const dir = path.join(OUT, new Date().toISOString().slice(0, 10));
fs.mkdirSync(dir, { recursive: true });
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);
fs.writeFileSync(path.join(dir, "liquidity.json"), j({ slot, rpc: RPC, mint: MINT, programs, pools: report }));
const md = [
  `# Liquidity audit: ${MINT} at slot ${slot}`, "",
  `Run ${et(now)} with \`npx tsx scripts/audit-liquidity.ts\` against ${RPC}. Shares are of each pool's LP supply now; amounts are what that share of the reserves would withdraw.`, "",
  "| Pool | Reserves | Locked forever | Timed lock | Free to withdraw |", "|---|---|---|---|---|",
  ...report.map((r) => `| ${r.name} \`${r.pool.address.slice(0, 6)}…\` | ${num(ui(r.reserves[r.pool.mints[0] === MINT ? 0 : 1], 9))} TEST | ${r.foreverPct.toFixed(2)}% | ${r.timedPct.toFixed(2)}% | ${r.freePct.toFixed(2)}% |`),
  "", "## Holders", "",
  ...report.flatMap((r) => [`### ${r.name} \`${r.pool.address}\``, "", ...r.holders.map((h: any) => `- \`${h.owner}\` ${h.amount} LP: ${h.kind}${h.lock ? ` (lock \`${h.lock}\`, ${h.unlockAt ? `unlocks ${et(h.unlockAt)}` : "permanent"}, fee NFT holder \`${h.nftOwner}\`)` : ""}`), ""]),
  "## Programs", "", ...programs.map((p) => `- ${p.name} \`${p.id}\`: ${p.upgradeable ? `upgradeable by \`${p.authority}\`` : "immutable"}`),
  "", "## What this does and doesn't show", "",
  "- Burned LP stays in the pool for good because XDEX divides withdrawals by the pool's own lp_supply, which a token burn doesn't lower (Raydium CP-Swap behaviour; the 100 LP gap in every untouched pool is CP-Swap's creation lock). If XDEX's program changed that rule, burned LP would instead enrich the remaining holders.",
  "- A permanent lp_locker lock keeps its principal liquidity; the fee NFT's holder can withdraw the LP that fees added since locking.",
  "- An upgradeable program can change these rules; upgrade control is a separate check.",
  "- It trusts the RPC it reads; rerun with `--rpc` against another provider to cross-check.",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "README.md"), md);
console.log(`\nevidence in ${path.relative(process.cwd(), dir)}/`);
