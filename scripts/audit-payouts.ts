/**
 * Audit a Tax Vault's payout lists from the chain, IPFS and docs/tax-vault-spec.md alone, and keep the evidence.
 *
 *   npx tsx scripts/audit-payouts.ts [--mint <mint>] [--back 1] [--rpc <url>] [--out audits/payouts] [--no-history]
 *
 * For the active and the pending list, and the --back lists before them (followed through each file's `prev`), it checks that:
 *   - the file on IPFS hashes to the CID stored on-chain, and is for this vault and mint;
 *   - its entries give the on-chain root and add up to the on-chain total;
 *   - its stated pot and every entry recompute from its inputs and the previous list (spec "Deterministic allocation");
 *   - the publish_list transaction that set it is found, signed by the publisher, with the same root, epoch, total and CID;
 *   - the balances it used are each owner's TEST at its snapshot slot (today's balances minus every later change in the
 *     mint's transaction history, so closed accounts count too), and no owner the rules make eligible is missing;
 * and that the PaidRecords add up to holders_paid and nobody was paid more than the active list gives them.
 *
 * It deliberately reimplements the leaf, tree, CID and allocation rules from the spec instead of importing src/, so
 * it doesn't share the site's bugs. Everything it read (raw vault account, list files byte for byte, transactions'
 * signatures, rebuilt balances, PaidRecords) and its results go to <out>/<date>-epoch-<n>/; it exits 1 if a check fails.
 *
 * Limits (also written into each report): it trusts the RPC it reads (pass --rpc to repeat against another);
 * owner changes aren't modelled; and a program-owned (off-curve) holder is excluded by rule, which says nothing about
 * who the tokens inside it belong to.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const RPC = arg("rpc", "https://rpc.mainnet.x1.xyz")!;
const MINT = arg("mint", "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz")!; // TEST
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const OUT = arg("out", path.join(import.meta.dirname, "..", "audits", "payouts"))!;
const HISTORY = !argv.includes("--no-history");
const BACK = Number(arg("back", "1"));
const GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/"];

async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
      return r.result;
    } catch (e) { if (i >= 6) throw e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
}

// ---- spec rules, reimplemented ----
const sha = (...b: Buffer[]) => crypto.createHash("sha256").update(Buffer.concat(b)).digest();
const u64le = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };
const leaf = (vault: Buffer, wallet: string, cum: bigint) => sha(Buffer.from("99tax-vault"), vault, Buffer.from(bs58.decode(wallet)), u64le(cum));
const node = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? sha(a, b) : sha(b, a));
function merkleRoot(vault: Buffer, entries: [string, string][]) {
  let level = entries.map(([w, c]) => leaf(vault, w, BigInt(c))).sort(Buffer.compare); // leaves sorted by hash (spec "Merkle list")
  if (!level.length) return Buffer.alloc(32);
  while (level.length > 1) { const next: Buffer[] = []; for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]); level = next; }
  return level[0];
}
{ // the spec's test vectors, so a drifted copy of the rules can't pass silently
  const v = Buffer.alloc(32, 1), w = (x: number) => bs58.encode(Buffer.alloc(32, x));
  if (merkleRoot(v, [[w(2), "1000000000"], [w(3), "5"]]).toString("hex") !== "1992f5473e12ba77f8b909f1cb3272b5492544fc3e37ea7a5d7c3776290bda6a"
    || merkleRoot(v, [[w(2), "1000000000"], [w(3), "5"], [w(4), "7"]]).toString("hex") !== "fa5686efd55343f28edd1e8892315bb847074dcde2a080abeabef401131282de")
    throw new Error("Merkle rules don't reproduce the spec's test vectors");
}
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (b: Buffer) => { let bits = 0, v = 0, o = ""; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += B32[(v << (5 - bits)) & 31]; return o; };
/** The 33 stored CID bytes (codec, sha256 digest) as a CIDv1 string; all zero is no CID. */
const cidString = (c: Buffer) => (c.every((x) => !x) ? null : "b" + base32(Buffer.concat([Buffer.from([1, c[0], 0x12, 0x20]), c.subarray(1)])));

// ---- vault (offsets from the spec's v3 layout) ----
const vaultPk = PublicKey.findProgramAddressSync([Buffer.from("vault"), new PublicKey(MINT).toBuffer()], PROGRAM)[0];
const VAULT = vaultPk.toBase58();
const authPda = PublicKey.findProgramAddressSync([Buffer.from("auth"), new PublicKey(MINT).toBuffer()], PROGRAM)[0].toBase58();
const acc = await rpc("getAccountInfo", [VAULT, { encoding: "base64", commitment: "confirmed" }]);
if (!acc.value) throw new Error(`no vault ${VAULT} for mint ${MINT}`);
const auditSlot: number = acc.context.slot;
const d = Buffer.from(acc.value.data[0], "base64");
const u64 = (o: number) => d.readBigUInt64LE(o), key = (o: number) => bs58.encode(d.subarray(o, o + 32));
const vault = {
  address: VAULT, mint: key(8), publisher: key(168), guardian: key(200), version: d[480],
  holdersFunded: u64(294), holdersPaid: u64(302),
  list: { epoch: u64(310), root: d.subarray(318, 350).toString("hex"), total: u64(350), cid: cidString(d.subarray(506, 539)) },
  pending: { epoch: u64(358), root: d.subarray(366, 398).toString("hex"), total: u64(398), activeAt: Number(d.readBigInt64LE(406)), cid: cidString(d.subarray(539, 572)) },
  lastPublishAt: Number(d.readBigInt64LE(498)), fallbackPaid: u64(572),
};
if (vault.mint !== MINT) throw new Error("vault mint mismatch");
if (vault.version < 3) throw new Error(`vault v${vault.version}: lists have no CID before v3`);

const checks: { ok: boolean; what: string }[] = [];
const check = (ok: boolean, what: string) => { checks.push({ ok, what }); console.log(ok ? "  PASS" : "  FAIL", what); };
const fmt = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(9).replace(/\.?0+$/, "");
const et = (unix: number) => new Date(unix * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";

// ---- list files ----
const files = new Map<string, Buffer>();
async function fetchList(cid: string) {
  if (files.has(cid)) return JSON.parse(files.get(cid)!.toString());
  const digest = Buffer.from(cid.slice(1).split("").reduce((acc, ch) => acc + B32.indexOf(ch).toString(2).padStart(5, "0"), "").match(/.{8}/g)!.map((x) => parseInt(x, 2)));
  if (digest[1] !== 0x55) throw new Error(`${cid}: not a raw-codec CID, can't hash-check it`);
  for (const g of GATEWAYS) {
    try {
      const r = await fetch(g + cid, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const b = Buffer.from(await r.arrayBuffer());
      if (!sha(b).equals(digest.subarray(4, 36))) continue; // a gateway serving other bytes is skipped, never trusted
      files.set(cid, b);
      return JSON.parse(b.toString());
    } catch {}
  }
  throw new Error(`no gateway served bytes matching ${cid}`);
}

// ---- publications: publish_list(root, epoch, total, cid) found through the publisher's transactions ----
const PUBLISH = sha(Buffer.from("global:publish_list")).subarray(0, 8);
async function findPublications(epochs: Set<bigint>, oldestSlot: number) {
  const found = new Map<bigint, any>();
  let before: string | undefined;
  while (found.size < epochs.size) {
    const sigs: any[] = await rpc("getSignaturesForAddress", [vault.publisher, { limit: 1000, before, commitment: "confirmed" }]);
    if (!sigs.length) break;
    for (const s of sigs) {
      if (s.err || s.slot < oldestSlot) continue;
      const tx = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const ixs = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((x: any) => x.instructions)];
      for (const ix of ixs) {
        if (keys[ix.programIdIndex] !== PROGRAM.toBase58()) continue;
        const data = Buffer.from(bs58.decode(ix.data));
        if (!data.subarray(0, 8).equals(PUBLISH) || keys[ix.accounts[1]] !== VAULT) continue;
        const epoch = data.readBigUInt64LE(40);
        if (!epochs.has(epoch)) continue;
        found.set(epoch, {
          signature: s.signature, slot: s.slot, blockTime: tx.blockTime, signer: keys[ix.accounts[0]],
          signerSigned: ix.accounts[0] < tx.transaction.message.header.numRequiredSignatures,
          root: data.subarray(8, 40).toString("hex"), epoch: epoch.toString(), total: data.readBigUInt64LE(48).toString(), cid: cidString(data.subarray(56, 89)),
        });
      }
    }
    before = sigs.at(-1).signature;
    if (sigs.at(-1).slot < oldestSlot) break;
  }
  return found;
}

// ---- balance history ----
// TEST has a transfer fee, so Token-2022 refuses the plain Transfer (MintRequiredForTransfer): every instruction that
// changes a TEST balance (TransferChecked, Burn, MintTo, the withheld-fee withdrawals) names the mint, so every such
// transaction is in the mint's signature history, including those touching accounts closed since. A balance at the
// end of slot S is then today's (read at a known context slot) minus every change after S; no ordering within a slot
// is needed.
type Change = { slot: number; account: string; owner: string; delta: bigint; signature: string };
async function changesAfter(fromSlot: number, toSlot: number) {
  const out: Change[] = [];
  for (let before: string | undefined; ;) {
    const page: any[] = await rpc("getSignaturesForAddress", [MINT, { limit: 1000, before, commitment: "confirmed" }]);
    for (const sg of page) {
      if (sg.err || sg.slot <= fromSlot || sg.slot > toSlot) continue; // a failed transaction changes no balance
      const tx = await rpc("getTransaction", [sg.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const rows = new Map<string, { owner: string; pre: bigint; post: bigint }>();
      for (const [list, field] of [[tx.meta.preTokenBalances, "pre"], [tx.meta.postTokenBalances, "post"]] as const)
        for (const t of list ?? []) {
          if (t.mint !== MINT) continue;
          const r = rows.get(keys[t.accountIndex]) ?? { owner: t.owner, pre: 0n, post: 0n };
          r[field] = BigInt(t.uiTokenAmount.amount); rows.set(keys[t.accountIndex], r);
        }
      for (const [account, r] of rows) if (r.post !== r.pre) out.push({ slot: sg.slot, account, owner: r.owner, delta: r.post - r.pre, signature: sg.signature });
    }
    if (page.length < 1000 || page.at(-1).slot <= fromSlot) break;
    before = page.at(-1).signature;
  }
  return out;
}

// ---- audit ----
console.log(`Vault ${VAULT} (mint ${MINT}), slot ${auditSlot}`);
console.log(`  publisher ${vault.publisher}, guardian ${vault.guardian}; funded ${fmt(vault.holdersFunded)} XNT, paid ${fmt(vault.holdersPaid)} XNT`);
const onchain = [
  vault.list.epoch > 0n ? { state: "active", ...vault.list } : null,
  vault.pending.epoch > 0n ? { state: "pending", ...vault.pending } : null,
].filter(Boolean) as { state: string; epoch: bigint; root: string; total: bigint; cid: string | null }[];
if (!onchain.length) throw new Error("no list published yet");

const scan = await rpc<any>("getProgramAccounts", [TOKEN_2022, {
  encoding: "base64", commitment: "confirmed", withContext: true, filters: [{ memcmp: { offset: 0, bytes: MINT } }], dataSlice: { offset: 0, length: 72 },
}]);
const scanSlot: number = scan.context.slot;
const tokenAccounts: { pubkey: string; owner: string; amount: bigint }[] = scan.value.map((a: any) => { const x = Buffer.from(a.account.data[0], "base64"); return { pubkey: a.pubkey, owner: bs58.encode(x.subarray(32, 64)), amount: x.readBigUInt64LE(64) }; });

const audited: any[] = [];
const lists = [];
for (const l of onchain) lists.push({ ...l, file: await fetchList(l.cid!) });
for (let i = 0; i < BACK; i++) { // older lists: their root and CID come from the next list's `prev`, which the chain vouches for
  const p = lists[0].file.inputs?.prev;
  if (!p) break;
  const f = await fetchList(p.cid);
  lists.unshift({ state: "previous", epoch: BigInt(p.epoch), root: p.root, total: BigInt(f.total), cid: p.cid, file: f });
}
const changes = HISTORY ? await changesAfter(Math.min(...lists.map((l) => Number(l.file.inputs.slot))), scanSlot) : [];
for (const c of changes) if (!tokenAccounts.some((a) => a.pubkey === c.account)) tokenAccounts.push({ pubkey: c.account, owner: c.owner, amount: 0n }); // closed since
if (HISTORY) console.log(`  ${new Set(changes.map((c) => c.signature)).size} transactions changed TEST balances since the oldest snapshot; ${tokenAccounts.filter((a) => !scan.value.some((x: any) => x.pubkey === a.pubkey)).length} of their accounts are closed now`);
const ownerAt = (slot: number) => { // every owner's TEST at the end of `slot`
  const m = new Map<string, bigint>();
  for (const a of tokenAccounts) m.set(a.owner, (m.get(a.owner) ?? 0n) + a.amount);
  for (const c of changes) if (c.slot > slot) m.set(c.owner, (m.get(c.owner) ?? 0n) - c.delta);
  return m;
};
const publications = await findPublications(new Set(lists.map((l) => l.epoch)), Math.min(...lists.map((l) => Number(l.file.inputs?.slot ?? 0))));

for (const l of lists) {
  const f = l.file;
  console.log(`\nList ${l.epoch} (${l.state}) ${l.cid}: ${f.entries.length} wallets, total ${fmt(BigInt(f.total))} XNT`);
  check(true, `list ${l.epoch}: file served by IPFS hashes to the CID ${l.state === "previous" ? "the next list names" : "stored on-chain"}`);
  check(f.vault === VAULT && f.mint === MINT && BigInt(f.epoch) === l.epoch, `list ${l.epoch}: file is for this vault, mint and epoch`);
  const root = merkleRoot(Buffer.from(bs58.decode(VAULT)), f.entries).toString("hex");
  check(root === l.root && f.root === l.root, `list ${l.epoch}: entries give the ${l.state === "previous" ? "root the next list names" : "on-chain root"}`);
  const sum = f.entries.reduce((a: bigint, [, c]: [string, string]) => a + BigInt(c), 0n);
  check(sum === l.total && BigInt(f.total) === l.total, `list ${l.epoch}: entries add up to the ${l.state === "previous" ? "file's" : "on-chain"} total (${fmt(sum)} XNT)`);

  const pub = publications.get(l.epoch);
  check(!!pub && pub.signerSigned && pub.signer === vault.publisher && pub.root === l.root && pub.total === l.total.toString() && pub.cid === l.cid,
    `list ${l.epoch}: publish_list ${pub ? pub.signature.slice(0, 12) + "…" : "(not found)"} signed by the publisher with this root, total and CID`);
  if (pub) check(pub.slot >= Number(f.inputs.slot), `list ${l.epoch}: published (slot ${pub.slot}, ${et(pub.blockTime)}) after its snapshot (slot ${f.inputs.slot})`);

  // allocation, from the previous list and the file's inputs
  const inp = f.inputs;
  let prev = new Map<string, bigint>();
  if (inp.prev) {
    const pf = await fetchList(inp.prev.cid);
    check(merkleRoot(Buffer.from(bs58.decode(VAULT)), pf.entries).toString("hex") === inp.prev.root && String(pf.epoch) === String(inp.prev.epoch),
      `list ${l.epoch}: previous list ${inp.prev.epoch} fetched by CID gives the root it names`);
    prev = new Map(pf.entries.map(([w, c]: [string, string]) => [w, BigInt(c)]));
  }
  const start = new Map(prev);
  for (const [w, x] of inp.paid as [string, string][]) if (BigInt(x) > (start.get(w) ?? 0n)) start.set(w, BigInt(x));
  const pot = BigInt(inp.holdersFunded) - [...start.values()].reduce((a, b) => a + b, 0n);
  check(pot === BigInt(inp.pot) && BigInt(inp.holdersFunded) <= vault.holdersFunded, `list ${l.epoch}: pot = holdersFunded − Σ start = ${fmt(pot)} XNT`);
  const bal = (inp.balances as [string, string][]).map(([w, b]) => [w, BigInt(b)] as [string, bigint]);
  const sumBal = bal.reduce((a, [, b]) => a + b, 0n);
  const calc = new Map(start); let biggest: [string, bigint] | null = null;
  for (const [w, b] of bal) {
    const s = sumBal ? (pot * b) / sumBal : 0n;
    calc.set(w, (calc.get(w) ?? 0n) + s);
    if (!biggest || s > biggest[1] || (s === biggest[1] && w < biggest[0])) biggest = [w, s];
  }
  const csum = [...calc.values()].reduce((a, b) => a + b, 0n), floor = BigInt(inp.floor);
  if (csum < floor && biggest) calc.set(biggest[0], calc.get(biggest[0])! + (floor - csum));
  for (const [w, c] of calc) if (c === 0n) calc.delete(w);
  const got = new Map<string, bigint>(f.entries.map(([w, c]: [string, string]) => [w, BigInt(c)]));
  const diffs = [...new Set([...calc.keys(), ...got.keys()])].filter((w) => calc.get(w) !== got.get(w));
  check(!diffs.length, `list ${l.epoch}: every entry recomputes from the inputs${diffs.length ? ` (${diffs.length} differ)` : ""}`);
  check([...prev].every(([w, c]) => (got.get(w) ?? 0n) >= c), `list ${l.epoch}: nobody's total is below the previous list`);

  // eligibility at the snapshot. The builder records getSlot() before scanning, so its read can land a few slots
  // later: the balances must all match at the recorded slot or at one slot after it, before the list was published.
  const rules = f.rules, minH = BigInt(rules.minHolding), snap = Number(inp.slot);
  const stated = new Map(bal);
  const excludedWhy = (owner: string) => rules.excludeOwners.includes(owner) ? "excludeOwners" : owner === authPda ? "vault auth PDA"
    : rules.excludeOffCurve && !PublicKey.isOnCurve(new PublicKey(owner).toBytes()) ? "off-curve (program-owned)" : null;
  const nowBy = ownerAt(scanSlot);
  let readSlot: number | null = null, at = new Map<string, bigint>();
  if (HISTORY) {
    const candidates = [snap, ...new Set(changes.filter((c) => c.slot > snap && c.slot < (pub?.slot ?? snap)).map((c) => c.slot).sort((x, y) => x - y))];
    for (const c of candidates) { const m = ownerAt(c); if ([...stated].every(([w, b]) => (m.get(w) ?? 0n) === b)) { readSlot = c; at = m; break; } }
    if (readSlot === null) at = ownerAt(snap);
    const wrong = [...stated].filter(([w, b]) => (at.get(w) ?? 0n) !== b).map(([w]) => w);
    check(readSlot !== null, `list ${l.epoch}: all ${stated.size} balances it used equal the owner's TEST at ${readSlot === snap ? `its snapshot slot ${snap}` : readSlot !== null ? `slot ${readSlot} (${readSlot - snap} after the recorded ${snap}, before publication)` : `slot ${snap} (${wrong.map((w) => w.slice(0, 4)).join(", ")} differ)`}`);
    const missing = [...at].filter(([w, b]) => b >= minH && !stated.has(w) && !excludedWhy(w)).map(([w]) => w);
    check(!missing.length, `list ${l.epoch}: no eligible owner (≥ ${fmt(minH)} TEST then, not excluded, including accounts closed since) is missing${missing.length ? `: ${missing.join(", ")}` : ""}`);
  }
  const holders = [...new Set([...nowBy.keys(), ...at.keys()])].map((owner) => ({ owner, now: nowBy.get(owner) ?? 0n, snapshot: HISTORY ? at.get(owner) ?? 0n : null, excluded: excludedWhy(owner), stated: stated.get(owner) ?? null }));
  check(bal.every(([w, b]) => b >= minH && !holders.find((h) => h.owner === w)?.excluded && !rules.excludeOwners.includes(w)), `list ${l.epoch}: every balance used meets minHolding and no excluded owner earns`);
  const excludedHeld = holders.filter((h) => h.excluded && h.now >= minH).sort((a, b) => (b.now > a.now ? 1 : -1));
  for (const h of excludedHeld) console.log(`    excluded ${h.owner} ${fmt(h.now)} TEST now (${h.excluded})`);
  audited.push({ list: l, file: f, pub, holders, excludedHeld, pot, readSlot });
}

// ---- payments ----
console.log("\nPayments");
const recs: any[] = await rpc("getProgramAccounts", [PROGRAM.toBase58(), { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 81 }, { memcmp: { offset: 8, bytes: VAULT } }] }]);
const paid = new Map(recs.map((r) => { const x = Buffer.from(r.account.data[0], "base64"); return [bs58.encode(x.subarray(40, 72)), x.readBigUInt64LE(72)] as [string, bigint]; }));
const paidSum = [...paid.values()].reduce((a, b) => a + b, 0n);
check(paidSum === vault.holdersPaid, `${paid.size} PaidRecords add up to holders_paid (${fmt(paidSum)} XNT)`);
check(vault.holdersPaid <= vault.list.total && vault.list.total <= vault.holdersFunded, "holders_paid ≤ list_total ≤ holders_funded");
const active = audited.find((a) => a.list.state === "active");
if (active) {
  const tot = new Map<string, bigint>(active.file.entries.map(([w, c]: [string, string]) => [w, BigInt(c)]));
  const over = [...paid].filter(([w, p]) => p > (tot.get(w) ?? 0n) && p > vault.fallbackPaid);
  check(!over.length, `nobody was paid more than the active list ${active.list.epoch} gives them`);
}

// ---- evidence ----
const failed = checks.filter((c) => !c.ok);
const newest = lists.reduce((a, b) => (b.epoch > a.epoch ? b : a));
const dir = path.join(OUT, `${new Date().toISOString().slice(0, 10)}-epoch-${newest.epoch}`);
fs.mkdirSync(path.join(dir, "lists"), { recursive: true });
for (const [cid, b] of files) fs.writeFileSync(path.join(dir, "lists", `${cid}.json`), b); // exact bytes, so the CID still checks
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);
fs.writeFileSync(path.join(dir, "vault.json"), j({ slot: auditSlot, rpc: RPC, dataBase64: acc.value.data[0], decoded: vault }));
fs.writeFileSync(path.join(dir, "publications.json"), j([...publications.values()]));
fs.writeFileSync(path.join(dir, "balances.json"), j({ scanSlot, changes, lists: audited.map((a) => ({ epoch: a.list.epoch, snapshotSlot: a.file.inputs.slot, matchedAtSlot: a.readSlot, holders: a.holders.filter((h: any) => h.now > 0n || h.snapshot || h.stated !== null) })) }));
fs.writeFileSync(path.join(dir, "paid-records.json"), j(Object.fromEntries(paid)));
fs.writeFileSync(path.join(dir, "checks.json"), j({ auditedAt: new Date().toISOString(), slot: auditSlot, rpc: RPC, passed: !failed.length, checks }));
const md = [
  `# Payout audit: ${MINT} at slot ${auditSlot}`, "",
  `Run ${et(Date.now() / 1000)} with \`npx tsx scripts/audit-payouts.ts\` against ${RPC}. **${failed.length ? `${failed.length} check(s) FAILED` : `All ${checks.length} checks passed`}.**`, "",
  `Vault \`${VAULT}\`: publisher \`${vault.publisher}\`, guardian \`${vault.guardian}\`, funded ${fmt(vault.holdersFunded)} XNT, paid ${fmt(vault.holdersPaid)} XNT.`, "",
  "| List | State | CID | Snapshot slot | Published | Wallets | Total XNT | Pot XNT |", "|---|---|---|---|---|---|---|---|",
  ...audited.map((a) => `| ${a.list.epoch} | ${a.list.state} | \`${a.list.cid}\` | ${a.file.inputs.slot} | ${a.pub ? `[${a.pub.signature.slice(0, 10)}…](https://explorer.mainnet.x1.xyz/tx/${a.pub.signature}) ${et(a.pub.blockTime)}` : "not found"} | ${a.file.entries.length} | ${fmt(a.list.total)} | ${fmt(a.pot)} |`),
  "", "## Checks", "", ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.what}`),
  "", "## Excluded holders (≥ minHolding now)", "",
  ...(audited.at(-1)?.excludedHeld ?? []).map((h: any) => `- \`${h.owner}\`: ${fmt(h.now)} TEST (${h.excluded})`),
  "", "## What this does and doesn't show", "",
  "- The leaf, tree, CID and allocation rules are reimplemented from docs/tax-vault-spec.md, not imported from the site. The leaf sort was added to the spec after an audit found it only in the site's code.",
  "- Snapshot balances are today's balances (read at a known slot) minus every TEST balance change after the snapshot, taken from every transaction that names the mint. That history is complete because TEST's transfer fee makes Token-2022 refuse transfers that don't name the mint; it includes accounts closed since. It trusts the RPC's transaction history; rerun with `--rpc` against another provider to cross-check.",
  "- The builder records its snapshot slot before it scans, so its balances can be from a few slots later; the check accepts one slot between the recorded slot and publication at which every balance matches, and says which.",
  "- An account's owner is the one its transactions report; an owner change (SetAuthority) isn't modelled.",
  "- Program-owned (off-curve) holders are excluded by the token's rules. That is a rule, not evidence of who the tokens inside belong to: TEST held through a router, escrow or smart wallet earns nothing.",
  "- Correct arithmetic doesn't make the rules fair, and point-in-time snapshots can be gamed when a payout outweighs the round-trip tax and price impact at that size and pool depth.",
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "README.md"), md);
console.log(`\n${failed.length ? `${failed.length} FAILED` : `all ${checks.length} checks passed`}; evidence in ${path.relative(process.cwd(), dir)}/`);
process.exit(failed.length ? 1 : 0);
