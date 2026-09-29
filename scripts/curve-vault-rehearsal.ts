/**
 * Bonding curve + Tax Vault (v3) rehearsal on a LOCAL validator (nothing goes to testnet or
 * mainnet): a site with factory.curve and factory.taxVault set up, the real bonding_curve
 * and tax_vault programs, testnet XDEX, lp_locker and the XNM reward pool cloned in.
 *
 *   1. Create a curve token through the site: its withdraw authority is the vault's auth PDA,
 *      no distributor key is written, the launch is flagged taxVault.
 *   2. Buy it to graduation; the site's curve crank graduates, delivers and registers it as
 *      a vault token (pool and lock NFT recorded; the factory distributor leaves it alone).
 *   3. Trade on XDEX: the tax stays withheld in the token accounts. Before the vault exists
 *      the pages say so, "Run the vault now" is refused and only the creator may start it.
 *   4. The creator starts the vault through the site (/api/launch/vault, the "Start the tax
 *      vault" button): publisher = the site's key, guardian = the creator.
 *   5. The site's vault crank collects, sells, funds the creator's XNM reward, publishes a
 *      list (to a local IPFS stand-in) and pays holders; then "Run the vault now" from a
 *      visitor's wallet earns the crank reward. The token and stats pages treat it as a
 *      vault token.
 *
 * Start the validator (3.1.x) with both programs as in scripts/local-curve-test.ts and
 * scripts/local-vault-v3-test.ts (short-windows builds), on this drill's ports:
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9301 --faucet-port 9305 \
 *     --gossip-port 9303 --dynamic-port-range 9310-9340 --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --clone AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ --clone 6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA \
 *     --clone 5GUzsG219nDBZJvS2xN5L8gQr43G9owzMhEL1X3a6soS --clone FQG6rKgbDCBxVxWZimckZpBMedkGC7RqBLXGMQ379sr2 \
 *     --clone 5nwh3vHNEyhGRA2Hc2o24ekTvqVSr7Dm7C3rkPH7GkP --clone CdQJoNNF1UpYekqzaXKekDc5hsrD6zzuZEMQv8hLavfc \
 *     --bpf-program CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY lp-locker/target/curve-test/bonding_curve.so \
 *     --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault3-test/tax_vault.so
 * then:
 *   LOCAL_RPC=http://127.0.0.1:9301 npx tsx scripts/curve-vault-rehearsal.ts
 * The site runs on port 8141, the IPFS stand-in on 8142. KEEP_DIR=1 keeps the throwaway
 * config/factory/state directory (it holds the drill's keypairs).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync, getMint,
  getTransferFeeAmount, getTransferFeeConfig, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";
import { cidFromBytes, decodeVault, rawCid, vaultAuthPda, vaultPda, type Vault } from "../src/taxvault.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9301";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const CURVE = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const TAX_VAULT = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const PORT = 8141, SITE = `http://127.0.0.1:${PORT}`;
const IPFS_PORT = 8142, IPFS = `http://127.0.0.1:${IPFS_PORT}`;
const JWT = "rehearsal-jwt";
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);

// ---------- a local stand-in for Pinata's upload API and an IPFS gateway ----------
const pinned = new Map<string, Buffer>();
const ipfs = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && req.url === "/v3/files") {
    if (req.headers.authorization !== `Bearer ${JWT}`) { res.writeHead(401).end("{}"); return; }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const cid = rawCid(bytes); // a small file is one raw block: its CID is its sha256
    pinned.set(cid, bytes);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { cid } }));
    return;
  }
  const g = /^\/ipfs\/(\w+)$/.exec(req.url ?? "");
  if (req.method === "GET" && g && pinned.has(g[1])) { res.writeHead(200).end(pinned.get(g[1])); return; }
  res.writeHead(404).end("not found");
});
await new Promise<void>((r) => ipfs.listen(IPFS_PORT, "127.0.0.1", r));

// ---------- throwaway config, fee token, crank and publisher keys ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curve-vault-rehearsal-"));
const payer = Keypair.generate(), crank = Keypair.generate(), publisher = Keypair.generate(), creator = Keypair.generate(), visitor = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
for (const k of [payer, creator, ...buyers]) await fund(k.publicKey, 80);
for (const k of [crank, publisher, visitor]) await fund(k.publicKey, 5);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
const creatorFee = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, creatorFee, creator.publicKey, feeMint)), [payer]);
await mintTo(conn, payer, feeMint, creatorFee, payer, 5_000_000);
const keyFile = (name: string, k: Keypair) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined, quoteTokens: undefined, launchesPaused: undefined,
    pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    curve: { programId: CURVE.toBase58(), crankKeypair: keyFile("crank", crank) },
    taxVault: { programId: TAX_VAULT.toBase58(), publisherKeypair: keyFile("publisher", publisher) },
  },
};
delete cfg.creatorReward;
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = {
  ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"),
  REFLECT_RPC_URL: RPC, PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "",
  // The v3 build under test uses short windows; crank passes every 10 s.
  TAX_VAULT_SHORT_WINDOWS: "1", TAX_VAULT_PASS_SECS: "10",
};
const server = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
const log: string[] = [];
server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
process.on("exit", () => server.kill());
for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
/** A fresh (uncached) view: the site serves most GET views stale-while-revalidate. */
const fresh = (p: string) => api(`${p}${p.includes("?") ? "&" : "?"}t=${Date.now()}`);
async function step(p: string, body: Record<string, unknown>, signer: Keypair, extra: Record<string, unknown> = {}) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64"), ...extra });
  return { ...out, signature };
}
async function waitFor(what: string, test: () => Promise<boolean>, ms = 300_000, every = 5_000, between?: () => Promise<unknown>) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await test().catch(() => false)) { ok(`${what} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); return; }
    if (between) await between().catch((e) => console.log(`    (trade skipped: ${String(e.message ?? e).slice(0, 80)})`));
    await sleep(every);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const ata = (mint: string, owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, TOKEN_2022_PROGRAM_ID);
/** XDEX trades by the buyers: each buys with 2 XNT and sells a third of its tokens (both pay the tax). */
async function trade(mint: string, pool: string) {
  for (const t of buyers) {
    const q = await quoteBuy(conn, XDEX, new PublicKey(pool), new PublicKey(mint), 2n * 10n ** 9n, 500);
    await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildBuy(conn, XDEX, t, q))), [t]);
  }
  for (const t of buyers.slice(0, 2)) {
    const bal = (await getAccount(conn, ata(mint, t.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const q = await quoteSell(conn, XDEX, new PublicKey(pool), new PublicKey(mint), bal / 3n, { maxImpactBps: 1000, slippageBps: 500 });
    if (q) await sendAndConfirmTransaction(conn, new Transaction().add(...(await buildSell(conn, XDEX, t, new PublicKey(mint), q))), [t]);
  }
}
const readVault = async (mint: string): Promise<Vault | null> => {
  const addr = vaultPda(TAX_VAULT, new PublicKey(mint));
  const info = await conn.getAccountInfo(addr, "confirmed");
  return info ? decodeVault(addr, info.data) : null;
};
function setMinHarvest(mint: string, value: string) {
  const f = path.join(dir, "factory", "launches", mint, "config.json");
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.distribution.minHarvestXnt = value;
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
}

try {
  console.log("1. Create a curve token through a site with the Tax Vault set up");
  const info = await api("/api/info");
  assert.equal(info.taxVault?.launches, true, "the site makes vault launches");
  ok(`site: curve ${info.curve}, taxVault ${JSON.stringify(info.taxVault)}`);
  const params = { name: "Vault Curve", symbol: "VCRV", image: "", description: "curve + tax vault rehearsal", supply: "1000000000", taxBps: 500,
    autoLpBps: 2500, burnBps: 2500, creator: creator.publicKey.toBase58() };
  const { mint } = await step("/api/curve/create", params, creator);
  const auth = vaultAuthPda(TAX_VAULT, new PublicKey(mint));
  const m = await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(m)!;
  assert.ok(fee.withdrawWithheldAuthority.equals(auth), "withdraw authority = the vault's auth PDA");
  assert.ok(fee.transferFeeConfigAuthority.equals(PublicKey.default), "no fee-config authority");
  assert.equal(m.supply, 0n);
  const launchDir = path.join(dir, "factory", "launches", mint);
  assert.equal(fs.existsSync(path.join(launchDir, "distributor.json")), false, "no distributor key file");
  let rec = JSON.parse(fs.readFileSync(path.join(launchDir, "launch.json"), "utf8"));
  assert.equal(rec.taxVault, true); assert.equal(rec.distributor, auth.toBase58());
  ok(`created ${mint.slice(0, 8)}…: withdraw authority = vault auth PDA ${auth.toBase58().slice(0, 8)}…, no distributor.json, record taxVault: true`);

  console.log("2. Buy to graduation; the site's curve crank graduates, delivers and registers it");
  await sleep(125_000); // the site enforces the real 2-minute anti-snipe window
  for (const [i, amt] of [["0", "3"], ["1", "4"], ["2", "2"]] as const) {
    await step("/api/curve/buy", { wallet: buyers[+i].publicKey.toBase58(), mint, xnt: amt }, buyers[+i], { curveMint: mint });
    ok(`buyer ${i} bought with ${amt} XNT`);
  }
  await step("/api/curve/buy", { wallet: buyers[2].publicKey.toBase58(), mint, xnt: "30" }, buyers[2], { curveMint: mint });
  ok("buyer 2's buy completes the curve");
  await waitFor("graduated, delivered and registered", async () => {
    const v = await api(`/api/curve/${mint}`);
    rec = JSON.parse(fs.readFileSync(path.join(launchDir, "launch.json"), "utf8"));
    return v.statusCode === 4 && !!rec.registeredAt;
  }, 300_000, 5_000);
  assert.equal((await getMint(conn, new PublicKey(mint), "confirmed", TOKEN_2022_PROGRAM_ID)).mintAuthority, null, "mint authority removed");
  assert.ok(rec.lockNft && rec.pool, "pool and lock NFT recorded");
  const tokenCfg = JSON.parse(fs.readFileSync(path.join(launchDir, "config.json"), "utf8"));
  assert.equal(tokenCfg.taxVault, true, "per-launch config says taxVault");
  assert.equal(tokenCfg.creatorReward.nftMint, rec.lockNft);
  assert.ok(log.join("").includes("as a Tax Vault token"), "the crank registered it as a vault token");
  assert.equal(fs.existsSync(path.join(launchDir, "distributor.json")), false);
  ok(`registered as a vault token: pool ${rec.pool.slice(0, 8)}…, lock NFT ${rec.lockNft.slice(0, 8)}… (held by the creator)`);
  assert.equal((await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(rec.lockNft), creator.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount, 1n);
  {
    // The factory distributor (a dry run) finds nothing to serve.
    const out = await new Promise<string>((res) => {
      const p = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/factory-distributor.ts"], { env });
      let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", () => res(o));
    });
    assert.match(out, /: 0 token\(s\)/, out);
    ok("the factory distributor skips it (dry run: 0 tokens)");
  }

  console.log("3. Before the vault: trades pay tax that stays withheld; the pages say who starts the vault");
  await trade(mint, rec.pool);
  const withheld = async () => {
    let sum = 0n;
    for (const b of buyers) sum += getTransferFeeAmount(await getAccount(conn, ata(mint, b.publicKey), "confirmed", TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
    return sum;
  };
  const w0 = await withheld();
  assert.ok(w0 > 0n, "tax withheld in the buyers' accounts");
  ok(`tax withheld in the buyers' token accounts: ${(Number(w0) / 1e9).toLocaleString()} tokens (only the vault's auth PDA can ever withdraw it)`);
  const cv = await api(`/api/curve/${mint}`);
  assert.equal(cv.vault?.exists, false); assert.equal(cv.vault?.creator, creator.publicKey.toBase58());
  const toks = (await fresh("/api/tokens")) as { mint: string }[];
  assert.ok(toks.some((t) => t.mint === mint));
  const listed = ((await fresh("/api/token-list")) as { mint: string; vault?: { exists: boolean } }[]).find((t) => t.mint === mint);
  assert.equal(listed?.vault?.exists, false);
  const mine = ((await fresh(`/api/launches?creator=${creator.publicKey.toBase58()}`)) as { mint: string; status: Record<string, unknown> }[]).find((l) => l.mint === mint)!;
  assert.deepEqual([mine.status.taxVault, mine.status.lock, mine.status.vault], [true, true, false]);
  ok(`curve page, Tokens page and "Your launches": vault not started (creator ${creator.publicKey.toBase58().slice(0, 4)}… gets the button)`);
  await api(`/api/vault/${mint}/crank-tx`, { caller: visitor.publicKey.toBase58() })
    .then(() => assert.fail("crank-tx before the vault"), (e) => { assert.match(e.message, /hasn't been started/); ok(`"Run the vault now" before the vault: "${e.message.split(": ").slice(1).join(": ")}"`); });
  await api("/api/launch/vault", { mint, creator: visitor.publicKey.toBase58() })
    .then(() => assert.fail("a visitor got a start-vault transaction"), (e) => { assert.match(e.message, /another wallet/); ok(`a visitor can't start it: "${e.message.split(": ").slice(1).join(": ")}"`); });

  console.log("4. The creator starts the tax vault through the site");
  const started = await step("/api/launch/vault", { mint, creator: creator.publicKey.toBase58() }, creator, { vaultMint: mint });
  const v0 = (await readVault(mint))!;
  assert.ok(v0, "vault exists");
  assert.ok(v0.publisher.equals(publisher.publicKey) && v0.guardian.equals(creator.publicKey), "publisher = the site's key, guardian = the creator");
  assert.ok(v0.pool.equals(new PublicKey(rec.pool)) && v0.creatorNft.equals(new PublicKey(rec.lockNft)), "the curve's pool and lock NFT");
  assert.deepEqual([v0.burnBps, v0.lpBps, v0.version], [2500, 2500, 3]);
  assert.equal((await api(`/api/curve/${mint}`)).vault?.exists, true, "the curve page shows it at once");
  ok(`vault started (${started.signature.slice(0, 8)}…): v${v0.version}, publisher ${publisher.publicKey.toBase58().slice(0, 4)}…, guardian = creator, split 25/25`);

  console.log("5. The site's vault crank: collect, sell, creator reward (XNM), list, payouts");
  await waitFor("collected, sold, creator funded, a list active and holders paid", async () => {
    const v = (await readVault(mint))!;
    return v.totalCollected > 0n && v.totalRewardOut > 0n && v.listEpoch > 0n && v.holdersPaid > 0n;
  }, 480_000, 10_000, () => trade(mint, rec.pool));
  const v1 = (await readVault(mint))!;
  assert.ok(v1.totalBurned > 0n && v1.totalLpXnt > 0n, "burned and added liquidity");
  assert.ok(!!cidFromBytes(v1.listCid) && pinned.has(cidFromBytes(v1.listCid)!), "the list file is on IPFS");
  ok(`collected ${(Number(v1.totalCollected) / 1e9).toLocaleString()} tokens, burned ${(Number(v1.totalBurned) / 1e9).toLocaleString()}, liquidity ${xnt(v1.totalLpXnt)} XNT, creator ${xnt(v1.totalCreatorXnt)} XNT -> ${Number(v1.totalRewardOut) / 1e9} XNM, holders paid ${xnt(v1.holdersPaid)} XNT (list ${v1.listEpoch}, ${cidFromBytes(v1.listCid)})`);
  const nft = await fresh(`/api/nft/${rec.lockNft}`);
  const rw = nft.rewards;
  assert.equal(rw?.symbol, "XNM");
  assert.ok(BigInt(rw.claimable) + BigInt(rw.vesting) > 0n, "XNM in the lock NFT's vesting vault");
  ok(`lock NFT's creator reward: ${Number(rw.vesting) / 10 ** rw.decimals} XNM vesting, ${Number(rw.claimable) / 10 ** rw.decimals} ready`);
  const stats = await fresh(`/api/token/${mint}/stats`);
  assert.equal(stats.vault?.exists, true);
  const dl = await fresh("/api/distribute/list");
  assert.ok(!dl.tokens.some((t: { mint: string }) => t.mint === mint), "not offered for \"Distribute now\"");
  const lb = await fresh(`/api/leaderboard/${mint}`);
  assert.ok(!JSON.stringify(lb).includes("Old distributor"), "the vault's auth PDA isn't labelled a retired distributor");
  const tl = ((await fresh("/api/token-list")) as { mint: string; holdersXnt: string; vault?: { exists: boolean } }[]).find((t) => t.mint === mint)!;
  assert.equal(tl.vault?.exists, true);
  ok(`stats: vault badge on, paid to holders ${xnt(BigInt(tl.holdersXnt))} XNT on the Tokens page, not in "Distribute now", leaderboard labels right`);

  console.log("6. \"Run the vault now\" from a visitor's wallet");
  {
    setMinHarvest(mint, "1000"); // the site's crank leaves the tax to the visitor meanwhile
    const pass0 = (await fresh(`/api/vault/${mint}`)).crank.lastPass?.at;
    await waitFor("a site crank pass finished", async () => (await fresh(`/api/vault/${mint}`)).crank.lastPass?.at !== pass0, 120_000, 1_000);
    await trade(mint, rec.pool); await trade(mint, rec.pool);
    const plan = await api(`/api/vault/${mint}/crank-tx`, { caller: visitor.publicKey.toBase58() });
    ok(`crank-tx: ${plan.txs.map((t: { kind: string }) => t.kind).join(", ")}; estimated reward ${xnt(BigInt(plan.crankRewardLamports))} XNT`);
    assert.ok(plan.txs.some((t: { kind: string }) => t.kind === "collect") && plan.txs.some((t: { kind: string }) => t.kind === "sell"));
    const sigs: string[] = [];
    for (const t of plan.txs) {
      const tx = Transaction.from(Buffer.from(t.tx, "base64"));
      assert.ok(tx.feePayer!.equals(visitor.publicKey), "the visitor pays");
      tx.partialSign(visitor);
      let r: { signature: string } | { error: string } = { error: "" };
      for (let attempt = 0; attempt < 4; attempt++) {
        r = await api("/api/send", { tx: tx.serialize().toString("base64") }).catch((e) => ({ error: e.message as string }));
        if ("signature" in r || !/OneSellPerSlot|0x1782/.test(r.error)) break;
        await sleep(1200);
      }
      if ("signature" in r) sigs.push(r.signature);
      ok(`${t.label}: ${"signature" in r ? "confirmed" : `failed (${r.error})`}`);
    }
    const res = await api(`/api/vault/${mint}/crank-result`, { signatures: sigs });
    const reward = BigInt(res.crankRewardLamports);
    assert.ok(reward > 0n, "the visitor earned a crank reward");
    const ev = fs.readFileSync(path.join(launchDir, "state", "events.jsonl"), "utf8");
    assert.ok(ev.includes(visitor.publicKey.toBase58()), "the visitor's run is in the token's log");
    ok(`crank reward ${xnt(reward)} XNT to the visitor; recorded for the token's stats`);
    setMinHarvest(mint, "0.05");
  }
  console.log("\nCurve + Tax Vault rehearsal finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.stack ?? e.message : e);
  console.error("--- server log (last 60 lines) ---\n" + log.join("").split("\n").slice(-60).join("\n"));
  process.exitCode = 1;
} finally {
  server.kill();
  ipfs.close();
  if (process.env.KEEP_DIR) console.log(`kept ${dir}`); else fs.rmSync(dir, { recursive: true, force: true });
}
