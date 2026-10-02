/**
 * Screen-records a guided tour of the live 99 + Tax site for a product video or a tutorial:
 * one clip per scene, with an on-screen caption (lower third), a visible cursor and a
 * highlight on what the caption talks about. With ffmpeg installed it also trims the
 * loading frames, converts each clip to MP4 and joins them into one video with an .srt of
 * the captions. The scenes and their voiceover lines are in docs/VIDEO-SCRIPT.md.
 *
 * Read-only: it browses public pages, never connects a wallet and never sends a transaction.
 * The launch-form scene types example values and stops before any approval.
 *
 *   npm i --no-save playwright && npx playwright install chromium     # once
 *   npx tsx scripts/video-tour.ts                                     # product cut, 1920x1080
 *   npx tsx scripts/video-tour.ts --cut tutorial                      # slower, longer captions
 *   npx tsx scripts/video-tour.ts --vertical --theme arcade           # 1080x1920 for shorts
 *   npx tsx scripts/video-tour.ts --scenes vault,leaderboard          # only some scenes
 *
 * Options: --cut product|tutorial · --scenes a,b,c · --theme <name> · --mode light|dark ·
 * --lang en|es · --size 1920x1080 · --vertical · --mainnet <url> · --testnet <url> ·
 * --mint <token mint> (default: the newest mainnet launch) · --nft <its lock NFT> · --wallet <address> (default:
 * that token's biggest holder) · --out <dir> (default video/out) · --no-captions · --headed
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name: string) => argv.includes(`--${name}`);
const cut = (opt("cut", "product") as "product" | "tutorial");
const vertical = flag("vertical");
const [W, H] = (opt("size", vertical ? "1080x1920" : "1920x1080")!).split("x").map(Number);
const theme = opt("theme", "receipt")!;
const mode = opt("mode", "light")!;
const lang = opt("lang", "en")!;
const MAINNET = (opt("mainnet", "https://99tax.vercel.app")!).replace(/\/$/, "");
const TESTNET = (opt("testnet", "https://99tax-testnet.vercel.app")!).replace(/\/$/, "");
const outDir = path.resolve(opt("out", "video/out")!, `${cut}${vertical ? "-vertical" : ""}`);
const only = opt("scenes")?.split(",").map((s) => s.trim()).filter(Boolean);
const captionsOn = !flag("no-captions");
/** Tutorial holds everything longer so a voiceover can explain it. */
const pace = cut === "tutorial" ? 1.9 : 1;
// Landscape: the page is laid out 1280 wide and zoomed up to fill a 1080p frame (big, sharp
// text). Vertical: the browser really is phone-sized, so the site uses its phone layout
// (zoom wouldn't trigger it), and ffmpeg scales the clip up to the frame.
const scale = vertical ? 2 : W >= 1920 ? 1.5 : 1;
const zoom = vertical ? 1 : scale;
const viewport = vertical ? { width: Math.round(W / scale), height: Math.round(H / scale) } : { width: W, height: H };

// ---------- playwright (not a dependency of the site: install it only to record) ----------
function loadPlaywright() {
  const tries = [import.meta.url, process.env.PLAYWRIGHT_DIR && path.join(process.env.PLAYWRIGHT_DIR, "noop.js")].filter(Boolean) as string[];
  for (const from of tries) { try { return createRequire(from)("playwright"); } catch { /* next */ } }
  console.error("Playwright isn't installed. Run once:\n  npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}

// ---------- scenes ----------
type Page = any;
interface Ctx { page: Page; mint: string; nft: string; wallet: string; cap: (product: string, tutorial?: string) => Promise<void>; hold: (ms: number) => Promise<void>;
  spot: (selector: string) => Promise<void>; unspot: () => Promise<void>; scrollTo: (selector: string, block?: "start" | "center") => Promise<void>;
  moveTo: (selector: string) => Promise<void>; }
interface Scene { id: string; url: (c: { mint: string; nft: string; wallet: string }) => string; run: (c: Ctx) => Promise<void> }

const SCENES: Scene[] = [
  { id: "hook", url: () => `${MAINNET}/`, run: async (c) => {
    await c.cap("Tax tokens that pay holders in real XNT", "99 + Tax is a launchpad for tax tokens on X1. Every trade pays a small tax, and that tax is paid to holders in XNT.");
    await c.hold(3500);
  } },
  { id: "split", url: () => `${MAINNET}/`, run: async (c) => {
    await c.scrollTo("#tax", "center");
    await c.cap("Every trade pays 1–10%. The creator picks the split", "Creators choose the tax, from 1 to 10%, and how it splits: holders, permanent liquidity, burn, and a 10% creator reward.");
    await c.spot("#bar");
    for (const [id, to] of [["#tax", 8], ["#burn", 40], ["#lp", 10], ["#tax", 5], ["#burn", 25], ["#lp", 25]] as const) await slide(c, id, to);
    await c.hold(1500);
    await c.unspot();
  } },
  { id: "launch", url: () => `${TESTNET}/launch`, run: async (c) => {
    await c.cap("Launch in a few wallet approvals", "Launching takes one form and a few wallet approvals. Here on testnet: a name, a symbol, a logo.");
    await c.scrollTo("#launchForm", "start");
    await type(c, 'input[name="name"]', "Demo Coin");
    await type(c, 'input[name="symbol"]', "DEMO");
    await c.scrollTo("#taxSplit", "center");
    await c.cap("100% of the supply goes into the pool. No dev bag", "The whole supply goes into the XDEX pool, so the creator starts with zero tokens, and the tax rate can never be changed after launch.");
    await c.spot("#taxSplit");
    await c.hold(3000);
    await c.unspot();
    await c.scrollTo("#payoutRow", "center");
    await c.cap("Pay holders in XNT, or in a token you choose", "New: holders can be paid in a token the creator picks instead of XNT. The vault swaps their share on XDEX before paying.");
    await c.spot("#payoutRow");
    await c.hold(3000);
    await c.unspot();
    await c.scrollTo("#launchBtn", "center");
    await c.cap("Liquidity locked in an NFT. Mint and freeze authority revoked", "Launch locks the liquidity in an NFT and revokes the mint and freeze authorities. We stop here: this tour never signs anything.");
    await c.moveTo("#launchBtn");
    await c.hold(3000);
  } },
  { id: "curve", url: () => `${TESTNET}/curve`, run: async (c) => {
    await c.cap("Or start on a bonding curve that graduates to XDEX", "Or launch on a bonding curve: 80% sells on the curve, and at the target the token graduates to XDEX with its liquidity locked and its tax on the vault.");
    await c.hold(2500);
    await scrollBy(c, 700);
    await c.hold(2500);
  } },
  { id: "vault", url: (x) => `${MAINNET}/nft/${x.nft}`, run: async (c) => {
    await c.cap("A program holds the tax. Nobody's wallet does", "Every token's tax goes to the Tax Vault program. No key on any server can move it.");
    await c.hold(2000);
    await c.scrollTo("#vault", "start");
    await c.spot("#vault");
    await c.cap("Collect, sell, add liquidity, burn, pay holders", "The vault collects the tax, sells it for XNT, adds liquidity, burns tokens, sends the creator reward and pays every holder from a public list.");
    await c.hold(3500);
    await c.unspot();
    await scrollBy(c, 500);
    await c.cap("Every step is on-chain and public", "Recent activity shows every step with its transaction. Rewards lists are pinned to IPFS and their fingerprint is stored on-chain, so anyone can check them.");
    await c.hold(3500);
  } },
  { id: "run-vault", url: (x) => `${MAINNET}/nft/${x.nft}`, run: async (c) => {
    await c.scrollTo("#vault", "start");
    await c.cap("Anyone can run the vault, and gets paid to", "The site runs the vault every minute, but anyone can press Run the vault now with their own wallet and earn 1% of the holders' XNT from the sale.");
    const btn = 'button:has-text("Run the vault now")';
    await c.moveTo(btn);
    await c.spot(btn);
    await c.hold(3500);
    await c.unspot();
  } },
  { id: "leaderboard", url: (x) => `${MAINNET}/leaderboard/${x.mint}`, run: async (c) => {
    await c.cap("Every holder's cost, value and rewards", "The leaderboard works out every holder's average cost from their trades, what their tokens are worth now, and what they've been paid.");
    await c.hold(2500);
    await c.scrollTo("table", "start");
    await c.spot("table");
    await c.cap("“If sold now”: after tax and price impact", "If sold now shows what selling the whole bag would really return, after the token's tax and the pool's price impact, not just balance times price.");
    await c.hold(4000);
    await c.unspot();
  } },
  { id: "earnings", url: (x) => `${MAINNET}/wallet/${x.wallet}`, run: async (c) => {
    await c.cap("My earnings: every payout, every token", "My earnings shows any wallet's holdings across every token, the XNT it has received and its lock NFTs.");
    await c.hold(3000);
    await scrollBy(c, 600);
    await c.hold(2500);
  } },
  { id: "analytics", url: () => `${MAINNET}/analytics`, run: async (c) => {
    await c.cap("Paid out, burned, added to liquidity", "Analytics adds it all up across the platform: XNT paid to holders, tokens burned and liquidity added.");
    await c.hold(3000);
    await scrollBy(c, 700);
    await c.hold(2500);
  } },
  { id: "recovery", url: () => `${MAINNET}/recovery`, run: async (c) => {
    await c.cap("If we disappear, holders still get paid", "And if 99 + Tax ever goes offline, this recovery page, pinned on IPFS, lets anyone run every vault from their own wallet. Creators can appoint a new publisher after 7 days, and fallback payouts start after 30.");
    await c.hold(4500);
    await scrollBy(c, 500);
    await c.hold(2500);
  } },
  { id: "themes", url: () => `${MAINNET}/`, run: async (c) => {
    await c.cap("Seven themes, English and Spanish", "The site comes in seven themes, in English and Spanish.");
    for (const t of ["arcade", "space", "desert", "casino", "notebook", "lunchbag", theme]) {
      await c.page.evaluate((name: string) => {
        try { localStorage.setItem("99tax-theme", name); } catch { /* recording only */ }
        const link = document.querySelector('link[rel="stylesheet"][href^="/theme"]') as HTMLLinkElement | null;
        if (link) link.href = `/theme-${name}.css`;
        document.documentElement.dataset.theme = name;
      }, t);
      await c.hold(1300);
    }
  } },
  { id: "outro", url: () => `${MAINNET}/`, run: async (c) => {
    await c.cap("99tax.vercel.app · open source · on X1", "Try it on testnet with free faucet XNT, or launch on mainnet. The code is open source on GitHub. Not financial advice; the programs are in beta and not yet audited.");
    await c.hold(4500);
  } },
];

// ---------- helpers used by the scenes ----------
async function slide(c: Ctx, selector: string, to: number) {
  await c.moveTo(selector);
  const from = Number(await c.page.$eval(selector, (e: HTMLInputElement) => e.value));
  const steps = Math.max(1, Math.abs(to - from));
  for (let i = 1; i <= steps; i++) {
    const v = from + ((to - from) * i) / steps;
    await c.page.$eval(selector, (e: HTMLInputElement, val: number) => { e.value = String(val); e.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await c.page.waitForTimeout(45 * pace);
  }
  await c.hold(400);
}
async function type(c: Ctx, selector: string, text: string) {
  await c.moveTo(selector);
  await c.page.click(selector);
  await c.page.locator(selector).pressSequentially(text, { delay: 90 * pace });
  await c.hold(500);
}
async function scrollBy(c: Ctx, px: number) {
  await c.page.evaluate((y: number) => window.scrollBy({ top: y, behavior: "smooth" }), px);
  await c.hold(1200);
}

// Caption bar, a visible cursor and a highlight ring: recorded video doesn't show the real pointer.
/** Caption and cursor sizes follow the video's size (1 = a 1080-pixel short side). */
const U = Math.min(viewport.width, viewport.height) / 1080 * (vertical ? 1.1 : 1);
const OVERLAY = (captions: boolean, zoom: number) => `
(() => {
  const css = \`
  #__tour-cap{position:fixed;left:50%;bottom:6vh;transform:translateX(-50%) translateY(12px);max-width:88vw;
    padding:${Math.round(18 * U)}px ${Math.round(34 * U)}px;border-radius:${Math.round(18 * U)}px;background:rgb(15 14 22 / .86);color:#fff;font:600 ${Math.round(40 * U)}px/1.3 system-ui,sans-serif;
    text-align:center;opacity:0;transition:opacity .35s,transform .35s;z-index:2147483646;pointer-events:none;box-shadow:0 10px 40px rgb(0 0 0 / .35)}
  #__tour-cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #__tour-cur{position:fixed;left:-60px;top:-60px;width:${Math.round(30 * U)}px;height:${Math.round(30 * U)}px;border-radius:50%;background:rgb(255 210 0 / .55);
    border:${Math.max(2, Math.round(3 * U))}px solid #111;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:left .05s linear,top .05s linear}
  .__tour-spot{outline:4px solid #ffcc00 !important;outline-offset:6px !important;border-radius:6px;transition:outline-color .3s}
  \`;
  const add = () => {
    if (document.getElementById("__tour-cur")) return;
    const s = document.createElement("style"); s.textContent = css + "body{zoom:${zoom}}"; document.head.append(s);
    // Outside <body>, so the zoom doesn't move them off the pointer.
    const cur = document.createElement("div"); cur.id = "__tour-cur"; document.documentElement.append(cur);
    ${captions ? 'const cap = document.createElement("div"); cap.id = "__tour-cap"; document.documentElement.append(cap);' : ""}
    document.addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    // The site's own pop-ups (disclaimer, wallet hints) stay out of the shot.
    for (const g of document.querySelectorAll(".gate")) g.remove();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

// ---------- run ----------
interface Clip { id: string; file: string; trimStart: number; captions: { at: number; text: string }[]; duration: number }

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  // Pick a real token and wallet from the mainnet site (nothing personal is hard-coded).
  let mint = opt("mint") ?? "", wallet = opt("wallet") ?? "";
  const tokens = await (await fetch(`${MAINNET}/api/tokens`)).json() as { mint: string; lockNft?: string }[];
  if (!mint) {
    if (!tokens.length) throw new Error(`No tokens listed at ${MAINNET}/api/tokens; pass --mint.`);
    mint = tokens[0].mint;
  }
  // The token's page (stats, Tax Vault panel) is its LP-lock NFT's page.
  const nft = opt("nft") ?? tokens.find((t) => t.mint === mint)?.lockNft ?? "";
  if (!nft) throw new Error(`No lock NFT found for ${mint}; pass --nft.`);
  if (!wallet) {
    const lb = await (await fetch(`${MAINNET}/api/leaderboard/${mint}`)).json() as { rows?: { wallet: string; balance: number }[] };
    wallet = lb.rows?.find((r) => r.balance > 0)?.wallet ?? "";
    if (!wallet) throw new Error("Couldn't find a holder for the earnings scene; pass --wallet.");
  }
  const scenes = SCENES.filter((s) => !only || only.includes(s.id));
  console.log(`Recording ${scenes.length} scene(s), ${cut} cut, ${W}x${H} (${theme}, ${mode}, ${lang}) → ${outDir}`);

  const browser = await chromium.launch({ headless: !flag("headed") });
  const clips: Clip[] = [];
  for (const [i, s] of scenes.entries()) {
    const ctx = await browser.newContext({ viewport, colorScheme: mode === "dark" ? "dark" : "light",
      recordVideo: { dir: path.join(outDir, ".raw"), size: viewport } });
    await ctx.addInitScript(({ theme, mode, lang }: { theme: string; mode: string; lang: string }) => {
      try {
        localStorage.setItem("99tax-disclaimer-v1", "yes");
        localStorage.setItem("99tax-theme", theme);
        localStorage.setItem("99tax-mode", mode);
        localStorage.setItem("99tax-lang", lang);
      } catch { /* recording only */ }
    }, { theme, mode, lang });
    await ctx.addInitScript(OVERLAY(captionsOn, zoom));
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(s.url({ mint, nft, wallet }), { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(1500); // let the page's data render before the clip starts
    const ready = Date.now();
    const captions: Clip["captions"] = [];
    let mouse = { x: viewport.width / 2, y: viewport.height / 2 };
    const c: Ctx = {
      page, mint, nft, wallet,
      cap: async (product, tutorial) => {
        const text = cut === "tutorial" && tutorial ? tutorial : product;
        captions.push({ at: (Date.now() - ready) / 1000, text });
        if (!captionsOn) return;
        await page.evaluate((t: string) => {
          const el = document.getElementById("__tour-cap"); if (!el) return;
          el.classList.remove("on");
          setTimeout(() => { el.textContent = t; el.classList.add("on"); }, 250);
        }, text);
        await page.waitForTimeout(400);
      },
      hold: (ms) => page.waitForTimeout(ms * pace),
      spot: async (sel) => { await page.locator(sel).first().evaluate((e: Element) => e.classList.add("__tour-spot"), undefined, { timeout: 4000 }).catch(() => undefined); },
      unspot: async () => { await page.evaluate(() => document.querySelectorAll(".__tour-spot").forEach((e) => e.classList.remove("__tour-spot"))); },
      scrollTo: async (sel, block = "start") => {
        await page.locator(sel).first().evaluate((e: Element, b: ScrollLogicalPosition) => e.scrollIntoView({ behavior: "smooth", block: b }), block, { timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(1100 * pace);
      },
      moveTo: async (sel) => {
        const box = await page.locator(sel).first().boundingBox({ timeout: 4000 }).catch(() => null);
        if (!box) return;
        const to = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
        await page.mouse.move(mouse.x, mouse.y);
        await page.mouse.move(to.x, to.y, { steps: 25 });
        mouse = to;
        await page.waitForTimeout(250);
      },
    };
    process.stdout.write(`  ${String(i + 1).padStart(2, "0")} ${s.id}… `);
    try { await s.run(c); } catch (e) { console.log(`(scene error: ${(e as Error).message.split("\n")[0]})`); }
    const duration = (Date.now() - ready) / 1000;
    const video = page.video();
    await ctx.close();
    const raw = await video.path();
    const file = path.join(outDir, `${String(i + 1).padStart(2, "0")}-${s.id}.webm`);
    fs.renameSync(raw, file);
    clips.push({ id: s.id, file, trimStart: (ready - t0) / 1000, captions, duration });
    console.log(`${duration.toFixed(1)} s`);
  }
  await browser.close();
  fs.rmSync(path.join(outDir, ".raw"), { recursive: true, force: true });

  // Captions for the whole tour (.srt), timed against the trimmed, joined clips.
  const srt: string[] = [];
  let offset = 0, n = 1;
  const ts = (t: number) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
  for (const clip of clips) {
    clip.captions.forEach((cp, k) => {
      const end = k + 1 < clip.captions.length ? clip.captions[k + 1].at : clip.duration;
      srt.push(`${n++}\n${ts(offset + cp.at)} --> ${ts(offset + end)}\n${cp.text}\n`);
    });
    offset += clip.duration;
  }
  fs.writeFileSync(path.join(outDir, `tour-${cut}.srt`), srt.join("\n"));
  fs.writeFileSync(path.join(outDir, "shotlist.json"), JSON.stringify({ cut, size: `${W}x${H}`, theme, mode, lang, mint, nft, wallet, clips }, null, 2));

  // MP4s and the joined video, when ffmpeg is installed.
  let ffmpeg = true;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch { ffmpeg = false; }
  if (!ffmpeg) {
    console.log(`\nClips (.webm), captions (.srt) and shotlist.json are in ${outDir}. Install ffmpeg to get MP4s and one joined video.`);
    return;
  }
  const mp4s: string[] = [];
  for (const clip of clips) {
    const mp4 = clip.file.replace(/\.webm$/, ".mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", clip.trimStart.toFixed(2), "-i", clip.file, "-t", clip.duration.toFixed(2),
      "-vf", `scale=${W}:${H}:flags=lanczos,fps=30`, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an", mp4]);
    mp4s.push(mp4);
  }
  const list = path.join(outDir, "concat.txt");
  fs.writeFileSync(list, mp4s.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = path.join(outDir, `tour-${cut}.mp4`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  fs.rmSync(list);
  console.log(`\nDone: ${joined} (${offset.toFixed(0)} s), captions tour-${cut}.srt, one MP4 per scene, shotlist.json.`);
  console.log("Add a voiceover (docs/VIDEO-SCRIPT.md) and music in any editor, or burn in the captions:");
  console.log(`  ffmpeg -i "${joined}" -vf subtitles="${path.join(outDir, `tour-${cut}.srt`)}" "${joined.replace(/\.mp4$/, "-subtitled.mp4")}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
