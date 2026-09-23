/**
 *   npm run admin -- status              # fee schedule, authorities, withheld fees, payout state
 *   npm run admin -- set-fee <bps>       # takes effect two epochs later (Token-2022 rule)
 *   npm run admin -- revoke-mint         # permanently fix the supply
 *   npm run admin -- lock-fee            # permanently remove the ability to change the fee
 */
import { PublicKey } from "@solana/web3.js";
import {
  AuthorityType, TOKEN_2022_PROGRAM_ID, createSetAuthorityInstruction, createSetTransferFeeInstruction,
  getTransferFeeConfig, unpackMint,
} from "@solana/spl-token";
import { connection, fromBaseUnits, loadConfig, loadKeypair, requireMint, xnt } from "./config.js";
import { scanTokenAccounts } from "./holders.js";
import { loadState, totalOwed } from "./state.js";
import { run, withPriority } from "./tx.js";

const U64_MAX = 2n ** 64n - 1n;

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const cfg = loadConfig();
  const conn = connection(cfg);
  const mint = requireMint(cfg);
  const mintState = unpackMint(mint, await conn.getAccountInfo(mint), TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(mintState);
  if (!fee) throw new Error("Mint has no transfer fee config");

  if (cmd === "status" || !cmd) {
    const { epoch } = await conn.getEpochInfo();
    const d = mintState.decimals;
    const rows = await scanTokenAccounts(conn, mint);
    const inAccounts = rows.reduce((a, r) => a + r.withheld, 0n);
    const distributor = loadKeypair(cfg.keypairs.distributor).publicKey;
    const s = loadState(mint.toBase58());
    console.log(`Mint:                 ${mint.toBase58()} (${cfg.network})`);
    console.log(`Supply:               ${fromBaseUnits(mintState.supply, d)}`);
    console.log(`Mint authority:       ${mintState.mintAuthority?.toBase58() ?? "revoked"}`);
    console.log(`Fee authority:        ${fee.transferFeeConfigAuthority.equals(PublicKey.default) ? "revoked" : fee.transferFeeConfigAuthority.toBase58()}`);
    console.log(`Withdraw authority:   ${fee.withdrawWithheldAuthority.toBase58()}`);
    console.log(`Fee (epoch ${epoch}):      older ${fee.olderTransferFee.transferFeeBasisPoints} bps; `
      + `newer ${fee.newerTransferFee.transferFeeBasisPoints} bps from epoch ${fee.newerTransferFee.epoch}`);
    console.log(`Withheld:             ${fromBaseUnits(inAccounts, d)} in accounts + ${fromBaseUnits(fee.withheldAmount, d)} in mint`);
    console.log(`Token accounts:       ${rows.length} (${rows.filter((r) => r.amount > 0n).length} non-empty)`);
    console.log(`Distributor:          ${distributor.toBase58()}  balance ${xnt(BigInt(await conn.getBalance(distributor)))}`);
    console.log(`Owed to holders:      ${xnt(totalOwed(s))} across ${Object.keys(s.owed).length} wallets`);
    console.log(`Auto-LP (${(cfg.distribution.autoLpBps ?? 0) / 100}% of fees): ${fromBaseUnits(BigInt(s.lp.tokens), d)} tokens kept, `
      + `${fromBaseUnits(BigInt(s.lp.sellTokens), d)} to sell, ${xnt(BigInt(s.lp.xnt))} raised`);
    if (s.inflight) console.log(`Unreconciled tx:      ${s.inflight.kind} ${s.inflight.signature}`);
    console.log(`Pending payout plan:  ${s.pending ? `${s.pending.batches.filter((b) => b.status !== "confirmed").length} batch(es) outstanding` : "none"}`);
    return;
  }

  const creator = loadKeypair(cfg.keypairs.creator);
  const p = cfg.distribution.priorityMicroLamports;
  if (cmd === "set-fee") {
    const bps = Number(arg);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("usage: set-fee <basis points 0..10000>");
    const sig = await run(conn, withPriority([
      createSetTransferFeeInstruction(mint, creator.publicKey, [], bps, U64_MAX, TOKEN_2022_PROGRAM_ID)], p), creator);
    console.log(`Fee set to ${bps} bps, effective in 2 epochs. ${sig}`);
  } else if (cmd === "revoke-mint") {
    const sig = await run(conn, withPriority([createSetAuthorityInstruction(
      mint, creator.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID)], p), creator);
    console.log(`Mint authority revoked. ${sig}`);
  } else if (cmd === "lock-fee") {
    const sig = await run(conn, withPriority([createSetAuthorityInstruction(
      mint, creator.publicKey, AuthorityType.TransferFeeConfig, null, [], TOKEN_2022_PROGRAM_ID)], p), creator);
    console.log(`Fee config authority revoked; the fee can never change. ${sig}`);
  } else {
    throw new Error(`Unknown command ${cmd}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
