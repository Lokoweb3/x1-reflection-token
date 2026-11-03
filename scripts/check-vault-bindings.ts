/**
 * Read-only: compare registered launches' vaults with their records, the comparison the site's crank
 * makes each pass (vaultBinding in src/factory/launch.ts). Run it before deploying that crank: a pool
 * that differs stops that token's sales. Reads launch records and RPC only.
 *
 *   REFLECT_FACTORY_DIR=<factory dir> npx tsx scripts/check-vault-bindings.ts --rpc <url> [--program <tax_vault id>]
 *   ... --mint <mint>     one token, answered YES or NO
 *
 * Exit 0: verified: every vault token (or this one) matches on both pool and creator NFT.
 * Exit 1: a pool or creator NFT differs from its record.
 * Exit 2: not verified: a field not in the record (the crank doesn't compare it and keeps going), a
 *         vault token with no vault, an unreadable account or record, no such record, or nothing to check.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { FACTORY_DIR } from "../src/config.js";
import { TAX_VAULT_PROGRAM_ID, decodeVault, vaultPda } from "../src/taxvault.js";
import { type LaunchRecord, readLaunch, vaultBinding, vaultManaged } from "../src/factory/launch.js";

const flag = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OK = 0, DIFFERS = 1, UNVERIFIED = 2;
const rpc = flag("rpc"), mintArg = flag("mint");
if (!rpc) { console.error("Usage: REFLECT_FACTORY_DIR=<dir> npx tsx scripts/check-vault-bindings.ts --rpc <url> [--program <id>] [--mint <mint>]"); process.exit(UNVERIFIED); }
const conn = new Connection(rpc, { commitment: "confirmed", disableRetryOnRateLimit: true });
const program = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);
const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

const programOf = (r: LaunchRecord) => (r.vaultProgram ? new PublicKey(r.vaultProgram) : program);
const addrOf = (r: LaunchRecord) => vaultPda(programOf(r), new PublicKey(r.mint));
const hotWallet = (r: LaunchRecord) => { try { return !vaultManaged(r); } catch { return false; } };

/** One registered launch against its vault account. */
function verdict(r: LaunchRecord, info: { owner: PublicKey; data: Buffer } | null): { code: number; kind: "verified" | "differs" | "unverified" | "not-vault"; text: string } {
  if (!info || !info.owner.equals(programOf(r))) {
    if (hotWallet(r)) return { code: OK, kind: "not-vault", text: "not a vault token" };
    return { code: UNVERIFIED, kind: "unverified", text: `NO VAULT under ${programOf(r).toBase58()}: nothing to compare (the creator hasn't started it, or wrong program or RPC)` };
  }
  let v;
  try { v = decodeVault(addrOf(r), info.data); } catch (e) { return { code: UNVERIFIED, kind: "unverified", text: `UNREADABLE vault account: ${msg(e)}` }; }
  const b = vaultBinding(r, v);
  const differs = [
    ...(b.poolWrong ? [`POOL DIFFERS: vault ${v.pool.toBase58()}, record ${r.pool}`] : []),
    ...(b.nftWrong ? [`CREATOR NFT DIFFERS: vault ${v.creatorNft.toBase58()}, record ${r.lockNft}`] : []),
  ];
  if (differs.length) return { code: DIFFERS, kind: "differs", text: differs.join("; ") };
  if (b.unverified.length) return { code: UNVERIFIED, kind: "unverified", text: `NOT VERIFIED: ${b.unverified.join(" and ")} not in the record, so not compared (the crank keeps going without it); the vault has pool ${v.pool.toBase58()}, creator NFT ${v.creatorNft.toBase58()}` };
  return { code: OK, kind: "verified", text: `pool ${v.pool.toBase58()} and creator NFT ${v.creatorNft.toBase58()} match the record` };
}

/** Only one token: YES or NO, and YES only for a match on both fields. */
async function one(mintText: string) {
  const no = (code: number, why: string) => { console.log(`NO: ${why}`); process.exit(code); };
  let r: LaunchRecord | null;
  try { r = readLaunch(mintText); } catch (e) { return no(UNVERIFIED, `can't read the launch record of ${mintText}: ${msg(e)}`); }
  if (!r) return no(UNVERIFIED, `no launch record for ${mintText} in ${FACTORY_DIR}`);
  if (!r.registeredAt) return no(UNVERIFIED, `${r.symbol} ${r.mint} isn't registered, so the crank doesn't serve it`);
  let info;
  try { info = await conn.getAccountInfo(addrOf(r), "confirmed"); } catch (e) { return no(UNVERIFIED, `can't read the vault: ${msg(e)}`); }
  const out = verdict(r, info);
  if (out.kind !== "verified") return no(out.kind === "not-vault" ? UNVERIFIED : out.code, `${r.symbol} ${r.mint}: ${out.text}`);
  console.log(`YES: ${r.symbol} ${r.mint}: ${out.text}`);
  process.exit(OK);
}
if (mintArg) await one(mintArg);

console.log(`Launch records in ${FACTORY_DIR}`);
const root = path.join(FACTORY_DIR, "launches");
const launches: LaunchRecord[] = [];
let unreadable = 0;
for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  if (!fs.existsSync(path.join(root, name, "launch.json"))) continue;
  try {
    const r = readLaunch(name);
    if (r?.registeredAt) launches.push(r);
  } catch (e) { unreadable++; console.log(`${name}: UNREADABLE record: ${msg(e)}`); }
}
const counts = { verified: 0, differs: 0, unverified: unreadable, "not-vault": 0 };
for (let i = 0; i < launches.length; i += 100) {
  const chunk = launches.slice(i, i + 100);
  let infos;
  try { infos = await conn.getMultipleAccountsInfo(chunk.map(addrOf), "confirmed"); }
  catch (e) { console.log(`NOT VERIFIED: can't read the vaults: ${msg(e)}`); process.exit(UNVERIFIED); }
  chunk.forEach((r, j) => {
    const out = verdict(r, infos[j]);
    counts[out.kind]++;
    console.log(`${r.symbol} ${r.mint}: ${out.text}`);
  });
}
if (!launches.length && !unreadable) { console.log("NOT VERIFIED: no registered launches here (is this the right directory?)"); process.exit(UNVERIFIED); }
console.log(`${launches.length + unreadable} registered: ${counts.verified} verified, ${counts.differs} off their record, ${counts.unverified} not verified, ${counts["not-vault"]} not vault tokens`);
process.exit(counts.differs ? DIFFERS : counts.unverified ? UNVERIFIED : OK);
