/**
 * Decide a peg or limit trade the chain can't settle (it alerted "can't prove whether <signature> landed").
 * Look the signature up first, on an explorer or a node with full history. Then:
 *
 *   npx tsx scripts/resolve-intent.ts <signature> landed    # it landed: count it against the day's limit or budget
 *   npx tsx scripts/resolve-intent.ts <signature> dropped   # it never landed, or it failed: forget it
 *
 * Writes state/intent-resolutions.json (REFLECT_STATE_DIR moves state/). A running bot acts on it at its next check; no
 * restart. Sends nothing, reads nothing from the chain, and needs no key.
 */
import path from "node:path";
import bs58 from "bs58";
import { recordResolution } from "../src/send-intent.js";

const [signature, verdict] = process.argv.slice(2);
const is64Bytes = (s: string | undefined) => { try { return !!s && bs58.decode(s).length === 64; } catch { return false; } };
if (!is64Bytes(signature) || (verdict !== "landed" && verdict !== "dropped")) {
  console.error("usage: npx tsx scripts/resolve-intent.ts <signature> landed|dropped   (see the file's header)");
  process.exit(1);
}
const stateDir = process.env.REFLECT_STATE_DIR ?? path.join(import.meta.dirname, "..", "state");
recordResolution(stateDir, signature, verdict);
console.log(`recorded: ${signature} ${verdict}. The bot acts on it at its next check.`);
