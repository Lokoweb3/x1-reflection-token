/**
 * The factory server's start, in a process of its own: nothing in memory, only what's on disk.
 * Recovery and one journal GC (no chain read needed for a saved launch). Prints what reached the
 * disk, in order. REFLECT_FACTORY_DIR says where; FAIL_DIR_FLUSH makes every directory flush fail.
 */
import fs from "node:fs";
import type { Connection } from "@solana/web3.js";

const events: string[] = [];
const realFsync = fs.fsyncSync.bind(fs), realRm = fs.rmSync.bind(fs);
fs.fsyncSync = ((fd: number) => {
  const isDir = fs.fstatSync(fd).isDirectory();
  if (isDir && process.env.FAIL_DIR_FLUSH) throw Object.assign(new Error("ENOSPC: no space left on device, fsync"), { code: "ENOSPC", syscall: "fsync" });
  realFsync(fd);
  events.push(`sync ${fs.readlinkSync(`/proc/self/fd/${fd}`)}`);
}) as typeof fs.fsyncSync;
fs.rmSync = ((p: string, o: fs.RmOptions) => { events.push(`rm ${p}`); realRm(p, o); }) as typeof fs.rmSync;

const { recoverPendingLaunches, gcPendingJournal } = await import("../../src/factory/launch.js");
recoverPendingLaunches();
const noChain = { getMultipleAccountsInfo: async () => { throw new Error("no read needed"); } } as unknown as Connection;
const removed = await gcPendingJournal(noChain);
console.log(JSON.stringify({ removed, events }));
