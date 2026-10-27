/**
 * Swap on Solana through Jupiter from a local keypair (the arb wallet by default, the same key that receives
 * bridged USDC on Solana, see scripts/bridge-usdc.ts). Quotes, builds and simulates; sends only with --live.
 *
 *   npx tsx scripts/solana-swap.ts --in <mint|USDC|SOL> --out <mint|GOOGLx> --amount <in units> [--slippage 0.5] [--keypair ./arb.keypair.json] [--live]
 *
 * Before sending: every instruction must be one a swap needs (src/swap-guard.ts: no approvals, authority changes,
 * account closes or SOL transfers to anyone but this wallet), and the simulation must succeed with account
 * post-states that spend no more than --amount of the input token, deliver at least the quote's minimum, and cost
 * no more lamports than the fee budget. After sending it waits for finality and prints what actually arrived.
 */
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount,
} from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { loadKeypair } from "../src/config.js";
import { checkSwapEffect, checkSwapInstructions, tokenAccountAmount } from "../src/swap-guard.js";

const ALIAS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  GOOGLx: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
};
const JUP = "https://lite-api.jup.ag/swap/v1";
const MIN_SOL = 2_000_000; // lamports left for later fees
const MAX_PRIORITY = 200_000; // lamports: the priority fee cap asked of Jupiter below

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
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: MAX_PRIORITY, priorityLevel: "medium" } } }) });
const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
if (tx.message.staticAccountKeys[0].toBase58() !== owner) fail("the swap transaction's fee payer isn't this wallet");
const lastValidBlockHeight = built.lastValidBlockHeight;
if (typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight)) fail("Jupiter didn't return a lastValidBlockHeight");

// Only the instructions a swap needs: nothing that approves, re-assigns, closes or pays out to anyone else.
const tables: AddressLookupTableAccount[] = [];
for (const l of tx.message.addressTableLookups) {
  const t = (await conn.getAddressLookupTable(l.accountKey)).value;
  if (!t) fail(`the swap's lookup table ${l.accountKey.toBase58()} doesn't exist`);
  tables.push(t!);
}
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
const bad = checkSwapInstructions(TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables }).instructions, { owner: wallet.publicKey, wsolAta });
if (bad.length) fail(`the swap transaction does more than swap:\n  ${bad.join("\n  ")}`);

// Simulate with the wallet's accounts' post-states and check what it would really move.
const ataFor = async (mint: string) => {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) fail(`${mint} isn't a token mint`);
  return getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, false, info!.owner);
};
const inAta = inMint === ALIAS.SOL ? null : await ataFor(inMint), outAta = outMint === ALIAS.SOL ? null : await ataFor(outMint);
const watched = [wallet.publicKey, wsolAta, ...(inAta ? [inAta] : []), ...(outAta ? [outAta] : [])];
const pre = await conn.getMultipleAccountsInfo(watched, "confirmed");
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: watched.map((k) => k.toBase58()) } });
if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
const post = sim.value.accounts ?? [];
if (post.length !== watched.length) fail("the simulation didn't return the wallet's accounts");
const postData = (i: number) => Buffer.from(post[i]!.data[0], "base64");
const lamportsBefore = (i: number) => BigInt(pre[i]?.lamports ?? 0), lamportsAfter = (i: number) => BigInt(post[i]?.lamports ?? 0);
const amountBefore = (i: number) => (pre[i] ? tokenAccountAmount(pre[i]!.data) : 0n), amountAfter = (i: number) => (post[i] ? tokenAccountAmount(postData(i)) : 0n);
const inIdx = inAta ? 2 : -1, outIdx = outAta ? 2 + (inAta ? 1 : 0) : -1;
// Rent for token accounts the swap opens (the wallet's own) is part of what it may cost.
const newRent = [inIdx, outIdx].filter((i) => i >= 0 && !pre[i] && post[i]).reduce((t, i) => t + lamportsAfter(i), 0n);
const maxFee = 5_000n * BigInt(tx.message.header.numRequiredSignatures) + BigInt(MAX_PRIORITY) + newRent;
const effect = checkSwapEffect({ amount, minOut, maxFee, inIsSol: inMint === ALIAS.SOL, outIsSol: outMint === ALIAS.SOL,
  inDebit: inIdx >= 0 ? amountBefore(inIdx) - amountAfter(inIdx) : 0n, outCredit: outIdx >= 0 ? amountAfter(outIdx) - amountBefore(outIdx) : 0n,
  solDelta: lamportsAfter(0) + lamportsAfter(1) - lamportsBefore(0) - lamportsBefore(1) });
if (effect.length) fail(`the simulated swap doesn't match the quote:\n  ${effect.join("\n  ")}`);
console.log(`  simulation passed (${sim.value.unitsConsumed} compute units); it spends and delivers what the quote says`);
if (!has("live")) { console.log("dry run: nothing sent (add --live to send)"); process.exit(0); }

tx.sign([wallet]);
const signature = bs58.encode(tx.signatures[0]);
await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
console.log(`sent: https://solscan.io/tx/${signature}`);
const res = await conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "finalized");
if (res.value.err) fail(`the swap failed on chain: ${JSON.stringify(res.value.err)}`);

const inAfter = await held(inMint), outAfter = await held(outMint), solAfter = await conn.getBalance(wallet.publicKey);
const spent = inBefore - inAfter, got = outAfter - outBefore;
console.log(`done: spent ${fmt(spent, inDec)} ${flag("in")}, received ${fmt(got, outDec)} ${flag("out")} (${((Number(spent) / 10 ** inDec) / (Number(got) / 10 ** outDec)).toFixed(4)} each); fees ${fmt(BigInt(solBefore - solAfter), 9)} SOL`);
if (got < minOut) console.log(`warning: received less than the quoted minimum ${fmt(minOut, outDec)}`);
if (solAfter < MIN_SOL) console.log("warning: the wallet is low on SOL for further fees");
