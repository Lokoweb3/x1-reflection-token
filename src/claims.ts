/**
 * Holder passes, distributor side (distribution.holderRewards = "claims"). Each cycle the
 * rewards credited to passes (in `owed` as "pass:<mint>") are folded into every pass's
 * cumulative total and published as one Merkle root, funding the on-chain pool in the same
 * transaction. The root is journaled in state before it's sent, and the next cycle settles
 * or retries it from what the chain shows, so a crash can't double-fund or lose rewards.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Config, xnt } from "./config.js";
import { State, addOwed, logEvent, record, saveState } from "./state.js";
import { outcome, run, sendAndConfirm, sign, simulate, withPriority } from "./tx.js";
import { buildTree, initHolderPoolIx, readHolderPool, setRootIx } from "./holder-pass.js";

export const claimsMode = (cfg: Config) => cfg.distribution.holderRewards === "claims";
/** Owed-key prefix for rewards allocated to a holder pass. */
export const PASS = "pass:";
export function lockerProgram(cfg: Config) {
  if (!cfg.locker?.programId) throw new Error("holderRewards = claims needs locker.programId");
  return new PublicKey(cfg.locker.programId);
}

export interface ClaimsCtx { cfg: Config; conn: Connection; mint: PublicKey; distributor: Keypair; execute: boolean }


/** Move a confirmed root's totals into state and clear what it paid from `owed`. */
export function settleRoot(s: State) {
  const p = s.claims!.pending!;
  s.claims!.cumulative = p.cumulative;
  s.claims!.epoch = p.epoch;
  let sum = 0n;
  for (const [pass, d] of Object.entries(p.delta)) { addOwed(s, PASS + pass, -BigInt(d)); sum += BigInt(d); }
  record(s, "claims-root", `epoch ${p.epoch}: ${xnt(sum)} added for ${Object.keys(p.delta).length} pass(es)`, p.signature);
  logEvent({ kind: "payout", signature: p.signature, total: sum.toString(), payments: Object.entries(p.delta), claims: true, epoch: p.epoch });
  s.claims!.pending = null;
  saveState(s);
}

/** A root sent last cycle: settle it if the chain has it, drop it if it expired, else wait. */
export async function reconcileRoot(ctx: ClaimsCtx, s: State): Promise<"done" | "wait"> {
  const p = s.claims?.pending;
  if (!p) return "done";
  const pool = await readHolderPool(ctx.conn, lockerProgram(ctx.cfg), ctx.mint);
  if (pool && pool.epoch >= BigInt(p.epoch) && pool.root.toString("hex") === p.root) { settleRoot(s); return "done"; }
  const o = await outcome(ctx.conn, p.signature, p.lastValidBlockHeight);
  if (o === "pending") { console.log(`Holder-pass root ${p.signature} still in flight; waiting.`); return "wait"; }
  if (o === "confirmed") { settleRoot(s); return "done"; }
  console.log(`Holder-pass root ${o}; it will be rebuilt and sent again.`);
  s.claims!.pending = null;
  saveState(s);
  return "done";
}

/** Publish every pass's new cumulative total as one Merkle root, funding the pool in the same transaction. */
export async function publishRoot(ctx: ClaimsCtx, s: State) {
  if (!claimsMode(ctx.cfg) || !ctx.execute) return;
  const { conn, cfg, distributor, mint } = ctx;
  const programId = lockerProgram(cfg);
  s.claims ??= { epoch: "0", cumulative: {}, pending: null };
  if (s.claims.pending) return;
  let pool = await readHolderPool(conn, programId, mint);
  if (!pool) {
    console.log("Creating this token's holder-pass pool…");
    await run(conn, withPriority([initHolderPoolIx(programId, distributor.publicKey, mint)], cfg.distribution.priorityMicroLamports), distributor);
    pool = await readHolderPool(conn, programId, mint);
    if (!pool) throw new Error("Holder-pass pool was not created");
  }
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.owed)) if (k.startsWith(PASS)) delta[k.slice(PASS.length)] = v;
  if (Object.keys(delta).length === 0) return;

  const cumulative: Record<string, string> = { ...s.claims.cumulative };
  for (const [pass, d] of Object.entries(delta)) cumulative[pass] = (BigInt(cumulative[pass] ?? "0") + BigInt(d)).toString();
  const total = Object.values(cumulative).reduce((a, v) => a + BigInt(v), 0n);
  if (pool.totalFunded > total) throw new Error(`On-chain pool is funded for ${xnt(pool.totalFunded)} but state totals ${xnt(total)}; state is behind the chain`);
  const epoch = (pool.epoch > BigInt(s.claims.epoch) ? pool.epoch : BigInt(s.claims.epoch)) + 1n;
  const { root } = buildTree(cumulative);
  const add = total - pool.totalFunded;
  console.log(`Publishing holder-pass root (epoch ${epoch}): ${Object.keys(delta).length} pass(es) credited, adding ${xnt(add)} to the pool.`);

  const signed = await sign(conn, withPriority([setRootIx(programId, distributor.publicKey, mint, root, epoch, total)], cfg.distribution.priorityMicroLamports), distributor);
  await simulate(conn, signed.tx);
  s.claims.pending = {
    epoch: epoch.toString(), root: root.toString("hex"), cumulative, delta, total: total.toString(),
    signature: signed.signature, lastValidBlockHeight: signed.lastValidBlockHeight, createdAt: new Date().toISOString(),
  };
  saveState(s); // journal before broadcasting
  try {
    await sendAndConfirm(conn, signed);
  } catch (e) {
    console.error(`Root send error: ${e instanceof Error ? e.message : e}`);
    if ((await reconcileRoot(ctx, s)) === "wait") throw new Error("Holder-pass root unresolved; the next cycle will reconcile it.");
    return;
  }
  settleRoot(s);
}

