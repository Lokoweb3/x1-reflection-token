/**
 * Local page with an Execute button for scripts/googl-bridge-buy.ts: bridge USDC.X to Solana, buy GOOGLx on
 * Jupiter, bridge it back to X1 as GOOGL.X, once per click.
 *
 *   npm run googl                   # http://127.0.0.1:8124
 *   npm run googl -- --port 9001
 *
 * It signs with the arb wallet's key (./arb.keypair.json, through the scripts), so it binds to localhost only and
 * answers only its own page (host and origin checked, as in src/dashboard.ts); it isn't for the public site. Execute
 * first quotes it from live prices and shows the result for you to confirm; the server only runs an amount quoted in
 * the last 2 minutes, one at a time. Each run's output is kept in state/googl-bridge-buy.log.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const LOG = path.join(process.env.REFLECT_STATE_DIR ?? path.join(ROOT, "state"), "googl-bridge-buy.log");
const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8124;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

let run: { amount: string; startedAt: number; output: string; done: boolean; ok: boolean | null } | null = null;
let lastPreview: { amount: string; at: number } | null = null;

function script(args: string[], onData?: (s: string) => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/googl-bridge-buy.ts", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (d: Buffer) => { out += d; onData?.(String(d)); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const amountOk = (a: unknown): a is string => typeof a === "string" && /^\d+(\.\d{1,6})?$/.test(a) && Number(a) > 0;

async function action(url: string, body: Record<string, unknown>) {
  if (url === "/api/preview") {
    if (!amountOk(body.amount)) throw new Error("Enter a USDC.X amount");
    const { code, out } = await script(["--amount", body.amount, "--json"]);
    const line = out.trim().split("\n").pop() ?? "";
    if (code !== 0 || !line.startsWith("{")) throw new Error(out.trim().split("\n").slice(-3).join(" ") || "preview failed");
    lastPreview = { amount: body.amount, at: Date.now() };
    return JSON.parse(line);
  }
  if (url === "/api/run") {
    if (!amountOk(body.amount)) throw new Error("Enter a USDC.X amount");
    if (run && !run.done) throw new Error("One is already running");
    if (!lastPreview || lastPreview.amount !== body.amount || Date.now() - lastPreview.at > 120_000) throw new Error("Quote this amount first (quotes last 2 minutes)");
    lastPreview = null;
    const r = { amount: body.amount, startedAt: Date.now(), output: "", done: false, ok: null as boolean | null };
    run = r;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `\n=== ${new Date().toISOString()} execute with ${r.amount} USDC.X\n`);
    void script(["--amount", r.amount, "--live"], (s) => { r.output += s; fs.appendFileSync(LOG, s); })
      .then(({ code }) => { r.done = true; r.ok = code === 0; });
    return { started: true };
  }
  return null;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buy GOOGL.X</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14161a;--muted:#5d6470;--line:#e2e5ea;--up:#13834a;--down:#c62828;--accent:#2457d6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--fg:#e8eaee;--muted:#9aa1ad;--line:#2a2f38;--up:#3ccf7e;--down:#ff6b6b;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:26px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:16px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);width:140px}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.45;cursor:not-allowed}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
.up{color:var(--up)}.down{color:var(--down)}.big{font-size:20px;font-weight:800}
pre{white-space:pre-wrap;word-break:break-all;font:12px/1.45 ui-monospace,monospace;max-height:420px;overflow:auto;margin:0}
.err{color:var(--down);margin-top:8px}
</style></head><body><main>
<h1>Buy GOOGL.X through Solana</h1>
<div class="muted">USDC.X on X1 → USDC on Solana → GOOGLx on Jupiter → GOOGL.X back on X1, for the arb wallet, once per click. The peg then sells the GOOGL.X a slice at a time when the X1 pool is above its band.</div>
<div class="card">
  <div class="row"><input id="amt" inputmode="decimal" placeholder="USDC.X" value="20"><button id="go" class="primary">Execute</button></div>
  <div id="err" class="err"></div>
  <div id="pv"></div>
</div>
<div class="card"><div class="row" style="justify-content:space-between"><b>Progress</b><span id="st" class="muted">idle</span></div><pre id="log" class="muted">Nothing executed yet.</pre></div>
</main><script>
const $=id=>document.getElementById(id), f=(v,d=2)=>Number(v).toFixed(d), sg=(v,d=2)=>(v>=0?"+":"")+f(v,d);
async function post(url,body){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const j=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw new Error(j.error||r.statusText);return j}
function show(p){const tone=v=>v>=0?"up":"down";
  $("pv").innerHTML='<table>'
   +'<tr><td>1. Bridge to Solana</td><td>'+f(p.usdcOnSolana,2)+' USDC arrives (fee '+p.bridgeOutFee+' USDC.X)</td></tr>'
   +'<tr><td>2. Buy on Jupiter</td><td>'+f(p.googlx,6)+' GOOGLx at $'+f(p.solanaPrice)+' ('+p.route+')</td></tr>'
   +'<tr><td>3. Bridge to X1</td><td>'+f(p.googlOnX1,6)+' GOOGL.X arrives (fee '+p.bridgeBackFeePct+'%)</td></tr>'
   +'<tr><td>X1 pool price now</td><td>$'+f(p.x1SpotPrice)+' ('+sg((p.x1SpotPrice/p.solanaPrice-1)*100)+'% vs Solana) · pool holds '+f(p.poolGoogl,4)+' GOOGL.X</td></tr>'
   +'<tr><td>Worth at that price<br><span class="muted">if the peg sells it gradually</span></td><td class="big '+tone(p.heldProfit)+'">'+sg(p.heldProfit)+' USDC.X ('+sg(p.heldProfitPct)+'%)</td></tr>'
   +'<tr><td>Sold all at once<br><span class="muted">impact '+f(p.saleImpactPct)+'%</span></td><td class="'+tone(p.profit)+'">'+sg(p.profit)+' USDC.X ('+sg(p.profitPct)+'%)</td></tr></table>'
   +(p.tooSmall?'<p class="err">Too small: '+p.tooSmall+'</p>':'')}
$("go").onclick=async()=>{const a=$("amt").value.trim();$("err").textContent="";$("pv").innerHTML='<p class="muted">Quoting…</p>';$("go").disabled=true;
 try{const p=await post("/api/preview",{amount:a});show(p);
  if(p.tooSmall)return;
  const msg="Execute with "+a+" USDC.X?\\n\\nBuys "+f(p.googlx,6)+" GOOGLx at $"+f(p.solanaPrice)+" on Solana and bridges it to X1.\\nWorth at the X1 pool price: "+sg(p.heldProfit)+" USDC.X ("+sg(p.heldProfitPct)+"%)"+(p.heldProfit<0?" (a loss at today's prices)":"")+"\\n\\nThis sends real transactions from the arb wallet.";
  if(!confirm(msg))return;
  await post("/api/run",{amount:a});poll();
 }catch(e){$("err").textContent=e.message}finally{$("go").disabled=false}};
async function poll(){const r=await fetch("/api/status").then(r=>r.json());
 if(r.run){$("log").textContent=r.run.output||"Starting…";$("log").scrollTop=1e9;
  $("st").textContent=r.run.done?(r.run.ok?"done":"stopped: see the output"):"running ("+r.run.amount+" USDC.X)…";$("st").className=r.run.done?(r.run.ok?"up":"down"):"muted";
  if(!r.run.done)setTimeout(poll,2000)}}
poll();
</script></body></html>`;

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 10_000) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad JSON")); } });
  });
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this local server (blocks DNS rebinding), and only accept POSTs from its
  // own page (blocks other sites driving it from your browser).
  if (!allowedHosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  if (req.method === "POST") {
    const origin = req.headers.origin ?? "";
    if (![...allowedHosts].some((h) => origin === `http://${h}`)) { res.writeHead(403).end("Forbidden origin"); return; }
    try {
      const out = await action(req.url ?? "", await readJson(req));
      if (!out) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  if (req.url === "/api/status") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ run }));
  } else if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
  } else {
    res.writeHead(404).end("Not found");
  }
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Try: npm run googl -- --port <another port>` : e.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`Buy GOOGL.X: http://127.0.0.1:${port}`));
