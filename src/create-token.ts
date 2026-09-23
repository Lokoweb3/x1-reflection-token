/**
 * Create the reflection token: a Token-2022 mint with a transfer fee and on-chain metadata.
 *
 *   npm run create-token                          # fresh random mint address
 *   npm run create-token -- --mint-keypair vanity.json
 *
 * With token.launchGrace=true the mint starts at 0% and the configured fee is
 * scheduled for two epochs later (~1.5–2 days on X1). That lets you seed XDEX
 * liquidity without losing feeBps of the deposit to the fee.
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  createMintToCheckedInstruction, createSetTransferFeeInstruction, getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { STATE_DIR, connection, loadConfig, loadKeypair, saveConfigField, toBaseUnits } from "./config.js";
import { run, withPriority } from "./tx.js";

const U64_MAX = 2n ** 64n - 1n; // no per-transfer fee cap

async function main() {
  const cfg = loadConfig();
  if (cfg.mint) throw new Error(`config.mint is already set (${cfg.mint}); clear it to create another token.`);
  const conn = connection(cfg);
  const creator = loadKeypair(cfg.keypairs.creator);
  const distributor = loadKeypair(cfg.keypairs.distributor);

  const flag = process.argv.indexOf("--mint-keypair");
  const mintKp = flag > 0 ? loadKeypair(process.argv[flag + 1]) : Keypair.generate();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const mintFile = path.join(STATE_DIR, `mint-${mintKp.publicKey.toBase58()}.json`);
  fs.writeFileSync(mintFile, JSON.stringify(Array.from(mintKp.secretKey)), { mode: 0o600 });

  const { name, symbol, uri, decimals, feeBps, launchGrace } = cfg.token;
  const supply = toBaseUnits(cfg.token.supply, decimals);
  const mint = mintKp.publicKey;
  const metadata: TokenMetadata = { mint, name, symbol, uri, updateAuthority: creator.publicKey, additionalMetadata: [] };

  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const initialBps = launchGrace ? 0 : feeBps;

  console.log(`Network:        ${cfg.network} (${cfg.rpcUrl})`);
  console.log(`Creator:        ${creator.publicKey.toBase58()}  (mint, fee-config & metadata authority)`);
  console.log(`Distributor:    ${distributor.publicKey.toBase58()}  (withdraw-withheld authority)`);
  console.log(`Mint:           ${mint.toBase58()}  (keypair backed up to ${mintFile})`);
  console.log(`Token:          ${name} (${symbol}), ${cfg.token.supply} supply, ${decimals} decimals`);
  console.log(`Transfer fee:   ${initialBps / 100}% now${launchGrace ? `, ${feeBps / 100}% after 2 epochs` : ""}`);

  const sig1 = await run(conn, withPriority([
    SystemProgram.createAccount({
      fromPubkey: creator.publicKey, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint, creator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(
      mint, creator.publicKey, distributor.publicKey, initialBps, U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, decimals, creator.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator.publicKey,
      mint, mintAuthority: creator.publicKey, name, symbol, uri,
    }),
  ], 10_000), creator, [mintKp]);
  console.log(`Mint created:   ${sig1}`);
  saveConfigField("mint", mint.toBase58());

  const ata = getAssociatedTokenAddressSync(mint, creator.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, ata, creator.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, ata, creator.publicKey, supply, decimals, [], TOKEN_2022_PROGRAM_ID),
  ];
  if (launchGrace && feeBps > 0) {
    ixs.push(createSetTransferFeeInstruction(mint, creator.publicKey, [], feeBps, U64_MAX, TOKEN_2022_PROGRAM_ID));
  }
  const sig2 = await run(conn, withPriority(ixs, 10_000), creator);
  console.log(`Supply minted:  ${sig2}  -> ${ata.toBase58()}`);

  const epoch = await conn.getEpochInfo();
  console.log(`\nDone. config.json "mint" updated.`);
  if (launchGrace && feeBps > 0) {
    console.log(`Fee is 0% until epoch ${epoch.epoch + 2}; add XDEX liquidity before then.`);
  }
  console.log("Next: create the TOKEN/XNT pool on XDEX, set xdex.pool in config.json, then `npm run admin -- status`.");
  console.log("When satisfied: `npm run admin -- revoke-mint` so supply can never grow.");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
