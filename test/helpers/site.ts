/**
 * The real factory server (src/factory-server.ts, as its own process) on throwaway directories,
 * against a stand-in RPC with no network: for what only shows with the server's own hooks
 * running, and for killing it and starting it again.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { AccountLayout, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

/** The RPC methods the server calls while starting and launching, answered from `accounts`. */
export function fakeRpc(feeMint: PublicKey) {
  const mintData = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  const tokenData = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: feeMint, owner: PublicKey.default, amount: 5_000_000n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tokenData);
  const account = (data: Buffer, owner = TOKEN_PROGRAM_ID.toBase58()) => ({ data: [data.toString("base64"), "base64"], executable: false, lamports: 1_000_000, owner, rentEpoch: 0, space: data.length });
  const onChain = new Set<string>();
  const calls: Record<string, number> = {};
  const held = new Map<string, () => void>();
  const down = new Set<string>();
  const lookup = (k: string) => {
    if (k === feeMint.toBase58()) return account(mintData);
    if (onChain.has(k)) return account(Buffer.alloc(0));
    return null;
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const { id, method, params } = JSON.parse(body);
      calls[method] = (calls[method] ?? 0) + 1;
      if (down.has(method)) { res.statusCode = 500; res.end("down"); return; }
      const hold = held.get(method);
      if (hold) { held.delete(method); hold(); await new Promise<void>((r) => { holdReleases.push(r); }); }
      const ctx = { context: { slot: 1, apiVersion: "1.18" } };
      const value = (v: unknown) => ({ ...ctx, value: v });
      let result: unknown = null;
      switch (method) {
        case "getLatestBlockhash": result = value({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000_000 }); break;
        case "getMinimumBalanceForRentExemption": result = 1_000_000; break;
        case "getBalance": result = value(1_000_000_000_000); break;
        case "getAccountInfo": {
          const k = params[0] as string;
          // Everything else the builder asks of the creator's fee account: a funded token account.
          result = value(lookup(k) ?? (fundedTokenAccounts.has(k) ? account(tokenData) : null));
          break;
        }
        case "getMultipleAccounts": result = value((params[0] as string[]).map((k) => lookup(k))); break;
        case "getTokenAccountBalance": result = value({ amount: "5000000", decimals: 6, uiAmount: 5, uiAmountString: "5" }); break;
        case "simulateTransaction": result = value({ err: null, logs: [], unitsConsumed: 1000, accounts: null, returnData: null }); break;
        case "getProgramAccounts": result = []; break;
        case "getSignaturesForAddress": result = []; break;
        case "getBlockHeight": result = 1; break;
        case "getSlot": result = 1; break;
        case "getEpochInfo": result = { absoluteSlot: 1, blockHeight: 1, epoch: 1, slotIndex: 1, slotsInEpoch: 100 }; break;
        case "sendTransaction": {
          // The transaction lands: the accounts it creates (its co-signers) now exist.
          const raw = Buffer.from(params[0] as string, "base64");
          const msg = VersionedTransaction.deserialize(raw).message;
          for (const k of msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures)) onChain.add(k.toBase58());
          result = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
          break;
        }
        case "getSignatureStatuses": result = value((params[0] as string[]).map(() => ({ slot: 1, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: "confirmed" }))); break;
        default: {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `not faked: ${method}` } }));
          return;
        }
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  const fundedTokenAccounts = new Set<string>();
  const holdReleases: (() => void)[] = [];
  return {
    server, onChain, calls, fundedTokenAccounts, down,
    /** The next call of `method` waits until `release()`; `arrived` resolves when it comes in. */
    hold(method: string) {
      let arrived = () => {};
      const reached = new Promise<void>((r) => { arrived = r; });
      held.set(method, arrived);
      return { reached, release: () => { for (const r of holdReleases.splice(0)) r(); } };
    },
    async listen() { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; },
    close() { return new Promise((r) => { server.closeAllConnections(); server.close(r); }); },
  };
}

const freePort = () => new Promise<number>((resolve) => {
  const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

export async function startSite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-site-test-"));
  const factoryDir = path.join(dir, "factory"), stateDir = path.join(dir, "state");
  fs.mkdirSync(factoryDir); fs.mkdirSync(stateDir);
  const feeMint = Keypair.generate().publicKey, feeReceiver = Keypair.generate().publicKey;
  const rpc = fakeRpc(feeMint);
  const rpcUrl = await rpc.listen();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = {
    network: "testnet", rpcUrl, keypairs: { creator: path.join(dir, "none.json"), distributor: path.join(dir, "none.json") },
    token: { name: "T", symbol: "T", uri: "", decimals: 9, supply: "1000000000", feeBps: 500, launchGrace: true }, mint: "",
    locker: { programId: Keypair.generate().publicKey.toBase58(), nftUri: "" },
    factory: { feeReceiver: feeReceiver.toBase58(), feeUsdc: "1", gasXnt: "0.05", port, publicUrl: origin, hosts: [], feeToken: { mint: feeMint.toBase58(), symbol: "TST", amount: "1" } },
    xdex: { programId: "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf", pool: "" },
    distribution: { minHoldingTokens: "1000", excludeOwners: [], excludeOffCurveOwners: true, operatingReserveXnt: "0.05", minGasXnt: "0.005", minPayoutXnt: "0.001", minCycleXnt: "0.01", maxSellTokensPerCycle: "", maxPriceImpactBps: 300, slippageBps: 100, autoLpBps: 4000, transfersPerTx: 18, priorityMicroLamports: 10000 },
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));

  let child = null as ChildProcess | null;
  let output = "";
  async function boot() {
    child = spawn(process.execPath, ["--import", "tsx", "--import", path.join(ROOT, "test", "helpers", "clock-preload.mjs"), path.join(ROOT, "src", "factory-server.ts")], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_FACTORY_DIR: factoryDir, REFLECT_STATE_DIR: stateDir, REFLECT_RPC_URL: rpcUrl, REFLECT_RPC_GAP_MS: "0", PINATA_JWT: "", NODE_TEST_CONTEXT: "" },
    });
    const c = child;
    c.stdout!.on("data", (d) => { output += d; });
    c.stderr!.on("data", (d) => { output += d; });
    for (let i = 0; i < 300; i++) {
      if (c.exitCode !== null) throw new Error(`server exited: ${output.slice(-2000)}`);
      try { await fetch(`${origin}/llms.txt`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error(`server didn't start: ${output.slice(-2000)}`);
  }
  await boot();

  const creator = Keypair.generate();
  /** A request from a visitor's address (X-Forwarded-For is believed from this machine, as from the proxy). */
  const call = (p: string, { ip, body }: { ip?: string; body?: unknown } = {}) => fetch(`${origin}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(ip ? { "x-forwarded-for": ip } : {}), ...(body === undefined ? {} : { origin, "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const launchParams = (who = creator.publicKey) => ({
    creator: who.toBase58(), name: "Pending", symbol: "PEND", description: "", image: "", supply: "1000000000", taxBps: 500,
    autoLpBps: 2500, burnBps: 0, poolTokens: "1000000000", poolXnt: "1", lockDays: null, quote: "XNT",
  });
  /** Step 1 through the real endpoint. */
  async function startLaunch(who: Keypair = creator) {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    rpc.fundedTokenAccounts.add(getAssociatedTokenAddressSync(feeMint, who.publicKey, false, TOKEN_PROGRAM_ID).toBase58());
    return call("/api/launch/token", { body: launchParams(who.publicKey) });
  }
  /** What the creator's wallet does with step 1: sign what the server co-signed. */
  const walletSign = (b64: string, who: Keypair = creator) => {
    const tx = Transaction.from(Buffer.from(b64, "base64"));
    tx.partialSign(who);
    return tx.serialize().toString("base64");
  };
  return {
    dir, factoryDir, rpc, origin, creator, call, startLaunch, walletSign, boot,
    log: () => output,
    launchFile: (mint: string, f: string) => path.join(factoryDir, "launches", mint, f),
    journalFile: (mint: string, f: string) => path.join(factoryDir, "pending-launches", mint, f),
    /** The server's clock moves 31 s on (test/helpers/clock-preload.mjs). */
    async skipClock() { child!.kill("SIGUSR2"); await new Promise((r) => setTimeout(r, 100)); },
    async ensureUp() { if (child?.exitCode !== null || child?.signalCode !== null) await boot(); },
    /** As a crash or `kill -9`: no handler of the server's runs. */
    kill() {
      const c = child!;
      return new Promise<void>((resolve) => { c.once("exit", () => resolve()); c.kill("SIGKILL"); });
    },
    async stop() {
      if (child && child.exitCode === null && child.signalCode === null) await this.kill();
      await rpc.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
