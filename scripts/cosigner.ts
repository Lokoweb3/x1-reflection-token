/**
 * Publisher-quorum co-signer (docs/tax-vault-spec.md "Publisher quorum"): checks every rewards
 * list the site proposes to the Squads multisig that publishes for Tax Vault tokens, and
 * approves only lists that pass. Runs anywhere with its own key and an RPC (no site, no
 * config.json); see README "Running a co-signer".
 *
 *   npx tsx scripts/cosigner.ts --rpc <url> --keypair <co-signer key file> --multisig <address>
 *     [--network testnet|mainnet | --squads-program <id>] [--program <tax_vault id>]
 *     [--ipfs-gateway <url>[,<url>...]] [--pinata-jwt <jwt> | env PINATA_JWT] [--pinata-api <url>]
 *     [--webhook <url>] [--loop <seconds> (default 20) | --once] [--dry-run]
 *     [--tolerance-bps 500] [--max-moved-bps 1000] [--large-share-bps 2500] [--max-snapshot-age-slots 9000]
 *     [--strict] [--allow-rule-change] [--allow-rebuild] [--wait-minutes 30] [--priority <microlamports>]
 *
 *   --keypair     a member of the multisig with the Vote (and Execute) permission; pays its
 *                 vote and execute fees (~0.00001 XNT each)
 *   --network     picks the Squads program (testnet DDL3Xp6i…, mainnet SQDS4ep6…; default
 *                 testnet); --squads-program overrides it
 *   --program     the tax_vault program the lists are for (default the testnet one)
 *   --pinata-jwt  also pin every approved list file to this Pinata account (a second copy)
 *   --webhook     POST {"text": ...} here for every rejection and every flagged approval
 *   --dry-run     check and report, never vote or execute
 *   --wait-minutes  a list file that can't be fetched is retried this long, then rejected
 *   --strict      flags (moved balances, a large share for a new wallet, an old snapshot)
 *                 reject the list too; --allow-rule-change / --allow-rebuild accept a
 *                 change of eligibility rules / a list that doesn't build on the last one
 *
 * Each pass, for every Active proposal of the multisig this key hasn't voted on: the vault
 * transaction must be exactly one publish_list of the tax_vault program (anything else is
 * rejected), the list file is fetched by the CID in the instruction and checked (its hash,
 * its Merkle root, totals, nobody below the previous list or what they were paid, the
 * allocation recomputed from the file's inputs, exclusions, balances vs the chain; see
 * src/list-verify.ts). Pass: approve, and execute once the threshold is met. Fail: reject
 * with the reason as the vote's memo, and alert. Proposals it approved that reached the
 * threshold are executed even if the site doesn't (the site may be down).
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_GATEWAY, TRUSTLESS_GATEWAY, normGateway, pinFile } from "../src/factory/ipfs.js";
import { DEFAULT_VERIFY, checkProposal, type VerifyOptions } from "../src/list-verify.js";
import { SQUADS_PROGRAM_IDS, approveIx, executeIx, memberOf, readProposal, readQuorum, rejectIx } from "../src/squads.js";
import { TAX_VAULT_PROGRAM_ID, cidFromBytes } from "../src/taxvault.js";
import { run, withPriority } from "../src/tx.js";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
function usage(problem?: string): never {
  if (problem) console.error(`cosigner: ${problem}\n`);
  console.error("Usage: npx tsx scripts/cosigner.ts --rpc <url> --keypair <file> --multisig <address> [--network testnet|mainnet] [--program <tax_vault id>]\n"
    + "         [--ipfs-gateway <url>[,...]] [--pinata-jwt <jwt>] [--webhook <url>] [--loop <seconds> | --once] [--dry-run] [--strict] (see the file's header)");
  process.exit(2);
}
if (has("help") || has("h")) usage();
const rpc = flag("rpc") ?? usage("--rpc is required");
const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(flag("keypair") ?? usage("--keypair is required")), "utf8"))));
const ms = new PublicKey(flag("multisig") ?? usage("--multisig is required"));
const network = (flag("network") ?? "testnet") as "testnet" | "mainnet";
if (network !== "testnet" && network !== "mainnet") usage("--network is testnet or mainnet");
const squadsProgram = new PublicKey(flag("squads-program") ?? SQUADS_PROGRAM_IDS[network]);
const taxProgram = new PublicKey(flag("program") ?? TAX_VAULT_PROGRAM_ID);
const gateways = (flag("ipfs-gateway") ?? `${DEFAULT_GATEWAY},${TRUSTLESS_GATEWAY},https://ipfs.io/ipfs/`).split(",").filter(Boolean).map(normGateway);
const pinataJwt = flag("pinata-jwt") ?? process.env.PINATA_JWT ?? "";
const pinataApi = flag("pinata-api") ?? process.env.PINATA_API_URL;
const webhook = flag("webhook");
const loopSecs = has("once") ? 0 : Number(flag("loop") ?? 20);
if (!(loopSecs >= 0)) usage("--loop takes seconds");
const dryRun = has("dry-run");
const waitMs = Number(flag("wait-minutes") ?? 30) * 60_000;
const microLamports = Number(flag("priority") ?? 10_000);
const num = (name: string, d: number) => { const x = flag(name); if (x === undefined) return d; const n = Number(x); if (!Number.isFinite(n) || n < 0) usage(`--${name} takes a number`); return n; };
const opts: VerifyOptions = {
  toleranceBps: num("tolerance-bps", DEFAULT_VERIFY.toleranceBps), maxMovedBps: num("max-moved-bps", DEFAULT_VERIFY.maxMovedBps),
  largeShareBps: num("large-share-bps", DEFAULT_VERIFY.largeShareBps), maxSnapshotAgeSlots: num("max-snapshot-age-slots", DEFAULT_VERIFY.maxSnapshotAgeSlots),
  allowRuleChange: has("allow-rule-change"), allowRebuild: has("allow-rebuild"), strict: has("strict"),
};

const conn = new Connection(rpc, "confirmed");
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** stdout, and the webhook if set (best effort). */
async function alert(text: string) {
  log(`ALERT ${text}`);
  if (!webhook) return;
  await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `[99tax co-signer] ${text}` }), signal: AbortSignal.timeout(10_000) })
    .catch((e) => log(`webhook failed: ${msg(e)}`));
}
const send = (label: string, ixs: Parameters<typeof withPriority>[0]) => run(conn, withPriority(ixs, microLamports, 200_000), me).then((sig) => { log(`  ${label}: ${sig}`); return sig; });

// ---------- one pass ----------
/** When each proposal was first seen waiting (a list file not fetchable yet). */
const waitingSince = new Map<string, number>();
const done = new Set<string>();

async function pass() {
  const q = await readQuorum(conn, squadsProgram, ms);
  if (!q) throw new Error(`${ms.toBase58()} isn't a Squads multisig of ${squadsProgram.toBase58()}`);
  const mine = memberOf(q, me.publicKey);
  if (!mine?.vote) throw new Error(`${me.publicKey.toBase58()} isn't a voting member of the multisig`);
  const from = q.staleTransactionIndex + 1n > q.transactionIndex - 50n ? q.staleTransactionIndex + 1n : q.transactionIndex - 50n;
  for (let i = from < 1n ? 1n : from; i <= q.transactionIndex; i++) {
    const key = i.toString();
    if (done.has(key)) continue;
    const p = await readProposal(conn, squadsProgram, ms, i).catch(() => null);
    if (!p) continue;
    const self = me.publicKey.toBase58();
    if (p.status === "Approved" && p.approved.includes(self)) {
      // Threshold met with our approval but not executed (the site may be down): execute it.
      if (!mine.execute || dryRun) continue;
      try { await send(`execute #${i}`, [await executeIx(conn, squadsProgram, ms, i, me.publicKey)]); } catch (e) { log(`  execute #${i} failed: ${msg(e).split("\n")[0]}`); }
      done.add(key); // one try per run (a stale list is refused by the program)
      continue;
    }
    if (p.status !== "Active") { if (p.status !== "Draft") done.add(key); continue; }
    if (p.approved.includes(self) || p.rejected.includes(self)) continue;

    const c = await checkProposal(conn, { squadsProgram, ms, index: i, taxProgram, gateways, opts });
    if (c.wait) {
      const since = waitingSince.get(key) ?? Date.now();
      waitingSince.set(key, since);
      if (Date.now() - since < waitMs) { log(`#${i}: waiting (${c.wait})`); continue; }
    }
    const reason = c.refused ?? (c.wait ? `${c.wait} for ${Math.round(waitMs / 60_000)} min` : null) ?? (c.result && !c.result.ok ? c.result.errors.join("; ") : null);
    const s = c.result?.summary;
    const what = s ? `list ${s.epoch} for ${s.mint.slice(0, 8)}… (${s.wallets} wallets, total ${s.total}, new ${s.newXnt ?? "?"}, ${s.cid})` : `proposal #${i}`;
    if (reason) {
      await alert(`REJECT #${i} ${what}: ${reason}`);
      if (!dryRun) await send(`reject #${i}`, [rejectIx(squadsProgram, ms, i, me.publicKey, `99tax co-signer: ${reason}`)]).catch((e) => log(`  reject #${i} failed: ${msg(e).split("\n")[0]}`));
      done.add(key); waitingSince.delete(key);
      continue;
    }
    const flags = c.result!.flags;
    log(`#${i}: PASS ${what}${flags.length ? `; flags: ${flags.join("; ")}` : ""}`);
    if (flags.length) await alert(`approved #${i} ${what} with flags: ${flags.join("; ")}`);
    if (dryRun) { done.add(key); continue; }
    await send(`approve #${i}`, [approveIx(squadsProgram, ms, i, me.publicKey, `99tax co-signer: checked list ${s!.epoch}`)]);
    done.add(key); waitingSince.delete(key);
    // A second copy of the file on our own IPFS provider.
    if (pinataJwt && c.file) {
      await pinFile({ jwt: pinataJwt, uploadUrl: pinataApi }, new Blob([new Uint8Array(c.file)], { type: "application/json" }), `list-${s!.mint.slice(0, 8)}-${s!.epoch}.json`, `99tax co-signer copy ${s!.mint.slice(0, 8)} list ${s!.epoch}`)
        .then((cid) => log(`  pinned a second copy: ${cid}${cid === cidFromBytes(c.args!.cid) ? " (same CID)" : " (a different CID: the provider chunks differently)"}`))
        .catch((e) => log(`  second pin failed: ${msg(e)}`));
    }
    const after = await readProposal(conn, squadsProgram, ms, i);
    if (after?.status === "Approved" && mine.execute) {
      await send(`execute #${i}`, [await executeIx(conn, squadsProgram, ms, i, me.publicKey)]).catch((e) => log(`  execute #${i} failed (the site may have executed it): ${msg(e).split("\n")[0]}`));
    }
  }
}

log(`co-signer ${me.publicKey.toBase58()} for multisig ${ms.toBase58()} (Squads ${squadsProgram.toBase58()}, tax_vault ${taxProgram.toBase58()})${dryRun ? ", DRY RUN" : ""}`);
{
  const q = await readQuorum(conn, squadsProgram, ms);
  if (!q) usage(`${ms.toBase58()} isn't a Squads multisig of ${squadsProgram.toBase58()}`);
  log(`  ${q.threshold} of ${q.voters} voters; members: ${q.members.map((m) => `${m.key}${m.key === me.publicKey.toBase58() ? " (me)" : ""} [${[m.initiate && "initiate", m.vote && "vote", m.execute && "execute"].filter(Boolean).join(",")}]`).join(", ")}`);
  log(`  publisher (vault PDA): ${q.vault.toBase58()}; config authority ${q.configAuthority?.toBase58() ?? "none (autonomous)"}; time lock ${q.timeLock}s`);
}
for (;;) {
  await pass().catch((e) => log(`pass failed: ${msg(e)}`));
  if (!loopSecs) break;
  await new Promise((r) => setTimeout(r, loopSecs * 1000));
}
