/**
 * The factory server's start, in a process of its own: nothing in memory, only what's on disk.
 * Recovery and one journal GC (no chain read needed for a saved launch). Prints what reached the
 * disk, in order. REFLECT_FACTORY_DIR says where; FAIL_DIR_FLUSH makes every directory flush fail;
 * RECORDS_CHAIN ({ height, slot, readSlot?, seen? }) has the launch records' GC run first, as the
 * server does, against a stand-in finalized chain.
 */
import fs from "node:fs";
import type { Connection, PublicKey } from "@solana/web3.js";

const events: string[] = [];
const realFsync = fs.fsyncSync.bind(fs), realRm = fs.rmSync.bind(fs);
fs.fsyncSync = ((fd: number) => {
  const isDir = fs.fstatSync(fd).isDirectory();
  if (isDir && process.env.FAIL_DIR_FLUSH) throw Object.assign(new Error("ENOSPC: no space left on device, fsync"), { code: "ENOSPC", syscall: "fsync" });
  realFsync(fd);
  events.push(`sync ${fs.readlinkSync(`/proc/self/fd/${fd}`)}`);
}) as typeof fs.fsyncSync;
fs.rmSync = ((p: string, o: fs.RmOptions) => { events.push(`rm ${p}`); realRm(p, o); }) as typeof fs.rmSync;

const { recoverPendingLaunches, gcLaunchRecords, gcPendingJournal } = await import("../../src/factory/launch.js");
recoverPendingLaunches();
const noChain = { getMultipleAccountsInfo: async () => { throw new Error("no read needed"); } } as unknown as Connection;
const plan = process.env.RECORDS_CHAIN ? JSON.parse(process.env.RECORDS_CHAIN) as { height: number; slot: number; readSlot?: number; seen?: string[] } : null;
const records = plan ? await gcLaunchRecords({
  getEpochInfo: async () => ({ absoluteSlot: plan.slot, blockHeight: plan.height }),
  getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: plan.readSlot ?? plan.slot }, value: keys.map((k) => (plan.seen?.includes(k.toBase58()) ? { lamports: 5 } : null)) }),
} as unknown as Connection) : [];
const removed = await gcPendingJournal(noChain);
console.log(JSON.stringify({ records, removed, events }));
