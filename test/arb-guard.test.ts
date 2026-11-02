import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BURN_MAX_RAW, FeeCap, FeeJournalError, RouteFailures, dustVerdict, withFileLock, x1FeeReservation, x1MaxTxFee } from "../src/arb-guard.js";

const MIN = 60_000;

test("5 failed sends in a row within 10 minutes skip the route for an hour", () => {
  const f = new RouteFailures();
  for (let i = 0; i < 4; i++) assert.equal(f.fail("r", i * MIN), false);
  assert.equal(f.skipped("r", 4 * MIN), false);
  assert.equal(f.fail("r", 4 * MIN), true, "the fifth failure trips it");
  assert.equal(f.skipped("r", 5 * MIN), true);
  assert.equal(f.skipped("other", 5 * MIN), false, "other routes go on");
  assert.equal(f.skipped("r", 4 * MIN + 60 * MIN - 1), true);
  assert.equal(f.skipped("r", 4 * MIN + 60 * MIN), false, "back after an hour");
});

test("a success, or failures spread over more than 10 minutes, don't trip it", () => {
  const f = new RouteFailures();
  for (let i = 0; i < 4; i++) f.fail("r", i * MIN);
  f.ok("r");
  assert.equal(f.fail("r", 5 * MIN), false, "the run started over");
  const g = new RouteFailures();
  for (let i = 0; i < 10; i++) assert.equal(g.fail("r", i * 3 * MIN), false, `failure ${i}`);
});

const feesFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fees-")), "arb-fees.json");
const worker = path.join(import.meta.dirname, "helpers", "fee-cap-worker.ts");
const workerArgs = (...args: (string | number)[]) => ["--import", "tsx", worker, ...args.map(String)];

test("the fee cap counts the last 24 hours and survives a restart", () => {
  const file = feesFile();
  const cap = new FeeCap(1_000n, file);
  assert.equal(cap.reserve(600n, 0), true);
  assert.equal(cap.reached(1), false);
  assert.equal(cap.reserve(400n, 10), true);
  assert.equal(cap.reached(11), true);
  const again = new FeeCap(1_000n, file);
  assert.equal(again.reached(12), true, "read back from the file");
  assert.equal(again.spent(24 * 3_600_000 + 5), 400n, "the first fee aged out");
  assert.equal(again.reached(24 * 3_600_000 + 5), false);
});

test("a reservation that would pass the cap is refused and records nothing", () => {
  const cap = new FeeCap(1_000n, feesFile());
  assert.equal(cap.reserve(600n, 0), true);
  assert.equal(cap.reserve(401n, 1), false);
  assert.equal(cap.spent(2), 600n);
  assert.equal(cap.reserve(400n, 3), true);
});

test("a cap of 0 limits nothing but still records, so a process with a cap counts it", () => {
  const file = feesFile();
  assert.equal(new FeeCap(0n, file).reserve(10_000n, 0), true);
  assert.equal(new FeeCap(0n, file).reached(1), false);
  assert.equal(new FeeCap(1_000n, file).reached(1), true);
});

test("settling replaces a reservation with what the chain charged, and only that one", () => {
  const cap = new FeeCap(1_000n, feesFile());
  cap.reserve(500n, 0, { signature: "a", lastValidBlockHeight: 9 });
  cap.reserve(300n, 1, { signature: "b", lastValidBlockHeight: 9 });
  assert.deepEqual(cap.unsettled(2).map((u) => [u.signature, u.lastValidBlockHeight]), [["a", 9], ["b", 9]]);
  assert.equal(cap.settle("a", 420n, 2), true);
  assert.equal(cap.spent(3), 720n);
  assert.deepEqual(cap.unsettled(3).map((u) => u.signature), ["b"]);
  assert.equal(cap.settle("nope", 1n, 3), false);
});

test("two handles on one wallet's file both count: 600 + 600 is 1,200, not 600", () => {
  const file = feesFile();
  const bot = new FeeCap(10_000n, file), scanner = new FeeCap(10_000n, file);
  bot.reserve(600n, 0);
  scanner.reserve(600n, 1);
  assert.equal(new FeeCap(10_000n, file).spent(2), 1_200n);
  assert.equal(bot.spent(2), 1_200n, "each sees the other's");
});

test("two real processes racing over one cap: never past it, and nothing lost", async () => {
  const file = feesFile();
  const startAt = Date.now() + 2_500;
  // Cap 100 fees; each process tries for 80, so together they must be cut off at exactly 100.
  const runs = [0, 1].map(() => new Promise<number>((resolve, reject) => {
    const c = spawn(process.execPath, workerArgs("race", file, 100, 1, 80, startAt), { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`worker exited ${code}`))));
  }));
  const [a, b] = await Promise.all(runs);
  assert.equal(a + b, 100, `one got ${a}, the other ${b}`);
  assert.ok(a > 0 && b > 0, `both must have run together: ${a} and ${b}`);
  assert.equal(new FeeCap(100n, file).spent(Date.now()), 100n, "every reservation made it to the file");
});

test("a lock left by a process that died is taken over", () => {
  const file = feesFile();
  const r = spawnSync(process.execPath, workerArgs("die-holding-lock", file), { encoding: "utf8" });
  assert.equal(r.signal, "SIGKILL", r.stderr);
  assert.ok(fs.existsSync(`${file}.lock`), "it died holding the lock");
  assert.equal(new FeeCap(1_000n, file).reserve(1n, 0), true);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a lock held by a live process is waited for, then refused: never skipped", async () => {
  const file = feesFile();
  const c = spawn(process.execPath, workerArgs("hold-lock", file, 8_000), { stdio: "ignore" });
  try {
    for (let i = 0; i < 200 && !fs.existsSync(`${file}.holding`); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(`${file}.holding`), "the worker holds the lock");
    const cap = new FeeCap(1_000n, file, { waitMs: 200 });
    assert.throws(() => cap.reserve(1n, 0), (e: Error) => e instanceof FeeJournalError && /still held/.test(e.message));
    assert.equal(cap.spent(1), 0n, "nothing recorded");
  } finally { c.kill("SIGKILL"); }
});

test("an old lock whose pid is in use (a reused pid) goes stale by age", () => {
  const file = feesFile();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), at: 0 }));
  const cap = new FeeCap(1_000n, file, { waitMs: 200 });
  assert.throws(() => cap.reserve(1n, 0), FeeJournalError, "fresh: a live pid's lock is respected");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(`${file}.lock`, old, old);
  assert.equal(cap.reserve(1n, 0), true);
});

test("a stranded lock-break file stops sending and the error names what to delete", () => {
  const file = feesFile();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 1, host: os.hostname() }));
  fs.writeFileSync(`${file}.lock.break`, "x");
  const cap = new FeeCap(1_000n, file, { waitMs: 100 });
  assert.throws(() => cap.reserve(1n, 0), (e: Error) => e instanceof FeeJournalError && e.message.includes(`${file}.lock.break`));
});

test("a lock this process lost isn't written through", () => {
  const file = feesFile();
  const cap = new FeeCap(1_000n, file);
  // Stand in for a frozen holder: another process took the lock over while this one wasn't looking.
  assert.throws(() => withFileLock(file, () => {
    fs.writeFileSync(`${file}.lock`, "someone else");
    (cap as unknown as { write(h: () => boolean, p: unknown[]): void }).write(() => false, []);
  }), FeeJournalError);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "someone else", "their lock is left alone");
});

test("only a missing fee journal is a fresh start: anything else refuses, and keeps the file", () => {
  assert.equal(new FeeCap(1_000n, feesFile()).spent(0), 0n);
  const bad = ["{ not json", "", "null", "[]", "{}", '{"paid":{}}', '{"paid":[{"at":"x","fee":"1"}]}', '{"paid":[{"at":1,"fee":"-1"}]}', '{"paid":[{"at":1,"fee":1}]}', '{"paid":[null]}'];
  for (const text of bad) {
    const file = feesFile();
    fs.writeFileSync(file, text);
    const cap = new FeeCap(1_000n, file);
    assert.throws(() => cap.reserve(1n, 0), FeeJournalError, `reserve on ${JSON.stringify(text)}`);
    assert.throws(() => cap.reached(0), FeeJournalError, `reached on ${JSON.stringify(text)}`);
    assert.equal(fs.readFileSync(file, "utf8"), text, "left for a person to look at");
  }
  const file = feesFile();
  fs.mkdirSync(file);
  assert.throws(() => new FeeCap(1_000n, file).reserve(1n, 0), FeeJournalError, "unreadable: a directory stands in for a read error");
});

test("a journal from before signatures were recorded is still read", () => {
  const file = feesFile();
  fs.writeFileSync(file, '{"paid":[{"at":5,"fee":"700"}]}\n');
  const cap = new FeeCap(1_000n, file);
  assert.equal(cap.spent(6), 700n);
  assert.equal(cap.reserve(301n, 7), false);
});

test("X1's fee: 10 lamports per requested CU, priority on the whole limit (rounded up), and 3,001 base", () => {
  assert.equal(x1MaxTxFee(1, 200_000, 1_000), 2_003_201n, "the case from .claude/x1-notes.md");
  assert.equal(x1MaxTxFee(1, 1, 1), 3_012n);
  // A live X1 transaction read 2026-11-02 (one signature, limit 90,000 at 11,000 uL/CU) was charged 903,990: the model is 1 over.
  assert.equal(x1MaxTxFee(1, 90_000, 11_000), 903_991n);
  assert.equal(x1MaxTxFee(2, 200_000, 1_000), 2_006_202n, "per-signature base: assumed, single-signature was all that was measured");
});

test("what's reserved covers the model with a quarter to spare, rounded up", () => {
  assert.equal(x1FeeReservation(1, 200_000, 1_000), 2_504_002n);
  assert.ok(x1FeeReservation(1, 1, 1) >= x1MaxTxFee(1, 1, 1));
});

test("close-dust burns only what is worthless and tiny in raw terms", () => {
  assert.equal(dustVerdict(10n, 9, 10n, 1_000_000n), "burn");
  assert.equal(dustVerdict(10n, 9, 1_000_000n, 1_000_000n), "worth selling");
  assert.equal(dustVerdict(BURN_MAX_RAW + 1n, 9, 0n, 1_000_000n), "too much to burn", "over the raw cap, even if priced at nothing");
  assert.equal(dustVerdict(1_000n, 6, null, 1_000_000n), "burn", "unpriced, a thousandth of a token");
  assert.equal(dustVerdict(1_001n, 6, null, 1_000_000n), "too much to burn");
});
