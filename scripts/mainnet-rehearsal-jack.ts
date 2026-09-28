/**
 * Mainnet dress rehearsal of a JACK-paired launch against a LOCAL validator that clones
 * mainnet XDEX, USDC.X with its XNT pool, JACK with its XNT pool, and runs the mainnet
 * lp_locker build. Starts its own site server (throwaway mainnet config pointing at the
 * local RPC, JACK offered as a pair) and drives it the way the launch page does: a
 * creator buys USDC.X for the fee and JACK for the pool, launches a TOKEN/JACK token,
 * traders buy and sell it with JACK, one distributor cycle runs, and the NFT holder
 * collects the LP fees. Nothing touches mainnet itself.
 *
 * Start the validator first (the same clones as scripts/mainnet-rehearsal.ts, plus JACK):
 *
 *   solana-test-validator --reset --ledger <scratch>/jack-ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --url https://rpc.mainnet.x1.xyz \
 *     --clone-upgradeable-program sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN \
 *     --upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C lp-locker/target/mainnet/lp_locker.so \
 *       53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy \
 *     --maybe-clone SKc6b6zAv2kkB9EtitjppbzPVR48bCMfRtE5B8KDuF1 \
 *     --clone CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR --clone 2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c \
 *     --clone 8wvV4HKBDFMLEUkVWp1WPNa5ano99XCm3f9t3troyLb --clone 7iw2adw8Af7x3pY7gj5RwczFXuGjCoX92Gfy3avwXQtg \
 *     --clone 3xafowUtErXrTEF2Tk3ENpUdxgkK7b5hMuSSFr5AQk6z --clone 4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ \
 *     --clone B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq \
 *     --clone 54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg --clone wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW \
 *     --clone Hh2rTiqoUUBRHr6y1qrjsdFQxoUs92tmWixwoJdcVwTm --clone 5fEAiBUSjmURAuAeLYoEq4Rk5rf9KWXZMdsLRmwSWL3H \
 *     --clone DKGsNPi3q3o1wRa7TTDgAGpt1j2b3ftxg9a8g8NF3iog --clone Cc3GywVrwCFvpYeJQGU86a79sRxvNuPnq9DTdWjFK7x2
 *
 *   LOCAL_RPC=http://127.0.0.1:8999 npx tsx scripts/mainnet-rehearsal-jack.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint, getTransferFeeConfig } from "@solana/spl-token";
import { buildBuy, buildSell, decodePool, quoteBuy, quoteSell } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
const PORT = Number(process.env.PORT ?? 8126), SITE = `http://127.0.0.1:${PORT}`;
const conn = new Connection(RPC, "confirmed");
const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const USDC = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const USDC_POOL = new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
const JACK = new PublicKey("54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg");
const JACK_POOL = new PublicKey("wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const FEE_RECEIVER = "53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy";
const POOL_JACK = "0.02"; // ≈ 17 XNT at ~844 XNT per JACK
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
const ok = (m: string) => console.log(`  ✓ ${m}`);

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
/** Sign a server-built transaction as the wallet would, and send it through the site. */
async function signAndSend(label: string, p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64") });
  ok(`${label}  ${signature.slice(0, 12)}…`);
  return out;
}
/** Read views are cached (stale-while-revalidate, warmed at start-up): poll until `ready` holds. */
async function view<T>(p: string, ready: (v: T) => boolean): Promise<T> {
  let v = await api(p) as T;
  for (let i = 0; i < 40 && !ready(v); i++) { await sleep(3_000); v = await api(p) as T; }
  return v;
}
const fund = async (k: Keypair, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), "confirmed");
async function send(k: Keypair, ixs: Awaited<ReturnType<typeof buildBuy>>) {
  await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [k], { commitment: "confirmed" });
}
const tokenBal = async (mint: PublicKey, owner: PublicKey) =>
  getAccount(conn, getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID).then((a) => a.amount, () => 0n);
function runDistributor(dir: string, env: NodeJS.ProcessEnv, execute: boolean) {
  return new Promise<{ code: number; out: string }>((res) => {
    const p = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/distribute.ts", ...(execute ? ["--execute"] : [])],
      { env: { ...env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_STATE_DIR: path.join(dir, "state") } });
    let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", (code) => res({ code: code ?? 1, out: o }));
  });
}

// ---------- throwaway mainnet config with JACK offered as a pair ----------
const dir = fs.mkdtempSync(path.join(process.env.REHEARSAL_TMP ?? os.tmpdir(), "jack-rehearsal-"));
fs.writeFileSync(path.join(dir, "distributor.json"), JSON.stringify(Array.from(Keypair.generate().secretKey)));
const base = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
const cfg = {
  ...base, network: "mainnet", rpcUrl: RPC, mint: "",
  keypairs: { creator: path.join(dir, "distributor.json"), distributor: path.join(dir, "distributor.json") },
  xdex: { programId: XDEX.toBase58(), pool: "" },
  locker: { programId: LOCKER.toBase58(), nftUri: "" },
  factory: {
    feeReceiver: FEE_RECEIVER, feeUsdc: "1", gasXnt: "0.05", port: PORT, publicUrl: SITE, hosts: [], theme: "receipt",
    quoteTokens: [{ mint: JACK.toBase58(), symbol: "JACK", xntPool: JACK_POOL.toBase58() }],
  },
  distribution: { ...base.distribution, autoLpBps: 2500, burnBps: 2500, creatorBps: 0, excludeOwners: [] },
};
delete cfg.creatorReward;
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = { ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC };
const server = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
const log: string[] = [];
server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
process.on("exit", () => server.kill());
for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);

try {
  const creator = Keypair.generate();
  const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  await fund(creator, 100);
  for (const t of traders) await fund(t, 50);
  const info = await api("/api/info");
  const jackInfo = info.quoteTokens.find((q: { symbol: string }) => q.symbol === "JACK");
  assert.ok(jackInfo?.priceXnt > 100, "the site prices JACK in XNT");
  ok(`site offers JACK as a pair (1 JACK ≈ ${jackInfo.priceXnt.toFixed(2)} XNT)`);

  console.log("1. Creator buys USDC.X for the launch fee and JACK for the pool (local swaps on the cloned pools)");
  await send(creator, await buildBuy(conn, XDEX, creator, await quoteBuy(conn, XDEX, USDC_POOL, USDC, 8n * 10n ** 9n, 100)));
  await send(creator, await buildBuy(conn, XDEX, creator, await quoteBuy(conn, XDEX, JACK_POOL, JACK, 25n * 10n ** 9n, 100)));
  const jackStart = await tokenBal(JACK, creator.publicKey);
  assert.ok(jackStart > 20_000_000n, "creator bought enough JACK");
  ok(`creator holds ${Number(jackStart) / 1e9} JACK`);

  console.log("2. Launch a JACK-paired token through the site API");
  const params = { name: "Jack Rehearsal", symbol: "JREH", image: "", description: "JACK pair rehearsal", supply: "1000000", poolTokens: "1000000",
    poolXnt: POOL_JACK, quote: "JACK", taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: creator.publicKey.toBase58() };
  // Refused before anything is signed: a pair the site doesn't offer, and more JACK than the wallet holds.
  await api("/api/launch/token", { ...params, quote: "BONK" }).then(() => assert.fail("unknown pair accepted"), (e) => ok(`unknown pair refused (${e.message.split(": ").pop()})`));
  await api("/api/launch/token", { ...params, poolXnt: "5" }).then(() => assert.fail("too much JACK accepted"), (e) => ok(`JACK balance checked (${e.message.split(": ").slice(1).join(": ").slice(0, 90)}…)`));
  const xntBefore = await conn.getBalance(creator.publicKey);
  const { mint } = await signAndSend("create token (+1 USDC fee)", "/api/launch/token", params, creator);
  await signAndSend("create TOKEN/JACK pool", "/api/launch/pool", { mint, creator: params.creator }, creator);
  await signAndSend("lock LP in NFT", "/api/launch/lock", { mint, creator: params.creator }, creator);
  await signAndSend("print receipt", "/api/launch/receipt", { mint, creator: params.creator }, creator).catch((e) => console.log(`  (receipt skipped: ${e.message})`));
  await api("/api/launch/register", { mint, creator: params.creator });
  const launchDir = path.join(dir, "factory", "launches", mint);
  const rec = JSON.parse(fs.readFileSync(path.join(launchDir, "launch.json"), "utf8"));
  const tokenCfg = JSON.parse(fs.readFileSync(path.join(launchDir, "config.json"), "utf8"));
  assert.equal(rec.quote, "JACK"); assert.equal(rec.quoteMint, JACK.toBase58()); assert.equal(rec.quoteXntPool, JACK_POOL.toBase58());
  assert.equal(tokenCfg.xdex.quoteMint, JACK.toBase58()); assert.equal(tokenCfg.xdex.quoteXntPool, JACK_POOL.toBase58());
  assert.equal(tokenCfg.xdex.pool, rec.pool);
  const pool = decodePool(new PublicKey(rec.pool), await conn.getAccountInfo(new PublicKey(rec.pool)), XDEX);
  assert.deepEqual(new Set(pool.mints.map((m) => m.toBase58())), new Set([mint, JACK.toBase58()]), "pool is TOKEN/JACK");
  const jackSpent = jackStart - await tokenBal(JACK, creator.publicKey);
  assert.equal(jackSpent, 20_000_000n, "exactly the pool's JACK left the creator");
  const m = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m.mintAuthority, null);
  assert.ok(getTransferFeeConfig(m)!.transferFeeConfigAuthority.equals(PublicKey.default));
  ok(`registered: pool ${rec.pool.slice(0, 6)}… is TOKEN/JACK with ${Number(jackSpent) / 1e9} JACK; creator spent ${xnt(xntBefore - await conn.getBalance(creator.publicKey))} XNT (pool fee, gas, rent, fees)`);
  ok(`per-launch config: xdex.quoteMint JACK, quoteXntPool ${tokenCfg.xdex.quoteXntPool.slice(0, 6)}…, NFT ${rec.lockNft.slice(0, 6)}…`);

  console.log("3. Traders buy JACK, then buy and sell the token with JACK");
  const tokenMint = new PublicKey(mint), poolKey = new PublicKey(rec.pool);
  for (const t of traders) await send(t, await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, JACK_POOL, JACK, 4n * 10n ** 9n, 100)));
  let trades = 0;
  for (let round = 0; round < 3; round++) {
    for (const t of traders) {
      // As much JACK as the 3% price-impact cap allows.
      const q = await quoteSell(conn, XDEX, poolKey, JACK, await tokenBal(JACK, t.publicKey), { maxImpactBps: 300, slippageBps: 300 }, tokenMint);
      if (q) { await send(t, await buildSell(conn, XDEX, t, JACK, q)); trades++; }
    }
    for (const t of traders.slice(0, 2)) {
      const q = await quoteSell(conn, XDEX, poolKey, tokenMint, (await tokenBal(tokenMint, t.publicKey)) / 3n, { maxImpactBps: 300, slippageBps: 300 }, JACK);
      if (q) { await send(t, await buildSell(conn, XDEX, t, tokenMint, q)); trades++; }
    }
  }
  const ready = (await api("/api/distribute/list")).tokens.find((x: { mint: string }) => x.mint === mint);
  assert.ok(BigInt(ready.worthLamports) >= BigInt(ready.thresholdLamports), `tax waiting (${ready.worthLamports}) should reach the collection threshold`);
  ok(`${trades} trades; tax waiting ≈ ${xnt(BigInt(ready.worthLamports))} XNT (valued via JACK/XNT), ${ready.holders} holders qualify`);

  console.log("4. Distributor: a dry run, then one real cycle");
  const dry = await runDistributor(launchDir, env, false);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /on the JACK\/XNT pool/, "dry run plans the JACK -> XNT swap");
  ok("dry run plans: sell for JACK, auto-LP with JACK, swap the rest to XNT");
  const creatorJackBefore = await tokenBal(JACK, creator.publicKey);
  const before = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
  const run = await runDistributor(launchDir, env, true);
  console.log(run.out.split("\n").filter((l) => /^\[|Swap|Sell |Auto-LP|Creator|pot|rror/.test(l)).map((l) => "    " + l.replace(/\s+[1-9A-HJ-NP-Za-km-z]{80,90}$/, "")).join("\n"));
  assert.equal(run.code, 0, run.out);
  const after = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
  const paid = after.map((a, i) => a - before[i]);
  assert.ok(paid.some((p) => p > 0), "holders received XNT");
  ok(`holders' XNT change: ${paid.map((p) => xnt(p)).join(", ")} XNT`);
  const events = fs.readFileSync(path.join(launchDir, "state", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const sell = events.find((e) => e.kind === "sell"), lp = events.find((e) => e.kind === "auto-lp"), swap = events.find((e) => e.kind === "quote-swap");
  assert.ok(sell && BigInt(sell.quote) > 0n && sell.quoteMint === JACK.toBase58(), "tax sold for JACK");
  assert.ok(lp && BigInt(lp.tokens) > 0n && BigInt(lp.quote) > 0n && BigInt(lp.xnt) > 0n, "auto-LP added TOKEN + JACK");
  assert.ok(swap && BigInt(swap.xnt) > 0n && BigInt(swap.creatorXnt) > 0n, "JACK swapped to XNT, creator's part set aside");
  ok(`sold tax for ${Number(sell.quote) / 1e9} JACK; auto-LP added ${Number(lp.tokens) / 1e9} tokens + ${Number(lp.quote) / 1e9} JACK (≈ ${xnt(lp.xnt)} XNT), LP burned`);
  ok(`swapped ${Number(swap.quote) / 1e9} JACK for ${xnt(swap.xnt)} XNT (${xnt(swap.creatorXnt)} XNT for the creator)`);
  const st = JSON.parse(fs.readFileSync(path.join(launchDir, "state", "distributor-state.json"), "utf8"));
  assert.equal(st.inflight, null, "nothing left in flight");
  ok(`state: ${st.quote ? `JACK set aside for auto-LP ${Number(st.quote.lp) / 1e9}, for the creator ${Number(st.quote.creator) / 1e9}` : "no JACK waiting"}; creator XNT ${xnt(BigInt(st.creator.xnt))}`);
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("reward"), new PublicKey(rec.lockNft).toBuffer(), USDC.toBuffer()], LOCKER)[0];
  assert.ok(await conn.getAccountInfo(vaultPda), "creator reward vault (USDC.X) exists");
  const nft = await api(`/api/nft/${rec.lockNft}`);
  assert.ok(BigInt(nft.rewards.vesting) > 0n && nft.rewards.symbol === "USDC", "creator reward deposited in USDC.X");
  ok(`creator reward: ${Number(nft.rewards.vesting) / 1e6} USDC.X vesting in the lock NFT's vault`);
  assert.equal(nft.quote, "JACK");

  console.log("5. The NFT holder collects LP trading fees (TOKEN + JACK)");
  const fees = nft.fees;
  assert.equal(fees?.quote, "JACK");
  ok(`fees ready: ${Number(fees.quoteAmount) / 1e9} JACK + ${Number(fees.tokens) / 1e9} tokens ≈ ${xnt(fees.worth)} XNT (network fee ≈ ${xnt(fees.networkFee ?? 0)})`);
  const tokBefore = await tokenBal(tokenMint, creator.publicKey);
  await signAndSend("collect fees", "/api/nft/collect", { nftMint: rec.lockNft, holder: params.creator }, creator);
  const gotJack = (await tokenBal(JACK, creator.publicKey)) - creatorJackBefore, gotTok = (await tokenBal(tokenMint, creator.publicKey)) - tokBefore;
  assert.ok(gotJack > 0n && gotTok > 0n, "collect paid both TOKEN and JACK");
  ok(`collected ${Number(gotJack) / 1e9} JACK + ${Number(gotTok) / 1e9} tokens`);

  console.log("6. Site views");
  type Row = { mint: string; [k: string]: any };
  const list = (await view<Row[]>("/api/token-list", (v) => v.some((t) => t.mint === mint))).find((t) => t.mint === mint)!;
  assert.equal(list.quote, "JACK");
  assert.ok(list.priceQuote > 0 && list.priceXnt > list.priceQuote * 100, "price in JACK with its XNT value");
  ok(`token list: ${list.priceQuote.toPrecision(3)} JACK ≈ ${list.priceXnt.toPrecision(3)} XNT per token; liquidity ${Number(list.liquidityQuote) / 1e9} JACK ≈ ${xnt(list.liquidityXnt)} XNT`);
  const stats = await view<any>(`/api/token/${mint}/stats`, (v) => BigInt(v.holdersXnt) > 0n);
  assert.ok(BigInt(stats.holdersXnt) > 0n && stats.launchPriceQuote > 0 && stats.launchPriceXnt === null);
  ok(`token stats: paid ${xnt(stats.holdersXnt)} XNT to holders, liquidity added ≈ ${xnt(stats.liquidityXnt)} XNT, pool ≈ ${xnt(stats.poolXnt)} XNT`);
  const board = await view<any>(`/api/leaderboard/${mint}`, (v) => v.summary.rewardsPaid > 0);
  assert.equal(board.quote, "JACK");
  assert.ok(board.summary.trades > 0 && board.summary.rewardsPaid > 0);
  ok(`leaderboard (costs in JACK): ${board.summary.trades} trades, avg cost ${board.summary.avgCost?.toPrecision(3)} JACK, rewards paid ${board.summary.rewardsPaid.toFixed(6)} XNT`);
  const nfts = await view<{ nftMint: string; valueXnt: string }[]>("/api/nfts", (v) => v.some((n) => n.nftMint === rec.lockNft));
  const mine = nfts.find((n) => n.nftMint === rec.lockNft);
  assert.ok(mine && BigInt(mine.valueXnt) > 0n);
  ok(`locked NFTs list: liquidity locked ≈ ${xnt(mine.valueXnt)} XNT`);
  console.log("\nJACK rehearsal finished: all checks passed.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error("--- server log (last 30 lines) ---\n" + log.join("").split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  server.kill();
}
