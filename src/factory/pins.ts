/**
 * Files the site pins for a transaction the visitor hasn't signed yet: token metadata
 * (a launch's step 1, a metadata update), lock receipts (their PNG and metadata JSON) and
 * logos (uploaded before the launch form is sent). The link has to be in the transaction,
 * so the pin can't wait for it; instead each is checked some minutes later and removed
 * from Pinata if nothing ended up using it (the transaction never landed). A pin is only
 * removed when the check says so for certain; a failed check is retried, then the pin kept.
 * Links are compared by content, not spelling, and one that can't be identified keeps the pin.
 * Only what's listed above is tracked: rewards-list files are pinned without ever being tracked
 * (factory/vault.ts, scripts/crank.ts, scripts/cosigner.ts), so nothing here can remove them.
 */
import type { Config } from "../config.js";
import { cidOfUrl, sameContent, unpinOrphan } from "./ipfs.js";

/** Metadata and receipts: their transaction's blockhash is long expired by then. */
export const ORPHAN_AFTER_MS = 30 * 60_000;
/** Logos: a creator may fill in the rest of the form for a while after uploading one. */
export const LOGO_ORPHAN_AFTER_MS = 6 * 3_600_000;

interface Pin {
  url: string;
  cid: string;
  label: string;
  due: number;
  /** True: in use, keep. False: unused, remove. Null: can't tell yet. */
  used: () => Promise<boolean | null>;
  /** Other pinned links this file points at (a metadata JSON's image). */
  refs: string[];
  tries: number;
}

export function pinTracker(cfg: Config, log: (s: string) => void = console.log) {
  /** Pins waiting for their check, by CID. */
  const pins = new Map<string, Pin>();
  /** Links kept because something in use points at them. */
  const keptRefs = new Set<string>();
  /** CIDs of logos removed as unused, so a launch that names one later is told to upload it again. */
  const removed = new Set<string>();

  function track(url: string, label: string, used: Pin["used"], { after = ORPHAN_AFTER_MS, refs = [] as string[] } = {}) {
    const cid = cidOfUrl(cfg, url);
    if (!cid) return;
    // It has just been uploaded, so it's pinned again if it had been removed.
    removed.delete(cid);
    if (pins.size >= 5_000) pins.delete(pins.keys().next().value!);
    pins.set(cid, { url, cid, label, due: Date.now() + after, used, refs: refs.filter(Boolean), tries: 0 });
  }

  /** Whether a waiting or kept pin points at `url`, or might (a logo is in use while its metadata may be). */
  const referenced = (url: string) => {
    for (const r of keptRefs) if (sameContent(r, url) !== false) return true;
    for (const p of pins.values()) for (const r of p.refs) if (sameContent(r, url) !== false) return true;
    return false;
  };

  /** A logo's check: whether a launch names it (any spelling) or a pin points at it; null if that can't be told. */
  function logoUsed(images: unknown[], url: string) {
    if (referenced(url)) return true;
    let unclear = false;
    for (const image of images) {
      const same = sameContent(image, url);
      if (same) return true;
      if (same === null) unclear = true;
    }
    return unclear ? null : false;
  }

  async function sweep() {
    const now = Date.now();
    // Referring pins first: a metadata JSON's verdict decides whether its image is in use.
    const due = [...pins.values()].filter((p) => p.due <= now).sort((a, b) => b.refs.length - a.refs.length);
    for (const p of due) {
      const used = await p.used().catch(() => null);
      // Uploaded again while that check ran: the new entry decides.
      if (pins.get(p.cid) !== p) continue;
      if (used === null) {
        if (++p.tries < 6) { p.due = now + 10 * 60_000; continue; }
        pins.delete(p.cid); // can't tell: kept for good
        for (const r of p.refs) keptRefs.add(r);
        continue;
      }
      pins.delete(p.cid);
      if (used) { for (const r of p.refs) keptRefs.add(r); continue; }
      if (referenced(p.url)) continue;
      try {
        if (await unpinOrphan(cfg, p.cid)) { removed.add(p.cid); log(`unpinned unused ${p.label} (${p.cid})`); }
      } catch (e) { log(`unpin ${p.label} (${p.cid}): ${e instanceof Error ? e.message : e}`); }
      if (removed.size > 5_000) removed.delete(removed.values().next().value!);
    }
  }

  /** Whether `url`, however it's spelled, names a logo removed as unused. */
  const wasRemoved = (url: unknown) => typeof url === "string" && [...removed].some((cid) => sameContent(url, cid) === true);

  return { track, sweep, referenced, logoUsed, wasRemoved };
}
