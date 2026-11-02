/** Files that must survive a crash: fully on disk, under their final name, or not at all. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Flush a directory, so the names just created, renamed or removed in it survive a power cut. */
export function syncDir(dir: string) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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
