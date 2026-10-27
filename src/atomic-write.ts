import fs from "node:fs";

/** Write `file` in full or not at all: a crash mid-write leaves the old contents, never a truncated file. */
export function writeFileAtomic(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}
