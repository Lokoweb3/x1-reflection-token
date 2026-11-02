/** Which views are charged, and on which budget: decided before any chain read. No network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { planView, type KnownSubjects } from "../src/factory/view-gate.js";
import { isFileError } from "../src/factory/limits.js";

const addr = () => Keypair.generate().publicKey.toBase58();
const creator = addr(), token = addr(), vault = addr(), nft = addr();
const known: KnownSubjects = { creators: new Set([creator]), tokens: new Set([token, vault]), nfts: new Set([nft]), isVaultMint: (m) => m === vault };
const plan = (p: string, k = known) => planView(new URL(p, "http://x"), k);

test("made-up routes and addresses cost nothing", () => {
  for (const p of ["/api/token/junk", "/api/token/junk/stats", "/api/wallet/nope", "/api/leaderboard/x", `/api/nft/${"1".repeat(44)}0`, `/api/token/${token}`, `/api/token/${token}/stats/more`, `/api/wallet/${creator}/x`, `/api/vault/${vault}/other`, "/api/vault/x/list"]) {
    assert.equal(plan(p).kind, "notFound", p);
  }
  for (const p of [`/api/token/${addr()}/stats`, `/api/leaderboard/${addr()}`, `/api/analytics?mint=${addr()}`, `/api/distribute/status?mint=${addr()}`, "/api/distribute/status", `/api/vault/${addr()}`, `/api/vault/${token}`, "/api/launches", "/api/launches?creator=x", "/api/payout-token?mint=x"]) {
    assert.equal(plan(p).kind, "refuse", p);
  }
  assert.deepEqual(plan(`/api/launches?creator=${addr()}`), { kind: "answer", value: [] }, "no launches: nothing to read");
  assert.equal(plan(`/api/vault/${vault}`, { ...known, isVaultMint: null }).kind, "notFound", "no Tax Vault here");
});

test("each real view draws on its own budget", () => {
  const lane = (p: string) => { const v = plan(p); assert.equal(v.kind, "view", p); return v.kind === "view" ? v.lane : null; };
  assert.equal(lane(`/api/launches?creator=${creator}`), "progress");
  assert.equal(lane(`/api/distribute/status?mint=${token}`), "progress");
  for (const p of [`/api/token/${token}/stats`, `/api/leaderboard/${token}`, `/api/analytics?mint=${token}`, "/api/analytics", "/api/nfts", "/api/token-list", "/api/stats", "/api/tokens", `/api/vault/${vault}`, `/api/vault/${vault}/list`, `/api/nft/${nft}`, `/api/wallet/${creator}`]) {
    assert.equal(lane(p), "known", p);
  }
  for (const p of [`/api/nft/${addr()}`, `/api/wallet/${addr()}`, `/api/payout-token?mint=${addr()}`]) assert.equal(lane(p), "lookup", p);
  assert.equal(plan("/api/curves").kind, "other");
  assert.equal(plan("/api/info").kind, "other");
});

test("made-up parameters can't bypass the cache: they aren't in its key", () => {
  const keys = [`/api/token/${token}/stats`, `/api/token/${token}/stats?t=1`, `/api/token/${token}/stats?mint=a`, `/api/token/${token}/stats?wallet=b`].map((p) => { const v = plan(p); return v.kind === "view" ? v.key : p; });
  assert.equal(new Set(keys).size, 1);
  const a = plan(`/api/launches?creator=${creator}&wallet=1`), b = plan(`/api/launches?creator=${creator}&mint=2`);
  assert.ok(a.kind === "view" && b.kind === "view" && a.key === b.key);
});

test("the launch flow's status is always read back fresh", () => {
  const v = plan(`/api/launches?creator=${creator}`);
  assert.ok(v.kind === "view" && v.wait && v.freshMs === 15_000);
  const d = plan(`/api/distribute/status?mint=${token}`);
  assert.ok(d.kind === "view" && d.wait && d.freshMs === 5_000);
});

test("a file error is for the log: a full disk too, with or without its code", () => {
  assert.ok(isFileError(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", syscall: "write" })));
  assert.ok(isFileError(new Error("EIO: i/o error")));
  assert.ok(isFileError(Object.assign(new Error("whatever"), { syscall: "open" })));
  assert.equal(isFileError(new Error("The launch fee is 1 USDC")), false);
  assert.equal(isFileError(new Error("fetch failed")), false);
});
