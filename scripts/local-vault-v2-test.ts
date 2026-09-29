/**
 * tax_vault v2 end-to-end test (docs/tax-vault-spec.md "# v2") against a LOCAL validator
 * cloned from X1 testnet. Nothing is sent to testnet or mainnet.
 *
 * The program starts as the v1 build (upgradeable, with a throwaway local upgrade
 * authority); a v1 vault runs a cycle; then the v2 build is deployed over it on the local
 * validator, `upgrade_vault` converts the vault in place and v2 continues from there.
 *
 *   solana-keygen new --no-bip39-passphrase -s -o <scratch>/upgrade-authority.json
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY \
 *     --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --clone AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ \
 *     --clone 6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA \
 *     --clone 5GUzsG219nDBZJvS2xN5L8gQr43G9owzMhEL1X3a6soS --clone FQG6rKgbDCBxVxWZimckZpBMedkGC7RqBLXGMQ379sr2 \
 *     --clone 5nwh3vHNEyhGRA2Hc2o24ekTvqVSr7Dm7C3rkPH7GkP --clone CdQJoNNF1UpYekqzaXKekDc5hsrD6zzuZEMQv8hLavfc \
 *     --upgradeable-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault-test/tax_vault.so <upgrade authority pubkey>
 *   LOCAL_RPC=http://127.0.0.1:8999 UPGRADE_AUTHORITY=<scratch>/upgrade-authority.json \
 *     [SOLANA_CLI=<path to solana>] npx tsx scripts/local-vault-v2-test.ts
 *
 * (the XNM mint, its XNM/XNT pool and the pool's vaults / LP mint / observation are the
 * --clone accounts; the pool's amm config is 3Fzz…, cloned above.) Both builds use
 * `--features "testnet short-windows"`: v1 in lp-locker/target/vault-test, v2 in
 * lp-locker/target/vault2-test (override with V2_SO).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMintLen, getTransferFeeAmount, unpackAccount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { buildBuy, buildCreatePool, buildSell, cpmmOut, decodePool, poolAddresses, poolAuthority, quoteBuy, quoteSell, snapshot } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this test only runs against a local validator");
const conn = new Connection(RPC, "confirmed");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// v2 network constants (testnet).
const REWARD_MINT = new PublicKey("AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ"); // XNM
const REWARD_POOL = new PublicKey("6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA"); // XNM/XNT
const REWARD_MAX_IMPACT_BPS = 300n, MAX_CANCELS_IN_ROW = 2;
const V1_LEN = 480, V2_LEN = 552;
const TAX_BPS = 500;
const BURN_BPS = 2500, LP_BPS = 2500;
const OUT_TOLERANCE_BPS = 50n, MIN_SELL_XNT = 2_000_000n, MIN_LP_XNT = 10_000_000n;
const DECIMALS = 9;
const U64_MAX = 2n ** 64n - 1n;
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
const tok = (t: bigint) => (Number(t) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 0 });
const ok = (s: string) => console.log(`  ✓ ${s}`);

// ---------- Program client (mirrors docs/tax-vault-spec.md) ----------

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const pda = (seeds: Buffer[], program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const vaultPda = (mint: PublicKey) => pda([Buffer.from("vault"), mint.toBuffer()]);
const authPda = (mint: PublicKey) => pda([Buffer.from("auth"), mint.toBuffer()]);
const recordPda = (vault: PublicKey, wallet: PublicKey) => pda([Buffer.from("paid"), vault.toBuffer(), wallet.toBuffer()]);
const lockPda = (nft: PublicKey) => pda([Buffer.from("lock"), nft.toBuffer()], LOCKER);
const rewardVaultPda = (nft: PublicKey, rewardMint: PublicKey) => pda([Buffer.from("reward"), nft.toBuffer(), rewardMint.toBuffer()], LOCKER);
const rewardTokensPda = (rv: PublicKey) => pda([Buffer.from("reward_tokens"), rv.toBuffer()], LOCKER);
const u64 = (...v: bigint[]) => { const b = Buffer.alloc(8 * v.length); v.forEach((x, i) => b.writeBigUInt64LE(x, 8 * i)); return b; };
const u16 = (...v: number[]) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16LE(x, 2 * i)); return b; };
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const ix = (name: string, keys: ReturnType<typeof m>[], args: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(`global:${name}`), args]) });
const authToken = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, authPda(mint), true, TOKEN_2022_PROGRAM_ID);
const authWxnt = (mint: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, authPda(mint), true, TOKEN_PROGRAM_ID);
const authReward = (mint: PublicKey) => getAssociatedTokenAddressSync(REWARD_MINT, authPda(mint), true, TOKEN_2022_PROGRAM_ID);

const initVaultIx = (payer: PublicKey, mint: PublicKey, pool: PublicKey, nft: PublicKey, burn: number, lp: number,
  publisher: PublicKey, guardian: PublicKey) => ix("init_vault", [
  m(payer, true, true), m(mint, false, false), m(vaultPda(mint), false, true), m(authPda(mint), false, true),
  m(pool, false, false), m(lockPda(nft), false, false), m(nft, false, false), m(SystemProgram.programId, false, false),
  m(SYSVAR_INSTRUCTIONS_PUBKEY, false, false),
], Buffer.concat([u16(burn, lp), publisher.toBuffer(), guardian.toBuffer()]));
const collectIx = (caller: PublicKey, mint: PublicKey, harvest: PublicKey[]) => ix("collect", [
  m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(mint, false, true),
  m(authToken(mint), false, true), m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
  m(SystemProgram.programId, false, false), ...harvest.map((h) => m(h, false, true)),
]);
interface PoolKeys { pool: PublicKey; lpMint: PublicKey; tokenVault: PublicKey; wxntVault: PublicKey; observation: PublicKey }
function poolKeys(mint: PublicKey): PoolKeys {
  const a = poolAddresses(XDEX, AMM_CONFIG, mint);
  const tokenIs0 = a.mint0.equals(mint);
  return { pool: a.pool, lpMint: a.lpMint, tokenVault: tokenIs0 ? a.vault0 : a.vault1, wxntVault: tokenIs0 ? a.vault1 : a.vault0, observation: a.observation };
}
const sellIx = (caller: PublicKey, mint: PublicKey, maxTokens: bigint) => {
  const p = poolKeys(mint);
  return ix("sell", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(mint, false, false),
    m(authToken(mint), false, true), m(authWxnt(mint), false, true), m(p.pool, false, true), m(AMM_CONFIG, false, false),
    m(poolAuthority(XDEX), false, false), m(p.tokenVault, false, true), m(p.wxntVault, false, true), m(p.observation, false, true),
    m(XDEX, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
    m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false), m(NATIVE_MINT, false, false),
  ], u64(maxTokens));
};
const addLiquidityIx = (caller: PublicKey, mint: PublicKey) => {
  const p = poolKeys(mint);
  return ix("add_liquidity", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(mint, false, false),
    m(authToken(mint), false, true), m(authWxnt(mint), false, true),
    m(getAssociatedTokenAddressSync(p.lpMint, authPda(mint), true, TOKEN_PROGRAM_ID), false, true),
    m(p.pool, false, true), m(poolAuthority(XDEX), false, false), m(p.tokenVault, false, true), m(p.wxntVault, false, true),
    m(p.lpMint, false, true), m(XDEX, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
    m(MEMO, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
    m(NATIVE_MINT, false, false),
  ]);
};
/** v1 fund_creator (reward = wrapped XNT). */
const fundCreatorV1Ix = (caller: PublicKey, mint: PublicKey, nft: PublicKey) => {
  const rv = rewardVaultPda(nft, NATIVE_MINT);
  return ix("fund_creator", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(authWxnt(mint), false, true),
    m(nft, false, false), m(NATIVE_MINT, false, false), m(rv, false, true), m(rewardTokensPda(rv), false, true),
    m(LOCKER, false, false), m(TOKEN_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false), m(lockPda(nft), false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
  ]);
};
interface RewardPool { pool: PublicKey; ammConfig: PublicKey; rewardVault: PublicKey; wxntVault: PublicKey; observation: PublicKey; side: number }
async function rewardPoolKeys(poolAddr = REWARD_POOL, rewardMint = REWARD_MINT): Promise<RewardPool> {
  const p = decodePool(poolAddr, await conn.getAccountInfo(poolAddr, "confirmed"), XDEX);
  const side = p.mints.findIndex((x) => x.equals(rewardMint));
  assert.ok(side >= 0 && p.mints[1 - side].equals(NATIVE_MINT), "reward pool is REWARD_MINT/wXNT");
  return { pool: poolAddr, ammConfig: p.ammConfig, rewardVault: p.vaults[side], wxntVault: p.vaults[1 - side], observation: p.observation, side };
}
/** v2 fund_creator: spec account order (24 accounts). */
const fundCreatorIx = (caller: PublicKey, mint: PublicKey, nft: PublicKey, rp: RewardPool,
  o: { rewardMint?: PublicKey; pool?: PublicKey } = {}) => {
  const rewardMint = o.rewardMint ?? REWARD_MINT;
  const rv = rewardVaultPda(nft, rewardMint);
  return ix("fund_creator", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(authWxnt(mint), false, true),
    m(nft, false, false), m(rewardMint, false, false), m(rv, false, true), m(rewardTokensPda(rv), false, true),
    m(LOCKER, false, false), m(TOKEN_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false), m(lockPda(nft), false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
    m(getAssociatedTokenAddressSync(rewardMint, authPda(mint), true, TOKEN_2022_PROGRAM_ID), false, true),
    m(o.pool ?? rp.pool, false, true), m(rp.ammConfig, false, false), m(poolAuthority(XDEX), false, false),
    m(rp.rewardVault, false, true), m(rp.wxntVault, false, true), m(rp.observation, false, true),
    m(XDEX, false, false), m(NATIVE_MINT, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
  ]);
};
const upgradeVaultIx = (payer: PublicKey, vault: PublicKey) =>
  ix("upgrade_vault", [m(payer, true, true), m(vault, false, true), m(SystemProgram.programId, false, false)]);
const publishIx = (publisher: PublicKey, mint: PublicKey, root: Buffer, epoch: bigint, total: bigint) =>
  ix("publish_list", [m(publisher, true, false), m(vaultPda(mint), false, true)], Buffer.concat([root, u64(epoch, total)]));
const cancelIx = (guardian: PublicKey, mint: PublicKey) => ix("cancel_list", [m(guardian, true, false), m(vaultPda(mint), false, true)]);
const payIx = (payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[]) => {
  const len = Buffer.alloc(4); len.writeUInt32LE(proof.length);
  return ix("pay", [
    m(payer, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(wallet, false, true),
    m(recordPda(vaultPda(mint), wallet), false, true), m(SystemProgram.programId, false, false),
  ], Buffer.concat([u64(cumulative), len, ...proof]));
};

interface Vault {
  raw: Buffer; mint: PublicKey; pool: PublicKey; creatorNft: PublicKey; rewardMint: PublicKey; rewardSwapPool: PublicKey;
  publisher: PublicKey; guardian: PublicKey; burnBps: number; lpBps: number; creatorBps: number; pendingTokens: bigint;
  lpTokens: bigint; sellLp: bigint; sellCreator: bigint; sellHolders: bigint; xntLp: bigint; xntCreator: bigint;
  holdersFunded: bigint; holdersPaid: bigint; listEpoch: bigint; listRoot: Buffer; listTotal: bigint; pendingEpoch: bigint;
  pendingRoot: Buffer; pendingTotal: bigint; pendingActiveAt: bigint; totalCollected: bigint; totalBurned: bigint;
  totalLpTokens: bigint; totalLpXnt: bigint; totalCreatorXnt: bigint; totalCrankRewards: bigint; createdAt: bigint;
  bump: number; authBump: number; lastSellSlot: bigint;
  // v2 (undefined on a 480-byte v1 vault)
  version?: number; cancelsInRow?: number; totalRewardOut?: bigint; lastRewardSlot?: bigint; reserved?: Buffer;
}
async function readVault(mint: PublicKey, expectLen?: number): Promise<Vault> {
  const info = await conn.getAccountInfo(vaultPda(mint), "confirmed");
  assert.ok(info && info.owner.equals(PROGRAM), "vault account");
  const d = info.data;
  assert.ok(d.length === V1_LEN || d.length === V2_LEN, `vault length ${d.length}`);
  if (expectLen) assert.equal(d.length, expectLen);
  assert.ok(d.subarray(0, 8).equals(disc("account:Vault")));
  const k = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const n = (o: number) => d.readBigUInt64LE(o);
  const v: Vault = {
    raw: Buffer.from(d),
    mint: k(8), pool: k(40), creatorNft: k(72), rewardMint: k(104), rewardSwapPool: k(136), publisher: k(168), guardian: k(200),
    burnBps: d.readUInt16LE(232), lpBps: d.readUInt16LE(234), creatorBps: d.readUInt16LE(236), pendingTokens: n(238),
    lpTokens: n(246), sellLp: n(254), sellCreator: n(262), sellHolders: n(270), xntLp: n(278), xntCreator: n(286),
    holdersFunded: n(294), holdersPaid: n(302), listEpoch: n(310), listRoot: d.subarray(318, 350), listTotal: n(350),
    pendingEpoch: n(358), pendingRoot: d.subarray(366, 398), pendingTotal: n(398), pendingActiveAt: d.readBigInt64LE(406),
    totalCollected: n(414), totalBurned: n(422), totalLpTokens: n(430), totalLpXnt: n(438), totalCreatorXnt: n(446),
    totalCrankRewards: n(454), createdAt: d.readBigInt64LE(462), bump: d[470], authBump: d[471], lastSellSlot: n(472),
  };
  if (d.length === V2_LEN) {
    Object.assign(v, { version: d[480], cancelsInRow: d[481], totalRewardOut: n(482), lastRewardSlot: n(490), reserved: d.subarray(498, 552) });
  }
  return v;
}

// ---------- Merkle list ----------

const sha = (...b: Buffer[]) => crypto.createHash("sha256").update(Buffer.concat(b)).digest();
const leafOf = (vault: PublicKey, wallet: PublicKey, cumulative: bigint) =>
  sha(Buffer.from("99tax-vault"), vault.toBuffer(), wallet.toBuffer(), u64(cumulative));
function merkle(leaves: Buffer[]) {
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const l = levels[levels.length - 1], next: Buffer[] = [];
    for (let i = 0; i < l.length; i += 2) {
      if (i + 1 === l.length) next.push(l[i]);
      else next.push(Buffer.compare(l[i], l[i + 1]) <= 0 ? sha(l[i], l[i + 1]) : sha(l[i + 1], l[i]));
    }
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];
  const proof = (idx: number) => {
    const out: Buffer[] = [];
    let i = idx;
    for (const l of levels.slice(0, -1)) { if ((i ^ 1) < l.length) out.push(l[i ^ 1]); i >>= 1; }
    return out;
  };
  return { root, proof };
}
interface List { epoch: bigint; total: bigint; entries: { wallet: PublicKey; cumulative: bigint }[]; root: Buffer; proof: (i: number) => Buffer[] }
function buildList(vault: PublicKey, epoch: bigint, entries: { wallet: PublicKey; cumulative: bigint }[]): List {
  const t = merkle(entries.map((e) => leafOf(vault, e.wallet, e.cumulative)));
  return { epoch, total: entries.reduce((s, e) => s + e.cumulative, 0n), entries, root: t.root, proof: t.proof };
}

// ---------- Helpers ----------

const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
async function fund(k: PublicKey, sol: number) {
  while (sol > 0) {
    const s = Math.min(sol, 100);
    await conn.confirmTransaction(await conn.requestAirdrop(k, s * LAMPORTS_PER_SOL), "confirmed");
    sol -= s;
  }
}
async function send(ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function txStats(sig: string) {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { cu: t?.meta?.computeUnitsConsumed ?? 0, fee: BigInt(t?.meta?.fee ?? 0), logs: t?.meta?.logMessages ?? [] };
}
function txSize(ixs: TransactionInstruction[], payer: PublicKey, signers: number, cu = 400_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  return tx.serializeMessage().length + 1 + 64 * signers;
}
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-1500)}`);
    ok(`rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function chainTime() {
  const slot = await conn.getSlot("confirmed");
  return BigInt((await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000));
}
const tokenBal = async (a: PublicKey, program = TOKEN_2022_PROGRAM_ID) => {
  const info = await conn.getAccountInfo(a, "confirmed");
  return info ? unpackAccount(a, info, program).amount : 0n;
};
async function nextSlot(after: bigint) {
  while (BigInt(await conn.getSlot("processed")) <= after + 1n) await sleep(200);
}
const stats: Record<string, { cu: number; size: number }[]> = {};
async function measured(name: string, ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000) {
  const size = txSize(ixs, signers[0].publicKey, signers.length, cu);
  assert.ok(size <= 1232, `${name}: transaction too large (${size} bytes)`);
  const sig = await send(ixs, signers, cu);
  const s = await txStats(sig);
  (stats[name] ??= []).push({ cu: s.cu, size });
  return { sig, ...s, size };
}

/** A Token-2022 tax token: metadata by `creator`, supply minted to `creator`, minting revoked. */
async function mintIxs(creator: PublicKey, mintKp: Keypair, o: { withdrawAuthority: PublicKey; supply: bigint }) {
  const mint = mintKp.publicKey;
  const uri = `https://example.invalid/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name: "Vault Test", symbol: "VLT", uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const ata = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
  return [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, null, o.withdrawAuthority, TAX_BPS, U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, creator, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, mint, mintAuthority: creator, name: "Vault Test", symbol: "VLT", uri }),
    createAssociatedTokenAccountIdempotentInstruction(creator, ata, creator, mint, TOKEN_2022_PROGRAM_ID),
    createMintToCheckedInstruction(mint, ata, creator, o.supply, DECIMALS, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ];
}

/** lp_locker `lock` of all `owner`'s LP (mirrors buildLock in src/locker-tx.ts). */
async function lockAll(owner: Keypair, mint: PublicKey) {
  const p = poolKeys(mint);
  const a = poolAddresses(XDEX, AMM_CONFIG, mint);
  const ownerLp = getAssociatedTokenAddressSync(p.lpMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
  const lp = await tokenBal(ownerLp, TOKEN_PROGRAM_ID);
  const nft = Keypair.generate();
  const lock = lockPda(nft.publicKey);
  const ownerNft = getAssociatedTokenAddressSync(nft.publicKey, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const metadata: TokenMetadata = { mint: nft.publicKey, name: "VLT LP Lock", symbol: "LPLOCK", uri: "", updateAuthority: owner.publicKey, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  await send([
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: nft.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(nft.publicKey, owner.publicKey, nft.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(nft.publicKey, 0, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: nft.publicKey, updateAuthority: owner.publicKey, mint: nft.publicKey, mintAuthority: owner.publicKey, name: metadata.name, symbol: metadata.symbol, uri: "" }),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ownerNft, owner.publicKey, nft.publicKey, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({
      programId: LOCKER, data: Buffer.concat([disc("global:lock"), u64(lp)]),
      keys: [
        m(owner.publicKey, true, true), m(p.pool, false, false), m(a.vault0, false, false), m(a.vault1, false, false),
        m(p.lpMint, false, false), m(ownerLp, false, true), m(nft.publicKey, false, true), m(ownerNft, false, true),
        m(lock, false, true), m(pda([Buffer.from("vault"), lock.toBuffer()], LOCKER), false, true),
        m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
      ],
    }),
  ], [owner, nft]);
  return { nft: nft.publicKey, lock };
}

async function launch(creator: Keypair, poolTokens: bigint, poolXnt: bigint) {
  const mintKp = Keypair.generate(), mint = mintKp.publicKey;
  await send(await mintIxs(creator.publicKey, mintKp, { withdrawAuthority: authPda(mint), supply: 1_000_000_000n * 10n ** 9n }), [creator, mintKp]);
  const cp = buildCreatePool(XDEX, "testnet", creator.publicKey, mint, poolTokens, poolXnt);
  await send(cp.ixs, [creator], 1_000_000);
  const { nft, lock } = await lockAll(creator, mint);
  return { mint, pool: cp.pool, nft, lock };
}

// ---------- Invariants ----------

let RENT0 = 0n;
async function checkInvariants(mint: PublicKey, label: string) {
  const v = await readVault(mint);
  const auth = await bal(authPda(mint));
  const promised = v.xntLp + v.xntCreator + (v.holdersFunded - v.holdersPaid);
  assert.ok(v.holdersPaid <= v.listTotal && v.listTotal <= v.holdersFunded, `${label}: paid <= list_total <= funded`);
  assert.equal(auth, promised + RENT0, `${label}: auth lamports == promised + reserve`);
  const tokens = await tokenBal(authToken(mint));
  assert.equal(tokens, v.pendingTokens + v.lpTokens + v.sellLp + v.sellCreator + v.sellHolders, `${label}: auth token balance == token buckets`);
  assert.equal(await conn.getAccountInfo(authWxnt(mint), "confirmed"), null, `${label}: no wXNT account left open`);
  assert.equal(await conn.getAccountInfo(authReward(mint), "confirmed"), null, `${label}: no reward-token account left open`);
  return v;
}

// ---------- Crank steps ----------

const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
async function trade(mint: PublicKey, pool: PublicKey, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    const t = traders[Math.floor(rnd() * traders.length)];
    const held = await tokenBal(getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID));
    if (held > 0n && rnd() < 0.45) {
      const q = await quoteSell(conn, XDEX, pool, mint, (held * BigInt(Math.floor(rnd() * 80 + 20))) / 100n, { maxImpactBps: 5000, slippageBps: 200 });
      if (q) await send(await buildSell(conn, XDEX, t, mint, q), [t]);
    } else {
      const q = await quoteBuy(conn, XDEX, pool, mint, BigInt(Math.floor((1 + rnd() * 6) * 1e9)), 200, 5000);
      await send(await buildBuy(conn, XDEX, t, q), [t]);
    }
  }
}
async function withheld(mint: PublicKey, extra: PublicKey[]) {
  const accs = [...traders.map((t) => getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID)), poolKeys(mint).tokenVault, ...extra];
  const withTax: PublicKey[] = [];
  for (const a of accs) {
    const info = await conn.getAccountInfo(a, "confirmed");
    if (info && (getTransferFeeAmount(unpackAccount(a, info, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n) > 0n) withTax.push(a);
  }
  return withTax;
}
async function collect(crank: Keypair, mint: PublicKey, creator: PublicKey) {
  const before = await readVault(mint);
  const r = await measured("collect", [collectIx(crank.publicKey, mint, await withheld(mint, [getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID)]))], [crank]);
  const v = await checkInvariants(mint, "collect");
  ok(`collect: got ${tok(v.totalCollected - before.totalCollected)} tokens (${r.cu} CU)`);
}
async function sellAll(crank: Keypair, mint: PublicKey, label: string) {
  let n = 0;
  for (;;) {
    await nextSlot((await readVault(mint)).lastSellSlot);
    const v = await readVault(mint);
    const s = await snapshot(conn, XDEX, poolKeys(mint).pool, mint);
    const impact = 250n; // sell's cap: min(300, tax 500 / 2)
    const cap = ((s.reserveToken * impact) / (10_000n - impact) * 10_000n) / 9_500n;
    const buckets = v.sellLp + v.sellCreator + v.sellHolders;
    const amount = buckets < cap ? buckets : cap;
    const expected = amount > 0n ? cpmmOut(amount - (amount * 500n + 9_999n) / 10_000n, s.reserveToken, s.reserveQuote, s.tradeFeeRate) : 0n;
    if (expected < MIN_SELL_XNT) break;
    await measured("sell", [sellIx(crank.publicKey, mint, U64_MAX)], [crank]);
    await checkInvariants(mint, "sell");
    n++;
  }
  const v = await readVault(mint);
  ok(`${label}: ${n} sells; xnt_lp ${xnt(v.xntLp)}, xnt_creator ${xnt(v.xntCreator)}, holders_funded ${xnt(v.holdersFunded)}`);
  return v;
}
async function maybeAddLiquidity(crank: Keypair, mint: PublicKey) {
  const v = await readVault(mint);
  if (v.xntLp < MIN_LP_XNT || v.lpTokens === 0n) return;
  const r = await measured("add_liquidity", [addLiquidityIx(crank.publicKey, mint)], [crank]);
  const a = await checkInvariants(mint, "add_liquidity");
  ok(`add_liquidity: ${xnt(v.xntLp - a.xntLp)} XNT deposited (${r.cu} CU)`);
}

/** Off-chain mirror of fund_creator v2's swap amount and expected output. */
async function expectedReward(mint: PublicKey, rp: RewardPool) {
  const v = await readVault(mint);
  const p = decodePool(rp.pool, await conn.getAccountInfo(rp.pool, "confirmed"), XDEX);
  const cfg = (await conn.getAccountInfo(rp.ammConfig, "confirmed"))!.data;
  const rate = cfg.readBigUInt64LE(12);
  const rX = (await tokenBal(rp.wxntVault, TOKEN_PROGRAM_ID)) - p.protocolFees[1 - rp.side] - p.fundFees[1 - rp.side];
  const rR = (await tokenBal(rp.rewardVault)) - p.protocolFees[rp.side] - p.fundFees[rp.side];
  const half = rate / 200n;
  const impact = REWARD_MAX_IMPACT_BPS < half ? REWARD_MAX_IMPACT_BPS : half;
  const cap = (rX * impact) / (10_000n - impact);
  const xntIn = v.xntCreator < cap ? v.xntCreator : cap;
  const expected = cpmmOut(xntIn, rX, rR, rate);
  return { v, xntIn, expected, minOut: (expected * (10_000n - OUT_TOLERANCE_BPS)) / 10_000n, capped: xntIn < v.xntCreator, impact };
}

async function fundCreator(crank: Keypair, mint: PublicKey, nft: PublicKey, rp: RewardPool, label: string) {
  await nextSlot((await readVault(mint)).lastRewardSlot ?? 0n);
  const e = await expectedReward(mint, rp);
  assert.ok(e.xntIn > 0n, "something to fund");
  const rv = rewardVaultPda(nft, REWARD_MINT), rt = rewardTokensPda(rv);
  const existed = !!(await conn.getAccountInfo(rv, "confirmed"));
  const rt0 = await tokenBal(rt), poolR0 = await tokenBal(rp.rewardVault), poolX0 = await tokenBal(rp.wxntVault, TOKEN_PROGRAM_ID);
  const deposited0 = existed ? (await conn.getAccountInfo(rv, "confirmed"))!.data.readBigUInt64LE(80) : 0n;
  const oldXntVault = rewardTokensPda(rewardVaultPda(nft, NATIVE_MINT));
  const oldXnt0 = await tokenBal(oldXntVault, TOKEN_PROGRAM_ID);
  const caller0 = await bal(crank.publicKey);
  const r = await measured(existed ? "fund_creator v2" : "fund_creator v2 (+ init_reward_vault)", [fundCreatorIx(crank.publicKey, mint, nft, rp)], [crank]);
  const v = await checkInvariants(mint, label);
  const out = (await tokenBal(rt)) - rt0;
  // Exact accounting.
  assert.equal(e.v.xntCreator - v.xntCreator, e.xntIn, "xnt_creator -= xnt_in");
  assert.equal(v.totalCreatorXnt - e.v.totalCreatorXnt, e.xntIn, "total_creator_xnt += xnt_in");
  assert.equal(v.totalRewardOut! - e.v.totalRewardOut!, out, "total_reward_out += reward_out");
  assert.equal(poolR0 - (await tokenBal(rp.rewardVault)), out, "lp_locker reward vault grew by exactly the swap output");
  assert.equal((await tokenBal(rp.wxntVault, TOKEN_PROGRAM_ID)) - poolX0, e.xntIn, "the pool got exactly xnt_in");
  assert.ok(out >= e.minOut, "out >= on-chain min out");
  const rvData = (await conn.getAccountInfo(rv, "confirmed"))!;
  assert.ok(rvData.owner.equals(LOCKER));
  assert.ok(new PublicKey(rvData.data.subarray(8, 40)).equals(nft) && new PublicKey(rvData.data.subarray(40, 72)).equals(REWARD_MINT));
  assert.equal(rvData.data.readBigUInt64LE(80) - deposited0, out, "reward vault total_deposited grew by the swap output");
  assert.equal(await tokenBal(oldXntVault, TOKEN_PROGRAM_ID), oldXnt0, "the old XNT reward vault is untouched");
  assert.ok(v.lastRewardSlot! > (e.v.lastRewardSlot ?? 0n));
  // The caller pays only the fee (+ the new reward vault's rent the first time).
  const newRent = existed ? 0n : BigInt((await conn.getAccountInfo(rv))!.lamports + (await conn.getAccountInfo(rt))!.lamports);
  assert.equal(caller0 - (await bal(crank.publicKey)), r.fee + newRent, "caller's temporary-account rent refunded");
  // The event.
  const ev = r.logs.filter((l) => l.startsWith("Program data: ")).map((l) => Buffer.from(l.slice("Program data: ".length), "base64"))
    .find((b) => b.subarray(0, 8).equals(disc("event:CreatorFunded")));
  assert.ok(ev && ev.length === 88, "CreatorFunded { vault, xnt_in, reward_out, reward_mint } event");
  assert.ok(new PublicKey(ev.subarray(8, 40)).equals(vaultPda(mint)));
  assert.equal(ev.readBigUInt64LE(40), e.xntIn);
  assert.equal(ev.readBigUInt64LE(48), out);
  assert.ok(new PublicKey(ev.subarray(56, 88)).equals(REWARD_MINT));
  ok(`${label}: ${xnt(e.xntIn)} XNT -> ${(Number(out) / 1e9).toFixed(6)} XNM${e.capped ? " (capped)" : ""} into the NFT's XNM reward vault${existed ? "" : " (created here)"}; `
    + `out ${out === e.expected ? "==" : "vs"} expected ${e.expected}, impact cap ${e.impact} bps (${r.cu} CU, ${r.size} bytes)`);
  return out;
}

async function publish(publisher: Keypair, mint: PublicKey, list: List) {
  await send([publishIx(publisher.publicKey, mint, list.root, list.epoch, list.total)], [publisher]);
  return readVault(mint);
}
async function payAll(crank: Keypair, mint: PublicKey, list: List) {
  while ((await chainTime()) < (await readVault(mint)).pendingActiveAt + 1n) await sleep(500);
  for (let i = 0; i < list.entries.length; i++) {
    const e = list.entries[i];
    const rec = await conn.getAccountInfo(recordPda(vaultPda(mint), e.wallet), "confirmed");
    if (rec && rec.data.readBigUInt64LE(72) >= e.cumulative) continue;
    await measured(`pay (proof ${list.proof(i).length})`, [payIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(i))], [crank]);
  }
  const v = await checkInvariants(mint, "pay");
  assert.equal(v.listEpoch, list.epoch);
  return v;
}
/** Everyone gets `share` of what's unallocated, on top of `prev`. */
function allocate(prev: Map<string, bigint>, amount: bigint) {
  const next = new Map(prev);
  for (const t of traders) next.set(t.publicKey.toBase58(), (prev.get(t.publicKey.toBase58()) ?? 0n) + amount / BigInt(traders.length));
  return next;
}
const entriesOf = (a: Map<string, bigint>) => [...a.entries()].map(([k, c]) => ({ wallet: new PublicKey(k), cumulative: c }));

// ---------- Test ----------

console.log("tax_vault v2 end-to-end (local validator, v1 -> v2 upgrade in place)");
RENT0 = BigInt(await conn.getMinimumBalanceForRentExemption(0));
const authorityPath = process.env.UPGRADE_AUTHORITY;
assert.ok(authorityPath, "UPGRADE_AUTHORITY=<throwaway local keypair file> (the --upgradeable-program authority)");
const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, "utf8"))));
const V2_SO = process.env.V2_SO ?? "lp-locker/target/vault2-test/tax_vault.so";
const SOLANA = process.env.SOLANA_CLI ?? "solana";
{
  const prog = await conn.getAccountInfo(PROGRAM);
  assert.ok(prog && prog.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111", "tax_vault is loaded as an upgradeable program");
  const pd = new PublicKey(prog.data.subarray(4, 36));
  const pdInfo = (await conn.getAccountInfo(pd))!;
  assert.ok(new PublicKey(pdInfo.data.subarray(13, 45)).equals(upgradeAuthority.publicKey), "upgrade authority is the local throwaway key");
  const rewardMint = (await conn.getAccountInfo(REWARD_MINT))!;
  assert.ok(rewardMint.owner.equals(TOKEN_2022_PROGRAM_ID), "XNM (cloned) is a Token-2022 mint");
}
const creator = Keypair.generate(), publisher = Keypair.generate(), crank = Keypair.generate(), attacker = Keypair.generate();
await fund(creator.publicKey, 300);
for (const k of [publisher, crank, attacker]) await fund(k.publicKey, 20);
for (const t of traders) await fund(t.publicKey, 200);
await fund(upgradeAuthority.publicKey, 20);
const rp = await rewardPoolKeys();
ok(`reward pool ${rp.pool.toBase58()} (XNM side ${rp.side}), amm config ${rp.ammConfig.toBase58()}`);

console.log("1. v1 program: launch, v1 vault, one full cycle, then a second cycle that leaves xnt_creator");
const A = await launch(creator, 500_000_000n * 10n ** 9n, 50n * 10n ** 9n);
const mint = A.mint, vault = vaultPda(mint);
await send([initVaultIx(creator.publicKey, mint, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]);
{
  const v = await readVault(mint, V1_LEN);
  assert.ok(v.rewardMint.equals(NATIVE_MINT) && v.rewardSwapPool.equals(PublicKey.default));
  ok(`v1 vault created (${V1_LEN} bytes, reward mint = wXNT)`);
}
await sleep(1500);
await trade(mint, A.pool, 24);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "v1 cycle 1");
await maybeAddLiquidity(crank, mint);
{
  const v = await readVault(mint);
  await send([fundCreatorV1Ix(crank.publicKey, mint, A.nft)], [crank]);
  const after = await checkInvariants(mint, "v1 fund_creator");
  assert.equal(after.xntCreator, 0n);
  ok(`v1 fund_creator: ${xnt(v.xntCreator)} XNT into the NFT's wXNT reward vault`);
}
let alloc = allocate(new Map(), ((await readVault(mint)).holdersFunded * 9n) / 10n);
const L1 = buildList(vault, 1n, entriesOf(alloc));
await publish(publisher, mint, L1);
await payAll(crank, mint, L1);
ok(`v1 list epoch 1 paid (${xnt(L1.total)} XNT)`);
await trade(mint, A.pool, 16);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "v1 cycle 2");
// A pending list at upgrade time (its fields must survive the upgrade).
alloc = allocate(alloc, ((await readVault(mint)).holdersFunded - L1.total) / 2n);
const L2 = buildList(vault, 2n, entriesOf(alloc));
await publish(publisher, mint, L2);
const beforeUpgrade = await readVault(mint, V1_LEN);
assert.ok(beforeUpgrade.xntCreator > 0n && beforeUpgrade.pendingEpoch === 2n);
ok(`v1 vault holds xnt_creator ${xnt(beforeUpgrade.xntCreator)} XNT and pending list epoch 2`);

console.log("2. Deploy the v2 build over the v1 program (local validator only)");
{
  const size = fs.statSync(V2_SO).size;
  const prog = (await conn.getAccountInfo(PROGRAM))!;
  const pd = new PublicKey(prog.data.subarray(4, 36));
  const pdLen = (await conn.getAccountInfo(pd))!.data.length - 45;
  const cli = (args: string[]) => execFileSync(SOLANA, [...args, "--url", RPC, "--keypair", authorityPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (size > pdLen) {
    cli(["program", "extend", PROGRAM.toBase58(), String(size - pdLen)]);
    ok(`program data extended by ${size - pdLen} bytes (${pdLen} -> ${size})`);
  }
  cli(["program", "deploy", "--program-id", PROGRAM.toBase58(), "--upgrade-authority", authorityPath, V2_SO]);
  ok(`v2 deployed over D9jt… (${size} bytes)`);
  await sleep(1500); // the new program is visible from the next slot
}
// Every instruction but upgrade_vault now refuses the 480-byte vault.
await fails("collect on an un-upgraded vault", send([collectIx(crank.publicKey, mint, [])], [crank]), /WrongVersion/);
await fails("sell on an un-upgraded vault", send([sellIx(crank.publicKey, mint, U64_MAX)], [crank]), /WrongVersion/);
await fails("add_liquidity on an un-upgraded vault", send([addLiquidityIx(crank.publicKey, mint)], [crank]), /WrongVersion/);
await fails("fund_creator (v2 accounts) on an un-upgraded vault", send([fundCreatorIx(crank.publicKey, mint, A.nft, rp)], [crank]), /WrongVersion/);
await fails("fund_creator (v1 accounts) on an un-upgraded vault", send([fundCreatorV1Ix(crank.publicKey, mint, A.nft)], [crank]), /WrongVersion/);
await fails("cancel_list on an un-upgraded vault", send([cancelIx(creator.publicKey, mint)], [creator]), /WrongVersion/);
await fails("publish_list on an un-upgraded vault", send([publishIx(publisher.publicKey, mint, L2.root, 3n, L2.total)], [publisher]), /WrongVersion/);
await fails("pay on an un-upgraded vault", send([payIx(crank.publicKey, mint, L1.entries[0].wallet, L1.entries[0].cumulative, L1.proof(0))], [crank]), /WrongVersion/);

console.log("3. upgrade_vault");
await fails("upgrade_vault on a non-vault program account (a PaidRecord)",
  send([upgradeVaultIx(crank.publicKey, recordPda(vault, L1.entries[0].wallet))], [crank]), /WrongAccount/);
await fails("upgrade_vault on an account the program doesn't own", send([upgradeVaultIx(crank.publicKey, A.pool)], [crank]), /WrongAccount/);
{
  const rent1 = BigInt(await conn.getMinimumBalanceForRentExemption(V1_LEN)), rent2 = BigInt(await conn.getMinimumBalanceForRentExemption(V2_LEN));
  const vaultLamports0 = await bal(vault);
  assert.equal(vaultLamports0, rent1);
  const payer0 = await bal(crank.publicKey);
  const r = await measured("upgrade_vault", [upgradeVaultIx(crank.publicKey, vault)], [crank]);
  const v = await readVault(mint, V2_LEN);
  const raw0 = beforeUpgrade.raw, raw = v.raw;
  assert.ok(raw.subarray(0, 104).equals(raw0.subarray(0, 104)), "bytes 0..104 unchanged");
  assert.ok(raw.subarray(168, 480).equals(raw0.subarray(168, 480)), "bytes 168..480 unchanged");
  assert.ok(v.rewardMint.equals(REWARD_MINT) && v.rewardSwapPool.equals(REWARD_POOL), "reward mint/pool set to XNM / XNM-XNT");
  assert.equal(v.version, 2);
  assert.equal(v.cancelsInRow, 0);
  assert.equal(v.totalRewardOut, 0n);
  assert.equal(v.lastRewardSlot, 0n);
  assert.ok(v.reserved!.equals(Buffer.alloc(54)));
  // Field by field for the v1 fields that matter.
  for (const k of ["xntCreator", "xntLp", "holdersFunded", "holdersPaid", "listEpoch", "listTotal", "pendingEpoch", "pendingTotal",
    "pendingActiveAt", "totalCollected", "totalCreatorXnt", "lastSellSlot", "createdAt", "sellLp", "sellCreator", "sellHolders", "lpTokens"] as const) {
    assert.equal(v[k], beforeUpgrade[k], `${k} intact`);
  }
  assert.ok(v.mint.equals(mint) && v.pool.equals(A.pool) && v.creatorNft.equals(A.nft) && v.publisher.equals(publisher.publicKey) && v.guardian.equals(creator.publicKey));
  assert.ok(v.listRoot.equals(beforeUpgrade.listRoot) && v.pendingRoot.equals(beforeUpgrade.pendingRoot));
  assert.deepEqual([v.burnBps, v.lpBps, v.creatorBps, v.bump, v.authBump], [beforeUpgrade.burnBps, beforeUpgrade.lpBps, beforeUpgrade.creatorBps, beforeUpgrade.bump, beforeUpgrade.authBump]);
  assert.equal(await bal(vault), rent2, "vault is rent-exempt at 552 bytes");
  assert.equal(payer0 - (await bal(crank.publicKey)), r.fee + rent2 - rent1, "payer paid exactly the extra rent");
  await checkInvariants(mint, "upgrade_vault");
  ok(`upgraded in place: 480 -> 552 bytes, v1 fields intact, reward = XNM via 6XES…, payer paid ${xnt(rent2 - rent1)} extra rent (${r.cu} CU, ${r.size} bytes)`);
}
await fails("upgrade_vault twice", send([upgradeVaultIx(crank.publicKey, vault)], [crank]), /WrongVersion/);

console.log("4. fund_creator v2: pending XNT -> XNM into the lock NFT's XNM reward vault");
await fails("fund_creator with the wrong reward mint (wXNT)",
  send([fundCreatorIx(crank.publicKey, mint, A.nft, rp, { rewardMint: NATIVE_MINT })], [crank]), /BadRewardMint/);
await fails("fund_creator with the wrong reward pool (the token's own pool)",
  send([fundCreatorIx(crank.publicKey, mint, A.nft, rp, { pool: A.pool })], [crank]), /WrongAccount/);
await fails("fund_creator with another pool's amm config / vaults",
  send([fundCreatorIx(crank.publicKey, mint, A.nft, { ...rp, wxntVault: poolKeys(mint).wxntVault })], [crank]), /WrongAccount/);
await fundCreator(crank, mint, A.nft, rp, "fund_creator after the upgrade");
{
  const v = await readVault(mint);
  assert.equal(v.xntCreator, 0n, "all pending XNT swapped (under the cap)");
}
await nextSlot((await readVault(mint)).lastRewardSlot!);
await fails("fund_creator with nothing to fund", send([fundCreatorIx(crank.publicKey, mint, A.nft, rp)], [crank]), /TooSmall/);

console.log("5. Guardian cancel limit");
{
  let v = await readVault(mint);
  assert.equal(v.pendingEpoch, 2n);
  await measured("cancel_list", [cancelIx(creator.publicKey, mint)], [creator]);
  v = await readVault(mint);
  assert.equal(v.cancelsInRow, 1);
  const L3 = buildList(vault, 3n, entriesOf(alloc));
  await publish(publisher, mint, L3);
  await send([cancelIx(creator.publicKey, mint)], [creator]);
  v = await readVault(mint);
  assert.equal(v.cancelsInRow, 2);
  ok("guardian cancelled 2 lists in a row (cancels_in_row = 2)");
  const L4 = buildList(vault, 4n, entriesOf(alloc));
  await publish(publisher, mint, L4);
  await fails("a third cancel in a row", send([cancelIx(creator.publicKey, mint)], [creator]), /TooManyCancels/);
  await fails("cancel by a non-guardian", send([cancelIx(attacker.publicKey, mint)], [attacker]), /NotGuardian/);
  v = await payAll(crank, mint, L4);
  assert.equal(v.cancelsInRow, 0, "a list going live resets the counter");
  ok(`list epoch 4 went live via pay; cancels_in_row back to 0`);
  alloc = allocate(alloc, (v.holdersFunded - v.listTotal) / 2n);
  const L5 = buildList(vault, 5n, entriesOf(alloc));
  await publish(publisher, mint, L5);
  await send([cancelIx(creator.publicKey, mint)], [creator]);
  assert.equal((await readVault(mint)).cancelsInRow, 1);
  ok("cancelling works again after a list went live");
  const L6 = buildList(vault, 6n, entriesOf(alloc));
  await publish(publisher, mint, L6);
  // publish_list activating a due list resets too.
  while ((await chainTime()) < (await readVault(mint)).pendingActiveAt + 1n) await sleep(500);
  alloc = allocate(alloc, ((await readVault(mint)).holdersFunded - L6.total) / 2n);
  const L7 = buildList(vault, 7n, entriesOf(alloc));
  v = await publish(publisher, mint, L7);
  assert.equal(v.listEpoch, 6n);
  assert.equal(v.cancelsInRow, 0, "publish_list activating the due list resets the counter");
  await payAll(crank, mint, L7);
  ok("publish_list that activates a due list also resets the counter; list 7 paid");
}

console.log("6. A full v2 cycle on the upgraded vault");
await trade(mint, A.pool, 16);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "v2 cycle");
await maybeAddLiquidity(crank, mint);
{
  await nextSlot((await readVault(mint)).lastRewardSlot!);
  // Two reward swaps in one transaction: the second is refused (one per slot).
  await fails("two fund_creator in one transaction",
    send([fundCreatorIx(crank.publicKey, mint, A.nft, rp), fundCreatorIx(crank.publicKey, mint, A.nft, rp)], [crank]), /OneSellPerSlot/);
}
await fundCreator(crank, mint, A.nft, rp, "fund_creator (existing XNM reward vault)");

console.log("7. A fresh v2 vault via init_vault");
const B = await launch(creator, 100_000_000n * 10n ** 9n, 10n * 10n ** 9n);
{
  const r = await measured("init_vault (v2)", [initVaultIx(creator.publicKey, B.mint, B.pool, B.nft, 2000, 3000, publisher.publicKey, creator.publicKey)], [creator]);
  const v = await readVault(B.mint, V2_LEN);
  assert.equal(v.version, 2);
  assert.ok(v.rewardMint.equals(REWARD_MINT) && v.rewardSwapPool.equals(REWARD_POOL));
  assert.equal(v.cancelsInRow, 0); assert.equal(v.totalRewardOut, 0n); assert.ok(v.reserved!.equals(Buffer.alloc(54)));
  assert.equal(await bal(vaultPda(B.mint)), BigInt(await conn.getMinimumBalanceForRentExemption(V2_LEN)));
  await checkInvariants(B.mint, "init_vault v2");
  ok(`init_vault creates a ${V2_LEN}-byte v2 vault (XNM / 6XES…) (${r.cu} CU, ${r.size} bytes)`);
  await fails("upgrade_vault on a fresh v2 vault", send([upgradeVaultIx(crank.publicKey, vaultPda(B.mint))], [crank]), /WrongVersion/);
}
await sleep(1500);
await trade(B.mint, B.pool, 16);
await collect(crank, B.mint, creator.publicKey);
await sellAll(crank, B.mint, "fresh vault");
await fundCreator(crank, B.mint, B.nft, rp, "fund_creator on the fresh vault");
await fails("fund_creator with another vault's lock NFT", send([fundCreatorIx(crank.publicKey, B.mint, A.nft, rp)], [crank]), /WrongAccount/);

const vf = await checkInvariants(mint, "final");
console.log("\nTotals (upgraded vault):", {
  collected: tok(vf.totalCollected), creatorXnt: xnt(vf.totalCreatorXnt), rewardOutXnm: (Number(vf.totalRewardOut) / 1e9).toFixed(6),
  holdersFunded: xnt(vf.holdersFunded), holdersPaid: xnt(vf.holdersPaid),
});
console.log("\nCompute units and transaction sizes (incl. a SetComputeUnitLimit instruction):");
for (const [name, rows] of Object.entries(stats)) {
  const cus = rows.map((r) => r.cu), sizes = rows.map((r) => r.size);
  console.log(`  ${name.padEnd(44)} ${String(Math.min(...cus)).padStart(7)}-${String(Math.max(...cus)).padEnd(7)} CU  ${Math.max(...sizes)} bytes  (${rows.length}x)`);
}
console.log("All tax-vault v2 checks passed.");
