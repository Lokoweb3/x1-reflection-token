/**
 * How many accounts can one X1 transaction touch? The on-chain holder split (vault v4) reads every
 * holder's token account in a snapshot batch, so this number sets the batch size.
 *
 *   npx tsx scripts/bench-account-limit.ts --keypair <payer.json> [--url https://rpc.testnet.x1.xyz]
 *
 * Creates one address lookup table holding 250 throwaway read-only addresses, then *simulates*
 * (never sends) a 1-lamport self transfer that also references the first N of them, for growing N,
 * and prints the largest N the cluster accepts and the error past it. Costs one lookup-table create
 * and extend (rent is reclaimable after deactivation); nothing else is sent.
 */
import fs from "node:fs";
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  TransactionMessage, VersionedTransaction, type AddressLookupTableAccount,
} from "@solana/web3.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const url = arg("url") ?? "https://rpc.testnet.x1.xyz";
const kpPath = arg("keypair");
if (!kpPath) { console.error("usage: --keypair <payer.json> [--url <rpc>]"); process.exit(1); }
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
const conn = new Connection(url, "confirmed");
const TOTAL = 250;

async function send(ixs: Parameters<TransactionMessage["constructor"]>[0]["instructions"]) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

async function main() {
  console.log(`payer ${payer.publicKey.toBase58()} on ${url}, balance ${(await conn.getBalance(payer.publicKey)) / 1e9}`);
  const addrs = Array.from({ length: TOTAL }, () => Keypair.generate().publicKey);
  const slot = await conn.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  console.log("create table", table.toBase58(), await send([createIx]));
  for (let i = 0; i < TOTAL; i += 30) {
    const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: payer.publicKey, payer: payer.publicKey, addresses: addrs.slice(i, i + 30) });
    await send([ix]);
  }
  // A table's new entries are usable from the next slot.
  await new Promise((r) => setTimeout(r, 2000));
  const alt = (await conn.getAddressLookupTable(table)).value as AddressLookupTableAccount;
  console.log("table entries", alt.state.addresses.length);

  const tryN = async (n: number) => {
    const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 });
    ix.keys.push(...addrs.slice(0, n).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })));
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ix] }).compileToV0Message([alt]);
    const tx = new VersionedTransaction(msg); tx.sign([payer]);
    const total = msg.staticAccountKeys.length + n;
    try {
      const r = await conn.simulateTransaction(tx, { sigVerify: false });
      return { n, total, ok: !r.value.err, err: r.value.err ? JSON.stringify(r.value.err) : null, bytes: tx.serialize().length };
    } catch (e) {
      return { n, total, ok: false, err: e instanceof Error ? e.message.slice(0, 160) : String(e), bytes: null };
    }
  };
  for (const n of [32, 56, 59, 60, 61, 62, 63, 64, 100, 120, 123, 124, 125, 126, 160, 200, 250]) {
    const r = await tryN(n);
    console.log(`${String(n).padStart(3)} extra (${r.total} accounts in all, ${r.bytes ?? "?"} bytes): ${r.ok ? "accepted" : `rejected ${r.err}`}`);
  }
  console.log(`lookup table ${table.toBase58()} left in place; deactivate and close it to reclaim its rent.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
