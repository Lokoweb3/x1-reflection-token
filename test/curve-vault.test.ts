/**
 * Bonding-curve launches on a Tax Vault site: the mint's withdraw authority is the vault's
 * auth PDA (no distributor key), the launch is a vault launch, and after graduation the
 * creator's "Start the tax vault" transaction uses the pool and lock NFT the curve created.
 * Without factory.taxVault a curve token keeps its distributor wallet. No network: the
 * connection is a stand-in that answers the few reads the builders make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, SystemProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, decodeInitializeTransferFeeConfigInstructionUnchecked,
} from "@solana/spl-token";
import type { Config } from "../src/config.js";

// Launch records and keys go to a throwaway factory directory (read when config.js loads).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curve-vault-test-"));
process.env.REFLECT_FACTORY_DIR = dir;
process.env.PINATA_JWT = "";
const { buildCurveStep, buildVaultStep, launchStatus, validateCurveParams, vaultLaunches, vaultManaged } = await import("../src/factory/launch.js");
const { CURVE_DISC, CURVE_LEN, CurveStatus, IX: CURVE_IX, authPda, curvePda, curveSetup } = await import("../src/curve.js");
const { IX, vaultAuthPda, vaultPda } = await import("../src/taxvault.js");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const CURVE = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const TAX_VAULT = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const feeMint = Keypair.generate().publicKey;
const publisher = Keypair.generate();
const publisherFile = path.join(dir, "publisher.json");
fs.writeFileSync(publisherFile, JSON.stringify(Array.from(publisher.secretKey)));
const creator = Keypair.generate().publicKey;

function config(taxVault: boolean, network: "testnet" | "mainnet" = "testnet") {
  return {
    network, xdex: { programId: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf", pool: "" },
    factory: {
      feeReceiver: Keypair.generate().publicKey.toBase58(), feeUsdc: "1", gasXnt: "0.05",
      feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" },
      curve: { programId: CURVE.toBase58() },
      ...(taxVault ? { taxVault: { programId: TAX_VAULT.toBase58(), publisherKeypair: publisherFile } } : {}),
    },
  } as unknown as Config;
}

/** A curve account as the program lays it out, at `status`, with its pool and lock NFT. */
function curveData(mint: PublicKey, status: number, pool: PublicKey, lockNft: PublicKey) {
  const b = Buffer.alloc(CURVE_LEN);
  CURVE_DISC.copy(b, 0);
  mint.toBuffer().copy(b, 8); creator.toBuffer().copy(b, 40);
  const o = 72 + 8 * 9 + 8; // nine u64 fields, then created_at
  b[o] = status;
  pool.toBuffer().copy(b, o + 1 + 4 + 8); lockNft.toBuffer().copy(b, o + 1 + 4 + 8 + 32);
  b.writeUInt16LE(500, o + 1 + 4 + 8 + 64);
  return b;
}

/** Answers the builders' reads: the fee token's mint and the creator's balance of it, plus `accounts`. */
function fakeConn(accounts = new Map<string, { owner: PublicKey; data: Buffer }>()) {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  return {
    getMinimumBalanceForRentExemption: async (n: number) => 1_000 * n,
    getAccountInfo: async (k: PublicKey) => {
      if (k.equals(feeMint)) return { owner: TOKEN_PROGRAM_ID, data: mintData, lamports: 1, executable: false };
      const a = accounts.get(k.toBase58());
      if (a) return { ...a, lamports: 1, executable: false };
      // Anything else that's asked for by the fee step is the creator's fee-token account.
      return accounts.size ? null : { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165), lamports: 1, executable: false };
    },
    getTokenAccountBalance: async () => ({ value: { amount: "5000000", decimals: 6, uiAmount: 5 } }),
  } as unknown as Connection;
}

const params = {
  creator: creator.toBase58(), name: "Vault Curve", symbol: "VCRV", description: "", image: "", supply: "1000000000", taxBps: 500,
  autoLpBps: 2500, burnBps: 2500, poolTokens: "1000000000", poolXnt: "500", lockDays: null, quote: "XNT",
};
const withdrawAuthorityOf = (ixs: TransactionInstruction[]) => {
  const ix = ixs.find((i) => i.programId.equals(TOKEN_2022_PROGRAM_ID) && i.data[0] === 26 && i.data[1] === 0)!;
  return decodeInitializeTransferFeeConfigInstructionUnchecked(ix).data;
};
const launchFile = (mint: string, f: string) => path.join(dir, "launches", mint, f);

test("vault curve launches only on testnet with a vault program and a publisher key", () => {
  assert.equal(vaultLaunches(config(true)), true);
  assert.equal(vaultLaunches(config(false)), false);
  assert.equal(vaultLaunches(config(true, "mainnet")), false);
});

test("with the Tax Vault set up, a curve token's tax is withdrawable only by the vault's auth PDA; no distributor key", async () => {
  const { ixs, record } = await buildCurveStep(fakeConn(), config(true), params, "http://127.0.0.1:1", CURVE);
  const mint = new PublicKey(record.mint);
  const fee = withdrawAuthorityOf(ixs);
  assert.ok(fee.withdrawWithheldAuthority?.equals(vaultAuthPda(TAX_VAULT, mint)), "withdraw authority = the vault's auth PDA");
  assert.equal(fee.transferFeeConfigAuthority, null, "the tax can never change");
  assert.equal(fee.transferFeeBasisPoints, 500);
  assert.equal(fee.maximumFee, 2n ** 64n - 1n, "no fee cap (the vault requires it)");
  // No distributor wallet: nothing pre-funded, no key file.
  assert.ok(!ixs.some((i) => i.programId.equals(SystemProgram.programId) && i.data.readUInt32LE(0) === 2 && !i.keys[1].pubkey.equals(mint)), "no gas transfer");
  assert.equal(fs.existsSync(launchFile(record.mint, "distributor.json")), false);
  assert.equal(record.taxVault, true);
  assert.equal(record.kind, "curve");
  assert.equal(record.distributor, vaultAuthPda(TAX_VAULT, mint).toBase58());
  assert.ok(vaultManaged(record), "the factory distributor skips it");
  // Minting goes to the curve (set before create_curve, the last instruction).
  assert.ok(ixs.at(-1)!.programId.equals(CURVE));
  const saved = JSON.parse(fs.readFileSync(launchFile(record.mint, "launch.json"), "utf8"));
  assert.equal(saved.taxVault, true);
  assert.ok(!authPda(CURVE, mint).equals(vaultAuthPda(TAX_VAULT, mint)));
});

test("without the Tax Vault, a curve token keeps its own distributor wallet", async () => {
  const { ixs, record } = await buildCurveStep(fakeConn(), config(false), params, "http://127.0.0.1:1", CURVE);
  const fee = withdrawAuthorityOf(ixs);
  assert.ok(fee.withdrawWithheldAuthority?.equals(new PublicKey(record.distributor)));
  const key = JSON.parse(fs.readFileSync(launchFile(record.mint, "distributor.json"), "utf8"));
  assert.ok(Keypair.fromSecretKey(Uint8Array.from(key)).publicKey.equals(new PublicKey(record.distributor)));
  assert.equal(record.taxVault, undefined);
  assert.equal(vaultManaged(record), false);
});

test("after graduation the creator starts the vault with the curve's pool and lock NFT; not before", async () => {
  const cfg = config(true);
  const { record } = await buildCurveStep(fakeConn(), cfg, params, "http://127.0.0.1:1", CURVE);
  const mint = new PublicKey(record.mint);
  const pool = Keypair.generate().publicKey, nft = Keypair.generate().publicKey;
  const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
  const setCurve = (status: number) => accounts.set(curvePda(CURVE, mint).toBase58(), { owner: CURVE, data: curveData(mint, status, pool, nft) });

  setCurve(CurveStatus.PoolCreated);
  let s = await launchStatus(fakeConn(accounts), cfg, record);
  assert.deepEqual({ lock: s.lock, taxVault: "taxVault" in s && s.taxVault, vault: "vault" in s && s.vault }, { lock: false, taxVault: true, vault: false });
  await assert.rejects(buildVaultStep(fakeConn(accounts), cfg, record, nft.toBase58()), /hasn't graduated/);

  setCurve(CurveStatus.Graduated);
  s = await launchStatus(fakeConn(accounts), cfg, record);
  assert.equal(s.lock, true);
  assert.equal(s.lockNft, nft.toBase58());
  assert.equal("vault" in s && s.vault, false, "graduated, vault not started yet");
  const [ix] = await buildVaultStep(fakeConn(accounts), cfg, record, s.lockNft!);
  assert.ok(ix.programId.equals(TAX_VAULT));
  assert.ok(ix.data.subarray(0, 8).equals(IX.initVault));
  assert.equal(ix.data.readUInt16LE(8), 2500); assert.equal(ix.data.readUInt16LE(10), 2500);
  assert.ok(new PublicKey(ix.data.subarray(12, 44)).equals(publisher.publicKey), "publisher = the site's key");
  assert.ok(new PublicKey(ix.data.subarray(44, 76)).equals(creator), "guardian = the creator");
  assert.ok(ix.keys[0].pubkey.equals(creator) && ix.keys[0].isSigner, "the creator signs and pays");
  assert.ok(ix.keys[1].pubkey.equals(mint) && ix.keys[4].pubkey.equals(pool) && ix.keys[6].pubkey.equals(nft), "the curve's pool and lock NFT");

  accounts.set(vaultPda(TAX_VAULT, mint).toBase58(), { owner: TAX_VAULT, data: Buffer.alloc(8) });
  s = await launchStatus(fakeConn(accounts), cfg, record);
  assert.equal("vault" in s && s.vault, true, "started");
  await assert.rejects(buildVaultStep(fakeConn(accounts), cfg, record, nft.toBase58()), /already started/);
});

test("a curve create request picks its graduation target: default 500, only the allowed values", async () => {
  const raw = { creator: creator.toBase58(), name: "Target Curve", symbol: "TGT", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 2500 };
  assert.equal(validateCurveParams(raw).poolXnt, "500", "default 500 XNT");
  assert.equal(validateCurveParams({ ...raw, targetXnt: "" }).poolXnt, "500");
  for (const t of [500, 1000, 3000, 5000, 10000]) assert.equal(validateCurveParams({ ...raw, targetXnt: t }).poolXnt, String(t));
  assert.equal(validateCurveParams({ ...raw, targetXnt: "10,000" }).poolXnt, "10000");
  for (const bad of [0, 20, 499, 501, 20000, "lots"]) {
    assert.throws(() => validateCurveParams({ ...raw, targetXnt: bad }), /Graduation target must be 500, 1,000, 3,000, 5,000 or 10,000 XNT/, `should reject ${bad}`);
  }
  // A client can't sneak another pool amount in: poolXnt always follows the target.
  assert.equal(validateCurveParams({ ...raw, poolXnt: "20" }).poolXnt, "500");

  // create_curve carries (supply, target) and the launch record keeps the target as the pool's XNT.
  const p = validateCurveParams({ ...raw, targetXnt: "10000" });
  const { ixs, record } = await buildCurveStep(fakeConn(), config(true), p, "http://127.0.0.1:1", CURVE);
  const create = ixs.at(-1)!;
  assert.ok(create.programId.equals(CURVE) && create.data.subarray(0, 8).equals(CURVE_IX.createCurve));
  assert.equal(create.data.length, 24);
  assert.equal(create.data.readBigUInt64LE(8), 1_000_000_000n);
  assert.equal(create.data.readBigUInt64LE(16), 10_000n);
  assert.equal(record.poolXnt, "10000");
  assert.equal(record.poolTokens, "200000000", "the pool's share (S - T) before the transfer fee");
  assert.equal(curveSetup(1_000_000_000n, 500, 10_000n).Pg, 200_000_000n * 10n ** 9n);
});
