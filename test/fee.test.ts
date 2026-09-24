import { test } from "node:test";
import assert from "node:assert/strict";
import { FEE_USDC, launchFee } from "../src/factory/launch.js";
import type { Config } from "../src/config.js";

const XNM = { mint: "AvNDf423kEmWNP6AZHFV7DkNG4YRgt6qbdyyryjaa4PQ", symbol: "XNM", amount: "1" };
const cfgFor = (network: "mainnet" | "testnet", feeToken?: typeof XNM) =>
  ({ network, factory: { feeReceiver: "x", feeUsdc: "1", feeToken } }) as unknown as Config;

test("mainnet always charges USDC.X, even with a feeToken override left in config", () => {
  for (const override of [undefined, XNM]) {
    const fee = launchFee(cfgFor("mainnet", override));
    assert.equal(fee.mint, "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
    assert.equal(fee.mint, FEE_USDC.mainnet);
    assert.equal(fee.symbol, "USDC");
    assert.equal(fee.amount, "1");
  }
});

test("testnet uses the feeToken override when set, else testnet USDC", () => {
  assert.deepEqual(launchFee(cfgFor("testnet", XNM)), XNM);
  const fee = launchFee(cfgFor("testnet"));
  assert.equal(fee.mint, FEE_USDC.testnet);
  assert.equal(fee.symbol, "USDC");
});
