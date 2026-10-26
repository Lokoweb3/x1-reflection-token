/**
 * Who can change the programs a token depends on: for each program, whether it is upgradeable, the exact upgrade
 * authority and what kind of account it is, every upgrade-related transaction on its programdata (deploys, upgrades,
 * authority changes, extensions) with signers, and the sha256 of the deployed code. Evidence goes to <out>/<date>/.
 *
 *   npx tsx scripts/audit-upgrades.ts [--rpc <url>] [--out audits/upgrades] [--compare <name>=<path.so> ...]
 *
 * What an authority's kind means:
 *   - a plain key (on the ed25519 curve, no account data): one private key signs upgrades directly. No on-chain
 *     multisig or timelock can apply to it; an off-chain arrangement (MPC, a hardware wallet) can't be seen on-chain.
 *   - an off-curve address (a PDA): only its program can sign for it; a Squads v4 vault is reported with its
 *     multisig's members, threshold and time lock.
 *   - none: the program can no longer be upgraded.
 * The newest deploy or upgrade found is checked against programdata's own "last deployed" slot: that corroborates
 * the latest deployment only. Earlier upgrades or authority changes are as complete as the RPC's signature index.
 * `--compare <name>=<build.so>` checks a local build against the chain the way docs/REVIEW.md does: the deployed
 * bytes start with the build, byte for byte, and anything after it (an account bigger than the build) is zeros.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const RPC = arg("rpc", "https://rpc.mainnet.x1.xyz")!;
const OUT = arg("out", path.join(import.meta.dirname, "..", "audits", "upgrades"))!;
const compare = new Map(argv.flatMap((a, i) => (argv[i - 1] === "--compare" ? [a.split("=") as [string, string]] : [])));
const PROGRAMS: [string, string][] = [
  ["tax_vault", "D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW"],
  ["lp_locker", "5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C"],
  ["XDEX", "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN"],
  ["8N4E locker", "8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf"],
  ["Token-2022 (TEST)", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
  ["SPL Token (LP mints)", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
];
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const LOADER_IX = ["InitializeBuffer", "Write", "DeployWithMaxDataLen", "Upgrade", "SetAuthority", "Close", "ExtendProgram", "SetAuthorityChecked", "Migrate", "ExtendProgramChecked"];

async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
      return r.result;
    } catch (e) { if (i >= 6) throw e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
}
const et = (unix: number) => new Date(unix * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** A Squads v4 multisig whose vault 0..3 is `authority`, found through the multisig named in its upgrade transactions. */
async function squadsFor(authority: string, candidates: Set<string>) {
  for (const ms of candidates) {
    const a = (await rpc("getAccountInfo", [ms, { encoding: "base64" }])).value;
    if (a?.owner !== SQUADS) continue;
    for (let i = 0; i < 4; i++) {
      const vault = PublicKey.findProgramAddressSync([Buffer.from("multisig"), new PublicKey(ms).toBuffer(), Buffer.from("vault"), Buffer.from([i])], new PublicKey(SQUADS))[0].toBase58();
      if (vault !== authority) continue;
      const d = Buffer.from(a.data[0], "base64"); // disc, create_key, config_authority, threshold u16, time_lock u32, tx index, stale index, rent_collector Option, bump, members
      let o = 8 + 32;
      const configAuthority = bs58.encode(d.subarray(o, o + 32)); o += 32;
      const threshold = d.readUInt16LE(o); o += 2;
      const timeLock = d.readUInt32LE(o); o += 4 + 16;
      o += d[o] ? 33 : 1; o += 1;
      const n = d.readUInt32LE(o); o += 4;
      const members = Array.from({ length: n }, (_, k) => ({ key: bs58.encode(d.subarray(o + k * 33, o + k * 33 + 32)), permissions: d[o + k * 33 + 32] }));
      return { multisig: ms, vaultIndex: i, threshold, timeLockSeconds: timeLock, configAuthority: configAuthority === "11111111111111111111111111111111" ? null : configAuthority, members };
    }
  }
  return null;
}

const report: any[] = [];
const checks: { ok: boolean; what: string }[] = [];
for (const [name, id] of PROGRAMS) {
  const acc = (await rpc("getAccountInfo", [id, { encoding: "base64" }])).value;
  if (acc.owner !== LOADER) {
    report.push({ name, id, loader: acc.owner, upgradeable: false, kind: `not upgradeable (loader ${acc.owner})` });
    console.log(`${name.padEnd(22)} ${id}: not upgradeable (loader ${acc.owner})`);
    continue;
  }
  const programdata = bs58.encode(Buffer.from(acc.data[0], "base64").subarray(4, 36));
  const pd = Buffer.from((await rpc("getAccountInfo", [programdata, { encoding: "base64" }])).value.data[0], "base64");
  const lastDeploySlot = Number(pd.readBigUInt64LE(4));
  const authority = pd[12] ? bs58.encode(pd.subarray(13, 45)) : null;
  const code = pd.subarray(45); // the deployed ELF, zero-padded to the account's size

  // every transaction touching programdata: the loader's management instructions, with signers and outer programs
  const history: any[] = [];
  const multisigCandidates = new Set<string>();
  for (let before: string | undefined; ;) {
    const sigs: any[] = await rpc("getSignaturesForAddress", [programdata, { limit: 1000, before }]);
    for (const s of sigs) {
      const tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const outer = tx.transaction.message.instructions.map((i: any) => keys[i.programIdIndex]);
      for (const i of tx.transaction.message.instructions) if (keys[i.programIdIndex] === SQUADS) for (const k of i.accounts) multisigCandidates.add(keys[k]);
      const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((x: any) => x.instructions)].filter((i: any) => keys[i.programIdIndex] === LOADER);
      history.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, failed: !!s.err,
        instructions: ixs.map((i: any) => LOADER_IX[Buffer.from(bs58.decode(i.data)).readUInt32LE(0)] ?? "?"),
        signers: keys.slice(0, tx.transaction.message.header.numRequiredSignatures), outerPrograms: [...new Set(outer)] });
    }
    if (sigs.length < 1000) break;
    before = sigs.at(-1).signature;
  }
  const deploys = history.filter((h) => !h.failed && h.instructions.some((x: string) => x === "DeployWithMaxDataLen" || x === "Upgrade"));
  const notes: string[] = [];
  if (deploys.length) check(deploys[0].slot === lastDeploySlot, `${name}: latest deployment corroborated: the newest deploy/upgrade found (slot ${deploys[0].slot}) is programdata's last-deployed slot`);
  else notes.push(`no deploy or upgrade transaction exists (programdata says slot ${lastDeploySlot}): it was installed by the runtime (genesis or a feature activation), so its history can't be checked here`);
  for (const x of notes) console.log(`  NOTE ${name}: ${x}`);

  let kind: string, squads = null;
  if (!authority) kind = "none: can no longer be upgraded";
  else if (PublicKey.isOnCurve(new PublicKey(authority).toBytes())) {
    const a = (await rpc("getAccountInfo", [authority, { encoding: "base64" }])).value;
    kind = !a || (a.owner === "11111111111111111111111111111111" && a.data[0] === "") ? "plain key: one private key signs upgrades; no on-chain multisig or timelock" : `on-curve account owned by ${a.owner}`;
  } else {
    squads = await squadsFor(authority, multisigCandidates);
    kind = squads ? `Squads v4 vault: ${squads.threshold} of ${squads.members.length}, time lock ${squads.timeLockSeconds}s` : "program-derived address (only its program can sign; not a recognised multisig)";
  }
  let local: string | null = null;
  if (compare.has(name)) {
    const b = fs.readFileSync(compare.get(name)!);
    local = sha(b);
    const same = b.length <= code.length && code.subarray(0, b.length).equals(b) && code.subarray(b.length).every((x) => x === 0);
    check(same, `${name}: deployed bytes are ${path.basename(compare.get(name)!)} (sha256 ${local.slice(0, 16)}…, ${b.length} bytes)${code.length > b.length ? " plus zero padding" : ""}`);
  }
  report.push({ name, id, upgradeable: !!authority, programdata, authority, kind, squads, notes, lastDeploySlot, accountCodeBytes: code.length, accountCodeSha256: sha(code), localSha256: local, history });
  console.log(`${name.padEnd(22)} ${id}: ${authority ? `authority ${authority} — ${kind}` : kind}`);
  for (const h of history) console.log(`    ${h.blockTime ? et(h.blockTime) : "?"} slot ${h.slot} ${h.failed ? "FAILED " : ""}${h.instructions.join(", ")} signed by ${h.signers.join(", ")}`);
  console.log(`    code ${code.length} bytes, sha256 ${sha(code)}`);
}
function check(ok: boolean, what: string) { checks.push({ ok, what }); console.log(`  ${ok ? "PASS" : "FAIL"} ${what}`); }

const dir = path.join(OUT, new Date().toISOString().slice(0, 10));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "upgrades.json"), JSON.stringify({ rpc: RPC, auditedAt: new Date().toISOString(), checks, programs: report }, null, 1));
fs.writeFileSync(path.join(dir, "README.md"), [
  `# Upgrade control audit`, "", `Run ${et(Date.now() / 1000)} with \`npx tsx scripts/audit-upgrades.ts\` against ${RPC}.`, "",
  "| Program | Upgrade authority | Kind | Deploys/upgrades | Last deployed |", "|---|---|---|---|---|",
  ...report.map((r) => `| ${r.name} \`${r.id.slice(0, 6)}…\` | ${r.authority ? `\`${r.authority}\`` : "—"} | ${r.kind} | ${r.history ? r.history.filter((h: any) => h.instructions.some((x: string) => x === "DeployWithMaxDataLen" || x === "Upgrade")).length : "—"} | ${r.history?.[0]?.blockTime ? et(r.history[0].blockTime) : "—"} |`),
  "", "## Checks", "", ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.what}`),
  "", "## History", "", ...report.filter((r) => r.history).flatMap((r) => [`### ${r.name}`, "", ...r.history.map((h: any) => `- ${h.blockTime ? et(h.blockTime) : "?"}: ${h.instructions.join(", ")} by ${h.signers.map((s: string) => `\`${s}\``).join(", ")} ([tx](https://explorer.mainnet.x1.xyz/tx/${h.signature}))`), ...r.notes.map((x: string) => `- note: ${x}`), `- program account: ${r.accountCodeBytes} bytes, sha256 \`${r.accountCodeSha256}\`${r.localSha256 ? ` (reproduced: build sha256 \`${r.localSha256}\`)` : ""}`, ""]),
  "## What this does and doesn't show", "",
  "- A plain-key authority's signature can't be constrained on-chain: there is no multisig or timelock to verify. Who holds the key is an off-chain fact.",
  "- The code hash identifies what is deployed; it ties to source only through a reproducible build of a known commit (`--compare`; see REPRODUCE.md when present). A build that doesn't match proves nothing about the source by itself: toolchain, flags, features and dependencies change the bytes.",
  "- The last-deployed slot check corroborates the latest deployment only; earlier history is as complete as the RPC's signature index. It trusts the RPC it reads.",
  "",
].join("\n"));
console.log(`\nevidence in ${path.relative(process.cwd(), dir)}/`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
