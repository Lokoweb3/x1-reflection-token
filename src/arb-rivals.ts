/**
 * "Who beat us": for each race the arb bot lost (state/arb-lost.jsonl, and older "gap gone" lines in
 * state/arb-bot.log), find on-chain the transaction that closed the gap first, and who sent it.
 *
 * For a lost race at time T through pools P, it lists every transaction in P's pools from T − 45 s to T + 2 s.
 * The rival is the latest successful one, not ours, before T that touches two or more of the route's pools
 * (an arb); if none did, the latest one touching any of them (a plain trade moved the price back). The
 * "opener" is the latest other successful transaction before the rival, normally the swap that opened the
 * gap, so `slotsAfterOpen` is how fast the rival reacted. It also reads the rival's priority fee, swap count,
 * and the XNT its fee payer gained (its profit, fee included).
 *
 * Results are cached in state/arb-rivals.jsonl, one line per lost race. Read-only: it never signs anything.
 */
import fs from "node:fs";
import path from "node:path";

export interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown }
export interface LostRace { key: string; at: number; name: string; pools: string[] }
export interface Rival {
  key: string; at: number; name: string;
  /** "arb" (touched 2+ of the route's pools), "trade" (a single-pool trade moved the price back), or "unknown". */
  kind: "arb" | "trade" | "unknown";
  wallet?: string; signature?: string; slot?: number; slotsAfterOpen?: number | null; secondsBeforeUs?: number;
  cuPrice?: number; fee?: number; swaps?: number; profit?: number | null; alsoFailed: number;
}

const WSOL = "So11111111111111111111111111111111111111112";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * Pick the transaction that beat us from each route pool's signatures (newest first, as the RPC returns them).
 * Pure, so it's tested without the network.
 */
export function pickRival(race: LostRace, sigsByPool: Map<string, SigInfo[]>, mine: Set<string>, windowSecs = 45) {
  const from = race.at / 1000 - windowSecs, to = race.at / 1000 + 2;
  const touched = new Map<string, { s: SigInfo; pools: number }>();
  for (const pool of race.pools) for (const s of sigsByPool.get(pool) ?? []) {
    if (s.blockTime === null || s.blockTime < from || s.blockTime > to || mine.has(s.signature)) continue;
    const t = touched.get(s.signature);
    touched.set(s.signature, { s, pools: (t?.pools ?? 0) + 1 });
  }
  const all = [...touched.values()].sort((a, b) => b.s.slot - a.s.slot);
  const ok = all.filter((x) => !x.s.err && (x.s.blockTime ?? 0) <= race.at / 1000);
  const arb = ok.find((x) => x.pools >= 2);
  const pick = arb ?? ok[0];
  const opener = pick ? ok.find((x) => x.s.slot < pick.s.slot || (x.s.slot === pick.s.slot && x !== pick && x.pools < pick.pools)) : undefined;
  return {
    kind: (arb ? "arb" : pick ? "trade" : "unknown") as Rival["kind"],
    pick: pick?.s, opener: opener?.s,
    alsoFailed: all.filter((x) => x.s.err && x.pools >= 2).length,
  };
}

/** The XNT (plain + wrapped) a transaction's fee payer gained, fee included, from a jsonParsed transaction. */
export function payerGain(tx: { meta: { preBalances: number[]; postBalances: number[]; preTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]; postTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[] } }, payer: string) {
  const w = (l?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]) => (l ?? []).filter((b) => b.owner === payer && b.mint === WSOL).reduce((a, b) => a + Number(b.uiTokenAmount.amount), 0);
  return (tx.meta.postBalances[0] - tx.meta.preBalances[0] + w(tx.meta.postTokenBalances) - w(tx.meta.preTokenBalances)) / 1e9;
}

/** The compute-unit price (µL/CU) a transaction set, from its ComputeBudget instruction (base58 data). */
export function cuPriceOf(ixs: { programId: string; data?: string }[]) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (const ix of ixs) {
    if (ix.programId !== COMPUTE_BUDGET || !ix.data) continue;
    let n = 0n;
    for (const c of ix.data) n = n * 58n + BigInt(A.indexOf(c));
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    const zeros = ix.data.length - ix.data.replace(/^1+/, "").length;
    const b = Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
    if (b[0] === 3 && b.length >= 9) return Number(b.readBigUInt64LE(1));
  }
  return 0;
}

/** Runs the lookups against an RPC, slowly (it shares the public RPC with the bot), caching what it finds. */
export function createRivals(o: { rpc: string; stateDir: string; me: string; log?: (s: string) => void }) {
  const file = path.join(o.stateDir, "arb-rivals.jsonl");
  const done = new Map<string, Rival>();
  try { for (const l of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l) as Rival; done.set(r.key, r); } } catch { /* none yet */ }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    for (let i = 0; ; i++) {
      await sleep(250);
      try {
        const r = await fetch(o.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
        if (r.status === 429) throw new Error("429");
        const j = await r.json() as { result?: T; error?: unknown };
        if (j.error) throw new Error(JSON.stringify(j.error));
        return j.result as T;
      } catch (e) { if (i >= 4) throw e; await sleep(1000 * 2 ** i); }
    }
  }
  /** A pool's signatures back to `from` (unix seconds), newest first. */
  async function sigs(pool: string, from: number) {
    const out: SigInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await rpc<SigInfo[]>("getSignaturesForAddress", [pool, { limit: 1000, ...(before ? { before } : {}) }]);
      out.push(...r);
      if (r.length < 1000 || (r.at(-1)!.blockTime ?? 0) < from) break;
      before = r.at(-1)!.signature;
    }
    return out;
  }
  async function resolve(race: LostRace): Promise<Rival> {
    const byPool = new Map<string, SigInfo[]>();
    for (const p of race.pools) byPool.set(p, await sigs(p, race.at / 1000 - 60));
    const { kind, pick, opener, alsoFailed } = pickRival(race, byPool, new Set());
    const base: Rival = { key: race.key, at: race.at, name: race.name, kind, alsoFailed };
    if (!pick) return base;
    const tx = await rpc<{ slot: number; meta: Parameters<typeof payerGain>[0]["meta"] & { fee: number; logMessages?: string[] }; transaction: { message: { accountKeys: { pubkey: string }[]; instructions: { programId: string; data?: string }[] } } } | null>(
      "getTransaction", [pick.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    const wallet = tx?.transaction.message.accountKeys[0]?.pubkey;
    if (wallet === o.me) return { ...base, kind: "unknown" };
    return { ...base, wallet, signature: pick.signature, slot: pick.slot, slotsAfterOpen: opener ? pick.slot - opener.slot : null,
      secondsBeforeUs: pick.blockTime !== null ? Math.round(race.at / 1000 - pick.blockTime) : undefined,
      cuPrice: tx ? cuPriceOf(tx.transaction.message.instructions) : undefined, fee: tx ? tx.meta.fee / 1e9 : undefined,
      swaps: tx?.meta.logMessages?.filter((l) => l.includes("Instruction: Swap")).length, profit: tx && wallet ? payerGain(tx, wallet) : null };
  }
  let busy = false;
  /** Resolve up to `max` races not looked up yet (newest first; each at least 20 s old so the RPC has indexed it). */
  async function run(races: LostRace[], max = 8) {
    if (busy) return 0;
    busy = true;
    let n = 0;
    try {
      for (const r of [...races].sort((a, b) => b.at - a.at)) {
        if (n >= max) break;
        if (done.has(r.key) || !r.pools.length || Date.now() - r.at < 20_000) continue;
        try {
          const x = await resolve(r);
          done.set(r.key, x);
          fs.appendFileSync(file, JSON.stringify(x) + "\n");
          n++;
        } catch (e) { o.log?.(`rivals: ${r.name} not looked up: ${e instanceof Error ? e.message : String(e)}`); break; }
      }
    } finally { busy = false; }
    return n;
  }
  return { run, all: () => [...done.values()], get: (key: string) => done.get(key) };
}
