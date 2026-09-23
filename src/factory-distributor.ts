/**
 * Runs the distribution cycle (src/distribute.ts) for every token launched through
 * the factory, one after another, each with its own config, distributor wallet and
 * state directory under factory/launches/<mint>/.
 *
 *   npm run factory:distribute                      # dry run for every token
 *   npm run factory:distribute -- --execute         # one real cycle each
 *   npm run factory:distribute -- --execute --loop 15
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { FACTORY_DIR, ROOT } from "./config.js";
import { registeredLaunches } from "./factory/launch.js";

const args = process.argv.slice(2);
const unknown = args.filter((a, i) => a !== "--execute" && a !== "--loop" && args[i - 1] !== "--loop");
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(" ")}`);
const execute = args.includes("--execute");
const loopIdx = args.indexOf("--loop");
const loopMinutes = loopIdx >= 0 ? Number(args[loopIdx + 1]) : 0;
if (loopIdx >= 0 && !(loopMinutes >= 1)) throw new Error("--loop needs a number of minutes >= 1");
const CYCLE_TIMEOUT_MS = 5 * 60_000;

function runToken(mint: string, symbol: string): Promise<number> {
  const dir = path.join(FACTORY_DIR, "launches", mint);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(ROOT, "src", "distribute.ts"),
      ...(execute ? ["--execute"] : []),
    ], {
      cwd: ROOT,
      env: { ...process.env, REFLECT_CONFIG: path.join(dir, "config.json"), REFLECT_STATE_DIR: path.join(dir, "state") },
    });
    const tag = `[${symbol} ${mint.slice(0, 4)}…]`;
    const out = (d: Buffer) => d.toString().split("\n").filter(Boolean).forEach((l) => console.log(`${tag} ${l}`));
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    const timer = setTimeout(() => { console.log(`${tag} cycle timed out; stopping it`); child.kill("SIGTERM"); }, CYCLE_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

async function once() {
  const tokens = registeredLaunches();
  console.log(`\n=== Factory cycle ${new Date().toISOString()} (${execute ? "EXECUTE" : "dry run"}): ${tokens.length} token(s) ===`);
  for (const t of tokens) {
    const code = await runToken(t.mint, t.symbol);
    if (code !== 0) console.log(`[${t.symbol}] cycle exited with code ${code}; continuing with the next token`);
  }
}

for (;;) {
  await once();
  if (!loopMinutes) break;
  await new Promise((r) => setTimeout(r, loopMinutes * 60_000));
}
