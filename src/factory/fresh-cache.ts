/**
 * A short-lived cache in front of a chain read. Past its freshness an entry is refreshed like a
 * new one: asked for admission and read once, however many requests come in meanwhile.
 */
export function freshCache<T>(freshMs: number, maxEntries: number) {
  const entries = new Map<string, { at: number; data: T }>();
  const loading = new Map<string, Promise<T>>();
  return {
    /** The value of `key`: cached, or being read, or read now if `admit()` allows (else `refused()` is thrown). */
    async get(key: string, admit: () => boolean, refused: () => Error, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < freshMs) return hit.data;
      const running = loading.get(key);
      if (running) return running;
      if (!admit()) throw refused();
      const p = load().then((data) => {
        entries.set(key, { at: Date.now(), data });
        if (entries.size > maxEntries) entries.clear();
        return data;
      }).finally(() => loading.delete(key));
      loading.set(key, p);
      return p;
    },
  };
}
