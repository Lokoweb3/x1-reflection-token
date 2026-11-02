/** setup.sh's version pins, with apt-get and dpkg-query as stand-ins. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LIB = path.resolve("deploy/setup-lib.sh");

/** node/caddy are `installed` at a version: dpkg-query answers with it, and apt-get changes it, as told. */
function run(opts: { nodeMajorOnPath?: number | null; caddyOnPath?: boolean; dpkg?: Record<string, string>; aptFails?: boolean; aptIgnoresPin?: boolean; env?: Record<string, string> }, fn: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const state = path.join(dir, "dpkg"); fs.mkdirSync(state);
  for (const [p, v] of Object.entries(opts.dpkg ?? {})) fs.writeFileSync(path.join(state, p), v);
  const log = path.join(dir, "log"); fs.writeFileSync(log, "");
  const write = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  write("dpkg-query", `f=${state}/\${@: -1}; [[ -f $f ]] && cat "$f" || exit 1`);
  write("apt-get", `echo "apt-get $*" >> ${log}
[[ $1 == install ]] || exit 0
${opts.aptFails ? "exit 100" : ""}
for a in "$@"; do case $a in *=*) p=\${a%%=*}; v=\${a#*=}; ${opts.aptIgnoresPin ? "" : `printf %s "$v" > ${state}/$p`} ;; esac; done`);
  if (opts.nodeMajorOnPath) write("node", `echo v${opts.nodeMajorOnPath}.1.0`);
  if (opts.caddyOnPath) write("caddy", "echo caddy");
  // PATH without the system's node or caddy, so only the stand-ins can be found.
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), "setup-sys-"));
  for (const t of ["bash", "dirname", "cat", "cut", "tr", "printf"]) {
    const found = spawnSync("bash", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) fs.symlinkSync(found, path.join(sys, t));
  }
  const r = spawnSync(path.join(sys, "bash"), ["-c", `set -euo pipefail; . ${LIB}; repo() { echo "repo added" >> ${log}; }; ${fn} repo`],
    { encoding: "utf8", env: { PATH: `${bin}:${sys}`, ...opts.env } });
  return { status: r.status, out: r.stdout + r.stderr, log: fs.readFileSync(log, "utf8"), version: (p: string) => { try { return fs.readFileSync(path.join(state, p), "utf8"); } catch { return null; } } };
}

test("NODE_VERSION: honored when a different Node 22+ is already installed", () => {
  const r = run({ nodeMajorOnPath: 24, dpkg: { nodejs: "24.1.0-1nodesource1" }, env: { NODE_VERSION: "22.11.0-1nodesource1" } }, "ensure_node");
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /repo added/);
  assert.match(r.log, /install -y --allow-downgrades nodejs=22\.11\.0-1nodesource1/);
  assert.equal(r.version("nodejs"), "22.11.0-1nodesource1");
});

test("CADDY_VERSION: honored when a different Caddy is already installed", () => {
  const r = run({ caddyOnPath: true, dpkg: { caddy: "2.7.0" }, env: { CADDY_VERSION: "2.8.4" } }, "ensure_caddy");
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /install -y --allow-downgrades caddy=2\.8\.4/);
  assert.equal(r.version("caddy"), "2.8.4");
});

test("a pin that's already installed changes nothing", () => {
  const n = run({ nodeMajorOnPath: 22, dpkg: { nodejs: "22.11.0-1nodesource1" }, env: { NODE_VERSION: "22.11.0-1nodesource1" } }, "ensure_node");
  assert.equal(n.status, 0, n.out);
  assert.equal(n.log, "");
  const c = run({ caddyOnPath: true, dpkg: { caddy: "2.8.4" }, env: { CADDY_VERSION: "2.8.4" } }, "ensure_caddy");
  assert.equal(c.status, 0, c.out);
  assert.equal(c.log, "");
});

test("a pin that can't be installed fails clearly, also when apt says it worked", () => {
  const a = run({ caddyOnPath: true, dpkg: { caddy: "2.7.0" }, aptFails: true, env: { CADDY_VERSION: "2.8.4" } }, "ensure_caddy");
  assert.notEqual(a.status, 0);
  assert.match(a.out, /Couldn't install caddy=2\.8\.4/);
  const b = run({ caddyOnPath: true, dpkg: { caddy: "2.7.0" }, aptIgnoresPin: true, env: { CADDY_VERSION: "2.8.4" } }, "ensure_caddy");
  assert.notEqual(b.status, 0);
  assert.match(b.out, /caddy is at '2\.7\.0' after installing the pinned 2\.8\.4/);
});

test("NODE_VERSION below 22 or not a version is refused before apt runs", () => {
  for (const v of ["20.1.0-1nodesource1", "latest", "22.1; rm -rf /"]) {
    const r = run({ nodeMajorOnPath: 22, dpkg: { nodejs: "22.0.0" }, env: { NODE_VERSION: v } }, "ensure_node");
    assert.notEqual(r.status, 0, v);
    assert.equal(r.log, "", v);
  }
});

test("no pin: an existing Node 22+ and Caddy are left alone", () => {
  const n = run({ nodeMajorOnPath: 24 }, "ensure_node");
  assert.equal(n.status, 0, n.out);
  assert.equal(n.log, "");
  const c = run({ caddyOnPath: true }, "ensure_caddy");
  assert.equal(c.status, 0, c.out);
  assert.equal(c.log, "");
});

test("no pin: missing or old Node, and missing Caddy, get installed", () => {
  for (const nodeMajorOnPath of [null, 20]) {
    const r = run({ nodeMajorOnPath }, "ensure_node");
    assert.equal(r.status, 0, r.out);
    assert.match(r.log, /repo added/);
    assert.match(r.log, /install -y nodejs$/m);
  }
  const c = run({}, "ensure_caddy");
  assert.equal(c.status, 0, c.out);
  assert.match(c.log, /install -y caddy$/m);
});
