/**
 * Holder passes: pull-based holder rewards on the lp_locker program.
 *
 * A token's distributor creates one HolderPool for the token (init_holder_pool). Holders
 * mint a 1-of-1 pass NFT (mint_pass). Each cycle the distributor adds every pass's share
 * to its cumulative total, builds a Merkle tree of (pass, cumulative) and posts the root
 * plus the XNT in one transaction (set_root). Whoever holds a pass claims the difference
 * between its cumulative total and what it already claimed (claim_pass).
 *
 * The tree here must match the program byte for byte: leaf = sha256("99tax-pass" ||
 * pass mint || cumulative u64 LE); inner node = sha256(smaller || larger); an odd node
 * moves up unchanged. Leaves are sorted, so the same totals always give the same root.
 */
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction, getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";

const disc = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
export const INIT_HOLDER_POOL_IX = disc("global:init_holder_pool");
export const SET_ROOT_IX = disc("global:set_root");
export const MINT_PASS_IX = disc("global:mint_pass");
export const CLAIM_PASS_IX = disc("global:claim_pass");
const HOLDER_POOL_ACCOUNT = disc("account:HolderPool");
const PASS_ACCOUNT = disc("account:Pass");
const PASS_LEN = 8 + 32 * 3 + 8 + 8 + 1;

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

export const holderPoolPda = (programId: PublicKey, tokenMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("holders"), tokenMint.toBuffer()], programId)[0];
export const passPda = (programId: PublicKey, passMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pass"), passMint.toBuffer()], programId)[0];

export interface HolderPool {
  address: PublicKey; tokenMint: PublicKey; authority: PublicKey; root: Buffer;
  epoch: bigint; totalFunded: bigint; totalClaimed: bigint; passes: bigint;
}
export interface Pass { address: PublicKey; tokenMint: PublicKey; passMint: PublicKey; minter: PublicKey; claimed: bigint; createdAt: number }

export function decodeHolderPool(address: PublicKey, d: Buffer): HolderPool {
  if (!d.subarray(0, 8).equals(HOLDER_POOL_ACCOUNT)) throw new Error("Not a HolderPool account");
  return {
    address, tokenMint: new PublicKey(d.subarray(8, 40)), authority: new PublicKey(d.subarray(40, 72)), root: Buffer.from(d.subarray(72, 104)),
    epoch: d.readBigUInt64LE(104), totalFunded: d.readBigUInt64LE(112), totalClaimed: d.readBigUInt64LE(120), passes: d.readBigUInt64LE(128),
  };
}
export function decodePass(address: PublicKey, d: Buffer): Pass {
  if (!d.subarray(0, 8).equals(PASS_ACCOUNT)) throw new Error("Not a Pass account");
  return {
    address, tokenMint: new PublicKey(d.subarray(8, 40)), passMint: new PublicKey(d.subarray(40, 72)), minter: new PublicKey(d.subarray(72, 104)),
    claimed: d.readBigUInt64LE(104), createdAt: Number(d.readBigInt64LE(112)),
  };
}

export async function readHolderPool(conn: Connection, programId: PublicKey, tokenMint: PublicKey) {
  const address = holderPoolPda(programId, tokenMint);
  const info = await conn.getAccountInfo(address, "confirmed");
  return info ? { ...decodeHolderPool(address, info.data), lamports: BigInt(info.lamports) } : null;
}

/** Every pass minted for a token. */
export async function listPasses(conn: Connection, programId: PublicKey, tokenMint: PublicKey): Promise<Pass[]> {
  const raw = await conn.getProgramAccounts(programId, {
    commitment: "confirmed", filters: [{ dataSize: PASS_LEN }, { memcmp: { offset: 8, bytes: tokenMint.toBase58() } }],
  });
  return raw.map(({ pubkey, account }) => decodePass(pubkey, account.data)).sort((a, b) => a.createdAt - b.createdAt || a.passMint.toBase58().localeCompare(b.passMint.toBase58()));
}

// ---------- Merkle tree ----------

const sha = (...parts: Buffer[]) => crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
export function passLeaf(passMint: PublicKey, cumulative: bigint) {
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(cumulative);
  return sha(Buffer.from("99tax-pass"), passMint.toBuffer(), amt);
}
const node = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? sha(a, b) : sha(b, a));

/** Root and proofs for every (pass, cumulative) entry. Empty input gives an all-zero root. */
export function buildTree(entries: Record<string, bigint | string>) {
  const leaves = Object.entries(entries)
    .map(([pass, cum]) => ({ pass, leaf: passLeaf(new PublicKey(pass), BigInt(cum)) }))
    .sort((x, y) => Buffer.compare(x.leaf, y.leaf));
  if (leaves.length === 0) return { root: Buffer.alloc(32), proofs: {} as Record<string, Buffer[]> };
  const proofs: Record<string, Buffer[]> = {};
  let level: Buffer[] = leaves.map((l) => l.leaf);
  let positions = new Map(leaves.map((l, i) => [l.pass, i]));
  for (const l of leaves) proofs[l.pass] = [];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
    for (const [pass, i] of positions) {
      const sib = i ^ 1;
      if (sib < level.length) proofs[pass].push(level[sib]);
      positions.set(pass, i >> 1);
    }
    level = next;
  }
  return { root: level[0], proofs };
}

export function verifyProof(proof: Buffer[], root: Buffer, leaf: Buffer) {
  let h = leaf;
  for (const p of proof) h = node(h, p);
  return h.equals(root);
}

// ---------- Instructions ----------

export function initHolderPoolIx(programId: PublicKey, authority: PublicKey, tokenMint: PublicKey) {
  return new TransactionInstruction({
    programId, data: Buffer.from(INIT_HOLDER_POOL_IX),
    keys: [meta(authority, true, true), meta(tokenMint, false, false), meta(holderPoolPda(programId, tokenMint), false, true), meta(SystemProgram.programId, false, false)],
  });
}

export function setRootIx(programId: PublicKey, authority: PublicKey, tokenMint: PublicKey, root: Buffer, epoch: bigint, totalRewards: bigint) {
  const data = Buffer.alloc(8 + 32 + 8 + 8);
  SET_ROOT_IX.copy(data, 0); root.copy(data, 8); data.writeBigUInt64LE(epoch, 40); data.writeBigUInt64LE(totalRewards, 48);
  return new TransactionInstruction({
    programId, data,
    keys: [meta(authority, true, true), meta(holderPoolPda(programId, tokenMint), false, true), meta(SystemProgram.programId, false, false)],
  });
}

export function claimPassIx(programId: PublicKey, holder: PublicKey, tokenMint: PublicKey, passMint: PublicKey, cumulative: bigint, proof: Buffer[]) {
  const data = Buffer.alloc(8 + 8 + 4 + 32 * proof.length);
  CLAIM_PASS_IX.copy(data, 0); data.writeBigUInt64LE(cumulative, 8); data.writeUInt32LE(proof.length, 16);
  proof.forEach((p, i) => p.copy(data, 20 + 32 * i));
  return new TransactionInstruction({
    programId, data,
    keys: [
      meta(holder, true, true), meta(holderPoolPda(programId, tokenMint), false, true), meta(passPda(programId, passMint), false, true),
      meta(getAssociatedTokenAddressSync(passMint, holder, false, TOKEN_2022_PROGRAM_ID), false, false), meta(TOKEN_2022_PROGRAM_ID, false, false),
    ],
  });
}

/** The pass's on-chain artwork: a tiny SVG ticket (it has to fit in the mint transaction). */
function passUri(symbol: string) {
  const sym = symbol.replace(/[^A-Za-z0-9$._-]/g, "").slice(0, 10);
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 170' font-family='monospace' font-weight='bold' text-anchor='middle'>`
    + `<rect width='300' height='170' rx='14' fill='red'/><rect x='9' y='9' width='282' height='152' rx='9'/>`
    + `<text x='150' y='82' font-size='50' fill='red'>99¢</text><text x='150' y='124' font-size='17' fill='white'>HOLDER PASS ${sym}</text></svg>`;
  return `data:application/json,{"image":"data:image/svg+xml,${svg}"}`;
}

/**
 * Mint a holder pass for `tokenMint` to `owner`: a fresh Token-2022 NFT with on-chain
 * metadata, then mint_pass (mints the single token, revokes the mint authority and
 * records the pass). Returns the pass mint keypair, which must co-sign.
 */
export async function buildMintPass(conn: Connection, programId: PublicKey, owner: PublicKey, tokenMint: PublicKey, symbol: string) {
  const passMint = Keypair.generate();
  const ownerAta = getAssociatedTokenAddressSync(passMint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID);
  const name = `${symbol} Holder Pass`.slice(0, 32);
  const uri = passUri(symbol);
  const md: TokenMetadata = { mint: passMint.publicKey, name, symbol: "99PASS", uri, updateAuthority: owner, additionalMetadata: [] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(md).length);
  const ixs = [
    SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: passMint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(passMint.publicKey, owner, passMint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(passMint.publicKey, 0, owner, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: passMint.publicKey, updateAuthority: owner, mint: passMint.publicKey, mintAuthority: owner, name, symbol: "99PASS", uri }),
    createAssociatedTokenAccountIdempotentInstruction(owner, ownerAta, owner, passMint.publicKey, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({
      programId, data: Buffer.from(MINT_PASS_IX),
      keys: [
        meta(owner, true, true), meta(holderPoolPda(programId, tokenMint), false, true), meta(passMint.publicKey, false, true),
        meta(ownerAta, false, true), meta(passPda(programId, passMint.publicKey), false, true),
        meta(TOKEN_2022_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false),
      ],
    }),
  ];
  return { ixs, signers: [passMint], passMint: passMint.publicKey };
}
