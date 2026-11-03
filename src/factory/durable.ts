/** Files that must survive a crash: fully on disk, under their final name, or not at all. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Flush a directory, so the names just created, renamed or removed in it survive a power cut. */
export function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Flush a file already in place. */
export function syncFile(file: string) {
  const fd = fs.openSync(file, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Create `dir` (and whatever is missing above it) so it survives a power cut: a directory's
 * entry lives in its parent, so every level is flushed, up to `base` and the parents of anything
 * just created. Levels are flushed even if they already existed: an earlier attempt may have
 * created them and stopped before flushing. Above `base`, a directory that already existed may
 * not be readable to flush, and isn't ours: that's not an error.
 */
export function mkdirDurable(target: string, root: string) {
  const dir = path.resolve(target), base = path.resolve(root);
  const first = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const top = path.dirname(first && first.length < base.length ? first : base);
  const created = !!first && first.length <= base.length;
  for (let d = dir; ; d = path.dirname(d)) {
    if (d === top && !created) { try { syncDir(d); } catch { /* see above */ } } else syncDir(d);
    if (d === top || d === path.dirname(d)) break;
  }
}

/**
 * Write `file` atomically: a private temp file, flushed, renamed over the old one. On failure
 * the old file (if any) is untouched and the temp file is gone; its contents never reach a log.
 */
export function writeFileDurable(file: string, text: string, mode = 0o600) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  syncDir(dir);
}
