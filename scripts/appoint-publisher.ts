/**
 * Appoint a new rewards-list publisher for a Tax Vault token, without the site: what the
 * token's creator (the vault's guardian) runs if the publisher has published nothing for 7
 * days (e.g. 99 + Tax went offline). The program refuses it any earlier.
 *
 *   npx tsx scripts/appoint-publisher.ts --rpc <url> --keypair <creator wallet file> \
 *     --mint <token mint> --new-publisher <address> [--program <tax_vault id>]     # dry run
 *   ... --execute                                                                  # send it
 *
 * The new publisher then runs the standalone crank with its key:
 *   npx tsx scripts/crank.ts --rpc <url> --keypair <fee wallet> --mint <mint> --publisher <its key file>
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TAX_VAULT_PROGRAM_ID, appointAllowedAt, appointPublisherIx, decodeVault, vaultPda } from "../src/taxvault.js";
import { run, simulate, sign, withPriority } from "../src/tx.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const need = (name: string) => flag(name) ?? (console.error(`Usage: npx tsx scripts/appoint-publisher.ts --rpc <url> --keypair <creator wallet> --mint <mint> --new-publisher <address> [--program <id>] [--execute]\nmissing --${name}`), process.exit(2));
const conn = new Connection(need("rpc"), "confirmed");
const guardian = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(need("keypair")), "utf8"))));
const mint = new PublicKey(need("mint"));
const newPublisher = new PublicKey(need("new-publisher"));
const program = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);
const execute = argv.includes("--execute");

const addr = vaultPda(program, mint);
const info = await conn.getAccountInfo(addr, "confirmed");
if (!info || !info.owner.equals(program)) throw new Error(`No Tax Vault for ${mint.toBase58()} under ${program.toBase58()}`);
const v = decodeVault(addr, info.data);
const when = (s: number) => new Date(s * 1000).toISOString();
console.log(`Vault ${addr.toBase58()} (v${v.version})`);
console.log(`  publisher now   ${v.publisher.toBase58()}   last list published ${when(v.lastPublishAt)}`);
console.log(`  guardian        ${v.guardian.toBase58()}`);
console.log(`  new publisher   ${newPublisher.toBase58()}`);
if (!v.guardian.equals(guardian.publicKey)) throw new Error(`This wallet (${guardian.publicKey.toBase58()}) isn't the vault's guardian; only the token's creator can appoint.`);
const allowed = appointAllowedAt(v);
if (allowed !== null && Date.now() / 1000 < allowed) {
  console.log(`\nNot yet: the publisher published a list on ${when(v.lastPublishAt)}; appointing opens ${when(allowed)} if no list is published before then.`);
  process.exit(1);
}

const ixs = withPriority([appointPublisherIx(program, guardian.publicKey, mint, newPublisher)], 10_000, 50_000);
if (!execute) {
  await simulate(conn, (await sign(conn, ixs, guardian)).tx);
  console.log("\nDry run: the transaction simulates OK. Add --execute to send it.");
  process.exit(0);
}
const sig = await run(conn, ixs, guardian);
console.log(`\nAppointed ${newPublisher.toBase58()}: ${sig}`);
console.log("Next: the new publisher runs scripts/crank.ts with --publisher <its key file> to publish lists again.");
