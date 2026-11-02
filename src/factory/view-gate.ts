/**
 * Which read-only views a request may reach, decided before anything is counted or read from
 * the chain. A made-up route or a token this site doesn't have is answered here for free, so
 * it can't use up the budget that real reads need. What's left costs chain reads when no cache
 * has it, and draws on one of three budgets (LIMITS in factory-server.ts):
 *   progress  a launch's or "Distribute now" run's status, for what really exists here: junk
 *             can't reach it, so a flood can't stop a launch in progress being followed
 *   known     this site's own tokens, vaults and lock NFTs: a limited set of cached answers
 *   lookup    any valid address (a stranger's wallet, an NFT): what the site-wide cap is for
 */
import { PublicKey } from "@solana/web3.js";

/** Read-only views served through the cache, not per-action flows like curves or the faucet. */
const VIEW_ROUTES = /^\/api\/(nft\/|nfts$|token\/|token-list$|analytics$|wallet\/|leaderboard\/|stats$|tokens$|vault\/|launches$|distribute\/status$|payout-token$)/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = (s: unknown): s is string => {
  if (typeof s !== "string" || !ADDRESS.test(s)) return false;
  try { new PublicKey(s); return true; } catch { return false; }
};

/** What this site knows of, read from its records (no chain reads). */
export interface KnownSubjects {
  creators: Set<string>;
  tokens: Set<string>;
  nfts: Set<string>;
  /** Null when the Tax Vault isn't on. */
  isVaultMint: ((mint: string) => boolean) | null;
}

export type Lane = "progress" | "known" | "lookup";
export type ViewPlan =
  /** Not a cached view: the rest of the GET handler decides. */
  | { kind: "other" }
  /** No such view: a 404. */
  | { kind: "notFound" }
  /** Refused with this message; nothing to read. */
  | { kind: "refuse"; message: string }
  /** The answer needs no chain read. */
  | { kind: "answer"; value: unknown }
  /** A read through the cache, under `key`. `wait`: past `freshMs` wait for the refresh, not the old copy. */
  | { kind: "view"; lane: Lane; key: string; freshMs: number; wait: boolean };

const UNKNOWN_TOKEN = "Unknown token";
const view = (lane: Lane, key: string, freshMs = 30_000, wait = false): ViewPlan => ({ kind: "view", lane, key, freshMs, wait });

export function planView(url: URL, known: KnownSubjects): ViewPlan {
  const p = url.pathname;
  if (!VIEW_ROUTES.test(p)) return { kind: "other" };
  const mint = url.searchParams.get("mint");
  // Only the parameters each view reads are in its key, so made-up ones can't bypass the cache.
  if (p === "/api/launches") {
    const creator = url.searchParams.get("creator");
    if (!isAddress(creator)) return { kind: "refuse", message: "Not a wallet address." };
    if (!known.creators.has(creator)) return { kind: "answer", value: [] }; // no launches: nothing to read
    return view("progress", `/api/launches?creator=${creator}`, 15_000, true);
  }
  if (p === "/api/distribute/status") {
    if (!mint || !known.tokens.has(mint)) return { kind: "refuse", message: UNKNOWN_TOKEN };
    return view("progress", `${p}?mint=${mint}`, 5_000, true);
  }
  if (p === "/api/nfts" || p === "/api/token-list" || p === "/api/stats" || p === "/api/tokens") return view("known", p);
  if (p === "/api/analytics") {
    if (mint === null) return view("known", p);
    return known.tokens.has(mint) ? view("known", `${p}?mint=${mint}`) : { kind: "refuse", message: UNKNOWN_TOKEN };
  }
  if (p === "/api/payout-token") {
    if (!isAddress(mint)) return { kind: "refuse", message: "The payout token must be a token (mint) address." };
    return view("lookup", `${p}?mint=${mint}`, 60_000);
  }
  const [, , route, subject, rest, ...more] = p.split("/");
  if (!isAddress(subject) || more.length) return { kind: "notFound" };
  if (route === "token") {
    if (rest !== "stats") return { kind: "notFound" };
    return known.tokens.has(subject) ? view("known", p) : { kind: "refuse", message: UNKNOWN_TOKEN };
  }
  if (route === "leaderboard") {
    if (rest !== undefined) return { kind: "notFound" };
    return known.tokens.has(subject) ? view("known", p) : { kind: "refuse", message: UNKNOWN_TOKEN };
  }
  if (route === "vault") {
    if (rest !== undefined && rest !== "list") return { kind: "notFound" };
    if (!known.isVaultMint) return { kind: "notFound" };
    return known.isVaultMint(subject) ? view("known", p) : { kind: "refuse", message: "This token's tax isn't held by the Tax Vault." };
  }
  if (rest !== undefined) return { kind: "notFound" };
  if (route === "nft") return view(known.nfts.has(subject) ? "known" : "lookup", p);
  if (route === "wallet") return view(known.creators.has(subject) ? "known" : "lookup", p);
  return { kind: "notFound" };
}
