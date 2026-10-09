import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  EVENT, IX, LOCKER_PROGRAM_ID, PAID_RECORD_DISC, PAID_RECORD_LEN, VAULT_DISC, VAULT_LEN, addLiquidityIx, buildVaultTree, cancelListIx, collectIx,
  decodeEvent, decodePaidRecord, decodeVault, derivePoolAccounts, effectiveList, encodePaidRecord, encodeVault, errorOf, fundCreatorIx, initVaultIx,
  paidRecordPda, parseEvents, payIx, poolAccountsFrom, publishListIx, sellIx, sellImpactBps, validSplit, TAX_VAULT_PROGRAM_ID, ERRORS, vaultAuthPda, vaultLeaf, vaultPda, verifyVaultProof, type Vault,
  MAX_CANCELS_IN_ROW, REWARD_MAX_IMPACT_BPS, REWARD_MINT, REWARD_POOL, REWARD_TOKEN, VAULT_V2_LEN, VAULT_V2_OFFSETS, VAULT_VERSION, cancelsLeft, deriveRewardPoolAccounts,
  rewardImpactBps, rewardPoolAccountsFrom, rewardTokenInfo, upgradeVaultIx, vaultJson,
  VAULT_V3_LEN, VAULT_V3_OFFSETS, VAULT_WINDOWS, appointAllowedAt, appointPublisherIx, base32Decode, base32Encode, cidFromBytes, cidToBytes, fallbackActive,
  fallbackAt, fallbackEntitled, payFallbackIx, rawCid, setPublisherIx,
  VAULT_PAYOUT_OFFSETS, initVaultPayoutIx, paysInToken, payFallbackTokenIx, payTokenIx,
} from "../src/taxvault.js";
import { composeList, listFileText, parseListFile } from "../src/vault-crank.js";
import { lockPda, MEMO_PROGRAM_ID, rewardTokensPda, rewardVaultPda } from "../src/locker.js";
import { poolAuthority, type Pool } from "../src/xdex.js";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const key = () => Keypair.generate().publicKey;
const PROGRAM = key();
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");

test("discriminators are Anchor's sha256 prefixes of the spec's names", () => {
  const ixs: [keyof typeof IX, string][] = [
    ["initVault", "init_vault"], ["collect", "collect"], ["sell", "sell"], ["addLiquidity", "add_liquidity"],
    ["fundCreator", "fund_creator"], ["publishList", "publish_list"], ["cancelList", "cancel_list"], ["pay", "pay"],
    ["upgradeVault", "upgrade_vault"], ["setPublisher", "set_publisher"], ["appointPublisher", "appoint_publisher"], ["payFallback", "pay_fallback"],
    ["initVaultPayout", "init_vault_payout"], ["fundHolders", "fund_holders"], ["payToken", "pay_token"], ["payFallbackToken", "pay_fallback_token"],
  ];
  assert.equal(Object.keys(IX).length, ixs.length);
  for (const [k, name] of ixs) assert.ok(IX[k].equals(disc(`global:${name}`)), name);
  assert.ok(VAULT_DISC.equals(disc("account:Vault")));
  assert.ok(PAID_RECORD_DISC.equals(disc("account:PaidRecord")));
  for (const name of Object.keys(EVENT) as (keyof typeof EVENT)[]) assert.ok(EVENT[name].equals(disc(`event:${name}`)), name);
  // Regression pin for the one the site calls most.
  assert.equal(IX.pay.toString("hex"), disc("global:pay").toString("hex"));
});

test("PDAs use the spec's seeds", () => {
  const mint = key(), wallet = key();
  const vault = vaultPda(PROGRAM, mint);
  assert.ok(vault.equals(PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], PROGRAM)[0]));
  assert.ok(vaultAuthPda(PROGRAM, mint).equals(PublicKey.findProgramAddressSync([Buffer.from("auth"), mint.toBuffer()], PROGRAM)[0]));
  assert.ok(paidRecordPda(PROGRAM, vault, wallet).equals(PublicKey.findProgramAddressSync([Buffer.from("paid"), vault.toBuffer(), wallet.toBuffer()], PROGRAM)[0]));
  // The auth PDA is off-curve: holder rules must exclude it explicitly (it's not a wallet).
  assert.equal(PublicKey.isOnCurve(vaultAuthPda(PROGRAM, mint).toBytes()), false);
});

test("split limits: holders keep at least 35% with the creator's fixed 10%", () => {
  assert.ok(validSplit(0, 0));
  assert.ok(validSplit(5000, 500));
  assert.ok(validSplit(2500, 3000));
  assert.ok(!validSplit(5001, 0));
  assert.ok(!validSplit(0, 5001));
  assert.ok(!validSplit(3000, 3000));
  assert.ok(!validSplit(-1, 0));
});

const flags = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
  ix.keys.map((k) => `${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`).join(" ");

test("init_vault: args and accounts", () => {
  const payer = key(), mint = key(), pool = key(), nft = key(), publisher = key(), guardian = key();
  const ix = initVaultIx(PROGRAM, { payer, mint, pool, creatorNft: nft, burnBps: 2500, lpBps: 3000, publisher, guardian });
  assert.ok(ix.programId.equals(PROGRAM));
  assert.equal(ix.data.length, 8 + 2 + 2 + 32 + 32);
  assert.ok(ix.data.subarray(0, 8).equals(IX.initVault));
  assert.equal(ix.data.readUInt16LE(8), 2500);
  assert.equal(ix.data.readUInt16LE(10), 3000);
  assert.ok(ix.data.subarray(12, 44).equals(publisher.toBuffer()));
  assert.ok(ix.data.subarray(44, 76).equals(guardian.toBuffer()));
  const want = [payer, mint, vaultPda(PROGRAM, mint), vaultAuthPda(PROGRAM, mint), pool, lockPda(LOCKER_PROGRAM_ID, nft), nft, SystemProgram.programId,
    SYSVAR_INSTRUCTIONS_PUBKEY];
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), want.map((k) => k.toBase58()));
  assert.equal(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), "Sysvar1nstructions1111111111111111111111111");
  assert.equal(flags(ix), "sw -- -w -w -- -- -- -- --");
});

test("collect: accounts, then the harvest accounts as writable remaining accounts", () => {
  const caller = key(), mint = key(), h = [key(), key(), key()];
  const auth = vaultAuthPda(PROGRAM, mint);
  const ix = collectIx(PROGRAM, caller, mint, h);
  assert.ok(ix.data.equals(IX.collect));
  const want = [caller, vaultPda(PROGRAM, mint), auth, mint, getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID),
    TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, ...h];
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), want.map((k) => k.toBase58()));
  assert.equal(flags(ix), "sw -w -w -w -w -- -- -- -w -w -w");
  assert.equal(collectIx(PROGRAM, caller, mint).keys.length, 8);
});

const poolFixture = (mint: PublicKey, tokenSide: 0 | 1): Pool => {
  const vaults: [PublicKey, PublicKey] = [key(), key()];
  const mints: [PublicKey, PublicKey] = tokenSide === 0 ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint];
  return {
    address: key(), ammConfig: key(), vaults, mints, programs: tokenSide === 0 ? [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID] : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
    observation: key(), lpMint: key(), lpSupply: 1n, lpDecimals: 9, depositsPaused: false, protocolFees: [0n, 0n], fundFees: [0n, 0n],
  };
};

test("pool accounts: token and wXNT vaults follow the pool's sides", () => {
  const mint = key();
  for (const side of [0, 1] as const) {
    const p = poolFixture(mint, side);
    const a = poolAccountsFrom(XDEX, p, mint);
    assert.ok(a.tokenVault.equals(p.vaults[side]));
    assert.ok(a.wxntVault.equals(p.vaults[1 - side]));
  }
  assert.throws(() => poolAccountsFrom(XDEX, poolFixture(mint, 0), key()));
  // Derived without the chain: the same PDAs XDEX uses (vault per mint).
  const cfg = key();
  const d = derivePoolAccounts(XDEX, cfg, mint);
  assert.ok(d.tokenVault.equals(PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), d.pool.toBuffer(), mint.toBuffer()], XDEX)[0]));
  assert.ok(d.wxntVault.equals(PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), d.pool.toBuffer(), NATIVE_MINT.toBuffer()], XDEX)[0]));
});

test("sell: max_tokens and the spec's 18 accounts", () => {
  const caller = key(), mint = key();
  const p = poolAccountsFrom(XDEX, poolFixture(mint, 1), mint);
  const ix = sellIx(PROGRAM, caller, mint, p, 123_456_789n);
  assert.ok(ix.data.subarray(0, 8).equals(IX.sell));
  assert.equal(ix.data.readBigUInt64LE(8), 123_456_789n);
  const auth = vaultAuthPda(PROGRAM, mint);
  const want = [caller, vaultPda(PROGRAM, mint), auth, mint, getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID), p.pool, p.ammConfig, poolAuthority(XDEX), p.tokenVault, p.wxntVault,
    p.observation, XDEX, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, NATIVE_MINT];
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), want.map((k) => k.toBase58()));
  assert.deepEqual(ix.keys.map((k) => k.isWritable), [true, true, true, false, true, true, true, false, false, true, true, true, false, false, false, false, false, false]);
  assert.deepEqual(ix.keys.map((k) => k.isSigner), [true, ...Array(17).fill(false)]);
});

test("add_liquidity: the spec's 19 accounts", () => {
  const caller = key(), mint = key();
  const p = poolAccountsFrom(XDEX, poolFixture(mint, 0), mint);
  const ix = addLiquidityIx(PROGRAM, caller, mint, p);
  assert.ok(ix.data.equals(IX.addLiquidity));
  const auth = vaultAuthPda(PROGRAM, mint);
  const want = [caller, vaultPda(PROGRAM, mint), auth, mint, getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID), getAssociatedTokenAddressSync(p.lpMint, auth, true, TOKEN_PROGRAM_ID),
    p.pool, poolAuthority(XDEX), p.tokenVault, p.wxntVault, p.lpMint, XDEX, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MEMO_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId, NATIVE_MINT];
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), want.map((k) => k.toBase58()));
  assert.deepEqual(ix.keys.map((k) => k.isWritable), [true, true, true, false, true, true, true, true, false, true, true, true, false, false, false, false, false, false, false]);
});

/** An XNT/reward-token pool as decodePool returns it (reward token on `rewardSide`). */
const rewardPoolFixture = (rewardMint: PublicKey, rewardSide: 0 | 1): Pool => {
  const mints: [PublicKey, PublicKey] = rewardSide === 0 ? [rewardMint, NATIVE_MINT] : [NATIVE_MINT, rewardMint];
  return {
    address: key(), ammConfig: key(), vaults: [key(), key()], mints,
    programs: rewardSide === 0 ? [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID] : [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
    observation: key(), lpMint: key(), lpSupply: 1n, lpDecimals: 9, depositsPaused: false, protocolFees: [0n, 0n], fundFees: [0n, 0n],
  };
};

test("reward pool accounts: reward and wXNT vaults follow the pool's sides; derived PDAs match XDEX's", () => {
  const rewardMint = REWARD_MINT.testnet;
  for (const side of [0, 1] as const) {
    const p = rewardPoolFixture(rewardMint, side);
    const a = rewardPoolAccountsFrom(XDEX, p, rewardMint);
    assert.ok(a.rewardVault.equals(p.vaults[side]));
    assert.ok(a.wxntVault.equals(p.vaults[1 - side]));
    assert.ok(a.rewardTokenProgram.equals(TOKEN_2022_PROGRAM_ID));
    assert.ok(a.pool.equals(p.address) && a.ammConfig.equals(p.ammConfig) && a.observation.equals(p.observation));
  }
  assert.throws(() => rewardPoolAccountsFrom(XDEX, rewardPoolFixture(rewardMint, 0), key()));
  const cfg = key();
  const d = deriveRewardPoolAccounts(XDEX, cfg, rewardMint);
  assert.ok(d.rewardVault.equals(PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), d.pool.toBuffer(), rewardMint.toBuffer()], XDEX)[0]));
  assert.ok(d.wxntVault.equals(PublicKey.findProgramAddressSync([Buffer.from("pool_vault"), d.pool.toBuffer(), NATIVE_MINT.toBuffer()], XDEX)[0]));
});

test("fund_creator (v2): the spec's 24 accounts, reward swap after the lp_locker ones", () => {
  const caller = key(), mint = key(), nft = key();
  const rewardMint = REWARD_MINT.testnet;
  const r = rewardPoolAccountsFrom(XDEX, rewardPoolFixture(rewardMint, 1), rewardMint);
  const ix = fundCreatorIx(PROGRAM, caller, mint, nft, r);
  assert.ok(ix.data.equals(IX.fundCreator));
  const auth = vaultAuthPda(PROGRAM, mint);
  const rv = rewardVaultPda(LOCKER_PROGRAM_ID, nft, rewardMint);
  const want = [caller, vaultPda(PROGRAM, mint), auth, getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID), nft, rewardMint,
    rv, rewardTokensPda(LOCKER_PROGRAM_ID, rv), LOCKER_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    lockPda(LOCKER_PROGRAM_ID, nft), TOKEN_2022_PROGRAM_ID,
    // auth_reward, reward_pool, reward_amm_config, xdex_authority, reward_pool_reward_vault, reward_pool_wxnt_vault,
    // reward_observation, xdex_program, native_mint, reward_token_program
    getAssociatedTokenAddressSync(rewardMint, auth, true, TOKEN_2022_PROGRAM_ID), r.pool, r.ammConfig, poolAuthority(XDEX), r.rewardVault, r.wxntVault,
    r.observation, XDEX, NATIVE_MINT, TOKEN_2022_PROGRAM_ID];
  assert.equal(ix.keys.length, 24);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), want.map((k) => k.toBase58()));
  assert.equal(flags(ix), "sw -w -w -w -- -- -w -w -- -- -- -- -- -- -w -w -- -- -w -w -w -- -- --");
  // The reward vault is keyed by the reward mint, not wXNT (the creator's old XNT vault stays separate).
  assert.ok(!rv.equals(rewardVaultPda(LOCKER_PROGRAM_ID, nft, NATIVE_MINT)));
  // A payout-token vault appends its payout pool (read-only) as the 25th account.
  const payoutPool = key();
  const withPayout = fundCreatorIx(PROGRAM, caller, mint, nft, r, payoutPool);
  assert.equal(withPayout.keys.length, 25);
  assert.deepEqual(withPayout.keys.slice(0, 24), ix.keys);
  assert.ok(withPayout.keys[24].pubkey.equals(payoutPool) && !withPayout.keys[24].isWritable && !withPayout.keys[24].isSigner);
});

test("upgrade_vault: payer, vault, system program", () => {
  const payer = key(), mint = key();
  const ix = upgradeVaultIx(PROGRAM, payer, mint);
  assert.ok(ix.data.equals(IX.upgradeVault));
  assert.equal(ix.data.length, 8);
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [payer, vaultPda(PROGRAM, mint), SystemProgram.programId].map((k) => k.toBase58()));
  assert.equal(flags(ix), "sw -w --");
});

test("v2 constants: the network's reward token and pool, impact cap and cancel limit", () => {
  assert.equal(REWARD_MINT.testnet.toBase58(), "AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ");
  assert.equal(REWARD_POOL.testnet.toBase58(), "6XESNUXbGNT6x3zaB51Axk7Jh6Ba58LFJukkfPUzzSwA");
  assert.equal(REWARD_MINT.mainnet.toBase58(), "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
  assert.equal(REWARD_POOL.mainnet.toBase58(), "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
  assert.equal(REWARD_TOKEN.testnet.decimals, 9);
  assert.equal(REWARD_TOKEN.mainnet.decimals, 6);
  assert.equal(REWARD_MAX_IMPACT_BPS, 300);
  // The reward swap's cap: half the pool's trade fee (millionths / 200), never above 3%.
  assert.equal(rewardImpactBps(3000n), 15); // 0.3% fee (testnet)
  assert.equal(rewardImpactBps(2800), 14); // 0.28% fee (mainnet)
  assert.equal(rewardImpactBps(1_000_000n), 300);
  assert.equal(rewardImpactBps(199), 0);
  assert.equal(MAX_CANCELS_IN_ROW, 2);
  assert.equal(VAULT_VERSION, 3);
  assert.deepEqual(rewardTokenInfo("testnet", REWARD_MINT.testnet), { mint: REWARD_MINT.testnet, symbol: "XNM", decimals: 9 });
  assert.equal(rewardTokenInfo("testnet", NATIVE_MINT)!.symbol, "XNT");
  assert.equal(rewardTokenInfo("mainnet", REWARD_MINT.testnet), null);
});

test("publish_list, cancel_list and pay: args and accounts", () => {
  const publisher = key(), mint = key(), root = crypto.randomBytes(32);
  const cid = cidToBytes("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
  const pub = publishListIx(PROGRAM, publisher, mint, root, 7n, 9_000_000_000n, cid);
  // v3: root, epoch, total, then the list file's CID as [u8; 33].
  assert.equal(pub.data.length, 8 + 32 + 8 + 8 + 33);
  assert.ok(pub.data.subarray(0, 8).equals(IX.publishList));
  assert.ok(pub.data.subarray(8, 40).equals(root));
  assert.equal(pub.data.readBigUInt64LE(40), 7n);
  assert.equal(pub.data.readBigUInt64LE(48), 9_000_000_000n);
  assert.ok(pub.data.subarray(56, 89).equals(cid));
  assert.equal(pub.data[56], 0x55);
  assert.deepEqual(pub.keys.map((k) => k.pubkey.toBase58()), [publisher, vaultPda(PROGRAM, mint)].map((k) => k.toBase58()));
  assert.equal(flags(pub), "s- -w");
  assert.throws(() => publishListIx(PROGRAM, publisher, mint, Buffer.alloc(31), 1n, 1n, cid));
  assert.throws(() => publishListIx(PROGRAM, publisher, mint, root, 1n, 1n, Buffer.alloc(32)));

  const guardian = key();
  const cancel = cancelListIx(PROGRAM, guardian, mint);
  assert.ok(cancel.data.equals(IX.cancelList));
  assert.equal(flags(cancel), "s- -w");

  const payer = key(), wallet = key(), proof = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)];
  const pay = payIx(PROGRAM, payer, mint, wallet, 5_000n, proof);
  assert.equal(pay.data.length, 8 + 8 + 4 + 96);
  assert.equal(pay.data.readBigUInt64LE(8), 5_000n);
  assert.equal(pay.data.readUInt32LE(16), 3);
  proof.forEach((p, i) => assert.ok(pay.data.subarray(20 + 32 * i, 52 + 32 * i).equals(p)));
  const vault = vaultPda(PROGRAM, mint);
  assert.deepEqual(pay.keys.map((k) => k.pubkey.toBase58()),
    [payer, vault, vaultAuthPda(PROGRAM, mint), wallet, paidRecordPda(PROGRAM, vault, wallet), SystemProgram.programId].map((k) => k.toBase58()));
  assert.equal(flags(pay), "sw -w -w -w -w --");
  assert.equal(payIx(PROGRAM, payer, mint, wallet, 1n, []).data.length, 20);
});

const sampleVault = (): Omit<Vault, "address"> => ({
  mint: key(), pool: key(), creatorNft: key(), rewardMint: NATIVE_MINT, rewardSwapPool: PublicKey.default, publisher: key(), guardian: key(),
  burnBps: 2500, lpBps: 2000, creatorBps: 1000,
  pendingTokens: 0n, lpTokens: 11n, sellLp: 12n, sellCreator: 13n, sellHolders: 14n, xntLp: 15n, xntCreator: 16n,
  holdersFunded: 2n ** 63n + 5n, holdersPaid: 17n, listEpoch: 3n, listRoot: crypto.randomBytes(32), listTotal: 18n,
  pendingEpoch: 4n, pendingRoot: crypto.randomBytes(32), pendingTotal: 19n, pendingActiveAt: 1_790_000_000,
  totalCollected: 20n, totalBurned: 21n, totalLpTokens: 22n, totalLpXnt: 23n, totalCreatorXnt: 24n, totalCrankRewards: 25n,
  createdAt: 1_780_000_000, bump: 254, authBump: 253, lastSellSlot: 123_456_789_012n,
  version: 1, cancelsInRow: 0, totalRewardOut: 0n, lastRewardSlot: 0n,
  lastPublishAt: 0, listCid: Buffer.alloc(33), pendingCid: Buffer.alloc(33), fallbackPaid: 0n, payoutPool: PublicKey.default, xntHolders: 0n,
});
const sampleVaultV2 = (): Omit<Vault, "address"> => ({
  ...sampleVault(), rewardMint: REWARD_MINT.testnet, rewardSwapPool: REWARD_POOL.testnet, version: 2, cancelsInRow: 1, totalRewardOut: 2n ** 60n + 7n, lastRewardSlot: 987_654_321_000n,
});
const sameVault = (back: Vault, v: Omit<Vault, "address">) => {
  for (const [k, want] of Object.entries(v)) {
    const got = (back as unknown as Record<string, unknown>)[k];
    if (want instanceof PublicKey) assert.ok((got as PublicKey).equals(want), k);
    else if (Buffer.isBuffer(want)) assert.ok((got as Buffer).equals(want), k);
    else assert.equal(got, want, k);
  }
};

test("Vault decodes what it encodes, field for field, at the spec's size", () => {
  assert.equal(VAULT_LEN, 480);
  const v = sampleVault();
  const d = encodeVault(v);
  assert.equal(d.length, VAULT_LEN);
  const addr = key();
  const back = decodeVault(addr, d);
  assert.ok(back.address.equals(addr));
  sameVault(back, v);
  // Fixed offsets the program's layout implies (8-byte discriminator, 7 keys, 3 u16).
  assert.equal(d.readUInt16LE(8 + 224), 2500);
  assert.equal(d.readBigUInt64LE(8 + 224 + 6 + 8), 11n); // lp_tokens after pending_tokens
  assert.equal(d.readBigUInt64LE(472), 123_456_789_012n); // last_sell_slot, the last field
  assert.throws(() => decodeVault(addr, Buffer.alloc(VAULT_LEN)));
  assert.throws(() => decodeVault(addr, d.subarray(0, VAULT_LEN - 1)));
});

test("Vault v2: 552 bytes, the appended fields at 480/481/482/490, older fields unmoved; v1 reads as version 1", () => {
  assert.equal(VAULT_V2_LEN, 552);
  assert.deepEqual(VAULT_V2_OFFSETS, { version: 480, cancelsInRow: 481, totalRewardOut: 482, lastRewardSlot: 490, reserved: 498 });
  const v = sampleVaultV2();
  const d = encodeVault(v);
  assert.equal(d.length, VAULT_V2_LEN);
  assert.equal(d[480], 2);
  assert.equal(d[481], 1);
  assert.equal(d.readBigUInt64LE(482), 2n ** 60n + 7n);
  assert.equal(d.readBigUInt64LE(490), 987_654_321_000n); // last_reward_slot
  assert.ok(d.subarray(498, 552).equals(Buffer.alloc(54))); // reserved
  assert.ok(d.subarray(104, 136).equals(REWARD_MINT.testnet.toBuffer())); // reward_mint
  assert.ok(d.subarray(136, 168).equals(REWARD_POOL.testnet.toBuffer())); // reward_swap_pool
  assert.equal(d.readBigUInt64LE(472), 123_456_789_012n);
  const back = decodeVault(key(), d);
  sameVault(back, v);
  // The first 480 bytes are a v1 vault's layout: an old account decodes with the v2 fields zeroed.
  const v1 = decodeVault(key(), Buffer.from(d.subarray(0, VAULT_LEN)));
  assert.equal(v1.version, 1);
  assert.equal(v1.cancelsInRow, 0);
  assert.equal(v1.totalRewardOut, 0n);
  assert.equal(v1.lastRewardSlot, 0n);
  assert.equal(v1.lastSellSlot, 123_456_789_012n);
  assert.equal(encodeVault(sampleVault()).length, VAULT_LEN);
});

test("cancels left: MAX_CANCELS_IN_ROW minus cancels in a row on v2, no limit on v1", () => {
  assert.equal(cancelsLeft({ version: 2, cancelsInRow: 0 }), 2);
  assert.equal(cancelsLeft({ version: 2, cancelsInRow: 1 }), 1);
  assert.equal(cancelsLeft({ version: 2, cancelsInRow: 2 }), 0);
  assert.equal(cancelsLeft({ version: 2, cancelsInRow: 5 }), 0);
  assert.equal(cancelsLeft({ version: 1, cancelsInRow: 0 }), null);
  const j = vaultJson({ ...sampleVaultV2(), address: key() } as Vault);
  assert.equal(j.version, 2);
  assert.equal(j.cancelsLeft, 1);
  assert.equal(j.rewardMint, REWARD_MINT.testnet.toBase58());
  assert.equal(j.rewardSwapPool, REWARD_POOL.testnet.toBase58());
  assert.equal(j.totals.rewardOut, (2n ** 60n + 7n).toString());
});

test("PaidRecord round-trips", () => {
  assert.equal(PAID_RECORD_LEN, 81);
  const r = { vault: key(), wallet: key(), paid: 987_654_321n, bump: 7 };
  const back = decodePaidRecord(key(), encodePaidRecord(r));
  assert.ok(back.vault.equals(r.vault) && back.wallet.equals(r.wallet));
  assert.equal(back.paid, r.paid);
  assert.equal(back.bump, 7);
  assert.throws(() => decodePaidRecord(key(), Buffer.alloc(81)));
});

test("effective list: a pending list counts once its time has come", () => {
  const v = { ...sampleVault(), address: key() } as Vault;
  assert.equal(effectiveList(v, v.pendingActiveAt - 1)!.epoch, 3n);
  assert.equal(effectiveList(v, v.pendingActiveAt)!.epoch, 4n);
  assert.equal(effectiveList({ ...v, pendingEpoch: 0n, listEpoch: 0n }, v.pendingActiveAt), null);
});

test("leaf is sha256(\"99tax-vault\" || vault || wallet || cumulative LE)", () => {
  const vault = key(), wallet = key();
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(123_456_789n);
  const want = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("99tax-vault"), vault.toBuffer(), wallet.toBuffer(), amt])).digest();
  assert.ok(vaultLeaf(vault, wallet, 123_456_789n).equals(want));
  // Bound to the vault: the same wallet and amount in another vault is another leaf.
  assert.ok(!vaultLeaf(key(), wallet, 123_456_789n).equals(want));
});

test("every wallet's proof verifies; wrong amounts, wrong vault and foreign proofs don't", () => {
  const vault = key();
  for (const n of [1, 2, 3, 5, 8, 17, 64]) {
    const entries: Record<string, bigint> = {};
    for (let i = 0; i < n; i++) entries[key().toBase58()] = BigInt(1_000 * (i + 1));
    const { root, proofs } = buildVaultTree(vault, entries);
    for (const [w, cum] of Object.entries(entries)) {
      const pk = new PublicKey(w);
      assert.ok(verifyVaultProof(proofs[w], root, vault, pk, cum), `n=${n}`);
      assert.ok(!verifyVaultProof(proofs[w], root, vault, pk, cum + 1n));
      assert.ok(!verifyVaultProof(proofs[w], root, key(), pk, cum));
      assert.ok(proofs[w].length <= Math.ceil(Math.log2(n)));
    }
    if (n > 1) {
      const [a, b] = Object.keys(entries);
      assert.ok(!verifyVaultProof(proofs[b], root, vault, new PublicKey(a), entries[a]));
    }
  }
  assert.ok(buildVaultTree(vault, {}).root.equals(Buffer.alloc(32)));
  // One wallet: the root is its leaf and the proof is empty.
  const w = key();
  const one = buildVaultTree(vault, { [w.toBase58()]: 5n });
  assert.ok(one.root.equals(vaultLeaf(vault, w, 5n)));
  assert.equal(one.proofs[w.toBase58()].length, 0);
});

test("the root doesn't depend on insertion order and accepts string amounts", () => {
  const vault = key();
  const ks = Array.from({ length: 11 }, () => key().toBase58());
  const fwd = Object.fromEntries(ks.map((k, i) => [k, BigInt(i + 1)]));
  const rev = Object.fromEntries([...ks].reverse().map((k) => [k, fwd[k].toString()]));
  assert.ok(buildVaultTree(vault, fwd).root.equals(buildVaultTree(vault, rev).root));
});

test("leaf and root match the tax_vault program (fixed vector from its Rust test)", () => {
  const vault = new PublicKey(Buffer.alloc(32, 1));
  const a = new PublicKey(Buffer.alloc(32, 2)), b = new PublicKey(Buffer.alloc(32, 3));
  assert.equal(vaultLeaf(vault, a, 1_000_000_000n).toString("hex"), "f1df94e69dc2ad0365865c9eaeb81deac6bfbc98a2e5abe33decf1128b63e821");
  assert.equal(vaultLeaf(vault, b, 5n).toString("hex"), "b5435ce16439596a11ef089ff9711a91493463e941f8a646a52fa2c3834ce969");
  const { root, proofs } = buildVaultTree(vault, { [a.toBase58()]: 1_000_000_000n, [b.toBase58()]: 5n });
  assert.equal(root.toString("hex"), "1992f5473e12ba77f8b909f1cb3272b5492544fc3e37ea7a5d7c3776290bda6a");
  assert.ok(verifyVaultProof(proofs[a.toBase58()], root, vault, a, 1_000_000_000n));
  assert.ok(verifyVaultProof(proofs[b.toBase58()], root, vault, b, 5n));
});

test("sale impact cap is min(3%, half the tax) and the program id is the deployed one", () => {
  assert.equal(sellImpactBps(500), 250);
  assert.equal(sellImpactBps(1000), 300);
  assert.equal(sellImpactBps(101), 50);
  assert.equal(TAX_VAULT_PROGRAM_ID.toBase58(), "D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
  assert.equal(ERRORS.indexOf("OneSellPerSlot") + 6000, 6018);
});

test("events decode from \"Program data:\" log lines", () => {
  const vault = key(), wallet = key();
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
  const line = (...parts: Buffer[]) => `Program data: ${Buffer.concat(parts).toString("base64")}`;
  const root = crypto.randomBytes(32);
  const logs = [
    "Program log: Instruction: Collect",
    line(EVENT.Collected, vault.toBuffer(), u64(1000n), u64(250n)),
    line(EVENT.Sold, vault.toBuffer(), u64(700n), u64(9_000n), u64(1_000n), u64(1_500n), u64(6_430n), u64(70n)),
    line(EVENT.LiquidityAdded, vault.toBuffer(), u64(5n), u64(6n), u64(7n)),
    line(EVENT.CreatorFunded, vault.toBuffer(), u64(8n)), // v1 shape { vault, amount }
    line(EVENT.ListPublished, vault.toBuffer(), u64(2n), root, u64(99n), i64(1_790_000_600)),
    line(EVENT.ListCancelled, vault.toBuffer(), u64(2n)),
    line(EVENT.Paid, vault.toBuffer(), wallet.toBuffer(), u64(40n), u64(140n)),
    line(Buffer.from("not-ours"), vault.toBuffer()),
    line(EVENT.Paid, vault.toBuffer()), // truncated
  ];
  const ev = parseEvents(logs);
  assert.deepEqual(ev.map((e) => e.name), ["Collected", "Sold", "LiquidityAdded", "CreatorFunded", "ListPublished", "ListCancelled", "Paid"]);
  assert.deepEqual(ev[0], { name: "Collected", vault: vault.toBase58(), got: 1000n, burned: 250n });
  assert.deepEqual(ev[1], { name: "Sold", vault: vault.toBase58(), tokensIn: 700n, xntOut: 9_000n, toLp: 1_000n, toCreator: 1_500n, toHolders: 6_430n, crankReward: 70n });
  assert.deepEqual(ev[4], { name: "ListPublished", vault: vault.toBase58(), epoch: 2n, root: root.toString("hex"), total: 99n, activeAt: 1_790_000_600 });
  assert.deepEqual(ev[6], { name: "Paid", vault: vault.toBase58(), wallet: wallet.toBase58(), amount: 40n, cumulative: 140n });
  assert.deepEqual(ev[3], { name: "CreatorFunded", vault: vault.toBase58(), xntIn: 8n, rewardOut: 8n, rewardMint: NATIVE_MINT.toBase58() });
  // v2: { vault, xnt_in, reward_out, reward_mint }
  const v2 = parseEvents([line(EVENT.CreatorFunded, vault.toBuffer(), u64(50_000_000n), u64(1_234_567_890n), REWARD_MINT.testnet.toBuffer())]);
  assert.deepEqual(v2, [{ name: "CreatorFunded", vault: vault.toBase58(), xntIn: 50_000_000n, rewardOut: 1_234_567_890n, rewardMint: REWARD_MINT.testnet.toBase58() }]);
  assert.equal(decodeEvent(Buffer.alloc(4)), null);
});

test("program errors are named from simulation messages", () => {
  assert.equal(errorOf(`Simulation failed: {"InstructionError":[2,{"Custom":6013}]}`), "NothingToPay");
  assert.equal(errorOf("custom program error: 0x177e"), "TooSmall"); // 6014
  assert.equal(errorOf(`{"Custom":6018}`), "OneSellPerSlot");
  assert.equal(errorOf(`{"Custom":6019}`), "WrongVersion");
  assert.equal(errorOf(`{"Custom":6020}`), "TooManyCancels");
  assert.equal(errorOf("custom program error: 0x1785"), "BadRewardMint"); // 6021
  assert.equal(errorOf(`{"Custom":6022}`), "PublisherActive");
  assert.equal(errorOf("custom program error: 0x1787"), "FallbackNotActive"); // 6023
  assert.equal(errorOf(`{"Custom":6024}`), "PaysInToken");
  assert.equal(errorOf(`{"Custom":6027}`), "BadPayoutPool");
  assert.equal(errorOf(`{"Custom":6028}`), null);
  assert.equal(ERRORS.length, 28);
  assert.equal(errorOf("something else"), null);
});

// ---------- v3 ----------
const sampleVaultV3 = (): Omit<Vault, "address"> => ({
  ...sampleVaultV2(), version: 3, lastPublishAt: 1_790_123_456, listCid: Buffer.concat([Buffer.from([0x55]), crypto.randomBytes(32)]),
  pendingCid: Buffer.concat([Buffer.from([0x70]), crypto.randomBytes(32)]), fallbackPaid: 2n ** 40n + 3n,
});

test("Vault v3: 640 bytes, last_publish_at 498, list_cid 506, pending_cid 539, fallback_paid 572, reserved to 640; v1/v2 still decode", () => {
  assert.equal(VAULT_V3_LEN, 640);
  assert.deepEqual(VAULT_V3_OFFSETS, { lastPublishAt: 498, listCid: 506, pendingCid: 539, fallbackPaid: 572, reserved: 580 });
  const v = sampleVaultV3();
  const d = encodeVault(v);
  assert.equal(d.length, 640);
  assert.equal(d[480], 3);
  assert.equal(d.readBigInt64LE(498), 1_790_123_456n);
  assert.ok(d.subarray(506, 539).equals(v.listCid));
  assert.ok(d.subarray(539, 572).equals(v.pendingCid));
  assert.equal(d.readBigUInt64LE(572), 2n ** 40n + 3n);
  assert.ok(d.subarray(580, 640).equals(Buffer.alloc(60)));
  // The v2 fields before 498 are where they were.
  assert.equal(d[481], 1);
  assert.equal(d.readBigUInt64LE(482), 2n ** 60n + 7n);
  assert.equal(d.readBigUInt64LE(490), 987_654_321_000n);
  sameVault(decodeVault(key(), d), v);
  // An older vault the crank still has to upgrade: its v3 fields read as zero.
  const v2 = decodeVault(key(), encodeVault(sampleVaultV2()));
  assert.equal(v2.version, 2);
  assert.equal(v2.lastPublishAt, 0);
  assert.ok(v2.listCid.equals(Buffer.alloc(33)) && v2.pendingCid.equals(Buffer.alloc(33)));
  assert.equal(v2.fallbackPaid, 0n);
  assert.equal(decodeVault(key(), encodeVault(sampleVault())).version, 1);
  // The site's JSON carries the CIDs as strings.
  const j = vaultJson({ ...v, address: key() } as Vault);
  assert.equal(j.lastPublishAt, 1_790_123_456);
  assert.equal(j.listCid, cidFromBytes(v.listCid));
  assert.equal(j.fallbackPaid, (2n ** 40n + 3n).toString());
  assert.equal(vaultJson({ ...sampleVaultV2(), address: key() } as Vault).listCid, null);
});

test("Payout token: pool at 580, unswapped XNT at 612 (zero = XNT payouts, as in every older vault); instructions", () => {
  assert.deepEqual(VAULT_PAYOUT_OFFSETS, { payoutPool: 580, xntHolders: 612, reserved: 620 });
  const plain = decodeVault(key(), encodeVault(sampleVaultV3()));
  assert.ok(plain.payoutPool.equals(PublicKey.default) && plain.xntHolders === 0n && !paysInToken(plain));
  const pool = key();
  const v = { ...sampleVaultV3(), payoutPool: pool, xntHolders: 2n ** 33n + 5n };
  const d = encodeVault(v);
  assert.equal(d.length, 640);
  assert.ok(d.subarray(580, 612).equals(pool.toBuffer()));
  assert.equal(d.readBigUInt64LE(612), 2n ** 33n + 5n);
  assert.ok(d.subarray(620, 640).equals(Buffer.alloc(20)));
  const back = decodeVault(key(), d);
  assert.ok(back.payoutPool.equals(pool) && back.xntHolders === 2n ** 33n + 5n && paysInToken(back));
  assert.equal(vaultJson({ ...back, address: key() }).payoutPool, pool.toBase58());

  const program = key(), mint = key(), payer = key(), wallet = key(), payoutMint = key();
  const p = { pool, payoutMint, payoutTokenProgram: TOKEN_PROGRAM_ID };
  const init = initVaultPayoutIx(program, { payer, mint, pool: key(), creatorNft: key(), burnBps: 2500, lpBps: 2500, publisher: payer, guardian: payer, payout: p });
  assert.ok(init.data.subarray(0, 8).equals(IX.initVaultPayout));
  assert.equal(init.keys.length, 12);
  assert.ok(init.keys[9].pubkey.equals(payoutMint) && init.keys[10].pubkey.equals(pool) && init.keys[11].pubkey.equals(TOKEN_PROGRAM_ID));
  const proof = [crypto.randomBytes(32), crypto.randomBytes(32)];
  const pay = payTokenIx(program, payer, mint, wallet, 1234n, proof, p);
  assert.ok(pay.data.subarray(0, 8).equals(IX.payToken));
  assert.equal(pay.data.readBigUInt64LE(8), 1234n);
  assert.equal(pay.data.readUInt32LE(16), 2);
  assert.ok(pay.keys[3].pubkey.equals(wallet) && !pay.keys[3].isWritable, "the wallet only owns the receiving account");
  assert.ok(pay.keys[8].pubkey.equals(getAssociatedTokenAddressSync(payoutMint, wallet, true, TOKEN_PROGRAM_ID)));
  assert.ok(payFallbackTokenIx(program, payer, mint, wallet, 1n, [], p).data.subarray(0, 8).equals(IX.payFallbackToken));
});

test("CIDs: known CIDv1 / CIDv0 strings round-trip through the program's [codec, digest]", () => {
  // The empty file as a raw block, and the empty UnixFS directory (v0 and v1 of the same CID).
  const empty = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const b = cidToBytes(empty);
  assert.equal(b.length, 33);
  assert.equal(b[0], 0x55);
  assert.equal(b.subarray(1).toString("hex"), crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
  assert.equal(cidFromBytes(b), empty);
  assert.equal(rawCid(new Uint8Array()), empty);
  assert.equal(rawCid(Buffer.from("hello world")), "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
  const dir = cidToBytes("QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn");
  assert.equal(dir[0], 0x70);
  assert.equal(cidFromBytes(dir), "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354");
  assert.ok(cidToBytes("bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354").equals(dir));
  assert.equal(cidFromBytes(Buffer.alloc(33)), null); // no file
  assert.throws(() => cidToBytes("zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA")); // base58btc CIDv1: not what we store
  assert.throws(() => cidToBytes("bagaaierasords4njcts6vs7qvdjfcvgnume4hqohf65zsfguprqphs3icwea")); // another codec (dag-json)
  assert.throws(() => cidFromBytes(Buffer.alloc(32)));
  for (let n = 0; n < 40; n++) {
    const x = crypto.randomBytes(n);
    assert.ok(base32Decode(base32Encode(x)).equals(x));
  }
  assert.equal(base32Encode(Buffer.from("foobar")), "mzxw6ytboi"); // RFC 4648 test vector, lowercase, no padding
});

test("fallbackEntitled: floor(cumulative * funded / list_total), like the program's u128 maths", () => {
  assert.equal(fallbackEntitled(1_000n, 3_000n, 2_000n), 1_500n);
  assert.equal(fallbackEntitled(1n, 10n, 3n), 3n); // 3.33 -> 3
  assert.equal(fallbackEntitled(5n, 7n, 0n), 0n);
  const big = 2n ** 63n;
  assert.equal(fallbackEntitled(big, big, big), big); // no overflow (bigint)
  assert.equal(fallbackEntitled(big - 1n, big, big - 1n), big);
  // Shares of a list never add up to more than funded.
  const cums = [123n, 456n, 789n, 1n];
  const total = cums.reduce((a, b) => a + b, 0n), funded = 10_007n;
  assert.ok(cums.reduce((a, c) => a + fallbackEntitled(c, funded, total), 0n) <= funded);
});

test("v3 windows: appointing and fallback count from last_publish_at; fallback needs an active list and nothing pending", () => {
  const w = { appointAfterSecs: 100, fallbackAfterSecs: 300 };
  const base = { ...sampleVaultV3(), address: key(), pendingEpoch: 0n, lastPublishAt: 1_000 } as Vault;
  assert.equal(appointAllowedAt(base, w), 1_100);
  assert.equal(fallbackAt(base, w), 1_300);
  assert.equal(appointAllowedAt({ version: 2, lastPublishAt: 0 }, w), null);
  assert.equal(fallbackActive(base, 1_299, w), false);
  assert.equal(fallbackActive(base, 1_300, w), true);
  assert.equal(fallbackActive({ ...base, listEpoch: 0n }, 5_000, w), false); // no list to pay from
  // A pending list not due yet blocks it; a due one is activated first, so it doesn't.
  assert.equal(fallbackActive({ ...base, pendingEpoch: 9n, pendingActiveAt: 6_000 }, 5_000, w), false);
  assert.equal(fallbackActive({ ...base, pendingEpoch: 9n, pendingActiveAt: 1_010 }, 5_000, w), true);
  assert.equal(fallbackActive({ ...base, version: 2 }, 5_000, w), false);
  assert.deepEqual(VAULT_WINDOWS, process.env.TAX_VAULT_SHORT_WINDOWS ? { appointAfterSecs: 15, fallbackAfterSecs: 30 } : { appointAfterSecs: 604_800, fallbackAfterSecs: 2_592_000 });
});

test("set_publisher, appoint_publisher and pay_fallback: args and accounts", () => {
  const mint = key(), signer = key(), np = key();
  for (const [ix, tag] of [[setPublisherIx(PROGRAM, signer, mint, np), IX.setPublisher], [appointPublisherIx(PROGRAM, signer, mint, np), IX.appointPublisher]] as const) {
    assert.equal(ix.data.length, 40);
    assert.ok(ix.data.subarray(0, 8).equals(tag));
    assert.ok(ix.data.subarray(8).equals(np.toBuffer()));
    assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), [signer, vaultPda(PROGRAM, mint)].map((k) => k.toBase58()));
    assert.equal(flags(ix), "s- -w");
  }
  const payer = key(), wallet = key(), proof = [crypto.randomBytes(32), crypto.randomBytes(32)];
  const fb = payFallbackIx(PROGRAM, payer, mint, wallet, 77n, proof);
  const normal = payIx(PROGRAM, payer, mint, wallet, 77n, proof);
  assert.ok(fb.data.subarray(0, 8).equals(IX.payFallback));
  // Same data and accounts as pay, only the discriminator differs.
  assert.ok(fb.data.subarray(8).equals(normal.data.subarray(8)));
  assert.deepEqual(fb.keys, normal.keys);
});

test("v3 events: PublisherChanged and FallbackPaid; only the program's own log lines count when asked", () => {
  const vault = key(), a = key(), b = key();
  const u64 = (v: bigint) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return x; };
  const data = (...parts: Buffer[]) => `Program data: ${Buffer.concat(parts).toString("base64")}`;
  const changed = data(EVENT.PublisherChanged, vault.toBuffer(), a.toBuffer(), b.toBuffer(), Buffer.from([1]));
  const fb = data(EVENT.FallbackPaid, vault.toBuffer(), a.toBuffer(), u64(40n), u64(1_040n));
  assert.deepEqual(parseEvents([changed, fb]), [
    { name: "PublisherChanged", vault: vault.toBase58(), old: a.toBase58(), new: b.toBase58(), byGuardian: true },
    { name: "FallbackPaid", vault: vault.toBase58(), wallet: a.toBase58(), amount: 40n, entitled: 1_040n },
  ]);
  const other = key().toBase58(), me = PROGRAM.toBase58();
  const logs = [
    `Program ${other} invoke [1]`, fb, `Program ${other} success`, // someone else's look-alike line
    `Program ${me} invoke [1]`, `Program ${other} invoke [2]`, fb, `Program ${other} success`, changed, `Program ${me} consumed 1 of 2 compute units`, `Program ${me} success`,
  ];
  assert.equal(parseEvents(logs).length, 3);
  assert.deepEqual(parseEvents(logs, PROGRAM).map((e) => e.name), ["PublisherChanged"]);
});

test("list builder: nobody starts below what they were paid, the total covers holders_paid, shares go on top", () => {
  const [a, b, c, d] = [key(), key(), key(), key()].map((k) => k.toBase58());
  const prev = { [a]: "100", [b]: "50", [c]: "10" };
  // After a fallback: a and b were paid more than their list totals.
  const paid = new Map([[a, 130n], [b, 50n], [d, 5n]]);
  const shares = new Map([[a, 7n], [c, 3n], [d, 1n]]);
  const floor = 190n; // holders_paid
  const r = composeList(prev, paid, shares, floor);
  assert.deepEqual(r.wallets, { [a]: "137", [b]: "50", [c]: "13", [d]: "6" });
  assert.equal(r.total, 206n);
  for (const [w, p] of paid) assert.ok(BigInt(r.wallets[w]) >= p, w);
  for (const [w, x] of Object.entries(prev)) assert.ok(BigInt(r.wallets[w]) >= BigInt(x), w);
  // Rebuilt from the paid records alone (the old list file is gone), with rounding dust:
  // the shortfall to max(list_total, holders_paid) goes to the largest share.
  const r2 = composeList(null, paid, new Map([[c, 20n], [a, 30n]]), 300n);
  assert.equal(r2.total, 300n);
  assert.equal(r2.wallets[a], String(130n + 30n + (300n - (185n + 50n))));
  for (const [w, p] of paid) assert.ok(BigInt(r2.wallets[w]) >= p);
  assert.deepEqual(composeList(null, new Map(), new Map(), 0n).wallets, {});
});

test("list files: the pinned bytes are canonical and a fetched file must give the on-chain root (and its raw CID)", () => {
  const vault = key(), mint = key();
  const wallets = { [key().toBase58()]: "5", [key().toBase58()]: "1000000000", [key().toBase58()]: "42" };
  const { root } = buildVaultTree(vault, wallets);
  const text = listFileText({ mint: mint.toBase58(), vault: vault.toBase58(), epoch: "3", root: root.toString("hex"), total: "1000000047", wallets });
  // Entries sorted by wallet, whatever order they came in.
  const f = JSON.parse(text);
  assert.deepEqual(f.entries.map((e: string[]) => e[0]), Object.keys(wallets).sort());
  assert.equal(text, listFileText({ mint: mint.toBase58(), vault: vault.toBase58(), epoch: "3", root: root.toString("hex"), total: "1000000047",
    wallets: Object.fromEntries(Object.entries(wallets).reverse()) }));
  const bytes = Buffer.from(text);
  const cid = cidToBytes(rawCid(bytes));
  assert.deepEqual(parseListFile(bytes, vault, root, cid).wallets, wallets);
  assert.throws(() => parseListFile(bytes, key(), root), /another vault/);
  assert.throws(() => parseListFile(bytes, vault, crypto.randomBytes(32)), /root/);
  const tampered = Buffer.from(text.replace('"42"', '"43"'));
  assert.throws(() => parseListFile(tampered, vault, root), /root/);
  assert.throws(() => parseListFile(bytes, vault, root, cidToBytes(rawCid(tampered))), /CID/);
});

// The program source, when it's in the tree: instruction args, error order and the v3 event
// fields must match what this client encodes.
const LIB = new URL("../lp-locker/programs/tax_vault/src/lib.rs", import.meta.url);
test("the client matches lp-locker/programs/tax_vault/src/lib.rs (args, errors, events, layout)", async (t) => {
  const fs = await import("node:fs");
  if (!fs.existsSync(LIB)) { t.skip("program source not present"); return; }
  const src = fs.readFileSync(LIB, "utf8");
  const size: Record<string, number> = { u8: 1, u16: 2, u64: 8, i64: 8, Pubkey: 32, "[u8; 32]": 32, "[u8; 33]": 33 };
  const argsOf = (name: string) => {
    const m = new RegExp(`pub fn ${name}(?:<[^>]*>)?\\(([^)]*(?:\\)[^)]*)?)\\) -> Result`).exec(src);
    assert.ok(m, `pub fn ${name} in lib.rs`);
    return m![1].split(/,(?![^<\[]*[>\]])/).map((s) => s.trim()).filter((s) => s && !/^(mut )?ctx:/.test(s)).map((s) => s.split(":").slice(1).join(":").trim());
  };
  const fixed = (name: string) => argsOf(name).reduce((a, ty) => a + (size[ty] ?? NaN), 0);
  const root = crypto.randomBytes(32), mint = key(), k = key();
  assert.equal(publishListIx(PROGRAM, k, mint, root, 1n, 2n, Buffer.alloc(33)).data.length, 8 + fixed("publish_list"));
  assert.deepEqual(argsOf("publish_list"), ["[u8; 32]", "u64", "u64", "[u8; 33]"]);
  assert.equal(setPublisherIx(PROGRAM, k, mint, k).data.length, 8 + fixed("set_publisher"));
  assert.equal(appointPublisherIx(PROGRAM, k, mint, k).data.length, 8 + fixed("appoint_publisher"));
  assert.deepEqual(argsOf("pay_fallback"), ["u64", "Vec<[u8; 32]>"]);
  assert.deepEqual(argsOf("pay"), ["u64", "Vec<[u8; 32]>"]);
  assert.deepEqual(argsOf("pay_token"), ["u64", "Vec<[u8; 32]>"]);
  assert.deepEqual(argsOf("pay_fallback_token"), ["u64", "Vec<[u8; 32]>"]);
  assert.deepEqual(argsOf("init_vault_payout"), argsOf("init_vault"));
  assert.equal(argsOf("fund_holders").length, 0);
  assert.equal(argsOf("upgrade_vault").length, 0);
  // Error codes: declaration order in `enum VaultError`.
  const errs = /pub enum VaultError \{([\s\S]*?)\n\}/.exec(src)![1].split("\n").map((l) => l.trim()).filter((l) => /^[A-Z]\w*,?$/.test(l)).map((l) => l.replace(",", ""));
  assert.deepEqual(errs, [...ERRORS]);
  // v3 event fields, in order.
  const fields = (ev: string) => new RegExp(`pub struct ${ev} \\{([\\s\\S]*?)\\n\\}`).exec(src)![1].split("\n").map((l) => /^\s*pub (\w+):/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(fields("PublisherChanged"), ["vault", "old", "new", "by_guardian"]);
  assert.deepEqual(fields("FallbackPaid"), ["vault", "wallet", "amount", "entitled"]);
  assert.deepEqual(fields("HoldersFunded"), ["vault", "xnt_in", "payout_out", "payout_mint"]);
  // Layout constants.
  assert.match(src, /pub const VAULT_V3_LEN: usize = 640;/);
  assert.match(src, /pub const VAULT_VERSION: u8 = 3;/);
  assert.match(src, /const LAST_PUBLISH_AT_OFFSET: usize = 498;/);
  const vaultFields = fields("Vault");
  assert.deepEqual(vaultFields.slice(-11), ["version", "cancels_in_row", "total_reward_out", "last_reward_slot", "last_publish_at", "list_cid", "pending_cid", "fallback_paid",
    "payout_pool", "xnt_holders", "reserved"]);
  assert.match(src, /pub reserved: \[u8; 20\],/);
});
