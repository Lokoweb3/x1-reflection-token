/**
 * Build the Tax Vault recovery page (src/recovery): one self-contained HTML file with the
 * wallet helper and the shared crank code bundled in, ready to pin to IPFS or host anywhere.
 *
 *   npx tsx scripts/build-recovery.ts [--network testnet|mainnet] [--out dist/recovery-<network>.html]
 *
 * --pin uploads it to public IPFS through Pinata (PINATA_JWT, or factory.pinataJwt from the
 * site's config: REFLECT_CONFIG), then fetches it back through public gateways and checks the
 * bytes. Run it where the key lives (the VM), e.g.
 *   sudo -u reflect node node_modules/tsx/dist/cli.mjs scripts/build-recovery.ts --network testnet --pin
 *
 * --short-windows builds a copy for local rehearsals against the program's short-windows
 * build (appoint after 15 s, fallback after 30 s); never pin that one.
 *
 * Prints the file's sha256 and its IPFS CID (CIDv1, raw leaves: what `ipfs add --cid-version 1
 * --raw-leaves` gives for a file under 1 MiB), so anyone can check a pinned copy against the source.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { build } from "esbuild";
import { rawCid } from "../src/taxvault.js";
import { loadConfig } from "../src/config.js";
import { pinFile } from "../src/factory/ipfs.js";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const network = flag("network") ?? "testnet";
if (network !== "testnet" && network !== "mainnet") throw new Error("--network must be testnet or mainnet");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const shortWindows = argv.includes("--short-windows");
const out = path.resolve(flag("out") ?? path.join(root, "dist", `recovery-${network}${shortWindows ? "-rehearsal" : ""}.html`));
const shim = (f: string) => path.join(root, "src/recovery/shims", f);

const res = await build({
  entryPoints: [path.join(root, "src/recovery/app.ts")],
  bundle: true, format: "iife", platform: "browser", target: "es2020", minify: true, write: false, legalComments: "none",
  alias: { "node:crypto": shim("node-crypto.ts"), "node:fs": shim("node-empty.ts"), "node:os": shim("node-empty.ts"), "node:path": shim("node-empty.ts") },
  inject: [shim("globals.ts")],
  define: { "process.env": shortWindows ? '{"TAX_VAULT_SHORT_WINDOWS":"1"}' : "{}", "import.meta.url": '"https://recovery.invalid/"' },
  logLevel: "warning",
});
// "</script" inside the bundle would end the inline script early.
const app = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const wallet = fs.readFileSync(path.join(root, "src/web/wallet.js"), "utf8").replace(/<\/script/gi, "<\\/script");
let commit = "unknown";
try { commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim() + (execSync("git status --porcelain src scripts", { cwd: root }).toString().trim() ? "+local" : ""); } catch {}
const html = fs.readFileSync(path.join(root, "src/recovery/page.html"), "utf8")
  .replace("__NET__", network).replace("__COMMIT__", commit + (shortWindows ? " · REHEARSAL BUILD (short windows), not for real vaults" : ""))
  .replace("<script>__WALLET__</script>", () => `<script>${wallet}</script>`)
  .replace("<script>__APP__</script>", () => `<script>${app}</script>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const bytes = Buffer.from(html);
console.log(`${path.relative(root, out)}  ${bytes.length} bytes  (${network}, commit ${commit})`);
console.log(`sha256 ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
if (bytes.length < 1_048_576) console.log(`raw CID ${rawCid(bytes)}`);

if (argv.includes("--pin")) {
  if (shortWindows) throw new Error("never pin a --short-windows (rehearsal) build");
  let jwt = process.env.PINATA_JWT ?? "";
  if (!jwt) { try { jwt = loadConfig().factory?.pinataJwt ?? ""; } catch { /* no config */ } }
  if (!jwt) throw new Error("--pin needs PINATA_JWT or factory.pinataJwt in the config");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const cid = await pinFile({ jwt }, new Blob([bytes], { type: "text/html" }), `99tax-recovery-${network}.html`, `99tax recovery page ${network} ${commit}`);
  console.log(`pinned: ${cid}`);
  // Pinata's public gateway won't serve HTML, and ipfs.io / dweb.link answer scripts with 429
  // (browsers get their service-worker gateway), so check the file is on the IPFS network
  // through a trustless gateway and print the links that work in a browser.
  try {
    const r = await fetch(`https://trustless-gateway.link/ipfs/${cid}?format=car`, { signal: AbortSignal.timeout(90_000) });
    const n = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    console.log(`  ${r.ok && n > bytes.length ? "ok  " : "WAIT"} on the IPFS network (trustless-gateway.link: HTTP ${r.status}, ${n} bytes; can take a few minutes after pinning)`);
  } catch (e) { console.log(`  WAIT trustless-gateway.link: ${e instanceof Error ? e.message : e} (can take a few minutes after pinning)`); }
  console.log(`open in a browser:\n  https://${cid}.ipfs.dweb.link/\n  https://${cid}.ipfs.inbrowser.link/\n  ipfs://${cid}  (Brave, or a local IPFS node)`);
  console.log(`sha256 of the file: ${sha} (compare with a local build of the same commit)`);
}
