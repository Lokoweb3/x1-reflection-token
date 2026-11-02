/**
 * Decide a peg or limit trade the chain can't settle (it alerted "can't prove whether <signature> landed").
 * Look the signature up first, on an explorer or a node with full history. Then:
 *
 *   npx tsx scripts/resolve-intent.ts <signature> landed  --wallet <address>   # it landed: count it against the day's limit or budget
 *   npx tsx scripts/resolve-intent.ts <signature> dropped --wallet <address>   # it never landed, or it failed: forget it
 *
 * It refuses unless the signature is a journaled intent, its blockhash has expired on finalized state (so it can't land
 * from here on), and the chain doesn't already answer the question, or answer it the other way. The decision goes in
 * state/intent-resolutions.json (REFLECT_STATE_DIR moves state/; REFLECT_RPC_URL picks the RPC, if the default can't
 * answer). A running bot acts on it at its next check; no restart. Sends nothing and needs no key.
 */
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { fateOfSend } from "../src/send-fate.js";
import { findPendingIntent, recordResolution } from "../src/send-intent.js";

const argv = process.argv.slice(2);
const [signature, verdict] = argv;
const at = argv.indexOf("--wallet"), walletText = at >= 0 ? argv[at + 1] : undefined;
const is64Bytes = (s: string | undefined) => { try { return !!s && bs58.decode(s).length === 64; } catch { return false; } };
const isKey = (s: string | undefined) => { try { return !!s && !!new PublicKey(s); } catch { return false; } };
if (!is64Bytes(signature) || (verdict !== "landed" && verdict !== "dropped") || !isKey(walletText)) {
  console.error("usage: npx tsx scripts/resolve-intent.ts <signature> landed|dropped --wallet <address>   (see the file's header)");
  process.exit(1);
}
const refuse = (why: string): never => { console.error(`not recorded: ${why}`); process.exit(1); };
const stateDir = process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state");
const intent = findPendingIntent(stateDir, signature);
if (!intent) refuse(`no peg or limit trade in ${stateDir} is waiting on ${signature}`);

const conn = new Connection(process.env.REFLECT_RPC_URL ?? "https://rpc.mainnet.x1.xyz", "confirmed");
const f = await fateOfSend(conn, { signature, lastValidBlockHeight: intent!.lastValidBlockHeight, wallet: new PublicKey(walletText!), sentAt: intent!.at ? Date.parse(intent!.at) : NaN });
if (f.fate === "in-flight") refuse(`it may still land (${f.reason}); try again once its blockhash has expired`);
if (f.fate === "unknown" && !f.expired) refuse(`can't confirm its blockhash has expired (${f.reason}), so it may still land; try again, or set REFLECT_RPC_URL to another node`);
if (f.fate === "landed" || f.fate === "failed" || f.fate === "never-landed") {
  const chain = f.fate === "landed" ? "landed" : "dropped";
  if (chain !== verdict) refuse(`the chain says ${f.fate}, which is "${chain}", not "${verdict}"`);
  console.log(`the chain says ${f.fate}: the bot settles this by itself at its next check, so nothing to record`);
  process.exit(0);
}
recordResolution(stateDir, signature, verdict);
console.log(`recorded: ${signature} ${verdict}. The bot acts on it at its next check.`);
