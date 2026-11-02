// Preloaded into scripts/solana-swap.ts by test/solana-swap-script.test.ts: answers Jupiter's two URLs from a fixture
// file, passes the local mock RPC through, and refuses every other use of global fetch, so the run can't reach anything real.
import fs from "node:fs";
const fixture = JSON.parse(fs.readFileSync(process.env.JUPITER_FIXTURE, "utf8"));
const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return real(url, init);
  if (u.includes("lite-api.jup.ag/swap/v1/quote")) return ok(fixture.quote);
  if (u.includes("lite-api.jup.ag/swap/v1/swap")) return ok(fixture.swap);
  throw new Error(`jupiter-preload: refused ${u}`);
};
