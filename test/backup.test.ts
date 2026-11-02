/** deploy/backup.sh with real tar and gpg, on throwaway folders and a throwaway keyring. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve("deploy/backup.sh");
const hasGpg = spawnSync("gpg", ["--version"]).status === 0;
const short = () => fs.mkdtempSync("/tmp/bk-");  // gpg-agent's socket path has a short length limit
const homes: string[] = [];
test.after(() => { for (const h of homes) spawnSync("gpgconf", ["--homedir", h, "--kill", "all"]); });

function app(opts: { mainnet?: boolean; keys?: boolean } = {}) {
  const root = short();
  const a = path.join(root, "app"); fs.mkdirSync(a);
  const write = (p: string, t = "x\n") => { fs.mkdirSync(path.dirname(path.join(a, p)), { recursive: true }); fs.writeFileSync(path.join(a, p), t); };
  write("config.json", "{}\n"); write("state/journal.json"); write("factory/launches/M1/launch.json");
  if (opts.keys !== false) {
    write("distributor.keypair.json", "[1]\n"); write("publisher-keypair.json", "[2]\n");
    write("factory/launches/M1/distributor.json", "[3]\n"); write("factory/pending-launches/M2/distributor.json", "[4]\n");
  }
  if (opts.mainnet) { write("mainnet/config.json", "{}\n"); write("mainnet/factory/pending-launches/M3/distributor.json", "[5]\n"); }
  const home = path.join(root, "g"); fs.mkdirSync(home, { mode: 0o700 }); homes.push(home);
  const pass = path.join(root, "pass"); fs.writeFileSync(pass, "correct horse battery staple\n", { mode: 0o600 });
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: root, GNUPGHOME: home, APP: a, BACKUP_DIR: path.join(root, "out"), BACKUP_PASSFILE: pass, BACKUP_ENV_FILE: path.join(root, "none") };
  const run = (extra: NodeJS.ProcessEnv = {}) => spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...env, ...extra } });
  const archives = () => (fs.existsSync(env.BACKUP_DIR!) ? fs.readdirSync(env.BACKUP_DIR!) : []);
  return { root, a, bin, env, pass, run, archives, write };
}
const names = (s: ReturnType<typeof app>) => {
  const f = path.join(s.env.BACKUP_DIR!, s.archives()[0]);
  const r = spawnSync("bash", ["-c", `set -o pipefail; gpg --batch --quiet --pinentry-mode loopback --passphrase-file "${s.pass}" -d "${f}" | tar -tzf -`], { encoding: "utf8", env: s.env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n");
};

test("backup: a passphrase backup decrypts, and holds config, every key and the pending launches", { skip: !hasGpg }, () => {
  const s = app({ mainnet: true });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Backup written: .*\(\d+ entries, 5 key files\)/);
  assert.equal(s.archives().length, 1);
  const n = names(s);
  for (const want of ["config.json", "distributor.keypair.json", "publisher-keypair.json", "state/journal.json", "factory/launches/M1/distributor.json",
    "factory/pending-launches/M2/distributor.json", "mainnet/config.json", "mainnet/factory/pending-launches/M3/distributor.json"])
    assert.ok(n.includes(want), `missing ${want}`);
});

test("backup: to a public key, checked against that key; the passphrase isn't needed", { skip: !hasGpg }, () => {
  const s = app();
  const g = spawnSync("gpg", ["--batch", "--passphrase", "", "--quick-gen-key", "reflect test <t@example.invalid>", "rsa2048", "encr", "never"], { encoding: "utf8", env: s.env });
  assert.equal(g.status, 0, g.stderr);
  const fpr = spawnSync("gpg", ["--batch", "--with-colons", "--list-keys"], { encoding: "utf8", env: s.env }).stdout.match(/^fpr:+([0-9A-F]{40}):/m)![1];
  const r = s.run({ BACKUP_RECIPIENT: fpr, BACKUP_PASSFILE: "/nonexistent" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const f = path.join(s.env.BACKUP_DIR!, s.archives()[0]);
  const d = spawnSync("bash", ["-c", `set -o pipefail; gpg --batch --quiet -d "${f}" | tar -tzf -`], { encoding: "utf8", env: s.env });
  assert.equal(d.status, 0, d.stderr);
  assert.ok(d.stdout.split("\n").includes("factory/pending-launches/M2/distributor.json"));
});

test("backup: a folder with no key files isn't a backup", { skip: !hasGpg }, () => {
  const s = app({ keys: false });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /no key files/);
  assert.deepEqual(s.archives(), []);
});

test("backup: missing config, or a mainnet folder without its config, stops the run", { skip: !hasGpg }, () => {
  let s = app();
  fs.rmSync(path.join(s.a, "config.json"));
  let r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /no config\.json/);
  assert.deepEqual(s.archives(), []);
  s = app();
  fs.mkdirSync(path.join(s.a, "mainnet"));
  r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /no mainnet\/config\.json/);
});

/** A tar that really runs, then reports the given status when creating. */
function tarExits(s: ReturnType<typeof app>, code: number) {
  const real = spawnSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(s.bin, "tar"), `#!/bin/bash\n${real} "$@" || exit\ncase "$*" in *-czf*) echo "tar: a message" >&2; exit ${code};; esac\n`, { mode: 0o755 });
}

test("backup: a file changing during the read (tar exit 1) is a warning, with a good archive", { skip: !hasGpg }, () => {
  const s = app();
  tarExits(s, 1);
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /WARNING: some files changed/);
  assert.ok(names(s).includes("config.json"));
});

test("backup: a real tar failure (exit 2) leaves no archive", { skip: !hasGpg }, () => {
  const s = app();
  tarExits(s, 2);
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.deepEqual(s.archives(), []);
});

test("backup: a truncated stream is caught by reading it back", { skip: !hasGpg }, () => {
  const s = app();
  // tar "succeeds" but only half the gzip comes out.
  const real = spawnSync("bash", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(s.bin, "tar"), `#!/bin/bash\ncase "$*" in *-czf*) ${real} "$@" | head -c 60; exit 0;; *) exec ${real} "$@";; esac\n`, { mode: 0o755 });
  const r = s.run();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.archives(), []);
});

test("backup: gpg failing leaves no archive and no temp file", { skip: !hasGpg }, () => {
  const s = app();
  fs.writeFileSync(path.join(s.bin, "gpg"), `#!/bin/bash\ncat >/dev/null\nexit 2\n`, { mode: 0o755 });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.deepEqual(s.archives(), []);
});

test("backup: an off-box copy that fails fails the run", { skip: !hasGpg }, () => {
  const s = app();
  fs.writeFileSync(path.join(s.bin, "rclone"), "#!/bin/bash\nexit 3\n", { mode: 0o755 });
  const r = s.run({ BACKUP_REMOTE: "b2:x" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /Copied to/);
});
