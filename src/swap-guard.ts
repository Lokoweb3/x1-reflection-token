/**
 * Checks on a swap transaction someone else built (Jupiter's /swap API, used by scripts/solana-swap.ts),
 * before it is signed. Two independent checks, both pure:
 *
 *   checkSwapInstructions  every top-level instruction must be one a Jupiter swap needs: compute budget,
 *                          opening the wallet's own token accounts, wrapping/unwrapping SOL into/out of the
 *                          wallet's own wSOL account, and Jupiter itself. Any Approve or SetAuthority (a swap
 *                          needs neither, and an authority handed to a program's address is lost: nobody can sign
 *                          for it), any CloseAccount or System transfer that pays anyone but the wallet, and any
 *                          other program, are refused.
 *   checkSwapEffect        the simulated account post-states: the input account loses at most `amount`, the
 *                          output account gains at least `minOut`, and the wallet's lamports (wSOL included)
 *                          fall by no more than the fee budget (plus the SOL going in, or less the SOL coming out).
 *   checkWalletAccounts    every writable account in the simulation: the wallet's token accounts stay the wallet's,
 *                          with no new delegate or close authority, and lose no tokens beyond the input; and which
 *                          new accounts are the wallet's own, whose rent is all the fee budget allows for.
 */
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");

// SPL Token (and Token-2022) instruction tags.
const TOKEN_APPROVE = 4, TOKEN_SET_AUTHORITY = 6, TOKEN_CLOSE = 9, TOKEN_APPROVE_CHECKED = 13, TOKEN_SYNC_NATIVE = 17;
const SYSTEM_TRANSFER = 2;

/** Problems with a swap transaction's top-level instructions (empty: it does only what a swap needs). */
export function checkSwapInstructions(ixs: TransactionInstruction[], w: { owner: PublicKey; wsolAta: PublicKey }): string[] {
  const problems: string[] = [];
  const ours = (k: PublicKey | undefined) => !!k && (k.equals(w.owner) || k.equals(w.wsolAta));
  ixs.forEach((ix, i) => {
    const p = ix.programId, tag = ix.data[0], at = `instruction ${i}`;
    if (p.equals(COMPUTE_BUDGET) || p.equals(JUPITER_V6)) return;
    if (p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // Create (no data or 0) / CreateIdempotent (1): keys are payer, account, wallet, mint, ...
      if (ix.data.length <= 1 && (tag === undefined || tag <= 1) && ix.keys[0]?.pubkey.equals(w.owner) && ix.keys[2]?.pubkey.equals(w.owner)) return;
      problems.push(`${at}: opens a token account for someone other than this wallet`);
      return;
    }
    if (p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022_PROGRAM_ID)) {
      if (tag === TOKEN_SYNC_NATIVE) return;
      if (tag === TOKEN_CLOSE) { if (ours(ix.keys[1]?.pubkey)) return; problems.push(`${at}: closes a token account into ${ix.keys[1]?.pubkey.toBase58()}`); return; }
      if (tag === TOKEN_APPROVE || tag === TOKEN_APPROVE_CHECKED) {
        problems.push(`${at}: approves ${ix.keys[tag === TOKEN_APPROVE ? 1 : 2]?.pubkey.toBase58()} to spend a token account`);
        return;
      }
      if (tag === TOKEN_SET_AUTHORITY) {
        // SetAuthority data: tag, authority type, COption<Pubkey> (1 byte + 32).
        const next = ix.data[2] === 1 && ix.data.length >= 35 ? new PublicKey(ix.data.subarray(3, 35)) : undefined;
        problems.push(`${at}: changes a token account's authority to ${next?.toBase58() ?? "none"}`);
        return;
      }
      problems.push(`${at}: unexpected token instruction ${tag}`);
      return;
    }
    if (p.equals(SystemProgram.programId)) {
      if (ix.data.length >= 4 && ix.data.readUInt32LE(0) === SYSTEM_TRANSFER) {
        const to = ix.keys[1]?.pubkey;
        if (to?.equals(w.wsolAta)) return;
        problems.push(`${at}: sends lamports to ${to?.toBase58()}`);
        return;
      }
      problems.push(`${at}: unexpected System instruction ${ix.data.length >= 4 ? ix.data.readUInt32LE(0) : "?"}`);
      return;
    }
    problems.push(`${at}: calls an unexpected program ${p.toBase58()}`);
  });
  return problems;
}

export interface SwapEffect {
  /** What was asked: `amount` in, at least `minOut` out (base units), at most `maxFee` lamports of fees and new-account rent. */
  amount: bigint;
  minOut: bigint;
  maxFee: bigint;
  inIsSol: boolean;
  outIsSol: boolean;
  /** Simulated changes: input token units that left the wallet's input account, output units that arrived (both 0 for SOL). */
  inDebit: bigint;
  outCredit: bigint;
  /** The wallet's lamports plus its wSOL account's, after minus before. */
  solDelta: bigint;
}

/** Problems with a simulated swap's effect on the wallet (empty: it spends and receives what was asked). */
export function checkSwapEffect(e: SwapEffect): string[] {
  const problems: string[] = [];
  if (!e.inIsSol && e.inDebit > e.amount) problems.push(`it would take ${e.inDebit} of the input token, more than the ${e.amount} asked`);
  if (!e.outIsSol && e.outCredit < e.minOut) problems.push(`it would deliver ${e.outCredit} of the output token, under the ${e.minOut} minimum`);
  const floor = (e.outIsSol ? e.minOut : 0n) - (e.inIsSol ? e.amount : 0n) - e.maxFee;
  if (e.solDelta < floor) problems.push(`the wallet's SOL would change by ${e.solDelta} lamports, under the ${floor} allowed`);
  return problems;
}

/** An account as read before a simulation or returned by one (null: it doesn't exist). */
export interface AccountState { lamports: bigint; owner: PublicKey; data: Buffer }
export interface SimAccount { address: PublicKey; pre: AccountState | null; post: AccountState | null }

const TOKEN_ACCOUNT_SIZE = 165, TOKEN_2022_ACCOUNT_TYPE = 2;
/** The token account in `a`, if it really is one: owned by a token program, of a token account's shape. */
function tokenAccountOf(a: AccountState | null) {
  if (!a || a.lamports === 0n) return null;
  const legacy = a.owner.equals(TOKEN_PROGRAM_ID), t22 = a.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!legacy && !t22) return null;
  // Token-2022: the base layout, padding up to the multisig size, then an account-type byte and extensions.
  if (a.data.length !== TOKEN_ACCOUNT_SIZE && !(t22 && a.data.length > TOKEN_ACCOUNT_SIZE && a.data[TOKEN_ACCOUNT_SIZE] === TOKEN_2022_ACCOUNT_TYPE)) return null;
  const option = (at: number) => (a.data.readUInt32LE(at) === 1 ? new PublicKey(a.data.subarray(at + 4, at + 36)) : null);
  return { owner: new PublicKey(a.data.subarray(32, 64)), amount: a.data.readBigUInt64LE(64), delegate: option(72),
    delegated: a.data.readBigUInt64LE(121), closeAuthority: option(129) };
}
const same = (a: PublicKey | null, b: PublicKey | null) => (a === null || b === null ? a === b : a.equals(b));
/** Solana's rent-exempt minimum for an account of `size` bytes. */
export const rentExempt = (size: number) => BigInt(128 + size) * 6_960n;

/**
 * Check every writable account of a simulated swap (`accounts` must include the wallet's input, output and wSOL
 * accounts). Returns what's wrong, and `newRent`: the lamports the wallet may fairly spend on new accounts. That is the
 * rent of token accounts this wallet owns outright, which stays the wallet's: it comes back when they're closed.
 * Accounts for anyone else, or anything shaped like a token account that no token program owns, earn no allowance, so
 * if the wallet paid for them the swap fails the fee budget. The wSOL account's lamports are counted in the wallet's
 * SOL already, so they earn none either.
 */
export function checkWalletAccounts(accounts: SimAccount[], w: { owner: PublicKey; wsolAta: PublicKey; inAta: PublicKey | null; outAta: PublicKey | null }) {
  const problems: string[] = [];
  let newRent = 0n;
  const mineByAddress = (k: PublicKey) => k.equals(w.wsolAta) || !!w.inAta?.equals(k) || !!w.outAta?.equals(k);
  for (const { address, pre, post } of accounts) {
    if (address.equals(w.owner)) continue;
    const name = address.toBase58();
    const before = tokenAccountOf(pre), after = tokenAccountOf(post);
    const mineBefore = !!before?.owner.equals(w.owner);
    const exists = !!post && post.lamports > 0n;
    if (!mineBefore && !mineByAddress(address) && !(exists && !pre && after?.owner.equals(w.owner))) continue;
    if (!exists) {
      if (mineBefore && before!.amount > 0n && !address.equals(w.wsolAta) && !w.inAta?.equals(address)) problems.push(`it would close ${name}, which holds ${before!.amount} tokens`);
      continue;
    }
    if (!after) { problems.push(`${name} would no longer be a token account`); continue; }
    if (!after.owner.equals(w.owner)) { problems.push(`it would hand the token account ${name} to ${after.owner.toBase58()}`); continue; }
    if (after.delegate && !(same(after.delegate, before?.delegate ?? null) && after.delegated <= (before?.delegated ?? 0n)))
      problems.push(`it would let ${after.delegate.toBase58()} spend ${after.delegated} from ${name}`);
    if (!same(after.closeAuthority, before?.closeAuthority ?? null)) problems.push(`it would set ${after.closeAuthority?.toBase58() ?? "no one"} as ${name}'s close authority`);
    if (mineBefore && after.amount < before!.amount && !address.equals(w.wsolAta) && !w.inAta?.equals(address)) problems.push(`it would take ${before!.amount - after.amount} tokens from ${name}, not the swap's input`);
    if (!pre && !address.equals(w.wsolAta)) {
      const rent = rentExempt(post!.data.length);
      newRent += post!.lamports < rent ? post!.lamports : rent;
    }
  }
  return { problems, newRent };
}

/** The amount of an SPL token account (Token or Token-2022), from its raw data. */
export const tokenAccountAmount = (data: Buffer | Uint8Array) => (data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n);
