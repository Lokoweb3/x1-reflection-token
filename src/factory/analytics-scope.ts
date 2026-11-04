/** Filter before aggregation and keep platform and per-token results in separate caches. */
export function scopedAnalytics<T extends { mint: string }, R>(
  targets: () => T[],
  aggregate: (targets: T[], mint?: string) => Promise<R>,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { at: number; data: Promise<R> }>();
  return (mint?: string): Promise<R> => {
    const all = targets();
    const selected = mint === undefined ? all : all.filter((t) => t.mint === mint);
    // Reject unknown/empty filters rather than silently returning platform totals.
    if (mint !== undefined && !selected.length) throw new Error("Unknown analytics mint");
    const key = mint ?? "all";
    const at = now();
    for (const [k, entry] of cache) if (at - entry.at >= 30_000) cache.delete(k);
    const hit = cache.get(key);
    if (hit) return hit.data;
    const data = aggregate(selected, mint);
    cache.set(key, { at, data });
    data.catch(() => {
      if (cache.get(key)?.data === data) cache.delete(key);
    });
    return data;
  };
}
