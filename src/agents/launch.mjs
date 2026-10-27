#!/usr/bin/env node
/**
 * Launch a token on a 99 + Tax site from the command line, signing with a local keypair.
 * Made for AI agents (see the site's /skill.md) and for people who'd rather not use a browser wallet.
 *
 *   npm i @solana/web3.js@1
 *   node launch.mjs --keypair <wallet.json> --name <name> --symbol <SYM> --supply <whole tokens>
 *     --tax <1-10 %> --pool <XNT> [--lp <% of the tax>] [--burn <% of the tax>] [--lock <days>|forever]
 *     [--description <text>] [--image <https:// or ipfs:// PNG/JPG/WebP/GIF>]
 *     [--website <url>] [--twitter <x.com url>] [--telegram <t.me url>] [--pair <symbol, default XNT>]
 *     [--site <url>] [--network mainnet|testnet] [--max-cost <XNT>] [--live]
 *   node launch.mjs --site <url> --keypair <wallet.json> --resume <mint> [--live]   (finish a launch that stopped)
 *   node launch.mjs --site <url> --keypair <wallet.json> --status                   (this wallet's launches)
 *
 * Network: https://99tax.vercel.app is mainnet (real funds), https://99tax-testnet.vercel.app is testnet. Before
 * anything is signed, the site's /api/info must report the network expected for it; any other --site needs
 * --network. A resumed mint must exist on that same network.
 *
 * Without --live it only checks: it prints the launch, what it costs and whether the wallet can pay, and
 * sends nothing. With --live it runs every step (token, pool, LP lock, tax vault, register), signing each
 * transaction the site builds with the keypair, which never leaves this machine. Each step waits for the
 * last to confirm; if one fails, rerun with --resume <mint> to continue from there.
 */
import fs from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

const DEFAULT_SITE = "{{SITE}}";
const RPC = { mainnet: "https://rpc.mainnet.x1.xyz", testnet: "https://rpc.testnet.x1.xyz" };

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(`--${k}`);
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }
// The site's own message (e.g. "Invalid symbol"), without a stack trace.
process.on("uncaughtException", (e) => die(e instanceof Error ? e.message : String(e)));

const site = (flag("site") ?? DEFAULT_SITE).replace(/\/$/, "");
if (!/^https?:\/\//.test(site)) die("--site must be the launch site's URL, e.g. https://99tax.vercel.app");
const keyPath = flag("keypair") ?? die("--keypair <wallet.json> is required (a Solana CLI keypair file)");
let wallet;
try { wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))); }
catch { die(`can't read a keypair from ${keyPath}`); }
const creator = wallet.publicKey.toBase58();
const live = has("live");

async function api(path, body) {
  const res = await fetch(`${site}${path}`, body === undefined ? {} : {
    method: "POST",
    // The site only takes POSTs from its own origin.
    headers: { "content-type": "application/json", origin: site },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`${path}: ${out.error ?? `HTTP ${res.status}`}`);
  return out;
}

/** Sign a transaction the site built (it may already carry the site's signature, e.g. the new mint's) and send it. */
async function signAndSend(label, path, body) {
  console.log(`\n== ${label}`);
  const { tx, ...rest } = await api(path, body);
  const t = VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
  t.sign([wallet]);
  // vaultMint: the site refreshes that token's vault pages at once.
  const { signature } = await api("/api/send", { tx: Buffer.from(t.serialize()).toString("base64"), ...(body.vaultMint ? { vaultMint: body.vaultMint } : {}) });
  console.log(`confirmed: ${info.explorer}/tx/${signature}`);
  return { signature, ...rest };
}

const OFFICIAL = { "https://99tax.vercel.app": "mainnet", "https://99tax-testnet.vercel.app": "testnet" };
const networkFlag = flag("network");
if (networkFlag !== undefined && !(networkFlag in RPC)) die("--network must be mainnet or testnet");
if (OFFICIAL[site] && networkFlag && networkFlag !== OFFICIAL[site]) die(`${site} is the ${OFFICIAL[site]} site, but --network says ${networkFlag}`);
const expectedNetwork = OFFICIAL[site] ?? networkFlag ?? die(`${site} isn't one of the official sites; say which network it should be on with --network mainnet|testnet`);
const info = await api("/api/info");
if (info.network !== expectedNetwork) die(`${site} reports ${info.network}, expected ${expectedNetwork}; refusing to continue`);
const conn = new Connection(RPC[info.network] ?? die(`unknown network ${info.network}`), "confirmed");
console.log(`site: ${site} (${info.network})   wallet: ${creator}`);

async function statusOf(mint) {
  const mine = await api(`/api/launches?creator=${creator}`);
  const l = mine.find((x) => x.mint === mint);
  if (!l) die(`${mint} isn't one of this wallet's launches on ${site}`);
  return l;
}

/** Steps 2 on: pool, LP lock, tax vault (vault launches), register. Each is skipped once done. */
async function finish(mint) {
  let { status } = await statusOf(mint);
  if (!status.token) die("the token step hasn't confirmed yet; wait a minute and --resume again");
  if (!status.pool) await signAndSend("2. create the pool", "/api/launch/pool", { mint, creator });
  if (!status.lock) await signAndSend("3. lock the liquidity", "/api/launch/lock", { mint, creator });
  ({ status } = await statusOf(mint));
  if (status.taxVault && !status.vault) await signAndSend("4. start the tax vault", "/api/launch/vault", { mint, creator, vaultMint: mint });
  if (status.holderPasses && !status.passes) await signAndSend("4b. turn on holder passes", "/api/launch/passes", { mint, creator, vaultMint: mint });
  console.log("\n== register");
  const { registered } = await api("/api/launch/register", { mint, creator });
  if (!registered) die(`registration didn't go through yet; rerun with --resume ${mint} --live`);
  console.log(`\nlive: ${info.explorer}/address/${mint}\npage: ${site}/tokens`);
}

if (has("status")) {
  const mine = await api(`/api/launches?creator=${creator}`);
  if (!mine.length) console.log("no launches from this wallet");
  for (const l of mine) {
    const s = l.status;
    const steps = ["token", "pool", "lock", ...(s.taxVault ? ["vault"] : []), "registered"].map((k) => `${k} ${s[k] ? "✓" : "·"}`).join("  ");
    console.log(`${l.symbol.padEnd(10)} ${l.mint}  ${steps}`);
  }
  process.exit(0);
}

const resume = flag("resume");
if (resume) {
  const l = await statusOf(new PublicKey(resume).toBase58());
  console.log(`resume ${l.symbol} ${l.mint}: ${JSON.stringify(l.status)}`);
  // The same network it was started on: its mint is on this network's chain once step 1 confirmed.
  if (l.status.token && !(await conn.getAccountInfo(new PublicKey(l.mint), "confirmed"))) {
    die(`${l.mint} isn't on X1 ${info.network}; resume it on the site it was started on`);
  }
  if (!live) { console.log("check only: nothing sent (add --live to continue it)"); process.exit(0); }
  await finish(l.mint);
  process.exit(0);
}

// A new launch.
const pct = (k, min, max, dflt) => {
  const v = flag(k) ?? dflt;
  if (v === undefined) die(`--${k} is required`);
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) die(`--${k} must be from ${min} to ${max} (percent)`);
  return Math.round(n * 100);
};
const supply = flag("supply") ?? die("--supply is required (whole tokens, 1,000 to 10,000,000,000)");
const lock = flag("lock") ?? "forever";
const params = {
  name: flag("name") ?? die("--name is required (up to 32 characters)"),
  symbol: flag("symbol") ?? die("--symbol is required (up to 10 letters/digits)"),
  description: flag("description") ?? "",
  image: flag("image") ?? "",
  ...(flag("website") ? { website: flag("website") } : {}),
  ...(flag("twitter") ? { twitter: flag("twitter") } : {}),
  ...(flag("telegram") ? { telegram: flag("telegram") } : {}),
  supply, poolTokens: supply, // the whole supply goes into the pool
  taxBps: pct("tax", 1, 10),
  autoLpBps: pct("lp", 0, 50, "25"),
  burnBps: pct("burn", 0, 50, "0"),
  quote: flag("pair") ?? "XNT",
  poolXnt: flag("pool") ?? die("--pool is required (how much XNT, or pair token, goes into the pool)"),
  lockDays: lock === "forever" ? "forever" : Number(lock),
};
if (params.autoLpBps + params.burnBps > 5500) die("--lp + --burn can't exceed 55% of the tax (10% goes to the creator; holders keep at least 35%)");
if (info.lockForeverOnly && params.lockDays !== "forever") die("this site only allows locking the liquidity forever (--lock forever)");
if (info.launchesPaused) die(`launches are paused: ${info.launchesPaused}`);

// What it costs, and whether the wallet can pay.
const xnt = (await conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
const feeHeld = async (mint) => {
  const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  return r.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
};
const fee = Number(info.feeAmount);
const feeHave = await feeHeld(info.feeMint);
const pairXnt = params.quote === "XNT" ? Number(params.poolXnt) : 0;
const vault = !!info.taxVault?.launches && params.quote === "XNT";
const gas = vault ? 0 : Number(info.gasXnt);
const xntNeed = pairXnt + Number(info.poolCreateFeeXnt ?? 0.1) + gas + 0.05;
console.log(`
launch ${params.name} (${params.symbol}) on ${info.network}
  supply      ${Number(supply).toLocaleString("en-US")}, all of it into a ${params.symbol}/${params.quote} pool with ${params.poolXnt} ${params.quote}
  tax         ${params.taxBps / 100}% on every transfer, fixed forever; of the tax: ${params.autoLpBps / 100}% to liquidity, ${params.burnBps / 100}% burned,
              ${info.creatorBps / 100}% to you (the creator), the rest (${(10000 - params.autoLpBps - params.burnBps - info.creatorBps) / 100}%) to holders in XNT
  liquidity   locked ${params.lockDays === "forever" ? "FOREVER (can never be withdrawn)" : `for ${params.lockDays} days`}
  cost        launch fee ${fee} ${info.feeSymbol} (you hold ${feeHave})
              about ${xntNeed.toFixed(3)} XNT: pool ${pairXnt}, XDEX pool fee ${info.poolCreateFeeXnt ?? "~0.1"}, ${gas ? `distributor gas ${gas}, ` : ""}network fees ~0.05 (you hold ${xnt.toFixed(3)})`);
const short = [];
if (feeHave < fee) short.push(`${fee} ${info.feeSymbol} for the launch fee`);
if (xnt < xntNeed) short.push(`${xntNeed.toFixed(3)} XNT`);
if (short.length) die(`the wallet needs ${short.join(" and ")}${info.network === "testnet" ? ` (testnet: ${site}/faucet)` : ""}`);
const maxCost = flag("max-cost");
if (maxCost !== undefined && xntNeed > Number(maxCost)) die(`this launch needs about ${xntNeed.toFixed(3)} XNT, over --max-cost ${maxCost}`);
if (!live) { console.log("\ncheck only: nothing sent. Add --live to launch (the tax and a forever lock can't be changed afterwards)."); process.exit(0); }

const { mint } = await signAndSend("1. create the token (pays the launch fee)", "/api/launch/token", { ...params, creator });
console.log(`mint: ${mint}   (if anything below fails: node launch.mjs --keypair ${keyPath} --resume ${mint} --live)`);
await finish(mint);
