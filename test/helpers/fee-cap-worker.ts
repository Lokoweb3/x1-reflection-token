// Run as a real process by test/arb-guard.test.ts. Modes:
//   race <file> <cap> <fee> <tries> <startAt>   reserve as fast as it can from <startAt> on; prints how many it got
//   die-holding-lock <file>                     takes the lock and dies without releasing it
//   hold-lock <file> <ms>                       takes the lock and holds it
import fs from "node:fs";
import { FeeCap, withFileLock } from "../../src/arb-guard.js";

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
}
