/**
 * Local dashboard for distributions, payouts and locked liquidity.
 *
 *   npm run dashboard                   # http://127.0.0.1:8123
 *   npm run dashboard -- --port 9000
 *
 * Combines the distributor's activity log (state/events.jsonl) and payout state with
 * live on-chain data. It binds to localhost only, because it shows every holder's
 * balance and payouts.
 *
 * The Lock and Collect buttons never touch a local key: the server builds an unsigned
 * transaction for the connected wallet's address, the browser wallet shows it for
 * approval and signs it, and the server only broadcasts the signed bytes. The one key
 * the server signs with is the throwaway NFT mint keypair it creates for a new lock.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, Keypair } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getEpochFee, getTransferFeeConfig, unpackMint,
} from "@solana/spl-token";
import { ROOT, connection, loadConfig, loadKeypair, requireMint, toBaseUnits } from "./config.js";
import { BURN_OWNERS, eligibleBalances, scanTokenAccounts } from "./holders.js";
import { loadState, lockHolder, readEvents, totalOwed } from "./state.js";
import { poolAuthority, snapshot } from "./xdex.js";
import { isqrt, listLocks, lockedLp, nftHolder, pendingFeeLp } from "./locker.js";
import { buildCollect, buildLock, buildUnlock, walletLp } from "./locker-tx.js";

const cfg = loadConfig();
const conn = connection(cfg);
const mint = requireMint(cfg);
const distributor = loadKeypair(cfg.keypairs.distributor).publicKey;
const portIdx = process.argv.indexOf("--port");
const port = portIdx > 0 ? Number(process.argv[portIdx + 1]) : 8123;
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("--port must be 1024..65535 (lower ports need root)");
}
const PAGE = path.join(ROOT, "src", "dashboard.html");
const CHAIN_TTL_MS = 15_000;

let chainCache: { at: number; data: Promise<unknown> } | null = null;

/** Live on-chain view, cached briefly so page refreshes don't hammer the RPC. */
function chain() {
  if (!chainCache || Date.now() - chainCache.at > CHAIN_TTL_MS) {
    chainCache = { at: Date.now(), data: loadChain() };
    chainCache.data.catch(() => { chainCache = null; });
  }
  return chainCache.data;
}

async function loadChain() {
  const dc = cfg.distribution;
  const [mintInfo, balance, rows, { epoch }] = await Promise.all([
    conn.getAccountInfo(mint), conn.getBalance(distributor, "confirmed"),
    scanTokenAccounts(conn, mint), conn.getEpochInfo(),
  ]);
  const mintState = unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID);
  const feeCfg = getTransferFeeConfig(mintState);
  const ata = getAssociatedTokenAddressSync(mint, distributor, false, TOKEN_2022_PROGRAM_ID);
  const ataRow = rows.find((r) => r.address.equals(ata));

  const excluded = new Set([...dc.excludeOwners, ...BURN_OWNERS, distributor.toBase58(), poolAuthority(new PublicKey(cfg.xdex.programId)).toBase58()]);
  const eligible = eligibleBalances(rows, {
    excluded, excludeOffCurve: dc.excludeOffCurveOwners, minHolding: toBaseUnits(dc.minHoldingTokens, mintState.decimals),
  });
  const balances = new Map<string, bigint>();
  for (const r of rows) balances.set(r.owner, (balances.get(r.owner) ?? 0n) + r.amount);

  let pool = null;
  if (cfg.xdex.pool) {
    try {
      const snap = await snapshot(conn, new PublicKey(cfg.xdex.programId), new PublicKey(cfg.xdex.pool), mint);
      // The pool counts every LP token it ever minted; the LP mint's supply drops when LP is burned.
      // The difference is liquidity nobody can withdraw (burned LP plus the pool's own 100-unit lock).
      const lpMinted = await conn.getTokenSupply(snap.pool.lpMint, "confirmed");
      const locked = snap.pool.lpSupply - BigInt(lpMinted.value.amount);
      pool = {
        tokens: snap.reserveToken.toString(), xnt: snap.reserveXnt.toString(),
        lpSupply: snap.pool.lpSupply.toString(), lpLocked: (locked > 0n ? locked : 0n).toString(),
        lpDecimals: snap.pool.lpDecimals, lpMint: snap.pool.lpMint.toBase58(),
        nftLocks: await nftLocks(snap.reserveToken, snap.reserveXnt, snap.pool.lpSupply),
      };
    } catch (e) {
      pool = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return {
    decimals: mintState.decimals,
    supply: mintState.supply.toString(),
    feeBps: feeCfg ? getEpochFee(feeCfg, BigInt(epoch)).transferFeeBasisPoints : 0,
    withheld: (rows.reduce((a, r) => a + r.withheld, 0n) + (feeCfg?.withheldAmount ?? 0n)).toString(),
    tokenAccounts: rows.length,
    distributorXnt: balance.toString(),
    distributorTokens: (ataRow?.amount ?? 0n).toString(),
    eligible: [...eligible].map(([owner, bal]) => [owner, bal.toString()]),
    balances: Object.fromEntries([...balances].map(([o, b]) => [o, b.toString()])),
    pool,
  };
}

/** LP locked forever in lp_locker NFTs, with each lock's claimable fees. */
async function nftLocks(reserveToken: bigint, reserveXnt: bigint, supply: bigint) {
  if (!cfg.locker?.programId || !cfg.xdex.pool) return null;
  const programId = new PublicKey(cfg.locker.programId);
  const sqrtK = isqrt(reserveToken * reserveXnt);
  const locks = await listLocks(conn, programId, new PublicKey(cfg.xdex.pool));
  return {
    programId: programId.toBase58(),
    locks: await Promise.all(locks.map(async (l) => {
      const [lp, holder] = await Promise.all([lockedLp(conn, programId, l.address), nftHolder(conn, l.nftMint)]);
      const fee = pendingFeeLp(lp, l.principal, sqrtK, supply);
      return {
        address: l.address.toBase58(), nftMint: l.nftMint.toBase58(), holder: holder?.owner.toBase58() ?? null,
        lp: lp.toString(), lockedAt: l.lockedAt, unlockAt: l.unlockAt, feeLpCollected: l.feeLpCollected.toString(),
        feeLp: fee.toString(), feeXnt: ((reserveXnt * fee) / supply).toString(), feeTokens: ((reserveToken * fee) / supply).toString(),
      };
    })),
  };
}

async function data() {
  const s = loadState(mint.toBase58());
  const explorer = `https://explorer.${cfg.network}.x1.xyz`;
  let live: unknown = null, liveError: string | null = null;
  try { live = await chain(); } catch (e) { liveError = e instanceof Error ? e.message : String(e); }
  return {
    now: new Date().toISOString(),
    config: {
      network: cfg.network, symbol: cfg.token.symbol, name: cfg.token.name, mint: mint.toBase58(),
      pool: cfg.xdex.pool, distributor: distributor.toBase58(), explorer,
      autoLpBps: cfg.distribution.autoLpBps ?? 0, minPayoutXnt: cfg.distribution.minPayoutXnt,
    },
    state: {
      owed: s.owed, owedTotal: totalOwed(s).toString(), lp: s.lp, inflight: s.inflight,
      pendingBatches: s.pending ? s.pending.batches.filter((b) => b.status !== "confirmed").length : 0,
      running: lockHolder() !== null,
    },
    events: readEvents(),
    live, liveError,
  };
}

const WEB3_BUNDLE = path.join(ROOT, "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64_000) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); } });
  });
}

/** An unsigned transaction for `payer`'s wallet, pre-signed only by `extra` (the new NFT mint). */
async function unsignedTx(payer: PublicKey, ixs: TransactionInstruction[], extra: Keypair[] = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.distribution.priorityMicroLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...ixs,
  );
  if (extra.length) tx.partialSign(...extra);
  // Catch problems before asking the wallet to approve anything.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ");
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ""}`);
  }
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

async function action(url: string, body: Record<string, unknown>) {
  if (url === "/api/wallet") {
    const owner = new PublicKey(String(body.owner));
    const [lp, balance] = await Promise.all([walletLp(conn, cfg, owner), conn.getBalance(owner, "confirmed")]);
    return { lp: lp.amount.toString(), lpDecimals: lp.decimals, lpSupply: lp.supply.toString(), xnt: String(balance) };
  }
  if (url === "/api/tx/lock") {
    const owner = new PublicKey(String(body.owner));
    const amount = body.amount === "all" ? "all" : BigInt(String(body.amount));
    const days = body.days === null || body.days === undefined ? undefined : Number(body.days);
    if (days !== undefined && !(days > 0 && days <= 36_500)) throw new Error("Lock duration must be 1 to 36500 days.");
    const unlockAt = days === undefined ? undefined : Math.floor(Date.now() / 1000 + days * 86_400);
    const { ixs, signers, summary } = await buildLock(conn, cfg, owner, amount, unlockAt);
    return { tx: await unsignedTx(owner, ixs, signers), nftMint: summary.nftMint.toBase58(), lp: summary.lp.toString() };
  }
  if (url === "/api/tx/collect") {
    const holder = new PublicKey(String(body.holder));
    const { ixs, summary } = await buildCollect(conn, cfg, holder, new PublicKey(String(body.nftMint)));
    if (!ixs) throw new Error(summary.feeLp > 0n ? "Fees ready are still dust; wait for more trading." : "No trading fees to collect yet.");
    return { tx: await unsignedTx(holder, ixs), xnt: summary.xntOut.toString(), tokens: summary.tokenOut.toString() };
  }
  if (url === "/api/tx/unlock") {
    const holder = new PublicKey(String(body.holder));
    const { ixs, summary } = await buildUnlock(conn, cfg, holder, new PublicKey(String(body.nftMint)));
    return { tx: await unsignedTx(holder, ixs), lp: summary.lp.toString() };
  }
  if (url === "/api/send") {
    const raw = Buffer.from(String(body.tx), "base64");
    const tx = Transaction.from(raw);
    if (!tx.verifySignatures()) throw new Error("Transaction is not fully signed");
    const signature = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 5 });
    const res = await conn.confirmTransaction(
      { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight ?? (await conn.getBlockHeight()) + 150 },
      "confirmed");
    if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
    chainCache = null; // show the result on the next refresh
    return { signature };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this local server (blocks DNS rebinding), and only
  // accept POSTs from its own page (blocks other sites driving it from your browser).
  if (!allowedHosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  if (req.method === "POST") {
    const origin = req.headers.origin ?? "";
    if (![...allowedHosts].some((h) => origin === `http://${h}`)) { res.writeHead(403).end("Forbidden origin"); return; }
    try {
      const out = await action(req.url ?? "", await readJson(req));
      if (!out) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  try {
    if (req.url === "/vendor/web3.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
      res.end(fs.readFileSync(WEB3_BUNDLE));
    } else if (req.url === "/api/data") {
      const body = JSON.stringify(await data());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } else if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(PAGE, "utf8"));
    } else {
      res.writeHead(404).end("Not found");
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" }).end(e instanceof Error ? e.message : String(e));
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE"
    ? `Port ${port} is already in use by another program. Try: npm run dashboard -- --port <another port>`
    : e.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Reflection dashboard for ${cfg.token.symbol} (${cfg.network}): http://127.0.0.1:${port}`);
});
