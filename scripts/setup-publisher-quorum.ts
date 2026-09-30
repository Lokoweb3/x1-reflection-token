/**
 * Set up the publisher quorum (docs/tax-vault-spec.md "Publisher quorum"): create the Squads v4
 * multisig (threshold 2, autonomous, no time lock) and hand the given vaults' publisher role to
 * its vault PDA. DRY RUN by default: prints and simulates everything, sends nothing.
 *
 *   npx tsx scripts/setup-publisher-quorum.ts --rpc <url> --keypair <payer file> --create-key <file>
 *     --site <pubkey> --cosigner <pubkey> [--backup <pubkey>] [--threshold 2]
 *     [--mint <mint>[,<mint>...] [--publisher <current publisher key file>]]
 *     [--network testnet|mainnet | --squads-program <id>] [--program <tax_vault id>] [--execute]
 *
 *   --keypair     pays the multisig's rent (and the fees); also the current publisher unless
 *                 --publisher is given
 *   --create-key  a throwaway key that seeds the multisig's address (signs its creation only);
 *                 created if the file doesn't exist, so the dry run and --execute agree. Keep it
 *                 out of the repository; it has no power once the multisig exists
 *   --site        the site's crank / publisher key (Initiate, Vote, Execute; also the rent
 *                 collector, so closed proposals return their rent to it)
 *   --cosigner    the independent co-signer (Vote, Execute), runs scripts/cosigner.ts
 *   --backup      optional cold key (Initiate, Vote, Execute): with the co-signer it can still
 *                 publish if the site's key is lost
 *   --mint        vaults whose publisher moves to the multisig's vault: `set_publisher`, signed
 *                 by the vault's current publisher (--publisher, e.g. the site's key)
 *   --execute     send: create the multisig if it doesn't exist yet, then set_publisher for
 *                 each mint whose publisher is that key
 *
 * An existing multisig at the address is checked (members, permissions, threshold, no config
 * authority, no time lock) and never modified. A vault already published by the multisig is
 * left as it is.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SQUADS_PROGRAM_IDS, Permission, createMultisigIx, readQuorum, squadsMultisigPda, squadsVaultPda } from "../src/squads.js";
import { TAX_VAULT_PROGRAM_ID, decodeVault, errorOf, setPublisherIx, vaultPda } from "../src/taxvault.js";
import { run, withPriority } from "../src/tx.js";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(`setup-publisher-quorum: ${problem}\n`);
  console.error("Usage: npx tsx scripts/setup-publisher-quorum.ts --rpc <url> --keypair <file> --create-key <file> --site <pubkey> --cosigner <pubkey>\n"
    + "         [--backup <pubkey>] [--threshold 2] [--mint <mint>[,...] [--publisher <file>]] [--network testnet|mainnet] [--program <id>] [--execute]");
  process.exit(2);
}
if (has("help") || has("h")) usage();
const readKey = (file: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(file), "utf8"))));
const rpc = flag("rpc") ?? usage("--rpc is required");
const payer = readKey(flag("keypair") ?? usage("--keypair is required"));
const createKeyFile = path.resolve(flag("create-key") ?? usage("--create-key <file> is required (created if missing)"));
const pk = (name: string, required = true) => { const v = flag(name); if (!v) { if (required) usage(`--${name} is required`); return null; } try { return new PublicKey(v); } catch { usage(`--${name} isn't an address`); } };
const site = pk("site")!, cosigner = pk("cosigner")!, backup = pk("backup", false);
const threshold = Number(flag("threshold") ?? 2);
const network = (flag("network") ?? "testnet") as "testnet" | "mainnet";
if (network !== "testnet" && network !== "mainnet") usage("--network is testnet or mainnet");
const squadsProgram = new PublicKey(flag("squads-program") ?? SQUADS_PROGRAM_IDS[network]);
const taxProgram = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);
const mints = (flag("mint") ?? "").split(",").filter(Boolean).map((m) => new PublicKey(m));
const publisher = flag("publisher") ? readKey(flag("publisher")!) : payer;
const execute = has("execute");

const members = [
  { key: site, permissions: [Permission.Initiate, Permission.Vote, Permission.Execute], role: "site (proposes, votes, executes)" },
  { key: cosigner, permissions: [Permission.Vote, Permission.Execute], role: "co-signer (votes, executes)" },
  ...(backup ? [{ key: backup, permissions: [Permission.Initiate, Permission.Vote, Permission.Execute], role: "backup (proposes, votes, executes)" }] : []),
];
if (new Set(members.map((m) => m.key.toBase58())).size !== members.length) usage("--site, --cosigner and --backup must be different keys");
if (!Number.isInteger(threshold) || threshold < 2 || threshold > members.length) usage(`--threshold must be 2..${members.length} (1 would let one key publish alone)`);

const conn = new Connection(rpc, "confirmed");
const say = (s: string) => console.log(s);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Simulate without signatures (the dry run), naming a program error if there is one. */
async function simulate(ixs: TransactionInstruction[], feePayer: PublicKey) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (!sim.value.err) return "simulation OK";
  const logs = (sim.value.logs ?? []).join("\n");
  return `simulation FAILED: ${errorOf(logs) ?? JSON.stringify(sim.value.err)}\n    ${(sim.value.logs ?? []).slice(-4).join("\n    ")}`;
}

// ---------- the multisig ----------
if (!fs.existsSync(createKeyFile)) {
  fs.writeFileSync(createKeyFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  say(`new create key written to ${createKeyFile} (keep it for --execute; it has no power afterwards)`);
}
const createKey = readKey(createKeyFile);
const ms = squadsMultisigPda(squadsProgram, createKey.publicKey);
const vault = squadsVaultPda(squadsProgram, ms);
say(`${execute ? "EXECUTE" : "DRY RUN (nothing is sent; add --execute)"} on ${rpc}`);
say(`Squads program ${squadsProgram.toBase58()} (${network}), tax_vault ${taxProgram.toBase58()}`);
say(`multisig    ${ms.toBase58()}`);
say(`vault PDA   ${vault.toBase58()}   <- the new publisher (factory.taxVault.quorum.multisig = the multisig above)`);
say(`threshold   ${threshold} of ${members.length}; config authority: none (autonomous); time lock 0; rent collector ${site.toBase58()}`);
for (const m of members) say(`  member ${m.key.toBase58()}  ${m.role}`);

const existing = await readQuorum(conn, squadsProgram, ms);
if (existing) {
  const want = new Map(members.map((m) => [m.key.toBase58(), m.permissions]));
  const problems: string[] = [];
  if (existing.threshold !== threshold) problems.push(`threshold ${existing.threshold}`);
  if (existing.configAuthority) problems.push(`config authority ${existing.configAuthority.toBase58()}`);
  if (existing.timeLock !== 0) problems.push(`time lock ${existing.timeLock}`);
  if (existing.members.length !== members.length) problems.push(`${existing.members.length} members`);
  for (const m of existing.members) {
    const p = want.get(m.key);
    if (!p) { problems.push(`unexpected member ${m.key}`); continue; }
    if (m.initiate !== p.includes(Permission.Initiate) || m.vote !== p.includes(Permission.Vote) || m.execute !== p.includes(Permission.Execute)) problems.push(`other permissions for ${m.key}`);
  }
  if (problems.length) { say(`\nThe multisig already exists but differs: ${problems.join("; ")}. Use another --create-key.`); process.exit(1); }
  say("\nThe multisig already exists with these settings: not created again.");
} else {
  const ix = await createMultisigIx(conn, squadsProgram, { creator: payer.publicKey, createKey: createKey.publicKey, threshold, rentCollector: site,
    members: members.map((m) => ({ key: m.key, permissions: m.permissions })) });
  if (!execute) say(`\nmultisig_create_v2: ${await simulate([ix], payer.publicKey)}`);
  else {
    const sig = await run(conn, withPriority([ix], 10_000, 100_000), payer, [createKey]);
    say(`\nmultisig created: ${sig}`);
    const q = await readQuorum(conn, squadsProgram, ms);
    if (!q || q.threshold !== threshold || q.members.length !== members.length) throw new Error("the new multisig doesn't read back as expected");
  }
}

// ---------- the vaults ----------
if (mints.length) say(`\nvaults (current publisher key ${publisher.publicKey.toBase58()}):`);
let failed = false;
for (const mint of mints) {
  const addr = vaultPda(taxProgram, mint);
  const info = await conn.getAccountInfo(addr, "confirmed");
  if (!info || !info.owner.equals(taxProgram)) { say(`  ${mint.toBase58()}: no vault`); failed = true; continue; }
  const v = decodeVault(addr, info.data);
  if (v.publisher.equals(vault)) { say(`  ${mint.toBase58()}: already published by the multisig`); continue; }
  if (v.version < 3) { say(`  ${mint.toBase58()}: vault v${v.version}; run the crank once so it's upgraded to v3 first`); failed = true; continue; }
  if (!v.publisher.equals(publisher.publicKey)) { say(`  ${mint.toBase58()}: its publisher is ${v.publisher.toBase58()}, not ${publisher.publicKey.toBase58()}: can't move it`); failed = true; continue; }
  if (v.pendingEpoch > 0n) say(`  ${mint.toBase58()}: note: list ${v.pendingEpoch} is pending; it stays and pays as usual`);
  const ix = setPublisherIx(taxProgram, publisher.publicKey, mint, vault);
  if (!execute) { say(`  ${mint.toBase58()}: set_publisher ${publisher.publicKey.toBase58()} -> ${vault.toBase58()}: ${await simulate([ix], payer.publicKey)}`); continue; }
  if (!(await readQuorum(conn, squadsProgram, ms))) throw new Error("the multisig doesn't exist: not moving any publisher to it");
  try {
    const sig = await run(conn, withPriority([ix], 10_000, 30_000), payer, publisher.publicKey.equals(payer.publicKey) ? [] : [publisher]);
    const after = decodeVault(addr, (await conn.getAccountInfo(addr, "confirmed"))!.data);
    say(`  ${mint.toBase58()}: publisher is now ${after.publisher.toBase58()} (${sig})`);
  } catch (e) {
    failed = true;
    say(`  ${mint.toBase58()}: set_publisher failed: ${errorOf(msg(e)) ?? msg(e).split("\n")[0]}`);
  }
}
if (execute && mints.length) say(`\nNext: set factory.taxVault.quorum = { "multisig": "${ms.toBase58()}" } in the site's config.json, restart it, and start scripts/cosigner.ts --multisig ${ms.toBase58()} with the co-signer's key.`);
process.exit(failed ? 1 : 0);
