/**
 * Mainnet dress rehearsal against a LOCAL validator that clones mainnet XDEX, USDC.X and
 * the XNT/USDC.X pool, and runs the mainnet lp_locker build. Drives the real site API
 * (started with a mainnet config pointing at the local RPC) the way the launch page does:
 * a fresh creator buys USDC.X for the fee, launches a token, traders generate tax, one
 * distributor cycle runs (holders, burn, auto-LP, creator reward swapped to USDC.X), and
 * the NFT holder collects LP fees. Nothing touches mainnet itself.
 *
 *   SITE=http://127.0.0.1:8125 LOCAL_RPC=http://127.0.0.1:8999 REFLECT_FACTORY_DIR=... \
 *     npx tsx scripts/mainnet-rehearsal.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";

const SITE = process.env.SITE ?? "http://127.0.0.1:8125";
const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8999", "confirmed");
const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const USDC = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const USDC_POOL = new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const FACTORY_DIR = process.env.REFLECT_FACTORY_DIR!;
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
/** Sign a server-built transaction as the wallet would, and send it through the site. */
async function signAndSend(label: string, p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64") });
  console.log(`  ✓ ${label}  ${signature.slice(0, 12)}…`);
  return out;
}
const fund = async (k: Keypair, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function swap(k: Keypair, ixs: Awaited<ReturnType<typeof buildBuy>>) {
  await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [k], { commitment: "confirmed" });
}

const creator = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
await fund(creator, 50);
for (const t of traders) await fund(t, 50);

console.log("1. Creator buys USDC.X for the launch fee (XNT/USDC.X pool)");
await swap(creator, await buildBuy(conn, XDEX, creator, await quoteBuy(conn, XDEX, USDC_POOL, USDC, 8n * 10n ** 9n, 100)));
const usdcAta = getAssociatedTokenAddressSync(USDC, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
const usdcBefore = (await getAccount(conn, usdcAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
console.log(`  ✓ creator holds ${Number(usdcBefore) / 1e6} USDC.X`);

console.log("2. Launch through the site API (token, pool, lock, register)");
const params = { name: "Rehearsal", symbol: "REH", image: "", description: "mainnet rehearsal", supply: "1000000", poolTokens: "1000000",
  poolXnt: "10", taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: creator.publicKey.toBase58() };
const { mint } = await signAndSend("create token (+1 USDC fee)", "/api/launch/token", params, creator);
await signAndSend("create pool", "/api/launch/pool", { mint, creator: params.creator }, creator);
await signAndSend("lock LP in NFT", "/api/launch/lock", { mint, creator: params.creator }, creator);
await signAndSend("print receipt", "/api/launch/receipt", { mint, creator: params.creator }, creator).catch((e) => console.log(`  (receipt skipped: ${e.message})`));
await api("/api/launch/register", { mint, creator: params.creator });
const usdcAfter = (await getAccount(conn, usdcAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
assert.equal(usdcBefore - usdcAfter, 1_000_000n, "launch fee should be exactly 1 USDC.X");
console.log(`  ✓ registered; launch fee charged: ${Number(usdcBefore - usdcAfter) / 1e6} USDC.X`);
const rec = JSON.parse(fs.readFileSync(path.join(FACTORY_DIR, "launches", mint, "launch.json"), "utf8"));
const m = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
assert.equal(m.mintAuthority, null, "mint authority revoked");
assert.ok(getTransferFeeConfig(m)!.transferFeeConfigAuthority.equals(PublicKey.default), "tax can't be changed");
console.log(`  ✓ mint authority revoked, tax fixed at ${getTransferFeeConfig(m)!.newerTransferFee.transferFeeBasisPoints / 100}%, pool ${rec.pool.slice(0, 6)}…, NFT ${rec.lockNft?.slice(0, 6)}…`);

console.log("3. Traders buy and sell to generate tax");
const pool = new PublicKey(rec.pool);
for (let round = 0; round < 3; round++) {
  for (const t of traders) await swap(t, await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, pool, new PublicKey(mint), 2n * 10n ** 9n, 300)));
  for (const t of traders.slice(0, 2)) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), t.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const bal = (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const q = await quoteSell(conn, XDEX, pool, new PublicKey(mint), bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
    if (q) await swap(t, await buildSell(conn, XDEX, t, new PublicKey(mint), q));
  }
}
const ready = (await api("/api/distribute/list")).tokens.find((x: { mint: string }) => x.mint === mint);
console.log(`  ✓ tax waiting ≈ ${xnt(BigInt(ready.worthLamports))} XNT (${ready.holders} holders qualify)`);

console.log("4. One distributor cycle (collect, burn, auto-LP, creator reward in USDC.X, pay holders)");
const dir = path.join(FACTORY_DIR, "launches", mint);
// Give the new distributor its gas reserve (the launch page funds it with gasXnt at launch).
const before = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
const out = execFileSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/distribute.ts", "--execute"], {
  env: { ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: conn.rpcEndpoint },
  encoding: "utf8",
});
console.log(out.split("\n").filter((l) => /Collected|Burn|burn|Auto-LP|Creator|creator|Paid|paid|pot|USDC|Error/i.test(l)).map((l) => "    " + l).join("\n"));
const after = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
const paid = after.map((a, i) => a - before[i]);
console.log(`  holders' XNT change: ${paid.map((p) => xnt(p)).join(", ")}`);
const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("reward"), new PublicKey(rec.lockNft).toBuffer(), USDC.toBuffer()], LOCKER)[0];
const vault = await conn.getAccountInfo(vaultPda);
console.log(`  creator reward vault (USDC.X): ${vault ? "exists" : "missing"}`);
const rewards = await api(`/api/nft/${rec.lockNft}`).catch((e) => ({ error: e.message }));
console.log(`  NFT view rewards: ${JSON.stringify(rewards.rewards ?? rewards.error)}`);

console.log("5. The NFT holder collects LP trading fees");
await signAndSend("collect fees", "/api/nft/collect", { nftMint: rec.lockNft, holder: params.creator }, creator)
  .catch((e) => console.log(`  (collect: ${e.message})`));
const board = await api(`/api/leaderboard/${mint}`);
console.log(`6. Leaderboard: ${board.summary.holders} holders, ${board.summary.trades} trades, avg cost ${board.summary.avgCost?.toFixed?.(8)} XNT`);
console.log("\nRehearsal finished.");
