/**
 * Payout tokens (Tax Vault `init_vault_payout`): a launch can pay its holders in another
 * token instead of XNT. This finds the token's XDEX pool against XNT and checks what the
 * program checks (no freeze authority; only metadata / group extensions, so no transfer fee,
 * hook, delegate or pause) plus this site's own rule: enough XNT in the pool that the
 * vault's swaps get a fair price. The pool is fixed in the vault for good.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getExtensionTypes, getTokenMetadata, unpackMint } from "@solana/spl-token";
import { Config, fromBaseUnits, toBaseUnits } from "../config.js";
import { REWARD_TOKEN } from "../taxvault.js";
import { XDEX_CREATE, decodePool, poolAddresses, snapshot } from "../xdex.js";

/** Smallest XNT side of the payout pool a launch may use (factory.taxVault.payoutMinPoolXnt). */
export const DEFAULT_PAYOUT_MIN_POOL_XNT = "10";
const ALLOWED_EXTENSIONS = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.GroupMemberPointer, ExtensionType.TokenGroup, ExtensionType.TokenGroupMember]);

export interface PayoutToken { mint: PublicKey; pool: PublicKey; tokenProgram: PublicKey; symbol: string; name: string; decimals: number; reserveXnt: bigint }

/** Whether this site offers payout tokens (needs the v4 program; testnet first). */
export const payoutTokensOn = (cfg: Config) => cfg.factory?.taxVault?.payoutTokens === true;

/** The pool a payout token pays through: XDEX's standard XNT pool for it, or the one XDEX's API lists. */
async function findPool(conn: Connection, cfg: Config, mint: PublicKey): Promise<PublicKey | null> {
  const xdex = new PublicKey(cfg.xdex.programId);
  const derived = poolAddresses(xdex, new PublicKey(XDEX_CREATE[cfg.network].ammConfig), mint).pool;
  const info = await conn.getAccountInfo(derived, "confirmed");
  if (info?.owner.equals(xdex)) return derived;
  try {
    const r = await fetch(`https://api.xdex.xyz/api/xendex/pool/tokens/${mint.toBase58()}/${NATIVE_MINT.toBase58()}?network=${cfg.network}`, { signal: AbortSignal.timeout(10_000) });
    const j = await r.json() as { data?: { pool_address?: string } | { pool_address?: string }[] };
    const d = Array.isArray(j.data) ? j.data[0] : j.data;
    return d?.pool_address ? new PublicKey(d.pool_address) : null;
  } catch { return null; }
}

/** Check a payout token and find its pool; throws a message the launch form shows. */
export async function payoutToken(conn: Connection, cfg: Config, mintStr: string, taxMint?: string): Promise<PayoutToken> {
  if (!payoutTokensOn(cfg)) throw new Error("Paying holders in another token isn't available on this site yet.");
  let mint: PublicKey;
  try { mint = new PublicKey(String(mintStr).trim()); } catch { throw new Error("The payout token must be a token (mint) address."); }
  if (mint.equals(NATIVE_MINT)) throw new Error("Leave the payout token empty to pay holders in XNT.");
  if (taxMint && mint.toBase58() === taxMint) throw new Error("A token can't pay its holders in itself.");
  // With the reward token as payout token, auth's reward account is also the holders' payout account.
  // The first v4 build sent that whole account to the creator; only offer it where the program keeps
  // the holders' tokens (factory.taxVault.rewardTokenPayouts, v4 from d4a1f210… / 630e4a06…).
  if (mint.equals(REWARD_TOKEN[cfg.network].mint) && cfg.factory?.taxVault?.rewardTokenPayouts !== true) throw new Error("That token is the creator reward token, so it can't also be the payout token yet. Pick another token.");
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error("That address isn't a token on this network.");
  const m = unpackMint(mint, info, info.owner);
  if (m.freezeAuthority) throw new Error("That token has a freeze authority, which could freeze the vault's payouts. Pick a token without one.");
  for (const ext of getExtensionTypes(m.tlvData)) {
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`That token has the ${ExtensionType[ext]} extension (e.g. its own transfer tax); the vault only pays in plain tokens.`);
  }
  const pool = await findPool(conn, cfg, mint);
  if (!pool) throw new Error("No XDEX pool between that token and XNT was found; the vault swaps through one.");
  const xdex = new PublicKey(cfg.xdex.programId);
  const p = decodePool(pool, await conn.getAccountInfo(pool, "confirmed"), xdex);
  const side = p.mints.findIndex((x) => x.equals(mint));
  if (side < 0 || !p.mints[1 - side].equals(NATIVE_MINT) || !p.programs[side].equals(info.owner)) throw new Error("That pool isn't the token's pool against XNT.");
  const snap = await snapshot(conn, xdex, pool, mint);
  const minXnt = toBaseUnits(cfg.factory?.taxVault?.payoutMinPoolXnt ?? DEFAULT_PAYOUT_MIN_POOL_XNT, 9);
  if (snap.reserveQuote < minXnt) {
    throw new Error(`That token's XNT pool is too thin (${fromBaseUnits(snap.reserveQuote, 9)} XNT; at least ${fromBaseUnits(minXnt, 9)} XNT) for fair swaps.`);
  }
  const md = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? await getTokenMetadata(conn, mint, "confirmed", TOKEN_2022_PROGRAM_ID).catch(() => null) : null;
  return { mint, pool, tokenProgram: info.owner, symbol: md?.symbol || `${mint.toBase58().slice(0, 4)}…`, name: md?.name ?? "", decimals: m.decimals, reserveXnt: snap.reserveQuote };
}

export const payoutTokenJson = (t: PayoutToken) => ({
  mint: t.mint.toBase58(), pool: t.pool.toBase58(), tokenProgram: t.tokenProgram.toBase58(), symbol: t.symbol, name: t.name, decimals: t.decimals,
  poolXnt: fromBaseUnits(t.reserveXnt, 9),
});
