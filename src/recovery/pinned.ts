/**
 * Pinned copies of the recovery page (scripts/build-recovery.ts --pin), linked from the site
 * and the README. Each is the build of `commit`: rebuild it and compare `sha256`.
 */
export const RECOVERY_PAGES: Record<"testnet" | "mainnet", { cid: string; commit: string; sha256: string } | null> = {
  testnet: { cid: "bafybeidzdlu2ggduswbtr637qnsfxgvjx5ogakxkihuamexkgvpjd5aska", commit: "5d162a7", sha256: "17f0150bc0b054f078b9eab339fa2dfa3ce9b29f0e23e876b66d3dd7b37f10f6" },
  mainnet: null,
};
/** A browser link to the pinned page (a subdomain gateway: it serves HTML, unlike Pinata's public one). */
export const recoveryUrl = (network: "testnet" | "mainnet") => {
  const p = RECOVERY_PAGES[network];
  return p ? `https://${p.cid}.ipfs.dweb.link/` : null;
};
