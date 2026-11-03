/**
 * When the crank may give up on a graduation step and take the irreversible way out: refund a
 * full curve instead of creating its pool, or burn a pool's LP instead of locking it.
 *
 * Passing the deadline only makes those actions possible; it says nothing about why the send
 * just failed. A timeout, a rate limit, a dead RPC, an empty crank wallet or a compute limit set
 * too low all look like a failed send and none of them means the step can't succeed. So the
 * crank asks the chain directly and acts only when a simulation against fresh state is refused
 * by a program, the same way, more than once, some time apart.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ERRORS } from "../program-errors.js";

/** Sightings of the same refusal the crank needs, and the least time between the first and the last. */
export const REFUSALS_NEEDED = 2;
export const REFUSAL_SPAN_SECS = 60;

/** Anchor's framework errors (wrong account, missing account, unknown instruction, ...) stop below this. */
const FIRST_PROGRAM_ERROR = 6000;
/** Curve errors that say nothing about whether the step can work: the state moved, or anyone can top `auth` up. */
const curveCode = (name: string) => FIRST_PROGRAM_ERROR + PROGRAM_ERRORS.curve.findIndex((r) => r[0] === name);
const NOT_PROOF = new Set([curveCode("WrongStatus"), curveCode("InsufficientReserve")]);

const SYSTEM = SystemProgram.programId.toBase58();
/** SystemError::AccountAlreadyInUse: the one thing the system program says that money can't fix (someone took the address). */
const SYSTEM_ADDRESS_TAKEN = 0;
/** TokenError::NotRentExempt and InsufficientFunds, in both token programs. */
const TOKEN_SHORT = new Set([0, 1]);
const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
/** "Transfer: insufficient lamports 1, need 2" (system program), "Error: insufficient funds" (token programs), "... insufficient funds for instruction" (runtime), "Error: Lamport balance below rent-exempt threshold" (token programs). */
const SHORT_OF_FUNDS = /insufficient (lamports|funds)|below rent-exempt/i;

/**
 * Whether the failure is, or may be, a shortage of funds, which a top-up cures: no reason for an
 * irreversible step. By what the chain returned first and the log text second, so a changed line
 * doesn't lose the check. Of the system program only an address already taken counts as a refusal
 * (see above), so a failure of its in a form not known here also keeps the LP.
 */
function fundingFailure(failed: string, detail: unknown, custom: number | null, logs: readonly string[]) {
  if (detail === "InsufficientFunds" || detail === "AccountNotRentExempt" || logs.some((l) => SHORT_OF_FUNDS.test(l))) return true;
  if (failed === SYSTEM) return custom !== SYSTEM_ADDRESS_TAKEN;
  return TOKEN_PROGRAMS.has(failed) && custom !== null && TOKEN_SHORT.has(custom);
}

/**
 * What a failed simulation shows: a short label of the program's refusal, or null when it isn't
 * one (a transaction-level error like an unpayable fee, a blown compute limit, a shortage of funds
 * at any depth, or a request this program doesn't accept, which is a bug or a version mismatch on
 * our side). A failure log in a form this doesn't recognise names no program, so it isn't one either.
 */
export function chainRefusal(err: unknown, logs: readonly string[] | null | undefined, curveProgram: PublicKey): string | null {
  const failure = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(failure) || failure.length !== 2 || !logs?.length) return null;
  if (logs.some((l) => /exceeded CUs meter|computational budget exceeded/i.test(l))) return null;
  // The innermost program failed first; the callers that pass the failure on are logged after it.
  const failed = logs.map((l) => /^Program (\S+) failed: /.exec(l)?.[1]).find(Boolean);
  if (!failed) return null;
  const detail = failure[1] as string | { Custom?: unknown };
  if (detail === "ComputationalBudgetExceeded") return null;
  const custom = typeof detail === "object" && detail !== null && typeof detail.Custom === "number" ? detail.Custom : null;
  if (fundingFailure(failed, detail, custom, logs)) return null;
  if (failed === curveProgram.toBase58() && (custom === null || custom < FIRST_PROGRAM_ERROR || NOT_PROOF.has(custom))) return null;
  return `${failed}: ${custom !== null ? `custom ${custom}` : JSON.stringify(detail)}`;
}

/** The refusals seen for each step. In memory only: a restart starts counting again, which only delays. */
export class RefusalWatch {
  private seen = new Map<string, { what: string; first: number; count: number }>();

  /** The step would work now, or its failure isn't a refusal: earlier sightings no longer count. */
  clear(key: string) { this.seen.delete(key); }

  /** Record one simulation's verdict; true once this same refusal has been seen often and long enough. */
  note(key: string, what: string | null, now: number) {
    if (what === null) { this.clear(key); return false; }
    const s = this.seen.get(key);
    if (!s || s.what !== what) { this.seen.set(key, { what, first: now, count: 1 }); return false; }
    s.count++;
    return s.count >= REFUSALS_NEEDED && now - s.first >= REFUSAL_SPAN_SECS;
  }
}
