/**
 * Empty a retired distributor wallet (its token moved to the Tax Vault): first pay the
 * holders its journal still says are owed, then send the rest of its XNT to `--to`.
 * Token dust in its token accounts stays where it is.
 *
 *   npx tsx scripts/sweep-retired-distributor.ts --keypair <distributor key> --to <wallet> \
 *     [--state <distributor-state.json>] [--rpc <url>]          # dry run
 *   ... --execute                                                 # send it
 *
 * Refuses while the wallet can still withdraw a token's tax (it must be retired first).
 */
import fs from "node:fs";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { loadKeypair } from "../src/config.js";
import { run, withPriority } from "../src/tx.js";

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const keyFile = arg("--keypair"), to = arg("--to");
if (!keyFile || !to) throw new Error("Usage: npx tsx scripts/sweep-retired-distributor.ts --keypair <file> --to <wallet> [--state <file>] [--rpc <url>] [--execute]");
const execute = args.includes("--execute");
const conn = new Connection(arg("--rpc") ?? "https://rpc.testnet.x1.xyz", "confirmed");
const key = loadKeypair(keyFile);
const dest = new PublicKey(to);
const xnt = (l: bigint | number) => `${(Number(l) / LAMPORTS_PER_SOL).toFixed(9)} XNT`;

// Still a withdraw authority of any Token-2022 mint it holds? Then it isn't retired.
const accounts = await conn.getParsedTokenAccountsByOwner(key.publicKey, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed");
for (const mint of new Set(accounts.value.map((a) => a.account.data.parsed.info.mint as string))) {
  const info = await conn.getAccountInfo(new PublicKey(mint), "confirmed");
  const fee = info && getTransferFeeConfig(unpackMint(new PublicKey(mint), info, TOKEN_2022_PROGRAM_ID));
  if (fee?.withdrawWithheldAuthority.equals(key.publicKey)) throw new Error(`Refusing: this wallet can still withdraw ${mint}'s tax; migrate the token first.`);
}

const state = arg("--state") && fs.existsSync(arg("--state")!) ? JSON.parse(fs.readFileSync(arg("--state")!, "utf8")) : {};
const owedRaw = Object.entries((state.owed ?? {}) as Record<string, string>).map(([w, a]) => [new PublicKey(w), BigInt(a)] as const).filter(([, a]) => a > 0n);
// A wallet with no account can only receive at least the rent-exempt minimum: it gets that
// instead of a smaller amount owed (the difference comes out of what is swept).
const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(0));
const existing = owedRaw.length ? await conn.getMultipleAccountsInfo(owedRaw.map(([w]) => w), "confirmed") : [];
const owed = owedRaw.map(([w, a], i) => [w, !existing[i] && a < rentMin ? rentMin : a, a] as const);
const balance = BigInt(await conn.getBalance(key.publicKey, "confirmed"));
const owedTotal = owed.reduce((s, [, a]) => s + a, 0n);
const FEE_ROOM = 20_000n; // the two transactions' fees (tiny limits, see fitComputeLimit)
const rest = balance - owedTotal - FEE_ROOM;
console.log(`Wallet ${key.publicKey.toBase58()}: ${xnt(balance)}`);
for (const [w, a, was] of owed) console.log(`  pay ${w.toBase58()} the ${xnt(was)} it is owed${a !== was ? ` (as ${xnt(a)}: a new wallet's minimum balance)` : ""}`);
console.log(`  then send ${xnt(rest > 0n ? rest : 0n)} to ${dest.toBase58()}`);
if (rest <= 0n && !owed.length) { console.log("Nothing to sweep."); process.exit(0); }
if (!execute) { console.log("\nDry run. Add --execute to send."); process.exit(0); }

if (owed.length) {
  const sig = await run(conn, withPriority(owed.map(([w, a]) => SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: w, lamports: a })), 1_000, 10_000), key);
  console.log(`Paid owed holders: ${sig}`);
}
// Everything left but the last transaction's fee (the wallet may close to 0 lamports).
const left = BigInt(await conn.getBalance(key.publicKey, "confirmed"));
const probe = new Transaction({ feePayer: key.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash })
  .add(...withPriority([SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: dest, lamports: 1 })], 1_000, 10_000));
const fee = BigInt((await conn.getFeeForMessage(probe.compileMessage(), "confirmed")).value ?? 10_000);
if (left > fee) {
  const sig = await run(conn, withPriority([SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: dest, lamports: left - fee })], 1_000, 10_000), key);
  console.log(`Sent ${xnt(left - fee)} to ${dest.toBase58()}: ${sig}`);
}
