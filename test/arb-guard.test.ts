import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BURN_MAX_RAW, FeeCap, FeeJournalError, RetryQueue, RouteFailures, dustVerdict, withFileLock, x1FeeReservation, x1MaxTxFee } from "../src/arb-guard.js";

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

const holderOf = (o: object) => JSON.stringify({ pid: process.pid, host: os.hostname(), ...o });
const realStart = () => fs.readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];

test("age alone never takes a live holder's lock: a paused holder still holds it when it wakes", () => {
  const file = feesFile();
  fs.writeFileSync(`${file}.lock`, holderOf({ start: realStart() }));
  const year = new Date(Date.now() - 365 * 86_400_000);
  fs.utimesSync(`${file}.lock`, year, year);
  const cap = new FeeCap(1_000n, file, { waitMs: 100 });
  assert.throws(() => cap.reserve(1n, 0), (e: Error) => e instanceof FeeJournalError && e.message.includes(String(process.pid)), "the error names the holder");
  assert.ok(fs.existsSync(`${file}.lock`));
});

test("a holder that's certainly gone loses its lock: a reused pid, or a restarted machine", () => {
  const reused = feesFile();
  fs.writeFileSync(`${reused}.lock`, holderOf({ start: "1" }));
  assert.equal(new FeeCap(1_000n, reused, { waitMs: 200 }).reserve(1n, 0), true);
  const rebooted = feesFile();
  fs.writeFileSync(`${rebooted}.lock`, holderOf({ start: realStart(), boot: "some-earlier-boot" }));
  assert.equal(new FeeCap(1_000n, rebooted, { waitMs: 200 }).reserve(1n, 0), true);
});

test("a lock that can't be judged is left for a person: another machine, another pid namespace, or a lock naming nobody", () => {
  for (const text of [JSON.stringify({ pid: 2 ** 22 + 1, host: "another-machine" }), holderOf({ pid: 2 ** 22 + 1, pidNs: "pid:[1]" }), "", "{ torn"]) {
    const file = feesFile();
    fs.writeFileSync(`${file}.lock`, text);
    assert.throws(() => new FeeCap(1_000n, file, { waitMs: 50 }).reserve(1n, 0), FeeJournalError, text);
  }
});

test("a holder paused between its cap check and its commit: one reservation, nothing overwritten", async () => {
  const file = feesFile(), PAUSE = 2_500;
  let out = "";
  const a = spawn(process.execPath, workerArgs("pause-before-commit", file, 100, 60, PAUSE), { stdio: ["ignore", "pipe", "inherit"] });
  a.stdout.on("data", (d) => { out += d; });
  const done = new Promise((r) => a.on("exit", r));
  for (let i = 0; i < 400 && !fs.existsSync(`${file}.holding`); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(`${file}.holding`), "the worker has checked the cap and paused before its rename");
  // A short wait while it's paused: refused, not stolen.
  assert.throws(() => new FeeCap(100n, file, { waitMs: 100 }).reserve(60n, Date.now()), FeeJournalError);
  // A long one, outlasting the pause: it sees the committed 60, and 60 more won't fit under 100.
  const second = new FeeCap(100n, file, { waitMs: PAUSE + 8_000 }).reserve(60n, Date.now());
  await done;
  assert.equal(out.trim(), "true", "the paused holder's reservation stands");
  assert.equal(second, false);
  assert.equal(new FeeCap(100n, file).spent(Date.now()), 60n);
});

test("the same signature is one reservation, also across handles, and doesn't re-check the cap", () => {
  const file = feesFile();
  const a = new FeeCap(100n, file), b = new FeeCap(100n, file);
  assert.equal(a.reserve(60n, 0, { signature: "s" }), true);
  assert.equal(b.reserve(60n, 1, { signature: "s" }), true, "already counted");
  assert.equal(a.spent(2), 60n);
  assert.equal(a.reserve(60n, 3, { signature: "t" }), false, "another transaction doesn't fit");
  assert.equal(a.reserve(10n, 4), true);
  assert.equal(a.reserve(10n, 5), true, "unsigned entries aren't the same transaction");
  assert.equal(a.spent(6), 80n);
});

test("settling consolidates a journal that already holds a signature twice", () => {
  const file = feesFile();
  fs.writeFileSync(file, JSON.stringify({ paid: [{ at: 1, fee: "60", signature: "s" }, { at: 2, fee: "50", signature: "other" }, { at: 3, fee: "60", signature: "s" }] }));
  const cap = new FeeCap(1_000n, file);
  assert.equal(cap.settle("s", 40n, 4), true);
  assert.equal(cap.spent(5), 90n);
  assert.deepEqual(cap.unsettled(5).map((u) => u.signature), ["other"]);
});

test("the retry queue gets to everything: what didn't settle backs off and goes to the back", () => {
  const q = new RetryQueue();
  const items = ["a", "b", "c", "d"].map((signature, i) => ({ signature, at: i }));
  const pick = (now: number, hurry = false) => q.pick(items, now, 2, hurry).map((i) => i.signature);
  assert.deepEqual(pick(0), ["a", "b"], "oldest first");
  q.failed("a", 0); q.failed("b", 0);
  assert.deepEqual(pick(1), ["c", "d"], "the unsettled two don't hide the rest");
  q.failed("c", 1); q.failed("d", 1);
  assert.deepEqual(pick(2), [], "all backing off");
  assert.deepEqual(pick(2, true), ["a", "b"], "in a hurry: least recently tried, regardless");
  assert.deepEqual(pick(60_000), ["a", "b"], "after a minute");
  q.failed("a", 60_000);
  assert.deepEqual(q.pick(items, 60_001 + 60_000, 4).map((i) => i.signature).includes("a"), false, "twice failed: two minutes");
  assert.deepEqual(q.pick(items, 60_000 + 120_000, 4).map((i) => i.signature).includes("a"), true);
  for (let i = 0; i < 20; i++) q.failed("b", 0);
  assert.equal(q.pick(items, 3_600_000, 4).some((i) => i.signature === "b"), true, "never more than an hour");
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
  // Unreadable, not malformed: a reading check must refuse by itself, before any write could fail for another reason.
  const dir = feesFile();
  fs.mkdirSync(dir);
  assert.throws(() => new FeeCap(1_000n, dir).reached(0), FeeJournalError, "a directory stands in for a read error");
  if (process.getuid?.() !== 0) {
    const locked = feesFile();
    fs.writeFileSync(locked, '{"paid":[{"at":1,"fee":"1"}]}');
    fs.chmodSync(locked, 0o000);
    assert.throws(() => new FeeCap(1_000n, locked).spent(2), (e: Error) => e instanceof FeeJournalError && /EACCES/.test(e.message));
  }
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
