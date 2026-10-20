/**
 * Bridge USDC.X from an X1 wallet to Solana USDC with Warp Bridge (bridge.x1.xyz). The bridge pays out to
 * the SAME public key on Solana, so the wallet's keypair also controls the USDC there (it holds no SOL
 * at first: send it some before moving the USDC on Solana). The bridge creates the Solana USDC account.
 *
 *   npx tsx scripts/bridge-usdc.ts [--keypair ./arb.keypair.json] (--amount <USDC.X> | --all [--keep <USDC.X>]) [--live]
 *   npx tsx scripts/bridge-usdc.ts --status [--keypair ...]
 *
 *   --amount  how much USDC.X to send (the bridge's flat fee, now 1 USDC.X, comes out of it; at least 11 now,
 *             since 10 must arrive after the fee)
 *   --all     the wallet's whole USDC.X balance, less --keep (e.g. --keep 20 leaves 20 for the limit buy)
 *   --live    sign and send; without it the transfer is only checked and simulated
 *   --status  check transfers already sent, without sending anything
 *
 * Before every transfer: the bridge must be unpaused, the USDC route must map USDC.X to Solana USDC with a
 * flat fee of at most 1 USDC.X and no percentage fee, enough X1 guardians must be healthy, and a simulation
 * must debit exactly the amount. Each transfer is written to state/bridge-usdc.json before it is sent; one
 * that hasn't been seen arriving on Solana blocks the next, so a transfer is never sent twice. After
 * sending, this waits for X1 finality and the Solana receipt (usually a minute or two); if it gives up
 * waiting, run --status later.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { loadKeypair } from "../src/config.js";

const API = "https://api.bridge.mainnet.x1.xyz";
const PROGRAM = new PublicKey("6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD");
const USDCX = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MAX_FEE = 1_000_000n; // 1 USDC.X
const MIN_XNT = 10_000_000; // keep 0.01 XNT for the transaction fee
const JOURNAL = path.join(process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state"), "bridge-usdc.json");

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(problem);
  console.error("usage: npx tsx scripts/bridge-usdc.ts [--keypair ./arb.keypair.json] (--amount <USDC.X> | --all [--keep <USDC.X>]) [--live]\n"
    + "       npx tsx scripts/bridge-usdc.ts --status [--keypair ...]   (see the file's header)");
  process.exit(problem ? 1 : 0);
}
if (has("help") || has("h")) usage();
const units = (name: string) => {
  const x = flag(name);
  if (x === undefined || !/^\d+(\.\d{1,6})?$/.test(x)) usage(`--${name} takes a USDC.X amount with at most 6 decimals`);
  const [whole, frac = ""] = x.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
};
const usdc = (raw: bigint) => (Number(raw) / 1e6).toFixed(6).replace(/\.?0+$/, "");
const fail = (problem: string): never => { console.error(`stopped: ${problem}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conn = new Connection(process.env.REFLECT_RPC_URL ?? "https://rpc.mainnet.x1.xyz", "confirmed");
const wallet: Keypair = loadKeypair(flag("keypair") ?? "./arb.keypair.json");
const owner = wallet.publicKey;
const ata = getAssociatedTokenAddressSync(USDCX, owner, false, TOKEN_2022_PROGRAM_ID);

type Entry = { signature: string; wallet: string; amountRaw: string; feeRaw: string; status: "pending_x1" | "pending_solana" | "completed" | "failed";
  createdAt: string; solanaSignature?: string };
const readJournal = (): Entry[] => (fs.existsSync(JOURNAL) ? JSON.parse(fs.readFileSync(JOURNAL, "utf8")).entries : []);
const writeJournal = (entries: Entry[]) => {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.writeFileSync(`${JOURNAL}.tmp`, JSON.stringify({ entries }, null, 2));
  fs.renameSync(`${JOURNAL}.tmp`, JOURNAL);
};

async function api(p: string) {
  const r = await fetch(API + p, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`bridge API ${p}: HTTP ${r.status}`);
  return r.json();
}

async function bridgeConfig() {
  const data = await api("/config");
  const x1 = data.x1, sol = data.solana;
  if (x1.config.programId !== PROGRAM.toBase58() || sol.config.programId !== PROGRAM.toBase58()) fail("the bridge program changed");
  if (x1.config.paused || sol.config.paused) fail("the bridge is paused");
  const route = (chain: any, mint: string, native: boolean) => {
    const t = chain.tokens.filter((t: any) => t.symbol === "USDC");
    if (t.length !== 1 || t[0].mint !== mint || t[0].decimals !== 6 || t[0].isNative !== native || t[0].paused) fail("the USDC route changed or is paused");
    return t[0];
  };
  const token = route(x1, USDCX.toBase58(), false);
  route(sol, SOL_USDC, true);
  if (BigInt(token.flatFeeAmount) > MAX_FEE || Number(token.percentageFeeBps) !== 0) fail(`the bridge fee is now ${usdc(BigInt(token.flatFeeAmount))} USDC.X + ${token.percentageFeeBps} bps`);
  if (Number(x1.config.flatFeeLamports) !== 0 || Number(x1.config.percentageFeeBps) !== 0) fail("the bridge now charges a native fee");
  const guardians = (await api("/guardians")).guardians as any[];
  const healthy = guardians.filter((g) => g.status === "healthy" && g.watches === "x1" && sol.config.guardians.includes(g.pubkey)).length;
  if (healthy < Number(sol.config.threshold)) fail(`only ${healthy} of the ${sol.config.threshold} X1 guardians needed are healthy`);
  return { token, feeCollector: new PublicKey(x1.config.feeCollector), feeCollectorAta: new PublicKey(token.feeCollectorAta), healthy, threshold: Number(sol.config.threshold) };
}

async function balance() {
  const info = await conn.getAccountInfo(ata);
  return info ? unpackAccount(ata, info, TOKEN_2022_PROGRAM_ID).amount : 0n;
}

/** Did the Solana payout credit this wallet with at least `minimum` USDC? */
async function solanaReceipt(signature: string, minimum: bigint) {
  const r = await fetch(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }] }) });
  const tx = (await r.json()).result;
  if (!tx) return false;
  if (tx.meta.err) fail(`the Solana payout ${signature} failed`);
  const sum = (rows: any[] = []) => rows.filter((b) => b.owner === owner.toBase58() && b.mint === SOL_USDC).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  if (sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances) < minimum) fail(`the Solana payout ${signature} credited less than ${usdc(minimum)} USDC`);
  return true;
}

/** Move each unfinished transfer along; true when none is left unfinished. */
async function reconcile(entries: Entry[]) {
  for (const e of entries.filter((e) => e.wallet === owner.toBase58())) {
    if (e.status === "pending_x1") {
      const s = (await conn.getSignatureStatuses([e.signature], { searchTransactionHistory: true })).value[0];
      if (!s || s.confirmationStatus !== "finalized") {
        if (!s && Date.now() - Date.parse(e.createdAt) > 5 * 60_000) { e.status = "failed"; writeJournal(entries); console.log(`${e.signature}: never landed on X1, nothing was sent`); continue; }
        return false;
      }
      e.status = s.err ? "failed" : "pending_solana";
      writeJournal(entries);
      if (s.err) { console.log(`${e.signature}: failed on X1, nothing was sent`); continue; }
    }
    if (e.status === "pending_solana") {
      const r = await api(`/transactions/${e.signature}`);
      const tx = r?.transaction ?? r;
      if (!tx || !["executed", "completed"].includes(tx.status) || !tx.destTxSig) return false;
      if (!(await solanaReceipt(tx.destTxSig, BigInt(e.amountRaw) - BigInt(e.feeRaw)))) return false;
      e.status = "completed";
      e.solanaSignature = tx.destTxSig;
      writeJournal(entries);
      console.log(`${usdc(BigInt(e.amountRaw) - BigInt(e.feeRaw))} USDC arrived on Solana: https://solscan.io/tx/${tx.destTxSig}`);
    }
  }
  return true;
}

function bridgeOut(amount: bigint, slot: number, blockhash: string, feeCollector: PublicKey, feeCollectorAta: PublicKey) {
  // The bridge client's sequence: top nibble 1 = from X1, next nibble 0 = to Solana.
  const seq = (1n << 60n) | (BigInt(slot) * 1000n);
  const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
  const outgoing = pda(Buffer.from("evt_out"), u64(seq));
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const ix = new TransactionInstruction({ programId: PROGRAM,
    keys: [w(pda(Buffer.from("config"))), w(pda(Buffer.from("token_registry"), USDCX.toBuffer())), w(outgoing), w(owner, true), w(ata), w(USDCX),
      r(PROGRAM), r(PROGRAM), w(feeCollector), w(feeCollectorAta), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId)],
    data: Buffer.concat([Buffer.from([27, 194, 57, 119, 215, 165, 247, 150]), u64(seq), u64(amount)]) });
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ix] }).compileToV0Message();
  return new VersionedTransaction(message);
}

async function waitForArrival(entries: Entry[]) {
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until) {
    if (await reconcile(entries)) return true;
    await sleep(10_000);
  }
  console.log("still on its way; check later with: npx tsx scripts/bridge-usdc.ts --status");
  return false;
}

const entries = readJournal();
if (has("status")) {
  const mine = entries.filter((e) => e.wallet === owner.toBase58());
  const done = await reconcile(entries);
  for (const e of mine) console.log(`${e.createdAt}  ${usdc(BigInt(e.amountRaw))} USDC.X  ${e.status}  x1 ${e.signature}${e.solanaSignature ? `  solana ${e.solanaSignature}` : ""}`);
  console.log(mine.length ? (done ? "nothing pending" : "a transfer is still on its way") : "no transfers yet");
  process.exit(0);
}
if (has("amount") === has("all")) usage("give --amount or --all");
if (!(await reconcile(entries))) fail("an earlier transfer hasn't arrived on Solana yet (see --status); nothing sent");

const cfg = await bridgeConfig();
const held = await balance();
const want = has("all") ? held - (has("keep") ? units("keep") : 0n) : units("amount");
const fee = BigInt(cfg.token.flatFeeAmount);
const min = BigInt(cfg.token.minAmount), max = BigInt(cfg.token.maxAmount), cap = BigInt(cfg.token.dailyCapRemaining);
if (want > held) fail(`the wallet holds ${usdc(held)} USDC.X, less than ${usdc(want)}`);
// The bridge's minimum applies after its fee: what arrives on Solana must be at least minAmount.
if (want - fee < min) fail(`the bridge needs at least ${usdc(min + fee)} USDC.X (${usdc(min)} arriving after the ${usdc(fee)} fee); asked for ${usdc(want)}`);
if (want > max || want > cap) fail(`the bridge takes at most ${usdc(max < cap ? max : cap)} USDC.X right now`);
const xnt = await conn.getBalance(owner);
if (xnt < MIN_XNT) fail("the wallet needs at least 0.01 XNT for the transaction fee");

const { blockhash } = await conn.getLatestBlockhash("confirmed");
const slot = await conn.getSlot("confirmed");
const tx = bridgeOut(want, slot, blockhash, cfg.feeCollector, cfg.feeCollectorAta);
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, accounts: { encoding: "base64", addresses: [ata.toBase58()] } });
if (sim.value.err) fail(`the simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`);
const after = unpackAccount(ata, { ...(await conn.getAccountInfo(ata))!, data: Buffer.from(sim.value.accounts![0]!.data[0], "base64") }, TOKEN_2022_PROGRAM_ID).amount;
if (held - after !== want) fail(`the simulation would debit ${usdc(held - after)} USDC.X, not ${usdc(want)}`);

console.log(`bridge ${usdc(want)} USDC.X from X1 ${owner.toBase58()}`);
console.log(`  to Solana ${owner.toBase58()} (same key): ${usdc(want - fee)} USDC after the ${usdc(fee)} USDC.X bridge fee`);
console.log(`  leaves ${usdc(held - want)} USDC.X on X1; guardians ${cfg.healthy} healthy (${cfg.threshold} needed); simulation passed`);
if (!has("live")) { console.log("dry run: nothing sent (add --live to send)"); process.exit(0); }

tx.sign([wallet]);
const signature = bs58.encode(tx.signatures[0]);
entries.push({ signature, wallet: owner.toBase58(), amountRaw: want.toString(), feeRaw: fee.toString(), status: "pending_x1", createdAt: new Date().toISOString() });
writeJournal(entries);
const sent = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 0, minContextSlot: sim.context.slot });
if (sent !== signature) fail(`the RPC returned signature ${sent}, expected ${signature}; the journal keeps the transfer reserved`);
console.log(`sent: https://explorer.x1.xyz/tx/${signature}\nwaiting for X1 finality and the Solana payout...`);
// Exit 2 while it is still on its way, so a caller (scripts/googl-bridge-buy.ts) doesn't carry on without it.
if (!(await waitForArrival(entries))) process.exit(2);
