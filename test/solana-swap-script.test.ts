// The real scripts/solana-swap.ts as a real process, without --live, so it stops before signing. A local modelled RPC
// answers its chain reads and simulation; a preload answers Jupiter from fixtures. The key is a throwaway generated
// here. Modelled: every answer, including the simulated post-states. Not covered: Jupiter's real responses, a real
// simulation, and everything after "dry run" (signing, sending, finality).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ACCOUNT_SIZE, AccountLayout, AccountState, AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { JUPITER_V6 } from "../src/swap-guard.js";
import { mockRpc, type RpcHandler } from "./helpers/mock-rpc.js";

const root = path.join(import.meta.dirname, "..");
const RENT = 2_039_280, FEE = 105_000;
const AMOUNT = 1_000_000n, MIN_OUT = 500_000n;

function tokenData(mint: PublicKey, owner: PublicKey, amount: bigint, o: { delegate?: PublicKey } = {}) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint, owner, amount, delegateOption: o.delegate ? 1 : 0, delegate: o.delegate ?? PublicKey.default, state: AccountState.Initialized, isNativeOption: 0, isNative: 0n,
    delegatedAmount: o.delegate ? 1n : 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return data;
}
type Acct = { lamports: number; owner: PublicKey; data: Buffer };
const wire = (a: Acct | null) => (a ? { lamports: a.lamports, owner: a.owner.toBase58(), data: [a.data.toString("base64"), "base64"], executable: false, rentEpoch: 0, space: a.data.length } : null);

interface Case { extraIxs?: (w: PublicKey, outAta: PublicKey) => TransactionInstruction[]; post?: (ctx: { wallet: PublicKey; other: PublicKey; inMint: PublicKey; outMint: PublicKey; hopMint: PublicKey; hopAta: PublicKey; outAta: PublicKey }) => Record<string, Acct | null> }

async function dryRun(c: Case) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-script-"));
  const kp = Keypair.generate(), wallet = kp.publicKey, other = Keypair.generate().publicKey;
  const keypair = path.join(dir, "throwaway.json");
  fs.writeFileSync(keypair, JSON.stringify([...kp.secretKey]));
  const inMint = Keypair.generate().publicKey, outMint = Keypair.generate().publicKey, hopMint = Keypair.generate().publicKey;
  const inAta = getAssociatedTokenAddressSync(inMint, wallet), outAta = getAssociatedTokenAddressSync(outMint, wallet), hopAta = getAssociatedTokenAddressSync(hopMint, wallet);
  const pool = Keypair.generate().publicKey;

  // A multihop: open the output and the intermediate account, then Jupiter's route through both.
  const jup = new TransactionInstruction({ programId: JUPITER_V6, data: Buffer.from([1]), keys: [
    { pubkey: wallet, isSigner: true, isWritable: true }, { pubkey: inAta, isSigner: false, isWritable: true }, { pubkey: hopAta, isSigner: false, isWritable: true },
    { pubkey: outAta, isSigner: false, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }] });
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    createAssociatedTokenAccountIdempotentInstruction(wallet, hopAta, wallet, hopMint), jup, ...(c.extraIxs?.(wallet, outAta) ?? [])];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: bs58.encode(Buffer.alloc(32, 7)), instructions: ixs }).compileToV0Message());

  const WALLET_SOL = 50_000_000;
  const pre = new Map<string, Acct | null>([
    [wallet.toBase58(), { lamports: WALLET_SOL, owner: SystemProgram.programId, data: Buffer.alloc(0) }],
    [inAta.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(inMint, wallet, AMOUNT) }],
    [outAta.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(outMint, wallet, 0n) }],
    [pool.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(outMint, other, 9n) }],
  ]);
  const post = new Map<string, Acct | null>([...pre,
    [wallet.toBase58(), { lamports: WALLET_SOL - RENT - FEE, owner: SystemProgram.programId, data: Buffer.alloc(0) }],
    [inAta.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(inMint, wallet, 0n) }],
    [outAta.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(outMint, wallet, MIN_OUT) }],
    [hopAta.toBase58(), { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(hopMint, wallet, 0n) }],
    ...Object.entries(c.post?.({ wallet, other, inMint, outMint, hopMint, hopAta, outAta }) ?? {}),
  ]);
  const ctx = (value: unknown) => ({ context: { slot: 500 }, value });
  const handler: RpcHandler = (m, p) => {
    switch (m) {
      case "getAccountInfo": {
        const k = new PublicKey(p[0]);
        if (![inMint, outMint].some((x) => x.equals(k))) return ctx(wire(pre.get(k.toBase58()) ?? null));
        if (p[1]?.encoding === "jsonParsed") return ctx({ lamports: 1, owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: MINT_SIZE, data: { program: "spl-token", space: MINT_SIZE, parsed: { type: "mint", info: { decimals: 6 } } } });
        return ctx(wire({ lamports: 1, owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(MINT_SIZE) }));
      }
      case "getBalance": return ctx(WALLET_SOL);
      case "getTokenAccountsByOwner": {
        const mint = p[1]?.mint, ata = mint === inMint.toBase58() ? inAta : outAta;
        const amount = mint === inMint.toBase58() ? AMOUNT.toString() : "0";
        return ctx([{ pubkey: ata.toBase58(), account: { lamports: RENT, owner: TOKEN_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0, space: ACCOUNT_SIZE,
          data: { program: "spl-token", space: ACCOUNT_SIZE, parsed: { type: "account", info: { tokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: amount } } } } } }]);
      }
      case "getMultipleAccounts": return ctx(p[0].map((k: string) => wire(pre.get(k) ?? null)));
      case "simulateTransaction": return ctx({ err: null, logs: [], unitsConsumed: 200_000, accounts: p[1].accounts.addresses.map((k: string) => wire(post.get(k) ?? null)) });
      default: return undefined;
    }
  };
  const rpc = await mockRpc(handler);
  const fixture = path.join(dir, "jupiter.json");
  fs.writeFileSync(fixture, JSON.stringify({
    quote: { inputMint: inMint.toBase58(), outputMint: outMint.toBase58(), inAmount: AMOUNT.toString(), outAmount: "510000", otherAmountThreshold: MIN_OUT.toString(), priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "A" } }, { swapInfo: { label: "B" } }] },
    swap: { swapTransaction: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: 1_000 },
  }));
  const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--import", path.join(root, "test", "helpers", "jupiter-preload.mjs"), path.join(root, "scripts", "solana-swap.ts"),
      "--in", inMint.toBase58(), "--out", outMint.toBase58(), "--amount", "1", "--keypair", keypair],
      { env: { ...process.env, SOLANA_RPC_URL: rpc.url, JUPITER_FIXTURE: fixture }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("exit", (code) => resolve({ code, text }));
  });
  await rpc.close();
  assert.ok(!rpc.calls.includes("sendTransaction"), "a dry run never sends");
  return out;
}

test("a normal multihop opening its own intermediate account passes", async () => {
  const r = await dryRun({});
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /simulation passed/);
  assert.match(r.text, /dry run: nothing sent/);
});

test("the same multihop paying rent for someone else's account fails the budget", async () => {
  const r = await dryRun({ post: ({ other, hopMint, hopAta }) => ({ [hopAta.toBase58()]: { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(hopMint, other, 0n) } }) });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /doesn't match the quote/);
});

test("a top-level SetAuthority to Jupiter stops it before the simulation", async () => {
  const r = await dryRun({ extraIxs: (w, outAta) => [createSetAuthorityInstruction(outAta, w, AuthorityType.AccountOwner, JUPITER_V6)] });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /does more than swap/);
  assert.doesNotMatch(r.text, /simulation passed/);
});

test("an output account changing hands inside the route is caught from the post-states, though the amounts check out", async () => {
  const r = await dryRun({ post: ({ outMint, outAta }) => ({ [outAta.toBase58()]: { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(outMint, JUPITER_V6, MIN_OUT) } }) });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /hand the token account/);
});

test("a delegate left on the output account is caught", async () => {
  const d = await dryRun({ post: ({ wallet, other, outMint, outAta }) => ({ [outAta.toBase58()]: { lamports: RENT, owner: TOKEN_PROGRAM_ID, data: tokenData(outMint, wallet, MIN_OUT, { delegate: other }) } }) });
  assert.equal(d.code, 1, d.text);
  assert.match(d.text, /let .* spend/);
});
