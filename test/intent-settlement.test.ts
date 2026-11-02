// Peg and limit settlement of a leftover intent, on a landed trade whose RPC has no history for it (no status, past its
// blockhash, nothing covering the send). Modelled RPC answers; nothing is sent. A check that goes on past settlement
// stops at reading the pool, which this fake can't answer: that's outside what's tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createLimitBuy, limitId } from "../src/limit.js";
import { createPeg, type PegSpec } from "../src/peg.js";
import { recordResolution, signed } from "../src/send-intent.js";
import type { Snapshot } from "../src/xdex.js";

const noHistory = { getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [null] }), getSlot: async () => 500, getBlock: async () => ({ blockHeight: 200 }), getSignaturesForAddress: async () => [] } as unknown as Connection;
const covered = { ...noHistory, getSignaturesForAddress: async () => [{ signature: "OLD", blockTime: 1_000, err: null }] } as unknown as Connection;
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const nyDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const common = (conn: Connection, stateDir: string, alerts: string[], sends: unknown[]) => ({ conn, xdex: PublicKey.unique(), owner: PublicKey.unique(),
  send: async (ixs: unknown) => { sends.push(ixs); return "x"; }, log: () => undefined, alert: async (s: string) => { alerts.push(s); }, stateDir, execute: true });

function limitCase(conn: Connection) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-intent-"));
  const spec = { symbol: "T", mint: PublicKey.unique(), quoteMint: PublicKey.unique(), pool: PublicKey.unique(), price: 100, budget: 50 };
  const id = limitId(spec), file = path.join(stateDir, "limit-orders.json");
  fs.writeFileSync(file, JSON.stringify({ [id]: { spent: "0", pending: { signature: "SIG", lastValidBlockHeight: 100, at: hourAgo(), amountIn: "1000000", minOut: "1", tokens: 1, poolPrice: 100 } } }));
  const alerts: string[] = [], sends: unknown[] = [];
  return { stateDir, alerts, sends, row: () => JSON.parse(fs.readFileSync(file, "utf8"))[id], order: createLimitBuy(spec, common(conn, stateDir, alerts, sends)) };
}

test("limit: unprovable buy blocks new buys and stays journaled, alerts once with the way out, and a person's decision counts it", async () => {
  const c = limitCase(noHistory);
  assert.equal(await c.order.check(), "pending");
  assert.equal(await c.order.check(), "pending");
  assert.equal(c.sends.length, 0);
  assert.equal(c.row().pending.signature, "SIG", "the intent stays");
  assert.equal(c.row().spent, "0");
  assert.equal(c.alerts.length, 1, "one alert");
  assert.match(c.alerts[0], /resolve-intent\.ts SIG/);

  recordResolution(c.stateDir, "SIG", "landed");
  await c.order.check().catch(() => undefined);
  assert.equal(c.row().spent, "1000000", "counted against the budget");
  assert.equal(c.row().pending, undefined);
});

test("limit: a person's 'dropped' clears it without counting; so does proof from the chain", async () => {
  const c = limitCase(noHistory);
  recordResolution(c.stateDir, "SIG", "dropped");
  await c.order.check().catch(() => undefined);
  assert.equal(c.row().spent, "0");
  assert.equal(c.row().pending, undefined);

  const p = limitCase(covered);
  await p.order.check().catch(() => undefined);
  assert.equal(p.row().spent, "0");
  assert.equal(p.row().pending, undefined);
  assert.equal(p.alerts.length, 0);
});

function pegCase(conn: Connection) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "peg-intent-"));
  const spec = { ticker: "T", mint: PublicKey.unique(), quoteMint: PublicKey.unique(), pool: PublicKey.unique() } as unknown as PegSpec;
  const alerts: string[] = [], sends: unknown[] = [];
  const keeper = createPeg(spec, common(conn, stateDir, alerts, sends));
  const files = () => fs.readdirSync(stateDir).filter((f) => f.endsWith(".json") && f !== "intent-resolutions.json");
  const seed = (file: string) => fs.writeFileSync(path.join(stateDir, file), JSON.stringify({ day: nyDay(), used: 0, pending: { signature: "SIG", lastValidBlockHeight: 100, at: hourAgo(), day: nyDay(), side: "buy", amountIn: "1", minOut: "1", tokens: 0.5, poolPrice: 1, refPrice: 1 } }));
  return { stateDir, alerts, sends, keeper, files, seed };
}
const PEG_FILE = "peg-t.json";

/** The writes `work` makes: each state file's contents must be flushed before it gets its final name. */
async function flushedBeforeRename(work: () => Promise<unknown>) {
  const events: string[] = [];
  const { fsyncSync, renameSync } = fs;
  fs.fsyncSync = (fd) => { events.push("fsync"); return fsyncSync(fd); };
  fs.renameSync = (a, b) => { events.push(`rename ${path.basename(String(b))}`); return renameSync(a, b); };
  try { await work(); } finally { fs.fsyncSync = fsyncSync; fs.renameSync = renameSync; }
  return events;
}
const assertDurable = (events: string[], file: string) => {
  const at = events.indexOf(`rename ${file}`);
  assert.ok(at > 0, `${file} was written: ${events.join(", ")}`);
  assert.equal(events[at - 1], "fsync", "its contents flushed first");
  assert.equal(events[at + 1], "fsync", "its name flushed after");
};

// setPending is also what journals the signature before a broadcast: the dropped case reaches that same writer.
test("limit: the intent and the budget are written durably", async () => {
  const dropped = limitCase(noHistory);
  recordResolution(dropped.stateDir, "SIG", "dropped");
  assertDurable(await flushedBeforeRename(() => dropped.order.check().catch(() => undefined)), "limit-orders.json");
  const landed = limitCase(noHistory);
  recordResolution(landed.stateDir, "SIG", "landed");
  assertDurable(await flushedBeforeRename(() => landed.order.check().catch(() => undefined)), "limit-orders.json");
});

test("peg: the intent and the day's count are written durably", async () => {
  for (const verdict of ["dropped", "landed"] as const) {
    const c = pegCase(noHistory);
    c.seed(PEG_FILE);
    recordResolution(c.stateDir, "SIG", verdict);
    assertDurable(await flushedBeforeRename(() => c.keeper.check().catch(() => undefined)), PEG_FILE);
  }
});

test("peg: unprovable trade blocks new trades and stays journaled, alerts once with the way out, and a person's decision counts it", async () => {
  const c = pegCase(noHistory);
  c.seed(PEG_FILE);
  assert.equal(await c.keeper.check(), "pending");
  assert.equal(await c.keeper.check(), "pending");
  assert.equal(c.sends.length, 0);
  const read = () => JSON.parse(fs.readFileSync(path.join(c.stateDir, PEG_FILE), "utf8"));
  assert.equal(read().pending.signature, "SIG");
  assert.equal(c.alerts.length, 1);
  assert.match(c.alerts[0], /resolve-intent\.ts SIG/);

  recordResolution(c.stateDir, "SIG", "landed");
  await c.keeper.check().catch(() => undefined);
  assert.equal(read().used, 0.5, "counted against the day");
  assert.equal(read().pending, undefined);
});

// ---------- A real check() down to its send, on a modelled pool and RPC; `send` plays the engine, calling signed() before "broadcast".
const noFee = { transferFeeConfigAuthority: PublicKey.default, withdrawWithheldAuthority: PublicKey.default, withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 }, newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 } };
const key = () => PublicKey.unique();
const SIG = "SENT";
/** A chain on which SENT has already confirmed, and the token (8 decimals) and USDC.X (6) both exist. */
const confirmedChain = () => ({
  getSignatureStatuses: async () => ({ context: { slot: 510 }, value: [{ confirmationStatus: "confirmed", err: null }] }),
  getTokenAccountBalance: async () => ({ value: { amount: (10n ** 12n).toString() } }),
  getAccountInfo: async (k: PublicKey) => { const decimals = k.equals(mintT) ? 8 : 6; const data = Buffer.alloc(MINT_SIZE); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data); return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false }; },
}) as unknown as Connection;
/** A pool holding `g` tokens and `u` USDC.X, read from either side; `mint` is the token. */
const poolOf = (mint: PublicKey, g: number, u: number) => (async (_c: unknown, _x: unknown, address: PublicKey, inMint: PublicKey) => {
  const tokenIn = inMint.equals(mint), tok = BigInt(Math.round(g * 1e8)), usd = BigInt(Math.round(u * 1e6));
  const pool = { address, ammConfig: key(), vaults: [key(), key()], mints: [key(), key()], programs: [TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID], observation: key() };
  return { pool, side: 0, quoteMint: key(), reserveToken: tokenIn ? tok : usd, reserveQuote: tokenIn ? usd : tok,
    tradeFeeRate: 2800n, feeCfg: noFee, epoch: 1n } as unknown as Snapshot;
});

type Sender = (ixs: TransactionInstruction[]) => Promise<string>;
function limitOrder(stateDir: string, execute: boolean, send: Sender, over: Record<string, unknown> = {}) {
  const spec = { symbol: "T", mint: mintT, quoteMint: quoteT, pool: poolT, price: 300, budget: 100 };
  const alerts: string[] = [];
  const order = createLimitBuy(spec, { conn: confirmedChain(), xdex: key(), owner: ownerT, send, log: () => undefined, alert: async (s) => { alerts.push(s); }, stateDir, execute,
    snapshot: poolOf(mintT, 10, 2_900) as never, ...over });
  const row = () => JSON.parse(fs.readFileSync(path.join(stateDir, "limit-orders.json"), "utf8"))[limitId(spec)];
  return { order, row, alerts, journal: () => { try { return fs.readFileSync(path.join(stateDir, "limit-trades.jsonl"), "utf8").trim().split("\n").length; } catch { return 0; } } };
}
const mintT = key(), quoteT = key(), poolT = key(), ownerT = Keypair.generate().publicKey;
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const stateBytes = (dir: string) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));

test("limit: a dry run on the live state, during the live send, writes nothing; the buy counts once", async () => {
  const dir = tmp("limit-dry");
  let during: unknown, duringBytes: unknown;
  const live = limitOrder(dir, true, async () => {
    signed(SIG, 1_000);
    const before = stateBytes(dir);
    during = await limitOrder(dir, false, async () => { throw new Error("a dry run must not send"); }).order.check();
    duringBytes = [before, stateBytes(dir)];
    return SIG;
  });
  assert.equal(await live.order.check(), "traded");
  assert.equal(during, "pending");
  const [before, after] = duringBytes as [unknown, unknown];
  assert.deepEqual(after, before, "the dry run changed nothing");
  const spent = BigInt(live.row().spent);
  assert.ok(spent > 0n);
  assert.equal(live.journal(), 1);
  assert.equal(live.row().pending, undefined);
  assert.deepEqual(live.row().counted, [SIG]);
});

test("limit: a second live process settling during the send counts it; the sender then doesn't: one buy, one count", async () => {
  const dir = tmp("limit-two");
  let spentAfterOther = 0n;
  const live = limitOrder(dir, true, async () => {
    signed(SIG, 1_000);
    const other = limitOrder(dir, true, async () => { throw new Error("no second trade here"); }, { snapshot: async () => { throw new Error("stop after settling"); } });
    await other.order.check().catch((e) => assert.match(String(e), /stop after settling/));
    spentAfterOther = BigInt(other.row().spent);
    assert.ok(spentAfterOther > 0n, "the other process counted it");
    return SIG;
  });
  assert.equal(await live.order.check(), "traded");
  assert.equal(BigInt(live.row().spent), spentAfterOther, "not counted twice");
  assert.equal(live.journal(), 1, "one line in the trade journal");
});

test("limit: an intent taken away before signing stops the broadcast; a foreign intent stops the claim", async () => {
  const dir = tmp("limit-stolen");
  let broadcast = false;
  const orders = () => JSON.parse(fs.readFileSync(path.join(dir, "limit-orders.json"), "utf8"));
  const live = limitOrder(dir, true, async () => {
    const all = orders();
    for (const k of Object.keys(all)) all[k].pending = { ...all[k].pending, token: "someone-else" };
    fs.writeFileSync(path.join(dir, "limit-orders.json"), JSON.stringify(all));
    signed(SIG, 1_000);
    broadcast = true;
    return SIG;
  });
  await assert.rejects(live.order.check(), /took this order's intent/);
  assert.equal(broadcast, false);
  assert.equal(BigInt(live.row().spent), 0n);

  const dir2 = tmp("limit-foreign");
  let sends = 0;
  const pool = poolOf(mintT, 10, 2_900);
  const second = limitOrder(dir2, true, async () => { sends++; return SIG; }, { snapshot: (async (...a: Parameters<typeof pool>) => {
    // Another process claims the order between this check's settle and its claim.
    const id = limitId({ symbol: "T", mint: mintT, quoteMint: quoteT, pool: poolT, price: 300, budget: 100 });
    fs.writeFileSync(path.join(dir2, "limit-orders.json"), JSON.stringify({ [id]: { spent: "0", pending: { token: "other", at: new Date().toISOString() } } }));
    return pool(...a);
  }) as never });
  assert.equal(await second.order.check(), "pending");
  assert.equal(sends, 0);
});

function pegKeeper(stateDir: string, execute: boolean, send: Sender, over: Record<string, unknown> = {}) {
  const spec = { ticker: "T", mint: mintT, quoteMint: quoteT, pool: poolT } as unknown as PegSpec;
  return createPeg(spec, { conn: confirmedChain(), xdex: key(), owner: ownerT, send, log: () => undefined, alert: async () => undefined, stateDir, execute,
    // The pool at 290 against a reference of 280: too high, so it sells.
    snapshot: poolOf(mintT, 10, 2_900) as never, fetchPrice: (async () => ({ price: 280, sources: "test" })) as never, ...over });
}
const pegState = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, PEG_FILE), "utf8"));
const pegLines = (dir: string) => fs.readFileSync(path.join(dir, "peg-trades.jsonl"), "utf8").trim().split("\n").length;

test("peg: a dry run on the live state, during the live send, writes nothing; the trade counts once", async () => {
  const dir = tmp("peg-dry");
  let during: unknown, same = false;
  const live = pegKeeper(dir, true, async () => {
    signed(SIG, 1_000);
    const before = stateBytes(dir);
    during = await pegKeeper(dir, false, async () => { throw new Error("a dry run must not send"); }).check();
    same = JSON.stringify(stateBytes(dir)) === JSON.stringify(before);
    return SIG;
  });
  assert.equal(await live.check(), "traded");
  assert.equal(during, "pending");
  assert.equal(same, true, "the dry run changed nothing");
  assert.ok(pegState(dir).used > 0);
  assert.equal(pegLines(dir), 1);
});

test("peg: a second live process settling during the send counts it; the sender then doesn't", async () => {
  const dir = tmp("peg-two");
  let afterOther = 0;
  const live = pegKeeper(dir, true, async () => {
    signed(SIG, 1_000);
    await pegKeeper(dir, true, async () => { throw new Error("no second trade here"); }, { fetchPrice: async () => { throw new Error("stop after settling"); } }).check().catch((e) => assert.match(String(e), /stop after settling/));
    afterOther = pegState(dir).used;
    assert.ok(afterOther > 0);
    return SIG;
  });
  assert.equal(await live.check(), "traded");
  assert.equal(pegState(dir).used, afterOther, "not counted twice");
  assert.equal(pegLines(dir), 1);
});

test("peg: a trade from an earlier day clears without counting today, and counts its signature", async () => {
  const c = pegCase(noHistory);
  fs.writeFileSync(path.join(c.stateDir, PEG_FILE), JSON.stringify({ day: "2020-01-01", used: 0.09, pending: { signature: "SIG", lastValidBlockHeight: 100, at: hourAgo(), day: "2020-01-01", side: "buy", amountIn: "1", minOut: "1", tokens: 0.5, poolPrice: 1, refPrice: 1 } }));
  recordResolution(c.stateDir, "SIG", "landed");
  await c.keeper.check().catch(() => undefined);
  const s = JSON.parse(fs.readFileSync(path.join(c.stateDir, PEG_FILE), "utf8"));
  assert.equal(s.used, 0);
  assert.equal(s.pending, undefined);
  assert.deepEqual(s.counted, ["SIG"]);
});

test("two real processes counting the same signatures: each exactly once, on a limit order and on a peg", async () => {
  const dir = tmp("slot-race"), N = 40;
  const worker = path.join(import.meta.dirname, "helpers", "fee-cap-worker.ts");
  const startAt = Date.now() + 2_500;
  const runs = [0, 1].map(() => new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", "tsx", worker, "slot-race", dir, String(N), String(startAt)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`worker exited ${code}`))));
  }));
  const [a, b] = await Promise.all(runs);
  assert.equal(a + b, N, `first counts: ${a} and ${b}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "limit-orders.json"), "utf8")).order.spent, String(N * 10));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "peg-t.json"), "utf8")).used, N);
});
