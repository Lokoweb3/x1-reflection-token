/**
 * Move an existing hot-wallet factory token onto the Tax Vault (docs/tax-vault-spec.md).
 *
 * One transaction, signed by the token's old distributor key and the publisher key (payer):
 *   1. Token-2022 SetAuthority(WithheldWithdraw): distributor -> the vault's auth PDA
 *   2. init_vault with the token's burn / liquidity split, publisher = the publisher key,
 *      guardian = the token's creator
 * After it lands, the launch record and per-launch config are marked `taxVault: true`, so
 * the hot-wallet distributor skips the token and the site's vault crank serves it. Tax
 * already withheld in holder accounts is collected by the vault from then on.
 *
 * Run a normal distribution cycle first: the script refuses while collected tax, set-aside
 * XNT or unpaid payouts worth a cycle still sit with the distributor (dust under
 * minCycleXnt / minHarvestXnt is left there, and said so).
 *
 *   REFLECT_FACTORY_DIR=... npx tsx scripts/migrate-to-vault.ts <mint>             # dry run
 *   REFLECT_FACTORY_DIR=... npx tsx scripts/migrate-to-vault.ts <mint> --execute   # send it
 *   ... --ignore-owed   proceed although holders are still owed small amounts (they stay
 *                       with the old distributor wallet)
 *
 * The main config (REFLECT_CONFIG, default config.json) gives the RPC and factory.taxVault.
 */
import fs from "node:fs";
import path from "node:path";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  AuthorityType, TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getTransferFeeConfig, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { Config, DEFAULT_MIN_HARVEST_XNT, FACTORY_DIR, connection, fromBaseUnits, loadConfig, loadKeypair, toBaseUnits, xnt } from "../src/config.js";
import { run, simulate, withPriority } from "../src/tx.js";
import { scanTokenAccounts } from "../src/holders.js";
import { snapshot, spotValue } from "../src/xdex.js";
import { CREATOR_BPS, initVaultIx, validSplit, vaultAuthPda, vaultPda } from "../src/taxvault.js";
import { markTaxVault, pairOf, readLaunch } from "../src/factory/launch.js";

const args = process.argv.slice(2);
const flags = new Set(["--execute", "--ignore-owed"]);
const unknown = args.filter((a) => a.startsWith("--") && !flags.has(a));
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}. Use --execute, --ignore-owed.`);
const mintArg = args.find((a) => !a.startsWith("--"));
if (!mintArg) throw new Error("Usage: npx tsx scripts/migrate-to-vault.ts <mint> [--execute] [--ignore-owed]");
const execute = args.includes("--execute");
const ignoreOwed = args.includes("--ignore-owed");

const cfg = loadConfig();
const conn = connection(cfg);
const tv = cfg.factory?.taxVault;
if (!tv?.programId) throw new Error("Set factory.taxVault.programId in the main config first.");
if (!tv.publisherKeypair) throw new Error("Set factory.taxVault.publisherKeypair (the crank / list publisher key; it pays for the vault account).");
const program = new PublicKey(tv.programId);
const publisher = loadKeypair(tv.publisherKeypair);
const mint = new PublicKey(mintArg);
const dir = path.join(FACTORY_DIR, "launches", mint.toBase58());
const refuse = (why: string): never => { console.error(`Refusing: ${why}`); process.exit(1); };

const r = readLaunch(mint.toBase58()) ?? refuse(`no launch record in ${dir}`);
const cfgFile = path.join(dir, "config.json");
if (!fs.existsSync(cfgFile)) refuse("the token isn't registered (no per-launch config.json)");
const tokenCfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Config;
if (r.taxVault || tokenCfg.taxVault) refuse("the token is already marked as a Tax Vault token");
if (pairOf(cfg, r).xntPool || tokenCfg.xdex.quoteMint) refuse(`the vault only takes XNT-paired tokens; this one is paired with ${r.quote}`);

// The old distributor must be the current withdraw authority, and sign.
const distributor = loadKeypair(path.resolve(dir, "distributor.json"));
if (distributor.publicKey.toBase58() !== r.distributor) refuse("distributor.json doesn't match the launch record's distributor");
const mintInfo = await conn.getAccountInfo(mint, "confirmed");
if (!mintInfo) refuse("mint not found on this network");
const mintState = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
const fee = getTransferFeeConfig(mintState) ?? refuse("the mint has no transfer fee");
if (!fee.withdrawWithheldAuthority.equals(distributor.publicKey)) refuse(`the withdraw authority is ${fee.withdrawWithheldAuthority.toBase58()}, not this distributor`);
if (!fee.transferFeeConfigAuthority.equals(PublicKey.default)) refuse("the tax can still be changed (fee config authority set); the vault needs it fixed");

// The pool must be TOKEN/wXNT (snapshot checks the pair).
const pool = new PublicKey(tokenCfg.xdex.pool || r.pool);
const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), pool, mint).catch((e) => refuse(`pool ${pool.toBase58()}: ${e instanceof Error ? e.message : e}`));
const lockNft = tokenCfg.creatorReward?.nftMint ?? r.lockNft ?? refuse("no lock NFT recorded for the creator reward");

const burnBps = tokenCfg.distribution.burnBps ?? 0, lpBps = tokenCfg.distribution.autoLpBps ?? 0;
if (!validSplit(burnBps, lpBps)) refuse(`the vault can't take this split (burn ${burnBps / 100}%, liquidity ${lpBps / 100}%)`);
if ((tokenCfg.distribution.creatorBps ?? 0) !== CREATOR_BPS) {
  console.warn(`Note: the vault's creator share is fixed at ${CREATOR_BPS / 100}%; this token's config has ${(tokenCfg.distribution.creatorBps ?? 0) / 100}%.`);
}
if (await conn.getAccountInfo(vaultPda(program, mint), "confirmed")) refuse("a vault already exists for this mint");

// Nothing may be left mid-cycle with the distributor.
const lock = path.join(dir, "state", "distributor.lock");
if (fs.existsSync(lock)) {
  try { process.kill(Number(fs.readFileSync(lock, "utf8")), 0); refuse("a distribution cycle is running right now; try again when it's done"); } catch { /* stale lock */ }
}
const stateFile = path.join(dir, "state", "distributor-state.json");
const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
const big = (v: unknown) => BigInt(String(v ?? "0"));
const firstCycle = "run a normal distribution cycle for this token first (factory distributor or \"Distribute now\")";
// A cycle always leaves some dust (auto-LP remainders under minCycleXnt): that much may stay
// with the old distributor; anything worth a cycle has to go through one first.
const dustXnt = toBaseUnits(tokenCfg.distribution.minCycleXnt, 9);
const dustTokensXnt = toBaseUnits(tokenCfg.distribution.minHarvestXnt ?? DEFAULT_MIN_HARVEST_XNT, 9);
const ata = getAssociatedTokenAddressSync(mint, distributor.publicKey, false, TOKEN_2022_PROGRAM_ID);
const ataInfo = await conn.getAccountInfo(ata, "confirmed");
const held = ataInfo ? unpackAccount(ata, ataInfo, TOKEN_2022_PROGRAM_ID).amount : 0n;
if (st) {
  if (st.inflight) refuse(`a ${st.inflight.kind} transaction is still being reconciled; ${firstCycle}`);
  if (st.pending) refuse(`a payout plan is unfinished; ${firstCycle}`);
  if (st.claims?.pending) refuse(`a holder-pass root is unfinished; ${firstCycle}`);
  if (big(st.creator?.rewardTokens) > 0n) refuse(`the creator's reward tokens haven't been deposited yet; ${firstCycle}`);
  const asideXnt = big(st.lp?.xnt) + big(st.creator?.xnt);
  if (asideXnt >= dustXnt) refuse(`${xnt(asideXnt)} is set aside for auto-LP or the creator; ${firstCycle}`);
  if (asideXnt > 0n) console.warn(`Leaving ${xnt(asideXnt)} of auto-LP / creator dust with the old distributor wallet.`);
  const owed = Object.values((st.owed ?? {}) as Record<string, string>).reduce((a, v) => a + BigInt(v), 0n);
  if (owed > 0n) {
    if (!ignoreOwed) refuse(`holders are still owed ${xnt(owed)} (${Object.keys(st.owed).length} wallets, under minPayoutXnt). Lower minPayoutXnt and ${firstCycle}, or pass --ignore-owed to leave it with the old distributor wallet.`);
    console.warn(`Holders are owed ${xnt(owed)} that stays with the old distributor wallet (--ignore-owed).`);
  }
}
const heldXnt = spotValue(held, snap);
if (held > 0n && heldXnt >= dustTokensXnt) refuse(`the distributor still holds ${fromBaseUnits(held, mintState.decimals)} collected tokens (~${xnt(heldXnt)}); ${firstCycle}`);
if (held > 0n) console.warn(`Leaving ${fromBaseUnits(held, mintState.decimals)} ${r.symbol} of collected-tax dust (~${xnt(heldXnt)}) in the old distributor's token account.`);

const rows = await scanTokenAccounts(conn, mint);
const waiting = rows.reduce((a, x) => a + x.withheld, 0n) + fee.withheldAmount;
const auth = vaultAuthPda(program, mint);
const ixs = [
  createSetAuthorityInstruction(mint, distributor.publicKey, AuthorityType.WithheldWithdraw, auth, [], TOKEN_2022_PROGRAM_ID),
  initVaultIx(program, { payer: publisher.publicKey, mint, pool, creatorNft: new PublicKey(lockNft), burnBps, lpBps, publisher: publisher.publicKey, guardian: new PublicKey(r.creator) }),
];

console.log(`Migrate ${r.symbol} (${mint.toBase58()}) to the Tax Vault on ${cfg.network}
  vault program      ${program.toBase58()}
  vault              ${vaultPda(program, mint).toBase58()}
  new withdraw auth  ${auth.toBase58()} (was the distributor ${distributor.publicKey.toBase58()})
  pool               ${pool.toBase58()}
  creator lock NFT   ${lockNft}
  split              burn ${burnBps / 100}% · liquidity ${lpBps / 100}% · creator ${CREATOR_BPS / 100}% · holders ${(10_000 - burnBps - lpBps - CREATOR_BPS) / 100}%
  publisher (payer)  ${publisher.publicKey.toBase58()}
  guardian           ${r.creator} (the creator; can cancel a pending rewards list)
  tax not yet collected: ${fromBaseUnits(waiting, mintState.decimals)} ${r.symbol} (the vault collects it)
  the distributor's leftover XNT (${xnt(BigInt(await conn.getBalance(distributor.publicKey, "confirmed")))}) stays in its wallet`);

const opts = cfg.distribution.priorityMicroLamports;
if (!execute) {
  // Read-only check that the transaction would go through, once the program is deployed.
  const prog = await conn.getAccountInfo(program, "confirmed");
  if (!prog?.executable) {
    console.log("\nDry run. The vault program isn't deployed on this network yet, so the transaction wasn't simulated.");
  } else {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: publisher.publicKey, blockhash, lastValidBlockHeight }).add(...withPriority(ixs, opts, 200_000));
    tx.sign(publisher, distributor);
    try { await simulate(conn, tx); console.log("\nDry run: simulation passed. Run again with --execute to send it."); }
    catch (e) { console.log(`\nDry run: simulation FAILED:\n${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
  }
} else {
  const sig = await run(conn, withPriority(ixs, opts, 200_000), publisher, [distributor]);
  console.log(`\nMigrated: ${sig}`);
  markTaxVault(mint.toBase58());
  console.log("Marked taxVault: true in the launch record and per-launch config. The site's vault crank serves the token from its next pass.");
}
