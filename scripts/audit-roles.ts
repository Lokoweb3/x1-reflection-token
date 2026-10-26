/**
 * Creator rewards and operator independence for a Tax Vault, checked on-chain. Evidence goes to <out>/<date>/.
 *
 *   npx tsx scripts/audit-roles.ts [--mint <mint>] [--rpc <url>] [--payer <funded address>] [--recent 300] [--out audits/roles]
 *
 * Creator rewards: the vault's lock NFT, its lp_locker lock (same pool), the reward vault (["reward", nft, reward_mint]):
 * its token balance against deposited − claimed, the tax vault's deposits against the reward vault's, the NFT's supply
 * and mint authority, and every deposit and claim with who signed and where claimed tokens went.
 *
 * Operator independence: the publisher, guardian and the windows the deployed program enforces (APPOINT_AFTER_SECS,
 * FALLBACK_AFTER_SECS; the mainnet build has no features, see audits/upgrades/*\/REPRODUCE.md); who signed the vault's
 * recent transactions, by instruction; whether each list file is served by public IPFS gateways (a fallback payout needs
 * the file to build proofs); and simulations, never sent, from a payer with no role: `pay` must succeed for a wallet
 * that is owed, and the role-gated instructions must fail with the program's own role or window error.
 *
 * The simulations build instructions with src/taxvault.ts; the deployed program decides whether they pass.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  TAX_VAULT_PROGRAM_ID as PROGRAM, LOCKER_PROGRAM_ID as LOCKER, IX, errorName, decodeVault, buildVaultTree,
  payIx, payFallbackIx, appointPublisherIx, publishListIx, cancelListIx, collectIx,
} from "../src/taxvault.js";

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const RPC = arg("rpc", "https://rpc.mainnet.x1.xyz")!;
const MINT = new PublicKey(arg("mint", "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz")!); // TEST
// Any funded system account with no role in the vault pays the simulated fees (nothing is signed or sent).
const PAYER = new PublicKey(arg("payer", "cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY")!);
const RECENT = Number(arg("recent", "300"));
const OUT = arg("out", path.join(import.meta.dirname, "..", "audits", "roles"))!;
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const APPOINT_AFTER_SECS = 7 * 86_400, FALLBACK_AFTER_SECS = 30 * 86_400; // tax_vault at 7f2097d, no features

const conn = new Connection(RPC, "confirmed");
const checks: { ok: boolean; what: string }[] = [];
const check = (ok: boolean, what: string) => { checks.push({ ok, what }); console.log(`  ${ok ? "PASS" : "FAIL"} ${what}`); };
const et = (unix: number) => new Date(unix * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";
const xnt = (l: bigint) => (Number(l) / 1e9).toFixed(6);
const pda = (program: PublicKey, ...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
const disc = (name: string) => Buffer.from(crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
async function txKeys(sig: string) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat().map(String);
  const ixs = [...tx.transaction.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex], accounts: i.accountKeyIndexes, data: Buffer.from(i.data) })),
    ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions.map((i) => ({ program: keys[i.programIdIndex], accounts: i.accounts, data: Buffer.from(bs58.decode(i.data)) })))];
  return { tx, keys, ixs, feePayer: keys[0] };
}

const vaultAddr = pda(PROGRAM, Buffer.from("vault"), MINT.toBuffer());
const vInfo = await conn.getAccountInfo(vaultAddr);
if (!vInfo) throw new Error("no vault");
const v = decodeVault(vaultAddr, vInfo.data);
const d = vInfo.data;
const now = Math.floor(Date.now() / 1000);
const creatorNft = new PublicKey(d.subarray(72, 104)), rewardMint = new PublicKey(d.subarray(104, 136));
const totalCreatorXnt = d.readBigUInt64LE(446), xntCreator = d.readBigUInt64LE(286), totalRewardOut = d.readBigUInt64LE(482);
console.log(`Vault ${vaultAddr.toBase58()} for ${MINT.toBase58()}`);

// ---------------- creator rewards ----------------
console.log("\nCreator rewards");
const lockAddr = pda(LOCKER, Buffer.from("lock"), creatorNft.toBuffer());
const lock = await conn.getAccountInfo(lockAddr);
check(!!lock && lock.owner.equals(LOCKER) && new PublicKey(lock.data.subarray(40, 72)).equals(v.pool),
  `the vault's creator NFT ${creatorNft.toBase58().slice(0, 6)}… is an lp_locker lock on the vault's own pool`);
const nftMint = (await conn.getParsedAccountInfo(creatorNft)).value?.data as any;
const nftHolders = (await conn.getTokenLargestAccounts(creatorNft)).value.filter((a) => a.amount === "1");
const nftHolderAcc = nftHolders[0] ? (await conn.getParsedAccountInfo(nftHolders[0].address)).value?.data as any : null;
const nftOwner: string | null = nftHolderAcc?.parsed?.info?.owner ?? null;
check(nftMint?.parsed?.info?.supply === "1" && nftMint?.parsed?.info?.mintAuthority === null && nftHolders.length === 1,
  `the NFT is one of one (supply 1, no mint authority), held by ${nftOwner}`);

const rewardVault = pda(LOCKER, Buffer.from("reward"), creatorNft.toBuffer(), rewardMint.toBuffer());
const rewardTokens = pda(LOCKER, Buffer.from("reward_tokens"), rewardVault.toBuffer());
const rv = await conn.getAccountInfo(rewardVault);
let reward: any = null;
if (rv) {
  const r = rv.data;
  const tranches = Array.from({ length: 10 }, (_, i) => ({ amount: r.readBigUInt64LE(96 + i * 16), unlockAt: Number(r.readBigInt64LE(104 + i * 16)) })).filter((t) => t.amount > 0n);
  const bal = BigInt((await conn.getTokenAccountBalance(rewardTokens)).value.amount);
  const dec = (await conn.getTokenAccountBalance(rewardTokens)).value.decimals;
  reward = { address: rewardVault.toBase58(), rewardMint: rewardMint.toBase58(), claimable: r.readBigUInt64LE(72), totalDeposited: r.readBigUInt64LE(80), totalClaimed: r.readBigUInt64LE(88), tranches, balance: bal, decimals: dec };
  const vesting = tranches.reduce((s, t) => s + t.amount, 0n);
  const u = (x: bigint) => (Number(x) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 6 });
  console.log(`  reward vault ${rewardVault.toBase58()}: deposited ${u(reward.totalDeposited)}, claimed ${u(reward.totalClaimed)}, vesting ${u(vesting)}, claimable now ${u(reward.claimable)} (reward mint ${rewardMint.toBase58()})`);
  check(bal === reward.totalDeposited - reward.totalClaimed && bal === vesting + reward.claimable,
    `reward vault holds exactly deposited − claimed = vesting + claimable (${u(bal)})`);
  check(reward.totalDeposited >= totalRewardOut, `reward vault deposits (${u(reward.totalDeposited)}) cover the tax vault's total_reward_out (${u(totalRewardOut)}); anyone may add more`);
  for (const t of tranches) console.log(`    vesting ${u(t.amount)} until ${et(t.unlockAt)}`);
} else check(false, "the reward vault exists");
console.log(`  tax vault: creator share ${v.creatorBps / 100}% of each collection; ${xnt(totalCreatorXnt)} XNT swapped for the creator so far, ${xnt(xntCreator)} XNT waiting`);
// The split, over the vault's life: burn is burn_bps of everything collected; of the XNT from sales, holders (before
// the crank reward, which the program takes out of the holders' part) get holders_bps per creator_bps, and LP keeps
// half its share as tokens, so its XNT is lp_bps/2 per creator_bps. Rounding goes to holders, hence the tolerance.
const holdersBps = 10_000 - v.burnBps - v.lpBps - v.creatorBps;
const creatorAll = totalCreatorXnt + xntCreator, holdersAll = v.holdersFunded + d.readBigUInt64LE(454), lpAll = d.readBigUInt64LE(438) + d.readBigUInt64LE(278);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, b);
check(v.totalCollected > 0n && near(Number(v.totalBurned) / Number(v.totalCollected), v.burnBps / 10_000), `burned ${Number(v.totalBurned * 1_000_000n / v.totalCollected) / 10_000}% of all TEST collected (burn_bps ${v.burnBps})`);
check(near(Number(holdersAll) / Number(creatorAll), holdersBps / v.creatorBps), `holders' XNT + crank rewards = ${(Number(holdersAll) / Number(creatorAll)).toFixed(7)} × the creator's (expected ${holdersBps}/${v.creatorBps})`);
check(near(Number(lpAll) / Number(creatorAll), v.lpBps / 2 / v.creatorBps), `LP's XNT = ${(Number(lpAll) / Number(creatorAll)).toFixed(7)} × the creator's (expected ${v.lpBps / 2}/${v.creatorBps}: half of LP's share stays as tokens)`);

// deposits and claims, from the reward vault's history
const events: any[] = [];
if (rv) {
  const CLAIM = disc("claim_reward"), DEPOSIT = disc("deposit_reward");
  for (let before: string | undefined; ;) {
    const sigs = await conn.getSignaturesForAddress(rewardVault, { limit: 1000, before });
    for (const s of sigs) {
      if (s.err) continue;
      const t = await txKeys(s.signature);
      if (!t) continue;
      for (const ix of t.ixs) {
        if (ix.program !== LOCKER.toBase58()) continue;
        if (ix.data.subarray(0, 8).equals(DEPOSIT)) events.push({ kind: "deposit", at: s.blockTime, signature: s.signature, by: t.keys[ix.accounts[0]], amount: ix.data.readBigUInt64LE(8), viaTaxVault: t.ixs.some((x) => x.program === PROGRAM.toBase58()) });
        if (ix.data.subarray(0, 8).equals(CLAIM)) {
          const to = t.keys[ix.accounts[5]];
          const pre = t.tx.meta?.preTokenBalances?.find((b) => t.keys[b.accountIndex] === rewardTokens.toBase58());
          const post = t.tx.meta?.postTokenBalances?.find((b) => t.keys[b.accountIndex] === rewardTokens.toBase58());
          const toOwner = t.tx.meta?.postTokenBalances?.find((b) => t.keys[b.accountIndex] === to)?.owner;
          events.push({ kind: "claim", at: s.blockTime, signature: s.signature, by: t.keys[ix.accounts[0]], to, toOwner, amount: BigInt(pre?.uiTokenAmount.amount ?? "0") - BigInt(post?.uiTokenAmount.amount ?? "0") });
        }
      }
    }
    if (sigs.length < 1000) break;
    before = sigs.at(-1)!.signature;
  }
  const deps = events.filter((e) => e.kind === "deposit"), claims = events.filter((e) => e.kind === "claim");
  const sum = (xs: any[]) => xs.reduce((s, e) => s + e.amount, 0n);
  console.log(`  ${deps.length} deposits (${deps.filter((e) => e.viaTaxVault).length} by fund_creator), ${claims.length} claims`);
  const others = new Map<string, { n: number; amount: bigint; first: number; last: number }>();
  for (const e of deps.filter((x) => !x.viaTaxVault)) { const o = others.get(e.by) ?? { n: 0, amount: 0n, first: e.at, last: e.at }; o.n++; o.amount += e.amount; o.first = Math.min(o.first, e.at); o.last = Math.max(o.last, e.at); others.set(e.by, o); }
  for (const [by, o] of others) console.log(`    other depositor ${by}: ${o.n} deposits, ${(Number(o.amount) / 10 ** reward.decimals).toFixed(6)}, ${et(o.first)} – ${et(o.last)}`);
  check(reward.totalDeposited - totalRewardOut === [...others.values()].reduce((s2, o) => s2 + o.amount, 0n), "the reward vault's deposits beyond the tax vault's total_reward_out are exactly the other depositors' deposits");
  for (const c of claims) console.log(`    claim ${et(c.at)}: ${(Number(c.amount) / 10 ** reward.decimals).toFixed(6)} by ${c.by} to an account of ${c.toOwner}`);
  check(sum(deps) === reward.totalDeposited && sum(claims) === reward.totalClaimed, "every deposit and claim in the reward vault's history adds up to its totals");
}

// ---------------- operator independence ----------------
console.log("\nOperator independence");
const appointAt = v.lastPublishAt + APPOINT_AFTER_SECS, fallbackAt = v.lastPublishAt + FALLBACK_AFTER_SECS;
console.log(`  publisher ${v.publisher.toBase58()}, guardian ${v.guardian.toBase58()}; last list ${et(v.lastPublishAt)}`);
console.log(`  if no list is published: guardian may appoint a new publisher from ${et(appointAt)}; anyone may pay_fallback from ${et(fallbackAt)}`);

// who signs the vault's transactions
const NAMES = Object.fromEntries(Object.entries(IX).map(([k, b]) => [b.toString("hex"), k]));
const bySigner = new Map<string, Map<string, number>>();
const sigs = await conn.getSignaturesForAddress(vaultAddr, { limit: Math.min(RECENT, 1000) });
for (const s of sigs) {
  if (s.err) continue;
  const t = await txKeys(s.signature);
  if (!t) continue;
  for (const ix of t.ixs) {
    if (ix.program !== PROGRAM.toBase58()) continue;
    const name = NAMES[ix.data.subarray(0, 8).toString("hex")] ?? "?";
    const role = t.feePayer === v.publisher.toBase58() ? "publisher (operator)" : t.feePayer === v.guardian.toBase58() ? "guardian" : t.feePayer;
    const m = bySigner.get(role) ?? new Map(); m.set(name, (m.get(name) ?? 0) + 1); bySigner.set(role, m);
  }
}
const span = sigs.length ? `${et(sigs.at(-1)!.blockTime!)} – ${et(sigs[0].blockTime!)}` : "";
console.log(`  last ${sigs.length} vault transactions (${span}), by fee payer:`);
for (const [who, m] of bySigner) console.log(`    ${who}: ${[...m].map(([k, n]) => `${k} ×${n}`).join(", ")}`);

// list files on public gateways
const cids = [v.listCid, v.pendingCid].filter((c): c is Buffer => !!c && c.some((x) => x));
const gateway: any[] = [];
const b32 = (b: Buffer) => { const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, x = 0, o = ""; for (const y of b) { x = (x << 8) | y; bits += 8; while (bits >= 5) { o += A[(x >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(x << (5 - bits)) & 31]; return o; };
for (const c of cids) {
  const cid = "b" + b32(Buffer.concat([Buffer.from([1, c[0], 0x12, 0x20]), c.subarray(1)]));
  for (const g of GATEWAYS) {
    let ok = false, status: number | string = "timeout";
    try { const r = await fetch(g + cid, { signal: AbortSignal.timeout(60000) }); status = r.status; ok = r.ok && crypto.createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest().equals(c.subarray(1)); } catch {}
    gateway.push({ cid, gateway: g, ok, status });
  }
  const served = gateway.filter((x) => x.cid === cid && x.ok).map((x) => new URL(x.gateway).host);
  console.log(`  list file ${cid.slice(0, 16)}…: ${gateway.filter((x) => x.cid === cid).map((x) => `${new URL(x.gateway).host} ${x.ok ? "served" : x.status}`).join(", ")}${served.length ? "" : " (none served it)"}`);
}

// simulations from a payer with no role
const owed = new Map<string, bigint>();
const active = JSON.parse(fs.readFileSync(fs.readdirSync(path.join(import.meta.dirname, "..", "audits", "payouts")).sort().reverse()
  .map((x) => path.join(import.meta.dirname, "..", "audits", "payouts", x, "lists")).filter((x) => fs.existsSync(x))
  .flatMap((dir) => fs.readdirSync(dir).map((f) => path.join(dir, f))).find((f) => { try { return BigInt(JSON.parse(fs.readFileSync(f, "utf8")).epoch) === v.listEpoch; } catch { return false; } })
  ?? (() => { throw new Error(`run scripts/audit-payouts.ts first: no saved file for active list ${v.listEpoch}`); })(), "utf8"));
const tree = buildVaultTree(vaultAddr, Object.fromEntries(active.entries));
if (!tree.root.equals(v.listRoot)) throw new Error("saved list doesn't give the on-chain root");
const recs = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 81 }, { memcmp: { offset: 8, bytes: vaultAddr.toBase58() } }] });
const paid = new Map(recs.map((r) => [new PublicKey(r.account.data.subarray(40, 72)).toBase58(), r.account.data.readBigUInt64LE(72)]));
for (const [w, c] of active.entries as [string, string][]) if (BigInt(c) > (paid.get(w) ?? 0n)) owed.set(w, BigInt(c) - (paid.get(w) ?? 0n));
const [wallet, amount] = [...owed].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] ?? [];

async function simulate(ixs: TransactionInstruction[], payer = PAYER) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  const custom = (r.value.err as any)?.InstructionError?.[1]?.Custom;
  return { ok: !r.value.err, error: custom !== undefined ? errorName(custom) ?? `custom ${custom}` : r.value.err ? JSON.stringify(r.value.err) : null, logs: r.value.logs?.slice(-4) };
}
const stranger = PAYER;
const sims: any[] = [];
const ROLE_ERRORS = ["NotPublisher", "NotGuardian", "PublisherActive", "FallbackNotActive"];
// want: null = must succeed; "no role error" = may fail on state (nothing to do) but not on who is calling; else that error
const expect = async (what: string, ixs: TransactionInstruction[], want: string | null) => {
  const r = await simulate(ixs);
  sims.push({ what, want, ...r });
  const ok = want === null ? r.ok : want === "no role error" ? r.ok || !ROLE_ERRORS.includes(r.error ?? "") : r.error === want;
  check(ok, `simulated ${what}: ${r.ok ? "succeeds" : `fails with ${r.error}`}${want === "no role error" ? " (not refused for who the caller is)" : want ? ` (expected ${want})` : ""}`);
};
console.log(`  simulations, fee payer ${PAYER.toBase58()} (no role in this vault; nothing is signed or sent):`);
if (wallet) await expect(`pay ${xnt(amount!)} XNT owed to ${wallet.slice(0, 6)}… by someone with no role`, [payIx(PROGRAM, stranger, MINT, new PublicKey(wallet), BigInt(Object.fromEntries(active.entries)[wallet]), tree.proofs[wallet])], null);
await expect("collect by someone with no role", [collectIx(PROGRAM, stranger, MINT)], "no role error");
if (wallet) await expect("pay_fallback before its window", [payFallbackIx(PROGRAM, stranger, MINT, new PublicKey(wallet), BigInt(Object.fromEntries(active.entries)[wallet]), tree.proofs[wallet])], "FallbackNotActive");
await expect("publish_list by someone with no role", [publishListIx(PROGRAM, stranger, MINT, Buffer.alloc(32, 7), v.listEpoch + 100n, v.listTotal, Buffer.alloc(33))], "NotPublisher");
await expect("appoint_publisher by someone with no role", [appointPublisherIx(PROGRAM, stranger, MINT, stranger)], "NotGuardian");
{ const r = await simulate([appointPublisherIx(PROGRAM, v.guardian, MINT, stranger)], v.guardian); sims.push({ what: "appoint_publisher by the guardian now", want: "PublisherActive", ...r });
  check(r.error === "PublisherActive", `simulated appoint_publisher by the guardian before ${et(appointAt)}: ${r.ok ? "succeeds" : `fails with ${r.error}`} (expected PublisherActive)`); }

// ---------------- evidence ----------------
const dir = path.join(OUT, new Date().toISOString().slice(0, 10));
fs.mkdirSync(dir, { recursive: true });
const j = (x: unknown) => JSON.stringify(x, (_, y) => (typeof y === "bigint" ? y.toString() : y), 1);
fs.writeFileSync(path.join(dir, "roles.json"), j({ rpc: RPC, at: new Date().toISOString(), vault: vaultAddr.toBase58(), creatorNft: creatorNft.toBase58(), nftOwner, reward, rewardEvents: events,
  totalCreatorXnt, xntCreator, totalRewardOut, publisher: v.publisher.toBase58(), guardian: v.guardian.toBase58(), lastPublishAt: v.lastPublishAt, appointAt, fallbackAt,
  recentSigners: Object.fromEntries([...bySigner].map(([k, m]) => [k, Object.fromEntries(m)])), gateway, simulations: sims, checks }));
fs.writeFileSync(path.join(dir, "README.md"), [
  "# Creator rewards and operator independence", "", `Run ${et(now)} with \`npx tsx scripts/audit-roles.ts\` against ${RPC}.`, "",
  "## Checks", "", ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.what}`), "",
  "## Who ran the vault recently", "", `Last ${sigs.length} vault transactions (${span}), by fee payer:`, "",
  ...[...bySigner].map(([who, m]) => `- ${who}: ${[...m].map(([k, n]) => `${k} ×${n}`).join(", ")}`), "",
  "## List files on public gateways", "", ...gateway.map((g) => `- \`${g.cid}\` ${new URL(g.gateway).host}: ${g.ok ? "served, bytes match" : "not served"}`), "",
  "## What this does and doesn't show", "",
  "- The windows are the deployed program's (reproduced from `7f2097d` without features); the simulations show the deployed code enforcing them now, not that it can't be upgraded (see audits/upgrades).",
  "- A simulation uses a funded address with no role as fee payer; signatures aren't checked and nothing is sent.",
  "- Fallback payouts need each wallet's proof, so the list file must stay retrievable. A gateway serving it today says nothing about who keeps pinning it, and a gateway refusing it (429 = rate-limited, 504 = timed out) doesn't show it's gone.",
  "- Recent fee payers show who did run the vault, not who could; anyone may run the permissionless steps.",
  "",
].join("\n"));
console.log(`\nevidence in ${path.relative(process.cwd(), dir)}/`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
