/**
 * Read-only: compare every registered launch's vault with its record, the comparison the site's
 * crank makes each pass (vaultBinding in src/factory/launch.ts). Run it before deploying the crank
 * that makes it: a pool that differs stops that token's sales. Reads launch.json files and RPC; exits 1
 * if anything differs.
 *
 *   REFLECT_FACTORY_DIR=<factory dir> npx tsx scripts/check-vault-bindings.ts --rpc <url> [--program <tax_vault id>]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TAX_VAULT_PROGRAM_ID, decodeVault, vaultPda } from "../src/taxvault.js";
import { registeredLaunches, vaultBinding } from "../src/factory/launch.js";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const rpc = flag("rpc");
if (!rpc) throw new Error("Usage: REFLECT_FACTORY_DIR=<dir> npx tsx scripts/check-vault-bindings.ts --rpc <url> [--program <id>]");
const conn = new Connection(rpc, "confirmed");
const program = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);

const launches = registeredLaunches();
const addrs = launches.map((r) => vaultPda(r.vaultProgram ? new PublicKey(r.vaultProgram) : program, new PublicKey(r.mint)));
let wrong = 0, none = 0;
for (let i = 0; i < launches.length; i += 100) {
  const infos = await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100), "confirmed");
  infos.forEach((info, j) => {
    const r = launches[i + j];
    if (!info) { none++; return; }
    const v = decodeVault(addrs[i + j], info.data);
    const b = vaultBinding(r, v);
    const problems = [
      ...(b.poolWrong ? [`POOL DIFFERS: vault ${v.pool.toBase58()}, record ${r.pool}`] : []),
      ...(b.nftWrong ? [`CREATOR NFT DIFFERS: vault ${v.creatorNft.toBase58()}, record ${r.lockNft}`] : []),
      ...b.unverified.map((f) => `not in the record, so not compared: ${f}`),
    ];
    if (b.poolWrong || b.nftWrong) wrong++;
    console.log(`${r.symbol} ${r.mint}: ${problems.length ? problems.join("; ") : "matches its record"}`);
  });
}
console.log(`${launches.length} registered, ${none} with no vault, ${wrong} off their record`);
process.exit(wrong ? 1 : 0);
