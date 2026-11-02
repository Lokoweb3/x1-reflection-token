/**
 * Upgrading lp_locker, on a LOCAL validator (nothing is sent to testnet or mainnet).
 *
 * MODE=upgrade (default): a validator cloning testnet XDEX and its pool config, with the OLD
 * lp_locker (fd136f3, what mainnet runs, built `--features "testnet short-vest"`) as an
 * upgradeable program. Locks and reward vaults are made on the old program, then this upgrades to
 * UPGRADE_SO (the new source, same features; UPGRADE_KEY = the local authority) and shows:
 *   - a timed lock made before unlocks after, with nft_mint read-only or writable, and nothing
 *     writes the mint (`mut` came off it); the old program refuses it read-only;
 *   - fees collect on a lock made before (protocol + fund fees, now checked_add);
 *   - a reward vault made before keeps working, and one on a mint the new rule refuses behaves
 *     as it always did (deposits go in; a claim comes up short by the fee, the rule's reason);
 *   - a new reward vault takes plain mints and refuses the others.
 *
 *   solana-test-validator --reset --ledger <scratch>/lp-ledger --rpc-port 8999 --faucet-port 9990 \
 *     --gossip-port 8990 --dynamic-port-range 8991-9020 --mint $(solana-keygen pubkey <scratch>/local-auth.json) \
 *     --url https://rpc.testnet.x1.xyz --clone-upgradeable-program 7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf \
 *     --maybe-clone 3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY --maybe-clone DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS \
 *     --upgradeable-program 5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C <old>.so $(solana-keygen pubkey <scratch>/local-auth.json)
 *
 * MODE=mainnet: read-only checks of TEST's live lock. A validator started with --url mainnet that
 * clones XDEX and the accounts this prints with PRINT_CLONES=1, and runs a given lp_locker. It
 * simulates (no signature, nothing lands) collect_fees and claim_reward as the NFT's holder and
 * prints each outcome: run it with the deployed binary and the new one and compare the output.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, createMintToInstruction, getAccount, getAssociatedTokenAddressSync, getMint, getMintLen,
} from "@solana/spl-token";
import type { Config } from "../src/config.js";
import { COLLECT_IX, CLAIM_REWARD_IX, MEMO_PROGRAM_ID, listLocks, lockPda, nftHolder, rewardTokensPda, rewardVaultPda, vaultPda } from "../src/locker.js";
import { buildClaimReward, buildCollect, buildDepositReward, buildLock, buildUnlock } from "../src/locker-tx.js";
import { buildBuy, buildCreatePool, poolAuthority, quoteBuy } from "../src/xdex.js";

const RPC = process.env.LOCAL_RPC ?? "http://127.0.0.1:8999";
assert.match(RPC, /127\.0\.0\.1|localhost/, "this drill only runs against a local validator");
const LOCKER = new PublicKey("5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C");
const conn = new Connection(RPC, "confirmed");
const ok = (m: string) => console.log(`  ✓ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- read-only checks of the live lock ----------
if (process.env.MODE === "mainnet") {
  const LOCK = new PublicKey("fzTp5jCHmXaVKiAUwNzX2U9YR5ydiiwyL7zJYFmhTXf");
  const XDEX = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
  const source = process.env.PRINT_CLONES ? new Connection(process.env.PRINT_CLONES, "confirmed") : conn;
  const d = (await source.getAccountInfo(LOCK))!.data;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const nftMint = key(8), pool = key(40), lpMint = key(72);
  const P = (await source.getAccountInfo(pool))!.data;
  const pk = (i: number) => new PublicKey(P.subarray(8 + i * 32, 40 + i * 32));
  const nftAcc = (await source.getTokenLargestAccounts(nftMint)).value[0].address;
  const holder = new PublicKey((await source.getAccountInfo(nftAcc))!.data.subarray(32, 64));
  const reward = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
  const vault = rewardVaultPda(LOCKER, nftMint, reward), vaultTokens = rewardTokensPda(LOCKER, vault);
  const holderReward = getAssociatedTokenAddressSync(reward, holder, false, TOKEN_2022_PROGRAM_ID);
  const holder0 = getAssociatedTokenAddressSync(pk(5), holder, false, TOKEN_PROGRAM_ID);
  const holder1 = getAssociatedTokenAddressSync(pk(6), holder, false, TOKEN_2022_PROGRAM_ID);
  const lockVault = vaultPda(LOCKER, LOCK);
  if (process.env.PRINT_CLONES) {
    const all = [LOCK, nftMint, pool, lpMint, nftAcc, holder, vault, vaultTokens, reward, holderReward, holder0, holder1, lockVault, pk(0), pk(2), pk(3), pk(5), pk(6)];
    const infos = await source.getMultipleAccountsInfo(all);
    console.log(all.filter((_, i) => infos[i]).map((k) => k.toBase58()).join(" "));
    process.exit(0);
  }
  const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const simulate = async (label: string, ix: TransactionInstruction) => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: holder, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ix] }).compileToLegacyMessage();
    const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = (r.value.logs ?? []).filter((l) => /AnchorError|Instruction: |failed|success$/.test(l)).map((l) => l.replace(/ consumed .*/, ""));
    console.log(`${label}: err=${JSON.stringify(r.value.err)}\n  ${logs.join("\n  ")}`);
  };
  const data = Buffer.alloc(24);
  COLLECT_IX.copy(data, 0);
  await simulate("collect_fees on TEST's lock", new TransactionInstruction({ programId: LOCKER, data, keys: [
    m(holder, true, true), m(LOCK, false, true), m(nftAcc, false, false), m(lockVault, false, true), m(pool, false, true), m(poolAuthority(XDEX), false, false),
    m(holder0, false, true), m(holder1, false, true), m(pk(2), false, true), m(pk(3), false, true), m(TOKEN_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
    m(pk(5), false, false), m(pk(6), false, false), m(lpMint, false, true), m(MEMO_PROGRAM_ID, false, false), m(XDEX, false, false),
  ] }));
  await simulate("claim_reward on its USDC.X vault", new TransactionInstruction({ programId: LOCKER, data: Buffer.from(CLAIM_REWARD_IX), keys: [
    m(holder, true, false), m(vault, false, true), m(vaultTokens, false, true), m(reward, false, false), m(nftAcc, false, false), m(holderReward, false, true),
    m(TOKEN_2022_PROGRAM_ID, false, false), m(TOKEN_2022_PROGRAM_ID, false, false),
  ] }));
  const locks = await listLocks(conn, LOCKER, pool);
  console.log(`listLocks: ${locks.map((l) => `${l.address.toBase58()} lp ${l.lockedLp} fee ${l.feeLpCollected} unlockAt ${l.unlockAt}`).join("; ")}`);
  process.exit(0);
}

// ---------- the upgrade ----------
const XDEX = new PublicKey("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
const send = (ixs: TransactionInstruction[], signers: Keypair[], cu = 1_000_000) =>
  sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs), signers, { commitment: "confirmed" });
async function fails(label: string, p: Promise<unknown>, match: RegExp) {
  try { await p; } catch (e) {
    const logs = ((e as { logs?: string[] }).logs ?? []).join("\n") + String(e);
    assert.match(logs, match, `${label}: failed, but not for the expected reason:\n${logs.slice(-1500)}`);
    ok(`rejected: ${label}`);
    return;
  }
  throw new Error(`${label}: should have failed`);
}
const owner = Keypair.generate(), trader = Keypair.generate();
for (const k of [owner, trader]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 500 * LAMPORTS_PER_SOL), "confirmed");

/** A Token-2022 mint, with a transfer fee if asked, and 1e15 base units in the owner's account. */
async function makeMint(decimals: number, feeBps?: number) {
  const mintKp = Keypair.generate(), mint = mintKp.publicKey;
  const len = getMintLen(feeBps === undefined ? [] : [ExtensionType.TransferFeeConfig]);
  const ata = getAssociatedTokenAddressSync(mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  await send([
    SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: mint, space: len, lamports: await conn.getMinimumBalanceForRentExemption(len), programId: TOKEN_2022_PROGRAM_ID }),
    ...(feeBps === undefined ? [] : [createInitializeTransferFeeConfigInstruction(mint, null, owner.publicKey, feeBps, 2n ** 64n - 1n, TOKEN_2022_PROGRAM_ID)]),
    createInitializeMintInstruction(mint, decimals, owner.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint, ata, owner.publicKey, 1_000_000_000_000_000n, [], TOKEN_2022_PROGRAM_ID),
  ], [owner, mintKp], 200_000);
  return mint;
}

console.log("On the old program");
const token = await makeMint(9);
const cp = buildCreatePool(XDEX, "testnet", owner.publicKey, token, 500_000_000_000_000n, 50_000_000_000n);
await send(cp.ixs, [owner]);
const cfg = { network: "testnet", distribution: { slippageBps: 100 }, token: { symbol: "LCK" }, mint: token.toBase58(), locker: { programId: LOCKER.toBase58(), nftUri: "" }, xdex: { programId: XDEX.toBase58(), pool: cp.pool.toBase58() } } as unknown as Config;
const target = { pool: cp.pool, mint: token, symbol: "LCK" };
const ownerLp = getAssociatedTokenAddressSync(cp.lpMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
const lpAll = (await getAccount(conn, ownerLp, "confirmed", TOKEN_PROGRAM_ID)).amount;
const lock = async (amount: bigint, unlockAt?: number) => {
  const b = await buildLock(conn, cfg, owner.publicKey, amount, unlockAt, target);
  await send(b.ixs, [owner, ...b.signers]);
  return b.summary.nftMint;
};
const unlockAfter = Math.floor(Date.now() / 1000) + 25;
const timedA = await lock(lpAll / 8n, unlockAfter), timedB = await lock(lpAll / 8n, unlockAfter), forever = await lock(lpAll / 4n);
ok("two timed locks and a forever lock");

// The old program has to have nft_mint writable: what the site sends today.
const readOnlyMint = (ix: TransactionInstruction, mint: PublicKey) => new TransactionInstruction({ programId: ix.programId, data: ix.data,
  keys: ix.keys.map((k) => (k.pubkey.equals(mint) ? { ...k, isWritable: false } : k)) });

const feeMint = await makeMint(6, 100), plain = await makeMint(6);
const deposit = async (mint: PublicKey, amount: bigint) => { const d = await buildDepositReward(conn, cfg, owner.publicKey, forever, mint, amount); await send(d.ixs, [owner]); };
await deposit(feeMint, 1_000_000n);
await deposit(plain, 1_000_000n);
ok("reward vaults on a transfer-fee mint and a plain mint, deposits in");
await sleep(Math.max(0, (unlockAfter + 1) * 1000 - Date.now()));
{
  const u = await buildUnlock(conn, cfg, owner.publicKey, timedA);
  await fails("unlock with nft_mint read-only, on the old program", send([readOnlyMint(u.ixs[1], timedA)], [owner]), /ConstraintMut|constraint/i);
}

console.log("Upgrading the program");
const so = process.env.UPGRADE_SO, key = process.env.UPGRADE_KEY;
assert.ok(so && key, "UPGRADE_SO and UPGRADE_KEY");
execFileSync("solana", ["program", "deploy", so, "--program-id", LOCKER.toBase58(), "--upgrade-authority", key, "--url", RPC, "--keypair", key, "--commitment", "confirmed"], { stdio: ["ignore", "pipe", "pipe"] });
await sleep(1_500);
const locks = await listLocks(conn, LOCKER, cp.pool);
assert.equal(locks.length, 3, "every lock still reads");
for (const l of locks) assert.ok(l.lockedLp > 0n && l.principal > 0n);
ok("upgraded; the locks read the same");

console.log("a. Unlock: nothing writes the NFT mint");
for (const [nft, how] of [[timedA, "read-only"], [timedB, "writable, as the site sends it"]] as const) {
  const before = (await conn.getAccountInfo(nft, "confirmed"))!;
  const lpBefore = (await getAccount(conn, ownerLp, "confirmed", TOKEN_PROGRAM_ID)).amount;
  const u = await buildUnlock(conn, cfg, owner.publicKey, nft);
  await send(how === "read-only" ? [u.ixs[0], readOnlyMint(u.ixs[1], nft)] : u.ixs, [owner]);
  assert.equal((await getAccount(conn, ownerLp, "confirmed", TOKEN_PROGRAM_ID)).amount, lpBefore + u.summary.lp, "the LP came back");
  assert.equal(await conn.getAccountInfo(lockPda(LOCKER, nft), "confirmed"), null, "lock closed");
  const after = (await conn.getAccountInfo(nft, "confirmed"))!;
  assert.ok(after.data.equals(before.data), "the mint's bytes are unchanged");
  assert.equal((await nftHolder(conn, nft))?.owner.toBase58(), owner.publicKey.toBase58(), "the NFT stays with its holder");
  assert.equal((await getMint(conn, nft, "confirmed", TOKEN_2022_PROGRAM_ID)).supply, 1n);
  ok(`unlocked with nft_mint ${how}`);
}

console.log("b. Fees collect on a lock made before");
for (let i = 0; i < 6; i++) await send(await buildBuy(conn, XDEX, trader, await quoteBuy(conn, XDEX, cp.pool, token, 2_000_000_000n, 500, 5000)), [trader]);
const lockBefore = (await listLocks(conn, LOCKER, cp.pool)).find((l) => l.nftMint.equals(forever))!;
const c = await buildCollect(conn, cfg, owner.publicKey, forever, true, target);
assert.ok(c.ixs?.length, "there are fees");
await send(c.ixs, [owner]);
const lockAfter = (await listLocks(conn, LOCKER, cp.pool)).find((l) => l.nftMint.equals(forever))!;
assert.ok(lockAfter.feeLpCollected > lockBefore.feeLpCollected);
ok(`collected ${lockAfter.feeLpCollected} LP of fees`);

console.log("c. Reward vaults");
const vestEnd = Date.now() + 60_000;
await deposit(feeMint, 500_000n);
ok("a deposit into the vault made before, whose mint the new rule refuses");
const newNft = await lock(lpAll / 8n);
const initFor = async (nft: PublicKey, mint: PublicKey) => (await buildDepositReward(conn, cfg, owner.publicKey, nft, mint, 1_000n)).ixs;
await fails("a new reward vault on a transfer-fee mint", send(await initFor(newNft, feeMint), [owner]), /BadRewardMint/);
await send(await initFor(newNft, plain), [owner]);
ok("a new reward vault on a plain Token-2022 mint");
const wxnt = new PublicKey("So11111111111111111111111111111111111111112");
await send(await initFor(newNft, wxnt), [owner]);
ok("a new reward vault on wrapped XNT (SPL Token)");
await sleep(Math.max(0, vestEnd - Date.now()));
const claimPlain = await buildClaimReward(conn, cfg, owner.publicKey, forever, plain);
await send(claimPlain.ixs, [owner]);
ok(`claimed ${claimPlain.amount} from the plain vault made before`);
// Why the rule exists, on either version: the vault books what was sent but receives it net of the
// fee, so it can't pay out what it booked. No live vault is on such a mint (see testdata/README.md).
await fails("a claim from the transfer-fee vault (short by the fee it was charged)", send((await buildClaimReward(conn, cfg, owner.publicKey, forever, feeMint)).ixs, [owner]), /insufficient funds/);

console.log("\nEvery lock and vault made on the old program works after the upgrade.");
