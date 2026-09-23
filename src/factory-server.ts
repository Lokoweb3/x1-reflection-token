/**
 * Token factory: a launch page where anyone connects a wallet and launches a tax token
 * whose tax pays holders in XNT (with auto-LP), with its launch LP locked in an NFT.
 *
 *   npm run factory                     # http://127.0.0.1:8124 (factory.port in config.json)
 *
 * "/" is the 99 + Tax landing page, "/launch" the launch app.
 *
 * The creator's wallet signs every transaction; the server only builds them, co-signs
 * with the new mint's throwaway key, and broadcasts what the wallet signed. Each token
 * gets its own distributor wallet, generated and kept here (factory/launches/<mint>/),
 * which `npm run factory:distribute` uses to collect, sell and pay out that token's tax.
 *
 * It listens on 127.0.0.1 by default. To make it public, put it behind a reverse proxy
 * (HTTPS) and list the public host name in factory.hosts.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { FACTORY_DIR, ROOT, connection, loadConfig } from "./config.js";
import { sendSigned, unsignedTx } from "./web/wallet-tx.js";
import {
  FEE_USDC, buildLockStep, buildPoolStep, buildTokenStep, launchStatus, listLaunches, readLaunch, registerLaunch,
  registeredLaunches, validateParams,
} from "./factory/launch.js";
import { XDEX_CREATE } from "./xdex.js";

const cfg = loadConfig();
const conn = connection(cfg);
const f = cfg.factory;
if (!f?.feeReceiver) throw new Error("Set factory.feeReceiver (and factory.feeUsdc) in config.json.");
if (!cfg.locker?.programId) throw new Error("Set locker.programId in config.json.");
const port = f.port ?? 8124;
const bind = f.bind ?? "127.0.0.1";
const publicUrl = f.publicUrl ?? `http://127.0.0.1:${port}`;
const explorer = `https://explorer.${cfg.network}.x1.xyz`;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(f.hosts ?? [])]);
const LANDING = path.join(ROOT, "src", "landing.html");
const PAGE = path.join(ROOT, "src", "factory.html");
const WALLET_JS = path.join(ROOT, "src", "web", "wallet.js");
const WEB3_BUNDLE = path.join(ROOT, "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
const opts = { microLamports: cfg.distribution.priorityMicroLamports };

// Starting a launch generates keys and files, so cap it per client address.
const recent = new Map<string, number[]>();
function rateLimit(ip: string, max = 10, windowMs = 3_600_000) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) throw new Error("Too many launches started from this address; try again later.");
  hits.push(now);
  recent.set(ip, hits);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64_000) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); } });
  });
}

/** The launch record for `mint`, checked to belong to `creator`. */
function ownLaunch(body: Record<string, unknown>) {
  const r = readLaunch(String(body.mint));
  if (!r) throw new Error("Unknown launch");
  if (r.creator !== new PublicKey(String(body.creator)).toBase58()) throw new Error("This launch belongs to another wallet");
  return r;
}

async function post(url: string, body: Record<string, unknown>, ip: string) {
  if (url === "/api/launch/token") {
    rateLimit(ip);
    const p = validateParams(body);
    const { ixs, signers, record } = await buildTokenStep(conn, cfg, p, publicUrl);
    return { tx: await unsignedTx(conn, new PublicKey(p.creator), ixs, signers, opts), mint: record.mint };
  }
  if (url === "/api/launch/pool") {
    const r = ownLaunch(body);
    const s = await launchStatus(conn, cfg, r);
    if (!s.token) throw new Error("Step 1 (token) hasn't confirmed yet.");
    if (s.pool) throw new Error("The pool already exists.");
    const { ixs } = buildPoolStep(cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, [], opts) };
  }
  if (url === "/api/launch/lock") {
    const r = ownLaunch(body);
    const s = await launchStatus(conn, cfg, r);
    if (!s.pool) throw new Error("Step 2 (pool) hasn't confirmed yet.");
    if (s.lock) throw new Error("The LP is already locked.");
    const { ixs, signers } = await buildLockStep(conn, cfg, r);
    return { tx: await unsignedTx(conn, new PublicKey(r.creator), ixs, signers, opts) };
  }
  if (url === "/api/launch/register") {
    const r = await registerLaunch(conn, cfg, ownLaunch(body));
    return { registered: !!r.registeredAt };
  }
  if (url === "/api/send") return { signature: await sendSigned(conn, String(body.tx)) };
  return null;
}

async function get(url: URL) {
  if (url.pathname === "/api/info") {
    const ammInfo = await conn.getAccountInfo(new PublicKey(XDEX_CREATE[cfg.network].ammConfig));
    return {
      network: cfg.network, explorer, feeUsdc: f!.feeUsdc, feeMint: FEE_USDC[cfg.network], feeReceiver: f!.feeReceiver,
      gasXnt: f!.gasXnt ?? "0.05", poolCreateFeeXnt: ammInfo ? Number(ammInfo.data.readBigUInt64LE(36)) / 1e9 : null,
      lockerProgram: cfg.locker!.programId, xdexProgram: cfg.xdex.programId,
    };
  }
  if (url.pathname === "/api/launches") {
    const creator = new PublicKey(url.searchParams.get("creator") ?? "").toBase58();
    const mine = listLaunches().filter((r) => r.creator === creator).slice(0, 20);
    return Promise.all(mine.map(async (r) => ({ ...publicView(r), status: await launchStatus(conn, cfg, r) })));
  }
  if (url.pathname === "/api/tokens") return registeredLaunches().map((r) => ({ ...publicView(r), paid: tokenPayouts(r.mint) }));
  if (url.pathname === "/api/stats") return stats();
  return null;
}

/** Totals from one launched token's distributor activity log. */
function tokenPayouts(mint: string) {
  const file = path.join(FACTORY_DIR, "launches", mint, "state", "events.jsonl");
  const out = { xntPaid: 0n, xntToLiquidity: 0n, burned: 0n, wallets: new Set<string>(), payouts: 0 };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.kind === "payout") { out.xntPaid += BigInt(e.total ?? 0); out.payouts++; for (const [w] of e.payments ?? []) out.wallets.add(w); }
        if (e.kind === "auto-lp") out.xntToLiquidity += BigInt(e.xnt ?? 0);
        if (e.kind === "burn") out.burned += BigInt(e.tokens ?? 0);
      } catch { /* skip a torn line */ }
    }
  }
  return { xntPaid: out.xntPaid.toString(), xntToLiquidity: out.xntToLiquidity.toString(), burned: out.burned.toString(), wallets: out.wallets.size, payouts: out.payouts };
}

/** Headline numbers for the landing page, across every launched token. */
let statsCache: { at: number; data: unknown } | null = null;
function stats() {
  if (statsCache && Date.now() - statsCache.at < 30_000) return statsCache.data;
  const tokens = registeredLaunches();
  let xntPaid = 0n, xntToLiquidity = 0n, launchXnt = 0, wallets = 0, payouts = 0;
  for (const t of tokens) {
    const p = tokenPayouts(t.mint);
    xntPaid += BigInt(p.xntPaid); xntToLiquidity += BigInt(p.xntToLiquidity);
    wallets += p.wallets; payouts += p.payouts; launchXnt += Number(t.poolXnt);
  }
  const data = {
    tokens: tokens.length, xntPaid: xntPaid.toString(), xntToLiquidity: xntToLiquidity.toString(),
    walletsPaid: wallets, payouts, launchLiquidityXnt: launchXnt,
    lockedForever: tokens.filter((t) => t.lockDays === null).length,
  };
  statsCache = { at: Date.now(), data };
  return data;
}

/** A launch without anything secret (the record never holds keys, but be explicit). */
function publicView(r: ReturnType<typeof listLaunches>[number]) {
  const { mint, name, symbol, description, image, supply, taxBps, autoLpBps, poolTokens, poolXnt, lockDays, pool, creator, createdAt, registeredAt, distributor } = r;
  const burnBps = r.burnBps ?? 0;
  return { mint, name, symbol, description, image, supply, taxBps, autoLpBps, burnBps, poolTokens, poolXnt, lockDays, pool, creator, createdAt, registeredAt, distributor };
}

const send = (res: http.ServerResponse, code: number, body: unknown, type = "application/json") =>
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(type === "application/json" ? JSON.stringify(body) : body as string);

const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  const url = new URL(req.url ?? "/", "http://localhost");
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  try {
    if (req.method === "POST") {
      const origin = req.headers.origin ?? "";
      if (![...allowedHosts].some((h) => origin === `http://${h}` || origin === `https://${h}`)) { res.writeHead(403).end("Forbidden origin"); return; }
      const out = await post(url.pathname, await readJson(req), ip);
      if (!out) { res.writeHead(404).end("Not found"); return; }
      send(res, 200, out);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") { send(res, 200, fs.readFileSync(LANDING, "utf8"), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/launch") { send(res, 200, fs.readFileSync(PAGE, "utf8"), "text/html; charset=utf-8"); return; }
    if (url.pathname === "/wallet.js") { send(res, 200, fs.readFileSync(WALLET_JS, "utf8"), "text/javascript"); return; }
    if (url.pathname === "/vendor/web3.js") { res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" }).end(fs.readFileSync(WEB3_BUNDLE)); return; }
    const meta = /^\/meta\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(url.pathname);
    if (meta) {
      const r = readLaunch(meta[1]);
      if (!r) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=300" })
        .end(JSON.stringify({ name: r.name, symbol: r.symbol, description: r.description, image: r.image }));
      return;
    }
    const out = await get(url);
    if (!out) { res.writeHead(404).end("Not found"); return; }
    send(res, 200, out);
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use; set factory.port in config.json.` : e.message);
  process.exit(1);
});
server.listen(port, bind, () => console.log(`Token factory (${cfg.network}): http://${bind}:${port}  (metadata URIs use ${publicUrl})`));
