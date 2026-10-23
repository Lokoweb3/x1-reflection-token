/**
 * v4 testnet helper: make test holders for a holder-pass token. For each new wallet it funds
 * a little XNT from --funder, buys at least --tokens of the token on XDEX (net of the 5% tax),
 * and registers the wallet's holder pass.
 *
 *   npx tsx scripts/v4-test-wallets.ts --mint <token> --funder <keypair.json> [--count 5]
 *       [--tokens 2200] [--xnt 0.02] [--no-register]
 *
 * Testnet only (refuses mainnet). The new wallets' keys are written to test-wallets/ (git-ignored)
 * so they can sell, receive payouts and be reused.
 */
import fs from "node:fs";
import path from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { loadConfig, loadKeypair } from "../src/config.js";
import { decodeVault, vaultPda } from "../src/taxvault.js";
import { quoteSell, swapIx } from "../src/xdex.js";
import { PASSES_PROGRAM_ID, holderTokenAccount, registerPassIx } from "../src/passes.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (k: string) => process.argv.includes(`--${k}`);

async function main() {
  const cfg = loadConfig();
  if (cfg.network !== "testnet") throw new Error("Testnet only.");
  const mintArg = arg("mint"), funderPath = arg("funder");
  if (!mintArg || !funderPath) throw new Error("usage: --mint <token> --funder <keypair.json> [--count 5] [--tokens 2200] [--xnt 0.02] [--no-register]");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const mint = new PublicKey(mintArg);
  const funder = loadKeypair(funderPath);
  const count = Number(arg("count") ?? 5);
  const wantTokens = BigInt(Math.round(Number(arg("tokens") ?? 2200) * 1e9)); // 9 decimals
  const fundLamports = Math.round(Number(arg("xnt") ?? 0.02) * 1e9);
  const xdex = new PublicKey(cfg.xdex.programId);
  const program = PASSES_PROGRAM_ID;
  const vault = decodeVault(vaultPda(program, mint), (await conn.getAccountInfo(vaultPda(program, mint)))!.data);
  const pool = vault.pool;
  const dir = path.join(process.cwd(), "test-wallets");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  console.log(`funder ${funder.publicKey.toBase58()} (${(await conn.getBalance(funder.publicKey)) / 1e9} XNT), pool ${pool.toBase58()}, ${count} wallets`);

  // XNT needed for wantTokens: double a guess until the quote covers it (the output is net of the tax).
  let spend = 100_000n;
  for (let i = 0; i < 40; i++) {
    const q = await quoteSell(conn, xdex, pool, NATIVE_MINT, spend, { maxImpactBps: 300, slippageBps: 200 }, mint);
    if (q && q.minimumOut >= wantTokens) break;
    spend *= 2n;
  }
  console.log(`each wallet buys with ${Number(spend) / 1e9} XNT`);
  if (BigInt(fundLamports) < spend + 8_000_000n) throw new Error(`--xnt too low: needs at least ${(Number(spend) + 8_000_000) / 1e9} XNT per wallet for the buy, accounts and fees`);

  const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), ...ixs), signers, { commitment: "confirmed" });

  for (let n = 0; n < count; n++) {
    const w = Keypair.generate();
    const file = path.join(dir, `${w.publicKey.toBase58()}.keypair.json`);
    fs.writeFileSync(file, JSON.stringify([...w.secretKey]), { mode: 0o600 });
    await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: w.publicKey, lamports: fundLamports })], [funder]);

    const wxnt = getAssociatedTokenAddressSync(NATIVE_MINT, w.publicKey, false, TOKEN_PROGRAM_ID);
    const dest = holderTokenAccount(w.publicKey, mint);
    const q = await quoteSell(conn, xdex, pool, NATIVE_MINT, spend, { maxImpactBps: 300, slippageBps: 200 }, mint);
    if (!q) throw new Error("No quote for the buy");
    const buy = await send([
      createAssociatedTokenAccountIdempotentInstruction(w.publicKey, wxnt, w.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
      SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: wxnt, lamports: spend }),
      createSyncNativeInstruction(wxnt, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(w.publicKey, dest, w.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      swapIx(xdex, w.publicKey, q, wxnt, dest),
      createCloseAccountInstruction(wxnt, w.publicKey, w.publicKey, [], TOKEN_PROGRAM_ID),
    ], [w]);
    const held = (await getAccount(conn, dest, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    let reg = "";
    if (!has("no-register")) reg = ` · pass ${await send([registerPassIx(program, w.publicKey, mint)], [w])}`;
    console.log(`${n + 1}. ${w.publicKey.toBase58()} holds ${Number(held) / 1e9} · buy ${buy}${reg}`);
  }
  console.log(`keys saved in ${dir}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
