/**
 * Checks on a swap transaction someone else built (Jupiter's /swap API, used by scripts/solana-swap.ts),
 * before it is signed. Two independent checks, both pure:
 *
 *   checkSwapInstructions  every top-level instruction must be one a Jupiter swap needs: compute budget,
 *                          opening the wallet's own token accounts, wrapping/unwrapping SOL into/out of the
 *                          wallet's own wSOL account, and Jupiter itself. An Approve, SetAuthority, CloseAccount
 *                          or System transfer that hands tokens, authority or lamports to anyone but the wallet
 *                          (or Jupiter) is refused, and so is any other program.
 *   checkSwapEffect        the simulated account post-states: the input account loses at most `amount`, the
 *                          output account gains at least `minOut`, and the wallet's lamports (wSOL included)
 *                          fall by no more than the fee budget (plus the SOL going in, or less the SOL coming out).
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
  const ours = (k: PublicKey | undefined) => !!k && (k.equals(w.owner) || k.equals(w.wsolAta) || k.equals(JUPITER_V6));
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
        const delegate = ix.keys[tag === TOKEN_APPROVE ? 1 : 2]?.pubkey;
        if (delegate?.equals(JUPITER_V6)) return;
        problems.push(`${at}: approves ${delegate?.toBase58()} to spend a token account`);
        return;
      }
      if (tag === TOKEN_SET_AUTHORITY) {
        // SetAuthority data: tag, authority type, COption<Pubkey> (1 byte + 32).
        const next = ix.data[2] === 1 && ix.data.length >= 35 ? new PublicKey(ix.data.subarray(3, 35)) : undefined;
        if (next?.equals(JUPITER_V6)) return;
        problems.push(`${at}: changes a token account's authority to ${next?.toBase58() ?? "none"}`);
        return;
      }
      problems.push(`${at}: unexpected token instruction ${tag}`);
      return;
    }
    if (p.equals(SystemProgram.programId)) {
      if (ix.data.length >= 4 && ix.data.readUInt32LE(0) === SYSTEM_TRANSFER) {
        const to = ix.keys[1]?.pubkey;
        if (to && (to.equals(w.wsolAta) || to.equals(JUPITER_V6))) return;
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

/** The amount of an SPL token account (Token or Token-2022), from its raw data. */
export const tokenAccountAmount = (data: Buffer | Uint8Array) => (data.length >= 72 ? Buffer.from(data).readBigUInt64LE(64) : 0n);
