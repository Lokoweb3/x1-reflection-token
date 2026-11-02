/**
 * Journaling a trade before it is sent (the peg keeper and limit buys, src/peg.ts and src/limit.ts), so a crash or a
 * confirmation that times out can't make the bot forget a trade that landed (and spend its budget twice) or count one
 * that didn't.
 *
 * The caller writes its intent to its state file, then sends inside `whenSigned(hook, ...)`: the engine's send
 * (src/arb-engine.ts) calls `signed(signature, lastValidBlockHeight)` after signing and before broadcasting, so the
 * hook can add the signature to the journaled intent. A later check settles a leftover intent with `settleIntent`.
 *
 * An intent is forgotten only on proof (src/send-fate.ts). Without proof it stays and blocks new trades ("unresolved"):
 * the caller alerts with `unresolvedHelp`, and `scripts/resolve-intent.ts` records a person's decision.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { Connection, PublicKey } from "@solana/web3.js";
import { writeFileDurable } from "./factory/durable.js";
import { fateOfSend, type SendFate } from "./send-fate.js";

type Hook = (signature: string, lastValidBlockHeight: number) => void;
const hooks = new AsyncLocalStorage<Hook>();

/** Run `send` with `hook` told each transaction's signature before it is broadcast. */
export const whenSigned = <T>(hook: Hook, send: () => Promise<T>) => hooks.run(hook, send);
/** Called by a sender after signing and before broadcasting. */
export const signed = (signature: string, lastValidBlockHeight: number) => hooks.getStore()?.(signature, lastValidBlockHeight);

export interface Intent { signature?: string; lastValidBlockHeight?: number; at?: string }
export type IntentVerdict = "landed" | "dropped" | "pending" | "unresolved";

/**
 * What became of a journaled intent: "landed" (count it), "dropped" (it never went out, failed, or provably never
 * landed: forget it), "pending" (still in flight: don't trade again yet) or "unresolved" (past its blockhash, but the
 * chain gave no proof either way: don't trade again until a person decides or a later check finds proof). An intent
 * without a signature was never broadcast: the signature is journaled before the broadcast.
 */
export function intentVerdict(i: Intent, fate: SendFate["fate"] | null): IntentVerdict {
  if (!i.signature || i.lastValidBlockHeight === undefined) return "dropped";
  if (fate === "landed") return "landed";
  if (fate === "failed" || fate === "never-landed") return "dropped";
  if (fate === "unknown") return "unresolved";
  return "pending";
}

const resolutionsFile = (stateDir: string) => path.join(stateDir, "intent-resolutions.json");
/** A person's decisions, by signature. Unreadable means no decisions: the intent just stays. */
function readResolutions(stateDir: string): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(resolutionsFile(stateDir), "utf8")); } catch { return {}; }
}
/** Record a person's decision on an unresolved intent (scripts/resolve-intent.ts); the next check acts on it. */
export function recordResolution(stateDir: string, signature: string, verdict: "landed" | "dropped") {
  fs.mkdirSync(stateDir, { recursive: true });
  writeFileDurable(resolutionsFile(stateDir), JSON.stringify({ ...readResolutions(stateDir), [signature]: verdict }, null, 2) + "\n");
}

export async function settleIntent(conn: Connection, i: Intent, ctx: { wallet: PublicKey; stateDir: string }): Promise<IntentVerdict> {
  if (!i.signature || i.lastValidBlockHeight === undefined) return intentVerdict(i, null);
  const decided = readResolutions(ctx.stateDir)[i.signature];
  if (decided === "landed" || decided === "dropped") return decided;
  const f = await fateOfSend(conn, { signature: i.signature, lastValidBlockHeight: i.lastValidBlockHeight, wallet: ctx.wallet, sentAt: i.at ? Date.parse(i.at) : NaN });
  return intentVerdict(i, f.fate);
}

/** How long an unresolved intent stays quiet: most clear by themselves within a check or two. */
export const UNRESOLVED_ALERT_MS = 15 * 60_000;
export const unresolvedOverdue = (i: Intent, now: number) => !i.at || !(now - Date.parse(i.at) < UNRESOLVED_ALERT_MS);
export const unresolvedHelp = (signature: string) =>
  `can't prove whether ${signature} landed, so no new trade until that's settled. Check it (https://explorer.x1.xyz/tx/${signature}), then run: npx tsx scripts/resolve-intent.ts ${signature} landed|dropped`;
