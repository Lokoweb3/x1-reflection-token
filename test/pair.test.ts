/**
 * Pools paired with another token than XNT (JACK): pool addresses, the pool-creation,
 * swap and deposit encoders for both pair kinds, swap parsing and launch validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  XDEX_CREATE, buildCreatePool, buildDepositAndBurn, buildSell, poolAddresses, spotValue, type DepositQuote, type Pool, type SellQuote,
} from "../src/xdex.js";
import { parseSwap } from "../src/trades.js";
import { XNT_PAIR, pairOf, validateParams } from "../src/factory/launch.js";
import type { Config } from "../src/config.js";

const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
const JACK = new PublicKey("54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg");
const MAINNET_CFG = new PublicKey(XDEX_CREATE.mainnet.ammConfig);
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);

test("pool addresses match the real mainnet JACK/XNT pool", () => {
  const a = poolAddresses(XDEX, MAINNET_CFG, JACK, NATIVE_MINT);
  assert.equal(a.pool.toBase58(), "wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW");
  assert.equal(a.lpMint.toBase58(), "Cc3GywVrwCFvpYeJQGU86a79sRxvNuPnq9DTdWjFK7x2");
  assert.equal(a.vault0.toBase58(), "Hh2rTiqoUUBRHr6y1qrjsdFQxoUs92tmWixwoJdcVwTm");
  assert.equal(a.vault1.toBase58(), "5fEAiBUSjmURAuAeLYoEq4Rk5rf9KWXZMdsLRmwSWL3H");
  assert.equal(a.observation.toBase58(), "DKGsNPi3q3o1wRa7TTDgAGpt1j2b3ftxg9a8g8NF3iog");
  // The default pair is XNT, so existing callers are unchanged.
  assert.ok(poolAddresses(XDEX, MAINNET_CFG, JACK).pool.equals(a.pool));
});

test("a TOKEN/JACK pool sorts its two mints the way XDEX does", () => {
  for (let i = 0; i < 20; i++) {
    const mint = Keypair.generate().publicKey;
    const a = poolAddresses(XDEX, MAINNET_CFG, mint, JACK);
    assert.ok(Buffer.compare(a.mint0.toBuffer(), a.mint1.toBuffer()) < 0);
    assert.deepEqual(new Set([a.mint0.toBase58(), a.mint1.toBase58()]), new Set([mint.toBase58(), JACK.toBase58()]));
    assert.ok(!a.pool.equals(poolAddresses(XDEX, MAINNET_CFG, mint).pool), "a JACK pool is a different pool from the XNT one");
  }
});

test("creating a TOKEN/XNT pool wraps XNT; a TOKEN/JACK pool uses the creator's JACK", () => {
  const creator = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const xntPool = buildCreatePool(XDEX, "mainnet", creator, mint, 1000n, 5n);
  assert.equal(xntPool.ixs.length, 4); // wXNT account, transfer, sync, initialize
  const wxnt = getAssociatedTokenAddressSync(NATIVE_MINT, creator, false, TOKEN_PROGRAM_ID);
  assert.ok(xntPool.ixs[1].programId.equals(SystemProgram.programId));
  const initX = xntPool.ixs[3];
  assert.ok(initX.keys.some((k) => k.pubkey.equals(wxnt)));

  const jackPool = buildCreatePool(XDEX, "mainnet", creator, mint, 1000n, 7n, JACK, TOKEN_2022_PROGRAM_ID);
  assert.equal(jackPool.ixs.length, 1, "no wrapping for a JACK pool");
  const init = jackPool.ixs[0];
  const a = poolAddresses(XDEX, MAINNET_CFG, mint, JACK);
  assert.ok(jackPool.pool.equals(a.pool));
  const tokenIs0 = a.mint0.equals(mint);
  // Amounts follow the mint order.
  assert.equal(u64(init.data, 8), tokenIs0 ? 1000n : 7n);
  assert.equal(u64(init.data, 16), tokenIs0 ? 7n : 1000n);
  const jackAcc = getAssociatedTokenAddressSync(JACK, creator, false, TOKEN_2022_PROGRAM_ID);
  const tokenAcc = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
  assert.ok(init.keys[7].pubkey.equals(tokenIs0 ? tokenAcc : jackAcc));
  assert.ok(init.keys[8].pubkey.equals(tokenIs0 ? jackAcc : tokenAcc));
  // Both sides are Token-2022; the LP mint program stays SPL Token; the pool fee account is XDEX's.
  assert.ok(init.keys[14].pubkey.equals(TOKEN_PROGRAM_ID));
  assert.ok(init.keys[15].pubkey.equals(TOKEN_2022_PROGRAM_ID) && init.keys[16].pubkey.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(init.keys[12].pubkey.toBase58(), XDEX_CREATE.mainnet.createPoolFee);
  assert.throws(() => buildCreatePool(XDEX, "mainnet", creator, mint, 1n, 1n, NATIVE_MINT, TOKEN_2022_PROGRAM_ID));
});

/** A fake pool: our token on `side`, the pair (`quote`, owned by `quoteProgram`) on the other. */
function fakePool(mint: PublicKey, quote: PublicKey, quoteProgram: PublicKey, side: 0 | 1): Pool {
  const k = () => Keypair.generate().publicKey;
  const mints: [PublicKey, PublicKey] = side === 0 ? [mint, quote] : [quote, mint];
  const programs: [PublicKey, PublicKey] = side === 0 ? [TOKEN_2022_PROGRAM_ID, quoteProgram] : [quoteProgram, TOKEN_2022_PROGRAM_ID];
  return { address: k(), ammConfig: MAINNET_CFG, vaults: [k(), k()], mints, programs, observation: k(), lpMint: k(), lpSupply: 1000n,
    lpDecimals: 9, depositsPaused: false, protocolFees: [0n, 0n], fundFees: [0n, 0n] };
}
const fakeConn = (lpOwner = TOKEN_PROGRAM_ID) => ({
  getAccountInfo: async (a: PublicKey) => (lpOwnerFor.has(a.toBase58()) ? { owner: lpOwner } : null),
  getMinimumBalanceForRentExemption: async () => 2_039_280,
}) as unknown as Connection;
const lpOwnerFor = new Set<string>();

test("selling for XNT unwraps through a temporary account; selling for JACK goes to the JACK account", async () => {
  const owner = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  for (const side of [0, 1] as const) {
    const pool = fakePool(mint, NATIVE_MINT, TOKEN_PROGRAM_ID, side);
    const q: SellQuote = { pool, side, amountIn: 500n, transferFee: 25n, expectedOut: 40n, minimumOut: 39n, priceImpactBps: 10n };
    const ixs = await buildSell(fakeConn(), XDEX, owner, mint, q);
    assert.equal(ixs.length, 4); // create temp, init, swap, close
    const swap = ixs[2];
    assert.equal(u64(swap.data, 8), 500n); assert.equal(u64(swap.data, 16), 39n);
    assert.ok(swap.keys[4].pubkey.equals(getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID)));
    assert.ok(swap.keys[10].pubkey.equals(mint) && swap.keys[11].pubkey.equals(NATIVE_MINT));
    assert.ok(swap.keys[8].pubkey.equals(TOKEN_2022_PROGRAM_ID) && swap.keys[9].pubkey.equals(TOKEN_PROGRAM_ID));

    const jp = fakePool(mint, JACK, TOKEN_2022_PROGRAM_ID, side);
    const jq: SellQuote = { ...q, pool: jp };
    const jix = await buildSell(fakeConn(), XDEX, owner, mint, jq);
    assert.equal(jix.length, 2); // JACK account (idempotent), swap
    const jackAta = getAssociatedTokenAddressSync(JACK, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    assert.ok(jix[1].keys[5].pubkey.equals(jackAta));
    assert.ok(jix[1].keys[6].pubkey.equals(jp.vaults[side]) && jix[1].keys[7].pubkey.equals(jp.vaults[1 - side]));
    assert.ok(jix[1].keys[10].pubkey.equals(mint) && jix[1].keys[11].pubkey.equals(JACK));
    // The distributor's JACK -> XNT swap: JACK is the input side of the JACK/XNT pool.
    const xp = fakePool(JACK, NATIVE_MINT, TOKEN_PROGRAM_ID, side);
    const xix = await buildSell(fakeConn(), XDEX, owner, JACK, { ...q, pool: xp });
    assert.equal(xix.length, 4);
    assert.ok(xix[2].keys[4].pubkey.equals(jackAta));
    await assert.rejects(buildSell(fakeConn(), XDEX, owner, mint, { ...q, pool: xp }), /another mint/);
  }
});

test("a JACK deposit takes JACK from the owner's account, in mint order, and burns the LP", async () => {
  const owner = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  for (const side of [0, 1] as const) {
    const pool = fakePool(mint, JACK, TOKEN_2022_PROGRAM_ID, side);
    lpOwnerFor.add(pool.lpMint.toBase58());
    const q: DepositQuote = { pool, side, lp: 77n, tokenIn: 1050n, quoteIn: 20n, maxTokens: 1100n, maxQuote: 22n };
    const ixs = await buildDepositAndBurn(fakeConn(), XDEX, owner, mint, q);
    assert.equal(ixs.length, 3); // LP account, deposit, burn
    const dep = ixs[1];
    const jackAta = getAssociatedTokenAddressSync(JACK, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const tokenAta = getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    assert.equal(u64(dep.data, 8), 77n);
    assert.equal(u64(dep.data, 16), side === 0 ? 1100n : 22n);
    assert.equal(u64(dep.data, 24), side === 0 ? 22n : 1100n);
    assert.ok(dep.keys[4].pubkey.equals(side === 0 ? tokenAta : jackAta));
    assert.ok(dep.keys[5].pubkey.equals(side === 0 ? jackAta : tokenAta));

    const xpool = fakePool(mint, NATIVE_MINT, TOKEN_PROGRAM_ID, side);
    lpOwnerFor.add(xpool.lpMint.toBase58());
    const xixs = await buildDepositAndBurn(fakeConn(), XDEX, owner, mint, { ...q, pool: xpool });
    assert.equal(xixs.length, 6, "XNT deposit keeps its temporary wrapped account"); // temp, init, LP account, deposit, burn, close
  }
});

test("spotValue prices the token side in the pair", () => {
  // 1256 XNT : 1.49 JACK -> 1 JACK ≈ 843 XNT.
  const s = { reserveToken: 1_490_000_000n, reserveQuote: 1_256_000_000_000n };
  assert.equal(spotValue(1_000_000_000n, s) / 1_000_000_000n, 842n);
  assert.equal(spotValue(0n, s), 0n);
});

/** A minimal confirmed swap transaction for parseSwap. */
function swapTx(wallet: PublicKey, balances: { mint: string; pre: bigint; post: bigint }[], lamports: [number, number], fee = 5000) {
  const tb = (which: "pre" | "post") => balances.map((b, i) => ({ accountIndex: i + 1, mint: b.mint, owner: wallet.toBase58(), uiTokenAmount: { amount: String(b[which]) } }));
  return {
    meta: { err: null, fee, logMessages: ["Program log: Instruction: SwapBaseInput"], preBalances: [lamports[0]], postBalances: [lamports[1]],
      preTokenBalances: tb("pre"), postTokenBalances: tb("post"), loadedAddresses: { writable: [], readonly: [] } },
    transaction: { message: { getAccountKeys: () => ({ get: () => wallet }) } },
  } as unknown as VersionedTransactionResponse;
}

test("parseSwap reads the JACK change for a JACK-paired token", () => {
  const w = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey.toBase58();
  // Bought 100 tokens for 0.002 JACK; lamports only paid the network fee.
  const buy = swapTx(w, [{ mint, pre: 0n, post: 100n }, { mint: JACK.toBase58(), pre: 5_000_000n, post: 3_000_000n }], [1_000_000_000, 999_995_000]);
  assert.deepEqual(parseSwap(buy, mint, JACK.toBase58()), { wallet: w.toBase58(), tokens: "100", xnt: "-2000000" });
  // The same transaction read as an XNT pair sees no XNT move (only the fee).
  assert.equal(parseSwap(buy, mint)?.xnt, "0");
  // A routed swap (XNT -> JACK -> token in one transaction): no JACK change, so no price.
  const routed = swapTx(w, [{ mint, pre: 0n, post: 100n }], [1_000_000_000, 900_000_000]);
  assert.deepEqual(parseSwap(routed, mint, JACK.toBase58()), { wallet: w.toBase58(), tokens: "100", xnt: "0", kind: "unpriced" });
});

test("launch pair: XNT by default, only offered pairs, and pool amounts per pair", () => {
  const ok = {
    creator: "53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy", name: "My Token", symbol: "MYT", description: "", image: "",
    supply: "1000000000", taxBps: 500, autoLpBps: 2500, poolTokens: "1000000000", poolXnt: "5", lockDays: null,
  };
  assert.equal(validateParams(ok).quote, "XNT");
  assert.equal(validateParams({ ...ok, quote: "JACK", poolXnt: "0.012" }, ["JACK"]).quote, "JACK");
  assert.throws(() => validateParams({ ...ok, quote: "JACK", poolXnt: "0.012" }), /isn't a pair/);
  assert.throws(() => validateParams({ ...ok, quote: "BONK" }, ["JACK"]), /isn't a pair/);
  assert.throws(() => validateParams({ ...ok, quote: "JACK", poolXnt: "0" }, ["JACK"]));
  assert.throws(() => validateParams({ ...ok, quote: "JACK", poolXnt: "0.0000000001" }, ["JACK"]));
  assert.throws(() => validateParams({ ...ok, poolXnt: "0.001" }), /at least 0.01/);

  const cfg = { factory: { quoteTokens: [{ symbol: "JACK", mint: JACK.toBase58(), xntPool: "wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW" }] } } as unknown as Config;
  assert.equal(pairOf(cfg, {}), XNT_PAIR);
  assert.equal(pairOf(cfg, { quote: "XNT" }), XNT_PAIR);
  assert.ok(pairOf(cfg, { quote: "JACK" }).mint.equals(JACK));
  // A recorded launch keeps its own pair even if the allowlist drops it later.
  const rec = { quote: "JACK", quoteMint: JACK.toBase58(), quoteXntPool: "wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW" };
  assert.ok(pairOf({ factory: {} } as unknown as Config, rec).xntPool!.equals(new PublicKey(rec.quoteXntPool)));
  assert.throws(() => pairOf({ factory: {} } as unknown as Config, { quote: "JACK" }));
});
