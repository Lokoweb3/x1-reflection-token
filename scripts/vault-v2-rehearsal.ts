/**
 * Tax Vault v2 rollout rehearsal: the exact testnet upgrade sequence, on a LOCAL validator.
 *
 *   1. The site as deployed today (OLD_SITE: a checkout of the previous commit) with the v1
 *      program: launch a vault token, trade it, let the v1 crank pay holders and fund the
 *      creator in XNT (like CUP today).
 *   2. Stop the site, deploy the v2 build over the program (extend first), start the NEW
 *      site on the same factory/state directories.
 *   3. The new crank upgrades the vault by itself (upgrade_vault), keeps paying holders and
 *      pays the creator in the reward token (XNM); the NFT page shows XNM plus the old XNT
 *      rewards, and both claims build; a fresh launch uses the v2 init_vault.
 *
 * Start the validator as in scripts/local-vault-v2-test.ts (v1 build loaded upgradeable,
 * XNM + its pool cloned), make a checkout of the old site with node_modules and
 * config.json, then:
 *   LOCAL_RPC=http://127.0.0.1:8999 OLD_SITE=<checkout> UPGRADE_AUTHORITY=<keypair file> \
 *     npx tsx scripts/vault-v2-rehearsal.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount,
  getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const OLD_SITE = path.resolve(process.env.OLD_SITE!);
const AUTHORITY = process.env.UPGRADE_AUTHORITY!;
const V2_SO = process.env.V2_SO ?? "lp-locker/target/vault2-test/tax_vault.so";
const XNM = "AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ";
const PORT = 8129, SITE = `http://127.0.0.1:${PORT}`;
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);
assert.ok(process.env.OLD_SITE && AUTHORITY, "OLD_SITE=<old checkout> UPGRADE_AUTHORITY=<keypair file>");

const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
async function step(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64") });
  return { ...out, signature };
}

// ---------- throwaway setup ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-v2-rehearsal-"));
const payer = Keypair.generate(), publisher = Keypair.generate(), creatorA = Keypair.generate(), creatorB = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [payer, publisher, creatorA, creatorB, ...traders]) await fund(k.publicKey, k === publisher ? 5 : 80);
await fund(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(AUTHORITY, "utf8")))).publicKey, 20);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
for (const c of [creatorA, creatorB]) {
  const ata = getAssociatedTokenAddressSync(feeMint, c.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, c.publicKey, feeMint)), [payer]);
  await mintTo(conn, payer, feeMint, ata, payer, 5_000_000);
}
fs.writeFileSync(path.join(dir, "publisher.json"), JSON.stringify(Array.from(publisher.secretKey)));
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], pinataJwt: undefined, faucet: undefined, turnstile: undefined,
    curve: undefined, quoteTokens: undefined, launchesPaused: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: path.join(dir, "publisher.json") },
  },
};
delete cfg.creatorReward;
const cfgFile = path.join(dir, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = { ...process.env, REFLECT_CONFIG: cfgFile, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC };
const log: string[] = [];
let server: ReturnType<typeof spawn> | null = null;
async function startServer(cwd: string) {
  server = spawn(process.execPath, [path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
}
async function stopServer() { if (!server) return; server.kill(); await new Promise((r) => server!.once("exit", r)); server = null; }
process.on("exit", () => server?.kill());

async function launch(creator: Keypair, name: string, symbol: string) {
  const params = { name, symbol, image: "", description: "vault v2 rehearsal", supply: "1000000", poolTokens: "1000000", poolXnt: "10",
    taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: creator.publicKey.toBase58() };
  const { mint } = await step("/api/launch/token", params, creator);
  await step("/api/launch/pool", { mint, creator: params.creator }, creator);
  await step("/api/launch/lock", { mint, creator: params.creator }, creator);
  await step("/api/launch/vault", { mint, creator: params.creator }, creator);
  await api("/api/launch/register", { mint, creator: params.creator });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
  return { mint, rec };
}
async function trade(mint: string, pool: string, rounds = 2) {
  for (let r = 0; r < rounds; r++) {
    for (const t of traders) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, await quoteBuy(conn, XDEX, new PublicKey(pool), new PublicKey(mint), 3n * 10n ** 9n, 300)))), [t]);
    for (const t of traders.slice(0, 2)) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), t.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const bal = (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const q = await quoteSell(conn, XDEX, new PublicKey(pool), new PublicKey(mint), bal / 3n, { maxImpactBps: 300, slippageBps: 300 });
      if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, new PublicKey(mint), q))), [t]);
    }
  }
}
const vaultAddr = (mint: string) => PublicKey.findProgramAddressSync([Buffer.from("vault"), new PublicKey(mint).toBuffer()], PROGRAM)[0];
const vaultLen = async (mint: string) => (await conn.getAccountInfo(vaultAddr(mint), "confirmed"))?.data.length ?? 0;
const events = (mint: string) => {
  const f = path.join(dir, "factory", "launches", mint, "state", "events.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
async function waitFor(what: string, test: () => Promise<boolean>, ms = 480_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; } await sleep(10_000); }
  throw new Error(`timed out waiting for: ${what}`);
}

try {
  console.log("1. OLD site + v1 program: a vault token (T1), trading, v1 crank cycles");
  await startServer(OLD_SITE);
  const t1 = await launch(creatorA, "Old Vault", "OLDV");
  assert.equal(await vaultLen(t1.mint), 480, "a v1 vault is 480 bytes");
  ok(`T1 ${t1.mint.slice(0, 8)}… launched with a v1 vault (480 bytes)`);
  await trade(t1.mint, t1.rec.pool, 3);
  await waitFor("v1 crank paid holders and funded the creator in XNT", async () => {
    const v = await api(`/api/vault/${t1.mint}`);
    return BigInt(v.state?.holdersPaid ?? 0) > 0n && events(t1.mint).some((e) => e.kind === "creator-reward");
  });
  const nft = t1.rec.lockNft ?? t1.rec.nftMint;
  const v1View = await api(`/api/vault/${t1.mint}`);
  ok(`before the upgrade: holders paid ${xnt(BigInt(v1View.state.holdersPaid))} XNT, list epoch ${v1View.state.list?.epoch ?? "-"}`);
  await trade(t1.mint, t1.rec.pool, 2); // tax waiting in the vault at upgrade time
  await stopServer();

  console.log("2. Stop the site, deploy v2 over the program, start the NEW site");
  {
    const size = fs.statSync(V2_SO).size;
    const prog = (await conn.getAccountInfo(PROGRAM))!;
    const pd = new PublicKey(prog.data.subarray(4, 36));
    const pdLen = (await conn.getAccountInfo(pd))!.data.length - 45;
    const cli = (args: string[]) => execFileSync("solana", [...args, "--url", RPC, "--keypair", AUTHORITY], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (size > pdLen) { cli(["program", "extend", PROGRAM.toBase58(), String(size - pdLen)]); ok(`program extended by ${size - pdLen} bytes`); }
    cli(["program", "deploy", "--program-id", PROGRAM.toBase58(), "--upgrade-authority", AUTHORITY, V2_SO]);
    ok(`v2 deployed (${size} bytes)`);
    await sleep(1500);
  }
  await startServer(process.cwd());
  const info = await api("/api/info");
  ok(`new site reports taxVault: ${JSON.stringify(info.taxVault)}`);

  console.log("3. NEW crank: upgrade in place, holders keep getting paid, creator reward in XNM");
  const paidBefore = BigInt((await api(`/api/vault/${t1.mint}`)).state?.holdersPaid ?? 0);
  await waitFor("vault upgraded to 552 bytes by the crank", async () => (await vaultLen(t1.mint)) === 552);
  await trade(t1.mint, t1.rec.pool, 2);
  await waitFor("creator paid in XNM and holders paid again after the upgrade", async () => {
    const v = await api(`/api/vault/${t1.mint}`);
    return BigInt(v.state?.holdersPaid ?? 0) > paidBefore && events(t1.mint).some((e) => e.kind === "creator-reward" && e.rewardMint === XNM);
  });
  const v2View = await api(`/api/vault/${t1.mint}`);
  ok(`after: version ${v2View.version ?? v2View.state?.version}, holders paid ${xnt(BigInt(v2View.state.holdersPaid))} XNT, cancels ${JSON.stringify(v2View.cancelsLeft ?? v2View.state?.cancelsLeft ?? null)}`);
  const xnmEv = events(t1.mint).filter((e) => e.kind === "creator-reward" && e.rewardMint === XNM);
  ok(`XNM creator rewards: ${xnmEv.length} swap(s), ${xnmEv.map((e) => `${xnt(BigInt(e.xnt))} XNT -> ${xnt(BigInt(e.reward))} XNM`).join("; ")}`);
  const nftView = await api(`/api/nft/${nft}`);
  const r = nftView.rewards;
  ok(`NFT page rewards: main ${r?.symbol ?? r?.mint} claimable ${r?.claimable} vesting ${r?.vesting}; others ${JSON.stringify((r?.others ?? []).map((o: any) => [o.symbol ?? o.mint, o.claimable, o.vesting]))}`);
  assert.ok(r && (r.mint === XNM || r.symbol === "XNM"), "the NFT's main reward is XNM");
  assert.ok((r.others ?? []).length >= 1, "the old XNT reward still shows");
  for (const want of [XNM, "So11111111111111111111111111111111111111112"]) {
    const res = await api("/api/nft/claim", { nftMint: nft, holder: creatorA.publicKey.toBase58(), rewardMint: want }).then(() => "tx built", (e) => `refused: ${e.message}`);
    ok(`claim ${want === XNM ? "XNM" : "XNT"}: ${res}`);
  }
  const stats = await api(`/api/token/${t1.mint}/stats`);
  ok(`token stats: holders ${xnt(BigInt(stats.holdersXnt ?? 0))} XNT, creator ${xnt(BigInt(stats.creatorXnt ?? 0))} XNT`);

  console.log("4. A fresh launch on the new site gets a v2 vault straight away");
  const t2 = await launch(creatorB, "New Vault", "NEWV");
  assert.equal(await vaultLen(t2.mint), 552, "a new vault is v2");
  ok(`T2 ${t2.mint.slice(0, 8)}… launched with a v2 vault (552 bytes)`);
  console.log("\nVault v2 rollout rehearsal finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error("--- server log (last 50 lines) ---\n" + log.join("").split("\n").slice(-50).join("\n"));
  process.exitCode = 1;
} finally {
  await stopServer();
}
