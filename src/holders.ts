import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountState, TOKEN_2022_PROGRAM_ID, getTransferFeeAmount, unpackAccount,
} from "@solana/spl-token";

export const BURN_OWNERS = ["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"];

export interface TokenAccountRow {
  address: PublicKey;
  owner: string;
  amount: bigint;
  withheld: bigint;
  frozen: boolean;
}

/** Every Token-2022 account for the mint, with balance and withheld transfer fees. */
export async function scanTokenAccounts(conn: Connection, mint: PublicKey): Promise<TokenAccountRow[]> {
  const raw = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  return raw.map(({ pubkey, account }) => {
    const acc = unpackAccount(pubkey, account, TOKEN_2022_PROGRAM_ID);
    return {
      address: pubkey,
      owner: acc.owner.toBase58(),
      amount: acc.amount,
      withheld: getTransferFeeAmount(acc)?.withheldAmount ?? 0n,
      frozen: acc.isFrozen || (acc as { state?: AccountState }).state === AccountState.Frozen,
    };
  });
}

export interface EligibilityRules {
  excluded: Set<string>;
  excludeOffCurve: boolean;
  minHolding: bigint;
}

/** Sum balances per wallet and drop excluded wallets, PDAs (optional) and dust holders. */
export function eligibleBalances(rows: TokenAccountRow[], rules: EligibilityRules): Map<string, bigint> {
  const perOwner = new Map<string, bigint>();
  for (const r of rows) {
    if (r.frozen || r.amount === 0n || rules.excluded.has(r.owner)) continue;
    perOwner.set(r.owner, (perOwner.get(r.owner) ?? 0n) + r.amount);
  }
  for (const [owner, bal] of perOwner) {
    const offCurve = !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
    if (bal < rules.minHolding || (rules.excludeOffCurve && offCurve)) perOwner.delete(owner);
  }
  return perOwner;
}

/**
 * Split freshly collected fee tokens: `lpBps` of them go to auto-LP, half kept as
 * the token side and half sold for the XNT side. The rest is sold for holders.
 */
export function splitForLp(amount: bigint, lpBps: number) {
  const lp = (amount * BigInt(lpBps)) / 10_000n;
  const keep = lp / 2n;
  return { keep, sell: lp - keep };
}

/** Pro-rata split of `pot`, rounded down; the remainder stays unallocated. */
export function allocate(balances: Map<string, bigint>, pot: bigint): Map<string, bigint> {
  const out = new Map<string, bigint>();
  let total = 0n;
  for (const b of balances.values()) total += b;
  if (total === 0n || pot <= 0n) return out;
  for (const [owner, bal] of balances) {
    const share = (pot * bal) / total;
    if (share > 0n) out.set(owner, share);
  }
  return out;
}
