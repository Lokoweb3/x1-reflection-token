/**
 * The Vercel backend's header gate: the two Caddy templates, what deploy/origin-gate.sh refuses and
 * what it does. caddy and systemctl are stand-ins here (a script that logs its arguments and exits as
 * told), so this tests our checks and ordering, not Caddy's own parsing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const GATE = path.resolve("deploy/origin-gate.sh");
const SETUP_LIB = path.resolve("deploy/setup-lib.sh");
const ENFORCE = fs.readFileSync("deploy/Caddyfile.vercel.template", "utf8");
const OBSERVE = fs.readFileSync("deploy/Caddyfile.vercel.observe.template", "utf8");
const GOOD = "a".repeat(40), NEXT = "b".repeat(40);

function sandbox(opts: { env?: string | null; caddyFails?: boolean; reloadFails?: boolean; caddyfile?: string | null; active?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const log = path.join(dir, "log");
  fs.writeFileSync(path.join(bin, "caddy"), `#!/bin/bash\necho "caddy $* secret=\${REFLECT_ORIGIN_SECRET:-none}" >> ${log}\nexit ${opts.caddyFails ? 1 : 0}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/bash\necho "systemctl $*" >> ${log}\ncase "$1" in is-active) exit ${opts.active === false ? 3 : 0};; reload) exit ${opts.reloadFails ? 1 : 0};; esac\nexit 0\n`, { mode: 0o755 });
  const envFile = path.join(dir, "reflect-origin.env"), caddyfile = path.join(dir, "Caddyfile");
  const envText = opts.env === undefined ? `REFLECT_ORIGIN_SECRET=${GOOD}\nREFLECT_ORIGIN_SECRET_NEXT=${NEXT}\n` : opts.env;
  if (envText !== null) fs.writeFileSync(envFile, envText);
  const live = opts.caddyfile === undefined ? "old config\n" : opts.caddyfile;
  if (live !== null) fs.writeFileSync(caddyfile, live);
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, ORIGIN_ENV: envFile, CADDYFILE: caddyfile,
    CADDY_DROPIN: path.join(dir, "dropin", "reflect-origin.conf"), DEPLOY_DIR: path.resolve("deploy") };
  const gate = (...args: string[]) => spawnSync("bash", [GATE, ...args], { encoding: "utf8", env });
  return { dir, log, envFile, caddyfile, env, gate, logged: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "") };
}
const candidate = (s: { dir: string }, text = "good config\n") => { const f = path.join(s.dir, "candidate"); fs.writeFileSync(f, text); return f; };

test("template: no default value for a secret, in either template", () => {
  for (const t of [ENFORCE, OBSERVE]) {
    assert.doesNotMatch(t, /origin-secret-unset/);
    assert.doesNotMatch(t, /\{\$[A-Z_]+:/, "a {$VAR:default} would load with a value published in this repo");
    assert.match(t, /header X-Origin-Auth \{\$REFLECT_ORIGIN_SECRET\}$/m);
    assert.match(t, /header X-Origin-Auth \{\$REFLECT_ORIGIN_SECRET_NEXT\}$/m);
  }
});

test("template: enforcing config has the header on the matcher that lets requests in; observe config doesn't", () => {
  const site = ENFORCE.match(/@site \{[^}]*(\{\$[^}]*\}[^}]*)*\}/)?.[0] ?? "";
  assert.match(site, /path \/__SECRET__ \/__SECRET__\/\*/);
  assert.match(site, /header X-Origin-Auth/);
  assert.doesNotMatch(ENFORCE, /X-Origin-Auth-Seen|@authed/);
  assert.match(OBSERVE, /^\t@site path \/__SECRET__ \/__SECRET__\/\*$/m);
  assert.match(OBSERVE, /^\theader @authed X-Origin-Auth-Seen ok$/m);
});

test("template: the two differ only in the gate", () => {
  const body = (t: string) => t.slice(t.indexOf(":80 {")).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const norm = (t: string) => body(t)
    .replace(/\t@site \{[\s\S]*?\n\t\}\n/, "GATE\n")
    .replace(/\t@site path [^\n]*\n\t@authed \{[\s\S]*?\n\t\}\n\theader @authed [^\n]*\n/, "GATE\n");
  assert.equal(norm(OBSERVE), norm(ENFORCE));
  assert.match(norm(ENFORCE), /GATE/);
});

test("template: a request without a visitor address never reaches the app with an empty header", () => {
  for (const t of [ENFORCE, OBSERVE]) {
    const site = t.slice(t.indexOf("handle @site {"));
    const set = site.indexOf("request_header @noVisitor X-Forwarded-For {remote_host}"), proxy = site.indexOf("reverse_proxy 127.0.0.1:8124");
    assert.match(site, /@noVisitor not header_regexp X-Forwarded-For \\S\n/);
    assert.ok(set >= 0 && set < proxy, "filled in before the proxy passes it on");
    assert.match(site, /header_up X-Forwarded-For \{http\.request\.header\.X-Forwarded-For\}/, "a valid one still passes as it was");
  }
});

test("render: every placeholder is replaced, including the second secret on the path line", () => {
  const s = sandbox();
  for (const mode of ["enforce", "observe"]) {
    const r = s.gate("render", mode, "PATHSECRET123", "site.vercel.app", "1-2-3-4.sslip.io");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /path \/PATHSECRET123 \/PATHSECRET123\/\*/);
    assert.doesNotMatch(r.stdout, /__[A-Z_]+__/);
    assert.match(r.stdout, /^1-2-3-4\.sslip\.io \{$/m);
    assert.match(r.stdout, /uri strip_prefix \/PATHSECRET123$/m);
    assert.match(r.stdout, /header_up Host site\.vercel\.app$/m);
  }
  assert.notEqual(s.gate("render", "nonsense", "x", "y", "z").status, 0);
});

test("check-env: both secrets are required and must be 32+ letters and digits; a value is never printed", () => {
  const run = (a?: string, b?: string) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
    if (a !== undefined) env.REFLECT_ORIGIN_SECRET = a;
    if (b !== undefined) env.REFLECT_ORIGIN_SECRET_NEXT = b;
    return spawnSync("bash", [GATE, "check-env"], { encoding: "utf8", env });
  };
  assert.equal(run(GOOD, NEXT).status, 0);
  for (const [a, b] of [[undefined, undefined], [GOOD, undefined], [undefined, NEXT], ["", NEXT], [GOOD, ""], ["short1", NEXT],
    [GOOD, "origin-secret-unset-see-deploy-README"], ["*".repeat(40), NEXT], [`${GOOD} x`, NEXT], [`${GOOD}\nimport evil`, NEXT]] as const) {
    const r = run(a, b);
    assert.notEqual(r.status, 0, `${a} / ${b}`);
    if (a && a !== GOOD) assert.ok(!r.stderr.includes(a), "printed a secret");
    assert.ok(!r.stderr.includes(GOOD), "printed a secret");
  }
});

test("apply: unset or bad secrets stop it before Caddy is asked and before the live file changes", () => {
  for (const env of [null, "", `REFLECT_ORIGIN_SECRET=${GOOD}\n`, `REFLECT_ORIGIN_SECRET_NEXT=${NEXT}\n`, `REFLECT_ORIGIN_SECRET=${GOOD}\nREFLECT_ORIGIN_SECRET_NEXT=origin-secret-unset-see-deploy-README\n`]) {
    const s = sandbox({ env });
    const r = s.gate("apply", candidate(s, "header X-Origin-Auth {$REFLECT_ORIGIN_SECRET}\n"));
    assert.notEqual(r.status, 0, String(env));
    assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "old config\n");
    assert.equal(s.logged(), "");
  }
});

test("apply: a config with the old fallback, a {$VAR:default} or a leftover placeholder is refused", () => {
  for (const bad of ["header X-Origin-Auth {$REFLECT_ORIGIN_SECRET:origin-secret-unset-see-deploy-README}\n", "header X-Origin-Auth {$REFLECT_ORIGIN_SECRET_NEXT:anything}\n", "path /x /__SECRET__/*\n", "__ORIGIN_HOST__ {\n"]) {
    const s = sandbox();
    const r = s.gate("apply", candidate(s, bad));
    assert.notEqual(r.status, 0, bad);
    assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "old config\n");
    assert.equal(s.logged(), "");
  }
  const s = sandbox();
  assert.equal(s.gate("apply", candidate(s, "# was __SECRET__ once, in a comment\nok\n")).status, 0, "comments don't count");
});

test("apply: a config Caddy's validate refuses isn't installed and nothing is reloaded", () => {
  const s = sandbox({ caddyFails: true });
  const r = s.gate("apply", candidate(s));
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "old config\n");
  assert.doesNotMatch(s.logged(), /reload/);
});

test("apply: Caddy validates with the secrets from the env file, then the file is installed and reloaded, keeping a backup", () => {
  const s = sandbox();
  const r = s.gate("apply", candidate(s));
  assert.equal(r.status, 0, r.stderr);
  const log = s.logged();
  assert.match(log, new RegExp(`caddy validate --adapter caddyfile --config \\S+ secret=${GOOD}`));
  assert.ok(log.indexOf("caddy validate") < log.indexOf("systemctl reload caddy"));
  assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "good config\n");
  const backups = fs.readdirSync(s.dir).filter((f) => f.startsWith("Caddyfile.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dir, backups[0]), "utf8"), "old config\n");
  assert.equal(fs.statSync(path.join(s.dir, backups[0])).mode & 0o077, 0, "a backup holds the path secret");
  assert.equal(fs.statSync(s.caddyfile).mode & 0o007, 0, "the live file holds the path secret");
});

test("apply: a failed reload puts the old file back and never restarts Caddy", () => {
  const s = sandbox({ reloadFails: true });
  const r = s.gate("apply", candidate(s));
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "old config\n");
  assert.doesNotMatch(s.logged(), /restart/, "a restart on a bad config would take the site down");
});

test("provision: creates valid secrets and the drop-in, saves the old config, and doesn't touch Caddy or enforce anything", () => {
  const s = sandbox({ env: null });
  const r = s.gate("provision");
  assert.equal(r.status, 0, r.stderr);
  const env = fs.readFileSync(s.envFile, "utf8");
  assert.match(env, /^REFLECT_ORIGIN_SECRET=[A-Za-z0-9]{32,}\nREFLECT_ORIGIN_SECRET_NEXT=[A-Za-z0-9]{32,}\n$/);
  const [, a, b] = env.match(/SECRET=(\w+)\n.*NEXT=(\w+)/s)!;
  assert.equal(a, b);
  assert.equal(fs.statSync(s.envFile).mode & 0o077, 0);
  assert.equal(fs.readFileSync(s.caddyfile, "utf8"), "old config\n");
  assert.equal(fs.readFileSync(`${s.caddyfile}.pre-origin-auth`, "utf8"), "old config\n");
  assert.equal(s.logged().trim(), "systemctl daemon-reload");
  const dropin = fs.readFileSync(s.env.CADDY_DROPIN!, "utf8");
  assert.match(dropin, /^EnvironmentFile=\S+reflect-origin\.env$/m, "no leading -: a missing file stops the unit");
  assert.match(dropin, /^ExecStartPre=\S+origin-gate\.sh check-env$/m);
  assert.match(dropin, /^ExecStart=$/m);
  assert.doesNotMatch(dropin, /--environ/, "caddy run --environ prints the secrets to the journal");
  assert.match(dropin, /^ExecReload=$/m);
  assert.ok(dropin.indexOf("ExecReload=" + path.resolve("deploy/origin-gate.sh")) < dropin.indexOf("reload --config"), "secrets are checked before the reload");
  // Run twice: the secrets and the saved original stay.
  fs.writeFileSync(s.caddyfile, "changed since\n");
  assert.equal(s.gate("provision").status, 0);
  assert.equal(fs.readFileSync(s.envFile, "utf8"), env);
  assert.equal(fs.readFileSync(`${s.caddyfile}.pre-origin-auth`, "utf8"), "old config\n");
});

test("provision: refuses an existing env file with a bad value", () => {
  const s = sandbox({ env: `REFLECT_ORIGIN_SECRET=${GOOD}\n` });
  assert.notEqual(s.gate("provision").status, 0);
  assert.equal(fs.existsSync(s.env.CADDY_DROPIN!), false);
});

test("the live-config check: the vendor's default is not live, anything serving is", () => {
  const vendorDefault = `:80 {\n\troot * /usr/share/caddy\n\tfile_server\n\t# reverse_proxy localhost:8080\n}\n`;
  const check = (text: string) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-")), "c"); fs.writeFileSync(f, text);
    return spawnSync("bash", ["-c", `. ${SETUP_LIB}; caddyfile_is_live ${f}`]).status;
  };
  assert.equal(check(vendorDefault), 1);
  assert.equal(check(`x.sslip.io {\n\t@site path /a /a/*\n}\n`), 0);
  assert.equal(check(`x.example {\n\treverse_proxy 127.0.0.1:8124\n}\n`), 0);
});

/** A fake backend behaving as the given Caddy mode, so `verify` can be tested end to end over HTTP. */
async function fake(mode: "observe" | "enforce" | "open", opts: { doorSends?: boolean } = {}) {
  const ok = (h: unknown) => h === GOOD || h === NEXT;
  const origin = http.createServer((req, res) => {
    const auth = req.headers["x-origin-auth"];
    const inPath = req.url?.startsWith("/SEC");
    if (!inPath) return void res.writeHead(404).end();
    if (mode === "enforce" && !ok(auth)) return void res.writeHead(404).end();
    if (mode === "observe" && ok(auth)) res.setHeader("X-Origin-Auth-Seen", "ok");
    res.writeHead(200).end("site");
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = (origin.address() as { port: number }).port;
  const door = http.createServer((_req, res) => {
    const headers = opts.doorSends ? { "x-origin-auth": GOOD } : undefined;
    http.get({ host: "127.0.0.1", port: originPort, path: "/SEC/", headers }, (up) => {
      res.writeHead(up.statusCode ?? 500, up.headers); up.pipe(res);
    });
  });
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  return { originUrl: `http://127.0.0.1:${originPort}/SEC`, doorUrl: `http://127.0.0.1:${(door.address() as { port: number }).port}`,
    close: () => { origin.close(); door.close(); } };
}
function verify(s: ReturnType<typeof sandbox>, mode: string, f: { originUrl: string; doorUrl: string }) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn("bash", [GATE, "verify", mode], { env: { ...s.env, ORIGIN_URL: f.originUrl, FRONT_DOOR: f.doorUrl } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
  });
}

test("verify observe: passes only when the front door really sends the header", async () => {
  const s = sandbox();
  let f = await fake("observe", { doorSends: true });
  let r = await verify(s, "observe", f); f.close();
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes(GOOD) && !r.out.includes(NEXT), "printed a secret");
  f = await fake("observe", { doorSends: false });
  r = await verify(s, "observe", f); f.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+front door/);
  assert.doesNotMatch(r.out, /FAIL\s+origin/, "the origin lines already pass before Vercel is touched");
});

test("verify enforce: passes when only the secrets get in, fails if the door has no header or the origin is open", async () => {
  const s = sandbox();
  let f = await fake("enforce", { doorSends: true });
  let r = await verify(s, "enforce", f); f.close();
  assert.equal(r.code, 0, r.out);
  f = await fake("enforce", { doorSends: false });
  r = await verify(s, "enforce", f); f.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+front door/);
  f = await fake("open", { doorSends: true });
  r = await verify(s, "enforce", f); f.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+origin, no header/);
  assert.match(r.out, /FAIL\s+origin, wrong header/);
});

test("verify: nothing answering is a failure, not a pass", async () => {
  const s = sandbox();
  const r = await verify(s, "enforce", { originUrl: "http://127.0.0.1:9/SEC", doorUrl: "http://127.0.0.1:9" });
  assert.equal(r.code, 1, r.out);
});
