import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, type TransferFeeConfig } from "@solana/spl-token";
import { createPeg, referencePrice, sizeFor, USDC_X, type PegSpec } from "../src/peg.js";
import type { Pool, Snapshot } from "../src/xdex.js";

// Maths and checks only: no network, no funds.
const key = () => Keypair.generate().publicKey;
const noFee = { transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 } } as unknown as TransferFeeConfig;
/** A GOOGL.X/USDC.X pool: `g` GOOGL.X (8 decimals) against `u` USDC.X (6 decimals), 0.28% fee, as the token side sees it. */
function pool(g: number, u: number, side: "token" | "quote"): Snapshot {
  const p = { address: key(), mints: [key(), USDC_X], programs: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID] } as unknown as Pool;
  const G = BigInt(Math.round(g * 1e8)), U = BigInt(Math.round(u * 1e6));
  return side === "token"
    ? { pool: p, side: 0, quoteMint: USDC_X, reserveToken: G, reserveQuote: U, tradeFeeRate: 2800n, feeCfg: noFee, epoch: 1n }
    : { pool: p, side: 1, quoteMint: p.mints[0], reserveToken: U, reserveQuote: G, tradeFeeRate: 2800n, feeCfg: noFee, epoch: 1n };
}

test("a sell is sized to land the pool on the target price, no further", () => {
  const s = pool(0.75, 0.75 * 363.5, "token"); // $363.50
  const r = sizeFor(s, (rIn, rOut) => (Number(rOut) / 1e6) / (Number(rIn) / 1e8) <= 345);
  const after = (Number(s.reserveQuote - r.out) / 1e6) / (Number(s.reserveToken + r.net) / 1e8);
  assert.ok(after <= 345 && after > 344.99, `lands at $${after}`);
  assert.ok(Math.abs(Number(r.amountIn) / 1e8 - 0.0196) < 0.0005, `sells ${Number(r.amountIn) / 1e8} GOOGL.X (the hand-worked 0.01958)`);
});

test("a buy is sized to lift the pool up to the target price", () => {
  const s = pool(0.75, 0.75 * 340, "quote"); // $340, USDC.X going in
  const r = sizeFor(s, (rIn, rOut) => (Number(rIn) / 1e6) / (Number(rOut) / 1e8) >= 351.6);
  const after = (Number(s.reserveToken + r.net) / 1e6) / (Number(s.reserveQuote - r.out) / 1e8);
  assert.ok(after >= 351.6 && after < 351.61, `lands at $${after}`);
});

test("no reference price (sources down, stale or disagreeing) means no trade, and nothing is read from the chain", async () => {
  const spec: PegSpec = { mint: key(), ticker: "GOOGL", coingeckoId: "x", solanaMint: "y", pool: key(), quoteMint: USDC_X };
  let sent = 0;
  const peg = createPeg(spec, { conn: new Connection("http://127.0.0.1:1"), xdex: key(), owner: key(), send: async () => { sent++; return "sig"; },
    log: () => {}, alert: async () => {}, stateDir: os.tmpdir(), execute: true, fetchPrice: async () => ({ error: "sources disagree" }) });
  assert.equal(await peg.check(), "no reference");
  assert.equal(sent, 0);
});

test("the reference needs CoinGecko and Jupiter within 1% of each other", async () => {
  const spec: PegSpec = { mint: key(), ticker: "GOOGL", coingeckoId: "alphabet-xstock", solanaMint: "XsMint", pool: key(), quoteMint: USDC_X };
  const real = globalThis.fetch;
  const reply = (cg: number, jup: number) => (async (url: string | URL) => new Response(JSON.stringify(String(url).includes("coingecko")
    ? { "alphabet-xstock": { usd: cg, last_updated_at: Math.floor(Date.now() / 1000) } } : { XsMint: { usdPrice: jup } }))) as typeof fetch;
  try {
    globalThis.fetch = reply(351.94, 351.3);
    const ok = await referencePrice(spec);
    assert.ok("price" in ok && Math.abs(ok.price - 351.62) < 0.01);
    globalThis.fetch = reply(351.94, 340);
    const bad = await referencePrice(spec);
    assert.ok("error" in bad && /disagree/.test(bad.error));
  } finally { globalThis.fetch = real; }
});
