/**
 * The launchpad's "v4" tab (holder passes, X1 testnet trial): read routes for the page and
 * unsigned transactions for the visitor's wallet to turn passes on (the creator), register a
 * pass (any holder), run a round, pay passes or remove passes whose wallets sold below the
 * minimum (anyone). Every rule is enforced by the
 * program; these only assemble instructions.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint } from "@solana/spl-token";
import { fromBaseUnits, loadKeypair, toBaseUnits, type Config } from "../config.js";
import { LISTED_VAULT, PASS_MIN_INTERVAL_SECS, PASS_MIN_POT_XNT, registeredLaunches } from "./launch.js";
import { decodeVault, poolAccountsFrom, vaultPda } from "../taxvault.js";
import { decodePool } from "../xdex.js";
import { unsignedTx } from "../web/wallet-tx.js";
import {
  MAX_BATCH_SLOTS, MAX_PASSES, PAY_BATCH_LUT, SNAPSHOT_BATCH_LUT, allocPassBookIx, passTablesFor, allocSteps, closeRoundIx, decodePassBook, initPassesIx, passBookPda, passModeOn, passPot, payBatches, payPassesIx,
  evictionCandidate, evictMinimum, holderTokenAccount, POT_CAP_PCT_OF_TAX, passUnits, readPassTables, registerMinimum, registerPassEvictIx, registerPassIx, removablePasses, removalPlan,
  sponsorHoldersIx, snapshotBatchIx, snapshotBatches, type PassBook,
} from "../passes.js";

/** The launchpad's pass rules (earning from a millionth of the supply) and the floors the "turn on" form accepts. */
const PASS_HOLDING_DIVISOR = 1_000_000n, PASS_HOLDING_FLOOR_DIVISOR = 10_000_000n;
const MIN_POT_FLOOR = 10_000_000n, MIN_INTERVAL_FLOOR = 86_400n; // the program's MIN_ROUND_INTERVAL
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };

export function passesApi(conn: Connection, cfg: Config, program: PublicKey, opts: { microLamports: number }) {
  const xdex = new PublicKey(cfg.xdex.programId);
  // The crank's lookup tables let a visitor's round use v0 transactions with larger batches.
  const crankKey = (() => { try { return cfg.factory?.taxVault?.publisherKeypair ? loadKeypair(cfg.factory.taxVault.publisherKeypair).publicKey : null; } catch { return null; } })();
  // Any tables that cover the book (the program's own first), else the crank's.
  const tablesFor = (mint: PublicKey, book: PassBook) => passTablesFor(conn, program, mint, book).then((t) => (t.length || !crankKey ? t : passTablesFor(conn, program, mint, book, crankKey)));

  async function readAll(mint: PublicKey) {
    const vault = vaultPda(program, mint);
    const [vInfo, bInfo, mInfo] = await conn.getMultipleAccountsInfo([vault, passBookPda(program, vault), mint], "confirmed");
    if (!vInfo || !vInfo.owner.equals(program)) return null;
    const v = decodeVault(vault, vInfo.data);
    const book: PassBook | null = passModeOn(vInfo.data) && bInfo ? decodePassBook(passBookPda(program, vault), bInfo.data) : null;
    const mintState = mInfo ? unpackMint(mint, mInfo, TOKEN_2022_PROGRAM_ID) : null;
    const decimals = mintState?.decimals ?? 9;
    const taxBps = mintState ? getTransferFeeConfig(mintState)?.newerTransferFee.transferFeeBasisPoints ?? 0 : 0;
    return { v, book, decimals, taxBps, supply: mintState?.supply ?? 0n };
  }

  function bookJson(book: PassBook, funded: bigint, decimals: number, slot: number | null) {
    const live = book.roundOpen && slot !== null && BigInt(slot) <= book.roundStartSlot + BigInt(MAX_BATCH_SLOTS);
    return {
      count: book.count, capacity: MAX_PASSES, rounds: book.rounds.toString(),
      minHolding: fromBaseUnits(book.minHolding, decimals), registerMin: fromBaseUnits(registerMinimum(book.minHolding), decimals), minPotXnt: fromBaseUnits(book.minPot, 9), minIntervalSecs: book.minInterval,
      allocatedXnt: fromBaseUnits(book.allocated, 9), potXnt: fromBaseUnits(passPot(funded, book), 9),
      lastRoundAt: book.lastRoundAt || null, nextRoundAt: book.lastRoundAt ? book.lastRoundAt + book.minInterval : null,
      roundLive: live, roundRead: book.roundNext,
    };
  }

  /** Every launch with a vault under this program, and whether its holder passes are on. */
  async function tokens() {
    const launches = registeredLaunches();
    const out = [];
    const slot = await conn.getSlot("confirmed").catch(() => null);
    for (const r of launches) {
      const a = await readAll(new PublicKey(r.mint)).catch(() => null);
      if (!a) continue;
      out.push({
        mint: r.mint, symbol: r.symbol, name: r.name, guardian: a.v.guardian.toBase58(), passes: !!a.book,
        // For the creator's "turn on" form: the launchpad's own rules (earning from a millionth of the supply).
        defaults: a.book ? null : { minHolding: fromBaseUnits(a.supply / PASS_HOLDING_DIVISOR, a.decimals), minPotXnt: PASS_MIN_POT_XNT, minIntervalSecs: Number(PASS_MIN_INTERVAL_SECS) },
        fundedXnt: fromBaseUnits(a.v.holdersFunded, 9), paidXnt: fromBaseUnits(a.v.holdersPaid, 9),
        book: a.book ? bookJson(a.book, a.v.holdersFunded, a.decimals, slot) : null,
      });
    }
    return { program: program.toBase58(), network: cfg.network, tokens: out };
  }

  /** One token's passes in full, plus the asking wallet's own pass. */
  async function detail(mintStr: string, wallet: string | null) {
    const mint = new PublicKey(mintStr);
    const a = await readAll(mint);
    if (!a) throw new Error("No vault under the v4 program for this token.");
    const slot = await conn.getSlot("confirmed").catch(() => null);
    // Passes remove_pass would take now (under the minimum, owed nothing): a slot to free.
    const removable = a.book ? await removablePasses(conn, mint, a.book).catch(() => new Set<string>()) : new Set<string>();
    const passes = a.book ? a.book.entries.map((e) => ({
      index: e.index, wallet: e.wallet.toBase58(), short: short(e.wallet),
      counted: fromBaseUnits(e.weight, a.decimals), owedXnt: fromBaseUnits(e.owed, 9), paidXnt: fromBaseUnits(e.paid, 9),
      dueXnt: fromBaseUnits(e.owed - e.paid, 9), removable: removable.has(e.wallet.toBase58()),
    })) : [];
    // Most a round can pay right now (every round is capped, however many batches): the cap
    // on the last round's counted balances at the pool's price (the program uses the live
    // balances at close).
    let roundCapXnt: string | null = null;
    if (a.book) {
      try {
        const pool = poolAccountsFrom(xdex, decodePool(a.v.pool, await conn.getAccountInfo(a.v.pool, "confirmed"), xdex), mint);
        const [rt, rx] = await Promise.all([pool.tokenVault, pool.wxntVault].map((k) => conn.getTokenAccountBalance(k, "confirmed").then((r) => BigInt(r.value.amount))));
        const weight = a.book.entries.reduce((x, e) => x + e.weight, 0n);
        const capBps = BigInt(Math.floor((a.taxBps * POT_CAP_PCT_OF_TAX) / 100));
        if (rt > 0n) roundCapXnt = fromBaseUnits((weight * rx / rt) * capBps / 10_000n, 9);
      } catch { /* no estimate */ }
    }
    return {
      roundCapXnt, taxBps: a.taxBps,
      mint: mintStr, program: program.toBase58(), vault: a.v.address.toBase58(), guardian: a.v.guardian.toBase58(),
      passes: !!a.book, fundedXnt: fromBaseUnits(a.v.holdersFunded, 9), paidXnt: fromBaseUnits(a.v.holdersPaid, 9),
      book: a.book ? bookJson(a.book, a.v.holdersFunded, a.decimals, slot) : null,
      entries: passes, removable: removable.size, mine: wallet ? passes.find((p) => p.wallet === wallet) ?? null : null,
    };
  }

  async function post(url: string, body: Record<string, unknown>) {
    const m = /^\/api\/v4\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(init-tx|register-tx|round-tx|pay-tx|sponsor-tx|remove-tx)$/.exec(url);
    if (!m) return null;
    const [, mintStr, action] = m;
    const mint = new PublicKey(mintStr);
    const a = await readAll(mint);
    if (!a) throw new Error("No holder-passes vault for this token; launch one with “Holder passes” ticked on the launch page.");

    if (action === "init-tx") {
      const guardian = new PublicKey(String(body.wallet));
      if (!a.v.guardian.equals(guardian)) throw new Error(`Only the token's creator (${short(a.v.guardian)}) can turn on holder passes.`);
      if (a.book) throw new Error("Holder passes are already on for this token.");
      if (a.v.listEpoch > 0n || a.v.pendingEpoch > 0n) throw new Error(LISTED_VAULT);
      const minHolding = body.minHolding === undefined || body.minHolding === "" ? a.supply / PASS_HOLDING_DIVISOR : toBaseUnits(String(body.minHolding), a.decimals);
      const minPot = toBaseUnits(String(body.minPotXnt ?? PASS_MIN_POT_XNT), 9);
      const secs = Math.floor(Number(body.minIntervalSecs ?? PASS_MIN_INTERVAL_SECS));
      if (!Number.isFinite(secs)) throw new Error("Enter the seconds between rounds as a whole number.");
      const minInterval = BigInt(secs);
      // The program takes any values; these floors keep a pass from being nearly free (256 dust
      // wallets could fill the book) and rounds from paying out crumbs every few seconds.
      const floor = a.supply / PASS_HOLDING_FLOOR_DIVISOR;
      if (minHolding < floor || minHolding <= 0n) throw new Error(`The minimum holding must be at least ${fromBaseUnits(floor > 0n ? floor : 1n, a.decimals)} tokens (a ten-millionth of the supply); the launchpad uses ${fromBaseUnits(a.supply / PASS_HOLDING_DIVISOR, a.decimals)} (a millionth).`);
      if (minPot < MIN_POT_FLOOR) throw new Error(`Rounds need at least ${fromBaseUnits(MIN_POT_FLOOR, 9)} XNT waiting.`);
      if (minInterval < MIN_INTERVAL_FLOOR) throw new Error(`Rounds must be at least ${MIN_INTERVAL_FLOOR} seconds apart.`);
      // The book is bigger than one instruction may create: grow it in steps first, all in one transaction.
      const len = (await conn.getAccountInfo(passBookPda(program, a.v.address), "confirmed"))?.data.length ?? 0;
      const grow = Array.from({ length: allocSteps(len) }, () => allocPassBookIx(program, guardian, mint));
      const ix = initPassesIx(program, guardian, mint, minHolding, minPot, minInterval);
      return { tx: await unsignedTx(conn, guardian, [...grow, ix], [], opts) };
    }
    if (action === "sponsor-tx") {
      const sponsor = new PublicKey(String(body.wallet));
      const lamports = toBaseUnits(String(body.amountXnt ?? ""), 9);
      if (lamports <= 0n) throw new Error("Enter how much XNT to add for holders.");
      const have = BigInt(await conn.getBalance(sponsor, "confirmed"));
      if (have < lamports + 5_000_000n) throw new Error(`This wallet has ${fromBaseUnits(have, 9)} XNT; sponsoring ${fromBaseUnits(lamports, 9)} needs a little more for the fee.`);
      return { tx: await unsignedTx(conn, sponsor, [sponsorHoldersIx(program, sponsor, mint, lamports)], [], opts) };
    }
    if (!a.book) throw new Error("Holder passes aren't on for this token yet (its creator turns them on).");

    if (action === "register-tx") {
      const wallet = new PublicKey(String(body.wallet));
      if (a.book.entries.some((e) => e.wallet.equals(wallet))) throw new Error("This wallet already has a pass.");
      const need = registerMinimum(a.book.minHolding);
      const held = await conn.getTokenAccountBalance(holderTokenAccount(wallet, mint), "confirmed").then((r) => BigInt(r.value.amount)).catch(() => 0n);
      if (held < need) throw new Error(`A pass needs at least ${fromBaseUnits(need, a.decimals)} tokens in this wallet (twice the ${fromBaseUnits(a.book.minHolding, a.decimals)} that earns); it holds ${fromBaseUnits(held, a.decimals)}.`);
      if (a.book.count < MAX_PASSES) return { tx: await unsignedTx(conn, wallet, [registerPassIx(program, wallet, mint)], [], opts) };
      // A full book: take the slot of the smallest pass owed nothing, with twice its balance.
      const slot = await evictionCandidate(conn, mint, a.book);
      if (!slot) throw new Error(`All ${MAX_PASSES} passes are taken and each is owed XNT right now; try again after the next payout.`);
      const needed = evictMinimum(a.book.minHolding, slot.balance);
      if (held < needed) {
        throw new Error(`All ${MAX_PASSES} passes are taken. To take the slot of the smallest one (${short(slot.entry.wallet)}, holding ${fromBaseUnits(slot.balance, a.decimals)}), this wallet needs ${fromBaseUnits(needed, a.decimals)} tokens; it holds ${fromBaseUnits(held, a.decimals)}.`);
      }
      const tables = !!(await readPassTables(conn, program, mint));
      return { tx: await unsignedTx(conn, wallet, [registerPassEvictIx(program, wallet, mint, slot.entry, tables)], [], opts),
        evicts: slot.entry.wallet.toBase58() };
    }

    const caller = new PublicKey(String(body.wallet));
    if (action === "round-tx") {
      if (!a.book.count) throw new Error("Nobody has registered a pass yet.");
      const poolInfo = await conn.getAccountInfo(a.v.pool, "confirmed");
      const pool = poolAccountsFrom(xdex, decodePool(a.v.pool, poolInfo, xdex), mint);
      const txs = [];
      const tables = await tablesFor(mint, a.book);
      const batches = snapshotBatches(a.book, tables.length ? SNAPSHOT_BATCH_LUT : undefined);
      // Measured on testnet: ~33k units for 56 reads, ~131k to close 256 passes.
      for (const [i, b] of batches.entries()) {
        // Only the first is simulated: later batches count on the round the first opens.
        txs.push({ label: `Read balances ${b.start + 1}–${b.start + b.accounts.length}`,
          tx: await unsignedTx(conn, caller, [snapshotBatchIx(program, caller, mint, b.start, b.accounts)], [], { ...opts, units: passUnits.read(b.accounts.length), simulate: i === 0, tables }) });
      }
      txs.push({ label: "Close the round and split the pot (you earn 1% of it)",
        tx: await unsignedTx(conn, caller, [closeRoundIx(program, caller, mint, pool.pool, pool.tokenVault, pool.wxntVault)], [], { ...opts, units: passUnits.close(a.book.count), simulate: false, tables }) });
      return { txs, windowSlots: MAX_BATCH_SLOTS, lookupTables: tables.length };
    }
    if (action === "remove-tx") {
      const slot = await conn.getSlot("confirmed");
      if (a.book.roundOpen && BigInt(slot) <= a.book.roundStartSlot + BigInt(MAX_BATCH_SLOTS)) throw new Error("A round is being read right now; try again in a minute.");
      const gone = await removablePasses(conn, mint, a.book);
      if (!gone.size) throw new Error("Every pass's wallet still holds the minimum (or is owed XNT), so there's nothing to remove.");
      const tables = !!(await readPassTables(conn, program, mint));
      const plan = removalPlan(program, caller, mint, a.book, gone, tables);
      const txs = [];
      // Only the first is simulated: each later one counts on the book the earlier ones leave.
      for (const [i, r] of plan.entries()) {
        txs.push({ label: `Remove the pass of ${short(r.wallet)}`, tx: await unsignedTx(conn, caller, [r.ix], [], { ...opts, units: 40_000, simulate: i === 0 }) });
      }
      return { txs, more: gone.size - plan.length };
    }
    // pay-tx
    const tables = await tablesFor(mint, a.book);
    const groups = payBatches(a.book, tables.length ? PAY_BATCH_LUT : undefined);
    if (!groups.length) throw new Error("No pass is owed anything right now.");
    const txs = [];
    for (const g of groups) {
      txs.push({ label: `Pay ${g.length} wallet${g.length === 1 ? "" : "s"}`,
        tx: await unsignedTx(conn, caller, [payPassesIx(program, caller, mint, g)], [], { ...opts, units: passUnits.pay(g.length), tables }) });
    }
    return { txs };
  }

  return { tokens, detail, post };
}
