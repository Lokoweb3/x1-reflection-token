// Run as a real process by test/arb-guard.test.ts. Modes:
//   race <file> <cap> <fee> <tries> <startAt>   reserve as fast as it can from <startAt> on; prints how many it got
//   die-holding-lock <file>                     takes the lock and dies without releasing it
//   hold-lock <file> <ms>                       takes the lock and holds it
//   slot-race <dir> <n> <startAt> <limit|peg>   counts signatures 0..n-1 on one limit order or one peg, racing another worker
//   pause-before-commit <file> <cap> <fee> <ms> reserves, pausing after the cap check and before the journal's rename; prints the result
import fs from "node:fs";
import path from "node:path";
import { FeeCap, withFileLock } from "../../src/arb-guard.js";
import { limitSlot } from "../../src/limit.js";
import { pegSlot } from "../../src/peg.js";

const [mode, file, a, b, c, d] = process.argv.slice(2);
if (mode === "race") {
  const cap = new FeeCap(BigInt(a), file);
  while (Date.now() < Number(d)) { /* start together */ }
  let got = 0;
  for (let i = 0; i < Number(c); i++) if (cap.reserve(BigInt(b), Date.now())) got++;
  console.log(got);
} else if (mode === "die-holding-lock") {
  withFileLock(file, () => { process.kill(process.pid, "SIGKILL"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); });
} else if (mode === "hold-lock") {
  withFileLock(file, () => { fs.writeFileSync(`${file}.holding`, "1"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(a)); });
} else if (mode === "pause-before-commit") {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    fs.renameSync = rename;
    fs.writeFileSync(`${file}.holding`, "1");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(c));
    rename(from, to);
  };
  console.log(new FeeCap(BigInt(a), file).reserve(BigInt(b), Date.now()));
}
if (mode === "slot-race") {
  const [dir, n, startAt, which] = [file, Number(a), Number(b), c];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const limit = limitSlot(dir, "order"), peg = pegSlot(dir, path.join(dir, "peg-t.json"));
  while (Date.now() < startAt) { /* start together */ }
  let got = 0;
  for (let i = 0; i < n; i++) {
    const signature = `sig${i}`;
    if (which === "limit" ? limit.count({ signature, at: "", amountIn: "10", minOut: "1", tokens: 1, poolPrice: 1 }, signature)
      : peg.count({ signature, at: "", day, side: "buy", amountIn: "1", minOut: "1", tokens: 1, poolPrice: 1, refPrice: 1 }, signature)) got++;
  }
  console.log(got);
}
