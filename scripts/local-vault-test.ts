/**
 * End-to-end test of the tax_vault program against a LOCAL validator that clones testnet
 * XDEX, its pool config and lp_locker (nothing is sent to testnet or mainnet):
 *
 *   solana-test-validator --reset --ledger <scratch>/vault-ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY \
 *     --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --bpf-program D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW lp-locker/target/vault-test/tax_vault.so
 *   LOCAL_RPC=http://127.0.0.1:8999 npx tsx scripts/local-vault-test.ts
 *
 * The program must be the v1 build with `--features "testnet short-windows"` (5 s list delay).
 * For v2 (vault upgrade, XNM creator reward, cancel limit) see scripts/local-vault-v2-test.ts.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createMintToCheckedInstruction,
  createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMint, getMintLen, getTransferFeeAmount,
  getTransferFeeConfig, unpackAccount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { buildBuy, buildCreatePool, buildSell, cpmmOut, poolAddresses, poolAuthority, quoteBuy, quoteSell, snapshot } from "../src/xdex.js";

const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8999", "confirmed");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TAX_BPS = 500;
const BURN_BPS = 2500, LP_BPS = 2500, CREATOR_BPS = 1000;
const MAX_IMPACT_BPS = 300n, OUT_TOLERANCE_BPS = 50n, CRANK_REWARD_BPS = 100n, CRANK_REWARD_CAP = 50_000_000n;
const MIN_SELL_XNT = 2_000_000n, MIN_LP_XNT = 10_000_000n;
const LIST_DELAY_SECS = 5;
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
const rewardVaultPda = (nft: PublicKey) => pda([Buffer.from("reward"), nft.toBuffer(), NATIVE_MINT.toBuffer()], LOCKER);
const rewardTokensPda = (rv: PublicKey) => pda([Buffer.from("reward_tokens"), rv.toBuffer()], LOCKER);
const u64 = (...v: bigint[]) => { const b = Buffer.alloc(8 * v.length); v.forEach((x, i) => b.writeBigUInt64LE(x, 8 * i)); return b; };
const u16 = (...v: number[]) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16LE(x, 2 * i)); return b; };
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const ix = (name: string, keys: ReturnType<typeof m>[], args: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(`global:${name}`), args]) });
const authToken = (mint: PublicKey) => getAssociatedTokenAddressSync(mint, authPda(mint), true, TOKEN_2022_PROGRAM_ID);
const authWxnt = (mint: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, authPda(mint), true, TOKEN_PROGRAM_ID);

const initVaultIx = (payer: PublicKey, mint: PublicKey, pool: PublicKey, nft: PublicKey, burn: number, lp: number,
  publisher: PublicKey, guardian: PublicKey, lock = lockPda(nft)) => ix("init_vault", [
  m(payer, true, true), m(mint, false, false), m(vaultPda(mint), false, true), m(authPda(mint), false, true),
  m(pool, false, false), m(lock, false, false), m(nft, false, false), m(SystemProgram.programId, false, false),
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
const sellIx = (caller: PublicKey, mint: PublicKey, maxTokens: bigint, o: { xdex?: PublicKey; ammConfig?: PublicKey } = {}) => {
  const p = poolKeys(mint);
  return ix("sell", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(mint, false, false),
    m(authToken(mint), false, true), m(authWxnt(mint), false, true), m(p.pool, false, true), m(o.ammConfig ?? AMM_CONFIG, false, false),
    m(poolAuthority(XDEX), false, false), m(p.tokenVault, false, true), m(p.wxntVault, false, true), m(p.observation, false, true),
    m(o.xdex ?? XDEX, false, false), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
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
const fundCreatorIx = (caller: PublicKey, mint: PublicKey, nft: PublicKey) => {
  const rv = rewardVaultPda(nft);
  return ix("fund_creator", [
    m(caller, true, true), m(vaultPda(mint), false, true), m(authPda(mint), false, true), m(authWxnt(mint), false, true),
    m(nft, false, false), m(NATIVE_MINT, false, false), m(rv, false, true), m(rewardTokensPda(rv), false, true),
    m(LOCKER, false, false), m(TOKEN_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false), m(lockPda(nft), false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
  ]);
};
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
  mint: PublicKey; pool: PublicKey; creatorNft: PublicKey; rewardMint: PublicKey; rewardSwapPool: PublicKey; publisher: PublicKey;
  guardian: PublicKey; burnBps: number; lpBps: number; creatorBps: number; pendingTokens: bigint; lpTokens: bigint; sellLp: bigint;
  sellCreator: bigint; sellHolders: bigint; xntLp: bigint; xntCreator: bigint; holdersFunded: bigint; holdersPaid: bigint;
  listEpoch: bigint; listRoot: Buffer; listTotal: bigint; pendingEpoch: bigint; pendingRoot: Buffer; pendingTotal: bigint;
  pendingActiveAt: bigint; totalCollected: bigint; totalBurned: bigint; totalLpTokens: bigint; totalLpXnt: bigint;
  totalCreatorXnt: bigint; totalCrankRewards: bigint; createdAt: bigint; bump: number; authBump: number; lastSellSlot: bigint;
}
async function readVault(mint: PublicKey): Promise<Vault> {
  const info = await conn.getAccountInfo(vaultPda(mint), "confirmed");
  assert.ok(info && info.owner.equals(PROGRAM), "vault account");
  const d = info.data;
  assert.equal(d.length, 480);
  assert.ok(d.subarray(0, 8).equals(disc("account:Vault")));
  const k = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const n = (o: number) => d.readBigUInt64LE(o);
  return {
    mint: k(8), pool: k(40), creatorNft: k(72), rewardMint: k(104), rewardSwapPool: k(136), publisher: k(168), guardian: k(200),
    burnBps: d.readUInt16LE(232), lpBps: d.readUInt16LE(234), creatorBps: d.readUInt16LE(236), pendingTokens: n(238),
    lpTokens: n(246), sellLp: n(254), sellCreator: n(262), sellHolders: n(270), xntLp: n(278), xntCreator: n(286),
    holdersFunded: n(294), holdersPaid: n(302), listEpoch: n(310), listRoot: d.subarray(318, 350), listTotal: n(350),
    pendingEpoch: n(358), pendingRoot: d.subarray(366, 398), pendingTotal: n(398), pendingActiveAt: d.readBigInt64LE(406),
    totalCollected: n(414), totalBurned: n(422), totalLpTokens: n(430), totalLpXnt: n(438), totalCreatorXnt: n(446),
    totalCrankRewards: n(454), createdAt: d.readBigInt64LE(462), bump: d[470], authBump: d[471], lastSellSlot: n(472),
  };
}

// ---------- Merkle list (same tree as lp_locker's holder passes, vault leaf prefix) ----------

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
function buildList(vault: PublicKey, epoch: bigint, entries: { wallet: PublicKey; cumulative: bigint }[], total?: bigint): List {
  const t = merkle(entries.map((e) => leafOf(vault, e.wallet, e.cumulative)));
  return { epoch, total: total ?? entries.reduce((s, e) => s + e.cumulative, 0n), entries, root: t.root, proof: t.proof };
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
const stats: Record<string, { cu: number; size: number }[]> = {};
async function measured(name: string, ixs: TransactionInstruction[], signers: Keypair[], cu = 400_000) {
  const size = txSize(ixs, signers[0].publicKey, signers.length, cu);
  assert.ok(size <= 1232, `${name}: transaction too large (${size} bytes)`);
  const sig = await send(ixs, signers, cu);
  const s = await txStats(sig);
  (stats[name] ??= []).push({ cu: s.cu, size });
  return { sig, ...s, size };
}

/** A Token-2022 tax token like buildMintSetup: metadata by `creator`, supply minted to `creator`, minting revoked. */
async function mintIxs(creator: PublicKey, mintKp: Keypair, o: { configAuthority: PublicKey | null; withdrawAuthority: PublicKey; supply: bigint; freeze?: PublicKey; maxFee?: bigint }) {
  const mint = mintKp.publicKey;
  const uri = `https://example.invalid/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name: "Vault Test", symbol: "VLT", uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  const ata = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
  return [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, o.configAuthority, o.withdrawAuthority, TAX_BPS, o.maxFee ?? U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, DECIMALS, creator, o.freeze ?? null, TOKEN_2022_PROGRAM_ID),
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
  const ixs = [
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
  ];
  await send(ixs, [owner, nft]);
  return { nft: nft.publicKey, lock, lp };
}

/** Mint + XDEX pool + forever lock, all by `creator`. */
async function launch(creator: Keypair, o: { configAuthority?: PublicKey | null; withdrawAuthority?: PublicKey; poolTokens: bigint; poolXnt: bigint; supply: bigint }) {
  const mintKp = Keypair.generate(), mint = mintKp.publicKey;
  await send(await mintIxs(creator.publicKey, mintKp, {
    configAuthority: o.configAuthority ?? null, withdrawAuthority: o.withdrawAuthority ?? authPda(mint), supply: o.supply,
  }), [creator, mintKp]);
  const cp = buildCreatePool(XDEX, "testnet", creator.publicKey, mint, o.poolTokens, o.poolXnt);
  await send(cp.ixs, [creator], 1_000_000);
  const { nft, lock } = await lockAll(creator, mint);
  return { mint, pool: cp.pool, lpMint: cp.lpMint, nft, lock };
}

// ---------- Invariants ----------

let RENT0 = 0n;
async function checkInvariants(mint: PublicKey, label: string) {
  const v = await readVault(mint);
  const auth = await bal(authPda(mint));
  const promised = v.xntLp + v.xntCreator + (v.holdersFunded - v.holdersPaid);
  assert.ok(v.holdersPaid <= v.listTotal && v.listTotal <= v.holdersFunded, `${label}: paid <= list_total <= funded`);
  assert.ok(v.pendingEpoch === 0n || v.pendingTotal <= v.holdersFunded, `${label}: pending total <= funded`);
  assert.ok(auth >= promised + RENT0, `${label}: auth lamports ${auth} >= promised ${promised} + reserve`);
  // Nobody donated in this test, so auth holds exactly the reserve plus what it owes.
  assert.equal(auth, promised + RENT0, `${label}: auth lamports == promised + reserve`);
  const tokens = await tokenBal(authToken(mint));
  const booked = v.pendingTokens + v.lpTokens + v.sellLp + v.sellCreator + v.sellHolders;
  assert.equal(tokens, booked, `${label}: auth token balance == token buckets`);
  assert.equal(v.pendingTokens, 0n);
  assert.equal(await conn.getAccountInfo(authWxnt(mint), "confirmed"), null, `${label}: no wXNT account left open`);
  return v;
}

// ---------- Test ----------

console.log("tax_vault end-to-end (local validator)");
RENT0 = BigInt(await conn.getMinimumBalanceForRentExemption(0));
{
  // The Rust unit test's vector (docs/tax-vault-spec.md): vault [1;32], wallets [2;32] / [3;32].
  const v = new PublicKey(Buffer.alloc(32, 1));
  const a = leafOf(v, new PublicKey(Buffer.alloc(32, 2)), 1_000_000_000n), b = leafOf(v, new PublicKey(Buffer.alloc(32, 3)), 5n);
  assert.equal(a.toString("hex"), "f1df94e69dc2ad0365865c9eaeb81deac6bfbc98a2e5abe33decf1128b63e821");
  assert.equal(merkle([a, b]).root.toString("hex"), "1992f5473e12ba77f8b909f1cb3272b5492544fc3e37ea7a5d7c3776290bda6a");
  ok("Merkle test vector matches the Rust unit test");
}
const creator = Keypair.generate(), publisher = Keypair.generate(), attacker = Keypair.generate(), crank = Keypair.generate();
const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
const fresh = Keypair.generate(), late = Keypair.generate(); // holder wallets that were never funded
await fund(creator.publicKey, 300);
for (const k of [publisher, attacker, crank]) await fund(k.publicKey, 10);
for (const t of traders) await fund(t.publicKey, 200);

console.log("1. Launch: tax token (withdraw authority = vault auth), XDEX pool, forever LP lock");
const SUPPLY = 1_000_000_000n * 10n ** 9n;
const A = await launch(creator, { poolTokens: 500_000_000n * 10n ** 9n, poolXnt: 50n * 10n ** 9n, supply: SUPPLY });
const mint = A.mint, auth = authPda(mint), vault = vaultPda(mint);
{
  const mi = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fc = getTransferFeeConfig(mi)!;
  assert.ok(fc.withdrawWithheldAuthority.equals(auth) && fc.transferFeeConfigAuthority.equals(PublicKey.default) && mi.mintAuthority === null);
  ok(`mint ${mint.toBase58()} (5% tax, fee config authority None, withdraw = auth ${auth.toBase58().slice(0, 8)}…, minting revoked)`);
  ok(`pool ${A.pool.toBase58()}, lock NFT ${A.nft.toBase58()}`);
}
// Second launch (another pool/lock) for the wrong-pool / wrong-lock attacks, and a migrated token.
const B = await launch(creator, { poolTokens: 100_000_000n * 10n ** 9n, poolXnt: 5n * 10n ** 9n, supply: SUPPLY });
const distributor = Keypair.generate();
await fund(distributor.publicKey, 2);
const C = await launch(creator, { withdrawAuthority: distributor.publicKey, poolTokens: 100_000_000n * 10n ** 9n, poolXnt: 5n * 10n ** 9n, supply: SUPPLY });

console.log("2. init_vault checks");
{
  const bad1 = Keypair.generate();
  await send(await mintIxs(creator.publicKey, bad1, { configAuthority: creator.publicKey, withdrawAuthority: authPda(bad1.publicKey), supply: 1n }), [creator, bad1]);
  await fails("init_vault on a mint whose fee config authority isn't None",
    send([initVaultIx(creator.publicKey, bad1.publicKey, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadAuthority/);
  const bad2 = Keypair.generate();
  await send(await mintIxs(creator.publicKey, bad2, { configAuthority: null, withdrawAuthority: creator.publicKey, supply: 1n }), [creator, bad2]);
  await fails("init_vault on a mint whose withdraw authority isn't auth",
    send([initVaultIx(creator.publicKey, bad2.publicKey, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadAuthority/);
  const bad3 = Keypair.generate();
  await send(await mintIxs(creator.publicKey, bad3, { configAuthority: null, withdrawAuthority: authPda(bad3.publicKey), supply: 1n, freeze: creator.publicKey }), [creator, bad3]);
  await fails("init_vault on a mint with a freeze authority",
    send([initVaultIx(creator.publicKey, bad3.publicKey, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadMint/);
  const bad4 = Keypair.generate();
  await send(await mintIxs(creator.publicKey, bad4, { configAuthority: null, withdrawAuthority: authPda(bad4.publicKey), supply: 1n, maxFee: 10n ** 12n }), [creator, bad4]);
  await fails("init_vault on a mint with a capped transfer fee",
    send([initVaultIx(creator.publicKey, bad4.publicKey, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadMint/);
  await fails("init_vault with a pool not containing the mint",
    send([initVaultIx(creator.publicKey, mint, B.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadPool/);
  await fails("init_vault with a lock for another pool",
    send([initVaultIx(creator.publicKey, mint, A.pool, B.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /BadLock/);
  await fails("init_vault with a lock that isn't the NFT's lock PDA",
    send([initVaultIx(creator.publicKey, mint, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey, B.lock)], [creator]), /BadLock/);
  await fails("init_vault with burn + LP over 55%",
    send([initVaultIx(creator.publicKey, mint, A.pool, A.nft, 3000, 2600, publisher.publicKey, creator.publicKey)], [creator]), /BadSplit/);
  await fails("a stranger front-runs init_vault with their own publisher/guardian",
    send([initVaultIx(attacker.publicKey, mint, A.pool, A.nft, BURN_BPS, LP_BPS, attacker.publicKey, attacker.publicKey)], [attacker]), /BadAuthority/);
}
{
  const r = await measured("init_vault", [initVaultIx(creator.publicKey, mint, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]);
  const v = await checkInvariants(mint, "init_vault");
  assert.ok(v.pool.equals(A.pool) && v.creatorNft.equals(A.nft) && v.rewardMint.equals(NATIVE_MINT) && v.rewardSwapPool.equals(PublicKey.default));
  assert.ok(v.publisher.equals(publisher.publicKey) && v.guardian.equals(creator.publicKey));
  assert.deepEqual([v.burnBps, v.lpBps, v.creatorBps], [BURN_BPS, LP_BPS, CREATOR_BPS]);
  assert.equal(await bal(auth), RENT0, "auth funded with exactly its rent-exempt reserve");
  ok(`vault created by the creator: 25% burn / 25% LP / 10% creator / 40% holders; auth holds the ${xnt(RENT0)} reserve (${r.cu} CU, ${r.size} bytes)`);
  await fails("init_vault twice", send([initVaultIx(creator.publicKey, mint, A.pool, A.nft, BURN_BPS, LP_BPS, publisher.publicKey, creator.publicKey)], [creator]), /already in use/);
}
{
  // Migration: the old withdraw authority hands over to auth and creates the vault atomically.
  const setAuth = createSetAuthorityInstruction(C.mint, distributor.publicKey, AuthorityType.WithheldWithdraw, authPda(C.mint), [], TOKEN_2022_PROGRAM_ID);
  await fails("init_vault by a non-creator without a hand-over in the same transaction",
    send([initVaultIx(distributor.publicKey, C.mint, C.pool, C.nft, 0, 0, publisher.publicKey, creator.publicKey)], [distributor]), /BadAuthority/);
  const r = await measured("init_vault (migration: SetAuthority + init_vault)",
    [setAuth, initVaultIx(distributor.publicKey, C.mint, C.pool, C.nft, 0, 0, publisher.publicKey, creator.publicKey)], [distributor]);
  const fc = getTransferFeeConfig(await getMint(conn, C.mint, "confirmed", TOKEN_2022_PROGRAM_ID))!;
  assert.ok(fc.withdrawWithheldAuthority.equals(authPda(C.mint)));
  ok(`migration: distributor's SetAuthority(WithheldWithdraw -> auth) + init_vault in one transaction (${r.size} bytes)`);
}

console.log("3. Trading on XDEX accumulates tax");
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
await sleep(1500); // XDEX opens the pool one second after creation
async function trade(rounds: number) {
  for (let i = 0; i < rounds; i++) {
    const t = traders[Math.floor(rnd() * traders.length)];
    const ata = getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const held = await tokenBal(ata);
    if (held > 0n && rnd() < 0.45) {
      const q = await quoteSell(conn, XDEX, A.pool, mint, (held * BigInt(Math.floor(rnd() * 80 + 20))) / 100n, { maxImpactBps: 5000, slippageBps: 200 });
      if (q) await send(await buildSell(conn, XDEX, t, mint, q), [t]);
    } else {
      const q = await quoteBuy(conn, XDEX, A.pool, mint, BigInt(Math.floor((1 + rnd() * 6) * 1e9)), 200, 5000);
      await send(await buildBuy(conn, XDEX, t, q), [t]);
    }
  }
}
async function withheldEverywhere() {
  const accs = [...traders.map((t) => getAssociatedTokenAddressSync(mint, t.publicKey, false, TOKEN_2022_PROGRAM_ID)),
    poolKeys(mint).tokenVault, getAssociatedTokenAddressSync(mint, creator.publicKey, false, TOKEN_2022_PROGRAM_ID)];
  let sum = 0n;
  const withTax: PublicKey[] = [];
  for (const a of accs) {
    const info = await conn.getAccountInfo(a, "confirmed");
    if (!info) continue;
    const w = getTransferFeeAmount(unpackAccount(a, info, TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
    if (w > 0n) { sum += w; withTax.push(a); }
  }
  const mw = getTransferFeeConfig(await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID))!.withheldAmount;
  return { sum: sum + mw, accounts: withTax };
}
await trade(24);
{
  const w = await withheldEverywhere();
  ok(`24 trades; ${tok(w.sum)} tokens of tax withheld in ${w.accounts.length} accounts`);
}

// ---------- One full cycle ----------

async function collect(label: string) {
  const w = await withheldEverywhere();
  const before = await readVault(mint);
  const supplyBefore = (await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const r = await measured(`collect (${w.accounts.length} harvest accounts)`, [collectIx(crank.publicKey, mint, w.accounts)], [crank]);
  const v = await checkInvariants(mint, label);
  const got = v.totalCollected - before.totalCollected;
  assert.equal(got, w.sum, "collected exactly every withheld token");
  const burn = (got * 2500n) / 10_000n, lp = (got * 2500n) / 10_000n, cr = (got * 1000n) / 10_000n;
  assert.equal(v.totalBurned - before.totalBurned, burn);
  assert.equal(v.lpTokens - before.lpTokens, lp / 2n);
  assert.equal(v.sellLp - before.sellLp, lp - lp / 2n);
  assert.equal(v.sellCreator - before.sellCreator, cr);
  assert.equal(v.sellHolders - before.sellHolders, got - burn - lp - cr);
  assert.equal((await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply, supplyBefore - burn, "burn reduced the supply");
  assert.equal((await withheldEverywhere()).sum, 0n, "nothing left withheld");
  ok(`collect: got ${tok(got)} tokens, burned ${tok(burn)}, kept ${tok(lp / 2n)} for LP, to sell ${tok(v.sellLp + v.sellCreator + v.sellHolders)} (${r.cu} CU, ${r.size} bytes)`);
  return v;
}

async function expectedSell(maxTokens: bigint) {
  const v = await readVault(mint);
  const s = await snapshot(conn, XDEX, A.pool, mint);
  const bps = 500n, maxImpact = MAX_IMPACT_BPS < bps / 2n ? MAX_IMPACT_BPS : bps / 2n;
  const net = (s.reserveToken * maxImpact) / (10_000n - maxImpact);
  const cap = (net * 10_000n) / (10_000n - bps);
  const buckets = v.sellLp + v.sellCreator + v.sellHolders;
  let amount = maxTokens < buckets ? maxTokens : buckets;
  if (cap < amount) amount = cap;
  const fee = (amount * bps + 9_999n) / 10_000n;
  const expected = cpmmOut(amount - fee, s.reserveToken, s.reserveQuote, s.tradeFeeRate);
  return { v, amount, expected, capped: cap < buckets && amount === cap };
}

async function afterLastSell() {
  const last = (await readVault(mint)).lastSellSlot;
  while (BigInt(await conn.getSlot("processed")) <= last + 1n) await sleep(200);
}

async function sellOnce(maxTokens: bigint) {
  await afterLastSell();
  const e = await expectedSell(maxTokens);
  const crankBefore = await bal(crank.publicKey);
  const r = await measured("sell", [sellIx(crank.publicKey, mint, maxTokens)], [crank]);
  const v = await checkInvariants(mint, "sell");
  const took = (e.v.sellLp - v.sellLp) + (e.v.sellCreator - v.sellCreator) + (e.v.sellHolders - v.sellHolders);
  assert.equal(took, e.amount, "sold amount = min(max_tokens, buckets, impact cap)");
  const toLp = v.xntLp - e.v.xntLp, toCr = v.xntCreator - e.v.xntCreator, toHo = v.holdersFunded - e.v.holdersFunded;
  const reward = v.totalCrankRewards - e.v.totalCrankRewards;
  const out = toLp + toCr + toHo + reward;
  assert.ok(out >= (e.expected * (10_000n - OUT_TOLERANCE_BPS)) / 10_000n, "out >= on-chain min out");
  // Pro-rata attribution, rounding to holders.
  const tLp = e.v.sellLp - v.sellLp, tCr = e.v.sellCreator - v.sellCreator;
  assert.equal(toLp, (out * tLp) / took);
  assert.equal(toCr, (out * tCr) / took);
  const hol = out - toLp - toCr;
  const expReward = (hol * CRANK_REWARD_BPS) / 10_000n < CRANK_REWARD_CAP ? (hol * CRANK_REWARD_BPS) / 10_000n : CRANK_REWARD_CAP;
  assert.equal(reward, expReward);
  assert.equal((await bal(crank.publicKey)) - crankBefore + r.fee, reward, "caller got exactly the crank reward (wXNT rent refunded)");
  assert.ok(v.lastSellSlot > e.v.lastSellSlot);
  return { out, expected: e.expected, amount: e.amount, reward, capped: e.capped, cu: r.cu, size: r.size };
}

async function sellAll(label: string) {
  let n = 0, exact = 0, capped = 0, total = 0n;
  for (;;) {
    const e = await expectedSell(U64_MAX);
    if (e.amount === 0n || e.expected < MIN_SELL_XNT) {
      await afterLastSell();
      await fails(`${label}: sell below the dust limit`, send([sellIx(crank.publicKey, mint, U64_MAX)], [crank]), /TooSmall/);
      break;
    }
    const s = await sellOnce(U64_MAX);
    n++; total += s.out;
    if (s.out === s.expected) exact++;
    if (s.capped) capped++;
    await sleep(500);
  }
  const v = await readVault(mint);
  ok(`${label}: ${n} sells (${capped} stopped by the impact cap), ${xnt(total)} XNT; output == on-chain expectation in ${exact}/${n}; left to sell ${tok(v.sellLp + v.sellCreator + v.sellHolders)} tokens`);
  return v;
}

async function addLiquidity() {
  const before = await readVault(mint);
  const p = poolKeys(mint);
  const lpSupply0 = (await getMint(conn, p.lpMint, "confirmed", TOKEN_PROGRAM_ID)).supply;
  const tv0 = await tokenBal(p.tokenVault), xv0 = await tokenBal(p.wxntVault, TOKEN_PROGRAM_ID);
  const crankBefore = await bal(crank.publicKey);
  const r = await measured("add_liquidity", [addLiquidityIx(crank.publicKey, mint)], [crank]);
  const v = await checkInvariants(mint, "add_liquidity");
  const tokens = before.lpTokens - v.lpTokens, x = before.xntLp - v.xntLp;
  assert.ok(tokens > 0n && x > 0n);
  assert.equal(v.totalLpTokens - before.totalLpTokens, tokens);
  assert.equal(v.totalLpXnt - before.totalLpXnt, x);
  assert.equal((await getMint(conn, p.lpMint, "confirmed", TOKEN_PROGRAM_ID)).supply, lpSupply0, "LP supply unchanged: every LP minted was burned");
  assert.equal(await conn.getAccountInfo(getAssociatedTokenAddressSync(p.lpMint, auth, true, TOKEN_PROGRAM_ID), "confirmed"), null, "auth holds no LP account");
  assert.equal((await tokenBal(p.wxntVault, TOKEN_PROGRAM_ID)) - xv0, x, "pool got exactly the XNT");
  const fee = (tokens * 500n + 9_999n) / 10_000n;
  assert.ok((await tokenBal(p.tokenVault)) - tv0 >= tokens - fee, "pool got the tokens net of tax");
  assert.equal((await bal(crank.publicKey)) - crankBefore + r.fee, 0n, "caller's rent refunded");
  const leftSide = v.xntLp < MIN_LP_XNT ? "XNT" : "tokens";
  ok(`add_liquidity: ${tok(tokens)} tokens + ${xnt(x)} XNT deposited, all LP burned (LP supply unchanged); left ${tok(v.lpTokens)} tokens / ${xnt(v.xntLp)} XNT (binding side: ${leftSide}) (${r.cu} CU, ${r.size} bytes)`);
}

async function fundCreator() {
  const before = await readVault(mint);
  const rv = rewardVaultPda(A.nft), rt = rewardTokensPda(rv);
  const existed = !!(await conn.getAccountInfo(rv, "confirmed"));
  const rt0 = await tokenBal(rt, TOKEN_PROGRAM_ID);
  const r = await measured(existed ? "fund_creator" : "fund_creator (+ init_reward_vault)", [fundCreatorIx(crank.publicKey, mint, A.nft)], [crank]);
  const v = await checkInvariants(mint, "fund_creator");
  assert.equal(v.xntCreator, 0n);
  assert.equal(v.totalCreatorXnt - before.totalCreatorXnt, before.xntCreator);
  assert.equal((await tokenBal(rt, TOKEN_PROGRAM_ID)) - rt0, before.xntCreator, "reward vault grew by xnt_creator");
  const rvInfo = (await conn.getAccountInfo(rv, "confirmed"))!;
  assert.ok(rvInfo.owner.equals(LOCKER));
  const d = rvInfo.data;
  assert.ok(new PublicKey(d.subarray(8, 40)).equals(A.nft) && new PublicKey(d.subarray(40, 72)).equals(NATIVE_MINT));
  const deposited = d.readBigUInt64LE(80);
  ok(`fund_creator: ${xnt(before.xntCreator)} XNT into the lock NFT's reward vault${existed ? "" : " (vault created in the same instruction)"}; total deposited ${xnt(deposited)} vesting for the NFT holder (${r.cu} CU, ${r.size} bytes)`);
}

async function publishAndPay(list: List, label: string) {
  const r = await measured("publish_list", [publishIx(publisher.publicKey, mint, list.root, list.epoch, list.total)], [publisher]);
  let v = await checkInvariants(mint, "publish");
  assert.equal(v.pendingEpoch, list.epoch);
  assert.equal(v.pendingTotal, list.total);
  ok(`${label}: published epoch ${list.epoch}, total ${xnt(list.total)} XNT, ${list.entries.length} wallets, active at +${v.pendingActiveAt - (await chainTime())}s (${r.cu} CU, ${r.size} bytes)`);
  // Paying before the delay: the pending list isn't active yet.
  const e0 = list.entries[0];
  await fails(`${label}: pay before the delay`, send([payIx(crank.publicKey, mint, e0.wallet, e0.cumulative, list.proof(0))], [crank]), /BadProof|NothingToPay/);
  while ((await chainTime()) < v.pendingActiveAt + 1n) await sleep(500);
  for (let i = 0; i < list.entries.length; i++) {
    const e = list.entries[i];
    const rec = await conn.getAccountInfo(recordPda(vault, e.wallet), "confirmed");
    const paid = rec ? rec.data.readBigUInt64LE(72) : 0n;
    if (i === 0) {
      await fails(`${label}: pay with a bad proof (inflated amount)`, send([payIx(crank.publicKey, mint, e.wallet, e.cumulative + 1n, list.proof(0))], [crank]), /BadProof/);
      await fails(`${label}: pay another wallet with this proof`, send([payIx(crank.publicKey, mint, attacker.publicKey, e.cumulative, list.proof(0))], [crank]), /BadProof/);
    }
    const w0 = await bal(e.wallet);
    const r2 = await measured(`pay (proof ${list.proof(i).length})`, [payIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(i))], [crank]);
    assert.equal((await bal(e.wallet)) - w0 + (e.wallet.equals(crank.publicKey) ? r2.fee : 0n), e.cumulative - paid, "wallet got cumulative - paid");
    const recAfter = (await conn.getAccountInfo(recordPda(vault, e.wallet), "confirmed"))!;
    assert.equal(recAfter.data.readBigUInt64LE(72), e.cumulative);
    v = await checkInvariants(mint, "pay");
    if (i === 0) {
      await fails(`${label}: pay the same wallet twice`, send([payIx(crank.publicKey, mint, e.wallet, e.cumulative, list.proof(0))], [crank]), /NothingToPay/);
    }
  }
  v = await readVault(mint);
  assert.equal(v.listEpoch, list.epoch);
  assert.equal(v.holdersPaid, list.total, "everything the list allocated was paid");
  ok(`${label}: paid ${list.entries.length} wallets, holders_paid = list_total = ${xnt(v.holdersPaid)}; unallocated ${xnt(v.holdersFunded - v.holdersPaid)} stays for the next list`);
}

/** Allocate `amount` pro-rata to token balances on top of `prev` cumulative totals. */
async function allocate(prev: Map<string, bigint>, amount: bigint, extra: PublicKey[]) {
  const wallets = [...traders.map((t) => t.publicKey), ...extra];
  const weights = await Promise.all(wallets.map(async (w, i) => i < traders.length
    ? await tokenBal(getAssociatedTokenAddressSync(mint, w, false, TOKEN_2022_PROGRAM_ID)) + 1n : 10n ** 16n));
  const sum = weights.reduce((a, b) => a + b, 0n);
  const next = new Map(prev);
  wallets.forEach((w, i) => next.set(w.toBase58(), (prev.get(w.toBase58()) ?? 0n) + (amount * weights[i]) / sum));
  return next;
}

console.log("4. Cycle 1");
await fails("collect with nothing withheld in the mint (migrated token C, no harvest accounts)", send([collectIx(crank.publicKey, C.mint, [])], [crank]), /NothingToCollect/);
await collect("collect 1");
await fails("collect again right away", send([collectIx(crank.publicKey, mint, [])], [crank]), /NothingToCollect/);
{
  // max_tokens bounds a sale.
  const s = await sellOnce(5_000_000n * 10n ** 9n);
  assert.equal(s.amount, 5_000_000n * 10n ** 9n);
  ok(`sell(max_tokens = 5,000,000): sold exactly that for ${xnt(s.out)} XNT, crank reward ${xnt(s.reward)}`);
}
await afterLastSell();
await fails("sell with a fake XDEX program", send([sellIx(crank.publicKey, mint, U64_MAX, { xdex: LOCKER })], [crank]), /WrongAccount/);
await afterLastSell();
await fails("sell with another amm config", send([sellIx(crank.publicKey, mint, U64_MAX, { ammConfig: B.pool })], [crank]), /WrongAccount/);
await afterLastSell();
await fails("two sells in one transaction (sandwich guard)", send([sellIx(crank.publicKey, mint, 10n ** 16n), sellIx(crank.publicKey, mint, 10n ** 16n)], [crank]), /OneSellPerSlot/);
await sleep(500);
await sellAll("cycle 1");
{
  const v = await readVault(mint);
  assert.ok(v.xntLp >= MIN_LP_XNT, "enough XNT for auto-LP");
}
await addLiquidity();
{
  const v = await readVault(mint);
  if (v.xntLp < MIN_LP_XNT) await fails("add_liquidity below MIN_LP_XNT", send([addLiquidityIx(crank.publicKey, mint)], [crank]), /TooSmall/);
}
await fundCreator();
await fails("fund_creator with nothing to fund", send([fundCreatorIx(crank.publicKey, mint, A.nft)], [crank]), /TooSmall/);
await fails("fund_creator with another lock NFT", send([fundCreatorIx(crank.publicKey, mint, B.nft)], [crank]), /WrongAccount/);

console.log("5. Rewards list: publish rules");
let v1 = await readVault(mint);
const funded1 = v1.holdersFunded;
let alloc = await allocate(new Map(), funded1 - funded1 / 10n, [fresh.publicKey]);
const entries = (a: Map<string, bigint>) => [...a.entries()].map(([k, c]) => ({ wallet: new PublicKey(k), cumulative: c }));
const L1 = buildList(vault, 1n, entries(alloc));
await fails("publish by a non-publisher", send([publishIx(attacker.publicKey, mint, L1.root, 1n, L1.total)], [attacker]), /NotPublisher/);
await fails("publish with total > holders_funded", send([publishIx(publisher.publicKey, mint, L1.root, 1n, funded1 + 1n)], [publisher]), /OverFunded/);
await fails("publish with epoch 0", send([publishIx(publisher.publicKey, mint, L1.root, 0n, L1.total)], [publisher]), /StaleEpoch/);
await send([publishIx(publisher.publicKey, mint, L1.root, 1n, L1.total)], [publisher]);
ok(`list epoch 1 pending (total ${xnt(L1.total)} of ${xnt(funded1)} funded)`);
await fails("publish with an old epoch", send([publishIx(publisher.publicKey, mint, L1.root, 1n, L1.total)], [publisher]), /StaleEpoch/);
await fails("publish with a lower total", send([publishIx(publisher.publicKey, mint, L1.root, 2n, L1.total - 1n)], [publisher]), /TotalDecreased/);
await fails("cancel by a non-guardian", send([cancelIx(attacker.publicKey, mint)], [attacker]), /NotGuardian/);
await fails("cancel by the publisher", send([cancelIx(publisher.publicKey, mint)], [publisher]), /NotGuardian/);
{
  const r = await measured("cancel_list", [cancelIx(creator.publicKey, mint)], [creator]);
  const v = await readVault(mint);
  assert.equal(v.pendingEpoch, 0n); assert.equal(v.listEpoch, 0n);
  ok(`guardian (creator) cancelled the pending list (${r.cu} CU, ${r.size} bytes)`);
}
await fails("cancel with nothing pending", send([cancelIx(creator.publicKey, mint)], [creator]), /NoPendingList/);
{
  // The cancelled list can never be paid.
  await fails("pay against a cancelled list", send([payIx(crank.publicKey, mint, L1.entries[0].wallet, L1.entries[0].cumulative, L1.proof(0))], [crank]), /BadProof/);
}
const L2 = buildList(vault, 2n, entries(alloc));
await publishAndPay(L2, "cycle 1");
await fails("publish with total > holders_funded after payouts", send([publishIx(publisher.publicKey, mint, L2.root, 3n, funded1 + 1n)], [publisher]), /OverFunded/);

console.log("6. Cycle 2 (growing totals)");
await trade(16);
await collect("collect 2");
await sellAll("cycle 2");
{
  const v = await readVault(mint);
  if (v.xntLp >= MIN_LP_XNT) await addLiquidity();
  else await fails("add_liquidity below MIN_LP_XNT", send([addLiquidityIx(crank.publicKey, mint)], [crank]), /TooSmall/);
}
await fundCreator();
const v2 = await readVault(mint);
alloc = await allocate(alloc, ((v2.holdersFunded - L2.total) * 9n) / 10n, [fresh.publicKey, late.publicKey]);
const L3 = buildList(vault, 3n, entries(alloc));
assert.ok(L3.total > L2.total && L3.total <= v2.holdersFunded);
await publishAndPay(L3, "cycle 2");

console.log("7. A list that tries to pay more than was funded");
{
  const v = await readVault(mint);
  const room = v.holdersFunded - v.listTotal;
  assert.ok(room > 1000n, "some unallocated holders' XNT");
  // Leaves promise `room` to two wallets each, but the list total only covers one.
  const x = traders[0].publicKey, y = traders[1].publicKey;
  const cx = alloc.get(x.toBase58())! + room, cy = alloc.get(y.toBase58())! + room;
  const bad = buildList(vault, 4n, [{ wallet: x, cumulative: cx }, { wallet: y, cumulative: cy }], v.listTotal + room);
  await send([publishIx(publisher.publicKey, mint, bad.root, bad.epoch, bad.total)], [publisher]);
  while ((await chainTime()) < (await readVault(mint)).pendingActiveAt + 1n) await sleep(500);
  await send([payIx(crank.publicKey, mint, x, cx, bad.proof(0))], [crank]);
  await checkInvariants(mint, "over-list pay 1");
  await fails("second leaf of an over-allocated list", send([payIx(crank.publicKey, mint, y, cy, bad.proof(1))], [crank]), /OverFunded/);
  const after = await readVault(mint);
  assert.equal(after.holdersPaid, after.listTotal);
  assert.ok(after.holdersPaid <= after.holdersFunded);
  ok(`payouts stop at the list total: holders_paid ${xnt(after.holdersPaid)} == list_total, funded ${xnt(after.holdersFunded)}`);
  await fails("publish a list above holders_funded to cover it", send([publishIx(publisher.publicKey, mint, bad.root, 5n, after.holdersFunded + 1n)], [publisher]), /OverFunded/);
}

console.log("8. Creator reward");
{
  const rv = rewardVaultPda(A.nft);
  const d = (await conn.getAccountInfo(rv, "confirmed"))!.data;
  const tranches: string[] = [];
  for (let i = 0; i < 10; i++) {
    const amt = d.readBigUInt64LE(96 + i * 16), at = d.readBigInt64LE(104 + i * 16);
    if (amt > 0n) tranches.push(`${xnt(amt)} XNT at ${new Date(Number(at) * 1000).toISOString()}`);
  }
  ok(`reward vault holds ${xnt(d.readBigUInt64LE(80))} XNT deposited, vesting: ${tranches.join("; ")}`);
  ok("claim by the NFT holder is lp_locker's claim_reward after the 7-day vest (the cloned testnet lp_locker has no short-vest), not run here");
}

const vf = await checkInvariants(mint, "final");
console.log("\nTotals:", {
  collected: tok(vf.totalCollected), burned: tok(vf.totalBurned), lpTokens: tok(vf.totalLpTokens), lpXnt: xnt(vf.totalLpXnt),
  creatorXnt: xnt(vf.totalCreatorXnt), crankRewards: xnt(vf.totalCrankRewards), holdersFunded: xnt(vf.holdersFunded), holdersPaid: xnt(vf.holdersPaid),
});
console.log("\nCompute units and transaction sizes (incl. a SetComputeUnitLimit instruction):");
for (const [name, rows] of Object.entries(stats)) {
  const cus = rows.map((r) => r.cu), sizes = rows.map((r) => r.size);
  console.log(`  ${name.padEnd(48)} ${String(Math.min(...cus)).padStart(7)}-${String(Math.max(...cus)).padEnd(7)} CU  ${Math.max(...sizes)} bytes  (${rows.length}x)`);
}
console.log("All tax-vault checks passed.");
