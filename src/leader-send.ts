/**
 * Send a signed transaction straight to the next few block producers, through the RPC port each one
 * advertises in gossip, alongside the normal RPC send: a transaction reaches the validator that will
 * include it without waiting for the public RPC to forward it.
 *
 * It follows the current slot over the websocket, reads the epoch's leader schedule once per epoch,
 * and the validators' RPC addresses every 10 minutes. Sends are fire-and-forget (a validator that
 * doesn't answer is skipped); stats() says how many went out and how many were accepted.
 */
import { Connection } from "@solana/web3.js";

export function createLeaderSender(conn: Connection, o: { ahead?: number; timeoutMs?: number; log?: (s: string) => void } = {}) {
  const ahead = o.ahead ?? 4, timeoutMs = o.timeoutMs ?? 1500;
  let slot = 0, rpcOf = new Map<string, string>(), rpcAt = 0;
  let schedule: { epoch: number; first: number; bySlot: Map<number, string> } | null = null;
  const stats = { sends: 0, accepted: 0, noLeader: 0 };
  conn.onSlotChange((s) => { slot = s.slot; });

  async function refresh() {
    if (Date.now() - rpcAt > 10 * 60_000) {
      const nodes = await conn.getClusterNodes();
      rpcOf = new Map(nodes.filter((n) => n.rpc).map((n) => [n.pubkey, `http://${n.rpc}`]));
      rpcAt = Date.now();
    }
    const ep = await conn.getEpochInfo("processed");
    if (!slot) slot = ep.absoluteSlot;
    if (!schedule || schedule.epoch !== ep.epoch) {
      const first = ep.absoluteSlot - ep.slotIndex, s = await conn.getLeaderSchedule(); // the current epoch's
      const bySlot = new Map<number, string>();
      for (const [id, idx] of Object.entries(s ?? {})) for (const i of idx) bySlot.set(first + i, id);
      schedule = { epoch: ep.epoch, first, bySlot };
    }
  }
  const ready = refresh().catch((e) => o.log?.(`leader send: not ready: ${e instanceof Error ? e.message : String(e)}`));
  setInterval(() => { refresh().catch(() => undefined); }, 60_000).unref();

  /** The RPC addresses of the validators producing the next `ahead` slots (each once). */
  function targets() {
    const out = new Set<string>();
    for (let s = slot; s < slot + ahead; s++) { const id = schedule?.bySlot.get(s); const url = id && rpcOf.get(id); if (url) out.add(url); }
    return [...out];
  }

  /** Send `raw` to the upcoming leaders (doesn't wait for them). */
  function send(raw: Uint8Array) {
    void ready.then(() => {
      const urls = targets();
      if (!urls.length) { stats.noLeader++; return; }
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64", skipPreflight: true, maxRetries: 0 }] });
      for (const url of urls) {
        stats.sends++;
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) })
          .then((r) => r.json()).then((j: { result?: string }) => { if (j.result) stats.accepted++; }).catch(() => undefined);
      }
    });
  }
  return { send, targets, stats: () => ({ ...stats }) };
}
