/**
 * Testnet faucet: one claim sends a small amount of the launch-fee token (XNM) and of XNT
 * (`xntAmount`, for fees and a small pool) from a dedicated faucet wallet, so anyone can
 * try a launch. Server-signed, so claimers pay nothing.
 *
 * Limits: one claim per wallet and per IP every `cooldownHours`, and at most `dailyCap`
 * claims per UTC day. Never runs on mainnet (the fee there is real USDC). Claims are
 * handled one at a time so two requests can't both pass the checks.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackMint } from "@solana/spl-token";
import { Config, FACTORY_DIR, ROOT, loadKeypair, toBaseUnits } from "../config.js";
import { run, withPriority } from "../tx.js";
import { launchFee } from "./launch.js";

const LOG = path.join(FACTORY_DIR, "faucet.json");
interface Log { wallets: Record<string, number>; ips: Record<string, number>; day: string; count: number }
const read = (): Log => (fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : { wallets: {}, ips: {}, day: "", count: 0 });
const write = (l: Log) => { fs.mkdirSync(FACTORY_DIR, { recursive: true }); fs.writeFileSync(LOG, JSON.stringify(l), { mode: 0o600 }); };
const today = () => new Date().toISOString().slice(0, 10);

function settings(cfg: Config) {
  const f = cfg.factory?.faucet;
  if (!f || cfg.network !== "testnet" || !cfg.factory?.feeToken) return null;
  const keypath = path.isAbsolute(f.keypair) ? f.keypair : path.join(ROOT, f.keypair);
  if (!fs.existsSync(keypath)) return null;
  return { ...f, keypath, xntAmount: f.xntAmount ?? "0", cooldownMs: (f.cooldownHours ?? 24) * 3_600_000, dailyCap: f.dailyCap ?? 100, token: launchFee(cfg) };
}

const turnstileSecret = (cfg: Config) => process.env.TURNSTILE_SECRET || cfg.factory?.turnstile?.secret || "";

/** Check a Cloudflare Turnstile token (skipped when no captcha is set up). */
export async function checkCaptcha(cfg: Config, token: unknown, ip: string) {
  const secret = turnstileSecret(cfg);
  if (!secret) return;
  if (typeof token !== "string" || !token) throw new Error("Please complete the captcha first.");
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form, signal: AbortSignal.timeout(10_000) })
    .then((x) => x.json() as Promise<{ success?: boolean }>).catch(() => ({ success: false }));
  if (!r.success) throw new Error("The captcha didn't pass; please try it again.");
}

/** What the page shows: whether it's on, how much it gives, and when this wallet can claim. */
export async function faucetStatus(conn: Connection, cfg: Config, wallet?: string) {
  const s = settings(cfg);
  if (!s) return { enabled: false };
  const faucet = loadKeypair(s.keypath).publicKey;
  const mint = new PublicKey(s.token.mint);
  const ata = getAssociatedTokenAddressSync(mint, faucet, false, (await conn.getAccountInfo(mint))!.owner);
  const bal = await conn.getTokenAccountBalance(ata).then((r) => Number(r.value.uiAmount ?? 0)).catch(() => 0);
  const log = read();
  const next = wallet && log.wallets[wallet] ? log.wallets[wallet] + s.cooldownMs : 0;
  const xnt = (await conn.getBalance(faucet)) / 1e9;
  return {
    enabled: true, captchaSiteKey: turnstileSecret(cfg) ? cfg.factory?.turnstile?.siteKey ?? null : null, symbol: s.token.symbol, amount: s.amount, xntAmount: s.xntAmount, address: faucet.toBase58(),
    balance: bal, xnt, empty: bal < Number(s.amount) || xnt < Number(s.xntAmount) + 0.005,
    remainingToday: Math.max(0, s.dailyCap - (log.day === today() ? log.count : 0)),
    nextClaimAt: next > Date.now() ? new Date(next).toISOString() : null,
  };
}

/**
 * Instructions for anyone to top up the faucet from their own wallet: `tokens` of the fee
 * token and/or `xnt` for its fees. The wallet signs, so nothing moves without approval.
 */
export async function faucetFundIxs(conn: Connection, cfg: Config, fromStr: string, tokens: string, xnt: string) {
  const s = settings(cfg);
  if (!s) throw new Error("The faucet is off.");
  const from = new PublicKey(fromStr);
  const faucet = loadKeypair(s.keypath).publicKey;
  const ixs: TransactionInstruction[] = [];
  const t = Number(tokens || 0), x = Number(xnt || 0);
  if (!(t >= 0 && x >= 0) || (t === 0 && x === 0)) throw new Error(`Enter an amount of ${s.token.symbol} and/or XNT to send.`);
  if (t > 0) {
    const mint = new PublicKey(s.token.mint);
    const mintInfo = (await conn.getAccountInfo(mint, "confirmed"))!;
    const program = mintInfo.owner;
    const decimals = unpackMint(mint, mintInfo, program).decimals;
    const amount = toBaseUnits(tokens, decimals);
    const src = getAssociatedTokenAddressSync(mint, from, false, program);
    const have = BigInt(await conn.getTokenAccountBalance(src).then((r) => r.value.amount).catch(() => "0"));
    if (have < amount) throw new Error(`This wallet has only ${Number(have) / 10 ** decimals} ${s.token.symbol}.`);
    const dst = getAssociatedTokenAddressSync(mint, faucet, false, program);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(from, dst, faucet, mint, program),
      createTransferCheckedInstruction(src, mint, dst, from, amount, decimals, [], program));
  }
  if (x > 0) ixs.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: faucet, lamports: toBaseUnits(xnt, 9) }));
  return ixs;
}

let queue: Promise<unknown> = Promise.resolve();

/** Send the faucet amount to `wallet`. Throws a readable reason if it can't. */
export function faucetClaim(conn: Connection, cfg: Config, walletStr: string, ip: string) {
  const job = queue.then(async () => {
    const s = settings(cfg);
    if (!s) throw new Error("The faucet is off.");
    const wallet = new PublicKey(walletStr);
    if (!PublicKey.isOnCurve(wallet.toBytes())) throw new Error("That isn't a wallet address.");
    const log = read();
    if (log.day !== today()) { log.day = today(); log.count = 0; }
    const now = Date.now();
    const wait = (t?: number) => (t && now - t < s.cooldownMs ? Math.ceil((t + s.cooldownMs - now) / 3_600_000) : 0);
    const w = wait(log.wallets[wallet.toBase58()]) || wait(log.ips[ip]);
    if (w) throw new Error(`Already claimed; try again in about ${w} hour${w === 1 ? "" : "s"}.`);
    if (log.count >= s.dailyCap) throw new Error("The faucet has reached today's limit; try again tomorrow (UTC).");

    const faucet = loadKeypair(s.keypath);
    const mint = new PublicKey(s.token.mint);
    const mintInfo = (await conn.getAccountInfo(mint, "confirmed"))!;
    const program = mintInfo.owner;
    const decimals = unpackMint(mint, mintInfo, program).decimals;
    const amount = toBaseUnits(s.amount, decimals);
    const from = getAssociatedTokenAddressSync(mint, faucet.publicKey, false, program);
    const to = getAssociatedTokenAddressSync(mint, wallet, false, program);
    const have = BigInt(await conn.getTokenAccountBalance(from).then((r) => r.value.amount).catch(() => "0"));
    if (have < amount) throw new Error(`The faucet is out of ${s.token.symbol}; please check back later.`);
    const xntOut = toBaseUnits(s.xntAmount, 9);
    // Keep 0.005 XNT back for the faucet's own fees and the new token account's rent.
    if (BigInt(await conn.getBalance(faucet.publicKey)) < xntOut + 5_000_000n) throw new Error("The faucet is out of XNT; please check back later.");

    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, to, wallet, mint, program),
      createTransferCheckedInstruction(from, mint, to, faucet.publicKey, amount, decimals, [], program),
    ];
    if (xntOut > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: wallet, lamports: xntOut }));
    const signature = await run(conn, withPriority(ixs, cfg.distribution.priorityMicroLamports), faucet);
    log.wallets[wallet.toBase58()] = now;
    if (ip) log.ips[ip] = now;
    log.count += 1;
    write(log);
    return { signature, amount: s.amount, symbol: s.token.symbol, xntAmount: s.xntAmount };
  });
  queue = job.catch(() => undefined);
  return job;
}
