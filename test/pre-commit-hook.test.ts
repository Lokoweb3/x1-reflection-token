/**
 * .githooks/pre-commit against a real throwaway git repo. No key here is real: the arrays are
 * counting bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK = path.resolve(".githooks/pre-commit");
const KEY = Array.from({ length: 64 }, (_, i) => i * 3);

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  return dir;
}
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function stage(dir: string, name: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, "add", "-f", "--", name);
}
const runHook = (dir: string, env: NodeJS.ProcessEnv = process.env) => spawnSync("bash", [HOOK], { cwd: dir, encoding: "utf8", env });

test("hook: a clean commit passes", () => {
  const d = repo();
  stage(d, "a.txt", "hello\n");
  stage(d, "numbers.json", JSON.stringify(KEY.slice(0, 63)));   // 63 numbers: not a key
  stage(d, "big.json", JSON.stringify([...KEY, 1]));            // 65 numbers: not a key
  stage(d, "range.json", JSON.stringify([...KEY.slice(0, 63), 256])); // 256 isn't a byte
  const r = runHook(d);
  assert.equal(r.status, 0, r.stderr);
});

test("hook: compact and multiline keys are refused, whatever the file name", () => {
  for (const content of [JSON.stringify(KEY), JSON.stringify(KEY, null, 2), `{"k":\r\n${KEY.join(" ,\t").replace(/^/, "[")}]}`]) {
    const d = repo();
    stage(d, "notes.txt", content);
    const r = runHook(d);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /notes\.txt looks like a secret key/);
  }
});

test("hook: a key followed by a NUL and a large payload is refused (compact and multiline)", () => {
  // The regression: grep -q exited at the match, the upstream writer took SIGPIPE, pipefail made
  // the condition false, and the commit went through.
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x41);
  for (const key of [JSON.stringify(KEY), JSON.stringify(KEY, null, 2)]) {
    const d = repo();
    stage(d, "blob.bin", Buffer.concat([Buffer.from(key), Buffer.from([0]), payload]));
    const r = runHook(d);
    assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /blob\.bin looks like a secret key/);
  }
});

test("hook: a key in a file with an awkward name is still found", () => {
  const d = repo();
  stage(d, "dir with space/ü -x.json", JSON.stringify(KEY));
  const r = runHook(d);
  assert.equal(r.status, 1, r.stderr);
});

test("hook: a symlink replaced by a key file (a type change) is refused", () => {
  const d = repo();
  fs.writeFileSync(path.join(d, "target"), "x\n");
  fs.symlinkSync("target", path.join(d, "link"));
  git(d, "add", "--", "target", "link");
  git(d, "commit", "-qm", "base", "--no-verify");
  fs.rmSync(path.join(d, "link"));
  stage(d, "link", JSON.stringify(KEY));
  const r = runHook(d);
  assert.equal(r.status, 1, r.stderr);
});

test("hook: a scan error is not treated as clean", () => {
  const d = repo();
  stage(d, "a.txt", "hello\n");
  // A grep that fails the way a real scan error does (exit 2).
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hook-bin-"));
  fs.writeFileSync(path.join(bin, "grep"), "#!/bin/sh\ncat >/dev/null\necho broken >&2\nexit 2\n", { mode: 0o755 });
  const r = runHook(d, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /couldn't scan a\.txt/);
});

test("hook: a staged-file listing that fails is not treated as clean", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hook-norepo-"));
  const r = runHook(d, { ...process.env, GIT_DIR: path.join(d, "missing"), GIT_CEILING_DIRECTORIES: d });
  assert.equal(r.status, 2, r.stderr);
});

// Built at run time and never real, so this file doesn't trip the hook it tests.
const BOT = ["123456789", "A".repeat(35)].join(":");
const API = "proapi" + "_" + "b".repeat(32);
const LONG = "c".repeat(24);

test("hook: bot and API tokens are refused, in any file, and the value is never printed", () => {
  for (const [name, content] of [
    ["notes.md", `the bot is ${BOT} today\n`],
    ["crlf.env", `TELEGRAM_BOT_TOKEN=${LONG}\r\n`],
    ["blockscout.txt", `key ${API}\n`],
    ["a.env", `TELEGRAM_BOT_TOKEN=${LONG}\n`],
    ["b.env", `export X1_NINJA_API_KEY="${LONG}"\n`],
    ["c.env", `LP_BLOCKSCOUT_KEY = ${LONG}\n`],
    ["d.json", JSON.stringify({ CLAUDE_CODE_MESSAGING_TOKEN: LONG })],
    ["e.yaml", `BLOCKSCOUT_API_KEY: '${LONG}'\n`],
  ] as const) {
    const d = repo();
    stage(d, name, content);
    const r = runHook(d);
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /bot or API token/);
    for (const secret of [BOT, API, LONG]) assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret), `${name} printed its value`);
  }
});

test("hook: naming these variables without a value passes", () => {
  const d = repo();
  stage(d, "a.ts", "const t = process.env.TELEGRAM_BOT_TOKEN;\nconst k = process.env.LP_BLOCKSCOUT_KEY ?? '';\n");
  stage(d, "b.md", "printf 'TELEGRAM_BOT_TOKEN=...\\nTELEGRAM_CHAT_ID=...\\n'\nset X1_NINJA_API_KEY=<your key>\nCLAUDE_CODE_MESSAGING_TOKEN: set by Claude Code\n");
  stage(d, "c.txt", "started 2026-11-03 12:30:45 block 90489395:ok\n");
  stage(d, "d.service", "# e.g. TELEGRAM_BOT_TOKEN=... and TELEGRAM_CHAT_ID=... (both needed)\n");
  const r = runHook(d);
  assert.equal(r.status, 0, r.stderr);
});

test("hook: a file name holding byte 0x01 can't hide a staged key or token", () => {
  const d = repo();
  stage(d, "safe-a", "fine\n");
  stage(d, "safe-b", "fine\n");
  git(d, "commit", "-qm", "base");
  stage(d, "safe-a\x01safe-b", `${BOT}\n`);
  const r = runHook(d);
  assert.equal(r.status, 1, r.stderr);
});

test("gitignore: key and state folders are ignored, source isn't", () => {
  const check = (p: string) => spawnSync("git", ["check-ignore", "-q", "--no-index", "--", p], { encoding: "utf8" }).status;
  for (const p of ["factory/pending-launches/M/distributor.json", "mainnet/factory/pending-launches/M/distributor.json",
    "mainnet/factory/launches/M/distributor.json", "tmp-rehearsal/factory/launches/M/distributor.json",
    "elsewhere/pending-launches/M/distributor.json", "mainnet/config.json", "state/arb-fees-W.json", "state/arb-fees-W.json.lock",
    "arb.keypair.json", "config.json"])
    assert.equal(check(p), 0, `${p} should be ignored`);
  for (const p of ["src/factory/launch.ts", "src/factory/durable.ts", "deploy/backup.sh"])
    assert.equal(check(p), 1, `${p} should not be ignored`);
});
