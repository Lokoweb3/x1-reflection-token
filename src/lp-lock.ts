/**
 * Lock XDEX LP tokens forever in the lp_locker program, behind a 1-of-1 NFT whose
 * holder can collect the trading fees the locked liquidity earns.
 *
 *   npm run lp-lock -- status                     # every lock on this pool, with fees ready to collect
 *   npm run lp-lock -- lock <amount|all>          # simulate locking the creator's LP tokens
 *   npm run lp-lock -- lock <amount|all> --yes    # send it (irreversible)
 *   npm run lp-lock -- lock <amount|all> --days 7 # timed lock: the NFT holder can unlock after 7 days
 *   npm run lp-lock -- unlock --nft <mint> --yes  # after a timed lock ends: LP back to the holder, NFT burned
 *   npm run lp-lock -- receipt --nft <mint> --yes # write the lock's receipt image into the NFT (on-chain)
 *   npm run lp-lock -- collect [--nft <mint>]     # simulate collecting fees as the NFT holder
 *   npm run lp-lock -- collect [--nft <mint>] --yes
 *
 * `lock` and `collect` sign with keypairs.creator unless --keypair <file> is given.
 * Nothing is sent without --yes. The dashboard offers the same actions with a browser wallet.
 */
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { connection, fromBaseUnits, loadConfig, loadKeypair, toBaseUnits, xnt } from "./config.js";
import { run, sign, simulate, withPriority } from "./tx.js";
import { snapshot } from "./xdex.js";
import { isqrt, listLocks, lockedLp, nftHolder, pendingFeeLp } from "./locker.js";
import { buildCollect, buildLock, buildReceipt, buildUnlock, lockerIds } from "./locker-tx.js";

const cfg = loadConfig();
const conn = connection(cfg);
const ids = lockerIds(cfg);
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const signer = loadKeypair(arg("--keypair") ?? cfg.keypairs.creator);
const send = process.argv.includes("--yes");

async function sendOrSimulate(ixs: TransactionInstruction[], extra: Keypair[] = [], priority = true) {
  // priority=false leaves out the compute-budget instructions (the receipt needs the room).
  const all = priority ? withPriority(ixs, cfg.distribution.priorityMicroLamports, 400_000) : ixs;
  if (!send) {
    const sim = await simulate(conn, (await sign(conn, all, signer, extra)).tx);
    console.log(`Simulation OK (${sim.unitsConsumed} compute units). Nothing sent; add --yes to send.`);
    return;
  }
  console.log(`Sent: ${await run(conn, all, signer, extra)}`);
}

async function status() {
  const snap = await snapshot(conn, ids.xdex, ids.pool, ids.mint);
  const sqrtK = isqrt(snap.reserveToken * snap.reserveXnt);
  const supply = snap.pool.lpSupply;
  const d = snap.pool.lpDecimals;
  const locks = await listLocks(conn, ids.programId, ids.pool);
  console.log(`lp_locker ${ids.programId.toBase58()} on pool ${ids.pool.toBase58()}: ${locks.length} lock(s)`);
  for (const l of locks) {
    const lp = await lockedLp(conn, ids.programId, l.address);
    const fee = pendingFeeLp(lp, l.principal, sqrtK, supply);
    const holder = await nftHolder(conn, l.nftMint);
    console.log(`\nLock ${l.address.toBase58()}`);
    console.log(`  NFT:            ${l.nftMint.toBase58()}  held by ${holder?.owner.toBase58() ?? "nobody (burned?)"}`);
    console.log(`  Locked:         ${fromBaseUnits(lp, d)} LP (${(Number(lp * 1_000_000n / supply) / 10_000).toFixed(2)}% of pool) since ${new Date(l.lockedAt * 1000).toISOString()}`);
    console.log(`  Worth now:      ${xnt((snap.reserveXnt * lp) / supply)} + ${fromBaseUnits((snap.reserveToken * lp) / supply, 9)} tokens`);
    console.log(`  Fees ready:     ${fromBaseUnits(fee, d)} LP ≈ ${xnt((snap.reserveXnt * fee) / supply)} + ${fromBaseUnits((snap.reserveToken * fee) / supply, 9)} tokens`);
    console.log(`  Fees collected: ${fromBaseUnits(l.feeLpCollected, d)} LP so far`);
    console.log(`  Unlocks:        ${l.unlockAt === null ? "never (locked forever)" : new Date(l.unlockAt * 1000).toISOString()}`);
  }
}

async function lock() {
  const a = process.argv[3];
  if (!a) throw new Error("usage: lock <amount|all> [--yes]");
  const snap = await snapshot(conn, ids.xdex, ids.pool, ids.mint);
  const days = arg("--days");
  if (days !== undefined && !(Number(days) > 0)) throw new Error("--days must be a positive number");
  const unlockAt = days === undefined ? undefined : Math.floor(Date.now() / 1000 + Number(days) * 86_400);
  const { ixs, signers, summary: s } = await buildLock(conn, cfg, signer.publicKey,
    a === "all" ? "all" : toBaseUnits(a, snap.pool.lpDecimals), unlockAt);
  const d = s.lpDecimals;
  const until = s.unlockAt === null ? "FOREVER" : `until ${new Date(s.unlockAt * 1000).toISOString()}`;
  console.log(`Lock ${fromBaseUnits(s.lp, d)} of ${fromBaseUnits(s.held, d)} LP (${(Number(s.lp * 1_000_000n / s.lpSupply) / 10_000).toFixed(2)}% of the pool) ${until}.`);
  console.log(`  NFT mint: ${s.nftMint.toBase58()} -> ${signer.publicKey.toBase58()}`);
  console.log(`  Lock:     ${s.lock.toBase58()}   Vault: ${s.vault.toBase58()}`);
  if (send) console.log(s.unlockAt === null
    ? "  This cannot be undone. The liquidity can never be withdrawn; only fees can be collected."
    : "  This cannot be undone early. Until the unlock time, only fees can be collected.");
  await sendOrSimulate(ixs, signers);
  if (send) await printReceipt(s.nftMint);
}

async function printReceipt(nftMint: PublicKey) {
  const { ixs, receipt: r, printed } = await buildReceipt(conn, cfg, signer.publicKey, nftMint);
  if (printed) { console.log("Receipt already printed in this NFT."); return; }
  console.log(`Receipt for ${nftMint.toBase58()}: ${r.symbol}, ${r.lockedLp} LP (${r.lpSharePct.toFixed(2)}%), ${r.term}, locked ${r.lockedAt}`);
  await sendOrSimulate(ixs, [], false);
}

async function receipt() {
  const nft = arg("--nft");
  if (!nft) throw new Error("usage: receipt --nft <mint> [--yes]");
  await printReceipt(new PublicKey(nft));
}

async function collect() {
  const nft = arg("--nft");
  const { ixs, summary: s } = await buildCollect(conn, cfg, signer.publicKey, nft ? new PublicKey(nft) : undefined, process.argv.includes("--force"));
  if (!ixs) {
    console.log(s.feeLp > 0n ? `Fees ready are dust (~${xnt(s.worth)}); wait for more trading. (--force to collect anyway)` : "No trading fees to collect yet.");
    return;
  }
  console.log(`Collect ${fromBaseUnits(s.feeLp, s.lpDecimals)} LP of fees from lock ${s.lock.toBase58()}:`);
  console.log(`  ≈ ${xnt(s.xntOut)} + ${fromBaseUnits(s.tokenOut, 9)} ${cfg.token.symbol} (after the ${cfg.token.symbol} transfer fee)`);
  await sendOrSimulate(ixs);
}

async function unlock() {
  const nft = arg("--nft");
  if (!nft) throw new Error("usage: unlock --nft <mint> [--yes]");
  const { ixs, summary: s } = await buildUnlock(conn, cfg, signer.publicKey, new PublicKey(nft));
  console.log(`Unlock ${s.lock.toBase58()}: ${fromBaseUnits(s.lp, 9)} LP back to ${signer.publicKey.toBase58()}, NFT burned.`);
  await sendOrSimulate(ixs);
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { status, lock, receipt, collect, unlock };
(commands[cmd ?? "status"] ?? (() => Promise.reject(new Error(`Unknown command ${cmd}`))))()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
