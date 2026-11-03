/**
 * scripts/quorum-action.ts rehearsal, on a LOCAL validator (nothing goes to testnet or mainnet;
 * the one public read is a genesis hash, to prove the wrong-network refusal against the real
 * RPCs). It drives the real script as a subprocess, one member key per run, with the real site
 * crank and the real co-signer running, against either Squads deployment:
 *
 *   S. A vault token launched through the site; scripts/setup-publisher-quorum.ts makes a 2-of-3
 *      multisig (site, co-signer, backup) its publisher.
 *   A. Site proposes a memo, the co-signer rejects it, site + backup approve and execute: the
 *      vault PDA signed and nothing moved. Vote orders against the cutoff (2 rejections).
 *   I. Interactions: a list the site proposed stays tracked while a set_publisher is open; it
 *      can be approved and published meanwhile; the site ignores indexes it didn't create.
 *   C. Refusals against the real program: wrong network, non-member, wrong
 *      --expect-new-publisher, unknown shape, before threshold, double execution, dry runs.
 *   B. The undo: site + backup set_publisher to a generated key with the co-signer running;
 *      that key publishes (scripts/crank.ts --publisher). It hands back to the multisig, and a
 *      second undo to the site's own key with a list open: the site drops the list and
 *      publishes directly without a restart. The stranded proposal can't execute.
 *      The guardian's appoint_publisher is simulated, not relied on.
 *
 * Generated keys only; a throwaway config based on config.example.json.
 *
 * SQUADS_DEPLOYMENT=testnet (Squads DDL3…) needs:
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9601 --faucet-port 9605 \
 *     --gossip-port 9603 --dynamic-port-range 9610-9640 --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program DDL3Xp6ie85DXgiPkXJ7abUyS2tGv4CGEod2DeQXQ941 \
 *     --clone BUksxAHQ4oudRMuKkmNqS9yhvkTtAYunw7rrdBRm3VEZ --maybe-clone 45bQSp8Xgvavg5fj6PAyqxR2Gd8nUbCFLFcsapmrFcyU \
 *     <XDEX_ARGS> --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW <short-windows v3 tax_vault.so>
 *
 * SQUADS_DEPLOYMENT=mainnet (the binary, program config and treasury of SQDS4…, read from mainnet;
 * XDEX and the rest still come from testnet, because the tax_vault test build is hard-wired to
 * testnet XDEX, so --clone-upgradeable-program can't name two clusters). Copying the program
 * accounts with --account doesn't run: their mainnet deploy slot is ahead of the local chain, so
 * every call fails with ProgramCacheHitMaxLimit. --upgradeable-program loads the same bytes at slot 0:
 *   solana program dump SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf <scratch>/squads-mainnet.so --url https://rpc.mainnet.x1.xyz
 *   for a in BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr 45bQSp8Xgvavg5fj6PAyqxR2Gd8nUbCFLFcsapmrFcyU; do
 *     solana account $a --url https://rpc.mainnet.x1.xyz --output json-compact --output-file <scratch>/$a.json; done
 *   solana-test-validator ...the same first line... \
 *     --upgradeable-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf <scratch>/squads-mainnet.so 2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7 \
 *     --account <each address> <scratch>/<address>.json \
 *     <XDEX_ARGS> --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW <short-windows v3 tax_vault.so>
 *
 * XDEX_ARGS: --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *   --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *   and the other clones listed in scripts/local-vault-v3-test.ts.
 *
 * then: SQUADS_DEPLOYMENT=<testnet|mainnet> LOCAL_RPC=http://127.0.0.1:9601 npx tsx scripts/quorum-action-rehearsal.ts
 * The site runs on port 8171, the IPFS stand-in on 8172, a webhook receiver on 8173.
 * KEEP_DIR=1 keeps the throwaway directory (it holds the drill's generated keys).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as squads from "@sqds/multisig";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { sha256Hex, xntOf } from "../src/quorum-action.js";
import {
  SQUADS_PROGRAM_IDS, approveIx, executeIx, proposeIxs, readProposal, readQuorum, squadsMultisigPda, squadsProgramConfigPda, squadsVaultPda,
} from "../src/squads.js";
import { appointPublisherIx, decodeVault, rawCid, setPublisherIx, vaultPda, type Vault } from "../src/taxvault.js";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9601";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const DEPLOY = process.env.SQUADS_DEPLOYMENT as "testnet" | "mainnet";
assert.ok(DEPLOY === "testnet" || DEPLOY === "mainnet", "set SQUADS_DEPLOYMENT=testnet or mainnet");
const SQUADS = SQUADS_PROGRAM_IDS[DEPLOY];
const OTHER = DEPLOY === "mainnet" ? "testnet" : "mainnet";
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const PORT = 8171, SITE = `http://127.0.0.1:${PORT}`;
const IPFS_PORT = 8172, IPFS = `http://127.0.0.1:${IPFS_PORT}`;
const HOOK_PORT = 8173, HOOK = `http://127.0.0.1:${HOOK_PORT}/alert`;
const JWT = "rehearsal-jwt";
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ok  ${m}`);
const TSX = path.join("node_modules", "tsx", "dist", "cli.mjs");

// ---------- a local stand-in for Pinata's upload API and an IPFS gateway; a webhook receiver ----------
const pinned = new Map<string, Buffer>();
const ipfs = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && req.url === "/v3/files") {
    if (req.headers.authorization !== `Bearer ${JWT}`) { res.writeHead(401).end("{}"); return; }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const cid = rawCid(bytes);
    pinned.set(cid, bytes);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { cid } }));
    return;
  }
  const g = /^\/ipfs\/(\w+)$/.exec(req.url ?? "");
  if (req.method === "GET" && g && pinned.has(g[1])) { res.writeHead(200).end(pinned.get(g[1])); return; }
  res.writeHead(404).end("not found");
});
await new Promise<void>((r) => ipfs.listen(IPFS_PORT, "127.0.0.1", r));
const alerts: string[] = [];
const hook = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { alerts.push(JSON.parse(Buffer.concat(chunks).toString()).text); } catch { /* ignore */ }
  res.writeHead(200).end("ok");
});
await new Promise<void>((r) => hook.listen(HOOK_PORT, "127.0.0.1", r));

// ---------- throwaway setup ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-action-rehearsal-"));
const payer = Keypair.generate(), site = Keypair.generate(), creator = Keypair.generate();
const cosigner = Keypair.generate(), backup = Keypair.generate(), outsider = Keypair.generate(), single = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
const keyFile = (name: string, k: Keypair, mode = 0o600) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode }); fs.chmodSync(f, mode); return f; };
const F = { payer: keyFile("payer", payer), site: keyFile("site", site), cosigner: keyFile("cosigner", cosigner), backup: keyFile("backup", backup), outsider: keyFile("outsider", outsider), single: keyFile("single", single) };
const createKey = Keypair.generate();
const createKeyFile = keyFile("create-key", createKey);
const MS = squadsMultisigPda(SQUADS, createKey.publicKey), MS_VAULT = squadsVaultPda(SQUADS, MS);

let server: ChildProcess | null = null, bg: ChildProcess | null = null;
const log: string[] = [];
function siteConfig(feeMint: PublicKey) {
  const base = JSON.parse(fs.readFileSync("config.example.json", "utf8"));
  const cfg = {
    ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
    keypairs: { creator: F.payer, distributor: F.payer },
    distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
    locker: { programId: "5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C", nftUri: "" },
    factory: {
      ...base.factory, port: PORT, publicUrl: SITE, hosts: [], feeReceiver: payer.publicKey.toBase58(),
      pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
      feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
      // The tax_vault test build is hard-wired to testnet XDEX, so the site stays network "testnet"
      // and names the Squads program; quorum-action and the co-signer route by --network.
      taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: F.site,
        quorum: { multisig: MS.toBase58(), programId: SQUADS.toBase58(), labels: { [cosigner.publicKey.toBase58()]: "co-signer", [backup.publicKey.toBase58()]: "backup" } } },
    },
  };
  delete cfg.creatorReward;
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return file;
}
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const cleanEnv = () => { const e: NodeJS.ProcessEnv = { ...process.env, PINATA_JWT: "" }; delete e.REFLECT_RPC_URL; delete e.REFLECT_CONFIG; return e; };
async function startServer(cfgFile: string) {
  server = spawn(process.execPath, [TSX, "src/factory-server.ts"], {
    env: { ...process.env, REFLECT_CONFIG: cfgFile, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC,
      TAX_VAULT_SHORT_WINDOWS: "1", PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "", TAX_VAULT_PASS_SECS: "6" },
    stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
}
async function stopChild(c: ChildProcess | null) { if (!c || c.exitCode !== null) return; c.kill(); await new Promise((r) => c.once("exit", r)); }
process.on("exit", () => { server?.kill(); bg?.kill(); });

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
async function launch(c: Keypair) {
  const params = { name: "Quorum Action Drill", symbol: "QAD", image: "", description: "quorum action drill", supply: "1000000", poolTokens: "1000000", poolXnt: "10",
    taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: c.publicKey.toBase58() };
  const { mint } = await step("/api/launch/token", params, c);
  await step("/api/launch/pool", { mint, creator: params.creator }, c);
  await step("/api/launch/lock", { mint, creator: params.creator }, c);
  await step("/api/launch/vault", { mint, creator: params.creator }, c);
  await api("/api/launch/register", { mint, creator: params.creator });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
  return { mint: mint as string, pool: rec.pool as string };
}
async function trade(mint: string, pool: string, rounds = 1) {
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
const readVault = async (mint: string): Promise<Vault> => {
  const addr = vaultPda(PROGRAM, new PublicKey(mint));
  return decodeVault(addr, (await conn.getAccountInfo(addr, "confirmed"))!.data);
};
const listFile = (mint: string) => JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "state", "vault-list.json"), "utf8"));
async function waitFor(what: string, test: () => Promise<boolean>, ms = 300_000, every = 2_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; } await sleep(every); }
  throw new Error(`timed out waiting for: ${what}`);
}
async function untilChainTime(unix: number, what: string) {
  for (;;) {
    const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
    if (t && t >= unix) break;
    await sleep(1_000);
  }
  ok(`chain time past ${what}`);
}
async function tryTx(ixs: TransactionInstruction[], signer: Keypair) {
  try { await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [signer]); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const squadsErr = (e: string) => /custom program error: 0x([0-9a-f]+)/i.exec(e) ? squads.generated.errorFromCode(parseInt(/custom program error: 0x([0-9a-f]+)/i.exec(e)![1], 16))?.name ?? e.slice(0, 100) : e.slice(0, 100);

// ---------- running repo scripts as their operators would ----------
async function script(file: string, args: string[], o: { expectCode?: number; quiet?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, [TSX, file, ...args], { env: { ...cleanEnv(), ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  clearTimeout(timer);
  if (!o.quiet) for (const l of out.trimEnd().split("\n")) console.log(`      | ${l}`);
  if (o.expectCode !== undefined) assert.equal(code, o.expectCode, `${file} ${args.join(" ")} exited with ${code}:\n${out}`);
  return { out, code };
}
const NET = ["--network", DEPLOY, "--allow-local-rpc", "--rpc", RPC];
const MSA = ["--multisig", MS.toBase58()];
const costs: { step: string; signature: string; row: string }[] = [];
/** Read right away: a local validator's small ledger drops old transactions during a long run. */
async function costRow(signature: string) {
  for (let i = 0; i < 5; i++) {
    const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) { const change = t.meta.preBalances[0] - t.meta.postBalances[0]; return `${t.meta.fee} | ${t.meta.computeUnitsConsumed ?? "?"} | ${change} | ${change - t.meta.fee}`; }
    await sleep(500);
  }
  return "not readable";
}
/** The real tool; expects it to work (exit 0) and files its signature for the cost table. */
async function qa(label: string, sub: string, key: string | null, args: string[], o: { quiet?: boolean } = {}) {
  let r = await script("scripts/quorum-action.ts", [sub, ...NET, ...MSA, ...(key ? ["--keypair", key] : []), ...args], { quiet: true });
  // The running site can take the next index first: the tool says so, and its operator runs it again.
  for (let i = 0; i < 3 && r.code === 1 && /another proposal took #/.test(r.out); i++) {
    ok(`${label}: the site took the index first, and the tool said so; running it again`);
    r = await script("scripts/quorum-action.ts", [sub, ...NET, ...MSA, ...(key ? ["--keypair", key] : []), ...args], { quiet: true });
  }
  if (!o.quiet) for (const l of r.out.trimEnd().split("\n")) console.log(`      | ${l}`);
  assert.equal(r.code, 0, `${sub} ${args.join(" ")} exited with ${r.code}:\n${r.out}`);
  const sig = /signature (\w{60,})/.exec(r.out)?.[1];
  if (sig && args.includes("--execute")) costs.push({ step: label, signature: sig, row: await costRow(sig) });
  return r.out;
}
/** The real tool refusing: exit code 1, with `re` in its output and nothing sent. */
async function qaRefused(what: string, sub: string, key: string | null, args: string[], re: RegExp, net = NET) {
  const before = await snapshot();
  const r = await script("scripts/quorum-action.ts", [sub, ...net, ...MSA, ...(key ? ["--keypair", key] : []), ...args], { quiet: true });
  assert.equal(r.code, 1, `${what} should be refused:\n${r.out}`);
  assert.match(r.out, re, what);
  assert.deepEqual(await snapshot(), before, `${what}: nothing changed`);
  ok(`refused: ${what}: ${(/REFUSED: (.*)/.exec(r.out)?.[1] ?? r.out.trim().split("\n").at(-1) ?? "").slice(0, 120)}`);
  return r.out;
}
/**
 * What a dry run or a refusal must leave alone. With the site and co-signer stopped (`quiet`)
 * that's the transaction index and every key's balance; while they run they spend and propose
 * on their own, so only the keys nothing else uses.
 */
let quiet = false;
async function snapshot() {
  const keys = [backup.publicKey, outsider.publicKey, MS_VAULT];
  if (quiet) keys.push(site.publicKey, cosigner.publicKey, single.publicKey);
  const bal = await Promise.all(keys.map((k) => conn.getBalance(k, "confirmed")));
  return { index: quiet ? (await readQuorum(conn, SQUADS, MS))?.transactionIndex.toString() : "not compared while the site runs", balances: bal };
}
const indexIn = (out: string) => { const m = /proposal #(\d+):/.exec(out); assert.ok(m, "the tool names the proposal"); return BigInt(m![1]); };
const startCosigner = () => {
  const child = spawn(process.execPath, [TSX, "scripts/cosigner.ts", "--rpc", RPC, "--keypair", F.cosigner, "--multisig", MS.toBase58(), "--network", DEPLOY, "--program", PROGRAM.toBase58(),
    "--ipfs-gateway", `${IPFS}/ipfs/`, "--webhook", HOOK, "--loop", "3", "--max-moved-bps", "100"], { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d) => log.push(`[co-signer] ${d}`)); child.stderr!.on("data", (d) => log.push(`[co-signer] ${d}`));
  bg = child;
  return child;
};
const twoPasses = () => sleep(14_000);
const prop = (i: bigint) => readProposal(conn, SQUADS, MS, i);

try {
  console.log(`Squads deployment: ${DEPLOY} ${SQUADS.toBase58()} on the local validator ${RPC}`);
  // ---------- what the validator really holds ----------
  {
    const p = await conn.getAccountInfo(SQUADS);
    assert.ok(p?.executable, `${SQUADS.toBase58()} is on the validator`);
    const dataAddr = new PublicKey(p!.data.subarray(4, 36));
    const pd = (await conn.getAccountInfo(dataAddr))!;
    const bin = pd.data.subarray(45);
    let end = bin.length; while (end > 0 && bin[end - 1] === 0) end--;
    const authority = pd.data[12] ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : "none";
    const cfg = await conn.getAccountInfo(squadsProgramConfigPda(SQUADS));
    assert.ok(cfg, "the program config is on the validator");
    const [c] = squads.accounts.ProgramConfig.fromAccountInfo(cfg!);
    const treasury = await conn.getAccountInfo(c.treasury);
    console.log(`  program data ${dataAddr.toBase58()}, ${end} bytes, sha256 ${crypto.createHash("sha256").update(bin.subarray(0, end)).digest("hex")}, upgrade authority ${authority}`);
    console.log(`  program config ${squadsProgramConfigPda(SQUADS).toBase58()}: authority ${c.authority.toBase58()}, multisig creation fee ${String(c.multisigCreationFee)}, treasury ${c.treasury.toBase58()} (${treasury ? `${treasury.lamports} lamports` : "not on the validator"})`);
    if (DEPLOY === "mainnet") assert.equal(authority, "2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7", "the mainnet program's own program data was cloned");
  }

  console.log("\nS. A vault token through the site; scripts/setup-publisher-quorum.ts makes the 2-of-3 its publisher");
  for (const k of [payer, creator, ...traders]) await fund(k.publicKey, 80);
  for (const k of [site, cosigner, backup, single]) await fund(k.publicKey, 5);
  await fund(outsider.publicKey, 1);
  const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
  {
    const ata = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
    await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, creator.publicKey, feeMint)), [payer]);
    await mintTo(conn, payer, feeMint, ata, payer, 5_000_000);
  }
  const cfgFile = siteConfig(feeMint);
  await startServer(cfgFile);
  const t1 = await launch(creator);
  const mint = t1.mint;
  await trade(mint, t1.pool, 2);
  await waitFor("the site published a list with its own key and paid holders", async () => (await readVault(mint)).holdersPaid > 0n);
  const setupArgs = ["--rpc", RPC, "--network", DEPLOY, "--keypair", F.payer, "--create-key", createKeyFile, "--site", site.publicKey.toBase58(), "--cosigner", cosigner.publicKey.toBase58(),
    "--backup", backup.publicKey.toBase58(), "--mint", mint, "--publisher", F.site, "--program", PROGRAM.toBase58()];
  const balPayer0 = await conn.getBalance(payer.publicKey, "confirmed");
  await script("scripts/setup-publisher-quorum.ts", [...setupArgs, "--execute"], { expectCode: 0 });
  const balPayer1 = await conn.getBalance(payer.publicKey, "confirmed");
  ok(`setup-publisher-quorum --network ${DEPLOY}: payer spent ${xntOf(balPayer0 - balPayer1)} XNT (multisig rent + fees)`);
  {
    const q = (await readQuorum(conn, SQUADS, MS))!;
    assert.equal(q.threshold, 2); assert.equal(q.voters, 3); assert.equal(q.configAuthority, null); assert.equal(q.timeLock, 0);
    assert.ok((await readVault(mint)).publisher.equals(MS_VAULT));
    ok(`multisig ${MS.toBase58()} under ${SQUADS.toBase58()}; publisher = its vault ${MS_VAULT.toBase58()}`);
  }
  const statusOut = await qa("status", "status", null, []);
  assert.match(statusOut, /threshold 2 of 3 voters \(rejections that close a proposal: 2\)/);
  startCosigner();

  console.log("\nA. Site proposes a memo; the co-signer rejects; site + backup approve and execute");
  const memoText = `quorum check ${DEPLOY}`;
  const memoHash = sha256Hex(memoText);
  let memoIndex: bigint;
  {
    const before = await snapshot();
    const dry = await qa("propose-memo dry run", "propose-memo", F.backup, ["--text", memoText], { quiet: true });
    assert.match(dry, /DRY RUN/); assert.match(dry, /simulation OK/); assert.match(dry, /expected fee/);
    assert.deepEqual(await snapshot(), before, "the dry run moved nothing");
    ok("propose-memo dry run: simulated, its key's balance unchanged (section C checks the index too, with the site stopped)");
    const out = await qa("propose memo", "propose-memo", F.site, ["--text", memoText, "--execute"]);
    memoIndex = indexIn(out);
    const hooks0 = alerts.length;
    await waitFor(`the co-signer rejected #${memoIndex}`, async () => (await prop(memoIndex))?.rejected.includes(cosigner.publicKey.toBase58()) === true, 60_000);
    await waitFor("its rejection reached the webhook", async () => alerts.slice(hooks0).concat(alerts).some((a) => a.includes(`REJECT #${memoIndex}`)), 20_000);
    await twoPasses();
    let p = (await prop(memoIndex))!;
    assert.equal(p.status, "Active"); assert.deepEqual(p.approved, [site.publicKey.toBase58()]); assert.deepEqual(p.rejected, [cosigner.publicKey.toBase58()]);
    ok("two site passes later: Active, 1 approval (proposer), 1 rejection. The site neither executed it nor added a rejection");
    const shown = await qa("status", "status", null, ["--index", memoIndex.toString()], { quiet: true });
    assert.match(shown, new RegExp(`text "${memoText}"`)); assert.match(shown, /reject memo from/); assert.match(shown, /needs 1 more approval/);
    ok("status decodes the memo and shows the co-signer's reason");
    await qa("backup approves memo", "approve", F.backup, ["--index", memoIndex.toString(), "--expect-memo-hash", memoHash, "--execute"]);
    p = (await prop(memoIndex))!;
    assert.equal(p.status, "Approved");
    ok("backup's approval reached the threshold despite the co-signer's earlier rejection (1 rejection is under the cutoff of 2)");
    await twoPasses();
    assert.equal((await prop(memoIndex))!.status, "Approved");
    ok("two site passes later still Approved: the site executes only what it tracks");
    const vaultBefore = await conn.getBalance(MS_VAULT, "confirmed");
    const exOut = await qa("backup executes memo", "execute", F.backup, ["--index", memoIndex.toString(), "--expect-memo-hash", memoHash, "--execute"]);
    assert.match(exOut, /the vault PDA signed/);
    assert.equal((await prop(memoIndex))!.status, "Executed");
    const sig = costs.at(-1)!.signature;
    const tx = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!;
    assert.ok(tx.meta!.logMessages!.some((l) => l.includes(`Signed by ${MS_VAULT.toBase58()}`)), "the memo program saw the vault PDA's signature");
    tx.meta!.postBalances.forEach((b, i) => {
      const moved = b - tx.meta!.preBalances[i];
      if (i === 0) assert.equal(moved, -tx.meta!.fee, "the fee payer paid the fee and nothing else");
      else assert.equal(moved, 0, `account ${i} moved nothing`);
    });
    assert.equal(await conn.getBalance(MS_VAULT, "confirmed"), vaultBefore);
    assert.ok(tx.meta!.postTokenBalances!.length === 0, "no token balances touched");
    ok(`executed: the memo program logged "Signed by ${MS_VAULT.toBase58().slice(0, 8)}…"; every account but the fee payer's fee unchanged`);
  }
  // Vote orders. The proposer's approval lands with the proposal, so the co-signer can't truly vote first.
  {
    const out = await qa("backup proposes memo (reject order)", "propose-memo", F.backup, ["--text", "order one", "--execute"], { quiet: true });
    const i = indexIn(out);
    await waitFor(`the co-signer rejected #${i}`, async () => (await prop(i))?.rejected.includes(cosigner.publicKey.toBase58()) === true, 60_000);
    await qa("site rejects", "reject", F.site, ["--index", i.toString(), "--memo", "not needed", "--execute"], { quiet: true });
    const p = (await prop(i))!;
    assert.equal(p.status, "Rejected");
    assert.equal(p.rejected.length, 2);
    ok(`co-signer + site rejections = the cutoff (voters 3 - threshold 2 + 1 = 2): #${i} Rejected with the backup's approval standing`);
    await qaRefused(`approving a Rejected proposal`, "approve", F.site, ["--index", i.toString()], /is Rejected: only an Active/);
    const e = await tryTx([approveIx(SQUADS, MS, i, site.publicKey)], site);
    assert.ok(e); ok(`the program refuses that too: ${squadsErr(e!)}`);
  }

  console.log("\nI. Interactions with the site's list proposals (co-signer stopped so a list stays open)");
  await stopChild(bg); bg = null;
  let listIndex: bigint, keepIndex: bigint;
  {
    await trade(mint, t1.pool, 2);
    await waitFor("the site proposed a list", async () => listFile(mint).next?.proposal?.status === "Active", 300_000);
    const n = listFile(mint).next;
    listIndex = BigInt(n.proposal.index);
    const epoch = BigInt(n.epoch);
    ok(`list ${epoch} proposed as #${listIndex}; memos took earlier indexes, so the site's fresh index skipped them`);
    assert.ok(listIndex > memoIndex);
    const out = await qa("backup proposes set_publisher", "propose-set-publisher", F.backup, ["--mint", mint, "--new-publisher", single.publicKey.toBase58(), "--execute"]);
    keepIndex = indexIn(out);
    assert.match(out, new RegExp(`note: list proposal #${listIndex} is open`));
    await twoPasses();
    assert.equal(listFile(mint).next?.proposal?.index, listIndex.toString(), "the site still tracks its own list");
    assert.equal((await prop(keepIndex))!.approved.length, 1); assert.equal((await prop(keepIndex))!.rejected.length, 0);
    ok(`with set_publisher #${keepIndex} open the site still tracks #${listIndex} and left #${keepIndex} alone`);
    await qaRefused("approving a list without --allow-unknown", "approve", F.backup, ["--index", listIndex.toString()], /doesn't check/);
    const appr = await qa("backup approves list", "approve", F.backup, ["--index", listIndex.toString(), "--allow-unknown", "--execute"], { quiet: true });
    assert.match(appr, /WARNING: --allow-unknown/);
    await waitFor(`the site executed #${listIndex} with set_publisher #${keepIndex} open`, async () => {
      const v = await readVault(mint);
      return v.pendingEpoch === epoch || v.listEpoch === epoch;
    }, 120_000);
    await waitFor("the site marked it published", async () => { const f = listFile(mint); return [f.next, f.active].some((l) => l?.epoch === epoch.toString() && !!l?.publishedAt); }, 60_000);
    assert.equal((await prop(keepIndex))!.status, "Active");
    ok(`a list can be approved and published while a set_publisher is open: #${keepIndex} is untouched and still Active`);
    const q = (await readQuorum(conn, SQUADS, MS))!;
    assert.equal(q.staleTransactionIndex, 0n, "vault transactions don't move the stale index");
    ok("staleTransactionIndex is still 0: executing a vault transaction doesn't stale the others (only config changes do)");
  }
  // A vote flip, and the guardian's route (simulated only).
  {
    const out = await qa("site proposes memo (flip)", "propose-memo", F.site, ["--text", "flip", "--execute"], { quiet: true });
    const i = indexIn(out);
    await qa("backup rejects", "reject", F.backup, ["--index", i.toString(), "--execute"], { quiet: true });
    assert.equal((await prop(i))!.status, "Active");
    await qa("backup changes to approve", "approve", F.backup, ["--index", i.toString(), "--execute"], { quiet: true });
    const p = (await prop(i))!;
    assert.equal(p.status, "Approved"); assert.equal(p.rejected.length, 0);
    ok(`a member can change its vote while Active: backup's rejection became an approval, #${i} Approved`);
    const v = await readVault(mint);
    await untilChainTime(v.lastPublishAt + 16, "last_publish_at + 15 s (short-windows build)");
    const { blockhash } = await conn.getLatestBlockhash();
    const sim = await conn.simulateTransaction(new Transaction({ feePayer: creator.publicKey, recentBlockhash: blockhash }).add(appointPublisherIx(PROGRAM, creator.publicKey, new PublicKey(mint), creator.publicKey)));
    assert.equal(sim.value.err, null, "appoint_publisher is allowed");
    ok("guardian route: appoint_publisher simulates OK after the window (not sent, not relied on)");
  }

  // The co-signer offline: the backup's key can run the co-signer's own checks once, instead of --allow-unknown.
  {
    await trade(mint, t1.pool, 2);
    await waitFor("the site proposed another list", async () => listFile(mint).next?.proposal?.status === "Active", 300_000);
    const n = listFile(mint).next;
    const r = await script("scripts/cosigner.ts", ["--rpc", RPC, "--keypair", F.backup, "--multisig", MS.toBase58(), "--network", DEPLOY, "--program", PROGRAM.toBase58(),
      "--ipfs-gateway", `${IPFS}/ipfs/`, "--once", "--max-moved-bps", "100"], { expectCode: 0, quiet: true });
    assert.match(r.out, new RegExp(`#${n.proposal.index}: PASS`), r.out);
    await waitFor(`scripts/cosigner.ts --once with the backup's key checked list ${n.epoch}, and it was published`, async () => {
      const v = await readVault(mint);
      return v.pendingEpoch === BigInt(n.epoch) || v.listEpoch === BigInt(n.epoch);
    }, 60_000);
    assert.equal((await prop(keepIndex))!.status, "Active");
    ok(`the backup's checked run left set_publisher #${keepIndex}, which it had already voted on, alone`);
  }

  console.log("\nC. Refusals against the real program (site and co-signer stopped, so the index and every balance can be compared)");
  {
    await stopChild(server); server = null;
    quiet = true;
    const K = keepIndex.toString();
    await qaRefused("--network missing", "status", null, [], /--network testnet\|mainnet is required/, ["--allow-local-rpc", "--rpc", RPC]);
    await qaRefused(`the other deployment (--network ${OTHER})`, "status", null, [], new RegExp(`isn't a Squads multisig of ${SQUADS_PROGRAM_IDS[OTHER].toBase58()}`), ["--network", OTHER, "--allow-local-rpc", "--rpc", RPC]);
    await qaRefused("a local validator without --allow-local-rpc", "status", null, [], /a local validator needs --allow-local-rpc/, ["--network", DEPLOY, "--rpc", RPC]);
    await qaRefused("--allow-local-rpc with a public URL", "status", null, [], /only for a validator on this machine/, ["--network", "mainnet", "--allow-local-rpc", "--rpc", "https://rpc.mainnet.x1.xyz"]);
    await qaRefused("--network mainnet at the real testnet RPC (a public genesis read)", "status", null, [], /is X1 testnet/, ["--network", "mainnet", "--rpc", "https://rpc.testnet.x1.xyz"]);
    await sleep(500);
    await qaRefused("--network testnet at the real mainnet RPC (a public genesis read)", "status", null, [], /is X1 mainnet/, ["--network", "testnet", "--rpc", "https://rpc.mainnet.x1.xyz"]);

    await qaRefused("non-member propose", "propose-memo", F.outsider, [], /isn't a member/);
    await qaRefused("non-member approve", "approve", F.outsider, ["--index", K], /isn't a member/);
    await qaRefused("non-member execute", "execute", F.outsider, ["--index", K], /isn't a member/);
    await qaRefused("co-signer has no Initiate", "propose-memo", F.cosigner, [], /no initiate/);
    {
      const e = await tryTx([approveIx(SQUADS, MS, keepIndex, outsider.publicKey)], outsider);
      assert.ok(e); ok(`the program refuses a non-member's vote too: ${squadsErr(e!)}`);
      const q = (await readQuorum(conn, SQUADS, MS))!;
      const e2 = await tryTx(proposeIxs(SQUADS, MS, q.transactionIndex + 1n, cosigner.publicKey, setPublisherIx(PROGRAM, MS_VAULT, new PublicKey(mint), cosigner.publicKey)), cosigner);
      assert.ok(e2); ok(`and the co-signer's proposal: ${squadsErr(e2!)}`);
    }
    {
      const loose = keyFile("loose", site, 0o640);
      await qaRefused("a group-readable key file", "approve", loose, ["--index", K], /readable by group or others/);
    }

    await qaRefused("set_publisher without --expect-new-publisher", "approve", F.site, ["--index", K], /restate the new publisher/);
    await qaRefused("wrong --expect-new-publisher", "approve", F.site, ["--index", K, "--expect-new-publisher", outsider.publicKey.toBase58()], /stored instruction sets/);
    await qaRefused("--expect-mint of another mint", "approve", F.site, ["--index", K, "--expect-new-publisher", single.publicKey.toBase58(), "--expect-mint", feeMint.toBase58()], /--expect-mint/);
    await qaRefused("--expect-memo-hash on a set_publisher", "approve", F.site, ["--index", K, "--expect-memo-hash", memoHash], /not a memo/);

    await qaRefused("new publisher = the multisig", "propose-set-publisher", F.site, ["--mint", mint, "--new-publisher", MS.toBase58()], /is the multisig account/);
    await qaRefused("new publisher = the current publisher", "propose-set-publisher", F.site, ["--mint", mint, "--new-publisher", MS_VAULT.toBase58()], /already the vault's publisher/);
    await qaRefused("new publisher = another multisig's vault PDA", "propose-set-publisher", F.site, ["--mint", mint, "--new-publisher", squadsVaultPda(SQUADS, Keypair.generate().publicKey).toBase58()], /off-curve/);
    await qaRefused("--squads-program without --allow-local-rpc", "status", null, ["--squads-program", SQUADS.toBase58()], /only for a local validator/, ["--network", "mainnet", "--rpc", "https://rpc.mainnet.x1.xyz"]);

    // Unknown shape: stored directly with the site's key, as a stolen key could.
    await fund(MS_VAULT, 1);
    const q = (await readQuorum(conn, SQUADS, MS))!;
    const u = q.transactionIndex + 1n;
    const err = await tryTx(proposeIxs(SQUADS, MS, u, site.publicKey, SystemProgram.transfer({ fromPubkey: MS_VAULT, toPubkey: outsider.publicKey, lamports: 500_000_000 })), site);
    assert.equal(err, null);
    const refused = await qaRefused("approving a transfer out of the vault (unknown shape)", "approve", F.backup, ["--index", u.toString()], /isn't one of the two known shapes/);
    assert.match(refused, /11111111111111111111111111111111/, "the stored program is printed");
    // Past the threshold, voted around the tool: the tool still won't execute it. (A member using anything else could.)
    {
      const e = await tryTx([approveIx(SQUADS, MS, u, backup.publicKey)], backup);
      assert.equal(e, null);
      assert.equal((await prop(u))!.status, "Approved");
      await qaRefused("executing it, Approved by votes outside the tool (unknown shape)", "execute", F.cosigner, ["--index", u.toString()], /isn't one of the two known shapes/);
    }
    {
      const before = await snapshot();
      const dry = await qa("execute unknown dry run", "execute", F.cosigner, ["--index", u.toString(), "--allow-unknown"], { quiet: true });
      assert.match(dry, /WARNING: --allow-unknown/); assert.match(dry, /nothing was sent/);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await prop(u))!.status, "Approved");
      ok("--allow-unknown in a dry run: a loud warning, the simulation, nothing sent, the vault PDA's 1 XNT still there");
    }

    await qaRefused("executing before the threshold (the tool)", "execute", F.site, ["--index", K, "--expect-new-publisher", single.publicKey.toBase58()], /is Active, not Approved: 1 of 2/);
    {
      const e = await tryTx([await executeIx(conn, SQUADS, MS, keepIndex, site.publicKey)], site);
      assert.ok(e); ok(`the program refuses it too: ${squadsErr(e!)}`);
      assert.ok((await readVault(mint)).publisher.equals(MS_VAULT));
    }
    await qaRefused("double execution (the tool)", "execute", F.site, ["--index", memoIndex.toString()], /already executed/);
    {
      const e = await tryTx([await executeIx(conn, SQUADS, MS, memoIndex, site.publicKey)], site);
      assert.ok(e); ok(`the program refuses it too: ${squadsErr(e!)}`);
    }

    // Dry runs of every subcommand, on what's open now.
    const before = await snapshot();
    const votesOf = async () => { const p = (await prop(keepIndex))!; return [p.status, p.approved, p.rejected]; };
    const pBefore = await votesOf();
    for (const [sub, key, args] of [
      ["propose-memo", F.site, []],
      ["propose-set-publisher", F.backup, ["--mint", mint, "--new-publisher", single.publicKey.toBase58()]],
      ["approve", F.site, ["--index", K, "--expect-new-publisher", single.publicKey.toBase58()]],
      ["reject", F.site, ["--index", K]],
    ] as [string, string, string[]][]) {
      const o = await qa(`${sub} dry run`, sub, key, args, { quiet: true });
      assert.match(o, /DRY RUN/); assert.match(o, /nothing was sent/); assert.match(o, /simulated balance change/);
    }
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await votesOf(), pBefore);
    ok("dry runs of propose-memo, propose-set-publisher, approve and reject: index, votes and balances unchanged");
    quiet = false;
    await startServer(cfgFile);
  }

  console.log("\nB. The undo: site + backup set_publisher to a generated key, co-signer running");
  {
    const K = keepIndex.toString(), expect = ["--expect-new-publisher", single.publicKey.toBase58(), "--expect-mint", mint];
    startCosigner();
    const hooks0 = alerts.length;
    await waitFor(`the co-signer rejected set_publisher #${K}`, async () => (await prop(keepIndex))?.rejected.includes(cosigner.publicKey.toBase58()) === true, 60_000);
    await waitFor("its alert reached the webhook", async () => alerts.slice(hooks0).concat(alerts).some((a) => a.includes(`REJECT #${K}`)), 20_000);
    const approved = await qa("site approves set_publisher", "approve", F.site, ["--index", K, ...expect, "--execute"]);
    assert.match(approved, /threshold met/);
    assert.equal((await prop(keepIndex))!.status, "Approved");
    ok("site + backup reached the threshold with the co-signer's rejection standing");
    const dry = await qa("execute dry run", "execute", F.site, ["--index", K, ...expect], { quiet: true });
    assert.match(dry, /DRY RUN/); assert.ok((await readVault(mint)).publisher.equals(MS_VAULT), "the dry run changed nothing");
    const out = await qa("site executes set_publisher", "execute", F.site, ["--index", K, ...expect, "--execute"]);
    assert.match(out, new RegExp(`CONFIRMED: the publisher is now ${single.publicKey.toBase58()}`));
    const v = await readVault(mint);
    assert.ok(v.publisher.equals(single.publicKey));
    ok(`the vault's publisher reads back ${single.publicKey.toBase58()}`);
    await qaRefused("executing the set_publisher again", "execute", F.site, ["--index", K, ...expect], /already executed/);

    await waitFor("the site says it no longer publishes for this vault", async () => {
      const b = await api(`/api/vault/${mint}?t=${Date.now()}`);
      return b.sitePublishes === false || /not this site/.test(JSON.stringify(b.crank?.lastPass?.notes ?? []));
    }, 60_000);
    const before = await readVault(mint);
    await trade(mint, t1.pool, 2);
    await waitFor("new holder XNT to allocate", async () => {
      const w = await readVault(mint);
      return w.holdersFunded > before.holdersFunded && w.pendingEpoch === 0n;
    }, 180_000);
    // The generated key publishes, as scripts/appoint-publisher.ts tells an appointed publisher to.
    const crankArgs = ["--rpc", RPC, "--keypair", F.single, "--publisher", F.single, "--mint", mint, "--program", PROGRAM.toBase58(), "--network", "testnet", "--ipfs-gateway", `${IPFS}/ipfs/`, "--pinata-api", `${IPFS}/v3/files`];
    let published = false;
    for (let i = 0; i < 6 && !published; i++) {
      await script("scripts/crank.ts", crankArgs, { env: { PINATA_JWT: JWT, TAX_VAULT_SHORT_WINDOWS: "1" }, quiet: i > 0 });
      const w = await readVault(mint);
      published = w.pendingEpoch > before.listEpoch || w.listEpoch > before.listEpoch;
      if (!published) await sleep(4_000);
    }
    assert.ok(published, "the generated key published a list");
    ok("the generated key published a list with scripts/crank.ts --publisher");
    assert.equal((await prop(keepIndex))!.status, "Executed");
    await stopChild(bg); bg = null;
    ok("co-signer stopped: nothing left for it to check");

    // Back to the quorum, then a second undo to the site's own key with a list open.
    const w = await readVault(mint);
    await untilChainTime(w.pendingActiveAt + 7, "the generated key's list is due");
    const err = await tryTx([setPublisherIx(PROGRAM, single.publicKey, new PublicKey(mint), MS_VAULT)], single);
    assert.equal(err, null, err ?? "");
    assert.ok((await readVault(mint)).publisher.equals(MS_VAULT));
    ok("the generated key handed the publisher back to the multisig's vault PDA");
    await trade(mint, t1.pool, 2);
    await waitFor("the site proposes through the quorum again, without a restart", async () => listFile(mint).next?.proposal?.status === "Active", 300_000);
    const openIndex = BigInt(listFile(mint).next.proposal.index);
    const openEpoch = listFile(mint).next.epoch;
    const out2 = await qa("site proposes set_publisher (back to itself)", "propose-set-publisher", F.site, ["--mint", mint, "--new-publisher", site.publicKey.toBase58(), "--execute"], { quiet: true });
    const second = indexIn(out2);
    const expect2 = ["--expect-new-publisher", site.publicKey.toBase58()];
    await qa("backup approves set_publisher", "approve", F.backup, ["--index", second.toString(), ...expect2, "--execute"], { quiet: true });
    await qa("backup executes set_publisher", "execute", F.backup, ["--index", second.toString(), ...expect2, "--execute"], { quiet: true });
    assert.ok((await readVault(mint)).publisher.equals(site.publicKey));
    ok(`second undo: the publisher is the site's key, with list #${openIndex} still open`);
    await waitFor("the site dropped its tracked list", async () => listFile(mint).history.some((h: { event: string; proposal?: string; reason?: string }) => h.event === "dropped" && h.proposal === openIndex.toString() && /no longer this multisig/.test(h.reason ?? "")), 60_000);
    assert.equal((await prop(openIndex))!.status, "Active");
    ok(`the site's history: list ${openEpoch} dropped ("the vault's publisher is no longer this multisig"); #${openIndex} left Active on-chain`);
    await qa("backup approves the stranded list", "approve", F.backup, ["--index", openIndex.toString(), "--allow-unknown", "--execute"], { quiet: true });
    assert.equal((await prop(openIndex))!.status, "Approved");
    const r = await script("scripts/quorum-action.ts", ["execute", ...NET, ...MSA, "--keypair", F.backup, "--index", openIndex.toString(), "--allow-unknown"], { quiet: true });
    assert.equal(r.code, 1); assert.match(r.out, /simulation FAILED: tax_vault: NotPublisher/);
    const e = await tryTx([await executeIx(conn, SQUADS, MS, openIndex, backup.publicKey)], backup);
    assert.ok(e);
    assert.equal((await prop(openIndex))!.status, "Approved");
    ok("the stranded list reached Approved but can't execute: simulation says tax_vault NotPublisher, the program refuses it, and it stays Approved");
    const beforeDirect = await readVault(mint);
    await trade(mint, t1.pool, 2);
    await waitFor("the site publishes directly with its key, no restart", async () => {
      const x = await readVault(mint);
      const top = x.pendingEpoch > x.listEpoch ? x.pendingEpoch : x.listEpoch;
      const f = listFile(mint);
      const l = [f.next, f.active].find((y) => y?.epoch === top.toString());
      return top > (beforeDirect.pendingEpoch > beforeDirect.listEpoch ? beforeDirect.pendingEpoch : beforeDirect.listEpoch) && !l?.proposal && !!l?.publishedAt;
    }, 300_000);
    const final = await qa("status", "status", null, [], { quiet: true });
    console.log(final.split("\n").filter((l) => l.startsWith("  #") || l.startsWith("  member")).map((l) => `      | ${l}`).join("\n"));
  }

  console.log("\nCosts on this validator (its fee rule, not X1's: X1 bills requested CU; rent is the same formula)");
  console.log("  step | fee (lamports) | CU used | signer's balance change (lamports) | rent = change - fee");
  for (const c of costs) console.log(`  ${c.step} | ${c.row}`);
  console.log(`\nQuorum action drill finished on the ${DEPLOY} Squads deployment.`);
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.stack ?? e.message : e);
  console.error("--- site and co-signer log (last 60 lines) ---\n" + log.join("").split("\n").slice(-60).join("\n"));
  process.exitCode = 1;
} finally {
  await stopChild(bg);
  await stopChild(server);
  ipfs.close(); hook.close();
  if (process.env.KEEP_DIR) console.log(`kept ${dir}`); else fs.rmSync(dir, { recursive: true, force: true });
}
