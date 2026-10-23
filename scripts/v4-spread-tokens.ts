/**
 * v4 testnet helper: send a holder-pass token from one wallet to every test wallet that has a
 * pass (test-wallets/), so they hold real balances. Each transfer pays the token's tax.
 *
 *   npx tsx scripts/v4-spread-tokens.ts --mint <token> --from <keypair.json> --each <tokens>
 *
 * Testnet only.
 */
import fs from "node:fs";
import path from "node:path";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAccount, getMint } from "@solana/spl-token";
import { loadConfig, loadKeypair } from "../src/config.js";
import { vaultPda } from "../src/taxvault.js";
import { PASSES_PROGRAM_ID, decodePassBook, holderTokenAccount, passBookPda } from "../src/passes.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const PER_TX = 8;

async function main() {
  const cfg = loadConfig();
  if (cfg.network !== "testnet") throw new Error("Testnet only.");
  const [mintArg, fromPath, eachArg] = [arg("mint"), arg("from"), arg("each")];
  if (!mintArg || !fromPath || !eachArg) throw new Error("usage: --mint <token> --from <keypair.json> --each <tokens>");
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const mint = new PublicKey(mintArg);
  const from = loadKeypair(fromPath);
  const { decimals } = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const each = BigInt(Math.round(Number(eachArg) * 10 ** decimals));
  const vault = vaultPda(PASSES_PROGRAM_ID, mint);
  const book = decodePassBook(passBookPda(PASSES_PROGRAM_ID, vault), (await conn.getAccountInfo(passBookPda(PASSES_PROGRAM_ID, vault)))!.data);
  const ours = new Set(fs.readdirSync(path.join(process.cwd(), "test-wallets")).map((f) => f.split(".")[0]));
  const targets = book.entries.filter((e) => ours.has(e.wallet.toBase58()));
  const source = holderTokenAccount(from.publicKey, mint);
  const have = (await getAccount(conn, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const need = each * BigInt(targets.length);
  console.log(`${targets.length} test wallets with passes; sending ${eachArg} each = ${Number(need) / 10 ** decimals} of ${Number(have) / 10 ** decimals}`);
  if (need > have) throw new Error("Not enough tokens in the sending wallet");
  for (let i = 0; i < targets.length; i += PER_TX) {
    const chunk = targets.slice(i, i + PER_TX);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      ...chunk.map((e) => createTransferCheckedInstruction(source, mint, e.tokenAccount, from.publicKey, each, decimals, [], TOKEN_2022_PROGRAM_ID)));
    const sig = await sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
    console.log(`sent to passes ${chunk[0].index + 1}–${chunk[chunk.length - 1].index + 1}: ${sig}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
