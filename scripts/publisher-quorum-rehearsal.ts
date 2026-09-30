/**
 * Publisher quorum rehearsal (docs/tax-vault-spec.md "Publisher quorum"), on a LOCAL validator
 * (nothing goes to testnet/mainnet). The tax_vault program is not changed: its publisher
 * becomes a Squads v4 multisig's vault.
 *
 *   A. The site as today (plain-key publisher): a vault token with trading, a list published
 *      and paid by the site's key.
 *   B. scripts/setup-publisher-quorum.ts: dry run, then --execute: a 2-of-3 multisig (site,
 *      co-signer, backup; autonomous, no time lock) and set_publisher(its vault PDA).
 *   C. The site proposes the next list (Squads vault transaction + proposal + its approval);
 *      without the co-signer nothing reaches the chain and the site's key alone can't execute.
 *   D. The co-signer (scripts/cosigner.ts --strict, a zero snapshot-age limit) rejects it (the
 *      site built it while the traders were trading, so its balances moved too): the
 *      site closes the proposal with its own rejection, records it as rejected (with the
 *      co-signer's reason) and proposes a new list.
 *   E. The co-signer checks that list, approves and executes it (and pins a second copy);
 *      it goes live and holders are paid; the page shows "checked by co-signer".
 *   F. With the site stopped, the site's key alone proposes a malicious list (a wallet
 *      lowered, an attacker paid) and a set_publisher(attacker): the co-signer rejects both
 *      (reasons as vote memos, webhook alerts), neither reaches the chain, the site's key
 *      can't execute them, and the vault's recovery clocks (last_publish_at) don't move;
 *      the guardian's appoint_publisher still opens 15 s after the last real list.
 *   G. The site restarts; with the co-signer looping, its next list is approved and paid, and
 *      finished proposals' rent is reclaimed.
 *
 * Start the validator with the 3.1.x solana-test-validator (short-windows v3 build loaded
 * read-only, the testnet Squads program and its program config cloned):
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9501 --faucet-port 9505 \
 *     --gossip-port 9503 --dynamic-port-range 9510-9540 --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --clone-upgradeable-program DDL3Xp6ie85DXgiPkXJ7abUyS2tGv4CGEod2DeQXQ941 \
 *     --clone BUksxAHQ4oudRMuKkmNqS9yhvkTtAYunw7rrdBRm3VEZ --maybe-clone 45bQSp8Xgvavg5fj6PAyqxR2Gd8nUbCFLFcsapmrFcyU \
 *     <the XDEX / XNM clones of scripts/local-vault-v3-test.ts> \
 *     --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault3-test/tax_vault.so
 * then:
 *   LOCAL_RPC=http://127.0.0.1:9501 npx tsx scripts/publisher-quorum-rehearsal.ts
 * The site runs on port 8161, the IPFS stand-in on 8162, a webhook receiver on 8163.
 * KEEP_DIR=1 keeps the throwaway config/factory/state directory (it holds the drill's keys).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import { buildBuy, buildSell, quoteBuy, quoteSell } from "../src/xdex.js";
import {
  PAID_RECORD_LEN, appointPublisherIx, buildVaultTree, cidFromBytes, cidToBytes, decodePaidRecord, decodeVault, publishListIx, rawCid, setPublisherIx,
  vaultPda, type Vault,
} from "../src/taxvault.js";
import { listFileText, type ListFileJson } from "../src/vault-crank.js";
import {
  SQUADS_PROGRAM_IDS, executeIx, proposalVotes, proposeIxs, readProposal, readQuorum, squadsMultisigPda, squadsVaultPda,
} from "../src/squads.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9501";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const SQUADS = SQUADS_PROGRAM_IDS.testnet;
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const PORT = 8161, SITE = `http://127.0.0.1:${PORT}`;
const IPFS_PORT = 8162, IPFS = `http://127.0.0.1:${IPFS_PORT}`;
const HOOK_PORT = 8163, HOOK = `http://127.0.0.1:${HOOK_PORT}/alert`;
const JWT = "rehearsal-jwt";
const conn = new Connection(RPC, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  ✓ ${m}`);
const xnt = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);

// ---------- a local stand-in for Pinata's upload API and an IPFS gateway; a webhook receiver ----------
const pinned = new Map<string, Buffer>();
let pins = 0;
const ipfs = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (req.method === "POST" && req.url === "/v3/files") {
    if (req.headers.authorization !== `Bearer ${JWT}`) { res.writeHead(401).end("{}"); return; }
    const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": String(req.headers["content-type"]) } }).formData();
    const bytes = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const cid = rawCid(bytes); // a small file is one raw block: its CID is its sha256
    pinned.set(cid, bytes); pins++;
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-quorum-rehearsal-"));
const payer = Keypair.generate(), sitePublisher = Keypair.generate(), creator = Keypair.generate();
const cosigner = Keypair.generate(), backup = Keypair.generate(), attacker = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
const fund = async (k: PublicKey, sol: number) => conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
for (const k of [payer, creator, ...traders]) await fund(k.publicKey, 80);
for (const k of [sitePublisher, cosigner]) await fund(k.publicKey, 5);
const feeMint = await createMint(conn, payer, payer.publicKey, null, 6);
{
  const ata = getAssociatedTokenAddressSync(feeMint, creator.publicKey);
  await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, creator.publicKey, feeMint)), [payer]);
  await mintTo(conn, payer, feeMint, ata, payer, 5_000_000);
}
const keyFile = (name: string, k: Keypair) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 }); return f; };
const payerFile = keyFile("payer", payer), publisherFile = keyFile("publisher", sitePublisher), cosignerFile = keyFile("cosigner", cosigner);
// The multisig's address follows from its create key, so the site's config can name it up front.
const createKey = Keypair.generate();
const createKeyFile = keyFile("create-key", createKey);
const MS = squadsMultisigPda(SQUADS, createKey.publicKey), MS_VAULT = squadsVaultPda(SQUADS, MS);
const base = JSON.parse(fs.readFileSync("config.json", "utf8"));
const cfg = {
  ...base, network: "testnet", rpcUrl: RPC, mint: "", xdex: { ...base.xdex, pool: "" },
  distribution: { ...base.distribution, excludeOwners: [], creatorBps: 0 },
  factory: {
    ...base.factory, port: PORT, publicUrl: SITE, hosts: [], faucet: undefined, turnstile: undefined,
    curve: undefined, quoteTokens: undefined, launchesPaused: undefined,
    pinataJwt: JWT, pinataApiUrl: `${IPFS}/v3/files`, ipfsGateway: `${IPFS}/ipfs/`,
    feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
    taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: publisherFile,
      quorum: { multisig: MS.toBase58(), labels: { [cosigner.publicKey.toBase58()]: "co-signer", [backup.publicKey.toBase58()]: "backup" } } },
  },
};
delete cfg.creatorReward;
const cfgFile = path.join(dir, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
fs.mkdirSync(path.join(dir, "factory")); fs.mkdirSync(path.join(dir, "state"));
const env = {
  ...process.env, REFLECT_FACTORY_DIR: path.join(dir, "factory"), REFLECT_STATE_DIR: path.join(dir, "state"), REFLECT_RPC_URL: RPC,
  TAX_VAULT_SHORT_WINDOWS: "1", PINATA_JWT: "", PINATA_API_URL: "", IPFS_GATEWAY: "", TAX_VAULT_PASS_SECS: "6",
};
const log: string[] = [];
let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  server = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "src/factory-server.ts"], { env: { ...env, REFLECT_CONFIG: cfgFile }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout!.on("data", (d) => log.push(String(d))); server.stderr!.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 60 && !(await fetch(SITE + "/api/info").then((r) => r.ok).catch(() => false)); i++) await sleep(500);
}
async function stopServer() { if (!server) return; server.kill(); await new Promise((r) => server!.once("exit", r)); server = null; }
process.on("exit", () => server?.kill());

async function api(p: string, body?: unknown) {
  const r = await fetch(SITE + p, body ? { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(`${p}: ${j.error}`);
  return j;
}
const fresh = (p: string) => api(`${p}?t=${Date.now()}`);
async function step(p: string, body: Record<string, unknown>, signer: Keypair) {
  const out = await api(p, body);
  const tx = Transaction.from(Buffer.from(out.tx, "base64"));
  tx.partialSign(signer);
  const { signature } = await api("/api/send", { tx: tx.serialize().toString("base64") });
  return { ...out, signature };
}
async function launch(c: Keypair, name: string, symbol: string) {
  const params = { name, symbol, image: "", description: "publisher quorum drill", supply: "1000000", poolTokens: "1000000", poolXnt: "10",
    taxBps: 500, autoLpBps: 2500, burnBps: 2500, lockDays: null, creator: c.publicKey.toBase58() };
  const { mint } = await step("/api/launch/token", params, c);
  await step("/api/launch/pool", { mint, creator: params.creator }, c);
  await step("/api/launch/lock", { mint, creator: params.creator }, c);
  await step("/api/launch/vault", { mint, creator: params.creator }, c);
  await api("/api/launch/register", { mint, creator: params.creator });
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "launch.json"), "utf8"));
  return { mint, rec };
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
async function paidRecords(vault: PublicKey) {
  const raw = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: PAID_RECORD_LEN }, { memcmp: { offset: 8, bytes: vault.toBase58() } }] });
  return new Map(raw.map(({ pubkey, account }) => { const r = decodePaidRecord(pubkey, account.data); return [r.wallet.toBase58(), r.paid] as [string, bigint]; }));
}
const listFromIpfs = (cidBytes: Buffer) => {
  const cid = cidFromBytes(cidBytes);
  assert.ok(cid && pinned.has(cid), `list ${cid} is on IPFS`);
  return { cid: cid!, file: JSON.parse(pinned.get(cid!)!.toString("utf8")) as ListFileJson };
};
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
/** A repo script as its operator would run it; async because the IPFS stand-in runs in this process. */
async function script(file: string, args: string[], opts: { expectCode?: number; quiet?: boolean } = {}) {
  const child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), file, ...args], { env: { ...process.env, PINATA_JWT: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; }); child.stderr!.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill(), 300_000);
  const code = await new Promise<number | null>((r) => child.once("exit", r));
  clearTimeout(timer);
  if (!opts.quiet) for (const l of out.trimEnd().split("\n")) console.log(`      | ${l}`);
  assert.equal(code, opts.expectCode ?? 0, `${file} exited with ${code}`);
  return out;
}
const cosignerArgs = ["--rpc", RPC, "--keypair", cosignerFile, "--multisig", MS.toBase58(), "--network", "testnet", "--program", PROGRAM.toBase58(),
  "--ipfs-gateway", `${IPFS}/ipfs/`, "--webhook", HOOK];
const listFile = (mint: string) => JSON.parse(fs.readFileSync(path.join(dir, "factory", "launches", mint, "state", "vault-list.json"), "utf8"));
/** Send `ixs` signed by `signer`; returns the error message if it fails. */
async function tryTx(ixs: TransactionInstruction[], signer: Keypair) {
  try { await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [signer]); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

let bg: ReturnType<typeof spawn> | null = null;
try {
  console.log("A. The site with a plain-key publisher: a vault token, trading, a list published and paid by the site's key");
  await startServer();
  const t1 = await launch(creator, "Quorum Drill", "QDRL");
  const mint = t1.mint;
  ok(`token ${mint.slice(0, 8)}… launched; publisher = the site's key ${sitePublisher.publicKey.toBase58().slice(0, 8)}…`);
  assert.ok((await readVault(mint)).publisher.equals(sitePublisher.publicKey));
  await trade(mint, t1.rec.pool, 2);
  await waitFor("the site published a list with its own key and paid holders", async () => (await readVault(mint)).holdersPaid > 0n, 300_000, 3_000);
  {
    const f = listFile(mint);
    const l = f.active ?? f.next;
    assert.ok(l && !l.proposal, "no proposal with a plain-key publisher");
    const v = await readVault(mint);
    const { file } = listFromIpfs(v.listCid);
    assert.ok(file.inputs && file.inputs.balances.length > 0 && file.inputs.prev === null, "the pinned file carries its inputs (first list: no previous)");
    ok(`list ${v.listEpoch} published directly (no proposal); its file carries inputs: ${file.inputs!.balances.length} balances, pot ${xnt(BigInt(file.inputs!.pot))} XNT`);
  }

  console.log("B. scripts/setup-publisher-quorum.ts: a 2-of-3 multisig, then set_publisher(its vault)");
  const setupArgs = ["--rpc", RPC, "--keypair", payerFile, "--create-key", createKeyFile, "--site", sitePublisher.publicKey.toBase58(),
    "--cosigner", cosigner.publicKey.toBase58(), "--backup", backup.publicKey.toBase58(), "--mint", mint, "--publisher", publisherFile, "--program", PROGRAM.toBase58()];
  {
    const dry = await script("scripts/setup-publisher-quorum.ts", setupArgs);
    assert.ok(dry.includes("DRY RUN") && (dry.match(/simulation OK/g) ?? []).length === 2, "dry run simulates the multisig and the set_publisher");
    assert.ok(!(await readQuorum(conn, SQUADS, MS)) && (await readVault(mint)).publisher.equals(sitePublisher.publicKey), "the dry run sent nothing");
    ok("dry run: both simulated, nothing sent");
    await script("scripts/setup-publisher-quorum.ts", [...setupArgs, "--execute"]);
    const q = (await readQuorum(conn, SQUADS, MS))!;
    assert.equal(q.threshold, 2); assert.equal(q.voters, 3); assert.equal(q.configAuthority, null); assert.equal(q.timeLock, 0);
    assert.ok(q.rentCollector?.equals(sitePublisher.publicKey));
    const site = q.members.find((m) => m.key === sitePublisher.publicKey.toBase58())!, cos = q.members.find((m) => m.key === cosigner.publicKey.toBase58())!;
    assert.ok(site.initiate && site.vote && site.execute && !cos.initiate && cos.vote && cos.execute);
    assert.ok((await readVault(mint)).publisher.equals(MS_VAULT), "the vault's publisher is the multisig's vault");
    ok(`multisig ${MS.toBase58().slice(0, 8)}… 2 of 3, autonomous, no time lock; publisher = its vault ${MS_VAULT.toBase58().slice(0, 8)}…`);
    await script("scripts/setup-publisher-quorum.ts", [...setupArgs, "--execute"], { quiet: true }); // idempotent
    ok("running it again changes nothing");
  }

  console.log("C. The site proposes the next list; without the co-signer nothing reaches the chain");
  let p1: { index: bigint; epoch: bigint };
  {
    await trade(mint, t1.rec.pool, 2);
    await waitFor("the site proposed a list to the multisig", async () => listFile(mint).next?.proposal?.status === "Active", 300_000, 2_000);
    const n = listFile(mint).next;
    p1 = { index: BigInt(n.proposal.index), epoch: BigInt(n.epoch) };
    const p = (await readProposal(conn, SQUADS, MS, p1.index))!;
    assert.deepEqual(p.approved, [sitePublisher.publicKey.toBase58()]);
    ok(`list ${p1.epoch} proposed as Squads #${p1.index}, approved by the site only`);
    await sleep(15_000); // two site passes
    const v = await readVault(mint);
    assert.ok(v.listEpoch < p1.epoch && v.pendingEpoch < p1.epoch, "not on-chain");
    assert.equal((await readProposal(conn, SQUADS, MS, p1.index))!.status, "Active");
    const err = await tryTx([await executeIx(conn, SQUADS, MS, p1.index, sitePublisher.publicKey)], sitePublisher);
    assert.ok(err, "the site's key alone can't execute");
    ok(`two passes later still only proposed; the site's key alone can't execute it (${/InvalidProposalStatus|custom program error: 0x[0-9a-f]+/.exec(err!)?.[0] ?? err!.slice(0, 80)})`);
    const view = await fresh(`/api/vault/${mint}`);
    assert.equal(view.quorum.threshold, 2); assert.equal(view.quorum.voters, 3); assert.equal(view.sitePublishes, true);
    assert.equal(view.latestList.check.cosigner, "waiting");
    ok(`/api/vault shows the ${view.quorum.threshold}-of-${view.quorum.voters} multisig and the list waiting for the co-signer`);
  }

  console.log("D. The co-signer (strict, zero snapshot age) rejects it: the site closes it and proposes a new list");
  let p2: { index: bigint; epoch: bigint };
  {
    const alerts0 = alerts.length;
    await script("scripts/cosigner.ts", [...cosignerArgs, "--once", "--strict", "--max-snapshot-age-slots", "0"]);
    assert.ok(alerts.length > alerts0 && /REJECT #/.test(alerts.at(-1)!), "the webhook got the rejection");
    await waitFor("the site recorded the rejection and proposed a new list", async () => {
      const f = listFile(mint);
      return f.history.some((h: { event: string; proposal?: string }) => h.event === "rejected" && h.proposal === p1.index.toString())
        && !!f.next?.proposal && BigInt(f.next.proposal.index) > p1.index;
    }, 120_000, 2_000);
    const f = listFile(mint);
    const rej = f.history.find((h: { event: string; proposal?: string }) => h.event === "rejected" && h.proposal === p1.index.toString());
    assert.match(rej.reason, /co-signer.*snapshot/);
    const closed = await readProposal(conn, SQUADS, MS, p1.index);
    assert.ok(!closed || closed.status === "Rejected", "the rejected proposal is closed (Rejected, or its accounts reclaimed)");
    p2 = { index: BigInt(f.next.proposal.index), epoch: BigInt(f.next.epoch) };
    ok(`#${p1.index} rejected ("${rej.reason.slice(0, 90)}…"), ${closed ? "Rejected" : "closed"}; new list ${p2.epoch} proposed as #${p2.index}`);
  }

  console.log("E. The co-signer checks the new list, approves and executes it; holders are paid");
  {
    const pins0 = pins;
    const before = await readVault(mint);
    const out = await script("scripts/cosigner.ts", [...cosignerArgs, "--once", "--pinata-jwt", JWT, "--pinata-api", `${IPFS}/v3/files`]);
    assert.match(out, new RegExp(`#${p2.index}: PASS`));
    assert.ok(pins > pins0 && /second copy: \w+ \(same CID\)/.test(out), "the co-signer pinned a second copy (same CID)");
    const v = await readVault(mint);
    assert.ok(v.pendingEpoch === p2.epoch || v.listEpoch === p2.epoch, "the list is on-chain");
    const n = listFile(mint).next ?? listFile(mint).active;
    assert.equal((v.pendingEpoch === p2.epoch ? v.pendingRoot : v.listRoot).toString("hex"), n.root, "the list the site proposed");
    assert.ok(v.lastPublishAt > before.lastPublishAt, "publishing restarted the clocks");
    ok(`list ${p2.epoch} published by the multisig (approved by the co-signer, executed by it)`);
    // With short windows the vault is usually in fallback by now: pay_fallback may already have
    // paid out everything funded, so this list adds nothing new and nobody is owed from it; it
    // then goes live with the next list (publish_list activates it). Step G checks payouts.
    const mine = () => { const f = listFile(mint); return [f.next, f.active].find((l) => l?.epoch === p2.epoch.toString()); };
    await waitFor("the site marked it published", async () => !!mine()?.publishedAt && mine()?.proposal?.status === "Executed", 120_000, 2_000);
    const f = listFile(mint);
    assert.ok(f.history.some((h: { event: string; epoch: string }) => h.event === "published" && h.epoch === p2.epoch.toString()));
    assert.ok(mine().proposal.approved.includes(cosigner.publicKey.toBase58()));
    const { file } = listFromIpfs(v.pendingEpoch === p2.epoch ? v.pendingCid : v.listCid);
    const paid = await paidRecords(vaultPda(PROGRAM, new PublicKey(mint)));
    for (const [w, c] of file.entries) assert.ok((paid.get(w) ?? 0n) <= BigInt(c));
    const b = await fresh(`/api/vault/${mint}`);
    assert.equal(b.latestList.check.cosigner, "checked");
    assert.deepEqual(b.latestList.check.approvedBy.map((x: { label: string }) => x.label), ["co-signer"]);
    ok(`vault-list.json: proposed → published → active; /api/vault shows "checked by co-signer"; nobody paid above the list (holders paid ${xnt((await readVault(mint)).holdersPaid)} XNT)`);
  }

  console.log("F. The site's key alone proposes a malicious list and a publisher change: rejected, never on-chain");
  {
    await stopServer();
    const pendingAt = (await readVault(mint)).pendingActiveAt;
    if (pendingAt) await untilChainTime(pendingAt + 16, "the pending list's time + margin"); // an honest-looking base: the list the vault pays now
    const v0 = await readVault(mint);
    const q0 = (await readQuorum(conn, SQUADS, MS))!;
    const due = v0.pendingEpoch > 0n;
    const base = { epoch: due ? v0.pendingEpoch : v0.listEpoch, root: due ? v0.pendingRoot : v0.listRoot, cid: due ? v0.pendingCid : v0.listCid, total: due ? v0.pendingTotal : v0.listTotal };
    const { cid: prevCid, file: prev } = listFromIpfs(base.cid);
    const wallets: Record<string, string> = Object.fromEntries(prev.entries);
    const [victim, vc] = [...prev.entries].sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1))[0];
    const cut = BigInt(vc) / 2n;
    wallets[victim] = (BigInt(vc) - cut).toString();
    const extra = v0.holdersFunded - base.total;
    wallets[attacker.publicKey.toBase58()] = (cut + extra).toString();
    const total = Object.values(wallets).reduce((a, x) => a + BigInt(x), 0n);
    const epoch = base.epoch + 1n;
    const root = buildVaultTree(v0.address, wallets).root;
    // Plausible-looking inputs: the attacker claims a big balance.
    const text = listFileText({ mint, vault: v0.address.toBase58(), epoch: epoch.toString(), root: root.toString("hex"), total: total.toString(), wallets, rules: prev.rules,
      inputs: { ...prev.inputs!, slot: String(await conn.getSlot()), holdersFunded: v0.holdersFunded.toString(), floor: base.total.toString(), pot: extra.toString(),
        prev: { epoch: base.epoch.toString(), root: base.root.toString("hex"), cid: prevCid }, paid: [],
        balances: [...prev.inputs!.balances, [attacker.publicKey.toBase58(), "900000000000000"] as [string, string]].sort(([a], [b]) => (a < b ? -1 : 1)) } });
    const cid = rawCid(Buffer.from(text));
    pinned.set(cid, Buffer.from(text));
    const iBad = q0.transactionIndex + 1n, iPub = q0.transactionIndex + 2n;
    await sendAndConfirmTransaction(conn, new Transaction().add(...proposeIxs(SQUADS, MS, iBad, sitePublisher.publicKey,
      publishListIx(PROGRAM, MS_VAULT, new PublicKey(mint), root, epoch, total, cidToBytes(cid)))), [sitePublisher]);
    await sendAndConfirmTransaction(conn, new Transaction().add(...proposeIxs(SQUADS, MS, iPub, sitePublisher.publicKey,
      setPublisherIx(PROGRAM, MS_VAULT, new PublicKey(mint), attacker.publicKey))), [sitePublisher]);
    ok(`the site's key proposed #${iBad} (${victim.slice(0, 4)}… cut by ${xnt(cut)}, attacker gets ${xnt(cut + extra)} XNT) and #${iPub} (set_publisher to the attacker)`);
    for (const i of [iBad, iPub]) assert.ok(await tryTx([await executeIx(conn, SQUADS, MS, i, sitePublisher.publicKey)], sitePublisher), `#${i} can't be executed by the site alone`);
    ok("the site's key alone can execute neither");
    const alerts0 = alerts.length;
    const out = await script("scripts/cosigner.ts", [...cosignerArgs, "--once"]);
    assert.match(out, new RegExp(`REJECT #${iBad}`)); assert.match(out, new RegExp(`REJECT #${iPub}`));
    assert.ok(alerts.length >= alerts0 + 2, "both alerts reached the webhook");
    const votesBad = await proposalVotes(conn, SQUADS, MS, iBad), votesPub = await proposalVotes(conn, SQUADS, MS, iPub);
    const memoBad = votesBad.find((x) => x.member === cosigner.publicKey.toBase58() && x.vote === "reject")?.memo ?? "";
    const memoPub = votesPub.find((x) => x.member === cosigner.publicKey.toBase58() && x.vote === "reject")?.memo ?? "";
    assert.match(memoBad, /below their total in the previous list/);
    assert.doesNotMatch(memoBad, /stale|pending until/, "refused for what it does, not for its timing");
    assert.match(memoPub, /isn't publish_list/);
    ok(`co-signer's reasons on-chain: #${iBad} "${memoBad.slice(0, 110)}…"; #${iPub} "${memoPub}"`);
    for (const i of [iBad, iPub]) {
      const p = (await readProposal(conn, SQUADS, MS, i))!;
      assert.equal(p.status, "Active"); assert.equal(p.approved.length, 1); assert.equal(p.rejected.length, 1);
      assert.ok(await tryTx([await executeIx(conn, SQUADS, MS, i, sitePublisher.publicKey)], sitePublisher), `#${i} still can't be executed`);
    }
    const v1 = await readVault(mint);
    assert.ok(v1.publisher.equals(MS_VAULT), "publisher unchanged");
    assert.equal(v1.listEpoch, v0.listEpoch); assert.equal(v1.pendingEpoch, v0.pendingEpoch); assert.ok(v1.listRoot.equals(v0.listRoot));
    assert.equal(v1.lastPublishAt, v0.lastPublishAt, "the recovery clocks didn't move");
    ok(`nothing reached the chain: publisher, list ${v1.listEpoch} and last_publish_at ${v1.lastPublishAt} unchanged`);
    // Recovery still opens on time: the guardian's appoint_publisher 15 s (short windows) after the last real list.
    await untilChainTime(v0.lastPublishAt + 16, "last_publish_at + 15 s");
    const { blockhash } = await conn.getLatestBlockhash();
    const sim = await conn.simulateTransaction(new Transaction({ feePayer: creator.publicKey, recentBlockhash: blockhash }).add(appointPublisherIx(PROGRAM, creator.publicKey, new PublicKey(mint), creator.publicKey)));
    assert.equal(sim.value.err, null, "appoint_publisher is allowed");
    ok("the guardian could appoint a new publisher now (simulated, not sent): the rejected proposals kept nothing closed");
  }

  console.log("G. The site restarts; with the co-signer looping, the next list is approved and paid");
  {
    await startServer();
    const v0 = await readVault(mint);
    bg = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/cosigner.ts", ...cosignerArgs, "--loop", "3"], { stdio: ["ignore", "pipe", "pipe"] });
    let bgOut = "";
    bg.stdout!.on("data", (d) => { bgOut += d; }); bg.stderr!.on("data", (d) => { bgOut += d; });
    await trade(mint, t1.rec.pool, 2);
    await waitFor("a new list proposed, approved by the co-signer, live, and holders paid", async () => {
      const w = await readVault(mint);
      const f = listFile(mint);
      return w.listEpoch > p2.epoch && w.holdersPaid > v0.holdersPaid && f.active?.proposal?.status === "Executed" && f.active.epoch === w.listEpoch.toString();
    }, 300_000, 3_000);
    bg.kill(); bg = null;
    const f = listFile(mint);
    ok(`list ${f.active.epoch} via Squads #${f.active.proposal.index} (approved by ${f.active.proposal.approved.length} members); co-signer log: ${(bgOut.match(/PASS/g) ?? []).length} pass(es)`);
    const closedP2 = await readProposal(conn, SQUADS, MS, p2.index);
    assert.equal(closedP2, null, "the executed proposal's accounts were closed (rent back to the site)");
    ok(`executed proposal #${p2.index} closed, its rent back to the site's key`);
  }
  console.log("\nPublisher quorum drill finished.");
} catch (e) {
  console.error("\nFAILED:", e instanceof Error ? e.stack ?? e.message : e);
  console.error("--- server log (last 60 lines) ---\n" + log.join("").split("\n").slice(-60).join("\n"));
  process.exitCode = 1;
} finally {
  bg?.kill();
  await stopServer();
  ipfs.close(); hook.close();
  if (process.env.KEEP_DIR) console.log(`kept ${dir}`); else fs.rmSync(dir, { recursive: true, force: true });
}
