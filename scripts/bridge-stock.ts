/**
 * Bridge an xStock (GOOGLx, SPYx, ...) from Solana to X1 with Warp Bridge (bridge.x1.xyz). The bridge pays
 * out to the SAME public key on X1 (the arb wallet by default, where the GOOGL.X peg and limit buys trade it).
 * The reverse of scripts/bridge-usdc.ts; buy the stock on Solana first with scripts/solana-swap.ts.
 *
 *   npx tsx scripts/bridge-stock.ts [--stock GOOGL] (--amount <shares> | --all) [--keypair ./arb.keypair.json] [--live]
 *   npx tsx scripts/bridge-stock.ts --status [--keypair ...]
 *
 *   --stock   the bridge's symbol for it (GOOGL, SPY, META, TSLA, ...); default GOOGL
 *   --amount  how much to send, in raw shares (wallets show xStocks times a small dividend multiplier,
 *             e.g. 0.0544 for 0.05427 raw; this takes the raw figure); --all sends the whole balance
 *   --live    sign and send; without it the transfer is only checked and simulated
 *   --status  check transfers already sent, without sending anything
 *
 * Before every transfer: the bridge must be unpaused, the stock's route must map its Solana mint to the X1
 * mint, the fee must be a percentage of at most 0.25% with no flat fee, enough Solana guardians must be
 * healthy, and a simulation must debit exactly the amount. Each transfer is written to
 * state/bridge-stock.json before it is sent; one that hasn't been seen arriving on X1 blocks the next.
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { loadKeypair } from "../src/config.js";

const API = "https://api.bridge.mainnet.x1.xyz";
const PROGRAM = new PublicKey("6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD");
const MAX_FEE_BPS = 25;
const MIN_SOL = 3_000_000; // keep 0.003 SOL for the fee (and the outgoing-message account's rent)
const JOURNAL = path.join(process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state"), "bridge-stock.json");

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/bridge-stock.ts [--stock GOOGL] (--amount <shares> | --all) [--keypair ./arb.keypair.json] [--live]\n"
    + "       npx tsx scripts/bridge-stock.ts --status [--keypair ...]   (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const fail = (problem: string): never => { console.error(`stopped: ${problem}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sol = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const x1 = new Connection(process.env.REFLECT_RPC_URL ?? "https://rpc.mainnet.x1.xyz", "confirmed");
const wallet: Keypair = loadKeypair(flag("keypair") ?? "./arb.keypair.json");
const owner = wallet.publicKey;
const symbol = (flag("stock") ?? "GOOGL").toUpperCase().replace(/X$/, "").replace(/\.$/, "");

type Entry = { signature: string; wallet: string; symbol: string; x1Mint: string; decimals: number; amountRaw: string; feeBps: number;
  status: "pending_solana" | "pending_x1" | "completed" | "failed"; createdAt: string; x1Signature?: string };
const readJournal = (): Entry[] => (fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, "utf8")).entries : []);
const writeJournal = (entries: Entry[]) => {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.writeFileSync(`${JOURNAL}.tmp`, JSON.stringify({ entries }, null, 2));
  fs.renameSync(`${JOURNAL}.tmp`, JOURNAL);
};
const shares = (raw: bigint, dec: number) => (Number(raw) / 10 ** dec).toFixed(dec).replace(/\.?0+$/, "");

async function api(p: string) {
  const r = await fetch(API + p, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`bridge API ${p}: HTTP ${r.status}`);
  return r.json();
}

async function bridgeConfig() {
  const data = await api("/config");
  const src = data.solana, dst = data.x1;
  if (src.config.programId !== PROGRAM.toBase58() || dst.config.programId !== PROGRAM.toBase58()) fail("the bridge program changed");
  if (src.config.paused || dst.config.paused) fail("the bridge is paused");
  const a = src.tokens.filter((t: any) => t.symbol === symbol), b = dst.tokens.filter((t: any) => t.symbol === symbol);
  if (a.length !== 1 || b.length !== 1) fail(`the bridge has no ${symbol} route (symbols: ${src.tokens.map((t: any) => t.symbol).join(", ")})`);
  const token = a[0], x1Token = b[0];
  if (!token.isNative || x1Token.isNative || token.decimals !== x1Token.decimals || token.paused || x1Token.paused) fail(`the ${symbol} route changed or is paused`);
  if (BigInt(token.flatFeeAmount) !== 0n || Number(token.percentageFeeBps) > MAX_FEE_BPS) fail(`the ${symbol} bridge fee is now ${token.flatFeeAmount} flat + ${token.percentageFeeBps} bps`);
  if (Number(src.config.flatFeeLamports) !== 0 || Number(src.config.percentageFeeBps) !== 0) fail("the bridge now charges a native fee");
  const guardians = (await api("/guardians")).guardians as any[];
  const healthy = guardians.filter((g) => g.status === "healthy" && g.watches === "sol" && dst.config.guardians.includes(g.pubkey)).length;
  if (healthy < Number(dst.config.threshold)) fail(`only ${healthy} of the ${dst.config.threshold} Solana guardians needed are healthy`);
  return { token, x1Token, feeCollector: new PublicKey(src.config.feeCollector), healthy, threshold: Number(dst.config.threshold) };
}

const accountBalance = async (conn: Connection, mint: PublicKey) => {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata);
  return { ata, amount: info ? unpackAccount(ata, info, TOKEN_2022_PROGRAM_ID).amount : 0n };
};

/** Did the X1 payout credit this wallet with at least `minimum` of the stock? */
async function x1Receipt(signature: string, mint: string, minimum: bigint) {
  const tx = await x1.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx) return false;
  if (tx.meta?.err) fail(`the X1 payout ${signature} failed`);
  const sum = (rows: any[] = []) => rows.filter((b) => b.owner === owner.toBase58() && b.mint === mint).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  if (sum(tx.meta!.postTokenBalances!) - sum(tx.meta!.preTokenBalances!) < minimum) fail(`the X1 payout ${signature} credited less than expected`);
  return true;
}

/** Move each unfinished transfer along; true when none is left unfinished. */
async function reconcile(entries: Entry[]) {
  for (const e of entries.filter((e) => e.wallet === owner.toBase58())) {
    if (e.status === "pending_solana") {
      const s = (await sol.getSignatureStatuses([e.signature], { searchTransactionHistory: true })).value[0];
      if (!s || s.confirmationStatus !== "finalized") {
        if (!s && Date.now() - Date.parse(e.createdAt) > 5 * 60_000) { e.status = "failed"; writeJournal(entries); console.log(`${e.signature}: never landed on Solana, nothing was sent`); continue; }
        return false;
      }
      e.status = s.err ? "failed" : "pending_x1";
      writeJournal(entries);
      if (s.err) { console.log(`${e.signature}: failed on Solana, nothing was sent`); continue; }
    }
    if (e.status === "pending_x1") {
      const r = await api(`/transactions/${e.signature}`);
      const tx = r?.transaction ?? r;
      if (!tx || !["executed", "completed"].includes(tx.status) || !tx.destTxSig) return false;
      const net = BigInt(e.amountRaw) - (BigInt(e.amountRaw) * BigInt(e.feeBps)) / 10_000n - 1n; // 1 unit of rounding room
      if (!(await x1Receipt(tx.destTxSig, e.x1Mint, net))) return false;
      e.status = "completed";
      e.x1Signature = tx.destTxSig;
      writeJournal(entries);
      console.log(`${e.symbol} arrived on X1: https://explorer.x1.xyz/tx/${tx.destTxSig}`);
    }
  }
  return true;
}

function bridgeOut(mint: PublicKey, amount: bigint, slot: number, blockhash: string, feeCollector: PublicKey, feeCollectorAta: PublicKey) {
  // The bridge client's sequence: top nibble 0 = from Solana, next nibble 1 = to X1.
  const seq = (1n << 56n) | (BigInt(slot) * 1000n);
  const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
  const vault = pda(Buffer.from("vault"), mint.toBuffer());
  const vaultAta = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const ix = new TransactionInstruction({ programId: PROGRAM,
    keys: [w(pda(Buffer.from("config"))), w(pda(Buffer.from("token_registry"), mint.toBuffer())), w(pda(Buffer.from("evt_out"), u64(seq))), w(owner, true),
      w(getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID)), w(mint), w(vault), w(vaultAta), w(feeCollector), w(feeCollectorAta),
      r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([27, 194, 57, 119, 215, 165, 247, 150]), u64(seq), u64(amount)]) });
  return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
}

const entries = readJournal();
if (has("status")) {
  const mine = entries.filter((e) => e.wallet === owner.toBase58());
  const done = await reconcile(entries);
  for (const e of mine) console.log(`${e.createdAt}  ${shares(BigInt(e.amountRaw), e.decimals)} ${e.symbol}  ${e.status}  solana ${e.signature}${e.x1Signature ? `  x1 ${e.x1Signature}` : ""}`);
  console.log(mine.length ? (done ? "nothing pending" : "a transfer is still on its way") : "no transfers yet");
  process.exit(0);
}
if (has("amount") === has("all")) usage("give --amount or --all");
if (!(await reconcile(entries))) fail("an earlier transfer hasn't arrived on X1 yet (see --status); nothing sent");

const cfg = await bridgeConfig();
const mint = new PublicKey(cfg.token.mint), dec = Number(cfg.token.decimals);
const { amount: held } = await accountBalance(sol, mint);
let want = held;
if (has("amount")) {
  const x = flag("amount")!;
  if (!new RegExp(`^\\d+(\\.\\d{1,${dec}})?$`).test(x)) usage(`--amount takes a number with at most ${dec} decimals`);
  const [whole, frac = ""] = x.split(".");
  want = BigInt(whole) * 10n ** BigInt(dec) + BigInt(frac.padEnd(dec, "0"));
}
const feeBps = Number(cfg.token.percentageFeeBps);
const fee = (want * BigInt(feeBps)) / 10_000n;
const min = BigInt(cfg.token.minAmount), max = BigInt(cfg.token.maxAmount), cap = BigInt(cfg.token.dailyCapRemaining);
if (want > held) fail(`the wallet holds ${shares(held, dec)} ${symbol}x (raw), less than ${shares(want, dec)}`);
if (want - fee < min) fail(`the bridge needs at least about ${shares(min + (min * BigInt(feeBps)) / 10_000n + 1n, dec)} ${symbol}x (asked for ${shares(want, dec)})`);
if (want > max || want > cap) fail(`the bridge takes at most ${shares(max < cap ? max : cap, dec)} ${symbol}x right now`);
if ((await sol.getBalance(owner)) < MIN_SOL) fail("the wallet needs at least 0.003 SOL for the fee");

// A finalized blockhash: the public RPC balances over nodes, and one may not have seen a newer one yet.
const { blockhash } = await sol.getLatestBlockhash("finalized");
const slot = await sol.getSlot("confirmed");
const tx = bridgeOut(mint, want, slot, blockhash, cfg.feeCollector, new PublicKey(cfg.token.feeCollectorAta));
const { ata } = await accountBalance(sol, mint);
const sim = await sol.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [ata.toBase58()] } });
if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
const after = unpackAccount(ata, { ...(await sol.getAccountInfo(ata))!, data: Buffer.from(sim.value.accounts![0]!.data[0], "base64") }, TOKEN_2022_PROGRAM_ID).amount;
if (held - after !== want) fail(`the simulation would debit ${shares(held - after, dec)}, not ${shares(want, dec)}`);

const x1Before = (await accountBalance(x1, new PublicKey(cfg.x1Token.mint))).amount;
console.log(`bridge ${shares(want, dec)} ${symbol}x (raw) from Solana ${owner.toBase58()}`);
console.log(`  to X1 ${owner.toBase58()} (same key): about ${shares(want - fee, dec)} ${cfg.x1Token.displaySymbol ?? symbol} after the ${feeBps / 100}% bridge fee`);
console.log(`  leaves ${shares(held - want, dec)} on Solana; X1 now holds ${shares(x1Before, dec)}; guardians ${cfg.healthy} healthy (${cfg.threshold} needed); simulation passed`);
if (!has("live")) { console.log("dry run: nothing sent (add --live to send)"); process.exit(0); }

tx.sign([wallet]);
const signature = bs58.encode(tx.signatures[0]);
entries.push({ signature, wallet: owner.toBase58(), symbol, x1Mint: cfg.x1Token.mint, decimals: dec, amountRaw: want.toString(), feeBps,
  status: "pending_solana", createdAt: new Date().toISOString() });
writeJournal(entries);
const sent = await sol.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, minContextSlot: sim.context.slot });
if (sent !== signature) fail(`the RPC returned signature ${sent}, expected ${signature}; the journal keeps the transfer reserved`);
console.log(`sent: https://solscan.io/tx/${signature}\nwaiting for Solana finality and the X1 payout...`);
const until = Date.now() + 15 * 60_000;
while (Date.now() < until) {
  if (await reconcile(entries)) process.exit(0);
  await sleep(10_000);
}
console.log("still on its way; check later with: npx tsx scripts/bridge-stock.ts --status");
process.exit(2);
