/**
 * Give the main config's token (the original single token, e.g. RFLT on testnet) a launch
 * record under factory/launches/<mint>/, so it is served like every launchpad token (and
 * can then move onto the Tax Vault with scripts/migrate-to-vault.ts).
 *
 * It writes, in the launch folder:
 *   launch.json                the launch record (creator, split, pool, lock NFT, distributor)
 *   config.json                the main config with this token's settings
 *   distributor.json           a copy of the main distributor key (the migration signs with it
 *                              once; after that it can't touch the tax)
 *   state/                     copies of events.jsonl, trades.json and distributor-state.json,
 *                              so its history, leaderboard and journal carry over
 * and then clears `xdex.pool` in the main config (backup: config.json.before-adopt), so the
 * site stops serving the token through the main config and there is only one copy of it.
 * The token's own distributor service should be stopped first.
 *
 *   npx tsx scripts/adopt-main-token.ts --creator <creator pubkey>              # dry run
 *   npx tsx scripts/adopt-main-token.ts --creator <creator pubkey> --execute    # write
 *
 * The creator's public key is asked for rather than read from keypairs.creator, whose key
 * file stays off the server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { CONFIG_PATH, FACTORY_DIR, ROOT, STATE_DIR, loadConfig, loadKeypair } from "../src/config.js";
import type { LaunchRecord } from "../src/factory/launch.js";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const creatorArg = args[args.indexOf("--creator") + 1];
if (!args.includes("--creator") || !creatorArg) throw new Error("Usage: npx tsx scripts/adopt-main-token.ts --creator <creator pubkey> [--execute]");
const creator = new PublicKey(creatorArg).toBase58();

const cfg = loadConfig();
const refuse = (why: string): never => { console.error(`Refusing: ${why}`); process.exit(1); };
if (!cfg.mint || !cfg.xdex.pool) refuse("the main config has no token (mint and xdex.pool); nothing to adopt");
if (cfg.xdex.quoteMint) refuse("the main token isn't paired with XNT");
const mint = new PublicKey(cfg.mint!).toBase58();
const dir = path.join(FACTORY_DIR, "launches", mint);
if (fs.existsSync(path.join(dir, "launch.json"))) refuse(`${dir} already has a launch record`);
// Resolved the way loadKeypair does (home-relative or from the app folder).
const k = cfg.keypairs.distributor;
const distributorPath = k.startsWith("~") ? path.join(os.homedir(), k.slice(1)) : path.resolve(ROOT, k);
const distributor = loadKeypair(distributorPath);
const lockNft = cfg.creatorReward?.nftMint ?? refuse("no creatorReward.nftMint in the main config (the creator's lock NFT)");

// Name, image and description as wallets show them: the token's metadata file.
const meta = await fetch(cfg.token.uri).then((r) => r.json() as Promise<{ image?: string; description?: string }>).catch(() => ({} as { image?: string; description?: string }));
const now = new Date().toISOString();
const created = (() => {
  // The mint backup create-token wrote: its time is the token's creation time.
  const f = path.join(STATE_DIR, `mint-${mint}.json`);
  return fs.existsSync(f) ? fs.statSync(f).mtime.toISOString() : now;
})();
const record: LaunchRecord = {
  creator, name: cfg.token.name, symbol: cfg.token.symbol, description: meta.description ?? "", image: meta.image ?? "",
  supply: String(cfg.token.supply), taxBps: cfg.token.feeBps, autoLpBps: cfg.distribution.autoLpBps ?? 0, burnBps: cfg.distribution.burnBps ?? 0,
  poolTokens: String(cfg.token.supply), poolXnt: "0", lockDays: null,
  mint, distributor: distributor.publicKey.toBase58(), pool: cfg.xdex.pool, lockNft, createdAt: created, registeredAt: now,
};
const tokenCfg = { ...cfg, keypairs: { ...cfg.keypairs, distributor: "distributor.json" } };
const stateFiles = ["events.jsonl", "trades.json", "distributor-state.json"].filter((f) => fs.existsSync(path.join(STATE_DIR, f)));

console.log(`Adopt ${cfg.token.symbol} (${mint}) as a launch record in ${dir}`);
console.log(`  creator ${creator}, tax ${cfg.token.feeBps / 100}%, liquidity ${(record.autoLpBps) / 100}%, burn ${record.burnBps / 100}%`);
console.log(`  pool ${cfg.xdex.pool}, lock NFT ${lockNft}, distributor ${record.distributor}`);
console.log(`  state copied: ${stateFiles.join(", ") || "none"}`);
console.log(`  main config: xdex.pool "${cfg.xdex.pool}" -> "" (backup ${path.basename(CONFIG_PATH)}.before-adopt)`);
if (!execute) { console.log("\nDry run. Add --execute to write."); process.exit(0); }

fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dir, "launch.json"), JSON.stringify(record, null, 2));
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(tokenCfg, null, 2));
fs.copyFileSync(distributorPath, path.join(dir, "distributor.json"));
fs.chmodSync(path.join(dir, "distributor.json"), 0o600);
for (const f of stateFiles) fs.copyFileSync(path.join(STATE_DIR, f), path.join(dir, "state", f));
const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
fs.writeFileSync(`${CONFIG_PATH}.before-adopt`, JSON.stringify(raw, null, 2));
raw.xdex.pool = "";
fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
console.log("\nDone. Next: restart the site, then run scripts/migrate-to-vault.ts for this mint (dry run first).");
