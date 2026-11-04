/**
 * The dust sweep page (src/sweep.html) on its own, for trying it on this machine before it's on the site:
 *
 *   npm run sweep-page                       # http://127.0.0.1:8127/sweep, mainnet, buys TEST
 *   npm run sweep-page -- --port 9003 --to <mint> --rpc <url>
 *
 * Same endpoints the site gives it (src/factory/sweep.ts): it builds unsigned transactions, the browser
 * wallet signs them, and it relays only fully signed transactions through the same checks as the site's
 * /api/send. It binds to localhost and answers only requests addressed to itself.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { createSweep, slippageOf } from "./factory/sweep.js";
import { sendSigned, unsignedTx } from "./web/wallet-tx.js";

const ROOT = path.join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const port = Number(arg("--port") ?? 8127);
const TO = new PublicKey(arg("--to") ?? "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz"); // TEST
const conn = new Connection(arg("--rpc") ?? "https://rpc.mainnet.x1.xyz", "confirmed");
const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const sweep = createSweep({ conn, xdex: XDEX, microLamports: 1000 });
const build = (payer: PublicKey, ixs: Parameters<typeof unsignedTx>[2]) => unsignedTx(conn, payer, ixs, [], { microLamports: 1000 });
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const web = (f: string) => path.join(ROOT, "src", "web", f);

function themeCss() {
  const [head, extra = ""] = fs.readFileSync(web("theme-receipt.css"), "utf8").split("/* AFTER BASE */");
  return head + fs.readFileSync(web("theme-base.css"), "utf8") + extra;
}
const files: Record<string, [string, () => string | Buffer]> = {
  "/sweep": ["text/html; charset=utf-8", () => fs.readFileSync(path.join(ROOT, "src", "sweep.html"), "utf8")],
  "/wallet.js": ["text/javascript", () => fs.readFileSync(web("wallet.js"), "utf8")],
  "/i18n.js": ["text/javascript; charset=utf-8", () => fs.readFileSync(web("i18n.js"), "utf8")],
  "/theme.js": ["text/javascript; charset=utf-8", () => `const SITE_THEME = "receipt";\nconst SITE_NET = ${JSON.stringify({ network: "mainnet", other: null })};\n` + fs.readFileSync(web("theme.js"), "utf8")],
  "/theme.css": ["text/css; charset=utf-8", themeCss],
  "/vendor/web3.js": ["text/javascript", () => fs.readFileSync(path.join(ROOT, "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js"))],
};

async function api(url: URL, body: Record<string, unknown> | null) {
  if (url.pathname === "/api/info") return { explorer: "https://explorer.mainnet.x1.xyz", network: "mainnet" };
  const bal = /^\/api\/balance\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
  if (bal) return { xnt: (await conn.getBalance(new PublicKey(bal[1]), "confirmed")) / 1e9 };
  if (url.pathname === "/api/sweep/scan") {
    const owner = url.searchParams.get("owner");
    if (!owner) return { targets: [{ mint: TO.toBase58() }] };
    return sweep.scan(new PublicKey(owner), TO);
  }
  if (!body) return null;
  if (url.pathname === "/api/sweep/sell") {
    const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 60).map((a) => new PublicKey(String(a)).toBase58()) : [];
    return sweep.sell(new PublicKey(String(body.owner)), TO, accounts, body.close !== false, slippageOf(body.slippageBps), build);
  }
  if (url.pathname === "/api/sweep/buy") {
    const signatures = Array.isArray(body.signatures) ? body.signatures.slice(0, 12).map(String).filter((x) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(x)) : [];
    return sweep.buy(new PublicKey(String(body.owner)), TO, { signatures, useWrapped: body.useWrapped === true, addRent: body.addRent !== false, hadWrapped: body.hadWrapped === true, slippageBps: slippageOf(body.slippageBps) }, build);
  }
  // Only transactions this server built (their programs were allowed when it built them), fully signed.
  if (url.pathname === "/api/send") return { signature: await sendSigned(conn, String(body.tx)) };
  return null;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 200_000) req.destroy(); });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Error("bad JSON")); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (!hosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/") { res.writeHead(302, { location: "/sweep" }).end(); return; }
  if (url.pathname === "/theme-receipt.css") { res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(themeCss()); return; }
  const logo = /^\/brand\/(logo-(?:512|192|64|32|wide-120)\.png)$/.exec(url.pathname);
  if (logo || url.pathname === "/favicon.ico") { res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" }).end(fs.readFileSync(web(path.join("brand", logo ? logo[1] : "logo-64.png")))); return; }
  const file = files[url.pathname];
  if (file) { res.writeHead(200, { "content-type": file[0], "cache-control": "no-store" }).end(file[1]()); return; }
  if (!url.pathname.startsWith("/api/")) { res.writeHead(404).end("Not found"); return; }
  try {
    if (req.method === "POST" && ![...hosts].some((h) => req.headers.origin === `http://${h}`)) { res.writeHead(403).end("Forbidden origin"); return; }
    const out = await api(url, req.method === "POST" ? await readJson(req) : null);
    if (!out) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
});
server.on("error", (e: NodeJS.ErrnoException) => { console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Try: npm run sweep-page -- --port <another>` : e.message); process.exit(1); });
server.listen(port, "127.0.0.1", () => console.log(`Dust sweep (mainnet, into ${TO.toBase58().slice(0, 4)}…): http://127.0.0.1:${port}/sweep`));
