/**
 * Buy GOOGL.X through Solana, once: bridge USDC.X from X1 to Solana, buy GOOGLx there on Jupiter, bridge it back to X1 as GOOGL.X
 * (where the arb bot's peg sells it into the GOOGL.X/USDC.X pool when that's above the reference). It pays when the
 * X1 pool is far enough above Solana's price to cover the bridges: a flat 1 USDC.X out, 0.25% back.
 *
 *   npx tsx scripts/googl-bridge-buy.ts --amount <USDC.X> [--json]  # preview: what it should end with
 *   npx tsx scripts/googl-bridge-buy.ts --amount <USDC.X> --live    # execute all three steps
 *
 * The preview prices every step from live quotes: the bridge's fees, Jupiter's quote for the USDC, and selling the
 * GOOGL.X that arrives into the X1 pool now (fee and price impact included). Prices move in the minutes the bridges
 * take, so the result can differ. A live run does the steps with scripts/bridge-usdc.ts, scripts/solana-swap.ts and
 * scripts/bridge-stock.ts, each simulating and checking before it sends, and stops at the first one that fails or
 * is still on its way (rerun that script's --status, then the remaining steps by hand). The local button for this
 * is src/googl-page.ts (npm run googl).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { XDEX_PROGRAM_IDS } from "../src/config.js";
import { quoteSell, snapshot } from "../src/xdex.js";

const ROOT = path.join(import.meta.dirname, "..");
const BRIDGE_API = "https://api.bridge.mainnet.x1.xyz";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GOOGLX_SOL = "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN";
const GOOGLX_X1 = new PublicKey("E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5");
const USDCX = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const GOOGL_POOL = new PublicKey("8MFEMQNdgES25bfhNuo2xAmbES6kiPHhKD27cZwkT2dj"); // GOOGL.X/USDC.X, the peg's pool

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/googl-bridge-buy.ts --amount <USDC.X> [--json | --live]   (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const amountText = flag("amount") ?? usage("--amount is required");
if (!/^\d+(\.\d{1,6})?$/.test(amountText)) usage("--amount takes a USDC.X amount with at most 6 decimals");
const amount = Number(amountText);

export async function preview(usdcx: number) {
  const cfg = await (await fetch(`${BRIDGE_API}/config`, { signal: AbortSignal.timeout(15_000) })).json();
  const usdcRoute = cfg.x1.tokens.find((t: any) => t.symbol === "USDC");
  const googlRoute = cfg.solana.tokens.find((t: any) => t.symbol === "GOOGL");
  if (!usdcRoute || !googlRoute) throw new Error("the bridge has no USDC or GOOGL route");
  const usdcFee = Number(usdcRoute.flatFeeAmount) / 1e6 + (usdcx * Number(usdcRoute.percentageFeeBps)) / 10_000;
  const usdcMin = Number(usdcRoute.minAmount) / 1e6 + usdcFee;
  const usdcArrives = usdcx - usdcFee;
  if (usdcArrives <= 0) throw new Error(`${usdcx} USDC.X doesn't cover the bridge fee`);

  const raw = BigInt(Math.round(usdcArrives * 1e6));
  const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL_USDC}&outputMint=${GOOGLX_SOL}&amount=${raw}&slippageBps=50`,
    { signal: AbortSignal.timeout(15_000) })).json();
  if (!q.outAmount) throw new Error(`no Jupiter quote: ${JSON.stringify(q).slice(0, 160)}`);
  const googlx = Number(q.outAmount) / 1e8;
  const solanaPrice = usdcArrives / googlx;

  const googlFeeBps = Number(googlRoute.percentageFeeBps);
  const googlArrives = BigInt(q.outAmount) - (BigInt(q.outAmount) * BigInt(googlFeeBps)) / 10_000n - BigInt(googlRoute.flatFeeAmount);
  const googlMin = Number(googlRoute.minAmount) / 1e8;

  const conn = new Connection(process.env.REFLECT_RPC_URL ?? "https://rpc.mainnet.x1.xyz", "confirmed");
  const sale = await quoteSell(conn, new PublicKey(XDEX_PROGRAM_IDS.mainnet), GOOGL_POOL, GOOGLX_X1, googlArrives,
    { maxImpactBps: 5_000, slippageBps: 0 }, USDCX);
  if (!sale) throw new Error("couldn't quote selling GOOGL.X into the X1 pool");
  const endUsdcx = Number(sale.expectedOut) / 1e6;
  const poolPrice = endUsdcx / (Number(googlArrives) / 1e8);
  // The pool's price now: what the GOOGL.X is worth if the peg sells it a slice at a time as buyers lift the pool,
  // instead of all at once.
  const snap = await snapshot(conn, new PublicKey(XDEX_PROGRAM_IDS.mainnet), GOOGL_POOL, GOOGLX_X1, USDCX);
  const spot = (Number(snap.reserveQuote) / 1e6) / (Number(snap.reserveToken) / 1e8);
  const heldUsdcx = spot * (Number(googlArrives) / 1e8);
  return {
    amount: usdcx,
    bridgeOutFee: usdcFee,
    usdcOnSolana: usdcArrives,
    googlx,
    solanaPrice,
    route: q.routePlan.map((r: any) => r.swapInfo.label).join(" > "),
    bridgeBackFeePct: googlFeeBps / 100,
    googlOnX1: Number(googlArrives) / 1e8,
    x1SalePrice: poolPrice,
    saleImpactPct: Number(sale.priceImpactBps) / 100,
    /** Selling it all into the X1 pool at once. */
    endUsdcx,
    profit: endUsdcx - usdcx,
    profitPct: ((endUsdcx - usdcx) / usdcx) * 100,
    /** At the X1 pool's price now (sold gradually by the peg); the pool's depth in GOOGL.X. */
    x1SpotPrice: spot,
    poolGoogl: Number(snap.reserveToken) / 1e8,
    heldUsdcx,
    heldProfit: heldUsdcx - usdcx,
    heldProfitPct: ((heldUsdcx - usdcx) / usdcx) * 100,
    /** Below these the bridges refuse it. */
    tooSmall: usdcx < usdcMin ? `the USDC bridge needs at least ${usdcMin} USDC.X` : googlx < googlMin * 1.003 ? `the GOOGL bridge needs at least ${googlMin} GOOGLx` : null,
  };
}

/** Run one step's script, echoing its output; resolves with the output, rejects on a failing or pending exit. */
function step(title: string, script: string, args: string[]): Promise<string> {
  console.log(`\n== ${title}`);
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", path.join("scripts", script), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; process.stdout.write(d); });
    child.on("close", (code) => code === 0 ? resolve(out)
      : reject(new Error(code === 2 ? `${title}: still on its way; check with npx tsx scripts/${script} --status, then run the remaining steps`
        : `${title} stopped (exit ${code}); nothing after it was run`)));
  });
}

const p = await preview(amount);
if (has("json")) { console.log(JSON.stringify(p)); process.exit(0); }
const f = (v: number, d = 2) => v.toFixed(d);
console.log(`Buy GOOGL.X through Solana with ${p.amount} USDC.X:`);
console.log(`  1. bridge to Solana: ${f(p.usdcOnSolana, 6)} USDC arrives (fee ${p.bridgeOutFee} USDC.X)`);
console.log(`  2. buy on Jupiter: ${p.googlx.toFixed(8)} GOOGLx at $${f(p.solanaPrice)} (${p.route})`);
console.log(`  3. bridge to X1: ${p.googlOnX1.toFixed(8)} GOOGL.X arrives (fee ${p.bridgeBackFeePct}%)`);
const sg = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${f(v, d)}`;
console.log(`  worth at the X1 pool's price now ($${f(p.x1SpotPrice)}, ${f((p.x1SpotPrice / p.solanaPrice - 1) * 100)}% vs Solana): ${f(p.heldUsdcx, 4)} USDC.X -> ${sg(p.heldProfit, 4)} (${sg(p.heldProfitPct)}%)`);
console.log(`  sold all at once into the pool (${f(p.poolGoogl, 4)} GOOGL.X deep): ${f(p.endUsdcx, 4)} USDC.X at $${f(p.x1SalePrice)}, impact ${f(p.saleImpactPct)}% -> ${sg(p.profit, 4)} (${sg(p.profitPct)}%)`);
if (p.tooSmall) { console.log(`  too small: ${p.tooSmall}`); process.exit(has("live") ? 1 : 0); }
if (!has("live")) { console.log("preview: nothing sent (add --live to run it)"); process.exit(0); }

try {
  const out1 = await step("1/3 bridge USDC.X to Solana", "bridge-usdc.ts", ["--amount", amountText, "--live"]);
  const arrived = out1.match(/([\d.]+) USDC arrived on Solana/)?.[1];
  if (!arrived) throw new Error("couldn't read how much USDC arrived; run the swap by hand");
  await step("2/3 buy GOOGLx on Jupiter", "solana-swap.ts", ["--in", "USDC", "--out", "GOOGLx", "--amount", arrived, "--live"]);
  await step("3/3 bridge GOOGLx to X1", "bridge-stock.ts", ["--stock", "GOOGL", "--all", "--live"]);
  console.log("\ndone: the GOOGL.X is in the arb wallet on X1; the peg sells it when the pool is above its band");
} catch (e) {
  console.error(`\nstopped: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
