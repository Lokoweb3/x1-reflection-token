/**
 * The recovery page's "Holder passes" panel, for a vault with passes turned on (vault v4,
 * testnet trial): the pass book read from the chain, and the buttons that keep it paying
 * with no server — register a pass, run a round, pay passes, sponsor holders. Transactions
 * are built here, signed by the visitor's wallet and sent straight to the RPC. A round uses
 * any active address lookup tables for the vault that hold every address it needs (v0
 * transactions, ~56 wallets per read); without them it uses plain ones (24 per read).
 */
import {
  ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type TransactionInstruction,
} from "@solana/web3.js";
import { fromBaseUnits, toBaseUnits } from "../config.js";
import { errorOf, poolAccountsFrom, type Vault } from "../taxvault.js";
import { decodePool } from "../xdex.js";
import { confirmByPolling } from "../tx.js";
import {
  MAX_BATCH_SLOTS, MAX_PASSES, PAY_BATCH_LUT, SNAPSHOT_BATCH_LUT, closeRoundIx, decodePassBook, holderTokenAccount, passBookPda, passModeOn,
  indexPlan, passPot, passTablesFor, passUnits, payBatches, payPassesIx, registerMinimum, registerPassIx, snapshotBatchIx, snapshotBatches, sponsorHoldersIx,
  type PassBook,
} from "../passes.js";

interface Ctx {
  conn: Connection; program: PublicKey; explorer: string; mint: PublicKey; v: Vault; xdex: PublicKey; decimals: number;
  wallet: () => string | null;
  signAll: (list: Uint8Array[]) => Promise<Uint8Array[]>;
  log: (text: string, kind?: "" | "good" | "bad", href?: string) => void;
  el: (tag: string, attrs?: Record<string, string>, ...kids: (Node | string | null | undefined | false)[]) => HTMLElement;
  reload: () => void;
}
const MICRO_LAMPORTS = 10_000;
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nowSecs = () => Math.floor(Date.now() / 1000);

/** The vault's pass book, or null when holder passes aren't on. */
export async function readBook(conn: Connection, program: PublicKey, vault: PublicKey): Promise<PassBook | null> {
  const [raw, book] = await conn.getMultipleAccountsInfo([vault, passBookPda(program, vault)], "confirmed");
  if (!raw || !passModeOn(raw.data) || !book) return null;
  return decodePassBook(passBookPda(program, vault), book.data);
}

/** Program errors a visitor can hit by racing someone else, in plain words. */
function friendly(m: string) {
  if (/AccountNotFound/.test(m)) return "your wallet has no XNT on this network to pay the fees (AccountNotFound). Fund it, or connect a wallet that has XNT here";
  if (/RoundOpen/.test(m)) return "a round is being read right now (most likely by a crank); it finishes within a minute";
  if (/RoundTooSoon/.test(m)) return "the last round was too recent";
  if (/PotTooSmall/.test(m)) return "not enough XNT is waiting for a round yet";
  if (/RoundExpired/.test(m)) return "the round's time window ran out before it closed; nothing is lost, run it again";
  if (/HoldingTooSmall/.test(m)) return "this wallet holds too few tokens to register";
  if (/PassBookFull/.test(m)) return "the pass book is full";
  return errorOf(m) ?? m.split("\n")[0];
}

/** Build, sign (one approval) and send transactions in order; a v0 one when `tables` is given. */
async function signAndSend(c: Ctx, steps: { label: string; ixs: TransactionInstruction[]; units: number }[], tables: AddressLookupTableAccount[]) {
  const payer = new PublicKey(c.wallet()!);
  const { blockhash, lastValidBlockHeight } = await c.conn.getLatestBlockhash("confirmed");
  const build = (s: (typeof steps)[number]) => {
    const ixs = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_LAMPORTS }), ComputeBudgetProgram.setComputeUnitLimit({ units: s.units }), ...s.ixs];
    return tables.length
      ? new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables))
      : new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...ixs);
  };
  const txs = steps.map(build);
  // Only the first can be simulated: later ones count on the earlier ones landing.
  const sim = txs[0] instanceof VersionedTransaction ? await c.conn.simulateTransaction(txs[0], { commitment: "confirmed" }) : await c.conn.simulateTransaction(txs[0]);
  if (sim.value.err) throw new Error(friendly((sim.value.logs ?? []).join(" ") || JSON.stringify(sim.value.err)));
  c.log(`Approve ${txs.length} transaction${txs.length === 1 ? "" : "s"} in your wallet…`);
  const signed = await c.signAll(txs.map((t) => (t instanceof VersionedTransaction ? t.serialize() : t.serialize({ requireAllSignatures: false, verifySignatures: false }))));
  let ok = 0;
  for (const [i, s] of steps.entries()) {
    try {
      const signature = await c.conn.sendRawTransaction(signed[i], { preflightCommitment: "confirmed", maxRetries: 5 });
      await confirmByPolling(c.conn, signed[i], signature, lastValidBlockHeight);
      ok++;
      c.log(`✓ ${s.label}`, "good", `${c.explorer}/tx/${signature}`);
    } catch (e) {
      c.log(`✗ ${s.label}: ${friendly(msg(e) + " " + ((e as { logs?: string[] }).logs ?? []).join(" "))}`, "bad");
      break;
    }
  }
  return ok;
}

/** The panel for one vault (empty when holder passes aren't on). */
export async function passesPanel(c: Ctx): Promise<HTMLElement | null> {
  const book = await readBook(c.conn, c.program, c.v.address);
  if (!book) return null;
  const { el } = c;
  const me = c.wallet();
  const pot = passPot(c.v.holdersFunded, book);
  const slot = await c.conn.getSlot("confirmed").catch(() => 0);
  const live = book.roundOpen && BigInt(slot) <= book.roundStartSlot + BigInt(MAX_BATCH_SLOTS);
  const wait = book.lastRoundAt + book.minInterval - nowSecs();
  const due = payBatches(book).flat();
  const mine = me ? book.entries.find((e) => e.wallet.toBase58() === me) ?? null : null;
  const tok = (n: bigint) => fromBaseUnits(n, c.decimals);
  const xnt = (n: bigint) => `${fromBaseUnits(n, 9)} XNT`;
  let busy = false;

  const box = el("section", { class: "panel" });
  box.append(el("h3", { text: "Holder passes" }),
    el("p", { class: "muted", text: "This vault splits the holders' share on-chain: registered wallets are paid by their live balance each round. Anyone can run a round or pay passes here; the program checks every account and amount." }),
    el("dl", {},
      el("div", { class: "kv" }, el("dt", { text: "Passes" }), el("dd", { text: `${book.count} / ${MAX_PASSES} · wallets holding ${tok(book.minHolding)}+ earn · registering needs ${tok(registerMinimum(book.minHolding))}` })),
      el("div", { class: "kv" }, el("dt", { text: "Waiting for holders" }), el("dd", { text: `${xnt(pot)} · a round runs once ${xnt(book.minPot)} waits and ${book.minInterval}s have passed` })),
      el("div", { class: "kv" }, el("dt", { text: "Rounds" }), el("dd", { text: `${book.rounds} · last ${book.lastRoundAt ? new Date(book.lastRoundAt * 1000).toLocaleString() : "never"}${live ? ` · a round is being read now (${book.roundNext} of ${book.count})` : ""}` })),
      el("div", { class: "kv" }, el("dt", { text: "Owed, not yet paid" }), el("dd", { text: due.length ? `${due.length} wallets, ${xnt(due.reduce((x, e) => x + e.owed - e.paid, 0n))}` : "nothing" })),
      el("div", { class: "kv" }, el("dt", { text: "Your pass" }), el("dd", { text: !me ? "connect a wallet" : mine ? `#${mine.index + 1} · counted ${tok(mine.weight)} · earned ${xnt(mine.owed)} · paid ${xnt(mine.paid)}` : "none" })),
    ));

  const act = async (label: string, f: () => Promise<number>) => {
    if (busy || !c.wallet()) return;
    busy = true;
    try { await f(); } catch (e) { c.log(`${label}: ${friendly(msg(e))}`, "bad"); }
    busy = false;
    setTimeout(c.reload, 3000);
  };
  const tablesFor = async (b: PassBook) => {
    // Bring the program's own lookup tables up to date first (one approval), then use them.
    const plan = await indexPlan(c.conn, c.program, c.mint, b, new PublicKey(me!)).catch(() => []);
    if (plan.length) {
      c.log(`Adding ${b.count} passes to the vault's lookup tables first (${plan.length} transaction${plan.length === 1 ? "" : "s"}).`);
      const ok = await signAndSend(c, plan.map((ix, i) => ({ label: `Index passes (${i + 1} of ${plan.length})`, ixs: [ix], units: 120_000 })), []);
      if (ok === plan.length) await new Promise((r) => setTimeout(r, 1500)); // new entries work from the next slot
    }
    const t = await passTablesFor(c.conn, c.program, c.mint, b).catch(() => []);
    if (!t.length) c.log("No lookup tables for this vault: using plain transactions (more of them).");
    return t;
  };
  const btn = (text: string, onClick: () => void, disabled: boolean) => {
    const b = el("button", { type: "button", text }) as HTMLButtonElement;
    b.onclick = onClick; b.disabled = disabled || !me;
    return b;
  };

  const row = el("div", { class: "row" });
  if (me && !mine) row.append(btn("Register my pass", () => void act("Register", async () => {
    const held = await c.conn.getTokenAccountBalance(holderTokenAccount(new PublicKey(me), c.mint), "confirmed").then((r) => BigInt(r.value.amount)).catch(() => 0n);
    if (held < registerMinimum(book.minHolding)) throw new Error(`a pass needs ${tok(registerMinimum(book.minHolding))} tokens in this wallet; it holds ${tok(held)}`);
    return signAndSend(c, [{ label: "Register my pass", ixs: [registerPassIx(c.program, new PublicKey(me), c.mint)], units: 60_000 }], []);
  }), book.count >= MAX_PASSES));

  const roundText = live ? "Round being read…" : wait > 0 ? `Next round in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}` : pot < book.minPot ? `Round at ${xnt(book.minPot)}` : "Run a round";
  row.append(btn(roundText, () => void act("Run a round", async () => {
    const fresh = (await readBook(c.conn, c.program, c.v.address))!;
    const tables = await tablesFor(fresh);
    const pool = poolAccountsFrom(c.xdex, decodePool(c.v.pool, await c.conn.getAccountInfo(c.v.pool, "confirmed"), c.xdex), c.mint);
    const caller = new PublicKey(me!);
    const steps = snapshotBatches(fresh, tables.length ? SNAPSHOT_BATCH_LUT : undefined).map((b) => ({
      label: `Read balances ${b.start + 1}–${b.start + b.accounts.length}`, ixs: [snapshotBatchIx(c.program, caller, c.mint, b.start, b.accounts)], units: passUnits.read(b.accounts.length) }));
    steps.push({ label: "Close the round and split the pot (you earn 1% of it)", ixs: [closeRoundIx(c.program, caller, c.mint, pool.pool, pool.tokenVault, pool.wxntVault)], units: passUnits.close(fresh.count) });
    return signAndSend(c, steps, tables);
  }), !book.count || live || wait > 0 || pot < book.minPot));

  row.append(btn(due.length ? `Pay ${due.length} wallet${due.length === 1 ? "" : "s"}` : "Pay passes", () => void act("Pay passes", async () => {
    const fresh = (await readBook(c.conn, c.program, c.v.address))!;
    const tables = await tablesFor(fresh);
    const caller = new PublicKey(me!);
    const steps = payBatches(fresh, tables.length ? PAY_BATCH_LUT : undefined).map((g) => ({
      label: `Pay ${g.length} wallet${g.length === 1 ? "" : "s"}`, ixs: [payPassesIx(c.program, caller, c.mint, g)], units: passUnits.pay(g.length) }));
    if (!steps.length) throw new Error("nobody is owed anything right now");
    return signAndSend(c, steps, tables);
  }), !due.length));
  box.append(row);

  if (c.v.payoutPool.equals(PublicKey.default)) {
    const amount = el("input", { value: "1", inputmode: "decimal", "aria-label": "XNT to sponsor", style: "max-width:120px" }) as HTMLInputElement;
    box.append(el("h3", { text: "Sponsor holders", style: "margin-top:16px;font-size:16px" }),
      el("p", { class: "muted", text: "Add XNT to the holders' share from your wallet. It can't be taken back; the next rounds split it by balance (a round read in several batches pays at most 80% of the tax rate on the counted tokens' value, so a large amount is paid over several rounds)." }),
      el("div", { class: "row" }, amount, btn("Sponsor holders", () => void act("Sponsor", async () => {
        const lamports = toBaseUnits(amount.value.trim(), 9);
        if (lamports <= 0n) throw new Error("enter an amount of XNT");
        return signAndSend(c, [{ label: `Sponsor holders ${fromBaseUnits(lamports, 9)} XNT`, ixs: [sponsorHoldersIx(c.program, new PublicKey(me!), c.mint, lamports)], units: 30_000 }], []);
      }), false)));
  }
  if (book.count) {
    const rows = book.entries.map((e) => el("tr", e.wallet.toBase58() === me ? { class: "me" } : {},
      el("td", { text: String(e.index + 1) }), el("td", { class: "mono" }, short(e.wallet.toBase58())),
      el("td", { class: "n", text: tok(e.weight) }), el("td", { class: "n", text: fromBaseUnits(e.owed, 9) }), el("td", { class: "n", text: fromBaseUnits(e.owed - e.paid, 9) })));
    box.append(el("details", {}, el("summary", { text: `All ${book.count} passes` }),
      el("table", { class: "passes" }, el("thead", {}, el("tr", {}, ...["#", "Wallet", "Counted", "Earned XNT", "Due XNT"].map((h) => el("th", { text: h })))), el("tbody", {}, ...rows))));
  }
  return box;
}
