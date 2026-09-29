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
} from "../src/taxvault.js";
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
    ["upgradeVault", "upgrade_vault"],
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
  assert.equal(VAULT_VERSION, 2);
  assert.deepEqual(rewardTokenInfo("testnet", REWARD_MINT.testnet), { mint: REWARD_MINT.testnet, symbol: "XNM", decimals: 9 });
  assert.equal(rewardTokenInfo("testnet", NATIVE_MINT)!.symbol, "XNT");
  assert.equal(rewardTokenInfo("mainnet", REWARD_MINT.testnet), null);
});

test("publish_list, cancel_list and pay: args and accounts", () => {
  const publisher = key(), mint = key(), root = crypto.randomBytes(32);
  const pub = publishListIx(PROGRAM, publisher, mint, root, 7n, 9_000_000_000n);
  assert.equal(pub.data.length, 56);
  assert.ok(pub.data.subarray(0, 8).equals(IX.publishList));
  assert.ok(pub.data.subarray(8, 40).equals(root));
  assert.equal(pub.data.readBigUInt64LE(40), 7n);
  assert.equal(pub.data.readBigUInt64LE(48), 9_000_000_000n);
  assert.deepEqual(pub.keys.map((k) => k.pubkey.toBase58()), [publisher, vaultPda(PROGRAM, mint)].map((k) => k.toBase58()));
  assert.equal(flags(pub), "s- -w");
  assert.throws(() => publishListIx(PROGRAM, publisher, mint, Buffer.alloc(31), 1n, 1n));

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
  assert.equal(errorOf(`{"Custom":6022}`), null);
  assert.equal(ERRORS.length, 22);
  assert.equal(errorOf("something else"), null);
});
