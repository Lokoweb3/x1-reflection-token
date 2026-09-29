/**
 * Standalone Tax Vault crank: keeps vault tokens running with nothing but an RPC and a
 * wallet (no site, no config.json), e.g. if 99 + Tax goes offline. See README "If 99 + Tax
 * goes offline".
 *
 *   npx tsx scripts/crank.ts --rpc <url> --keypair <file> (--mint <mint>[,<mint>...] | --all)
 *     [--publisher <keypair file>] [--loop <seconds>] [--ipfs-gateway <url>[,<url>...]]
 *     [--pinata-jwt <jwt> | env PINATA_JWT] [--pinata-api <url>] [--program <id>] [--network testnet|mainnet]
 *
 *   --keypair     the wallet that pays the fees (and the PaidRecord rents) and earns the crank
 *                 reward (1% of the holders' XNT from each sale, up to 0.05 XNT)
 *   --all         every vault of the program (--program, default the testnet tax_vault
 *                 D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW)
 *   --publisher   the vault's publisher key (e.g. one the creator appointed): also builds,
 *                 pins (needs a Pinata key) and publishes rewards lists for the vaults it
 *                 publishes for; a list in fallback ends the fallback
 *   --loop        run again every <seconds> (default: one pass)
 *   --ipfs-gateway where list files are read (default Pinata's gateway, then ipfs.io)
 *   --network     only needed if it can't be told from the pool's XDEX program
 * Env TAX_VAULT_SHORT_WINDOWS=1 matches a program built with `short-windows` (local tests).
 *
 * Each pass, per vault: upgrade_vault (v1/v2), collect, sell, add_liquidity, fund_creator,
 * then pays: the active list's file is read from IPFS by the CID stored on-chain and checked
 * against the on-chain Merkle root before anything is paid from it; `pay` normally, and
 * `pay_fallback` once no list was published for 30 days. Same rules and limits as the site
 * (src/vault-crank.ts). Every transaction is simulated first; nothing is sent for a step
 * that isn't due.
 */
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { XDEX_PROGRAM_IDS, xnt } from "../src/config.js";
import { DEFAULT_GATEWAY, fetchFromGateways, pinFile } from "../src/factory/ipfs.js";
import {
  TAX_VAULT_PROGRAM_ID, VAULT_DISC, VAULT_VERSION, appointAllowedAt, cidFromBytes, decodeVault, effectiveList, fallbackAt, type Vault, type VaultEvent,
} from "../src/taxvault.js";
import {
  ACTIVATION_MARGIN_SECS, type CrankToken, type PayList, defaultRules, inFallback, listFileText, nowSecs, parseListFile, rulesFromJson, rulesJson, vaultCrank,
} from "../src/vault-crank.js";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(`crank: ${problem}\n`);
  console.error("Usage: npx tsx scripts/crank.ts --rpc <url> --keypair <file> (--mint <mint>[,<mint>...] | --all) [--publisher <keypair>]\n"
    + "         [--loop <seconds>] [--ipfs-gateway <url>[,<url>...]] [--pinata-jwt <jwt>|env PINATA_JWT] [--pinata-api <url>] [--program <id>] [--network testnet|mainnet]");
  process.exit(2);
}
if (has("help") || has("h")) usage();
const rpc = flag("rpc") ?? usage("--rpc is required");
const readKey = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))));
const signer = readKey(flag("keypair") ?? usage("--keypair is required"));
const publisher = flag("publisher") ? readKey(flag("publisher")!) : null;
const program = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);
const mintArgs = (flag("mint") ?? "").split(",").filter(Boolean).map((m) => new PublicKey(m));
if (!has("all") && !mintArgs.length) usage("give --mint <mint> or --all");
const loopSecs = flag("loop") ? Number(flag("loop")) : 0;
if (!(loopSecs >= 0)) usage("--loop takes seconds");
const gateways = (flag("ipfs-gateway") ?? `${DEFAULT_GATEWAY},https://ipfs.io/ipfs/`).split(",").filter(Boolean).map((g) => g.replace(/\/?$/, "/"));
const pinataJwt = flag("pinata-jwt") ?? process.env.PINATA_JWT ?? "";
const pinataApi = flag("pinata-api") ?? process.env.PINATA_API_URL;
const networkArg = flag("network");
if (networkArg && networkArg !== "testnet" && networkArg !== "mainnet") usage("--network is testnet or mainnet");
const microLamports = Number(flag("priority") ?? 10_000);

const conn = new Connection(rpc, "confirmed");
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };

// ---------- helpers ----------
/** Every vault account of the program (any version). */
async function allVaults(): Promise<PublicKey[]> {
  const raw = await conn.getProgramAccounts(program, { commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: bs58.encode(VAULT_DISC) } }] });
  return raw.map(({ account }) => new PublicKey(account.data.subarray(8, 40)));
}

/** The XDEX program (the vault pool's owner) and so the network. */
async function networkOf(v: Vault): Promise<{ xdex: PublicKey; network: "mainnet" | "testnet" }> {
  const info = await conn.getAccountInfo(v.pool, "confirmed");
  if (!info) throw new Error(`the vault's pool ${v.pool.toBase58()} doesn't exist`);
  const xdex = info.owner;
  const known = Object.entries(XDEX_PROGRAM_IDS).find(([, id]) => id === xdex.toBase58())?.[0] as "mainnet" | "testnet" | undefined;
  const network = (networkArg as "mainnet" | "testnet" | undefined) ?? known;
  if (!network) throw new Error(`can't tell the network from the pool's program ${xdex.toBase58()}; pass --network`);
  return { xdex, network };
}

/** Symbol, tax (bps) and supply of the mint. */
async function tokenInfo(mint: PublicKey) {
  const [info, md] = await Promise.all([conn.getAccountInfo(mint, "confirmed"), getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null)]);
  const m = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(m);
  const epoch = BigInt((await conn.getEpochInfo("confirmed")).epoch);
  const taxBps = fee ? (epoch >= fee.newerTransferFee.epoch ? fee.newerTransferFee : fee.olderTransferFee).transferFeeBasisPoints : 0;
  return { symbol: md?.symbol || short(mint), taxBps, supply: m.supply };
}

/** List files by CID, checked against the root they were published with (kept between passes). */
const lists = new Map<string, { wallets: Record<string, string>; rules?: ReturnType<typeof rulesJson> }>();
async function listFile(v: Vault, cidBytes: Buffer, root: Buffer) {
  const cid = cidFromBytes(cidBytes);
  if (!cid) return null;
  const key = `${cid}:${root.toString("hex")}`;
  if (!lists.has(key)) {
    const bytes = await fetchFromGateways(gateways, cid);
    const { file, wallets } = parseListFile(bytes, v.address, root, cidBytes);
    lists.set(key, { wallets, rules: file.rules });
    log(`  list file ${cid}: ${Object.keys(wallets).length} wallets, root matches the chain`);
  }
  return { cid, ...lists.get(key)! };
}

/** One line per program event, for the log. */
function describe(e: VaultEvent) {
  switch (e.name) {
    case "Collected": return `collected ${e.got} tokens (${e.burned} burned)`;
    case "Sold": return `sold ${e.tokensIn} tokens for ${xnt(e.xntOut)} (crank reward ${xnt(e.crankReward)})`;
    case "LiquidityAdded": return `added liquidity: ${e.tokens} tokens + ${xnt(e.xnt)}`;
    case "CreatorFunded": return `creator reward: ${xnt(e.xntIn)} -> ${e.rewardOut} ${short(e.rewardMint)}`;
    case "ListPublished": return `list ${e.epoch} published, total ${xnt(e.total)}, pays from ${new Date(e.activeAt * 1000).toISOString()}`;
    case "ListCancelled": return `list ${e.epoch} cancelled`;
    case "Paid": return `paid ${short(e.wallet)} ${xnt(e.amount)} (total ${xnt(e.cumulative)})`;
    case "FallbackPaid": return `fallback-paid ${short(e.wallet)} ${xnt(e.amount)} (total ${xnt(e.entitled)})`;
    case "PublisherChanged": return `publisher ${short(e.old)} -> ${short(e.new)}`;
  }
}

// ---------- one vault ----------
async function crankVault(mint: PublicKey) {
  let v = await (async () => {
    const [addr] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], program);
    const info = await conn.getAccountInfo(addr, "confirmed");
    return info && info.owner.equals(program) ? decodeVault(addr, info.data) : null;
  })();
  if (!v) { log(`${short(mint)}: no vault`); return; }
  const { xdex, network } = await networkOf(v);
  const info = await tokenInfo(mint);
  const onTx = (_t: CrankToken, _v: Vault, _sig: string, events: VaultEvent[]) => { for (const e of events) log(`  ${describe(e)}`); };
  const env = { conn, program, xdex, network, microLamports, tag: " ", onTx };
  const c = vaultCrank({ ...env, signer });
  const notes: string[] = [];
  const t: CrankToken = { mint, symbol: info.symbol, taxBps: info.taxBps, rules: defaultRules(info.supply) };
  const now = nowSecs();
  log(`${t.symbol} (${mint.toBase58()}) vault v${v.version}, ${network}; publisher ${short(v.publisher)}, holders funded ${xnt(v.holdersFunded)}, paid ${xnt(v.holdersPaid)}`
    + (v.version >= 3 ? `; last list published ${new Date(v.lastPublishAt * 1000).toISOString()}${inFallback(v, now) ? " (FALLBACK active)" : ""}` : ""));
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) {
      if (/: WrongVersion$/.test(msg(e))) { notes.push(`${name} waits for the vault upgrade`); return; }
      log(`  ${name} failed: ${msg(e).split("\n")[0].slice(0, 300)}`);
    }
  };
  // The active list's file (and its payout rules) first: collect uses its minimum.
  const eff0 = effectiveList(v, now);
  const active = eff0 ? await listFile(v, eff0.cid, eff0.root).catch((e) => { log(`  list ${eff0.epoch}: ${msg(e)}`); return null; }) : null;
  if (active?.rules) t.rules = rulesFromJson(active.rules, t.rules);

  await step("upgrade_vault", async () => { v = await c.upgrade(t, v!, notes); });
  let pool: Awaited<ReturnType<typeof c.poolOf>> | null = null;
  await step("pool", async () => { pool = await c.poolOf(v!); });
  await step("collect", () => c.collect(t, v!, notes));
  if (pool) {
    await step("sell", () => c.sell(t, pool!, notes));
    await step("add_liquidity", () => c.liquidity(t, pool!, notes));
  }
  await step("fund_creator", () => c.creator(t, notes));

  // Lists: with --publisher, build, pin and publish a new one when this key publishes for the vault.
  await step("rewards list", async () => {
    v = (await c.readVault(mint)) ?? v!;
    if (!publisher || v.version < VAULT_VERSION) return;
    if (!v.publisher.equals(publisher.publicKey)) {
      const at = appointAllowedAt(v)!;
      notes.push(`not publishing: the vault's publisher is ${short(v.publisher)}; the creator (${short(v.guardian)}) can appoint ${short(publisher.publicKey)} from ${new Date(at * 1000).toISOString()}`);
      return;
    }
    if (v.pendingEpoch > 0n) { notes.push(`list ${v.pendingEpoch} is pending until ${new Date(v.pendingActiveAt * 1000).toISOString()}`); return; }
    const cur = v.listEpoch > 0n ? await listFile(v, v.listCid, v.listRoot).catch((e) => { log(`  active list: ${msg(e)}`); return null; }) : null;
    if (v.listEpoch > 0n && !cur) log("  the active list's file isn't readable: the new list starts every wallet from what it was paid on-chain");
    const fallback = inFallback(v);
    const pc = vaultCrank({ ...env, signer: publisher });
    const next = await pc.nextList(t, v, v.listEpoch > 0n ? cur?.wallets ?? null : {}, notes, fallback);
    if (!next) { notes.push("no new list (not enough new XNT for holders yet)"); return; }
    if (!pinataJwt) { notes.push("a new list is due but there's no Pinata key (--pinata-jwt or PINATA_JWT): not published"); return; }
    const text = listFileText({ mint: mint.toBase58(), vault: v.address.toBase58(), epoch: next.epoch.toString(), root: next.root.toString("hex"),
      total: next.total.toString(), wallets: next.wallets, rules: rulesJson(t.rules) });
    // No pin, no publish: the list file must be on IPFS before its CID goes on-chain.
    const cid = await pinFile({ jwt: pinataJwt, uploadUrl: pinataApi }, new Blob([text], { type: "application/json" }), `${t.symbol}-list-${next.epoch}.json`, `99tax ${t.symbol} rewards list ${next.epoch}`);
    log(`  list ${next.epoch}: ${xnt(next.allocated)} new across ${next.holders} holder(s), total ${xnt(next.total)}, pinned as ${cid}${fallback ? " (ends the fallback)" : ""}`);
    await pc.publish(t, v, { epoch: next.epoch, total: next.total, root: next.root, cid, wallets: Object.keys(next.wallets).length });
    lists.set(`${cid}:${next.root.toString("hex")}`, { wallets: next.wallets, rules: rulesJson(t.rules) });
  });

  // Pays: pay normally, pay_fallback once no list was published for FALLBACK_AFTER_SECS.
  await step("pay", async () => {
    v = (await c.readVault(mint)) ?? v!;
    const at = nowSecs();
    const eff = effectiveList(v, at - ACTIVATION_MARGIN_SECS);
    if (!eff) { notes.push("no rewards list yet"); return; }
    if (!eff.pending && v.pendingEpoch > 0n && at >= v.pendingActiveAt) return; // a new list is about to take over
    const file = await listFile(v, eff.cid, eff.root);
    if (!file) { notes.push(`list ${eff.epoch} has no IPFS file (published before v3): can't pay from it here`); return; }
    const list: PayList = { root: eff.root.toString("hex"), wallets: file.wallets };
    const fallback = inFallback(v, at);
    const n = await c.pay(t, v, list, fallback ? "fallback" : "pay", notes);
    if (!n) notes.push(fallback ? `fallback active since ${new Date(fallbackAt(v)! * 1000).toISOString()}: nobody owed enough yet` : "nobody owed enough yet");
  });
  for (const n of notes) log(`  ${n}`);
}

async function pass() {
  const mints = has("all") ? await allVaults() : mintArgs;
  log(`pass: ${mints.length} vault(s), wallet ${signer.publicKey.toBase58()} (${xnt(BigInt(await conn.getBalance(signer.publicKey)))})${publisher ? `, publisher ${publisher.publicKey.toBase58()}` : ""}`);
  for (const m of mints) {
    try { await crankVault(m); } catch (e) { log(`${short(m)}: ${msg(e)}`); }
  }
}

await pass();
while (loopSecs > 0) {
  await new Promise((r) => setTimeout(r, loopSecs * 1000));
  await pass().catch((e) => log(`pass failed: ${msg(e)}`));
}
