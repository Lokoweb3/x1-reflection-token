import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECOVERY_PAGES, pinnedRecoveryFile, recoveryUrl } from "../src/recovery/pinned.js";
import { gatewayFor, normGateway, TRUSTLESS_GATEWAY } from "../src/factory/ipfs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the recovery page the site serves is byte-identical to the pinned IPFS copy", () => {
  for (const net of ["testnet", "mainnet"] as const) {
    const p = RECOVERY_PAGES[net];
    const bytes = pinnedRecoveryFile(ROOT, net);
    if (!p) { assert.equal(bytes, null); continue; }
    assert.ok(bytes, `src/recovery/pinned/recovery-${net}.html is missing or doesn't match the pinned sha256`);
    assert.match(bytes.toString("utf8"), new RegExp(`commit <span class="mono">${p.commit}</span>`));
    assert.equal(recoveryUrl(net), `https://${p.cid}.ipfs.dweb.link/`);
  }
});

test("gateway entries: bases get the CID appended, templates get it substituted", () => {
  assert.equal(gatewayFor("https://gateway.pinata.cloud/ipfs", "bafk"), "https://gateway.pinata.cloud/ipfs/bafk");
  assert.equal(gatewayFor(TRUSTLESS_GATEWAY, "bafk"), "https://trustless-gateway.link/ipfs/bafk?format=raw");
  assert.equal(normGateway("https://ipfs.io/ipfs"), "https://ipfs.io/ipfs/");
  assert.equal(normGateway(TRUSTLESS_GATEWAY), TRUSTLESS_GATEWAY);
});
