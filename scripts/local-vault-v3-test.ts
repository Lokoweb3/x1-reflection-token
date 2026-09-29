/**
 * tax_vault v3 end-to-end test (docs/tax-vault-spec.md "# v3") against a LOCAL validator
 * cloned from X1 testnet. Nothing is sent to testnet or mainnet.
 *
 * The program starts as the v1 build (upgradeable, with a throwaway local upgrade
 * authority) so a real 480-byte v1 vault can be created; then the v2 build is deployed
 * over it and a v2 vault runs a full cycle (published + active list, payments); then the
 * v3 build is deployed over that (program data extended first), both vaults are upgraded
 * straight to v3 (552 -> 640 and 480 -> 640) and the v3 features are exercised:
 * list CIDs, set_publisher, appoint_publisher, pay_fallback and leaving fallback, plus a
 * fresh v3 init_vault.
 *
 * Use the 3.1.x solana-test-validator / solana CLI (older validators reject
 * `program extend`). From the repo root:
 *
 *   solana-keygen new --no-bip39-passphrase -s -o <scratch>/upgrade-authority.json
 *   solana-test-validator --reset --ledger <scratch>/ledger --rpc-port 9101 \
 *     --faucet-port 9102 --gossip-port 9103 --dynamic-port-range 9110-9140 \
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
 *   LOCAL_RPC=http://127.0.0.1:9101 UPGRADE_AUTHORITY=<scratch>/upgrade-authority.json \
 *     SOLANA_CLI=<3.1.x solana> npx tsx scripts/local-vault-v3-test.ts
 *
 * All three builds use `--features "testnet short-windows"` (list delay 5 s, appoint after
 * 15 s, fallback after 30 s): v1 in lp-locker/target/vault-test, v2 in
 * lp-locker/target/vault2-test (V2_SO), v3 in lp-locker/target/vault3-test (V3_SO).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMintLen, getTransferFeeAmount, unpackAccount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { buildBuy, buildCreatePool, buildSell, cpmmOut, decodePool, poolAddresses, poolAuthority, quoteBuy, quoteSell, snapshot } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:9101";
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
const V1_LEN = 480, V2_LEN = 552, V3_LEN = 640;
// v3 windows of the short-windows build (seconds).
const APPOINT_AFTER_SECS = 15n, FALLBACK_AFTER_SECS = 30n;
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
/** v1/v2 publish_list (no CID). */
const publishV2Ix = (publisher: PublicKey, mint: PublicKey, root: Buffer, epoch: bigint, total: bigint) =>
  ix("publish_list", [m(publisher, true, false), m(vaultPda(mint), false, true)], Buffer.concat([root, u64(epoch, total)]));
/** v3 publish_list(root, epoch, total, cid: [u8; 33]). */
const publishIx = (publisher: PublicKey, mint: PublicKey, root: Buffer, epoch: bigint, total: bigint, cid: Buffer) => {
  assert.equal(cid.length, 33);
  return ix("publish_list", [m(publisher, true, false), m(vaultPda(mint), false, true)], Buffer.concat([root, u64(epoch, total), cid]));
};
const setPublisherIx = (publisher: PublicKey, mint: PublicKey, next: PublicKey) =>
  ix("set_publisher", [m(publisher, true, false), m(vaultPda(mint), false, true)], next.toBuffer());
const appointPublisherIx = (guardian: PublicKey, mint: PublicKey, next: PublicKey) =>
  ix("appoint_publisher", [m(guardian, true, false), m(vaultPda(mint), false, true)], next.toBuffer());
const cancelIx = (guardian: PublicKey, mint: PublicKey) => ix("cancel_list", [m(guardian, true, false), m(vaultPda(mint), false, true)]);
const payIx = (payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[], name = "pay") => {
  const len = Buffer.alloc(4); len.writeUInt32LE(proof.length);
  return ix(name, [
    m(payer, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(wallet, false, true),
    m(recordPda(vaultPda(mint), wallet), false, true), m(SystemProgram.programId, false, false),
  ], Buffer.concat([u64(cumulative), len, ...proof]));
};
/** pay_fallback: same accounts and data as pay. */
const payFallbackIx = (payer: PublicKey, mint: PublicKey, wallet: PublicKey, cumulative: bigint, proof: Buffer[]) =>
  payIx(payer, mint, wallet, cumulative, proof, "pay_fallback");
/** A list file's CID as stored on-chain: [codec 0x55 (raw), sha256 digest]. */
const cidOf = (file: string) => Buffer.concat([Buffer.from([0x55]), crypto.createHash("sha256").update(file).digest()]);

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
  // v3 (undefined below 640 bytes)
  lastPublishAt?: bigint; listCid?: Buffer; pendingCid?: Buffer; fallbackPaid?: bigint; reserved3?: Buffer;
}
async function readVault(mint: PublicKey, expectLen?: number): Promise<Vault> {
  const info = await conn.getAccountInfo(vaultPda(mint), "confirmed");
  assert.ok(info && info.owner.equals(PROGRAM), "vault account");
  const d = info.data;
  assert.ok(d.length === V1_LEN || d.length === V2_LEN || d.length === V3_LEN, `vault length ${d.length}`);
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
  if (d.length === V3_LEN) {
    Object.assign(v, {
      version: d[480], cancelsInRow: d[481], totalRewardOut: n(482), lastRewardSlot: n(490), lastPublishAt: d.readBigInt64LE(498),
      listCid: d.subarray(506, 539), pendingCid: d.subarray(539, 572), fallbackPaid: n(572), reserved3: d.subarray(580, 640),
    });
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
/**
 * Confirm by polling (no websocket: with the ports this test uses, the validator's pubsub
 * port, rpc-port + 1, is taken by the faucet).
 */
async function confirm(sig: string) {
  for (let i = 0; i < 150; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) {
      const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      throw Object.assign(new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`), { logs: t?.meta?.logMessages ?? [] });
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`transaction ${sig} not confirmed`);
}
async function fund(k: PublicKey, sol: number) {
  while (sol > 0) {
    const s = Math.min(sol, 100);
    await confirm(await conn.requestAirdrop(k, s * LAMPORTS_PER_SOL));
    sol -= s;
  }
}
async function send(ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  // Preflight failures carry the logs (SendTransactionError.logs), as with sendAndConfirmTransaction.
  return confirm(await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" }));
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
  // v3: fallback payments can take holders_paid past list_total, never past holders_funded.
  assert.ok(v.holdersPaid <= v.holdersFunded && v.listTotal <= v.holdersFunded, `${label}: paid <= funded, list_total <= funded`);
  if ((v.fallbackPaid ?? 0n) === 0n) assert.ok(v.holdersPaid <= v.listTotal, `${label}: paid <= list_total (no fallback yet)`);
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

/** The list file (as the crank pins it to IPFS) and its CID. */
const listFile = (mint: PublicKey, list: List) => JSON.stringify({
  version: 1, mint: mint.toBase58(), vault: vaultPda(mint).toBase58(), epoch: String(list.epoch), root: list.root.toString("hex"),
  total: String(list.total), entries: list.entries.map((e) => [e.wallet.toBase58(), String(e.cumulative)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
});
async function publish(publisher: Keypair, mint: PublicKey, list: List) {
  const len = (await conn.getAccountInfo(vaultPda(mint), "confirmed"))!.data.length;
  const i = len === V3_LEN ? publishIx(publisher.publicKey, mint, list.root, list.epoch, list.total, cidOf(listFile(mint, list)))
    : publishV2Ix(publisher.publicKey, mint, list.root, list.epoch, list.total);
  await measured(len === V3_LEN ? "publish_list (v3)" : "publish_list (v1/v2)", [i], [publisher]);
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

const events = (logs: string[], name: string) => logs.filter((l) => l.startsWith("Program data: "))
  .map((l) => Buffer.from(l.slice("Program data: ".length), "base64")).filter((b) => b.subarray(0, 8).equals(disc(`event:${name}`)));
const recordPaid = async (mint: PublicKey, wallet: PublicKey) => {
  const info = await conn.getAccountInfo(recordPda(vaultPda(mint), wallet), "confirmed");
  return info ? info.data.readBigUInt64LE(72) : 0n;
};
async function waitChain(t: bigint) {
  while ((await chainTime()) < t) await sleep(500);
}

/** Deploy a build over the program (local validator only), extending the program data first if needed. */
async function deploy(so: string, label: string) {
  const size = fs.statSync(so).size;
  const prog = (await conn.getAccountInfo(PROGRAM))!;
  const pd = new PublicKey(prog.data.subarray(4, 36));
  const pdLen = (await conn.getAccountInfo(pd))!.data.length - 45;
  const cli = (args: string[]) => execFileSync(SOLANA, [...args, "--url", RPC, "--keypair", authorityPath!], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (size > pdLen) {
    cli(["program", "extend", PROGRAM.toBase58(), String(size - pdLen)]);
    ok(`program data extended by ${size - pdLen} bytes (${pdLen} -> ${size})`);
  }
  // --use-rpc: no TPU client (it needs the websocket port, see `confirm`).
  cli(["program", "deploy", "--use-rpc", "--program-id", PROGRAM.toBase58(), "--upgrade-authority", authorityPath!, so]);
  ok(`${label} deployed over D9jt… (${size} bytes)`);
  await sleep(1500); // the new program is visible from the next slot
}

/**
 * pay_fallback every entry of `list` and check each payment is exactly
 * floor(cumulative * holders_funded / list_total) - paid, the event, and the totals.
 */
async function payFallbackAll(crank: Keypair, mint: PublicKey, list: List, label: string) {
  const v0 = await readVault(mint);
  assert.equal(v0.listEpoch, list.epoch, "fallback pays from the active list");
  let sum = 0n, n = 0;
  for (let i = 0; i < list.entries.length; i++) {
    const e = list.entries[i];
    const v = await readVault(mint);
    const entitled = (e.cumulative * v.holdersFunded) / v.listTotal;
    const paid = await recordPaid(mint, e.wallet);
    if (entitled <= paid) {
      await fails(`${label}: pay_fallback with nothing owed`, send([payFallbackIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(i))], [crank]), /NothingToPay/);
      continue;
    }
    const w0 = await bal(e.wallet);
    const r = await measured(`pay_fallback (proof ${list.proof(i).length})`, [payFallbackIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(i))], [crank]);
    const amount = entitled - paid;
    assert.equal((await bal(e.wallet)) - w0, amount, "wallet got exactly floor(c*funded/total) - paid");
    assert.equal(await recordPaid(mint, e.wallet), entitled, "record.paid = entitled");
    const va = await readVault(mint);
    assert.equal(va.holdersPaid - v.holdersPaid, amount, "holders_paid += amount");
    assert.equal(va.fallbackPaid! - v.fallbackPaid!, amount, "fallback_paid += amount");
    const ev = events(r.logs, "FallbackPaid")[0];
    assert.ok(ev && ev.length === 88, "FallbackPaid { vault, wallet, amount, entitled } event");
    assert.ok(new PublicKey(ev.subarray(8, 40)).equals(vaultPda(mint)) && new PublicKey(ev.subarray(40, 72)).equals(e.wallet));
    assert.equal(ev.readBigUInt64LE(72), amount);
    assert.equal(ev.readBigUInt64LE(80), entitled);
    sum += amount;
    n++;
    // Paying the same wallet again: nothing owed.
    await fails(`${label}: second pay_fallback of the same wallet`, send([payFallbackIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(i))], [crank]), /NothingToPay/);
  }
  const v = await checkInvariants(mint, label);
  assert.ok(v.holdersPaid <= v.holdersFunded, "sum of payments <= holders_funded");
  // Rounding leaves less than one lamport per wallet of the holders' pool unpaid.
  const owed = v.holdersFunded - v.holdersPaid;
  ok(`${label}: ${n} wallets paid ${xnt(sum)} XNT; funded ${xnt(v.holdersFunded)}, paid ${xnt(v.holdersPaid)} (left ${owed} lamports), `
    + `list_total ${xnt(v.listTotal)}, fallback_paid ${xnt(v.fallbackPaid!)}`);
  return { v, sum };
}

console.log("tax_vault v3 end-to-end (local validator, v1 -> v2 -> v3 in place)");
RENT0 = BigInt(await conn.getMinimumBalanceForRentExemption(0));
const authorityPath = process.env.UPGRADE_AUTHORITY;
assert.ok(authorityPath, "UPGRADE_AUTHORITY=<throwaway local keypair file> (the --upgradeable-program authority)");
const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(authorityPath, "utf8"))));
const V2_SO = process.env.V2_SO ?? "lp-locker/target/vault2-test/tax_vault.so";
const V3_SO = process.env.V3_SO ?? "lp-locker/target/vault3-test/tax_vault.so";
const SOLANA = process.env.SOLANA_CLI ?? "solana";
{
  const prog = await conn.getAccountInfo(PROGRAM);
  assert.ok(prog && prog.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111", "tax_vault is loaded as an upgradeable program");
  const pd = new PublicKey(prog.data.subarray(4, 36));
  const pdInfo = (await conn.getAccountInfo(pd))!;
  assert.ok(new PublicKey(pdInfo.data.subarray(13, 45)).equals(upgradeAuthority.publicKey), "upgrade authority is the local throwaway key");
}
const creator = Keypair.generate(), publisher = Keypair.generate(), crank = Keypair.generate(), attacker = Keypair.generate();
const publisher2 = Keypair.generate(), publisher3 = Keypair.generate();
await fund(creator.publicKey, 400);
for (const k of [publisher, publisher2, publisher3, crank, attacker]) await fund(k.publicKey, 20);
for (const t of traders) await fund(t.publicKey, 300);
await fund(upgradeAuthority.publicKey, 20);
const rp = await rewardPoolKeys();

console.log("1. v1 program: a v1 vault (B) with a cycle, a paid list and a pending list");
const B = await launch(creator, 200_000_000n * 10n ** 9n, 20n * 10n ** 9n);
const vaultB = vaultPda(B.mint);
await send([initVaultIx(creator.publicKey, B.mint, B.pool, B.nft, 2000, 2000, publisher.publicKey, creator.publicKey)], [creator]);
await readVault(B.mint, V1_LEN);
await sleep(1500);
await trade(B.mint, B.pool, 16);
await collect(crank, B.mint, creator.publicKey);
await sellAll(crank, B.mint, "v1 vault B");
let allocB = allocate(new Map(), ((await readVault(B.mint)).holdersFunded * 8n) / 10n);
const B1 = buildList(vaultB, 1n, entriesOf(allocB));
await publish(publisher, B.mint, B1);
await payAll(crank, B.mint, B1);
allocB = allocate(allocB, ((await readVault(B.mint)).holdersFunded - B1.total) / 2n);
const B2 = buildList(vaultB, 2n, entriesOf(allocB));
await publish(publisher, B.mint, B2);
const beforeB = await readVault(B.mint, V1_LEN);
assert.ok(beforeB.pendingEpoch === 2n && beforeB.listEpoch === 1n && beforeB.xntCreator > 0n);
ok(`v1 vault B: list 1 paid (${xnt(B1.total)} XNT), list 2 pending, xnt_creator ${xnt(beforeB.xntCreator)}`);

console.log("2. v2 program: a v2 vault (A) with a full cycle, an active list and payments");
await deploy(V2_SO, "v2");
const A = await launch(creator, 500_000_000n * 10n ** 9n, 50n * 10n ** 9n);
const mint = A.mint, vault = vaultPda(mint);
await send([initVaultIx(creator.publicKey, mint, A.pool, A.nft, 2500, 2500, publisher.publicKey, creator.publicKey)], [creator]);
await readVault(mint, V2_LEN);
await sleep(1500);
await trade(mint, A.pool, 24);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "v2 cycle");
await maybeAddLiquidity(crank, mint);
await fundCreator(crank, mint, A.nft, rp, "v2 fund_creator");
let alloc = allocate(new Map(), ((await readVault(mint)).holdersFunded * 9n) / 10n);
const L1 = buildList(vault, 1n, entriesOf(alloc));
await publish(publisher, mint, L1);
await payAll(crank, mint, L1);
ok(`v2 list epoch 1 active and paid (${xnt(L1.total)} XNT to ${L1.entries.length} wallets)`);
// Another cycle so the vault holds unallocated holders' XNT, XNT for the LP and the creator.
await trade(mint, A.pool, 12);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "v2 cycle 2");
const beforeA = await readVault(mint, V2_LEN);
assert.ok(beforeA.version === 2 && beforeA.listEpoch === 1n && beforeA.holdersPaid === L1.total && beforeA.holdersFunded > L1.total);
assert.ok(beforeA.totalRewardOut! > 0n && beforeA.lastRewardSlot! > 0n, "v2 fields in use");

console.log("3. Deploy the v3 build over the v2 program (local validator only)");
await deploy(V3_SO, "v3");
await fails("collect on a v2 vault", send([collectIx(crank.publicKey, mint, [])], [crank]), /WrongVersion/);
await fails("publish_list on a v2 vault", send([publishIx(publisher.publicKey, mint, L1.root, 2n, L1.total, Buffer.alloc(33))], [publisher]), /WrongVersion/);
await fails("pay on a v2 vault", send([payIx(crank.publicKey, mint, L1.entries[0].wallet, L1.entries[0].cumulative, L1.proof(0))], [crank]), /WrongVersion/);
await fails("pay_fallback on a v2 vault", send([payFallbackIx(crank.publicKey, mint, L1.entries[0].wallet, L1.entries[0].cumulative, L1.proof(0))], [crank]), /WrongVersion/);
await fails("set_publisher on a v2 vault", send([setPublisherIx(publisher.publicKey, mint, publisher2.publicKey)], [publisher]), /WrongVersion/);
await fails("collect on a v1 vault", send([collectIx(crank.publicKey, B.mint, [])], [crank]), /WrongVersion/);

console.log("4. upgrade_vault 552 -> 640 (v2 vault A) and 480 -> 640 (v1 vault B)");
await fails("upgrade_vault on a PaidRecord", send([upgradeVaultIx(crank.publicKey, recordPda(vault, L1.entries[0].wallet))], [crank]), /WrongAccount/);
await fails("upgrade_vault on an account the program doesn't own", send([upgradeVaultIx(crank.publicKey, A.pool)], [crank]), /WrongAccount/);
const rent = async (n: number) => BigInt(await conn.getMinimumBalanceForRentExemption(n));
{
  const t0 = await chainTime();
  const payer0 = await bal(crank.publicKey);
  assert.equal(await bal(vault), await rent(V2_LEN));
  const r = await measured("upgrade_vault (552 -> 640)", [upgradeVaultIx(crank.publicKey, vault)], [crank]);
  const v = await readVault(mint, V3_LEN);
  const raw0 = beforeA.raw, raw = v.raw;
  assert.ok(raw.subarray(0, 480).equals(raw0.subarray(0, 480)), "bytes 0..480 (every v1 field) unchanged");
  assert.ok(raw.subarray(481, 498).equals(raw0.subarray(481, 498)), "bytes 481..498 (v2 fields) unchanged");
  assert.equal(v.version, 3);
  assert.deepEqual([v.cancelsInRow, v.totalRewardOut, v.lastRewardSlot], [beforeA.cancelsInRow, beforeA.totalRewardOut, beforeA.lastRewardSlot]);
  assert.ok(v.rewardMint.equals(REWARD_MINT) && v.rewardSwapPool.equals(REWARD_POOL));
  assert.ok(v.lastPublishAt! >= t0 - 2n && v.lastPublishAt! <= (await chainTime()) + 2n, `last_publish_at = now (${v.lastPublishAt} vs ${t0})`);
  assert.ok(v.listCid!.equals(Buffer.alloc(33)) && v.pendingCid!.equals(Buffer.alloc(33)) && v.fallbackPaid === 0n && v.reserved3!.equals(Buffer.alloc(60)));
  assert.ok(raw.subarray(506).equals(Buffer.alloc(134)), "bytes 506..640 zero");
  for (const k of ["xntCreator", "xntLp", "holdersFunded", "holdersPaid", "listEpoch", "listTotal", "pendingEpoch", "pendingTotal",
    "pendingActiveAt", "totalCollected", "totalBurned", "totalLpTokens", "totalLpXnt", "totalCreatorXnt", "totalCrankRewards",
    "lastSellSlot", "createdAt", "sellLp", "sellCreator", "sellHolders", "lpTokens", "pendingTokens"] as const) {
    assert.equal(v[k], beforeA[k], `${k} intact`);
  }
  assert.ok(v.mint.equals(mint) && v.pool.equals(A.pool) && v.creatorNft.equals(A.nft) && v.publisher.equals(publisher.publicKey) && v.guardian.equals(creator.publicKey));
  assert.ok(v.listRoot.equals(beforeA.listRoot) && v.pendingRoot.equals(beforeA.pendingRoot));
  assert.deepEqual([v.burnBps, v.lpBps, v.creatorBps, v.bump, v.authBump], [beforeA.burnBps, beforeA.lpBps, beforeA.creatorBps, beforeA.bump, beforeA.authBump]);
  assert.equal(await bal(vault), await rent(V3_LEN), "vault is rent-exempt at 640 bytes");
  assert.equal(payer0 - (await bal(crank.publicKey)), r.fee + (await rent(V3_LEN)) - (await rent(V2_LEN)), "payer paid exactly the extra rent");
  await checkInvariants(mint, "upgrade_vault A");
  ok(`A upgraded in place: 552 -> 640 bytes, every v1/v2 field intact, version 3, last_publish_at = now (${r.cu} CU, ${r.size} bytes)`);
}
await fails("upgrade_vault twice", send([upgradeVaultIx(crank.publicKey, vault)], [crank]), /WrongVersion/);
{
  const t0 = await chainTime();
  const payer0 = await bal(crank.publicKey);
  const r = await measured("upgrade_vault (480 -> 640)", [upgradeVaultIx(crank.publicKey, vaultB)], [crank]);
  const v = await readVault(B.mint, V3_LEN);
  const raw0 = beforeB.raw, raw = v.raw;
  assert.ok(raw.subarray(0, 104).equals(raw0.subarray(0, 104)) && raw.subarray(168, 480).equals(raw0.subarray(168, 480)), "v1 bytes kept (but reward mint/pool)");
  assert.ok(beforeB.rewardMint.equals(NATIVE_MINT) && v.rewardMint.equals(REWARD_MINT) && v.rewardSwapPool.equals(REWARD_POOL), "reward mint/pool -> XNM / XNM-XNT");
  assert.equal(v.version, 3);
  assert.deepEqual([v.cancelsInRow, v.totalRewardOut, v.lastRewardSlot], [0, 0n, 0n]);
  assert.ok(v.lastPublishAt! >= t0 - 2n && v.lastPublishAt! <= (await chainTime()) + 2n, "last_publish_at = now");
  assert.ok(raw.subarray(481, 498).equals(Buffer.alloc(17)) && raw.subarray(506).equals(Buffer.alloc(134)), "new bytes zero");
  assert.ok(v.pendingEpoch === 2n && v.pendingRoot.equals(B2.root) && v.listEpoch === 1n && v.listRoot.equals(B1.root), "B's lists intact");
  assert.equal(await bal(vaultB), await rent(V3_LEN));
  assert.equal(payer0 - (await bal(crank.publicKey)), r.fee + (await rent(V3_LEN)) - (await rent(V1_LEN)), "payer paid exactly the extra rent");
  await checkInvariants(B.mint, "upgrade_vault B");
  ok(`B upgraded straight from v1: 480 -> 640 bytes, v1 fields intact, reward = XNM (${r.cu} CU)`);
  await fails("upgrade_vault twice (B)", send([upgradeVaultIx(crank.publicKey, vaultB)], [crank]), /WrongVersion/);
  // B carries on: its pending v1 list goes live (pending_cid was zero), and it pays.
  const v2 = await payAll(crank, B.mint, B2);
  assert.ok(v2.listCid!.equals(Buffer.alloc(33)), "a list published before v3 has no CID");
  await trade(B.mint, B.pool, 8);
  await collect(crank, B.mint, creator.publicKey);
  await sellAll(crank, B.mint, "upgraded v1 vault B");
  await fundCreator(crank, B.mint, B.nft, rp, "fund_creator on the upgraded v1 vault B (XNM)");
}

console.log("5. List CIDs on-chain; cancel clears the pending one");
alloc = allocate(alloc, ((await readVault(mint)).holdersFunded - L1.total) / 3n);
const L2 = buildList(vault, 2n, entriesOf(alloc));
{
  const cid2 = cidOf(listFile(mint, L2));
  const t0 = await chainTime();
  const v = await publish(publisher, mint, L2);
  assert.ok(v.pendingCid!.equals(cid2) && v.pendingEpoch === 2n, "pending_cid = cid");
  assert.ok(v.listCid!.equals(Buffer.alloc(33)), "list_cid untouched while pending");
  assert.ok(v.lastPublishAt! >= t0 - 2n, "publish_list sets last_publish_at");
  await send([cancelIx(creator.publicKey, mint)], [creator]);
  const c = await readVault(mint);
  assert.ok(c.pendingEpoch === 0n && c.pendingCid!.equals(Buffer.alloc(33)), "cancel clears pending_cid");
  assert.equal(c.lastPublishAt, v.lastPublishAt, "cancel doesn't touch last_publish_at");
  ok(`publish stored pending_cid ${cid2.toString("hex").slice(0, 12)}…; cancel_list cleared it`);
}
const L3 = buildList(vault, 3n, entriesOf(alloc));
const cid3 = cidOf(listFile(mint, L3));
const pub3 = await publish(publisher, mint, L3);
assert.ok(pub3.pendingCid!.equals(cid3));
const T3 = pub3.lastPublishAt!;

console.log("6. Publisher rotation and the guardian's appoint window");
await fails("appoint_publisher right after a publish", send([appointPublisherIx(creator.publicKey, mint, publisher3.publicKey)], [creator]), /PublisherActive/);
await fails("appoint_publisher by a non-guardian", send([appointPublisherIx(attacker.publicKey, mint, attacker.publicKey)], [attacker]), /NotGuardian/);
await fails("pay_fallback while a list is pending (and just published)",
  send([payFallbackIx(crank.publicKey, mint, L1.entries[0].wallet, L1.entries[0].cumulative, L1.proof(0))], [crank]), /FallbackNotActive/);
await fails("set_publisher by a non-publisher", send([setPublisherIx(attacker.publicKey, mint, attacker.publicKey)], [attacker]), /NotPublisher/);
await fails("set_publisher by the guardian", send([setPublisherIx(creator.publicKey, mint, creator.publicKey)], [creator]), /NotPublisher/);
{
  const r = await measured("set_publisher", [setPublisherIx(publisher.publicKey, mint, publisher2.publicKey)], [publisher]);
  const v = await readVault(mint);
  assert.ok(v.publisher.equals(publisher2.publicKey));
  assert.equal(v.lastPublishAt, T3, "set_publisher doesn't touch last_publish_at");
  const ev = events(r.logs, "PublisherChanged")[0];
  assert.ok(ev && ev.length === 105, "PublisherChanged { vault, old, new, by_guardian } event");
  assert.ok(new PublicKey(ev.subarray(8, 40)).equals(vault) && new PublicKey(ev.subarray(40, 72)).equals(publisher.publicKey)
    && new PublicKey(ev.subarray(72, 104)).equals(publisher2.publicKey) && ev[104] === 0);
  ok(`set_publisher: publisher rotated its own key (${r.cu} CU)`);
}
await fails("publish_list by the old publisher", send([publishIx(publisher.publicKey, mint, L3.root, 9n, L3.total, cid3)], [publisher]), /NotPublisher/);
{
  const v = await payAll(crank, mint, L3);
  assert.ok(v.listCid!.equals(cid3) && v.pendingCid!.equals(Buffer.alloc(33)), "activation: list_cid = pending_cid, pending_cid cleared");
  ok(`list 3 went live via pay: list_cid = ${cid3.toString("hex").slice(0, 12)}…, pending_cid cleared`);
}
assert.ok((await chainTime()) < T3 + FALLBACK_AFTER_SECS - 2n, "still inside the fallback window");
await fails("pay_fallback before FALLBACK_AFTER_SECS", send([payFallbackIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative, L3.proof(0))], [crank]), /FallbackNotActive/);
// More tax while the operator is "gone" (the permissionless steps keep running).
await trade(mint, A.pool, 12);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "cycle with no publisher");
await waitChain(T3 + APPOINT_AFTER_SECS + 1n);
{
  if ((await chainTime()) < T3 + FALLBACK_AFTER_SECS - 1n) {
    await fails("pay_fallback after the appoint window but before the fallback window",
      send([payFallbackIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative, L3.proof(0))], [crank]), /FallbackNotActive/);
  }
  const r = await measured("appoint_publisher", [appointPublisherIx(creator.publicKey, mint, publisher3.publicKey)], [creator]);
  const v = await readVault(mint);
  assert.ok(v.publisher.equals(publisher3.publicKey));
  assert.equal(v.lastPublishAt, T3, "appoint_publisher doesn't reset last_publish_at");
  const ev = events(r.logs, "PublisherChanged")[0];
  assert.ok(ev && ev.length === 105 && new PublicKey(ev.subarray(40, 72)).equals(publisher2.publicKey)
    && new PublicKey(ev.subarray(72, 104)).equals(publisher3.publicKey) && ev[104] === 1, "PublisherChanged by_guardian = true");
  ok(`appoint_publisher allowed ${APPOINT_AFTER_SECS}s after the last publish (${r.cu} CU)`);
}

console.log("7. Fallback: pay from the last active list, scaled up to everything funded");
await waitChain(T3 + FALLBACK_AFTER_SECS + 1n);
{
  const v = await readVault(mint);
  assert.ok(v.holdersFunded > v.listTotal, "more funded than the list allocated");
  // A bad proof (wrong amount, or another wallet's proof) is refused.
  await fails("pay_fallback with a wrong cumulative", send([payFallbackIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative + 1n, L3.proof(0))], [crank]), /BadProof/);
  await fails("pay_fallback with another wallet's proof", send([payFallbackIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative, L3.proof(1))], [crank]), /BadProof/);
  await fails("pay_fallback for a wallet not on the list", send([payFallbackIx(crank.publicKey, mint, attacker.publicKey, L3.entries[0].cumulative, L3.proof(0))], [crank]), /BadProof/);
  await fails("pay_fallback to auth", send([payFallbackIx(crank.publicKey, mint, authPda(mint), L3.entries[0].cumulative, L3.proof(0))], [crank]), /WrongAccount/);
}
const f1 = await payFallbackAll(crank, mint, L3, "fallback round 1");
assert.ok(f1.sum > 0n && f1.v.holdersPaid > f1.v.listTotal, "fallback paid past the list total");
await fails("normal pay in fallback (already paid more than its cumulative)",
  send([payIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative, L3.proof(0))], [crank]), /NothingToPay/);

console.log("8. More tax arrives: fallback pays more");
await trade(mint, A.pool, 12);
await collect(crank, mint, creator.publicKey);
await sellAll(crank, mint, "cycle in fallback");
const f2 = await payFallbackAll(crank, mint, L3, "fallback round 2");
assert.ok(f2.sum > 0n, "more tax -> more fallback pay");
assert.equal(f2.v.fallbackPaid, f1.sum + f2.sum, "fallback_paid tracks every fallback payment");

console.log("9. A new publish ends the fallback (total >= holders_paid, cumulative >= paid)");
{
  // Some new tax for the new list to allocate.
  await trade(mint, A.pool, 8);
  await collect(crank, mint, creator.publicKey);
  await sellAll(crank, mint, "cycle before the new list");
  const v = await readVault(mint);
  // Start each wallet from max(previous cumulative, on-chain paid), then allocate.
  const base = new Map<string, bigint>();
  for (const e of L3.entries) {
    const paid = await recordPaid(mint, e.wallet);
    base.set(e.wallet.toBase58(), e.cumulative > paid ? e.cumulative : paid);
  }
  const baseTotal = [...base.values()].reduce((s, c) => s + c, 0n);
  assert.ok(baseTotal >= v.holdersPaid, "the carried-over totals cover what was paid");
  const short = buildList(vault, 4n, L3.entries);
  assert.ok(v.holdersPaid - 1n >= v.listTotal, "only the new holders_paid rule refuses the next publish");
  await fails("publish_list with total < holders_paid", send([publishIx(publisher3.publicKey, mint, short.root, 4n, v.holdersPaid - 1n, cidOf("short"))], [publisher3]), /TotalDecreased/);
  await fails("publish_list by the rotated-out publisher", send([publishIx(publisher2.publicKey, mint, short.root, 4n, v.holdersPaid, cidOf("x"))], [publisher2]), /NotPublisher/);
  assert.equal((await readVault(mint)).lastPublishAt, T3, "failed publishes don't touch last_publish_at");
  alloc = allocate(base, (v.holdersFunded - baseTotal) / 2n);
  const L4 = buildList(vault, 4n, entriesOf(alloc));
  assert.ok(L4.total >= v.holdersPaid && L4.total <= v.holdersFunded);
  const p = await publish(publisher3, mint, L4);
  assert.ok(p.lastPublishAt! > T3 && p.pendingCid!.equals(cidOf(listFile(mint, L4))));
  ok(`appointed publisher published list 4 (total ${xnt(L4.total)} >= holders_paid ${xnt(v.holdersPaid)})`);
  await fails("pay_fallback after a new publish", send([payFallbackIx(crank.publicKey, mint, L3.entries[0].wallet, L3.entries[0].cumulative, L3.proof(0))], [crank]), /FallbackNotActive/);
  const w0 = await Promise.all(L4.entries.map((e) => bal(e.wallet)));
  const paid0 = await Promise.all(L4.entries.map((e) => recordPaid(mint, e.wallet)));
  const a = await payAll(crank, mint, L4);
  for (let i = 0; i < L4.entries.length; i++) {
    assert.equal((await bal(L4.entries[i].wallet)) - w0[i], L4.entries[i].cumulative - paid0[i], "normal pay: cumulative - paid");
  }
  assert.ok(a.holdersPaid <= a.listTotal && a.listCid!.equals(cidOf(listFile(mint, L4))));
  await fails("pay_fallback once the new list is live", send([payFallbackIx(crank.publicKey, mint, L4.entries[0].wallet, L4.entries[0].cumulative, L4.proof(0))], [crank]), /FallbackNotActive/);
  ok("list 4 live and paid by the normal path; fallback off");
}

console.log("10. A fresh v3 vault via init_vault");
const C = await launch(creator, 100_000_000n * 10n ** 9n, 10n * 10n ** 9n);
{
  const t0 = await chainTime();
  const r = await measured("init_vault (v3)", [initVaultIx(creator.publicKey, C.mint, C.pool, C.nft, 2000, 3000, publisher.publicKey, creator.publicKey)], [creator]);
  const v = await readVault(C.mint, V3_LEN);
  assert.equal(v.version, 3);
  assert.ok(v.rewardMint.equals(REWARD_MINT) && v.rewardSwapPool.equals(REWARD_POOL));
  assert.ok(v.lastPublishAt! >= t0 - 2n && v.lastPublishAt! <= (await chainTime()) + 2n && v.lastPublishAt === v.createdAt, "last_publish_at = created_at = now");
  assert.ok(v.listCid!.equals(Buffer.alloc(33)) && v.pendingCid!.equals(Buffer.alloc(33)) && v.fallbackPaid === 0n && v.reserved3!.equals(Buffer.alloc(60)));
  assert.equal(await bal(vaultPda(C.mint)), await rent(V3_LEN));
  await checkInvariants(C.mint, "init_vault v3");
  ok(`init_vault creates a ${V3_LEN}-byte v3 vault, clocks start at creation (${r.cu} CU, ${r.size} bytes)`);
  await fails("upgrade_vault on a fresh v3 vault", send([upgradeVaultIx(crank.publicKey, vaultPda(C.mint))], [crank]), /WrongVersion/);
  await fails("appoint_publisher on a fresh vault", send([appointPublisherIx(creator.publicKey, C.mint, publisher3.publicKey)], [creator]), /PublisherActive/);
  await waitChain(v.lastPublishAt! + FALLBACK_AFTER_SECS + 1n);
  await fails("pay_fallback with no list ever", send([payFallbackIx(crank.publicKey, C.mint, L1.entries[0].wallet, 1n, [])], [crank]), /FallbackNotActive/);
}

const vf = await checkInvariants(mint, "final");
console.log("\nTotals (vault A):", {
  collected: tok(vf.totalCollected), holdersFunded: xnt(vf.holdersFunded), holdersPaid: xnt(vf.holdersPaid),
  fallbackPaid: xnt(vf.fallbackPaid!), listTotal: xnt(vf.listTotal),
});
console.log("\nCompute units and transaction sizes (incl. a SetComputeUnitLimit instruction):");
for (const [name, rows] of Object.entries(stats)) {
  const cus = rows.map((r) => r.cu), sizes = rows.map((r) => r.size);
  console.log(`  ${name.padEnd(44)} ${String(Math.min(...cus)).padStart(7)}-${String(Math.max(...cus)).padEnd(7)} CU  ${Math.max(...sizes)} bytes  (${rows.length}x)`);
}
console.log("All tax-vault v3 checks passed.");
