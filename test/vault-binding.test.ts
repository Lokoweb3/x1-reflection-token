/**
 * A tax vault must sit on the launch it was listed as: init_vault takes any pool of the mint and any
 * lock naming that pool, so registration and the crank are what hold it to the launch's. Real
 * registerLaunch and real vault service against a stand-in RPC. No network, no real keys.
 */
import { test, before, after, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AccountLayout, ACCOUNT_SIZE, ExtensionType, MintLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TransferFeeConfigLayout } from "@solana/spl-token";
import { mockRpc, rpcError } from "./helpers/mock-rpc.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-binding-test-"));
process.env.REFLECT_FACTORY_DIR = path.join(dir, "factory");
fs.mkdirSync(process.env.REFLECT_FACTORY_DIR);
// Loaded after the directory is set: src/config.ts reads it once, on import.
const { CONFIG_DISC, POOL_DISC, XDEX_CREATE, poolAddresses } = await import("../src/xdex.js");
const { encodeVault, decodeVault, vaultAuthPda, vaultPda } = await import("../src/taxvault.js");
const { lockPda } = await import("../src/locker.js");
const { CURVE_DISC, CURVE_LEN, CurveStatus, curvePda } = await import("../src/curve.js");
const launch = await import("../src/factory/launch.js");
const { vaultService } = await import("../src/factory/vault.js");
const { vaultOnLaunchPool } = await import("../src/vault-crank.js");

const REPO = path.resolve(import.meta.dirname, "..");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const OTHER_TIER = new PublicKey("77zjKzW2UTth9vMNxfHQsA7YcweTcgNgcCUMyTAXo1T9");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const PROGRAM = new PublicKey("D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW");
const CURVES = Keypair.generate().publicKey;
const key = () => Keypair.generate().publicKey;
const sha8 = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const ixDisc = { collect: sha8("global:collect"), sell: sha8("global:sell"), add_liquidity: sha8("global:add_liquidity"), fund_creator: sha8("global:fund_creator") };

const siteKeyFile = path.join(dir, "site.json");
const siteKey = Keypair.generate();
fs.writeFileSync(siteKeyFile, JSON.stringify([...siteKey.secretKey]));

// ---------- the stand-in chain ----------
const world = { accounts: new Map<string, { owner: string; data: Buffer }>(), simulated: [] as Buffer[], locksDown: false };
const put = (k: PublicKey, owner: PublicKey, data: Buffer) => world.accounts.set(k.toBase58(), { owner: owner.toBase58(), data });
const account = (a: { owner: string; data: Buffer }) => ({ data: [a.data.toString("base64"), "base64"], executable: false, lamports: 10 ** 12, owner: a.owner, rentEpoch: 0, space: a.data.length });
const ctx = { context: { slot: 100, apiVersion: "1.18" } };
function matching(owner: string, filters: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[] = []) {
  return [...world.accounts.entries()].filter(([, a]) => a.owner === owner && filters.every((f) =>
    f.dataSize !== undefined ? a.data.length === f.dataSize : a.data.subarray(f.memcmp!.offset).subarray(0, bs58.decode(f.memcmp!.bytes).length).equals(Buffer.from(bs58.decode(f.memcmp!.bytes)))))
    .map(([pubkey, a]) => ({ pubkey, account: account(a) }));
}
let rpc: Awaited<ReturnType<typeof mockRpc>>;
const conn = () => new Connection(rpc.url, { commitment: "confirmed", disableRetryOnRateLimit: true });
before(async () => {
  rpc = await mockRpc((method, params) => {
    switch (method) {
      case "getAccountInfo": { const a = world.accounts.get(params[0]); return { ...ctx, value: a ? account(a) : null }; }
      case "getMultipleAccounts": return { ...ctx, value: (params[0] as string[]).map((k) => { const a = world.accounts.get(k); return a ? account(a) : null; }) };
      case "getProgramAccounts": {
        if (world.locksDown && params[0] === LOCKER.toBase58()) return rpcError(-32005, "Too many requests");
        const rows = matching(params[0], params[1]?.filters);
        return params[1]?.withContext ? { ...ctx, value: rows } : rows;
      }
      case "getEpochInfo": return { absoluteSlot: 100, blockHeight: 100, epoch: 5, slotIndex: 0, slotsInEpoch: 432_000, transactionCount: 1 };
      case "getBalance": return { ...ctx, value: 10 ** 12 };
      case "getSignaturesForAddress": return [];
      case "getLatestBlockhash": return { ...ctx, value: { blockhash: key().toBase58(), lastValidBlockHeight: 1_000_000 } };
      case "getSlot": return 100;
      case "getBlockHeight": return 100;
      case "getTokenMetadata": return null;
      case "getFeeForMessage": return { ...ctx, value: 5000 };
      // Nothing lands: what the crank tried to run is what the test reads.
      case "simulateTransaction": {
        world.simulated.push(Buffer.from(params[0], "base64"));
        return { ...ctx, value: { err: { InstructionError: [2, { Custom: 1 }] }, unitsConsumed: 1, accounts: null, returnData: null, logs: [] } };
      }
      default: return rpcError(-32601, `not faked: ${method}`);
    }
  });
});
after(async () => { await rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  world.accounts.clear(); world.simulated.length = 0; world.locksDown = false;
  fs.rmSync(path.join(process.env.REFLECT_FACTORY_DIR!, "launches"), { recursive: true, force: true });
});
/** Which vault steps the crank got as far as simulating. */
const tried = (step: keyof typeof ixDisc) => world.simulated.filter((raw) => raw.includes(ixDisc[step])).length;

// ---------- accounts ----------
function mintData(o: { withdraw: PublicKey; mintAuthority?: PublicKey | null; withheld?: bigint; bps?: number }) {
  const d = Buffer.alloc(ACCOUNT_SIZE + 1 + 4 + 108);
  MintLayout.encode({ mintAuthorityOption: o.mintAuthority ? 1 : 0, mintAuthority: o.mintAuthority ?? PublicKey.default, supply: 10n ** 18n, decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, d);
  d[ACCOUNT_SIZE] = 1; // AccountType::Mint
  d.writeUInt16LE(ExtensionType.TransferFeeConfig, ACCOUNT_SIZE + 1);
  d.writeUInt16LE(108, ACCOUNT_SIZE + 3);
  const fee = { epoch: 0n, maximumFee: 2n ** 64n - 1n, transferFeeBasisPoints: o.bps ?? 500 };
  TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: o.withdraw, withheldAmount: o.withheld ?? 0n, olderTransferFee: fee, newerTransferFee: fee }, d, ACCOUNT_SIZE + 5);
  return d;
}
function tokenAccount(addr: PublicKey, mint: PublicKey, owner: PublicKey, program: PublicKey, amount: bigint) {
  const d = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, d);
  put(addr, program, d);
}
function ammConfig(addr: PublicKey, xdex: PublicKey) {
  const d = Buffer.alloc(236);
  CONFIG_DISC.copy(d);
  d.writeBigUInt64LE(2_500n, 12);
  put(addr, xdex, d);
}
/** An XDEX pool of `mint` against wXNT at its real address (or `addr`), with these reserves. */
function pool(mint: PublicKey, reserveToken: bigint, reserveXnt: bigint, o: { amm?: PublicKey; addr?: PublicKey; xdex?: PublicKey; mintProgram?: PublicKey } = {}) {
  const xdex = o.xdex ?? XDEX, amm = o.amm ?? new PublicKey(XDEX_CREATE.testnet.ammConfig), mintProgram = o.mintProgram ?? TOKEN_2022_PROGRAM_ID;
  const a = poolAddresses(xdex, amm, mint);
  const addr = o.addr ?? a.pool;
  ammConfig(amm, xdex);
  const tokenIs0 = a.mint0.equals(mint);
  const vaults = [a.vault0, a.vault1];
  const d = Buffer.alloc(637);
  POOL_DISC.copy(d);
  [amm, key(), a.vault0, a.vault1, a.lpMint, a.mint0, a.mint1, tokenIs0 ? mintProgram : TOKEN_PROGRAM_ID, tokenIs0 ? TOKEN_PROGRAM_ID : mintProgram, a.observation]
    .forEach((k, i) => k.toBuffer().copy(d, 8 + i * 32));
  d[330] = 9;
  d.writeBigUInt64LE(10n ** 15n, 333);
  put(addr, xdex, d);
  tokenAccount(vaults[tokenIs0 ? 0 : 1], mint, a.pool, mintProgram, reserveToken);
  tokenAccount(vaults[tokenIs0 ? 1 : 0], NATIVE_MINT, a.pool, TOKEN_PROGRAM_ID, reserveXnt);
  return addr;
}
/** An lp_locker lock: its account (and schedule, for a timed one) at their real addresses. */
function lock(nft: PublicKey, onPool: PublicKey, locker: PublicKey, lockedLp: bigint, o: { unlockAt?: number; feeLpCollected?: bigint; lockedAt?: number } = {}) {
  const d = Buffer.alloc(178);
  sha8("account:Lock").copy(d);
  [nft, onPool, key(), locker].forEach((k, i) => k.toBuffer().copy(d, 8 + i * 32));
  d.writeBigUInt64LE(lockedLp, 136);
  d.writeBigUInt64LE(lockedLp, 144);
  d.writeBigUInt64LE(o.feeLpCollected ?? 0n, 160);
  d.writeBigInt64LE(BigInt(o.lockedAt ?? Math.floor(Date.now() / 1000) - 100), 168);
  const addr = lockPda(LOCKER, nft);
  put(addr, LOCKER, d);
  if (o.unlockAt) {
    const s = Buffer.alloc(49);
    sha8("account:LockSchedule").copy(s);
    addr.toBuffer().copy(s, 8);
    s.writeBigInt64LE(BigInt(o.unlockAt), 40);
    put(PublicKey.findProgramAddressSync([Buffer.from("schedule"), addr.toBuffer()], LOCKER)[0], LOCKER, s);
  }
}
const SUPPLY = 1_000_000_000n * 10n ** 9n, POOL_XNT = 100n * 10n ** 9n;
const baseVault = (o: { mint: PublicKey; pool: PublicKey; creatorNft: PublicKey; guardian: PublicKey }) => ({
  ...o, rewardMint: key(), rewardSwapPool: key(), publisher: siteKey.publicKey,
  burnBps: 0, lpBps: 2500, creatorBps: 1000,
  pendingTokens: 0n, lpTokens: 0n, sellLp: 0n, sellCreator: 0n, sellHolders: 0n, xntLp: 0n, xntCreator: 0n, holdersFunded: 0n, holdersPaid: 0n,
  listEpoch: 0n, listRoot: Buffer.alloc(32), listTotal: 0n, pendingEpoch: 0n, pendingRoot: Buffer.alloc(32), pendingTotal: 0n, pendingActiveAt: 0,
  totalCollected: 0n, totalBurned: 0n, totalLpTokens: 0n, totalLpXnt: 0n, totalCreatorXnt: 0n, totalCrankRewards: 0n,
  createdAt: 1_780_000_000, bump: 254, authBump: 253, lastSellSlot: 0n, version: 3, cancelsInRow: 0, totalRewardOut: 0n, lastRewardSlot: 0n,
  lastPublishAt: Math.floor(Date.now() / 1000), listCid: Buffer.alloc(33), pendingCid: Buffer.alloc(33), fallbackPaid: 0n, payoutPool: PublicKey.default, xntHolders: 0n,
});
type VaultFields = ReturnType<typeof baseVault>;
const putVault = (f: VaultFields) => put(vaultPda(PROGRAM, f.mint), PROGRAM, encodeVault(f));

const cfg = (): never => ({
  network: "testnet", rpcUrl: "", keypairs: { creator: siteKeyFile, distributor: siteKeyFile }, mint: "",
  token: { name: "T", symbol: "T", uri: "", decimals: 9, supply: "1000000000", feeBps: 500, launchGrace: true },
  locker: { programId: LOCKER.toBase58(), nftUri: "" },
  factory: { feeReceiver: key().toBase58(), feeUsdc: "1", taxVault: { programId: PROGRAM.toBase58(), publisherKeypair: siteKeyFile }, curve: { programId: CURVES.toBase58() } },
  xdex: { programId: XDEX.toBase58(), pool: "" },
  distribution: { minHoldingTokens: "1000", excludeOwners: [], excludeOffCurveOwners: true, operatingReserveXnt: "0.05", minGasXnt: "0.005", minPayoutXnt: "0.001", minCycleXnt: "0.01", maxSellTokensPerCycle: "", maxPriceImpactBps: 300, slippageBps: 100, autoLpBps: 0, transfersPerTx: 18, priorityMicroLamports: 10000 },
}) as never;

/** A launch as the site's steps leave it: mint, pool with the whole supply, all the LP locked by the creator, and the record. */
function launched(o: { lockDays?: number | null; payoutMint?: PublicKey } = {}) {
  const creator = key(), mint = key(), nft = key();
  const reserveToken = SUPPLY * 95n / 100n; // the tax is withheld on the way in
  put(mint, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: vaultAuthPda(PROGRAM, mint) }));
  const launchPool = pool(mint, reserveToken, POOL_XNT);
  const allLp = launch.isqrt(reserveToken * POOL_XNT);
  lock(nft, launchPool, creator, allLp, o.lockDays ? { unlockAt: Math.floor(Date.now() / 1000) + o.lockDays * 86_400 } : {});
  const record = {
    creator: creator.toBase58(), name: "Thin", symbol: "THN", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 0,
    poolTokens: "1000000000", poolXnt: "100", lockDays: o.lockDays ?? null, quote: "XNT", mint: mint.toBase58(), distributor: vaultAuthPda(PROGRAM, mint).toBase58(),
    pool: launchPool.toBase58(), createdAt: new Date().toISOString(), taxVault: true, ...(o.payoutMint ? { payoutMint: o.payoutMint.toBase58() } : {}),
  } as const;
  const vault = baseVault({ mint, pool: launchPool, creatorNft: nft, guardian: creator });
  return { creator, mint, nft, launchPool, allLp, record, vault };
}
const save = (r: { mint: string; [k: string]: unknown }) => {
  const d = path.join(process.env.REFLECT_FACTORY_DIR!, "launches", r.mint);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "launch.json"), JSON.stringify(r));
};
const register = (r: unknown) => launch.registerLaunch(conn(), cfg(), r as never);
const listed = (mint: PublicKey) => fs.existsSync(path.join(process.env.REFLECT_FACTORY_DIR!, "launches", mint.toBase58(), "config.json"));

// ---------- registration ----------
test("a legitimate vault launch registers, its record keeping the vault's own lock", async () => {
  const l = launched();
  putVault(l.vault);
  save(l.record);
  const done = await register(l.record);
  assert.ok(done.registeredAt);
  assert.equal(done.lockNft, l.nft.toBase58());
  assert.ok(listed(l.mint));
});

test("a timed lock (lockDays) still registers", async () => {
  const l = launched({ lockDays: 30 });
  putVault(l.vault);
  save(l.record);
  assert.ok((await register(l.record)).registeredAt);
});

test("a payout-token vault still registers", async () => {
  const payoutMint = key();
  const l = launched({ payoutMint });
  const payoutPool = pool(payoutMint, 10n ** 15n, 10n ** 13n, { mintProgram: TOKEN_PROGRAM_ID });
  putVault({ ...l.vault, payoutPool });
  save(l.record);
  assert.ok((await register(l.record)).registeredAt);
});

test("the finding: a vault on a second, thin pool with 1 raw LP locked isn't listed", async () => {
  const l = launched();
  // The creator's second pool on the other open fee tier, a real lock of 1 raw LP, and their own init_vault naming them.
  const thin = pool(l.mint, 5n * 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER });
  const thinNft = key();
  lock(thinNft, thin, l.creator, 1n);
  putVault({ ...l.vault, pool: thin, creatorNft: thinNft });
  save(l.record);
  await assert.rejects(register(l.record), /sells through a different pool/);
  assert.ok(!listed(l.mint), "nothing was written");
});

test("a wrong pool is refused even with the launch's own lock named", async () => {
  const l = launched();
  putVault({ ...l.vault, pool: pool(l.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER }) });
  save(l.record);
  await assert.rejects(register(l.record), /sells through a different pool/);
});

test("a thin lock on the right pool is refused, though the creator's locks together hold enough", async () => {
  const l = launched();
  const thinNft = key();
  lock(thinNft, l.launchPool, l.creator, 1n);
  putVault({ ...l.vault, creatorNft: thinNft });
  save(l.record);
  await assert.rejects(register(l.record), /whole LP must be locked/);
  assert.ok(!listed(l.mint));
});

test("with an older thin lock around, the record keeps the lock the vault names (the one that holds the LP)", async () => {
  const l = launched();
  lock(key(), l.launchPool, l.creator, 1n, { lockedAt: 1_700_000_000 });
  putVault(l.vault);
  save(l.record);
  assert.equal((await register(l.record)).lockNft, l.nft.toBase58());
});

test("a lock of another pool, or nobody's lock, is refused as the creator NFT", async () => {
  const l = launched();
  const elsewhere = key();
  lock(elsewhere, key(), l.creator, l.allLp);
  putVault({ ...l.vault, creatorNft: elsewhere });
  save(l.record);
  await assert.rejects(register(l.record), /creator NFT isn't the launch's LP lock/);
  putVault({ ...l.vault, creatorNft: key() });
  await assert.rejects(register(l.record), /creator NFT isn't the launch's LP lock/);
});

test("another wallet's full lock on the right pool isn't the launch's lock", async () => {
  const l = launched();
  const theirs = key();
  lock(theirs, l.launchPool, key(), l.allLp);
  putVault({ ...l.vault, creatorNft: theirs });
  save(l.record);
  await assert.rejects(register(l.record), /creator NFT isn't the launch's LP lock/);
});

test("an unreadable lock list or a record with no pool fails closed", async () => {
  const l = launched();
  putVault(l.vault);
  save(l.record);
  await assert.rejects(register({ ...l.record, pool: undefined }), /record has no pool/);
  world.locksDown = true;
  await assert.rejects(register(l.record));
  assert.ok(!listed(l.mint));
  world.locksDown = false;
  world.accounts.set(vaultPda(PROGRAM, l.mint).toBase58(), { owner: PROGRAM.toBase58(), data: Buffer.alloc(10) });
  await assert.rejects(register(l.record), /Not a Vault account/);
});

test("a registered launch whose timed lock has since closed stays fine; one off its recorded NFT doesn't", async () => {
  const l = launched();
  putVault(l.vault);
  save(l.record);
  const done = await register(l.record);
  world.accounts.delete(lockPda(LOCKER, l.nft).toBase58());
  // launchStatus needs some lock of the creator's to call the launch complete: a later one, not the vault's.
  lock(key(), l.launchPool, l.creator, 5n);
  assert.equal((await register(done)).registeredAt, done.registeredAt);
  putVault({ ...l.vault, creatorNft: key() });
  await assert.rejects(register(done), /creator NFT isn't the launch's LP lock/);
});

// ---------- curve tokens ----------
function curveData(mint: PublicKey, creator: PublicKey, curvePool: PublicKey, nft: PublicKey) {
  const d = Buffer.alloc(CURVE_LEN);
  CURVE_DISC.copy(d);
  mint.toBuffer().copy(d, 8);
  creator.toBuffer().copy(d, 40);
  let at = 72 + 8 * 10;
  d[at] = CurveStatus.Graduated; at += 1 + 4 + 8;
  curvePool.toBuffer().copy(d, at); at += 32;
  nft.toBuffer().copy(d, at);
  return d;
}
function graduated() {
  const creator = key(), mint = key(), nft = key();
  const auth = PublicKey.findProgramAddressSync([Buffer.from("auth"), mint.toBuffer()], CURVES)[0];
  put(mint, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: vaultAuthPda(PROGRAM, mint), mintAuthority: auth }));
  const curvePool = pool(mint, 10n ** 17n, 500n * 10n ** 9n);
  lock(nft, curvePool, auth, 10n ** 14n);
  put(curvePda(CURVES, mint), CURVES, curveData(mint, creator, curvePool, nft));
  const record = {
    kind: "curve", creator: creator.toBase58(), name: "Crv", symbol: "CRV", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 0, poolTokens: "200000000", poolXnt: "500",
    lockDays: null, quote: "XNT", mint: mint.toBase58(), distributor: vaultAuthPda(PROGRAM, mint).toBase58(), pool: curvePool.toBase58(), createdAt: new Date().toISOString(), taxVault: true,
    curve: curvePda(CURVES, mint).toBase58(),
  };
  save(record);
  return { creator, mint, nft, curvePool, record, vault: baseVault({ mint, pool: curvePool, creatorNft: nft, guardian: creator }) };
}

test("a curve token registers before its vault exists, or with a vault on the curve's pool and lock", async () => {
  const a = graduated();
  const done = await register(a.record);
  assert.equal(done.lockNft, a.nft.toBase58());
  const b = graduated();
  putVault(b.vault);
  assert.ok((await register(b.record)).registeredAt);
});

test("a curve token whose creator already started a vault elsewhere isn't registered", async () => {
  const a = graduated();
  const thin = pool(a.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER });
  putVault({ ...a.vault, pool: thin });
  await assert.rejects(register(a.record), /sells through a different pool/);
  putVault({ ...a.vault, creatorNft: key() });
  await assert.rejects(register(a.record), /creator NFT isn't the launch's LP lock/);
  assert.ok(!listed(a.mint));
});

// ---------- the crank ----------
const service = (c: ReturnType<typeof conn> = conn()) => vaultService(c, cfg(), { microLamports: 1 }, PROGRAM, c);
/** Enough to sell and to pay the creator: sell buckets, tax waiting, creator XNT, a real reward pool. */
function dueVault(v: VaultFields): VaultFields {
  const rewardMint = key();
  put(rewardMint, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: key(), bps: 0 }));
  const rewardSwapPool = pool(rewardMint, 10n ** 15n, 10n ** 13n);
  return { ...v, sellHolders: 10n ** 16n, xntCreator: 10n ** 9n, rewardMint, rewardSwapPool };
}
const waitingTax = (mint: PublicKey) => put(mint, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: vaultAuthPda(PROGRAM, mint), withheld: 10n ** 15n }));
async function pass(t: TestContext) {
  const logged: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => { logged.push(a.join(" ")); });
  t.mock.method(console, "log", () => {});
  const s = service();
  await s.crankOnce();
  t.mock.restoreAll();
  return { s, logged };
}
const notesOf = async (s: ReturnType<typeof service>, mint: PublicKey) => (await s.badge(mint.toBase58()))?.crank.lastPass?.notes ?? [];

test("the crank collects, sells and pays the creator for a vault on its record", async (t) => {
  const l = launched();
  waitingTax(l.mint);
  putVault(dueVault(l.vault));
  save({ ...l.record, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() });
  const { s } = await pass(t);
  assert.ok(tried("collect") > 0 && tried("sell") > 0 && tried("fund_creator") > 0, (await notesOf(s, l.mint)).join(" | "));
});

test("the crank won't collect or sell for a listed vault on another pool, says so loudly, and still pays the creator", async (t) => {
  const l = launched();
  waitingTax(l.mint);
  const thin = pool(l.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER });
  putVault({ ...dueVault(l.vault), pool: thin, xntLp: 10n ** 9n, lpTokens: 10n ** 12n });
  save({ ...l.record, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() });
  const { s, logged } = await pass(t);
  assert.equal(tried("collect") + tried("sell") + tried("add_liquidity"), 0);
  assert.ok(tried("fund_creator") > 0, "XNT already sold still moves");
  assert.ok(logged.some((x) => /VAULT NOT ON ITS LAUNCH/.test(x) && x.includes(thin.toBase58())));
  assert.ok((await notesOf(s, l.mint)).some((n) => /NOT SELLING/.test(n)));
  const badge = await s.badge(l.mint.toBase58());
  assert.match(badge!.mismatch!, /different pool/);
});

test("a creator NFT off the record stops the creator reward only: sales go on", async (t) => {
  const l = launched();
  putVault({ ...dueVault(l.vault), creatorNft: key() });
  save({ ...l.record, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() });
  const { s } = await pass(t);
  assert.ok(tried("sell") > 0, (await notesOf(s, l.mint)).join(" | "));
  assert.equal(tried("fund_creator"), 0);
  assert.ok((await notesOf(s, l.mint)).some((n) => /NOT PAYING THE CREATOR REWARD/.test(n)));
});

test("a curve vault started after listing: the same check stops the sale where the crank first acts on it", async (t) => {
  const a = graduated();
  const done = await register(a.record);
  const thin = pool(a.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER });
  const thinNft = key();
  lock(thinNft, thin, a.creator, 1n);
  waitingTax(a.mint);
  putVault({ ...dueVault(a.vault), pool: thin, creatorNft: thinNft });
  const { s, logged } = await pass(t);
  assert.equal(tried("collect") + tried("sell") + tried("fund_creator"), 0);
  assert.ok(logged.some((x) => /VAULT NOT ON ITS LAUNCH/.test(x)));
  assert.equal(done.pool, a.curvePool.toBase58());
  assert.ok((await notesOf(s, a.mint)).length >= 2);
});

test("the run-the-vault button leaves out the same steps", async () => {
  const l = launched();
  waitingTax(l.mint);
  const fields = dueVault(l.vault);
  putVault(fields);
  save({ ...l.record, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() });
  const kinds = async () => (await service().crankPlan(l.mint.toBase58(), key())).steps.map((x) => x.kind);
  assert.ok((await kinds()).includes("sell"));
  putVault({ ...fields, pool: pool(l.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER }) });
  const off = await kinds();
  assert.ok(!off.includes("sell") && !off.includes("collect"), off.join());
  assert.ok(off.includes("fund_creator"));
  putVault({ ...fields, creatorNft: key() });
  const noReward = await kinds();
  assert.ok(noReward.includes("sell") && !noReward.includes("fund_creator"), noReward.join());
});

test("the holder-passes round button won't build a round on a vault off its record", async () => {
  const { passesApi } = await import("../src/factory/passes-api.js");
  const { PASS_MODE_OFFSET, passBookPda } = await import("../src/passes.js");
  const l = launched();
  const book = Buffer.alloc(8 + 32 + 8 * 8 + 16 + 112);
  book.writeUInt32LE(1, 8 + 32 + 8 * 8);
  put(passBookPda(PROGRAM, vaultPda(PROGRAM, l.mint)), PROGRAM, book);
  const on = (f: VaultFields) => {
    const d = encodeVault(f);
    d[PASS_MODE_OFFSET] = 1;
    put(vaultPda(PROGRAM, l.mint), PROGRAM, d);
  };
  save({ ...l.record, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() });
  const api = passesApi(conn(), cfg(), PROGRAM, { microLamports: 1 });
  const round = () => api.post(`/api/v4/${l.mint.toBase58()}/round-tx`, { wallet: key().toBase58() });
  on({ ...l.vault, pool: pool(l.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER }) });
  await assert.rejects(round(), /pool isn't the launch's/);
  on(l.vault);
  await round().catch((e) => assert.doesNotMatch(String(e), /pool isn't the launch's/));
});

// TEST's real vault, as read from mainnet in the 2026-10-27 payout audit (slot 88896822); its lock
// holds about 11% of the pool's LP today, so no check on a listed vault may ask for "most of the LP".
const REAL = JSON.parse(fs.readFileSync(path.join(REPO, "audits/payouts/2026-10-27-epoch-755/vault.json"), "utf8"));
const TEST_MINT = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");
const TEST_POOL = "6FszF7uwrujG8vdmxUCyLLAoQMRCUNgoWuebhuzZ6sVn", TEST_NFT = "BsR6qa86A1yaN6RXD8vQrLVXDrtdu4ek1eq82Aadjdqf";
const MAIN_XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const realVault = () => decodeVault(vaultPda(PROGRAM, TEST_MINT), Buffer.from(REAL.dataBase64, "base64"));

test("TEST's real vault bytes: on its known pool and lock, and on the pool a launch makes", () => {
  const v = realVault();
  assert.equal(v.pool.toBase58(), TEST_POOL);
  assert.equal(v.creatorNft.toBase58(), TEST_NFT);
  assert.ok(vaultOnLaunchPool(MAIN_XDEX, "mainnet", v));
  assert.deepEqual(launch.vaultBinding({ pool: TEST_POOL, lockNft: TEST_NFT }, v), { poolWrong: false, nftWrong: false, unverified: [] });
  assert.ok(launch.vaultBinding({ pool: key().toBase58(), lockNft: TEST_NFT }, v).poolWrong);
  assert.ok(!vaultOnLaunchPool(MAIN_XDEX, "mainnet", { mint: v.mint, pool: poolAddresses(MAIN_XDEX, key(), v.mint).pool }));
});

for (const [name, fields] of [["with both fields", { pool: TEST_POOL, lockNft: TEST_NFT }], ["with no lockNft, an older record's shape", { pool: TEST_POOL }], ["with no pool field at all", {}]] as const) {
  test(`a vault shaped like TEST's keeps selling, record ${name}`, async (t) => {
    const creator = new PublicKey("DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n");
    const v = realVault();
    put(TEST_MINT, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: vaultAuthPda(PROGRAM, TEST_MINT) }));
    pool(TEST_MINT, 10n ** 16n, 10n ** 12n, { addr: v.pool, amm: v.pool && new PublicKey(XDEX_CREATE.testnet.ammConfig) });
    const { address: _address, ...rest } = v;
    // No lists in this pass: the real ones would mean reading IPFS.
    put(vaultPda(PROGRAM, TEST_MINT), PROGRAM, encodeVault({ ...rest, sellHolders: 10n ** 13n, version: 3, listEpoch: 0n, listCid: Buffer.alloc(33), pendingEpoch: 0n, pendingCid: Buffer.alloc(33), holdersFunded: 0n, holdersPaid: 0n }));
    save({ creator: creator.toBase58(), name: "TEST", symbol: "TEST", description: "", image: "", supply: "1000000000", taxBps: 500, autoLpBps: 2500, burnBps: 2500, poolTokens: "1", poolXnt: "1", lockDays: null, quote: "XNT",
      mint: TEST_MINT.toBase58(), distributor: vaultAuthPda(PROGRAM, TEST_MINT).toBase58(), createdAt: new Date().toISOString(), registeredAt: new Date().toISOString(), taxVault: true, ...fields });
    const { s, logged } = await pass(t);
    assert.ok(tried("sell") > 0, "still sells");
    assert.ok(!logged.some((x) => /VAULT NOT ON ITS LAUNCH/.test(x)));
    const notes = await notesOf(s, TEST_MINT);
    assert.equal(notes.some((n) => /not in the launch record/.test(n)), Object.keys(fields).length < 2);
  });
}

// ---------- the scripts, as real processes ----------
function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", path.join(REPO, script), ...args], { cwd: REPO, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}
const crankKey = path.join(dir, "crank-key.json");
fs.writeFileSync(crankKey, JSON.stringify([...Keypair.generate().secretKey]));
const standalone = (extra: string[] = []) => runScript("scripts/crank.ts", ["--rpc", rpc.url, "--keypair", crankKey, "--all", "--network", "testnet", "--program", PROGRAM.toBase58(), ...extra]);

test("scripts/crank.ts --all skips sales for a vault off the pool a launch makes, unless told otherwise", async () => {
  const l = launched();
  waitingTax(l.mint);
  putVault({ ...dueVault(l.vault), pool: pool(l.mint, 10n ** 15n, 10n ** 12n, { amm: OTHER_TIER }) });
  const off = await standalone();
  assert.match(off.out, /NOT SELLING/);
  assert.equal(tried("collect") + tried("sell"), 0, off.out);
  assert.ok(tried("fund_creator") > 0, off.out);
  world.simulated.length = 0;
  const forced = await standalone(["--allow-other-pool"]);
  assert.doesNotMatch(forced.out, /NOT SELLING/);
  assert.ok(tried("sell") > 0, forced.out);
});

test("scripts/crank.ts --all sells for a vault on the launch pool", async () => {
  const l = launched();
  putVault(dueVault(l.vault));
  const on = await standalone();
  assert.doesNotMatch(on.out, /NOT SELLING/);
  assert.ok(tried("sell") > 0, on.out);
});

test("scripts/migrate-to-vault.ts refuses a config that disagrees with the launch record, before anything is built", async () => {
  const l = launched();
  const distributor = Keypair.generate();
  put(l.mint, TOKEN_2022_PROGRAM_ID, mintData({ withdraw: distributor.publicKey }));
  const record = { ...l.record, distributor: distributor.publicKey.toBase58(), taxVault: undefined, registeredAt: new Date().toISOString(), lockNft: l.nft.toBase58() };
  save(record);
  const launchDir = path.join(process.env.REFLECT_FACTORY_DIR!, "launches", l.mint.toBase58());
  fs.writeFileSync(path.join(launchDir, "distributor.json"), JSON.stringify([...distributor.secretKey]));
  const main = path.join(dir, "migrate-config.json");
  fs.writeFileSync(main, JSON.stringify({ ...(cfg() as object), rpcUrl: rpc.url }));
  const tokenCfg = (poolAddr: PublicKey, nft: PublicKey) => fs.writeFileSync(path.join(launchDir, "config.json"), JSON.stringify({ xdex: { pool: poolAddr.toBase58() }, creatorReward: { nftMint: nft.toBase58() }, distribution: {} }));
  const run = () => runScript("scripts/migrate-to-vault.ts", [l.mint.toBase58()], { REFLECT_CONFIG: main });
  tokenCfg(pool(l.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER }), l.nft);
  const wrongPool = await run();
  assert.equal(wrongPool.code, 1, wrongPool.out);
  assert.match(wrongPool.out, /Refusing: the config's pool .* isn't the launch record's/);
  tokenCfg(l.launchPool, key());
  const wrongNft = await run();
  assert.equal(wrongNft.code, 1, wrongNft.out);
  assert.match(wrongNft.out, /Refusing: the config's lock NFT .* isn't the launch record's/);
  assert.equal(world.simulated.length, 0);
});

test("scripts/check-vault-bindings.ts lists what differs and exits 1, and is quiet about what doesn't", async () => {
  const good = launched(), bad = launched(), old = launched();
  putVault(good.vault); putVault(old.vault);
  const thin = pool(bad.mint, 10n ** 15n, 10n ** 8n, { amm: OTHER_TIER });
  putVault({ ...bad.vault, pool: thin });
  const at = { registeredAt: new Date().toISOString() };
  save({ ...good.record, ...at, lockNft: good.nft.toBase58() });
  const run = () => runScript("scripts/check-vault-bindings.ts", ["--rpc", rpc.url, "--program", PROGRAM.toBase58()]);
  assert.equal((await run()).code, 0);
  save({ ...old.record, ...at });
  save({ ...bad.record, ...at, lockNft: bad.nft.toBase58() });
  const r = await run();
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes(`POOL DIFFERS: vault ${thin.toBase58()}, record ${bad.launchPool.toBase58()}`), r.out);
  assert.match(r.out, /not in the record, so not compared: creator NFT/);
  assert.match(r.out, /3 registered, 0 with no vault, 1 off their record/);
});

