/**
 * Local, read-only dashboard for the arb bot: profit by day, the windows you ask about (today, 24h, 7 days, all
 * time), fast mode against the week before it, the routes that pay, every recent trade, and whether the bot is
 * up. It reads the bot's own files (state/arb-trades.jsonl, arb-fast.json, arb-bot.log, arb-fast.off, arb.env)
 * and refreshes itself every 30 s.
 *
 *   npm run arb-page                # http://127.0.0.1:8125
 *   npm run arb-page -- --port 9002
 *
 * "Real" profit leaves out the share of each trade that came out of your own LP (the trade's ownShare): that
 * part only moves your money between the pools and the wallet. Times are US Eastern. It binds to localhost and
 * answers only GETs addressed to itself; it never signs or sends anything.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRivals, type LostRace, type Rival } from "./arb-rivals.js";

const ROOT = path.join(import.meta.dirname, "..");
const STATE = process.env.REFLECT_STATE_DIR ?? path.join(ROOT, "state");
const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8125;
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const TZ = "America/New_York";
const DAY = 86_400_000;

interface Trade { at: string; name: string; hops: number; xntIn: string; expectedProfit: string; actualProfit: string | null; ownShare?: number; signature: string; fast?: boolean }

const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));
const read = (f: string) => { try { return fs.readFileSync(path.join(STATE, f), "utf8"); } catch { return ""; } };

/** The last `bytes` of a file (the bot log is large; status and recent failures are near its end). */
function tail(f: string, bytes: number) {
  try {
    const fd = fs.openSync(path.join(STATE, f), "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").slice(start ? 1 : 0);
  } catch { return []; }
}
/** A log line's time (its "YYYY-MM-DD HH:MM:SS EDT|EST" stamp) in ms, or null. */
function stampMs(line: string) {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (EDT|EST)/.exec(line);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] === "EDT" ? "-04:00" : "-05:00"}`) : null;
}

let price: { at: number; usd: number | null } = { at: 0, usd: null };
/** XNT in USD from the XDEX API (cached 5 minutes; null if it can't be read). */
async function xntUsd() {
  if (Date.now() - price.at < 5 * 60_000) return price.usd;
  try {
    const j = await (await fetch("https://api.xdex.xyz/api/xendex/pool/CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR", { signal: AbortSignal.timeout(5000) })).json() as { data?: Record<string, unknown> };
    const d = j.data ?? {};
    const usd = d.token1_symbol === "WXNT" ? Number(d.token1_price) : d.token2_symbol === "WXNT" ? Number(d.token2_price) : NaN;
    price = { at: Date.now(), usd: Number.isFinite(usd) && usd > 0 ? usd : price.usd };
  } catch { price = { at: Date.now(), usd: price.usd }; }
  return price.usd;
}

/** A journaled trade in the page's units (XNT, ms), with its real profit (your own LP's share left out). */
function toTrade(t: Trade) {
  const gross = Number(t.actualProfit) / 1e9, own = t.ownShare ?? 0;
  return { at: Date.parse(t.at), name: t.name.replace(/ buy-(main|side)$/, ""), dir: /buy-(main|side)$/.exec(t.name)?.[0] ?? "pair", hops: t.hops,
    xntIn: Number(t.xntIn) / 1e9, expected: Number(t.expectedProfit) / 1e9, gross, own, real: gross * (1 - own), fast: !!t.fast, signature: t.signature };
}
/**
 * The tokens a route passes through, from its name (as the bot names them, src/arb-engine.ts routesFor):
 * "T/Q buy-side" is XNT → Q → T → XNT, "T/Q buy-main" XNT → T → Q → XNT, "T/Qa → T/Qb" XNT → Qa → T → Qb → XNT.
 */
export function tokenPath(name: string, dir: string): string[] {
  const pair = name.split(" → ");
  if (pair.length === 2) {
    const [t, qa] = pair[0].split("/"), qb = pair[1].split("/")[1];
    return t && qa && qb ? ["XNT", qa, t, qb, "XNT"] : [];
  }
  const [t, q] = name.split("/");
  if (!t || !q) return [];
  return dir === "buy-main" ? ["XNT", t, q, "XNT"] : ["XNT", q, t, "XNT"];
}
/** A "gap gone" log line as a lost race: when, which route, and its direction. */
function lostOf(line: string) {
  const m = /(?:EST|EDT) (.+?) \(\d+ swaps via [^)]*\): gap gone before/.exec(line);
  if (!m) return null;
  return { at: stampMs(line) ?? Date.now(), name: m[1].replace(/ buy-(main|side)$/, ""), dir: /buy-(main|side)$/.exec(m[1])?.[0] ?? "pair" };
}

interface Lost { at: string; name: string; hops: number; pools?: string[]; xntIn: string; expectedProfit: string; ownShare?: number; reason: string; fee?: string }
/** A journaled lost race in the page's units: what the plan expected it to make, and the real part of that. */
function toLost(l: Lost) {
  const expected = Number(l.expectedProfit) / 1e9, own = l.ownShare ?? 0;
  return { at: Date.parse(l.at), name: l.name.replace(/ buy-(main|side)$/, ""), dir: /buy-(main|side)$/.exec(l.name)?.[0] ?? "pair", hops: l.hops,
    xntIn: Number(l.xntIn) / 1e9, expected, own, real: expected * (1 - own), reason: l.reason, fee: l.fee ? Number(l.fee) / 1e9 : 0,
    pools: l.pools ?? [], key: l.at + "|" + l.name };
}

function running() {
  try { process.kill(Number(read("arb-bot.pid").trim()), 0); return true; } catch { return false; }
}

async function data() {
  const now = Date.now();
  const trades = read("arb-trades.jsonl").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Trade]; } catch { return []; } })
    .filter((t) => t.actualProfit !== null && Number.isFinite(Number(t.actualProfit))).map(toTrade);
  const sum = (from: number) => {
    const s = trades.filter((t) => t.at >= from);
    return { trades: s.length, gross: s.reduce((a, t) => a + t.gross, 0), real: s.reduce((a, t) => a + t.real, 0) };
  };
  const todayStart = Date.parse(`${dayOf(now)}T00:00:00${new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).format(now).endsWith("EDT") ? "-04:00" : "-05:00"}`);

  // Profit by Eastern day since the first trade (days with no trades included).
  const byDay = new Map<string, { real: number; own: number; trades: number }>();
  const today = dayOf(now);
  for (let d = trades.length ? dayOf(trades[0].at) : today; d <= today; d = new Date(Date.parse(`${d}T12:00:00Z`) + DAY).toISOString().slice(0, 10))
    byDay.set(d, { real: 0, own: 0, trades: 0 });
  for (const t of trades) { const d = byDay.get(dayOf(t.at)); if (d) { d.real += t.real; d.own += t.gross - t.real; d.trades++; } }

  // When the money comes: real profit by Eastern weekday and hour, the last 30 days.
  const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ real: 0, trades: 0 })));
  const wh = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" });
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (const t of trades.filter((x) => x.at >= now - 30 * DAY)) {
    const parts = Object.fromEntries(wh.formatToParts(new Date(t.at)).map((q) => [q.type, q.value]));
    const c = heat[WD.indexOf(parts.weekday)]?.[Number(parts.hour) % 24];
    if (c) { c.real += t.real; c.trades++; }
  }

  // Fast mode: when the running bot started with it, what it made since, against the week before.
  const log = tail("arb-bot.log", 4_000_000);
  const starts = log.filter((l) => l.includes(" arb bot LIVE: "));
  const lastStart = starts.at(-1) ?? "";
  const fastSince = (() => { for (let i = starts.length - 1; i >= 0; i--) if (!starts[i].includes("FAST:")) return i + 1 < starts.length ? stampMs(starts[i + 1]) : null; return starts.length ? stampMs(starts[0]) : null; })();
  const fastOn = lastStart.includes("FAST:");
  let fast = null;
  if (fastOn && fastSince) {
    const s = trades.filter((t) => t.at >= fastSince), days = Math.max((now - fastSince) / DAY, 1 / 24);
    const before = trades.filter((t) => t.at >= fastSince - 7 * DAY && t.at < fastSince).reduce((a, t) => a + t.real, 0) / 7;
    const failed = log.filter((l) => (stampMs(l) ?? 0) >= fastSince && l.includes("gap gone before it landed") && l.includes("[fast]"));
    const fees = failed.reduce((a, l) => a + Number(/fee ([\d.]+) XNT/.exec(l)?.[1] ?? 0), 0);
    let guard: { day: string; spent: string; made: string } | null = null;
    try { guard = JSON.parse(read("arb-fast.json")); } catch { /* none yet */ }
    const args = /ARB_FAST_ARGS="([^"]*)"/.exec(read("arb.env"))?.[1] ?? "";
    const maxLoss = Number(/--fast-max-loss ([\d.]+)/.exec(args)?.[1] ?? 0.05) * 1e9;
    const tripped = !!guard && guard.day === dayOf(now) && Number(guard.spent) > Number(guard.made) + maxLoss;
    fast = { since: fastSince, tripped, landed: s.length, fastLanded: s.filter((t) => t.fast).length, real: s.reduce((a, t) => a + t.real, 0), perDay: s.reduce((a, t) => a + t.real, 0) / days,
      beforePerDay: before, failed: failed.length, failedFees: fees, guard: guard && guard.day === dayOf(now) ? guard : null, args };
  }

  // Routes over the last 7 days, by real profit.
  const routes = new Map<string, { trades: number; real: number; gross: number; own: number; last: number }>();
  for (const t of trades.filter((x) => x.at >= now - 7 * DAY)) {
    const r = routes.get(t.name) ?? { trades: 0, real: 0, gross: 0, own: 0, last: 0 };
    r.trades++; r.real += t.real; r.gross += t.gross; r.own = t.own; r.last = Math.max(r.last, t.at);
    routes.set(t.name, r);
  }
  // Races, last 24 hours: trades that landed against gaps another trader closed first (either path's log line).
  const lostLines = log.filter((l) => (stampMs(l) ?? 0) >= now - DAY && l.includes(": gap gone before"));
  const lostBy = new Map<string, number>();
  for (const l of lostLines) { const n = /(?:EST|EDT) (.+?) \(\d+ swaps/.exec(l)?.[1]?.replace(/ buy-(main|side)$/, ""); if (n) lostBy.set(n, (lostBy.get(n) ?? 0) + 1); }
  const races = { won: trades.filter((t) => t.at >= now - DAY).length, lost: lostLines.length,
    top: [...lostBy].map(([name, lost]) => ({ name, lost })).sort((a, b) => b.lost - a.lost).slice(0, 5) };
  // Lost races with their value (journaled since the bot started recording them).
  const lostRows = read("arb-lost.jsonl").split("\n").filter(Boolean).flatMap((l) => { try { return [toLost(JSON.parse(l) as Lost)]; } catch { return []; } });
  const missed = (from: number) => { const r = lostRows.filter((x) => x.at >= from); return { races: r.length, expected: r.reduce((a, x) => a + x.expected, 0), real: r.reduce((a, x) => a + x.real, 0), fees: r.reduce((a, x) => a + x.fee, 0) }; };
  const withRival = (x: ReturnType<typeof toLost>) => { const r = rivals.get(x.key); const { pools: _p, ...rest } = x; return { ...rest, rival: r ? { kind: r.kind, wallet: r.wallet, signature: r.signature, slotsAfterOpen: r.slotsAfterOpen, cuPrice: r.cuPrice, profit: r.profit } : null }; };
  const lostLog = { since: lostRows[0]?.at ?? null, today: missed(todayStart), h24: missed(now - DAY), d7: missed(now - 7 * DAY), all: missed(0), recent: lostRows.slice(-80).reverse().map(withRival) };
  // Who beat us, the last 7 days: every lost race looked up so far, grouped by the wallet that closed the gap.
  const looked = rivals.all().filter((r) => r.at >= now - 7 * DAY);
  const byWallet = new Map<string, Rival[]>();
  for (const r of looked) if (r.wallet) byWallet.set(r.wallet, [...(byWallet.get(r.wallet) ?? []), r]);
  const med = (v: number[]) => { const a = v.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const whoBeatUs = {
    looked: looked.length, pending: lostRaces(now).filter((r) => !rivals.get(r.key)).length,
    arbs: looked.filter((r) => r.kind === "arb").length, trades: looked.filter((r) => r.kind === "trade").length, unknown: looked.filter((r) => r.kind === "unknown").length,
    medianSlots: med(looked.flatMap((r) => (r.slotsAfterOpen ?? null) === null ? [] : [r.slotsAfterOpen as number])),
    medianSecs: med(looked.flatMap((r) => r.secondsBeforeUs === undefined ? [] : [r.secondsBeforeUs])),
    rivals: [...byWallet].map(([wallet, rs]) => {
      const routes = new Map<string, number>(); for (const r of rs) routes.set(r.name, (routes.get(r.name) ?? 0) + 1);
      return { wallet, wins: rs.length, arbs: rs.filter((r) => r.kind === "arb").length, routes: [...routes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => ({ name: n, wins: c })),
        medianSlots: med(rs.flatMap((r) => (r.slotsAfterOpen ?? null) === null ? [] : [r.slotsAfterOpen as number])), medianCuPrice: med(rs.flatMap((r) => r.cuPrice === undefined ? [] : [r.cuPrice])),
        swaps: med(rs.flatMap((r) => r.swaps === undefined ? [] : [r.swaps])), profit: rs.reduce((a, r) => a + (r.kind === "arb" && r.profit ? r.profit : 0), 0), last: Math.max(...rs.map((r) => r.at)) };
    }).sort((a, b) => b.wins - a.wins).slice(0, 10),
  };
  // The route map: the tokens traded most over 7 days around XNT, and how often each leg between two was used.
  const tokCount = new Map<string, number>(), legs = new Map<string, number>();
  for (const t of trades.filter((x) => x.at >= now - 7 * DAY)) {
    const p = tokenPath(t.name, t.dir);
    for (const k of new Set(p)) if (k !== "XNT") tokCount.set(k, (tokCount.get(k) ?? 0) + 1);
    for (let i = 0; i + 1 < p.length; i++) { const k = [p[i], p[i + 1]].sort().join("|"); legs.set(k, (legs.get(k) ?? 0) + 1); }
  }
  const nodes = [...tokCount].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([sym, n]) => ({ sym, trades: n }));
  const keep = new Set(["XNT", ...nodes.map((n) => n.sym)]);
  const map = { nodes, legs: [...legs].map(([k, n]) => { const [a, b] = k.split("|"); return { a, b, trades: n }; }).filter((l) => keep.has(l.a) && keep.has(l.b)) };
  // The radar's last hour: races won (trades) and lost.
  const radar = [...trades.filter((t) => t.at >= now - 3_600_000).map((t) => ({ at: t.at, kind: "won", name: t.name, real: t.real })),
    ...log.filter((l) => (stampMs(l) ?? 0) >= now - 3_600_000).flatMap((l) => { const x = lostOf(l); return x ? [{ at: x.at, kind: "lost", name: x.name, real: 0 }] : []; })];
  const lastLine = [...log].reverse().find((l) => stampMs(l) !== null) ?? "";
  const scan = [...log].reverse().find((l) => / scan: \d+ pools/.test(l)) ?? "";
  const peg = [...log].reverse().find((l) => l.includes(" peg GOOGL: ")) ?? "";
  return {
    now, xntUsd: await xntUsd(),
    windows: { today: sum(todayStart), h24: sum(now - DAY), d7: sum(now - 7 * DAY), all: sum(0) },
    firstTrade: trades[0]?.at ?? null,
    days: [...byDay].map(([day, v]) => ({ day, ...v })),
    // Real profit per hour, the last 24 hours (oldest first).
    hours: Array.from({ length: 24 }, (_, i) => trades.filter((t) => t.at >= now - (24 - i) * 3_600_000 && t.at < now - (23 - i) * 3_600_000).reduce((a, t) => a + t.real, 0)),
    heat, races, map, radar, lostLog, whoBeatUs,
    fast,
    routes: [...routes].map(([name, r]) => ({ name, ...r })).sort((a, b) => b.real - a.real).slice(0, 12),
    recent: trades.slice(-60).reverse(),
    status: {
      running: running(), fastOn, fastOff: fs.existsSync(path.join(STATE, "arb-fast.off")),
      lastLogAt: stampMs(lastLine), scan: scan.replace(/^.*? scan: /, ""), peg: peg.replace(/^.*? peg GOOGL: /, ""),
    },
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arb Bot Tracker</title>
<style>
:root{color-scheme:light;--bg:#eef0f3;--bg2:#e6e9ee;--card:#fbfbfc;--card2:#f3f4f6;--fg:#0b0d10;--muted:#4f5560;--faint:#878d97;--line:#dfe2e7;--grid:#e9ebef;
 --s1:#2a78d6;--s2:#eb6834;--good:#13834a;--bad:#c62828;--warn:#b26a00;--glow:rgba(42,120,214,.10)}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#07090c;--bg2:#0c1016;--card:#10141a;--card2:#151a22;--fg:#eef1f5;--muted:#aab2bf;--faint:#6f7886;--line:#1f2630;--grid:#19202a;
 --s1:#3987e5;--s2:#d95926;--good:#3ccf7e;--bad:#ff6b6b;--warn:#f0b44c;--glow:rgba(57,135,229,.18)}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#07090c;--bg2:#0c1016;--card:#10141a;--card2:#151a22;--fg:#eef1f5;--muted:#aab2bf;--faint:#6f7886;--line:#1f2630;--grid:#19202a;
 --s1:#3987e5;--s2:#d95926;--good:#3ccf7e;--bad:#ff6b6b;--warn:#f0b44c;--glow:rgba(57,135,229,.18)}
*{box-sizing:border-box}html,body{margin:0}
body{background:radial-gradient(1200px 500px at 15% -10%,var(--glow),transparent 60%),radial-gradient(900px 400px at 100% 0%,var(--glow),transparent 60%),var(--bg);
 background-attachment:fixed;color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
.num,.mono{font-family:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
main{max-width:1180px;margin:0 auto;padding:18px 16px 56px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,var(--s1),color-mix(in oklab,var(--s1) 40%,#000));display:grid;place-items:center;color:#fff;font-weight:800;font-size:18px;box-shadow:0 6px 20px var(--glow)}
h1{font-size:19px;margin:0;letter-spacing:-.01em}.sub{color:var(--muted);font-size:12px}
.chips{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:99px;border:1px solid var(--line);background:var(--card);font-size:12px;font-weight:600;color:var(--muted)}
.chip b{color:var(--fg)}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--good);position:relative}
.pulse::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--good);opacity:0;animation:ping 2s infinite}
.pulse.off{background:var(--bad)}.pulse.off::after{border-color:var(--bad)}
@keyframes ping{0%{transform:scale(.5);opacity:.8}100%{transform:scale(1.6);opacity:0}}
button{font:inherit;color:inherit;cursor:pointer}
.iconbtn{border:1px solid var(--line);background:var(--card);border-radius:99px;width:30px;height:30px;display:grid;place-items:center;color:var(--muted)}
.ring{width:16px;height:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:14px;position:relative}
.card h2{font-size:13px;margin:0;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.hero{display:grid;grid-template-columns:1.25fr 2fr;gap:14px;margin-top:16px}
@media (max-width:860px){.hero{grid-template-columns:1fr}}
.hero .card{margin-top:0}
.big{font-size:52px;font-weight:800;letter-spacing:-.03em;line-height:1.05;margin-top:8px}
.big small{font-size:16px;color:var(--muted);font-weight:600;letter-spacing:0;margin-left:6px}
.usd{font-size:18px;color:var(--good);font-weight:700;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media (max-width:620px){.kpis{grid-template-columns:1fr}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px;display:flex;flex-direction:column;gap:2px;min-width:0}
.kpi .k{font-size:12px;color:var(--muted);font-weight:600}.kpi .v{font-size:26px;font-weight:800;letter-spacing:-.02em}
.kpi .s{font-size:12px;color:var(--faint)}.spark{width:100%;height:34px;margin-top:6px}
.seg{display:inline-flex;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:2px}
.seg button{border:0;background:transparent;padding:4px 10px;border-radius:8px;font-size:12px;font-weight:600;color:var(--muted)}
.seg button.on{background:var(--card);color:var(--fg);box-shadow:0 1px 3px rgba(0,0,0,.15)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}@media (max-width:860px){.cols{grid-template-columns:1fr}}
.cols>.card{margin-top:0;min-width:0}
.cmp{display:grid;gap:10px;margin-top:6px}
.cmp .row{display:grid;grid-template-columns:110px 1fr 70px;gap:10px;align-items:center;font-size:12px;color:var(--muted)}
.bar{height:12px;border-radius:6px;background:var(--card2);overflow:hidden}.bar>span{display:block;height:100%;border-radius:6px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
.stat{background:var(--card2);border-radius:12px;padding:10px 12px}.stat .k{font-size:11px;color:var(--muted);font-weight:600}.stat .v{font-size:18px;font-weight:800;margin-top:2px}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.muted{color:var(--muted)}.faint{color:var(--faint)}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--card2);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
.heat{display:grid;grid-template-columns:30px repeat(24,minmax(0,1fr));gap:2px;font-size:10px;color:var(--faint)}
.heat .c{aspect-ratio:1;border-radius:3px;background:var(--card2)}
.heat .lbl{display:flex;align-items:center}
.ramp{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--faint);margin-top:8px}.ramp span.g{flex:0 0 120px;height:8px;border-radius:4px;background:linear-gradient(90deg,color-mix(in oklab,var(--s1) 12%,var(--card)),var(--s1))}
.route{display:grid;grid-template-columns:22px minmax(0,1.3fr) 2fr 84px;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.route:last-child{border-bottom:0}.route .rk{color:var(--faint);font-weight:700}.route .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.route .meta{font-size:11px;color:var(--faint)}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;border:1px solid var(--line);color:var(--muted);vertical-align:1px;margin-left:4px}
.tag.fast{border-color:color-mix(in oklab,var(--s1) 50%,var(--line));color:var(--s1)}
.tag.own{border-color:color-mix(in oklab,var(--s2) 50%,var(--line));color:var(--s2)}
table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font-size:11px;color:var(--faint);font-weight:600;text-transform:uppercase;letter-spacing:.05em}th.l,td.l{text-align:left}
tbody tr:hover{background:var(--card2)}
tr.new{animation:flash 2.4s ease-out}@keyframes flash{0%{background:color-mix(in oklab,var(--good) 30%,transparent)}100%{background:transparent}}
.scroll{overflow-x:auto}a{color:var(--s1);text-decoration:none}a:hover{text-decoration:underline}
.status{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.status .stat .v{font-size:13px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
#tip{position:fixed;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:none;z-index:9;min-width:140px}
#toasts{position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:10}
.toast{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--good);border-radius:12px;padding:10px 14px;box-shadow:0 10px 30px rgba(0,0,0,.3);font-size:13px;animation:in .3s ease-out}
@keyframes in{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
svg text{font-family:ui-monospace,Menlo,monospace}
/* motion */
.reveal{opacity:0;transform:translateY(16px);animation:rise .7s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
.card,.kpi{transition:transform .25s ease,box-shadow .25s ease,border-color .25s ease}
.card:hover,.kpi:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(0,0,0,.16);border-color:color-mix(in oklab,var(--s1) 35%,var(--line))}
.draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:drawline 1.2s cubic-bezier(.3,.6,.2,1) forwards}
@keyframes drawline{to{stroke-dashoffset:0}}
.fadein{opacity:0;animation:fade .9s .35s ease forwards}@keyframes fade{to{opacity:1}}
.grow{transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0);animation:grow .7s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes grow{to{transform:scaleY(1)}}
.heat.anim .c{opacity:0;transform:scale(.3);animation:pop .45s cubic-bezier(.2,.8,.3,1.3) forwards}
@keyframes pop{to{opacity:1;transform:none}}
.heat .c{transition:transform .15s}.heat .c:hover{transform:scale(1.35);position:relative;z-index:2;outline:2px solid var(--card)}
.bar>span{transition:width 1s cubic-bezier(.2,.7,.2,1)}
tr.new{animation:slidein .5s ease-out,flash 2.6s ease-out}
@keyframes slidein{from{opacity:0;transform:translateX(-14px)}}
.ticker{overflow:hidden;white-space:nowrap;margin-top:14px;border:1px solid var(--line);border-radius:12px;background:var(--card);padding:9px 0;
 -webkit-mask-image:linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent);mask-image:linear-gradient(90deg,transparent,#000 5%,#000 95%,transparent)}
.ticker .track{display:inline-flex;gap:30px;padding-left:30px;animation:tick var(--dur,80s) linear infinite}
.ticker:hover .track{animation-play-state:paused}
.ticker .it{font-size:12px;color:var(--muted)}.ticker .it b{font-family:ui-monospace,Menlo,monospace}
@keyframes tick{to{transform:translateX(-50%)}}
.float{position:absolute;right:22px;top:58px;font:800 20px ui-monospace,Menlo,monospace;color:var(--good);pointer-events:none;animation:floatup 2.4s ease-out forwards}
@keyframes floatup{0%{opacity:0;transform:translateY(12px) scale(.9)}15%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-46px)}}
.glow{animation:glow 1.8s ease-out}@keyframes glow{30%{filter:drop-shadow(0 0 16px color-mix(in oklab,var(--good) 75%,transparent))}}
.logo{animation:spin 8s linear infinite}@keyframes spin{0%,90%{transform:none}100%{transform:rotate(360deg)}}
.races{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center}@media (max-width:480px){.races{grid-template-columns:1fr;justify-items:center}}
.donut{width:120px;height:120px}.donut circle{transition:stroke-dasharray 1.1s cubic-bezier(.2,.7,.2,1)}
.lost{display:grid;gap:6px;margin-top:4px;font-size:12px}.lost .r{display:grid;grid-template-columns:minmax(0,1fr) 90px 28px;gap:8px;align-items:center}
.lost .r span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* aurora background: drifts slowly, brightens when a trade lands */
body::before{content:"";position:fixed;inset:-20%;z-index:-1;pointer-events:none;opacity:.75;transition:opacity .5s,filter .5s;filter:blur(30px);
 background:radial-gradient(40% 30% at 20% 20%,color-mix(in oklab,var(--s1) 22%,transparent),transparent 70%),radial-gradient(35% 30% at 80% 30%,color-mix(in oklab,var(--s2) 12%,transparent),transparent 70%),radial-gradient(40% 35% at 50% 90%,color-mix(in oklab,var(--good) 12%,transparent),transparent 70%);
 animation:aurora 30s ease-in-out infinite alternate}
@keyframes aurora{0%{transform:translate(0,0) rotate(0)}50%{transform:translate(3%,-2%) rotate(8deg)}100%{transform:translate(-3%,2%) rotate(-6deg)}}
body.flash::before{opacity:1;filter:blur(18px) brightness(1.5)}
/* odometer */
.od{display:inline-block;height:1.05em;overflow:hidden;vertical-align:bottom}
.od .col{display:flex;flex-direction:column;transition:transform 1.4s cubic-bezier(.2,.7,.2,1)}.od .col span{height:1.05em;line-height:1.05em}
/* coins */
.coin{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;pointer-events:none;z-index:30;display:grid;place-items:center;font:800 9px system-ui;color:#7a5200;
 background:radial-gradient(circle at 35% 30%,#fff6c8,#f2c14e 45%,#b8860b);box-shadow:0 0 10px rgba(242,193,78,.55)}
/* route flow */
.flowwrap{position:relative}#flow{display:block;width:100%;height:320px}
.leg{fill:none;stroke:var(--s1);stroke-linecap:round}
.leg.run{stroke-dasharray:3 9;animation:dash var(--d,2s) linear infinite}@keyframes dash{to{stroke-dashoffset:-24}}
.leg.hl{stroke:var(--warn);opacity:1!important}
.node circle{fill:var(--card2);stroke:color-mix(in oklab,var(--s1) 60%,var(--line));stroke-width:1.5;transition:stroke .2s,stroke-width .2s}
.node text{font:600 10px system-ui;fill:var(--muted)}.node.hl circle{stroke:var(--warn);stroke-width:3}.node.hl text{fill:var(--fg)}
.hub circle{fill:var(--s1);stroke:color-mix(in oklab,var(--s1) 50%,#fff);stroke-width:2}.hub text{fill:#fff;font:800 11px system-ui}
.hubring{fill:none;stroke:var(--s1);opacity:0;animation:hubring 3s ease-out infinite}@keyframes hubring{0%{r:22;opacity:.5}100%{r:60;opacity:0}}
.lostflash{fill:none;stroke:var(--s2);stroke-width:4;stroke-linecap:round;animation:lostfade 1.6s ease-out forwards}@keyframes lostfade{0%{opacity:.95}100%{opacity:0}}
.burst{fill:none;stroke:var(--good);stroke-width:3;animation:burst 1.2s ease-out forwards}@keyframes burst{0%{r:20;opacity:1}100%{r:70;opacity:0}}
.flowtxt{font:800 15px ui-monospace,Menlo,monospace;fill:var(--good);animation:floatsvg 2.2s ease-out forwards}@keyframes floatsvg{0%{opacity:0;transform:translateY(0)}15%{opacity:1}100%{opacity:0;transform:translateY(-34px)}}
/* radar */
#radar{display:block;width:100%;max-width:300px;margin:0 auto;aspect-ratio:1}
.sweep{transform-box:view-box;transform-origin:50% 50%;animation:sweep 4s linear infinite}@keyframes sweep{to{transform:rotate(360deg)}}
.blip{transition:opacity 1s}.ping{fill:none;stroke-width:2;animation:ping2 1.4s ease-out forwards}@keyframes ping2{0%{r:3;opacity:1}100%{r:22;opacity:0}}
.scanring{fill:none;stroke:var(--s1);stroke-width:2;animation:scanring 2.2s ease-out forwards}@keyframes scanring{0%{r:4;opacity:.8}100%{r:132;opacity:0}}
.events{display:grid;gap:4px;margin-top:10px;font-size:12px}.events .e{display:grid;grid-template-columns:62px 12px minmax(0,1fr) auto;gap:8px;align-items:center}
.events .e span:nth-child(3){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.events .dot{width:8px;height:8px;border-radius:50%}
/* chart tip pulse, heatmap now, route hover */
.pulsedot{fill:none;stroke:var(--s1);stroke-width:2;animation:pdot 2s ease-out infinite}@keyframes pdot{0%{r:4;opacity:.9}100%{r:16;opacity:0}}
.heat .c.now{outline:2px solid var(--warn);outline-offset:1px;animation:nowpulse 1.6s ease-in-out infinite}@keyframes nowpulse{50%{outline-color:transparent}}
.route{cursor:default;border-radius:8px;transition:background .2s}.route:hover{background:var(--card2)}
tbody tr.hl{background:color-mix(in oklab,var(--warn) 14%,transparent)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body><main>
<div class="top">
 <div class="brand"><div class="logo">⇄</div><div><h1>Arb Bot Tracker</h1><div class="sub mono">ueAt…bDwm · X1 mainnet · times US Eastern</div></div></div>
 <div class="chips">
  <span class="chip" id="live"><span class="pulse"></span><b>LIVE</b></span>
  <span class="chip" id="fastchip" style="display:none">⚡ <b>FAST</b></span>
  <span class="chip mono" id="xnt">XNT —</span>
  <span class="chip"><svg class="ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" stroke-width="3"/><circle id="ringfg" cx="10" cy="10" r="8" fill="none" stroke="var(--s1)" stroke-width="3" stroke-linecap="round" transform="rotate(-90 10 10)" stroke-dasharray="50.3" stroke-dashoffset="0"/></svg><span id="upd">—</span></span>
  <button class="iconbtn" id="chime" title="Chime when a trade lands (off)" aria-label="Chime on new trades">♪</button>
  <button class="iconbtn" id="theme" title="Light / dark" aria-label="Toggle light and dark">◐</button>
 </div>
</div>

<div class="ticker reveal" id="ticker" style="animation-delay:.05s"><div class="track" id="track"></div></div>
<div class="hero">
 <div class="card reveal" id="herocard" style="animation-delay:.1s">
  <h2>All-time real profit</h2>
  <div class="big num"><span id="allv">0.000</span><small>XNT</small></div>
  <div class="usd num" id="allusd"></div>
  <div class="sub" id="allsub" style="margin-top:8px"></div>
 </div>
 <div class="kpis" id="kpis"></div>
</div>

<div class="card reveal" style="animation-delay:.25s">
 <div class="head"><h2 id="charttitle">Cumulative real profit</h2>
  <div class="chips"><div class="seg" id="mode"><button data-v="cum" class="on">Cumulative</button><button data-v="daily">Daily</button></div>
  <div class="seg" id="range"><button data-v="7">7D</button><button data-v="30" class="on">30D</button><button data-v="0">All</button></div></div></div>
 <div class="legend" id="legend"></div>
 <svg id="chart" width="100%" height="280" role="img" aria-label="Arb profit chart"></svg>
 <details><summary class="muted" style="font-size:12px;cursor:pointer">Table view</summary><div class="scroll"><table id="daytable"></table></div></details>
</div>

<div class="cols">
 <div class="card reveal" style="animation-delay:.3s"><div class="head"><h2>Route flow · 7 days</h2><span class="sub">a trade runs its route live</span></div>
  <div class="flowwrap"><svg id="flow" role="img" aria-label="Map of the routes the bot trades"><g id="base"></g><g id="fx"></g></svg></div>
  <div class="legend" style="margin-top:4px"><span><i style="background:var(--s1)"></i>Legs traded (thicker = more)</span><span><i style="background:var(--good)"></i>Trade landing</span><span><i style="background:var(--s2)"></i>Race lost</span></div></div>
 <div class="card reveal" style="animation-delay:.32s"><div class="head"><h2>Scanner radar · last hour</h2><span class="sub" id="radarsub">sweeps 966 vaults live</span></div>
  <svg id="radar" viewBox="-140 -140 280 280" role="img" aria-label="Races won and lost in the last hour"></svg>
  <div class="legend" style="justify-content:center;margin-top:6px"><span><i style="background:var(--good)"></i>Won</span><span><i style="background:var(--s2)"></i>Lost</span><span class="faint">older blips drift outward</span></div>
  <div class="events" id="events"></div></div>
</div>
<div class="cols">
 <div class="card reveal" id="fastcard" style="animation-delay:.35s"><div class="head"><h2>Races · last 24 hours</h2><span id="fastpill"></span></div><div id="racebody"></div><div id="fastbody" class="muted" style="margin-top:14px"></div></div>
 <div class="card reveal" style="animation-delay:.4s"><div class="head"><h2>When the money comes</h2><span class="sub">real XNT by hour, last 30 days</span></div><div class="heat" id="heat"></div>
  <div class="ramp"><span>less</span><span class="g"></span><span>more</span><span id="heatmax" class="mono"></span></div></div>
</div>

<div class="cols">
 <div class="card reveal" style="animation-delay:.45s"><div class="head"><h2>Top routes · 7 days</h2><span class="sub">by real profit</span></div><div id="routes"></div></div>
 <div class="card reveal" style="animation-delay:.5s"><div class="head"><h2>Bot</h2></div><div class="status" id="status"></div></div>
</div>

<div class="card reveal" style="animation-delay:.55s">
 <div class="head"><h2>Trade feed</h2><div class="seg" id="filter"><button data-v="all" class="on">All</button><button data-v="real">Others' pools</button><button data-v="fast">Fast</button></div></div>
 <div class="scroll"><table><thead><tr><th class="l">Time</th><th class="l">Route</th><th>In</th><th>Expected</th><th>Made</th><th>Own</th><th>Real</th><th></th></tr></thead><tbody id="feed"></tbody></table></div>
</div>
<div class="card reveal" style="animation-delay:.6s">
 <div class="head"><h2>Lost races · what they would have made</h2><span class="sub" id="lostsince"></span></div>
 <div class="stats" id="losttiles" style="margin-top:0;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>
 <div class="scroll" style="margin-top:12px"><table><thead><tr><th class="l">Time</th><th class="l">Route</th><th>Stake</th><th>Would have made</th><th>Own</th><th>Real missed</th><th class="l">Why</th><th class="l">Beaten by</th></tr></thead><tbody id="lostfeed"></tbody></table></div>
 <div class="sub" style="margin-top:8px">“Would have made” is the bot’s estimate when it priced the trade; a race it won might have landed for a little less. Lost races cost nothing unless a fee is shown.</div>
</div>
<div class="card reveal" style="animation-delay:.65s">
 <div class="head"><h2>Who beat us · last 7 days</h2><span class="sub" id="whosub"></span></div>
 <div id="whosum" class="sub" style="margin-bottom:10px"></div>
 <div class="scroll"><table><thead><tr><th class="l">Rival wallet</th><th>Beat us</th><th class="l">Where</th><th>Blocks after the opening trade</th><th>Priority µL/CU</th><th>Swaps</th><th>They made</th><th>Last</th></tr></thead><tbody id="who"></tbody></table></div>
 <div class="sub" style="margin-top:8px">Looked up on-chain: the latest successful transaction through the route’s pools before the bot gave up. “Arb” touched two or more of them; a plain trade that moved the price back counts as “trade”.</div>
</div>
<div id="tip"></div><div id="toasts"></div>
</main><script>
const $=id=>document.getElementById(id),REFRESH=30;
const f=(v,d=3)=>Number(v).toFixed(d),sg=(v,d=4)=>(v>=0?"+":"")+f(v,d);
const tz={timeZone:"America/New_York"};
const fmtT=ms=>new Date(ms).toLocaleString("en-US",{...tz,month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
const ago=ms=>{const s=(Date.now()-ms)/1000;return s<90?Math.round(s)+"s ago":s<5400?Math.round(s/60)+" min ago":s<172800?Math.round(s/3600)+" h ago":Math.round(s/86400)+" d ago"};
let D=null,mode="cum",range=30,filter="all",seen=null,first=true,lastLoad=0,animate=true,prevCum=null,sse=false,hlName=null;
const still=matchMedia("(prefers-reduced-motion: reduce)").matches;
const usd=v=>D&&D.xntUsd?"$"+(v*D.xntUsd).toFixed(2):"";
try{const t=localStorage.getItem("arb-theme");if(t)document.documentElement.dataset.theme=t}catch{}
$("theme").onclick=()=>{const r=document.documentElement,dark=r.dataset.theme?r.dataset.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;r.dataset.theme=dark?"light":"dark";try{localStorage.setItem("arb-theme",r.dataset.theme)}catch{};draw()};
for(const [id,set] of [["mode",v=>mode=v],["range",v=>range=+v],["filter",v=>filter=v]])$(id).onclick=e=>{const b=e.target.closest("button");if(!b)return;[...$(id).children].forEach(x=>x.classList.toggle("on",x===b));set(b.dataset.v);prevCum=null;animate=true;draw();animate=false};
/** Roll a number from what it showed last to its new value. */
function countUp(el,to,d=3){const from=Number(el.dataset.v??0);el.dataset.v=to;if(still||from===to){el.textContent=f(to,d);return}
 const t0=performance.now(),dur=first?1100:700;const step=t=>{const k=Math.min(1,(t-t0)/dur),e=1-Math.pow(1-k,3);el.textContent=f(from+(to-from)*e,d);if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step)}
/** Draw-on for every line marked .drawme inside root, and fade-in for .fademe (only when animating). */
function drawIn(root){if(still||!animate)return;root.querySelectorAll(".drawme").forEach(p=>{const L=p.getTotalLength?p.getTotalLength():0;if(!L)return;p.style.setProperty("--len",L);p.classList.add("draw")});
 root.querySelectorAll(".fademe").forEach(p=>p.classList.add("fadein"))}
function tip(e,html){const t=$("tip");t.innerHTML=html;t.style.display="block";const w=t.offsetWidth;t.style.left=Math.min(e.clientX+14,innerWidth-w-8)+"px";t.style.top=(e.clientY+14)+"px"}
const hideTip=()=>$("tip").style.display="none";
function spark(vals){const W=200,H=34,max=Math.max(...vals,1e-9),n=vals.length,x=i=>i*(W-4)/(n-1)+2,y=v=>H-3-(H-6)*v/max;
 const pts=vals.map((v,i)=>x(i)+","+y(v)).join(" ");return '<svg class="spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><polyline points="'+x(0)+','+(H-1)+' '+pts+' '+x(n-1)+','+(H-1)+'" class="fademe" fill="color-mix(in oklab,var(--s1) 16%,transparent)" stroke="none"/><polyline class="drawme" points="'+pts+'" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/></svg>'}
/** Slot-machine digits: each digit is a column of 0-9 that rolls to its new value. */
function odo(el,v,d=3){const txt=f(v,d),old=el.dataset.txt||"";el.dataset.txt=txt;
 const col=(c,i)=>'<span class="od"><span class="col" style="transition-delay:'+(i*45)+'ms;transform:translateY(-'+(first&&!still?0:+c*1.05)+'em)">'+"0123456789".split("").map(x=>"<span>"+x+"</span>").join("")+'</span></span>';
 if(old.length!==txt.length||!el.querySelector(".od")){el.innerHTML=txt.split("").map((c,i)=>c>="0"&&c<="9"?col(c,i):"<span>"+c+"</span>").join("");
  if(first&&!still)requestAnimationFrame(()=>requestAnimationFrame(()=>set()))}else set();
 function set(){const cols=el.querySelectorAll(".col");let k=0;txt.split("").forEach(c=>{if(c>="0"&&c<="9"){cols[k].style.transform="translateY(-"+(+c*1.05)+"em)";k++}})}}
function hero(){const w=D.windows;odo($("allv"),w.all.real);$("allusd").textContent=D.xntUsd?"≈ "+usd(w.all.real):"";
 $("allsub").textContent=w.all.trades.toLocaleString()+" trades · "+f(w.all.gross,1)+" XNT gross"+(D.firstTrade?" · since "+new Date(D.firstTrade).toLocaleDateString("en-US",{...tz,month:"short",day:"numeric"}):"");
 let ki=0;const last14=D.days.slice(-14).map(d=>d.real),k=(name,o,extra,sp)=>'<div class="kpi'+(first&&!still?' reveal" style="animation-delay:'+(0.15+0.06*ki++)+'s':'')+'"><div class="k">'+name+'</div><div class="v num" data-to="'+o.real+'">'+f(o.real)+'</div><div class="s num">'+o.trades+' trades · '+usd(o.real)+(extra||"")+'</div>'+spark(sp)+'<div class="s">'+(sp===last14?"last 14 days":"last 24 hours, by hour")+'</div></div>';
 const prev=[...$("kpis").querySelectorAll(".v")].map(e=>e.dataset.v);
 $("kpis").innerHTML=k("Today",w.today,"",D.hours)+k("Last 24 hours",w.h24,"",D.hours)+k("Last 7 days",w.d7," · "+f(w.d7.real/7,2)+"/day",last14);
 $("kpis").querySelectorAll(".v").forEach((e,i)=>{e.dataset.v=prev[i]??0;countUp(e,Number(e.dataset.to))});
 drawIn($("kpis"));
 $("xnt").textContent="XNT "+(D.xntUsd?"$"+D.xntUsd.toFixed(4):"—")}
function rangeDays(){return range?D.days.slice(-range):D.days}
function chart(){const svg=$("chart"),W=svg.clientWidth||900,H=280,L=48,R=10,T=14,B=28;const all=D.days;const days=rangeDays(),n=days.length;
 const fastDay=D.fast?new Date(D.fast.since).toLocaleDateString("en-CA",tz):null;let s="";
 const every=Math.ceil(n/Math.max(2,Math.floor((W-L-R)/56)));
 if(mode==="cum"){$("charttitle").textContent="Cumulative real profit";$("legend").innerHTML='<span><i style="background:var(--s1)"></i>Real profit, running total (XNT)</span>';
  let acc=0;const before=all.slice(0,all.length-n).reduce((a,d)=>a+d.real,0);const cum=days.map(d=>acc+=d.real).map(v=>v+before);
  const lo=Math.min(...cum),hi=Math.max(...cum),span=Math.max(hi-lo,0.5),min=Math.max(0,lo-span*.08),max=hi+span*.08;
  const x=i=>L+(n===1?(W-L-R)/2:i*(W-L-R)/(n-1)),y=v=>T+(H-T-B)*(1-(v-min)/(max-min));
  for(let i=0;i<=4;i++){const v=min+(max-min)*i/4;s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--grid)"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="11" fill="var(--faint)">'+(+v.toFixed(v<10?2:0))+'</text>'}
  const pts=cum.map((v,i)=>x(i)+","+y(v)).join(" ");
  s+='<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--s1)" stop-opacity=".35"/><stop offset="1" stop-color="var(--s1)" stop-opacity="0"/></linearGradient></defs>';
  s+='<polygon class="fademe" points="'+x(0)+','+(H-B)+' '+pts+' '+x(n-1)+','+(H-B)+'" fill="url(#ga)"/><polyline class="drawme" points="'+pts+'" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>';
  days.forEach((d,i)=>{if(d.day===fastDay)s+=marker(x(i),T,H-B);if((n-1-i)%every===0)s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="'+(i===n-1?"end":i===0?"start":"middle")+'" font-size="11" fill="var(--faint)">'+d.day.slice(5)+'</text>'});
  s+='<circle class="'+(still?"":"pulsedot")+'" cx="'+x(n-1)+'" cy="'+y(cum[n-1])+'" r="4"/><circle id="tipdot" cx="'+x(n-1)+'" cy="'+y(cum[n-1])+'" r="4" fill="var(--s1)" stroke="var(--card)" stroke-width="2"/>';
  const morph=!animate&&!still&&prevCum&&prevCum.length===cum.length&&prevCum.some((v,i)=>Math.abs(v-cum[i])>1e-9)?prevCum:null;prevCum=cum;
  setTimeout(()=>{if(!morph)return;const pl=svg.querySelector(".drawme"),pg=svg.querySelector(".fademe"),td=svg.querySelector("#tipdot"),t0=performance.now();
   const step=t=>{const k=Math.min(1,(t-t0)/700),e=1-Math.pow(1-k,3),vals=cum.map((v,i)=>morph[i]+(v-morph[i])*e),pp=vals.map((v,i)=>x(i)+","+y(v)).join(" ");
    pl.setAttribute("points",pp);pg.setAttribute("points",x(0)+","+(H-B)+" "+pp+" "+x(n-1)+","+(H-B));td.setAttribute("cy",y(vals[n-1]));if(k<1)requestAnimationFrame(step)};requestAnimationFrame(step)},0);
  s+='<line id="xh" x1="0" x2="0" y1="'+T+'" y2="'+(H-B)+'" stroke="var(--muted)" stroke-dasharray="2 3" visibility="hidden"/><circle id="xd" r="5" fill="var(--s1)" stroke="var(--card)" stroke-width="2" visibility="hidden"/>';
  s+='<rect id="hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'" fill="transparent"/>';svg.innerHTML=s;drawIn(svg);
  const hit=svg.querySelector("#hit"),xh=svg.querySelector("#xh"),xd=svg.querySelector("#xd");
  hit.onmousemove=e=>{const r=svg.getBoundingClientRect(),i=Math.max(0,Math.min(n-1,Math.round((e.clientX-r.left-L)/((W-L-R)/Math.max(1,n-1)))));const d=days[i];
   xh.setAttribute("x1",x(i));xh.setAttribute("x2",x(i));xh.setAttribute("visibility","visible");xd.setAttribute("cx",x(i));xd.setAttribute("cy",y(cum[i]));xd.setAttribute("visibility","visible");
   tip(e,"<b>"+dayName(d.day)+"</b><br>Total <b class='num'>"+f(cum[i])+"</b> XNT "+usd(cum[i])+"<br>That day <span class='num'>"+sg(d.real,3)+"</span> · "+d.trades+" trades")};
  hit.onmouseleave=()=>{hideTip();xh.setAttribute("visibility","hidden");xd.setAttribute("visibility","hidden")};
 }else{$("charttitle").textContent="Profit per day";$("legend").innerHTML='<span><i style="background:var(--s1)"></i>Real: from other people’s pools</span><span><i style="background:var(--s2)"></i>From your own LP</span>';
  const max=Math.max(0.5,...days.map(d=>d.real+d.own)),nice=(()=>{const p=Math.pow(10,Math.floor(Math.log10(max)));for(const m of[1,2,2.5,5,10])if(m*p>=max)return m*p})();
  const y=v=>T+(H-T-B)*(1-v/nice),bw=(W-L-R)/n,bar=Math.max(2,Math.min(28,bw-3));
  for(let i=0;i<=4;i++){const v=nice*i/4;s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--grid)"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="11" fill="var(--faint)">'+(+v.toFixed(2))+'</text>'}
  days.forEach((d,i)=>{const x0=L+i*bw+(bw-bar)/2,r=Math.min(4,bar/2);
   if(d.real>0){const yr=y(d.real),h=y(0)-yr;s+=h>r?'<path class="bar1" data-i="'+i+'" d="M'+x0+','+y(0)+'V'+(yr+r)+'q0,-'+r+' '+r+',-'+r+'h'+(bar-2*r)+'q'+r+',0 '+r+','+r+'V'+y(0)+'z" fill="var(--s1)"/>':'<rect class="bar1" data-i="'+i+'" x="'+x0+'" y="'+yr+'" width="'+bar+'" height="'+h+'" fill="var(--s1)"/>'}
   if(d.own>0.0005){const top=y(d.real+d.own),bot=d.real>0?y(d.real)-2:y(0);if(bot-top>0.5)s+='<rect class="bar2" data-i="'+i+'" x="'+x0+'" y="'+top+'" width="'+bar+'" height="'+(bot-top)+'" rx="'+Math.min(3,bar/2)+'" fill="var(--s2)"/>'}
   if(d.day===fastDay)s+=marker(x0-2,T,y(0));
   if((n-1-i)%every===0)s+='<text x="'+(x0+bar/2)+'" y="'+(H-8)+'" text-anchor="middle" font-size="11" fill="var(--faint)">'+d.day.slice(5)+'</text>';
   s+='<rect class="hb" data-i="'+i+'" x="'+(L+i*bw)+'" y="'+T+'" width="'+bw+'" height="'+(H-T-B)+'" fill="transparent"/>'});
  s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--line)"/>';svg.innerHTML=s;
  if(animate&&!still)svg.querySelectorAll(".bar1,.bar2").forEach(b=>{b.classList.add("grow");b.style.animationDelay=(+b.dataset.i*14+(b.classList.contains("bar2")?120:0))+"ms"});
  svg.querySelectorAll(".hb").forEach(h=>{h.onmousemove=e=>{const d=days[+h.dataset.i];tip(e,"<b>"+dayName(d.day)+"</b><br>Real <b class='num'>"+f(d.real)+"</b> XNT "+usd(d.real)+"<br>Own LP <span class='num'>"+f(d.own)+"</span> XNT<br>"+d.trades+" trades")};h.onmouseleave=hideTip});
 }
 $("daytable").innerHTML="<tr><th class='l'>Day</th><th>Trades</th><th>Real XNT</th><th>Own LP XNT</th></tr>"+[...days].reverse().map(d=>"<tr><td class='l'>"+d.day+"</td><td>"+d.trades+"</td><td class='num'>"+f(d.real)+"</td><td class='num'>"+f(d.own)+"</td></tr>").join("")}
const marker=(x,t,b)=>'<line x1="'+x+'" x2="'+x+'" y1="'+t+'" y2="'+b+'" stroke="var(--warn)" stroke-dasharray="3 3"/><text x="'+(x-5)+'" y="'+(t+11)+'" text-anchor="end" font-size="11" fill="var(--warn)">⚡ fast</text>';
const dayName=d=>new Date(d+"T12:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
function fast(){const F=D.fast;$("fastchip").style.display=F?"":"none";
 if(!F){$("fastpill").innerHTML='<span class="chip">fast mode off</span>';$("fastbody").innerHTML='<span class="sub">Every trade is checked before it’s sent, so a lost race costs nothing. Fast mode: <code>scripts/arb.sh fast on</code>.</span>';return}
 const early=Date.now()-F.since<6*3600000,hit=F.fastLanded+F.failed?F.fastLanded/(F.fastLanded+F.failed):null,mx=Math.max(F.perDay,F.beforePerDay,1e-9);
 $("fastpill").innerHTML='<span class="chip"><span class="pulse'+(F.tripped?" off":"")+'"></span>'+(F.tripped?"guard tripped":"on since "+fmtT(F.since))+'</span>';
 $("fastbody").innerHTML='<div class="cmp">'
  +'<div class="row"><span>7 days before</span><div class="bar"><span style="width:'+(F.beforePerDay/mx*100)+'%;background:var(--faint)"></span></div><span class="num" style="text-align:right">'+f(F.beforePerDay,2)+'/d</span></div>'
  +'<div class="row"><span>Since fast</span><div class="bar"><span style="width:'+(early?0:F.perDay/mx*100)+'%;background:var(--s1)"></span></div><span class="num" style="text-align:right">'+(early?"—":f(F.perDay,2)+"/d")+'</span></div></div>'
  +(early?'<div class="sub" style="margin-top:6px">Per-day rate shows after 6 hours.</div>':'')
  +'<div class="stats"><div class="stat"><div class="k">Real since fast</div><div class="v num">'+f(F.real)+'</div></div>'
  +'<div class="stat"><div class="k">Hit rate</div><div class="v num">'+(hit===null?"—":Math.round(hit*100)+"%")+'</div><div class="sub">'+F.fastLanded+' landed · '+F.failed+' missed</div></div>'
  +'<div class="stat"><div class="k">Miss fees</div><div class="v num '+(F.tripped?"bad":"")+'">'+f(F.failedFees,4)+'</div><div class="sub">'+(F.guard?"today "+f(Number(F.guard.spent)/1e9,4)+" vs "+f(Number(F.guard.made)/1e9,4)+" made":"guard ok")+'</div></div></div>'
  +'<div class="sub" style="margin-top:12px"><code>'+F.args+'</code> · off: <code>scripts/arb.sh fast off</code></div>'}
function heat(){const H=D.heat,WD=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],max=Math.max(1e-9,...H.flat().map(c=>c.real));let s='<div></div>';
 for(let h=0;h<24;h++)s+='<div style="text-align:center">'+(h%6===0?h:"")+'</div>';
 H.forEach((row,d)=>{s+='<div class="lbl">'+WD[d]+'</div>';row.forEach((c,h)=>{const k=c.real>0?12+88*Math.sqrt(c.real/max):0;s+='<div class="c" data-d="'+d+'" data-h="'+h+'" style="'+(k?'background:color-mix(in oklab,var(--s1) '+k.toFixed(0)+'%,var(--card))':'')+'"></div>'})});
 $("heat").innerHTML=s;$("heatmax").textContent="max "+f(max,2);
 const np=Object.fromEntries(new Intl.DateTimeFormat("en-US",{...tz,weekday:"short",hour:"numeric",hourCycle:"h23"}).formatToParts(new Date()).map(q=>[q.type,q.value]));
 const nc=$("heat").querySelector('.c[data-d="'+WD.indexOf(np.weekday)+'"][data-h="'+(+np.hour%24)+'"]');if(nc){nc.classList.add("now");nc.title="now"}
 $("heat").classList.toggle("anim",animate&&!still);if(animate)$("heat").querySelectorAll(".c").forEach(c=>c.style.animationDelay=((+c.dataset.h)*22+(+c.dataset.d)*40)+"ms");
 $("heat").querySelectorAll(".c").forEach(c=>{c.onmousemove=e=>{const v=H[c.dataset.d][c.dataset.h];tip(e,"<b>"+WD[c.dataset.d]+" "+String(c.dataset.h).padStart(2,"0")+":00–"+String(c.dataset.h).padStart(2,"0")+":59</b><br>Real <b class='num'>"+f(v.real)+"</b> XNT<br>"+v.trades+" trades")};c.onmouseleave=hideTip})}
function routes(){const R=D.routes,max=Math.max(1e-9,...R.map(r=>r.real));
 $("routes").innerHTML=R.length?R.map((r,i)=>'<div class="route" data-name="'+r.name.replace(/"/g,"&quot;")+'"><span class="rk">'+(i+1)+'</span><div class="nm">'+r.name+(r.own>=.5?'<span class="tag own">'+Math.round(r.own*100)+'% own</span>':'')+'<div class="meta">'+r.trades+' trades · '+ago(r.last)+'</div></div><div class="bar"><span data-w="'+(r.real/max*100)+'" style="width:'+(animate&&!still?0:r.real/max*100)+'%;background:var(--s1);transition-delay:'+(i*60)+'ms"></span></div><span class="num" style="text-align:right">'+f(r.real)+'</span></div>').join(""):'<div class="muted">No trades in 7 days.</div>';
 $("routes").querySelectorAll(".route").forEach(el=>{el.onmouseenter=()=>hl(el.dataset.name);el.onmouseleave=()=>hl(null)});
 if(animate&&!still)requestAnimationFrame(()=>requestAnimationFrame(()=>$("routes").querySelectorAll(".bar>span").forEach(b=>b.style.width=b.dataset.w+"%")))}
function status(){const S=D.status,stale=S.lastLogAt&&Date.now()-S.lastLogAt>5*60000,ok=S.running&&!stale;
 $("live").innerHTML='<span class="pulse'+(ok?"":" off")+'"></span><b>'+(ok?(sse?"LIVE":"POLLING"):S.running?"QUIET":"STOPPED")+'</b>';
 const st=(k,v)=>'<div class="stat"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>';
 $("status").innerHTML=st("Process",S.running?'<span class="good">running</span>':'<span class="bad">not running</span>')+st("Last log",S.lastLogAt?fmtT(S.lastLogAt)+" · "+ago(S.lastLogAt):"—")
  +st("Scanner",S.scan||"—")+st("GOOGL peg",S.peg||"—")}
function feed(){const rows=D.recent.filter(t=>filter==="all"||(filter==="real"?t.own<.5:t.fast));
 $("feed").innerHTML=rows.map(t=>'<tr data-name="'+t.name.replace(/"/g,"&quot;")+'" class="'+(seen&&!seen.has(t.signature)?"new":"")+(hlName===t.name?" hl":"")+'"><td class="l mono">'+fmtT(t.at)+'</td><td class="l">'+t.name+' <span class="faint">'+t.dir+'</span>'+(t.fast?'<span class="tag fast">⚡ fast</span>':'')+'</td><td class="num">'+f(t.xntIn,2)+'</td><td class="num faint">'+sg(t.expected)+'</td><td class="num">'+sg(t.gross)+'</td><td class="num">'+(t.own?Math.round(t.own*100)+"%":"—")+'</td><td class="num"><b class="'+(t.real>0?"good":"")+'">'+sg(t.real)+'</b></td><td><a target="_blank" rel="noopener" href="https://explorer.x1.xyz/tx/'+t.signature+'">tx ↗</a></td></tr>').join("")||'<tr><td class="l muted" colspan="8">No trades match.</td></tr>'}
function toast(t){const el=document.createElement("div");el.className="toast";el.innerHTML="<b class='good num'>"+sg(t.real)+" XNT</b> real · "+t.name+(t.fast?" ⚡":"")+"<div class='sub num'>made "+sg(t.gross)+" · "+fmtT(t.at)+"</div>";$("toasts").appendChild(el);setTimeout(()=>el.remove(),8000)}
function races(){const R=D.races,tot=R.won+R.lost,p=tot?R.won/tot:0,C=2*Math.PI*48;
 const dash=(animate&&!still?0:p*C)+" "+C;
 $("racebody").innerHTML='<div class="races"><svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Races won"><circle cx="60" cy="60" r="48" fill="none" stroke="var(--card2)" stroke-width="14"/>'
  +'<circle id="dn" cx="60" cy="60" r="48" fill="none" stroke="var(--s1)" stroke-width="14" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="'+dash+'"/>'
  +'<text x="60" y="58" text-anchor="middle" font-size="24" font-weight="800" fill="var(--fg)">'+(tot?Math.round(p*100)+"%":"—")+'</text><text x="60" y="78" text-anchor="middle" font-size="11" fill="var(--faint)">won</text></svg>'
  +'<div style="min-width:0;width:100%"><div class="stats" style="margin-top:0;grid-template-columns:1fr 1fr"><div class="stat"><div class="k">Won (landed)</div><div class="v num good">'+R.won+'</div></div><div class="stat"><div class="k">Lost (gap gone)</div><div class="v num">'+R.lost+'</div>'+(D.lostLog&&D.lostLog.h24.races?'<div class="sub num">missed '+f(D.lostLog.h24.real)+' real</div>':'')+'</div></div>'
  +(R.top.length?'<div class="sub" style="margin:10px 0 4px">Where other bots got there first</div><div class="lost">'+R.top.map(t=>'<div class="r"><span>'+t.name+'</span><div class="bar"><span style="width:'+(t.lost/R.top[0].lost*100)+'%;background:var(--s2)"></span></div><span class="num faint" style="text-align:right">'+t.lost+'</span></div>').join("")+'</div>':'')+'</div></div>';
 if(animate&&!still)requestAnimationFrame(()=>requestAnimationFrame(()=>{const d=$("dn");if(d)d.setAttribute("stroke-dasharray",(p*C)+" "+C)}))}
function ticker(){const list=D.recent.slice(0,24),items=list.map(t=>'<span class="it">'+new Date(t.at).toLocaleTimeString("en-US",{...tz,hour:"numeric",minute:"2-digit"})+' · '+t.name+' <b class="'+(t.real>0?"good":"")+'">'+sg(t.real)+'</b>'+(t.own>=.5?' <span class="faint">own</span>':'')+'</span>').join("");
 const tr=$("track");if(tr.dataset.k===(list[0]?.signature||""))return;tr.dataset.k=list[0]?.signature||"";tr.innerHTML=items+items;tr.style.setProperty("--dur",Math.max(40,list.length*5)+"s")}
function celebrate(t){if(still)return;const c=$("herocard"),el=document.createElement("div");el.className="float";el.textContent=sg(t.real)+" XNT";c.appendChild(el);setTimeout(()=>el.remove(),2500);
 const v=$("allv");v.classList.remove("glow");void v.offsetWidth;v.classList.add("glow")}
/** The tokens a route passes through, from its name (same rule as the server's tokenPath). */
function tokenPath(name,dir){const pair=name.split(" → ");if(pair.length===2){const a=pair[0].split("/"),b=pair[1].split("/");return a[0]&&a[1]&&b[1]?["XNT",a[1],a[0],b[1],"XNT"]:[]}
 const q=name.split("/");if(!q[0]||!q[1])return[];return dir==="buy-main"?["XNT",q[0],q[1],"XNT"]:["XNT",q[1],q[0],"XNT"]}
const hash=t=>{let h=2166136261;for(const c of t)h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0)/4294967296};
const SVGNS="http://www.w3.org/2000/svg";
let geo=null;
/** Lay out the route map: XNT in the middle, the busiest tokens around it, a line per leg traded. */
function flow(){const svg=$("flow"),W=svg.clientWidth||560,H=320,cx=W/2,cy=H/2,R=Math.min(W/2-48,128),N=D.map.nodes;
 const pos={XNT:[cx,cy]};N.forEach((nd,i)=>{const a=-Math.PI/2+i*2*Math.PI/Math.max(N.length,1);pos[nd.sym]=[cx+R*Math.cos(a),cy+R*Math.sin(a)]});
 geo={pos,cx,cy,R,W,H};svg.setAttribute("viewBox","0 0 "+W+" "+H);
 const maxT=Math.max(1,...D.map.legs.map(l=>l.trades));let s="";
 for(const l of D.map.legs){const w=1+2.6*Math.log2(1+l.trades)/Math.log2(1+maxT),op=.18+.5*l.trades/maxT,dur=Math.max(.7,3.2-2.4*l.trades/maxT);
  s+='<path class="leg'+(still?"":" run")+'" data-a="'+esc(l.a)+'" data-b="'+esc(l.b)+'" d="'+legD(l.a,l.b,true)+'" stroke-width="'+w.toFixed(2)+'" style="opacity:'+op.toFixed(2)+';--d:'+dur.toFixed(2)+'s"><title>'+esc(l.a)+' ↔ '+esc(l.b)+': '+l.trades+' trades</title></path>'}
 if(!still)s+='<circle class="hubring" cx="'+cx+'" cy="'+cy+'" r="22"/>';
 for(const nd of N){const p=pos[nd.sym],r=Math.min(18,6+Math.sqrt(nd.trades)*1.1),below=p[1]>=cy-2;
  s+='<g class="node" data-sym="'+esc(nd.sym)+'"><circle cx="'+p[0]+'" cy="'+p[1]+'" r="'+r.toFixed(1)+'"><title>'+esc(nd.sym)+': '+nd.trades+' trades</title></circle><text x="'+p[0]+'" y="'+(below?p[1]+r+12:p[1]-r-5)+'" text-anchor="middle">'+esc(nd.sym)+'</text></g>'}
 s+='<g class="hub"><circle cx="'+cx+'" cy="'+cy+'" r="22"/><text x="'+cx+'" y="'+(cy+4)+'" text-anchor="middle">XNT</text></g>';
 $("base").innerHTML=s;if(hlName)hl(hlName)}
const esc=t=>String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
/** Where a token sits (tokens off the map get a spot on an outer ring). */
function at(sym){if(geo.pos[sym])return geo.pos[sym];const a=hash(sym)*2*Math.PI;return [geo.cx+geo.R*1.22*Math.cos(a),geo.cy+geo.R*1.22*Math.sin(a)]}
/** One leg as path data; token-to-token legs bow toward the middle. */
function legD(a,b,move){const A=at(a),B=at(b);let seg;if(a==="XNT"||b==="XNT")seg="L"+B[0].toFixed(1)+","+B[1].toFixed(1);
 else{const mx=(A[0]+B[0])/2,my=(A[1]+B[1])/2,qx=mx+(geo.cx-mx)*.38,qy=my+(geo.cy-my)*.38;seg="Q"+qx.toFixed(1)+","+qy.toFixed(1)+" "+B[0].toFixed(1)+","+B[1].toFixed(1)}
 return (move?"M"+A[0].toFixed(1)+","+A[1].toFixed(1):"")+seg}
const routeD=p=>p.length<2?"":"M"+at(p[0]).map(v=>v.toFixed(1)).join(",")+p.slice(1).map((t,i)=>legD(p[i],t,false)).join("");
/** Run a trade along its route: a glowing head with a tail, then a burst and its profit at XNT. A lost race flashes orange. */
function flowRun(p,real,won){if(!geo||!p.length)return;const fx=$("fx"),d=routeD(p);
 if(!won||still){const pa=document.createElementNS(SVGNS,"path");pa.setAttribute("d",d);pa.setAttribute("class",won?"leg":"lostflash");if(won){pa.style.stroke="var(--good)";pa.style.strokeWidth=3}fx.appendChild(pa);setTimeout(()=>pa.remove(),1700);if(won)burst(real);return}
 const guide=document.createElementNS(SVGNS,"path");guide.setAttribute("d",d);guide.setAttribute("fill","none");fx.appendChild(guide);const L=guide.getTotalLength(),dots=[];
 for(let i=0;i<8;i++){const c=document.createElementNS(SVGNS,"circle");c.setAttribute("r",i?Math.max(1.5,5-i*.5):6);c.setAttribute("fill","var(--good)");c.style.opacity=i?(1-i/9):1;if(!i)c.style.filter="drop-shadow(0 0 6px var(--good))";fx.appendChild(c);dots.push(c)}
 const t0=performance.now(),dur=600+p.length*380;
 const step=t=>{const k=(t-t0)/dur;dots.forEach((c,i)=>{const kk=Math.max(0,Math.min(1,k-i*.025)),e=kk<.5?2*kk*kk:1-Math.pow(-2*kk+2,2)/2,pt=guide.getPointAtLength(e*L);c.setAttribute("cx",pt.x);c.setAttribute("cy",pt.y)});
  if(k<1.2)requestAnimationFrame(step);else{dots.forEach(c=>c.remove());guide.remove();burst(real)}};requestAnimationFrame(step)}
function burst(real){const fx=$("fx");const c=document.createElementNS(SVGNS,"circle");c.setAttribute("class","burst");c.setAttribute("cx",geo.cx);c.setAttribute("cy",geo.cy);c.setAttribute("r",20);fx.appendChild(c);
 const t=document.createElementNS(SVGNS,"text");t.setAttribute("class","flowtxt");t.setAttribute("x",geo.cx);t.setAttribute("y",geo.cy-32);t.setAttribute("text-anchor","middle");t.textContent=sg(real)+" XNT";fx.appendChild(t);
 setTimeout(()=>{c.remove();t.remove()},2300)}
/** Light up a route (from the leaderboard): its tokens and legs on the map, its rows in the feed. */
function hl(name){hlName=name;const toks=new Set(name?[...tokenPath(name,"buy-main"),...tokenPath(name,"pair")]:[]);
 document.querySelectorAll("#base .node").forEach(n=>n.classList.toggle("hl",toks.has(n.dataset.sym)));
 document.querySelectorAll("#base .leg").forEach(l=>l.classList.toggle("hl",toks.has(l.dataset.a)&&toks.has(l.dataset.b)));
 document.querySelectorAll("#feed tr").forEach(r=>r.classList.toggle("hl",!!name&&r.dataset.name===name))}
// ---------- radar ----------
let blips=[];
function radarAdd(b,live){blips.push({...b,live});blips=blips.filter(x=>Date.now()-x.at<3600000).slice(-80);radar(live?b:null);events()}
function radar(fresh){const r=$("radar");let s='<defs><radialGradient id="rg"><stop offset="0" stop-color="var(--s1)" stop-opacity=".10"/><stop offset="1" stop-color="var(--s1)" stop-opacity="0"/></radialGradient>'
  +'<linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--s1)" stop-opacity="0"/><stop offset="1" stop-color="var(--s1)" stop-opacity=".45"/></linearGradient></defs>'
  +'<circle r="132" fill="url(#rg)" stroke="var(--line)"/>';
 for(const rr of[44,88])s+='<circle r="'+rr+'" fill="none" stroke="var(--line)" stroke-dasharray="2 4"/>';
 s+='<line x1="-132" x2="132" y1="0" y2="0" stroke="var(--grid)"/><line y1="-132" y2="132" x1="0" x2="0" stroke="var(--grid)"/>';
 if(!still)s+='<g class="sweep"><path d="M0,0 L132,0 A132,132 0 0,0 '+(132*Math.cos(-.6)).toFixed(1)+','+(132*Math.sin(-.6)).toFixed(1)+' Z" fill="url(#sw)"/><line x1="0" y1="0" x2="132" y2="0" stroke="var(--s1)" stroke-width="1.5" opacity=".8"/></g>';
 for(const b of blips){const age=(Date.now()-b.at)/3600000,a=hash(b.name)*2*Math.PI,rad=14+age*112,col=b.kind==="won"?"var(--good)":"var(--s2)",sz=b.kind==="won"?Math.min(7,3+Math.sqrt(Math.max(b.real,0))*14):3;
  const x=(rad*Math.cos(a)).toFixed(1),y=(rad*Math.sin(a)).toFixed(1);s+='<circle class="blip" cx="'+x+'" cy="'+y+'" r="'+sz.toFixed(1)+'" fill="'+col+'" style="opacity:'+Math.max(.15,1-age*.85).toFixed(2)+'"><title>'+esc(b.name)+(b.kind==="won"?" "+sg(b.real):" lost")+'</title></circle>';
  if(fresh===b||(fresh&&b.at===fresh.at&&b.name===fresh.name))s+='<circle class="ping" cx="'+x+'" cy="'+y+'" r="3" stroke="'+col+'"/>'}
 s+='<circle r="3" fill="var(--s1)"/>';r.innerHTML=s;
 const w=blips.filter(b=>b.kind==="won").length,l=blips.length-w;$("radarsub").textContent=w+" won · "+l+" lost this hour"}
function radarScan(){if(still)return;const r=$("radar"),c=document.createElementNS(SVGNS,"circle");c.setAttribute("class","scanring");c.setAttribute("r",4);r.appendChild(c);setTimeout(()=>c.remove(),2300)}
function events(){const ev=[...blips].sort((a,b)=>b.at-a.at).slice(0,6);
 $("events").innerHTML=ev.map(b=>'<div class="e"><span class="faint mono">'+new Date(b.at).toLocaleTimeString("en-US",{...tz,hour:"numeric",minute:"2-digit"})+'</span><span class="dot" style="background:'+(b.kind==="won"?"var(--good)":"var(--s2)")+'"></span><span>'+esc(b.name)+'</span><span class="num '+(b.kind==="won"?"good":"faint")+'">'+(b.kind==="won"?sg(b.real):b.missed?"lost "+f(b.missed,4):"lost")+'</span></div>').join("")||'<div class="faint">Nothing in the last hour yet.</div>'}
// ---------- coins, chime, background flash ----------
function coins(n){if(still)return;const r=$("allv").getBoundingClientRect(),vis=r.bottom>0&&r.top<innerHeight,ox=vis?r.left+r.width/2:innerWidth/2,oy=vis?r.top+r.height/2:innerHeight*.35,list=[];
 for(let i=0;i<n;i++){const c=document.createElement("div");c.className="coin";c.textContent="X";document.body.appendChild(c);list.push({c,x:ox,y:oy,vx:(Math.random()-.5)*14,vy:-6-Math.random()*10,rot:Math.random()*360,vr:(Math.random()-.5)*30})}
 let fr=0;const step=()=>{fr++;for(const q of list){q.vy+=.5;q.x+=q.vx;q.y+=q.vy;q.rot+=q.vr;q.c.style.left=q.x+"px";q.c.style.top=q.y+"px";q.c.style.transform="rotate("+q.rot+"deg) scaleX("+Math.cos(q.rot/40).toFixed(2)+")";q.c.style.opacity=Math.max(0,1-Math.max(0,fr-50)/30)}
  if(fr<80)requestAnimationFrame(step);else list.forEach(q=>q.c.remove())};requestAnimationFrame(step)}
let chimeOn=false,actx=null;try{chimeOn=localStorage.getItem("arb-chime")==="1"}catch{}
function chimeUI(){$("chime").innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'+(chimeOn?'':'<line x1="3" y1="3" x2="21" y2="21"/>')+'</svg>';$("chime").style.color=chimeOn?"var(--good)":"";$("chime").title="Chime when a trade lands ("+(chimeOn?"on":"off")+")"}
$("chime").onclick=()=>{chimeOn=!chimeOn;try{localStorage.setItem("arb-chime",chimeOn?"1":"0")}catch{};chimeUI();if(chimeOn)chime()};chimeUI();
function chime(){if(!chimeOn)return;try{actx=actx||new (window.AudioContext||window.webkitAudioContext)();const t=actx.currentTime;
 [[880,0],[1318.5,.09],[1760,.18]].forEach(([fq,dl])=>{const o=actx.createOscillator(),g=actx.createGain();o.type="sine";o.frequency.value=fq;g.gain.setValueAtTime(0,t+dl);g.gain.linearRampToValueAtTime(.12,t+dl+.01);g.gain.exponentialRampToValueAtTime(.0001,t+dl+.5);o.connect(g).connect(actx.destination);o.start(t+dl);o.stop(t+dl+.55)})}catch{}}
function flashBg(){if(still)return;document.body.classList.add("flash");setTimeout(()=>document.body.classList.remove("flash"),900)}
// ---------- live stream ----------
let reloadT=null;const reloadSoon=()=>{clearTimeout(reloadT);reloadT=setTimeout(load,900)};
function stream(){const es=new EventSource("/api/stream");es.onopen=()=>{sse=true;if(D)status()};es.onerror=()=>{sse=false;if(D)status()};
 es.onmessage=m=>{let e;try{e=JSON.parse(m.data)}catch{return}
  if(e.type==="trade"){const t=e.trade;flowRun(e.path,t.real,true);radarAdd({at:t.at,kind:"won",name:t.name,real:t.real},true);if(t.real>=.1)coins(28);chime();flashBg();reloadSoon()}
  else if(e.type==="lost"){flowRun(e.path,0,false);radarAdd({at:e.at,kind:"lost",name:e.name,real:0,missed:e.real||0},true);if(D){D.races.lost++;races()}if(e.expected!==undefined)reloadSoon()}
  else if(e.type==="scan"){radarScan();if(D){D.status.scan=e.text;status()}}}}
function lostLog(){const L=D.lostLog,t=(k,o)=>'<div class="stat"><div class="k">'+k+'</div><div class="v num">'+f(o.real)+' <span class="sub">real</span></div><div class="sub num">'+o.races+' races · '+f(o.expected)+' gross'+(o.fees?' · fees '+f(o.fees,4):'')+(D.xntUsd?' · '+usd(o.real):'')+'</div></div>';
 $("losttiles").innerHTML=t("Missed today",L.today)+t("Missed 24 hours",L.h24)+t("Missed 7 days",L.d7)+t("Missed since recording",L.all);
 $("lostsince").textContent=L.since?"recorded since "+fmtT(L.since):"recording starts with the bot’s next lost race";
 $("lostfeed").innerHTML=L.recent.map(x=>'<tr data-name="'+esc(x.name)+'" class="'+(seenLost&&!seenLost.has(x.at+x.name)?"new":"")+(hlName===x.name?" hl":"")+'"><td class="l mono">'+fmtT(x.at)+'</td><td class="l">'+esc(x.name)+' <span class="faint">'+x.dir+'</span></td><td class="num">'+f(x.xntIn,2)+'</td><td class="num">'+sg(x.expected)+'</td><td class="num">'+(x.own?Math.round(x.own*100)+"%":"—")+'</td><td class="num"><b class="warn">'+f(x.real,4)+'</b></td><td class="l faint">'+esc(x.reason)+(x.fee?' · fee '+f(x.fee,4):'')+'</td><td class="l">'+beaten(x.rival)+'</td></tr>').join("")||'<tr><td class="l muted" colspan="8">No lost races recorded yet.</td></tr>';
 seenLost=new Set(L.recent.map(x=>x.at+x.name))}
let seenLost=null;
const short=w=>w?w.slice(0,4)+"…"+w.slice(-4):"—";
const addr=w=>'<a class="mono" target="_blank" rel="noopener" href="https://explorer.x1.xyz/address/'+w+'">'+short(w)+'</a>';
function beaten(r){if(!r)return'<span class="faint">looking…</span>';if(!r.wallet)return'<span class="faint">'+(r.kind==="unknown"?"not found":r.kind)+'</span>';
 return addr(r.wallet)+' <span class="tag'+(r.kind==="arb"?" fast":"")+'">'+r.kind+'</span>'+(r.slotsAfterOpen!=null?' <span class="faint">+'+r.slotsAfterOpen+' blk</span>':'')+(r.signature?' <a target="_blank" rel="noopener" href="https://explorer.x1.xyz/tx/'+r.signature+'">tx ↗</a>':'')}
function who(){const W=D.whoBeatUs;$("whosub").textContent=W.looked+" lost races looked up"+(W.pending?" · "+W.pending+" to go":"");
 $("whosum").innerHTML=W.looked?('<b>'+W.arbs+'</b> by arb bots · <b>'+W.trades+'</b> by plain trades · '+W.unknown+' not found'
  +(W.medianSlots!=null?' · the rival typically landed <b>'+W.medianSlots+' block'+(W.medianSlots===1?'':'s')+'</b> after the trade that opened the gap':'')
  +(W.medianSecs!=null?', about <b>'+W.medianSecs+' s</b> before your bot gave up':'')+'.'):'Looking up the lost races on-chain, a few a minute…';
 $("who").innerHTML=W.rivals.map(r=>'<tr><td class="l">'+addr(r.wallet)+'</td><td class="num"><b>'+r.wins+'</b>'+(r.arbs<r.wins?' <span class="faint">('+r.arbs+' arb)</span>':'')+'</td><td class="l" style="white-space:normal;min-width:160px">'+r.routes.map(x=>esc(x.name)+(x.wins>1?' <span class="faint">×'+x.wins+'</span>':'')).join(", ")+'</td><td class="num">'+(r.medianSlots??"—")+'</td><td class="num">'+(r.medianCuPrice!=null?Number(r.medianCuPrice).toLocaleString():"—")+'</td><td class="num">'+(r.swaps??"—")+'</td><td class="num">'+(r.profit?sg(r.profit):"—")+'</td><td class="faint">'+ago(r.last)+'</td></tr>').join("")||'<tr><td class="l muted" colspan="8">No rivals found yet.</td></tr>'}
function draw(){if(!D)return;lostLog();who();hero();ticker();chart();flow();if(first){blips=D.radar.slice();radar();events()}races();fast();heat();routes();status();feed()}
setInterval(()=>{if(D)radar()},5000);stream();
async function load(){try{D=await (await fetch("/api/data",{cache:"no-store"})).json();lastLoad=Date.now();
 const fresh=seen?D.recent.filter(t=>!seen.has(t.signature)):[];fresh.slice(0,3).forEach(toast);
 draw();if(fresh.length)celebrate(fresh[0]);seen=new Set(D.recent.map(t=>t.signature));first=false;animate=false}catch(e){$("upd").textContent="offline"}}
setInterval(()=>{if(!lastLoad)return;const left=Math.max(0,REFRESH-(Date.now()-lastLoad)/1000);$("upd").textContent="next "+Math.ceil(left)+"s";$("ringfg").setAttribute("stroke-dashoffset",(50.3*(1-left/REFRESH)).toFixed(1))},250);
load();setInterval(load,REFRESH*1000);let rt;addEventListener("resize",()=>{clearTimeout(rt);rt=setTimeout(()=>{if(D){chart();flow()}},120)});
</script></body></html>`;

// ---------- who beat us: look up lost races on-chain in the background ----------
const ARB_WALLET = "ueAtvunDsCP963s6kvsQ8q3xSfPVekHddj4dLG5bDwm";
const rivals = createRivals({ rpc: process.env.ARB_RIVALS_RPC ?? "https://rpc.mainnet.x1.xyz", stateDir: STATE, me: ARB_WALLET, log: (l) => console.log(l) });
let poolByPrefix: Map<string, string | null> | null = null;
/** Full pool addresses for the 4-character prefixes older log lines name ("via 7deZ → 4C4o → 8hEh"); null where two pools share one. */
async function prefixes() {
  if (poolByPrefix) return poolByPrefix;
  const r = await fetch(process.env.ARB_RIVALS_RPC ?? "https://rpc.mainnet.x1.xyz", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: ["sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN", { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 637 }] }] }) });
  const list = ((await r.json()) as { result: { pubkey: string }[] }).result.map((a) => a.pubkey);
  const m = new Map<string, string | null>();
  for (const a of list) m.set(a.slice(0, 4), m.has(a.slice(0, 4)) ? null : a);
  poolByPrefix = m;
  return m;
}
/** Every lost race of the last 7 days: the journal's, and older log lines from before the bot journaled them. */
function lostRaces(now: number): LostRace[] {
  const out: LostRace[] = read("arb-lost.jsonl").split("\n").filter(Boolean).flatMap((l) => { try { const x = toLost(JSON.parse(l) as Lost); return x.at >= now - 7 * DAY ? [{ key: x.key, at: x.at, name: x.name, pools: x.pools }] : []; } catch { return []; } });
  if (poolByPrefix) for (const l of tail("arb-bot.log", 4_000_000)) {
    if (!l.includes(": gap gone before") || l.includes("would have made")) continue;
    const at = stampMs(l), m = /(?:EST|EDT) (.+?) \(\d+ swaps via ([^)]*)\)/.exec(l);
    if (!at || !m || at < now - 7 * DAY) continue;
    const pools = m[2].split(" → ").map((p) => poolByPrefix!.get(p.trim())).filter((p): p is string => !!p);
    out.push({ key: new Date(at).toISOString() + "|" + m[1].replace(/ buy-(main|side)$/, ""), at, name: m[1].replace(/ buy-(main|side)$/, ""), pools });
  }
  return out;
}
if (!argv.includes("--no-rivals")) {
  const tick = async () => { try { await prefixes(); await rivals.run(lostRaces(Date.now()), 8); } catch (e) { console.log(`rivals: ${e instanceof Error ? e.message : String(e)}`); } };
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}

// ---------- live stream: new trades, lost races and scans, the moment the bot writes them ----------
const clients = new Set<http.ServerResponse>();
function broadcast(ev: Record<string, unknown>) { const s = "data: " + JSON.stringify(ev) + "\n\n"; for (const c of clients) c.write(s); }
/** Call `onLine` for each line appended to a state file from now on (checked every 500 ms; a truncated file starts over). */
function follow(file: string, onLine: (l: string) => void) {
  const f = path.join(STATE, file);
  let pos = (() => { try { return fs.statSync(f).size; } catch { return 0; } })(), rest = "";
  setInterval(() => {
    let size = 0;
    try { size = fs.statSync(f).size; } catch { return; }
    if (size < pos) { pos = 0; rest = ""; }
    if (size === pos) return;
    const fd = fs.openSync(f, "r"), buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); pos = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) if (l) onLine(l);
  }, 500).unref();
}
follow("arb-trades.jsonl", (l) => {
  try { const t = JSON.parse(l) as Trade; if (t.actualProfit !== null && Number.isFinite(Number(t.actualProfit))) { const x = toTrade(t); broadcast({ type: "trade", trade: x, path: tokenPath(x.name, x.dir) }); } } catch { /* partial line */ }
});
follow("arb-lost.jsonl", (l) => {
  try { const x = toLost(JSON.parse(l) as Lost); broadcast({ type: "lost", ...x, path: tokenPath(x.name, x.dir) }); } catch { /* partial line */ }
});
follow("arb-bot.log", (l) => {
  const lost = l.includes("would have made") ? null : lostOf(l);
  if (lost) broadcast({ type: "lost", ...lost, path: tokenPath(lost.name, lost.dir) });
  else if (/ scan: \d+ pools/.test(l)) broadcast({ type: "scan", at: stampMs(l) ?? Date.now(), text: l.replace(/^.*? scan: /, "") });
});
setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20_000).unref();

const server = http.createServer(async (req, res) => {
  // Only answer requests addressed to this local server (blocks DNS rebinding); read-only, so GETs only.
  if (!allowedHosts.has(req.headers.host ?? "")) { res.writeHead(403).end("Forbidden host"); return; }
  if (req.method !== "GET") { res.writeHead(405).end("Read-only"); return; }
  if (req.url === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/api/data") {
    try { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(await data())); }
    catch (e) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); }
  } else if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
  } else {
    res.writeHead(404).end("Not found");
  }
});
server.on("error", (e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is in use. Try: npm run arb-page -- --port <another port>` : e.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`Arb bot tracker: http://127.0.0.1:${port}`));
