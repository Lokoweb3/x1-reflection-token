/**
 * Pinned copies of the recovery page (scripts/build-recovery.ts --pin), linked from the site
 * and the README. Each is the build of `commit`: rebuild it and compare `sha256`. The same
 * bytes are kept in src/recovery/pinned/recovery-<network>.html and served by the site at
 * /recovery, for browsers or security software that block IPFS gateways.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const RECOVERY_PAGES: Record<"testnet" | "mainnet", { cid: string; commit: string; sha256: string } | null> = {
  testnet: { cid: "bafybeidzdlu2ggduswbtr637qnsfxgvjx5ogakxkihuamexkgvpjd5aska", commit: "5d162a7", sha256: "17f0150bc0b054f078b9eab339fa2dfa3ce9b29f0e23e876b66d3dd7b37f10f6" },
  mainnet: { cid: "bafybeid64cdbdnrx26ewj7kn6bvw5mnlruikiqpvqopobpeiqgpze5mdge", commit: "e462dfb", sha256: "351fb1237a3386a1016c64037f24399da6ce799564c3937f0de5e5ba6c36924b" },
};
/** A browser link to the pinned page (a subdomain gateway: it serves HTML, unlike Pinata's public one). */
export const recoveryUrl = (network: "testnet" | "mainnet") => {
  const p = RECOVERY_PAGES[network];
  return p ? `https://${p.cid}.ipfs.dweb.link/` : null;
};

/**
 * The pinned page's bytes for the site's /recovery, or null when there is none for this
 * network or the file in the repo isn't byte-identical to the pinned one.
 */
export function pinnedRecoveryFile(root: string, network: "testnet" | "mainnet"): Buffer | null {
  const p = RECOVERY_PAGES[network];
  const f = path.join(root, "src", "recovery", "pinned", `recovery-${network}.html`);
  if (!p || !fs.existsSync(f)) return null;
  const bytes = fs.readFileSync(f);
  return crypto.createHash("sha256").update(bytes).digest("hex") === p.sha256 ? bytes : null;
}
