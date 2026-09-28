/**
 * Tax Vault rehearsal: the real site server + the real tax_vault program on a LOCAL
 * validator (testnet XDEX and lp_locker cloned in, tax_vault from the short-windows build).
 *
 *   1. Site without the vault: launch a hot-wallet token (T1), trade it, run one normal
 *      distributor cycle.
 *   2. Site with the vault: launch a vault token (T2) through all five steps, trade it.
 *   3. Migrate T1 onto the vault with scripts/migrate-to-vault.ts --execute.
 *   4. Trade both, let the site's vault crank collect, sell, add liquidity, fund the
 *      creator, publish the rewards list and pay holders; check the chain and the site.
 *
 * Start the validator first (see scripts/local-vault-test.ts for the clones), then:
 *   LOCAL_RPC=http://127.0.0.1:8999 VAULT_PROGRAM=<id> npx tsx scripts/vault-rehearsal.ts
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount,
  getAssociatedTokenAddressSync, getMint, getTransferFeeConfig, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
const PROGRAM = process.env.VAULT_PROGRAM!;
const PORT = 8128, SITE = `http://127.0.0.1:${PORT}`;
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);
const tsx = path.join("node_modules", "tsx", "dist", "cli.mjs");

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-rehearsal-"));
const payer = Keypair.generate(), publisher = Keypair.generate(), creatorA = Keypair.generate(), creatorB = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const k of [payer, publisher, creatorA, creatorB, ...traders]) await fund(k.publicKey, k === publisher ? 5 : 80);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
for (const c of [creatorA, creatorB]) {
  const ata = getAssociatedTokenAddressSync(feeMint, c.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, c.publicKey, feeMint)), [payer]);
  await mintTo(conn, payer, feeMint, ata, payer, 5_000_000);
}
fs.writeFileSync(path.join(dir, "publisher.json"), JSON.stringify(Array.from(publisher.secretKey)));
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const baseCfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], pinataJwt: undefined, faucet: undefined, turnstile: undefined,
    curve: undefined, quoteTokens: undefined, launchesPaused: undefined,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
  },
};
delete baseCfg.creatorReward;
const cfgA = path.join(dir, "config-hot.json"), cfgB = path.join(dir, "config-vault.json");
fs.writeFileSync(cfgA, JSON.stringify(baseCfg, null, 2));
fs.writeFileSync(cfgB, JSON.stringify({ ...baseCfg, factory: { ...baseCfg.factory, taxVault: { programId: PROGRAM, publisherKeypair: path.join(dir, "publisher.json") } } }, null, 2));
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const envFor = (cfg: string) => ({ ...process.env, REFLECT_CONFIG: cfg, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC });
const log: string[] = [];
let server: ReturnType<typeof spawn> | null = null;
async function startServer(cfg: string) {
  server = spawn(process.execPath, [tsx, "src/factory-server.ts"], { env: envFor(cfg), stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
}
async function stopServer() { if (!server) return; server.kill(); await new Promise((r) => server!.once("exit", r)); server = null; }
process.on("exit", () => server?.kill());

async function launch(creator: Keypair, name: string, symbol: string, vault: boolean) {
  const params = { name, symbol, image: "", description: "vault rehearsal", supply: "1000000", poolTokens: "1000000", poolXnt: "10",
    taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: creator.publicKey.toBase58() };
  const { mint } = await step("/api/launch/token", params, creator);
  await step("/api/launch/pool", { mint, creator: params.creator }, creator);
  await step("/api/launch/lock", { mint, creator: params.creator }, creator);
  if (vault) await step("/api/launch/vault", { mint, creator: params.creator }, creator);
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
const withdrawAuthority = async (mint: string) =>
  getTransferFeeConfig(await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID))!.withdrawWithheldAuthority.toBase58();

try {
  console.log("1. Site WITHOUT the vault: a hot-wallet launch (T1) and one normal cycle");
  await startServer(cfgA);
  const t1 = await launch(creatorA, "Hot Token", "HOT", false);
  ok(`T1 ${t1.mint.slice(0, 8)}… launched; withdraw authority = its distributor ${(await withdrawAuthority(t1.mint)).slice(0, 8)}…`);
  await trade(t1.mint, t1.rec.pool);
  const t1Dir = path.join(dir, "factory", "launches", t1.mint);
  const cyc = spawnSync(process.execPath, [tsx, "src/distribute.ts", "--execute"], { env: { ...envFor(cfgA), REFLECT_CONFIG: path.join(t1Dir, "config.json"), REFLECT_STATE_DIR: path.join(t1Dir, "state") }, encoding: "utf8" });
  ok(`normal cycle for T1: ${(cyc.stdout.match(/\[payout\][^\n]*|No holder[^\n]*/) ?? ["(see log)"])[0].slice(0, 80)}`);
  await stopServer();

  console.log("2. Site WITH the vault: a vault launch (T2), five steps");
  await startServer(cfgB);
  const info = await api("/api/info");
  ok(`site reports taxVault: ${JSON.stringify(info.taxVault)}`);
  const t2 = await launch(creatorB, "Vault Token", "VLT", true);
  const auth2 = PublicKey.findProgramAddressSync([Buffer.from("auth"), new PublicKey(t2.mint).toBuffer()], new PublicKey(PROGRAM))[0];
  assert.equal(await withdrawAuthority(t2.mint), auth2.toBase58(), "T2's withdraw authority is the vault's auth PDA");
  ok(`T2 ${t2.mint.slice(0, 8)}… launched: withdraw authority = vault auth PDA (no distributor key); registered ${!!t2.rec.registeredAt || "check"}`);
  assert.ok(!fs.existsSync(path.join(dir, "factory", "launches", t2.mint, "distributor.json")), "no distributor key file for a vault launch");
  ok("no distributor key file was created for T2");
  await trade(t2.mint, t2.rec.pool);

  console.log("3. Migrate T1 onto the vault");
  // Like an operator would: run normal cycles until the old distributor holds only dust
  // (sales are capped per cycle), checking with the migration script's dry run.
  for (let i = 0; i < 8; i++) {
    const dry = spawnSync(process.execPath, [tsx, "scripts/migrate-to-vault.ts", t1.mint, "--ignore-owed"], { env: envFor(cfgB), encoding: "utf8" });
    if (dry.status === 0 && !/Refusing/.test(dry.stdout + dry.stderr)) { ok(`dry run clear after ${i} extra cycle(s)`); break; }
    ok(`dry run refused (${(dry.stdout + dry.stderr).match(/Refusing:[^\n]*/)?.[0].slice(0, 90) ?? "see output"}); running another normal cycle`);
    spawnSync(process.execPath, [tsx, "src/distribute.ts", "--execute"], { env: { ...envFor(cfgA), REFLECT_CONFIG: path.join(t1Dir, "config.json"), REFLECT_STATE_DIR: path.join(t1Dir, "state") }, encoding: "utf8" });
  }
  const mig = spawnSync(process.execPath, [tsx, "scripts/migrate-to-vault.ts", t1.mint, "--execute", "--ignore-owed"], { env: envFor(cfgB), encoding: "utf8" });
  console.log(mig.stdout.split("\n").filter(Boolean).slice(-6).map((l) => "    " + l.slice(0, 150)).join("\n"));
  if (mig.status !== 0) throw new Error("migration failed:\n" + mig.stderr.slice(-800));
  const auth1 = PublicKey.findProgramAddressSync([Buffer.from("auth"), new PublicKey(t1.mint).toBuffer()], new PublicKey(PROGRAM))[0];
  assert.equal(await withdrawAuthority(t1.mint), auth1.toBase58(), "T1 now withdraws to the vault");
  ok("T1 migrated: withdraw authority handed from the distributor to the vault");
  await stopServer(); await startServer(cfgB); // pick up the migrated record
  await trade(t1.mint, t1.rec.pool);

  console.log("4. The site's crank runs the vault cycle for both tokens");
  const before = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
  const t0 = Date.now();
  const paid = async (mint: string) => (await api(`/api/vault/${mint}`).catch(() => null)) as any;
  let v1: any = null, v2: any = null;
  while (Date.now() - t0 < 480_000) {
    [v1, v2] = await Promise.all([paid(t1.mint), paid(t2.mint)]);
    const done = (v: any) => v && BigInt(v.state?.holdersPaid ?? 0) > 0n;
    if (done(v1) && done(v2)) break;
    await sleep(10_000);
  }
  ok(`after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  for (const [name, v, mint] of [["T1 (migrated)", v1, t1.mint], ["T2 (new)", v2, t2.mint]] as const) {
    const s = v?.state ?? {};
    console.log(`    ${name}: holders funded ${xnt(BigInt(s.holdersFunded ?? 0))} XNT, paid ${xnt(BigInt(s.holdersPaid ?? 0))} XNT, list epoch ${s.list?.epoch ?? "-"}`);
    assert.ok(BigInt(s.holdersPaid ?? 0) > 0n, `${name}: holders were paid by the vault`);
    const ev = fs.readFileSync(path.join(dir, "factory", "launches", mint, "state", "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    ok(`${name}: events ${[...new Set(ev.map((e) => e.kind))].join(", ")}`);
    const list = await api(`/api/vault/${mint}/list`);
    ok(`${name}: public rewards list ${list.status}, epoch ${list.epoch}, ${list.wallets?.length ?? 0} wallets`);
    const stats = await api(`/api/token/${mint}/stats`);
    ok(`${name}: site badge ${JSON.stringify(stats.vault ? "Tax enforced by program" : null)}; paid to holders ${xnt(BigInt(stats.holdersXnt ?? 0))} XNT`);
  }
  const after = await Promise.all(traders.map((t) => conn.getBalance(t.publicKey)));
  ok(`traders' XNT change (incl. their own trading): ${after.map((a, i) => xnt(a - before[i])).join(", ")}`);
  console.log("\nVault rehearsal finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error("--- server log (last 40 lines) ---\n" + log.join("").split("\n").slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  await stopServer();
}
