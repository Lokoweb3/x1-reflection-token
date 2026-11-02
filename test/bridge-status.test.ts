// The real bridge scripts, in --status mode, as real processes against a local modelled RPC. --status signs and sends
// nothing. The key is a throwaway generated here. The journal is one pending entry, so reconcile runs its real path. What
// isn't covered: the bridge API and the later stages of a transfer, and anything about a real node's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { mockRpc, rpcError, type RpcHandler } from "./helpers/mock-rpc.js";

const root = path.join(import.meta.dirname, "..");
const signature = bs58.encode(Buffer.alloc(64, 3)), outgoing = Keypair.generate().publicKey.toBase58();
const sentAtSec = Math.floor(Date.now() / 1000) - 3_600;

const ctx = (slot: number, value: unknown) => ({ context: { slot }, value });
function chain(over: Record<string, () => unknown> = {}): RpcHandler {
  const base: Record<string, () => unknown> = {
    getSignatureStatuses: () => ctx(510, [null]),
    getSlot: () => 500,
    getBlock: () => ({ blockhash: "x", previousBlockhash: "y", parentSlot: 499, blockTime: sentAtSec, blockHeight: 200 }),
    getSignaturesForAddress: () => [{ signature: bs58.encode(Buffer.alloc(64, 4)), slot: 1, blockTime: sentAtSec - 3600, err: null, memo: null, confirmationStatus: "finalized" }],
    getAccountInfo: () => ctx(505, null),
  };
  return (m) => ({ ...base, ...over })[m]?.();
}
const behind = () => rpcError(-32016, "Minimum context slot has not been reached");

async function runStatus(script: string, statusField: string, handler: RpcHandler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-status-"));
  const wallet = Keypair.generate(), keypair = path.join(dir, "throwaway.json");
  fs.writeFileSync(keypair, JSON.stringify([...wallet.secretKey]));
  const journal = path.join(dir, script === "bridge-usdc" ? "bridge-usdc.json" : "bridge-stock.json");
  const entry = { signature, wallet: wallet.publicKey.toBase58(), amountRaw: "1000000", feeRaw: "0", feeBps: 0, symbol: "GOOGL", x1Mint: outgoing, decimals: 8,
    status: statusField, createdAt: new Date(sentAtSec * 1000).toISOString(), lastValidBlockHeight: 100, outgoing };
  fs.writeFileSync(journal, JSON.stringify({ entries: [entry] }));
  const rpc = await mockRpc(handler);
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const c = spawn(process.execPath, ["--import", "tsx", path.join(root, "scripts", `${script}.ts`), "--status", "--keypair", keypair],
      { env: { ...process.env, REFLECT_RPC_URL: rpc.url, SOLANA_RPC_URL: rpc.url, REFLECT_STATE_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    c.stdout.on("data", (d) => { text += d; });
    c.stderr.on("data", (d) => { text += d; });
    c.on("exit", (code) => resolve({ code, text }));
  });
  await rpc.close();
  return { ...out, status: JSON.parse(fs.readFileSync(journal, "utf8")).entries[0].status as string };
}

for (const [script, pending] of [["bridge-usdc", "pending_x1"], ["bridge-stock", "pending_solana"]] as const) {
  test(`${script}: a lagging node can't mark moved funds failed; proof can`, async () => {
    const lagging = await runStatus(script, pending, chain({ getAccountInfo: behind, getSignaturesForAddress: behind }));
    assert.equal(lagging.code, 0, lagging.text);
    assert.equal(lagging.status, pending, lagging.text);
    assert.match(lagging.text, /still on its way/);
    assert.match(lagging.text, /It blocks the next transfer/, "and it says why, for a person");

    const marker = await runStatus(script, pending, chain({ getAccountInfo: () => ctx(505, { lamports: 1, owner: Keypair.generate().publicKey.toBase58(), data: ["", "base64"], executable: false, rentEpoch: 0, space: 0 }) }));
    assert.equal(marker.status, pending, marker.text);
    assert.match(marker.text, /tokens were taken/);

    const short = await runStatus(script, pending, chain({ getSignaturesForAddress: () => [] }));
    assert.equal(short.status, pending, short.text);

    const proven = await runStatus(script, pending, chain());
    assert.equal(proven.status, "failed", proven.text);
    assert.match(proven.text, /never landed/);
  });
}
