/**
 * Swap on Solana through Jupiter from a local keypair (the arb wallet by default, the same key that receives
 * bridged USDC on Solana, see scripts/bridge-usdc.ts). Quotes, builds and simulates; sends only with --live.
 *
 *   npx tsx scripts/solana-swap.ts --in <mint|USDC|SOL> --out <mint|GOOGLx> --amount <in units> [--slippage 0.5] [--keypair ./arb.keypair.json] [--live]
 *
 * Before sending: the simulation must succeed, spend no more than --amount of the input token, and leave the
 * wallet at least 0.002 SOL. After sending it waits for finality and prints what actually arrived.
 */
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadKeypair } from "../src/config.js";

const ALIAS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  GOOGLx: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
};
const JUP = "https://lite-api.jup.ag/swap/v1";
const MIN_SOL = 2_000_000; // lamports left for later fees

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/solana-swap.ts --in <mint|USDC|SOL> --out <mint|GOOGLx> --amount <in units> [--slippage 0.5] [--keypair ./arb.keypair.json] [--live]");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const fail = (problem: string): never => { console.error(`stopped: ${problem}`); process.exit(1); };
const mintOf = (x: string | undefined, name: string) => { if (!x) usage(`--${name} is required`); const m = ALIAS[x] ?? x; new PublicKey(m); return m; };

const inMint = mintOf(flag("in"), "in"), outMint = mintOf(flag("out"), "out");
if (inMint === outMint) usage("--in and --out are the same token");
const amountText = flag("amount") ?? usage("--amount is required");
if (!/^\d+(\.\d+)?$/.test(amountText)) usage("--amount takes a number");
const slippageBps = Math.round(Number(flag("slippage") ?? 0.5) * 100);
if (!(slippageBps > 0 && slippageBps <= 300)) usage("--slippage is a percent, at most 3");

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const wallet: Keypair = loadKeypair(flag("keypair") ?? "./arb.keypair.json");
const owner = wallet.publicKey.toBase58();

async function getJson(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${url.split("?")[0]}: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function decimalsOf(mint: string) {
  if (mint === ALIAS.SOL) return 9;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const d = (info.value?.data as any)?.parsed?.info?.decimals;
  if (typeof d !== "number") fail(`${mint} isn't a token mint`);
  return d as number;
}
/** The wallet's balance of a mint, in base units (SOL: lamports, wrapped included). */
async function held(mint: string) {
  let total = 0n;
  if (mint === ALIAS.SOL) total += BigInt(await conn.getBalance(wallet.publicKey));
  const accounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  for (const a of accounts.value) total += BigInt((a.account.data as any).parsed.info.tokenAmount.amount);
  return total;
}

const [inDec, outDec] = await Promise.all([decimalsOf(inMint), decimalsOf(outMint)]);
const [whole, frac = ""] = amountText.split(".");
if (frac.length > inDec) usage(`--amount has more than ${inDec} decimals`);
const amount = BigInt(whole) * 10n ** BigInt(inDec) + BigInt(frac.padEnd(inDec, "0") || "0");
const fmt = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toFixed(dec).replace(/\.?0+$/, "");

const inBefore = await held(inMint), outBefore = await held(outMint), solBefore = await conn.getBalance(wallet.publicKey);
if (inBefore < amount) fail(`the wallet holds ${fmt(inBefore, inDec)}, less than ${amountText}`);

const quote = await getJson(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`);
if (quote.inputMint !== inMint || quote.outputMint !== outMint || BigInt(quote.inAmount) !== amount) fail("the quote doesn't match the request");
const out = BigInt(quote.outAmount), minOut = BigInt(quote.otherAmountThreshold);
const price = (Number(amount) / 10 ** inDec) / (Number(out) / 10 ** outDec);
console.log(`swap ${amountText} ${flag("in")} -> ${fmt(out, outDec)} ${flag("out")} (at least ${fmt(minOut, outDec)}; ${price.toFixed(4)} per ${flag("out")})`);
console.log(`  route: ${quote.routePlan.map((r: any) => r.swapInfo.label).join(" > ")}; price impact ${(Number(quote.priceImpactPct) * 100).toFixed(3)}%; wallet ${owner}`);

const built = await getJson(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 200_000, priorityLevel: "medium" } } }) });
const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
if (tx.message.staticAccountKeys[0].toBase58() !== owner) fail("the swap transaction's fee payer isn't this wallet");

const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
console.log(`  simulation passed (${sim.value.unitsConsumed} compute units)`);
if (!has("live")) { console.log("dry run: nothing sent (add --live to send)"); process.exit(0); }

tx.sign([wallet]);
const signature = bs58.encode(tx.signatures[0]);
await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
console.log(`sent: https://solscan.io/tx/${signature}`);
const { blockhash, lastValidBlockHeight } = { blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight as number };
const res = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "finalized");
if (res.value.err) fail(`the swap failed on chain: ${JSON.stringify(res.value.err)}`);

const inAfter = await held(inMint), outAfter = await held(outMint), solAfter = await conn.getBalance(wallet.publicKey);
const spent = inBefore - inAfter, got = outAfter - outBefore;
console.log(`done: spent ${fmt(spent, inDec)} ${flag("in")}, received ${fmt(got, outDec)} ${flag("out")} (${((Number(spent) / 10 ** inDec) / (Number(got) / 10 ** outDec)).toFixed(4)} each); fees ${fmt(BigInt(solBefore - solAfter), 9)} SOL`);
if (got < minOut) console.log(`warning: received less than the quoted minimum ${fmt(minOut, outDec)}`);
if (solAfter < MIN_SOL) console.log("warning: the wallet is low on SOL for further fees");
