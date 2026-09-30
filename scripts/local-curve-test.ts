/**
 * End-to-end test of the bonding_curve program against a LOCAL validator that clones
 * testnet XDEX, its pool config and lp_locker (nothing is sent to testnet or mainnet):
 *
 *   solana-test-validator --reset --ledger <scratch>/curve-ledger --rpc-port 8999 \
 *     --faucet-port 9990 --gossip-port 8990 --dynamic-port-range 8991-9020 \
 *     --url https://rpc.testnet.x1.xyz \
 *     --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --clone-upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY \
 *     --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --bpf-program CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY lp-locker/target/curve2-test/bonding_curve.so
 *   LOCAL_RPC=http://127.0.0.1:8999 npx tsx scripts/local-curve-test.ts
 *
 * The program must be built with `--features "testnet short-windows"` (5 s anti-snipe window),
 * from the source with selectable graduation targets (create_curve(supply, target)); the
 * curve here graduates at the default 500 XNT. scripts/local-curve-targets-test.ts covers
 * the other targets and the upgrade over curves made by the first (fixed 20 XNT) program.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction, createSetAuthorityInstruction,
  getAccount, getAssociatedTokenAddressSync, getMint, getMintLen, getTokenMetadata, getTransferFeeAmount,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { buildSell, poolAddresses, quoteSell, poolAuthority } from "../src/xdex.js";

const conn = new Connection(process.env.LOCAL_RPC ?? "http://127.0.0.1:8999", "confirmed");
const PROGRAM = new PublicKey("CiMeZV1RqSskr9RR7Xj2FDHnMHuuoL7Dc5a4dzD89FTY");
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const AMM_CONFIG = new PublicKey("3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY");
const CREATE_POOL_FEE = new PublicKey("DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS");
const FEE_RECEIVER = new PublicKey("53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy");
const GRADUATION_DEPOSIT = 300_000_000n, GRADUATE_REWARD = 10_000_000n;
const TARGET_WHOLE = 500n, TARGET_XNT = TARGET_WHOLE * 10n ** 9n;
const SNIPE_WINDOW_SECS = 5;
const TAX_BPS = 500;
const SUPPLY_WHOLE = 1_000_000_000n;
const S = SUPPLY_WHOLE * 10n ** 9n;
const U64_MAX = 2n ** 64n - 1n;
const xnt = (l: bigint | number) => (Number(l) / 1e9).toFixed(6);
const ok = (s: string) => console.log(`  ✓ ${s}`);

// ---------- Program client (mirrors docs/bonding-curve-spec.md) ----------

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const pda = (seeds: Buffer[], program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const curvePda = (mint: PublicKey) => pda([Buffer.from("curve"), mint.toBuffer()]);
const authPda = (mint: PublicKey) => pda([Buffer.from("auth"), mint.toBuffer()]);
const posPda = (curve: PublicKey, owner: PublicKey) => pda([Buffer.from("pos"), curve.toBuffer(), owner.toBuffer()]);
const nftPda = (curve: PublicKey) => pda([Buffer.from("nft"), curve.toBuffer()]);
const u64 = (...v: bigint[]) => { const b = Buffer.alloc(8 * v.length); v.forEach((x, i) => b.writeBigUInt64LE(x, 8 * i)); return b; };
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const ix = (name: string, keys: ReturnType<typeof m>[], args: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([disc(`global:${name}`), args]) });

const createCurveIx = (creator: PublicKey, mint: PublicKey, supplyWhole: bigint, targetWhole = TARGET_WHOLE) => ix("create_curve", [
  m(creator, true, true), m(mint, false, true), m(curvePda(mint), false, true), m(authPda(mint), false, true), m(SystemProgram.programId, false, false),
], u64(supplyWhole, targetWhole));
const buyIx = (buyer: PublicKey, mint: PublicKey, xntIn: bigint, minOut: bigint) => {
  const curve = curvePda(mint);
  return ix("buy", [
    m(buyer, true, true), m(curve, false, true), m(authPda(mint), false, true), m(posPda(curve, buyer), false, true),
    m(FEE_RECEIVER, false, true), m(SystemProgram.programId, false, false),
  ], u64(xntIn, minOut));
};
const sellIx = (seller: PublicKey, mint: PublicKey, tokensIn: bigint, minOut: bigint) => {
  const curve = curvePda(mint);
  return ix("sell", [
    m(seller, true, true), m(curve, false, true), m(authPda(mint), false, true), m(posPda(curve, seller), false, true),
    m(FEE_RECEIVER, false, true), m(SystemProgram.programId, false, false),
  ], u64(tokensIn, minOut));
};
function graduatePoolIx(caller: PublicKey, mint: PublicKey) {
  const auth = authPda(mint);
  const a = poolAddresses(XDEX, AMM_CONFIG, mint);
  return ix("graduate_pool", [
    m(caller, true, true), m(curvePda(mint), false, true), m(auth, false, true), m(mint, false, true),
    m(getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID), false, true),
    m(getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID), false, true),
    m(getAssociatedTokenAddressSync(a.lpMint, auth, true, TOKEN_PROGRAM_ID), false, true),
    m(XDEX, false, false), m(AMM_CONFIG, false, false), m(poolAuthority(XDEX), false, false),
    m(a.pool, false, true), m(a.lpMint, false, true), m(a.vault0, false, true), m(a.vault1, false, true),
    m(CREATE_POOL_FEE, false, true), m(a.observation, false, true), m(NATIVE_MINT, false, false),
    m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false), m(SYSVAR_RENT_PUBKEY, false, false),
  ]);
}
function graduateLockIx(caller: PublicKey, mint: PublicKey, creator: PublicKey) {
  const auth = authPda(mint), curve = curvePda(mint), nft = nftPda(curve);
  const a = poolAddresses(XDEX, AMM_CONFIG, mint);
  const lock = pda([Buffer.from("lock"), nft.toBuffer()], LOCKER);
  return ix("graduate_lock", [
    m(caller, true, true), m(curve, false, true), m(auth, false, true), m(creator, false, true), m(nft, false, true),
    m(getAssociatedTokenAddressSync(nft, auth, true, TOKEN_2022_PROGRAM_ID), false, true),
    m(getAssociatedTokenAddressSync(nft, creator, true, TOKEN_2022_PROGRAM_ID), false, true),
    m(a.pool, false, false), m(a.vault0, false, false), m(a.vault1, false, false), m(a.lpMint, false, false),
    m(getAssociatedTokenAddressSync(a.lpMint, auth, true, TOKEN_PROGRAM_ID), false, true),
    m(lock, false, true), m(pda([Buffer.from("vault"), lock.toBuffer()], LOCKER), false, true), m(LOCKER, false, false),
    m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    m(SystemProgram.programId, false, false),
  ]);
}
const deliverIx = (payer: PublicKey, mint: PublicKey, owner: PublicKey, creator: PublicKey) => {
  const curve = curvePda(mint);
  return ix("deliver", [
    m(payer, true, true), m(curve, false, true), m(authPda(mint), false, true), m(posPda(curve, owner), false, true),
    m(owner, false, true), m(getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID), false, true),
    m(mint, false, true), m(creator, false, true),
    m(TOKEN_2022_PROGRAM_ID, false, false), m(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), m(SystemProgram.programId, false, false),
  ]);
};

interface Curve {
  mint: PublicKey; creator: PublicKey; supply: bigint; curveTokens: bigint; poolTokensGross: bigint; poolTokensNet: bigint;
  targetXnt: bigint; virtualXnt: bigint; virtualTokens: bigint; tokensSold: bigint; raisedXnt: bigint; createdAt: bigint;
  status: number; positions: number; delivered: bigint; pool: PublicKey; lockNft: PublicKey; taxBps: number;
}
async function readCurve(mint: PublicKey): Promise<Curve> {
  const info = await conn.getAccountInfo(curvePda(mint), "confirmed");
  assert.ok(info && info.owner.equals(PROGRAM), "curve account");
  const d = info.data;
  assert.ok(d.subarray(0, 8).equals(disc("account:Curve")));
  const k = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const n = (o: number) => d.readBigUInt64LE(o);
  return {
    mint: k(8), creator: k(40), supply: n(72), curveTokens: n(80), poolTokensGross: n(88), poolTokensNet: n(96),
    targetXnt: n(104), virtualXnt: n(112), virtualTokens: n(120), tokensSold: n(128), raisedXnt: n(136),
    createdAt: d.readBigInt64LE(144), status: d[152], positions: d.readUInt32LE(153), delivered: n(157),
    pool: k(165), lockNft: k(197), taxBps: d.readUInt16LE(229),
  };
}
async function readPosition(curve: PublicKey, owner: PublicKey) {
  const info = await conn.getAccountInfo(posPda(curve, owner), "confirmed");
  if (!info) return null;
  const d = info.data;
  return { balance: d.readBigUInt64LE(72), deposit: d.readBigUInt64LE(80), lamports: BigInt(info.lamports) };
}

// Curve maths mirror (for quotes and expectations).
const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
const k0 = (c: Curve) => (c.virtualXnt - c.raisedXnt) * (c.virtualTokens + c.tokensSold);
function quoteBuy(c: Curve, xntIn: bigint) {
  let fee = ceil(xntIn * 100n, 10_000n), net = xntIn - fee;
  let out = c.virtualTokens - ceil(k0(c), c.virtualXnt + net);
  let complete = false;
  if (c.tokensSold + out >= c.curveTokens) {
    out = c.curveTokens - c.tokensSold;
    net = ceil(k0(c), c.virtualTokens - out) - c.virtualXnt;
    xntIn = ceil(net * 10_000n, 9_900n); fee = xntIn - net; complete = true;
  }
  return { xntIn, fee, net, out, complete };
}
function quoteSellCurve(c: Curve, tokensIn: bigint) {
  const x1 = ceil(k0(c), c.virtualTokens + tokensIn);
  const gross = c.virtualXnt - x1, fee = ceil(gross * 100n, 10_000n);
  return { gross, fee, out: gross - fee };
}

// ---------- Helpers ----------

const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));
async function fund(k: PublicKey, sol: number) {
  await conn.confirmTransaction(await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL), "confirmed");
}
async function send(ixs: TransactionInstruction[], signers: Keypair[], cu?: number) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
async function txStats(sig: string) {
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { cu: t?.meta?.computeUnitsConsumed ?? 0, fee: BigInt(t?.meta?.fee ?? 0), logs: t?.meta?.logMessages ?? [] };
}
function txSize(ixs: TransactionInstruction[], payer: PublicKey, signers: number, cu?: number) {
  const tx = new Transaction();
  if (cu) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = PublicKey.default.toBase58();
  return tx.serializeMessage().length + 1 + 64 * signers;
}
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-1200)}`);
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

/** Token-2022 tax token like buildTokenStep, but the mint authority ends at the curve's auth and nothing is minted. */
async function mintIxs(creator: PublicKey, mintKp: Keypair, distributor: PublicKey, name: string, symbol: string) {
  const mint = mintKp.publicKey;
  const uri = `https://example.invalid/meta/${mint.toBase58()}.json`;
  const metadata: TokenMetadata = { mint, name, symbol, uri, updateAuthority: creator, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length);
  return [
    SystemProgram.createAccount({ fromPubkey: creator, newAccountPubkey: mint, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint, creator, mint, TOKEN_2022_PROGRAM_ID),
    createInitializeTransferFeeConfigInstruction(mint, null, distributor, TAX_BPS, U64_MAX, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint, 9, creator, null, TOKEN_2022_PROGRAM_ID),
    // Token metadata needs the mint authority's signature, so the creator is the mint
    // authority until the metadata exists, then hands it to the curve's auth PDA.
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID, metadata: mint, updateAuthority: creator, mint, mintAuthority: creator, name, symbol, uri,
    }),
    createSetAuthorityInstruction(mint, creator, AuthorityType.MintTokens, authPda(mint), [], TOKEN_2022_PROGRAM_ID),
  ];
}

// ---------- Test ----------

console.log("bonding_curve end-to-end (local validator)");
const creator = Keypair.generate(), attacker = Keypair.generate(), crank = Keypair.generate();
const buyers = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
await Promise.all([creator, attacker, crank].map((k) => fund(k.publicKey, 20)));
for (const b of buyers) await fund(b.publicKey, 1_000);
await fund(FEE_RECEIVER, 1); // exists on the real networks; on a fresh local ledger it must exist to take small fees

console.log("1. Create the token and the curve");
const mintKp = Keypair.generate(), mint = mintKp.publicKey, distributor = Keypair.generate().publicKey;
const curveKey = curvePda(mint), auth = authPda(mint);
await send(await mintIxs(creator.publicKey, mintKp, distributor, "Curve Test", "CURV"), [creator, mintKp]);
const mintState = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
assert.ok(mintState.mintAuthority?.equals(auth) && mintState.supply === 0n && mintState.freezeAuthority === null);
ok(`mint ${mint.toBase58()} (5% tax, mint authority = auth, supply 0)`);
await fails("someone else opens a curve on the creator's mint", send([createCurveIx(attacker.publicKey, mint, SUPPLY_WHOLE)], [attacker]), /BadMint/);
await fails("supply below 1,000", send([createCurveIx(creator.publicKey, mint, 999n)], [creator]), /BadSupply/);
// The testnet build (what this runs against) also takes 10 and 20 XNT; everything else is refused.
for (const t of [0n, 9n, 11n, 19n, 21n, 499n, 501n, 20_000n]) {
  await fails(`graduation target ${t} XNT`, send([createCurveIx(creator.publicKey, mint, SUPPLY_WHOLE, t)], [creator]), /BadTarget/);
}
await send([createCurveIx(creator.publicKey, mint, SUPPLY_WHOLE)], [creator]);
let c = await readCurve(mint);
assert.equal(c.supply, S); assert.equal(c.curveTokens, S * 8000n / 10000n); assert.equal(c.status, 0); assert.equal(c.taxBps, TAX_BPS);
assert.equal(c.targetXnt, TARGET_XNT, "the chosen target is stored");
assert.equal(await bal(auth), GRADUATION_DEPOSIT);
const X0 = c.virtualXnt, Y0 = c.virtualTokens, K0 = X0 * Y0;
ok(`curve created: T=${c.curveTokens / 10n ** 9n} Pn=${c.poolTokensNet / 10n ** 9n} x0=${xnt(X0)} y0=${Y0 / 10n ** 9n}; auth holds the 0.3 deposit`);
{
  // The whole launch (mint + metadata + hand-over + create_curve) also fits in one transaction.
  const kp = Keypair.generate();
  const all = [...(await mintIxs(creator.publicKey, kp, distributor, "A Much Longer Token Name 32 char", "LONGSYMBOL")), createCurveIx(creator.publicKey, kp.publicKey, 10_000_000_000n)];
  const size = txSize(all, creator.publicKey, 2);
  const sig = await send(all, [creator, kp]);
  ok(`one-transaction launch works too (${size} bytes, ${(await txStats(sig)).cu} CU)`);
}

console.log("2. Trading rules");
{
  // The testnet build lets the creator buy (for testing); mainnet builds refuse it with CreatorCannotBuy.
  // Simulated only, so the curve's state below is unchanged.
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: creator.publicKey, recentBlockhash: blockhash }).add(buyIx(creator.publicKey, mint, 100_000_000n, 0n));
  tx.sign(creator);
  const sim = await conn.simulateTransaction(tx);
  assert.equal(sim.value.err, null, `creator buy should simulate OK on the testnet build: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}`);
  ok("creator can buy on their own curve (testnet build; mainnet refuses)");
}
await fails("early buy over 1% of supply", send([buyIx(buyers[0].publicKey, mint, 5_000_000_000n, 0n)], [buyers[0]]), /TooBigEarly/);
await fails("zero buy", send([buyIx(buyers[0].publicKey, mint, 0n, 0n)], [buyers[0]]), /ZeroAmount/);

// Invariants after every trade.
const tracked = new Set<string>();
const byKey = new Map(buyers.map((b) => [b.publicKey.toBase58(), b]));
async function checkInvariants(label: string) {
  c = await readCurve(mint);
  let deposits = 0n, balances = 0n, open = 0;
  for (const k of tracked) {
    const p = await readPosition(curveKey, new PublicKey(k));
    if (!p) continue;
    deposits += p.deposit; balances += p.balance; open++;
  }
  const a = await bal(auth);
  assert.equal(open, c.positions, `${label}: positions`);
  assert.equal(balances, c.tokensSold, `${label}: position balances == tokens_sold`);
  assert.equal(c.virtualTokens + c.tokensSold, Y0, `${label}: y + sold == y0`);
  assert.equal(c.virtualXnt - c.raisedXnt, X0, `${label}: x - raised == x0`);
  assert.ok(c.virtualXnt * c.virtualTokens >= K0, `${label}: x*y >= k0`);
  assert.equal(a, GRADUATION_DEPOSIT + c.raisedXnt + deposits, `${label}: auth lamports == deposit + raised + position deposits`);
}
async function buy(b: Keypair, xntIn: bigint, slip = 0n) {
  const before = await readCurve(mint);
  const q = quoteBuy(before, xntIn);
  const fr0 = await bal(FEE_RECEIVER);
  await send([buyIx(b.publicKey, mint, xntIn, q.out - (q.out * slip) / 10_000n)], [b]);
  tracked.add(b.publicKey.toBase58());
  assert.equal((await bal(FEE_RECEIVER)) - fr0, q.fee, "fee receiver got exactly the 1% fee");
  await checkInvariants("buy");
  return q;
}
async function sell(b: Keypair, tokens: bigint) {
  const q = quoteSellCurve(await readCurve(mint), tokens);
  const before = await bal(b.publicKey);
  const sig = await send([sellIx(b.publicKey, mint, tokens, q.out)], [b]);
  const { fee } = await txStats(sig);
  assert.equal((await bal(b.publicKey)) - before + fee, q.out, "seller received exactly the quoted XNT");
  await checkInvariants("sell");
  return q;
}

const small = await buy(buyers[0], 30_000_000n);
ok(`early small buy allowed: ${small.out / 10n ** 9n} tokens for 0.03 XNT`);
const wait = Number(c.createdAt) + SNIPE_WINDOW_SECS + 1;
while ((await chainTime()) < BigInt(wait)) await sleep(500);
const big = await buy(buyers[0], 5_000_000_000n);
ok(`after the ${SNIPE_WINDOW_SECS}s window the same 5 XNT buy goes through (${big.out / 10n ** 9n} tokens)`);

console.log("3. Many buys and sells by several wallets (invariants checked after each)");
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
let trades = 0;
while (c.raisedXnt < (TARGET_XNT * 85n) / 100n) {
  const b = buyers[Math.floor(rnd() * buyers.length)];
  const p = await readPosition(curveKey, b.publicKey);
  if (p && p.balance > 0n && rnd() < 0.3) {
    await sell(b, (p.balance * BigInt(Math.floor(rnd() * 90) + 10)) / 100n);
  } else {
    await buy(b, BigInt(Math.floor((5 + rnd() * 45) * 1e9)), 50n); // 1-10% of the target
  }
  trades++;
}
// One wallet sells out completely (its position stays open with balance 0 until delivery).
const outSeller = buyers[3];
const p3 = await readPosition(curveKey, outSeller.publicKey);
if (p3 && p3.balance > 0n) { await sell(outSeller, p3.balance); trades++; }
ok(`${trades} trades; raised ${xnt(c.raisedXnt)} XNT, sold ${c.tokensSold / 10n ** 9n} tokens; auth == 0.3 + raised + deposits, x*y >= k0 every time`);

console.log("4. Slippage and balance checks");
{
  const q = quoteBuy(c, 1_000_000_000n);
  await fails("buy with min_tokens_out above the quote", send([buyIx(buyers[1].publicKey, mint, 1_000_000_000n, q.out + 1n)], [buyers[1]]), /Slippage/);
  const p = (await readPosition(curveKey, buyers[1].publicKey))!;
  const s = quoteSellCurve(c, p.balance / 2n);
  await fails("sell with min_xnt_out above the quote", send([sellIx(buyers[1].publicKey, mint, p.balance / 2n, s.out + 1n)], [buyers[1]]), /Slippage/);
  await fails("sell more than the position holds", send([sellIx(buyers[1].publicKey, mint, p.balance + 1n, 0n)], [buyers[1]]), /InsufficientBalance/);
  await fails("sell from someone else's position", send([sellIx(attacker.publicKey, mint, 1n, 0n)], [attacker]), /AccountNotInitialized|3012/);
}

console.log("5. The last buy fills exactly to T");
{
  c = await readCurve(mint);
  const last = buyers[2];
  const offer = TARGET_XNT / 2n;
  const q = quoteBuy(c, offer);
  assert.ok(q.complete);
  const before = await bal(last.publicKey);
  const hadPos = !!(await readPosition(curveKey, last.publicKey));
  const sig = await send([buyIx(last.publicKey, mint, offer, q.out)], [last]);
  tracked.add(last.publicKey.toBase58());
  const { fee } = await txStats(sig);
  await checkInvariants("final buy");
  assert.equal(c.status, 1, "status Complete");
  assert.equal(c.tokensSold, c.curveTokens, "tokens_sold == T");
  assert.equal(c.virtualTokens, Y0 - c.curveTokens);
  assert.ok(hadPos, "final buyer already had a position");
  assert.equal(before - (await bal(last.publicKey)) - fee, q.xntIn, "final buyer paid only what the fill cost");
  assert.ok(c.raisedXnt <= TARGET_XNT && TARGET_XNT - c.raisedXnt < 10n, `raised ${c.raisedXnt}`);
  ok(`offered ${xnt(offer)} XNT, paid ${xnt(q.xntIn)} for the last ${q.out / 10n ** 9n} tokens; status Complete, raised ${xnt(c.raisedXnt)} (target ${xnt(TARGET_XNT)})`);
}
await fails("buy after Complete", send([buyIx(buyers[0].publicKey, mint, 100_000_000n, 0n)], [buyers[0]]), /NotTrading/);
await fails("sell after Complete", send([sellIx(buyers[0].publicKey, mint, 1n, 0n)], [buyers[0]]), /NotTrading/);
await fails("deliver before graduation", send([deliverIx(crank.publicKey, mint, buyers[0].publicKey, creator.publicKey)], [crank]), /WrongStatus/);
await fails("graduate_lock before the pool", send([graduateLockIx(crank.publicKey, mint, creator.publicKey)], [crank], 1_400_000), /WrongStatus|WrongAccount/);
const finalPrice = { x: c.virtualXnt, y: c.virtualTokens };

console.log("6. Graduate: pool");
const pa = poolAddresses(XDEX, AMM_CONFIG, mint);
const gpIxs = [graduatePoolIx(crank.publicKey, mint)];
const gpSize = txSize(gpIxs, crank.publicKey, 1, 1_400_000);
const authBeforePool = await bal(auth);
const gpSig = await send(gpIxs, [crank], 1_400_000);
const gp = await txStats(gpSig);
c = await readCurve(mint);
assert.equal(c.status, 2); assert.ok(c.pool.equals(pa.pool));
const poolInfo = await conn.getAccountInfo(pa.pool, "confirmed");
assert.ok(poolInfo?.owner.equals(XDEX));
const [v0, v1] = await Promise.all([pa.vault0, pa.vault1].map((v, i) =>
  getAccount(conn, v, "confirmed", pa.mint0.equals(mint) === (i === 0) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)));
const tokenVault = pa.mint0.equals(mint) ? v0 : v1, xntVault = pa.mint0.equals(mint) ? v1 : v0;
assert.equal(xntVault.amount, TARGET_XNT, "pool got TARGET_XNT");
assert.equal(tokenVault.amount, c.poolTokensNet, "pool token vault got exactly pool_tokens_net");
assert.equal(await conn.getAccountInfo(getAssociatedTokenAddressSync(NATIVE_MINT, auth, true, TOKEN_PROGRAM_ID)), null, "auth's wXNT account closed");
assert.equal(await conn.getAccountInfo(getAssociatedTokenAddressSync(mint, auth, true, TOKEN_2022_PROGRAM_ID)), null, "auth's token account closed");
ok(`pool ${pa.pool.toBase58()} created: ${xnt(xntVault.amount)} XNT + ${tokenVault.amount / 10n ** 9n} tokens (${gp.cu} CU, ${gpSize} bytes; auth spent ${xnt(authBeforePool - TARGET_XNT - (await bal(auth)))} on pool fee + rents)`);
await fails("graduate_pool twice", send(gpIxs, [crank], 1_400_000), /WrongStatus/);

console.log("7. Graduate: lock");
{
  const bad = graduateLockIx(crank.publicKey, mint, attacker.publicKey);
  await fails("graduate_lock with the wrong creator", send([bad], [crank], 1_400_000), /WrongAccount/);
}
const glIxs = [graduateLockIx(crank.publicKey, mint, creator.publicKey)];
const glSize = txSize(glIxs, crank.publicKey, 1, 1_400_000);
const crankBefore = await bal(crank.publicKey);
const authBeforeLock = await bal(auth);
const glSig = await send(glIxs, [crank], 1_400_000);
const gl = await txStats(glSig);
c = await readCurve(mint);
const nft = nftPda(curveKey);
assert.equal(c.status, 3); assert.ok(c.lockNft.equals(nft));
const lockAddr = pda([Buffer.from("lock"), nft.toBuffer()], LOCKER);
const lockInfo = await conn.getAccountInfo(lockAddr, "confirmed");
assert.ok(lockInfo?.owner.equals(LOCKER), "lock exists in lp_locker");
const lockData = lockInfo!.data;
assert.ok(new PublicKey(lockData.subarray(40, 72)).equals(pa.pool), "lock is for our pool");
assert.ok(new PublicKey(lockData.subarray(104, 136)).equals(auth), "locker recorded = auth");
const lockVault = await getAccount(conn, pda([Buffer.from("vault"), lockAddr.toBuffer()], LOCKER), "confirmed", TOKEN_PROGRAM_ID);
assert.ok(lockVault.amount > 0n);
const creatorNft = await getAccount(conn, getAssociatedTokenAddressSync(nft, creator.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID);
assert.equal(creatorNft.amount, 1n, "creator holds the lock NFT");
const nftMint = await getMint(conn, nft, "confirmed", TOKEN_2022_PROGRAM_ID);
assert.equal(nftMint.supply, 1n); assert.equal(nftMint.mintAuthority, null);
const md = await getTokenMetadata(conn, nft, "confirmed", TOKEN_2022_PROGRAM_ID);
assert.ok(md?.updateAuthority?.equals(creator.publicKey) && md.name === "99 + Tax LP Lock" && md.symbol === "LPLOCK");
assert.equal((await bal(crank.publicKey)) - crankBefore + gl.fee, GRADUATE_REWARD, "caller got the reward");
ok(`LP ${lockVault.amount} locked forever (lock ${lockAddr.toBase58().slice(0, 8)}…), NFT held by the creator, metadata update authority = creator`);
ok(`caller got ${xnt(GRADUATE_REWARD)} XNT (${gl.cu} CU, ${glSize} bytes; auth spent ${xnt(authBeforeLock - (await bal(auth)))} incl. reward)`);
await fails("graduate_lock twice", send(glIxs, [crank], 1_400_000), /WrongStatus/);

console.log("8. Deliver every position");
// One buyer creates their token account first: they get the whole deposit back.
const preMade = buyers[1];
await send([createAssociatedTokenAccountIdempotentInstruction(preMade.publicKey,
  getAssociatedTokenAddressSync(mint, preMade.publicKey, false, TOKEN_2022_PROGRAM_ID), preMade.publicKey, mint, TOKEN_2022_PROGRAM_ID)], [preMade]);
const creatorBeforeEnd = await bal(creator.publicKey);
const expectedAtEnd = await bal(auth);
const positions = await conn.getProgramAccounts(PROGRAM, { commitment: "confirmed", filters: [{ dataSize: 89 }, { memcmp: { offset: 8, bytes: curveKey.toBase58() } }] });
assert.equal(positions.length, c.positions);
let deliveredTotal = 0n, refundedTotal = 0n, depositsTotal = 0n;
for (const { pubkey, account } of positions) {
  const owner = new PublicKey(account.data.subarray(40, 72));
  const balance = account.data.readBigUInt64LE(72), deposit = account.data.readBigUInt64LE(80);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const hadAta = !!(await conn.getAccountInfo(ata, "confirmed"));
  const ownerBefore = await bal(owner);
  await send([deliverIx(crank.publicKey, mint, owner, creator.publicKey)], [crank]);
  assert.equal(await conn.getAccountInfo(pubkey, "confirmed"), null, "position closed");
  const got = (await bal(owner)) - ownerBefore - BigInt(account.lamports);
  if (balance > 0n) {
    const t = await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.equal(t.amount, balance, "tokens delivered");
  }
  if (hadAta || balance === 0n) assert.equal(got, deposit, "whole deposit refunded");
  else assert.equal(got, 0n, "deposit exactly paid for the new token account");
  deliveredTotal += balance; refundedTotal += got; depositsTotal += deposit;
  const who = byKey.get(owner.toBase58()) ? `buyer${buyers.indexOf(byKey.get(owner.toBase58())!)}` : owner.toBase58();
  ok(`${who}: ${balance / 10n ** 9n} tokens delivered, refund ${xnt(got)} + position rent ${xnt(account.lamports)}${hadAta ? " (had a token account)" : ""}`);
}
c = await readCurve(mint);
const finalMint = await getMint(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
assert.equal(c.status, 4, "status Finished");
assert.equal(c.positions, 0); assert.equal(deliveredTotal, c.curveTokens); assert.equal(c.delivered, c.curveTokens);
assert.equal(finalMint.mintAuthority, null, "mint authority revoked");
assert.equal(finalMint.supply, S, "total supply == S exactly");
assert.equal(await bal(auth), 0n, "auth emptied");
const creatorGot = (await bal(creator.publicKey)) - creatorBeforeEnd;
assert.equal(creatorGot, expectedAtEnd - depositsTotal, "creator got everything but the deposits (refunds + new token accounts)");
ok(`all ${positions.length} positions delivered; supply ${finalMint.supply / 10n ** 9n} == S, mint authority None, status Finished`);
ok(`leftover ${xnt(creatorGot)} XNT went to the creator; auth is empty (of the 0.3 deposit, ${xnt(GRADUATION_DEPOSIT - creatorGot)} went to pool fee, rents and reward)`);
await fails("deliver after Finished", send([deliverIx(crank.publicKey, mint, buyers[0].publicKey, creator.publicKey)], [crank]), /AccountNotInitialized|WrongStatus|3012/);

console.log("9. Pool opening price vs curve final price");
{
  const curvePrice = Number(finalPrice.x) / Number(finalPrice.y);
  const tv = await getAccount(conn, tokenVault.address, "confirmed", TOKEN_2022_PROGRAM_ID);
  const xv = await getAccount(conn, xntVault.address, "confirmed", TOKEN_PROGRAM_ID);
  const d = poolInfo!.data;
  const side = pa.mint0.equals(mint) ? 0 : 1;
  const fees = (s: number) => d.readBigUInt64LE(341 + 8 * s) + d.readBigUInt64LE(357 + 8 * s);
  const poolPrice = Number(xv.amount - fees(1 - side)) / Number(tv.amount - fees(side));
  const diff = Math.abs(poolPrice - curvePrice) / curvePrice;
  assert.ok(diff < 1e-6, `price mismatch ${diff}`);
  ok(`curve ends at ${curvePrice.toExponential(6)} XNT/token, pool opens at ${poolPrice.toExponential(6)} (diff ${(diff * 100).toExponential(2)}%)`);
}

console.log("10. Real XDEX swap of a delivered token");
{
  const seller = buyers[0];
  const src = getAssociatedTokenAddressSync(mint, seller.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const have = (await getAccount(conn, src, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const amount = have / 10n;
  const withheld0 = getTransferFeeAmount(await getAccount(conn, tokenVault.address, "confirmed", TOKEN_2022_PROGRAM_ID))?.withheldAmount ?? 0n;
  let q = null;
  for (let i = 0; i < 20 && !q; i++) {
    try { q = await quoteSell(conn, XDEX, pa.pool, mint, amount, { maxImpactBps: 5000, slippageBps: 100 }); }
    catch (e) { if (!String(e).includes("not open yet")) throw e; await sleep(1000); }
  }
  assert.ok(q, "sell quote");
  const before = await bal(seller.publicKey);
  const sig = await send(await buildSell(conn, XDEX, seller, mint, q), [seller]);
  const { fee } = await txStats(sig);
  const withheld1 = getTransferFeeAmount(await getAccount(conn, tokenVault.address, "confirmed", TOKEN_2022_PROGRAM_ID))!.withheldAmount;
  const expectedFee = (q.amountIn * BigInt(TAX_BPS) + 9_999n) / 10_000n;
  assert.equal(withheld1 - withheld0, expectedFee, "5% transfer fee withheld in the pool vault");
  const got = (await bal(seller.publicKey)) - before + fee;
  assert.ok(got >= q.minimumOut, "swap paid out");
  ok(`sold ${q.amountIn / 10n ** 9n} tokens on XDEX for ${xnt(got)} XNT; ${expectedFee / 10n ** 9n} tokens (5%) withheld as tax in the vault`);
}

console.log(`\nCompute: graduate_pool ${gp.cu} CU (${gpSize} bytes), graduate_lock ${gl.cu} CU (${glSize} bytes).`);
console.log("All bonding-curve checks passed.");
