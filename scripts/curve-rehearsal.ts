/**
 * Bonding-curve rehearsal: the real site server + the real bonding_curve program on a
 * LOCAL validator (testnet XDEX and lp_locker cloned in). Drives everything through the
 * site's API the way the Curve tab does, then waits for the server's crank to graduate
 * the curve and deliver every buyer's tokens, and checks the result on-chain. Nothing
 * touches a real network.
 *
 * Start the validator first (see scripts/local-curve-test.ts), then:
 *   LOCAL_RPC=http://127.0.0.1:8999 CURVE_PROGRAM=<id> npx tsx scripts/curve-rehearsal.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount,
  getAssociatedTokenAddressSync, getMint, getTransferFeeAmount, mintTo,
} from "@solana/spl-token";
import { buildSell, quoteSell } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
const PROGRAM = process.env.CURVE_PROGRAM!;
const PORT = 8127, SITE = `http://127.0.0.1:${PORT}`;
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
const ok = (m: string) => console.log(`  ✓ ${m}`);

const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
async function signAndSend(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64"), curveMint: body.mint });
  return { ...out, signature };
}

// ---------- throwaway config, fee token and crank ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curve-rehearsal-"));
const payer = Keypair.generate(), crank = Keypair.generate(), creator = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [payer, crank, creator, ...buyers]) await fund(k.publicKey, k === crank ? 2 : 60);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
const creatorFee = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, creatorFee, creator.publicKey, feeMint)), [payer]);
await mintTo(conn, payer, feeMint, creatorFee, payer, 5_000_000);
fs.writeFileSync(path.join(dir, "crank.json"), JSON.stringify(Array.from(crank.secretKey)));
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], pinataJwt: undefined, faucet: undefined, turnstile: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    curve: { programId: PROGRAM, crankKeypair: path.join(dir, "crank.json") },
  },
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
  console.log("1. Create a curve token through the site (launch fee in the local fee token)");
  const params = { name: "Curve Rehearsal", symbol: "CRV", image: "", description: "rehearsal", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 2500, creator: creator.publicKey.toBase58() };
  const { mint } = await signAndSend("/api/curve/create", params, creator);
  const m = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m.supply, 0n);
  ok(`created ${mint.slice(0, 8)}…: supply 0, launch fee paid (${Number((await getAccount(conn, creatorFee)).amount) / 1e6} TST left)`);
  const view = async (w?: Keypair) => api(`/api/curve/${mint}${w ? `?wallet=${w.publicKey.toBase58()}` : ""}`);

  console.log("2. Trading through the site");
  await signAndSend("/api/curve/buy", { wallet: creator.publicKey.toBase58(), mint, xnt: "0.1" }, creator).then(() => assert.fail("creator buy should fail"), (e) => ok(`creator can't buy (${String(e.message).slice(0, 60)}…)`));
  await sleep(125_000); // the site enforces the real 2-minute anti-snipe window
  for (const [i, amt] of [["0", "2"], ["1", "3"], ["2", "1.5"], ["0", "4"]] as const) {
    const r = await signAndSend("/api/curve/buy", { wallet: buyers[+i].publicKey.toBase58(), mint, xnt: amt }, buyers[+i]);
    ok(`buyer ${i} bought with ${amt} XNT (quote ${JSON.stringify(r.quote).slice(0, 90)}…)`);
  }
  const s = await signAndSend("/api/curve/sell", { wallet: buyers[1].publicKey.toBase58(), mint, tokens: "50000000" }, buyers[1]);
  ok(`buyer 1 sold 50M tokens back (quote ${JSON.stringify(s.quote).slice(0, 80)}…)`);
  let v = await view(buyers[0]);
  ok(`progress: raised ${v.curve?.raisedXnt ?? v.raisedXnt ?? JSON.stringify(v).slice(0, 0)} | status ${v.curve?.status ?? v.status}`);
  const fin = await signAndSend("/api/curve/buy", { wallet: buyers[2].publicKey.toBase58(), mint, xnt: "30" }, buyers[2]);
  ok(`final buy completes the curve (quote ${JSON.stringify(fin.quote).slice(0, 90)}…)`);

  console.log("3. The site's crank graduates the curve and delivers tokens");
  const t0 = Date.now();
  let status = "";
  while (Date.now() - t0 < 240_000) {
    v = await view();
    status = String(v.curve?.status ?? v.status ?? v.curve?.statusName ?? "");
    if (/finished|4/i.test(status)) break;
    await sleep(5_000);
  }
  ok(`curve status after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${status}`);
  const m2 = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  assert.equal(m2.mintAuthority, null, "mint authority revoked");
  assert.equal(m2.supply, 1_000_000_000n * 10n ** 9n, "supply is exactly S");
  ok(`mint authority None, supply exactly 1,000,000,000`);
  for (const [i, b] of buyers.entries()) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), b.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const acc = await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    ok(`buyer ${i} received ${(Number(acc.amount) / 1e9).toLocaleString()} tokens in their wallet`);
  }
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
  ok(`launch record: registered ${rec.registeredAt ? "yes" : "NO"}, pool ${String(rec.pool).slice(0, 8)}…, lock NFT ${String(rec.lockNft ?? "").slice(0, 8)}…`);
  assert.ok(rec.registeredAt, "registered with the distributor");
  const nftAta = getAssociatedTokenAddressSync(new PublicKey(rec.lockNft), creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
  assert.equal((await getAccount(conn, nftAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1n);
  ok("creator holds the LP-lock NFT");

  console.log("4. Trading on XDEX pays the tax, and the distributor pays holders");
  const seller = buyers[0], sAta = getAssociatedTokenAddressSync(new PublicKey(mint), seller.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bal = (await getAccount(conn, sAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const q = await quoteSell(conn, XDEX, new PublicKey(rec.pool), new PublicKey(mint), bal / 2n, { maxImpactBps: 5000, slippageBps: 500 });
  await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, seller, new PublicKey(mint), q!))), [seller]);
  ok(`buyer 0 sold ${(Number(q!.amountIn) / 1e9).toLocaleString()} tokens on XDEX; tax withheld ${(Number(q!.transferFee) / 1e9).toLocaleString()}`);
  const launchDir = path.join(dir, "factory", "launches", mint);
  const before = await Promise.all(buyers.slice(1).map((b) => conn.getBalance(b.publicKey)));
  const out = await new Promise<string>((res) => {
    const p = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/distribute.ts", "--execute"], { env: { ...env, REFLECT_CONFIG: path.join(launchDir, "config.json"), REFLECT_STATE_DIR: path.join(launchDir, "state") } });
    let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", () => res(o));
  });
  console.log(out.split("\n").filter((l) => /Collected|burn|Auto-LP|Creator|Paid|pot|Error|error/i.test(l)).map((l) => "    " + l.slice(0, 150)).join("\n"));
  const after = await Promise.all(buyers.slice(1).map((b) => conn.getBalance(b.publicKey)));
  ok(`holders' XNT change: ${after.map((a, i) => xnt(a - before[i])).join(", ")}`);
  console.log("\nCurve rehearsal finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error("--- server log (last 30 lines) ---\n" + log.join("").split("\n").slice(-30).join("\n"));
  process.exitCode = 1;
} finally {
  server.kill();
}
