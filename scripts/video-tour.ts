/**
 * Records a narrated tour of the live 99 + Tax site, for a product video or a tutorial.
 *
 * The narration drives everything: each scene is a list of sentences (NARRATION below, the
 * single source of the script; docs/VIDEO-SCRIPT.md is generated from it with
 * --print-script). Each sentence is shown as the caption while it's spoken, the screen
 * action it talks about (typing, scrolling, a highlight) happens during it, and the next
 * sentence waits until it's finished. With --voice, every sentence is spoken by an
 * ElevenLabs voice first, so the recording is timed to the real audio and the voice lands
 * on the action it describes; without it, sentences are timed at a speaking pace, ready
 * for a voiceover read from the printed script.
 *
 * Read-only: it browses public pages, never connects a wallet and never sends a transaction.
 * The launch scene types example values into the testnet form and stops before any approval.
 *
 *   npm i --no-save playwright && npx playwright install chromium     # once; plus ffmpeg
 *   npx tsx scripts/video-tour.ts --voice <ElevenLabs voice id>       # product cut, voiced
 *   npx tsx scripts/video-tour.ts --cut tutorial --voice <id>         # the ~6 min tutorial
 *   npx tsx scripts/video-tour.ts --vertical --voice <id>             # 1080x1920 for shorts
 *   npx tsx scripts/video-tour.ts --print-script                      # the script as Markdown
 *
 * Options: --cut product|tutorial · --voice <id> · --model eleven_multilingual_v2 ·
 * --music <file> (ducked under the voice) · --scenes a,b,c · --theme <name> ·
 * --mode light|dark · --lang en|es · --size 1920x1080 · --vertical · --mainnet <url> ·
 * --testnet <url> · --mint <token> · --nft <its lock NFT> · --wallet <address> ·
 * --out <dir> (default video/out) · --no-captions · --headed
 *
 * The ElevenLabs key comes from ELEVENLABS_API_KEY or ~/.config/elevenlabs/key, never the
 * repo. Spoken sentences are cached in video/out/voice-cache, so re-runs only pay for
 * sentences that changed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

// ---------- options ----------
type Cut = "product" | "tutorial";
const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name: string) => argv.includes(`--${name}`);
const cut = (opt("cut", "product") as Cut);
const vertical = flag("vertical");
const [W, H] = (opt("size", vertical ? "1080x1920" : "1920x1080")!).split("x").map(Number);
const theme = opt("theme", "receipt")!;
const mode = opt("mode", "light")!;
const lang = opt("lang", "en")!;
const MAINNET = (opt("mainnet", "https://99tax.vercel.app")!).replace(/\/$/, "");
const TESTNET = (opt("testnet", "https://99tax-testnet.vercel.app")!).replace(/\/$/, "");
const outRoot = path.resolve(opt("out", "video/out")!);
const outDir = path.join(outRoot, `${cut}${vertical ? "-vertical" : ""}`);
const only = opt("scenes")?.split(",").map((s) => s.trim()).filter(Boolean);
const captionsOn = !flag("no-captions");
const voice = opt("voice");
const model = opt("model", "eleven_multilingual_v2")!;
const music = opt("music");
// Landscape: the page is laid out 1280 wide and zoomed up to fill a 1080p frame (big, sharp
// text). Vertical: the browser really is phone-sized, so the site uses its phone layout
// (zoom wouldn't trigger it), and ffmpeg scales the clip up to the frame.
const scale = vertical ? 2 : W >= 1920 ? 1.5 : 1;
const zoom = vertical ? 1 : scale;
const viewport = vertical ? { width: Math.round(W / scale), height: Math.round(H / scale) } : { width: W, height: H };
const GAP = 0.35; // seconds of quiet between sentences
const TAIL = 0.8; // after a scene's last sentence

// ---------- the script ----------
/** Every scene's narration, sentence by sentence, for each cut. The recorder and the docs both read this. */
const NARRATION: Record<string, { title: string; product: string[]; tutorial: string[] }> = {
  hook: { title: "What 99 + Tax is", product: [
    "Most tax tokens ask you to trust a wallet.",
    "99 + Tax pays holders in real XNT, from a program nobody controls.",
  ], tutorial: [
    "99 + Tax is a launchpad for tax tokens on the X1 blockchain.",
    "Every time someone trades one of these tokens, a small tax is taken, and that tax is paid to the people holding the token, in XNT, straight to their wallets.",
    "The difference from most tax tokens: the tax isn't held by the team's wallet. A program on the chain holds it, and it keeps working even if this website goes away.",
  ] },
  split: { title: "Where the tax goes", product: [
    "Every trade pays a small tax, from 1 to 10 percent.",
    "The creator picks the split: holders, permanent liquidity, burn, and a creator reward.",
  ], tutorial: [
    "The creator sets the tax, anywhere from 1 to 10 percent, and decides how it splits.",
    "At least 35 percent always goes to holders. Up to half can be added to the pool as permanent liquidity, and those liquidity tokens are burned, so it can never be pulled.",
    "Up to half can be burned, so the supply only goes down. And 10 percent is the creator's reward, paid in USDC on mainnet and vesting over seven days.",
    "Drag the sliders on the home page to see what a day of trading would pay.",
  ] },
  launch: { title: "Launching a token", product: [
    "Launching takes one form and a few wallet approvals.",
    "The whole supply goes into the pool, so there's no dev bag.",
    "Holders can be paid in XNT, or in a token you choose.",
    "The liquidity is locked in an NFT, and the tax can never be changed.",
  ], tutorial: [
    "Here's the launch form, on testnet, where XNT is free from the faucet. A name, a symbol, a logo, and the split.",
    "All of the supply goes into an XDEX pool. You start with zero tokens, like everyone else.",
    "New: Pay holders in lets you pay holders in another token instead of XNT. The vault swaps their share on XDEX before paying.",
    "When you press Launch, your wallet approves a few transactions: the token is created, the pool's liquidity is locked in an NFT that you hold, and the mint and freeze authorities are revoked.",
  ] },
  curve: { title: "The bonding curve", product: [
    "Or start on a bonding curve that graduates to XDEX by itself.",
  ], tutorial: [
    "On testnet you can also launch on a bonding curve. 80 percent of the supply sells on the curve, with no tax.",
    "When it reaches its target, from 500 to 10,000 XNT, it graduates: the other 20 percent and the XNT seed an XDEX pool, the liquidity is locked, and from then on its tax runs through the vault like any other token.",
  ] },
  vault: { title: "The Tax Vault", product: [
    "The tax goes to the Tax Vault program, not to anyone's wallet.",
    "It sells the tax for XNT, adds liquidity, burns tokens and pays every holder.",
    "Every payout list is public on IPFS, and every step is on-chain.",
  ], tutorial: [
    "This is a token's page. The Tax Vault panel shows what the vault is doing.",
    "It collects the tax from every trade, sells it for XNT with a cap on price impact, adds liquidity, burns tokens and sends the creator their reward.",
    "Then it builds the rewards list: what every holder is owed, by balance. The list is pinned to IPFS with its fingerprint on-chain, and after a ten-minute window the vault pays each wallet exactly its line.",
    "Recent activity links every step to its transaction.",
  ] },
  "run-vault": { title: "Anyone can run it", product: [
    "Anyone can run the vault, and gets paid to.",
    "No one running it can take a cent.",
  ], tutorial: [
    "The site runs the vault every minute, but it doesn't have to be us.",
    "Anyone can press Run the vault now: your wallet pays the small network fee, and you earn 1 percent of the holders' XNT from each sale, up to 0.05 XNT.",
    "The program decides every amount, so whoever runs it can't take anything.",
  ] },
  leaderboard: { title: "The leaderboard", product: [
    "Every holder sees their cost, what it's worth, and what they've earned.",
    "If sold now shows what selling would really return, after the tax and the price impact.",
  ], tutorial: [
    "The leaderboard works out every holder's average buy price from their trades on XDEX, including trades routed through other pools.",
    "Worth now is your balance at today's price.",
    "If sold now is what selling the whole bag would really return, after the token's tax and the price impact of the sale itself. That matters for big holders.",
    "Rewards earned and total return add it all up.",
  ] },
  earnings: { title: "My earnings", product: [
    "My earnings shows your payouts across every token, in one place.",
  ], tutorial: [
    "My earnings shows any wallet's holdings across every token, the XNT it has received, and its lock NFTs with fees and rewards ready to claim.",
  ] },
  analytics: { title: "Analytics", product: [
    "Analytics adds it all up: XNT paid to holders, tokens burned and liquidity added.",
  ], tutorial: [
    "Analytics adds it up across the whole platform: XNT paid to holders, tokens burned and liquidity added.",
  ] },
  recovery: { title: "If 99 + Tax disappears", product: [
    "And if we ever disappear, a recovery page on IPFS keeps every vault running.",
  ], tutorial: [
    "What happens if this site goes offline? The money is on-chain, so nothing is lost.",
    "This recovery page is one file pinned on IPFS. It talks only to the blockchain and your wallet, and lets anyone run every vault.",
    "If no new rewards list is published for seven days, the token's creator can appoint a new publisher. After thirty days, anyone can pay holders from the last list.",
    "And the code is open source on GitHub.",
  ] },
  themes: { title: "Themes and languages", product: [
    "Seven themes, in English and Spanish.",
  ], tutorial: [
    "The site comes in seven themes, in English and in Spanish.",
  ] },
  outro: { title: "Try it", product: [
    "99 + Tax. Live on X1.",
    "Try it free on testnet, or launch on mainnet at 99tax.vercel.app.",
  ], tutorial: [
    "Try everything on testnet with free faucet XNT, then launch on mainnet at 99tax.vercel.app.",
    "One last thing: the programs are in beta and haven't had a formal audit yet, and nothing here is financial advice. Thanks for watching.",
  ] },
};
/** Spelled the way a voice should say it (speech only; captions keep the real text). */
const speakable = (t: string) => t
  .replace(/99tax\.vercel\.app/g, "ninety-nine tax dot vercel dot app")
  .replace(/99 \+ Tax/g, "Ninety-nine plus Tax")
  .replace(/\bXDEX\b/g, "X-DEX")
  .replace(/\bIPFS\b/g, "I-P-F-S")
  .replace(/\bNFTs\b/g, "N-F-Ts").replace(/\bNFT\b/g, "N-F-T")
  .replace(/\bUSDC\b/g, "U-S-D-C");

// ---------- scenes: what happens on screen while each sentence is spoken ----------
type Page = any;
interface Ctx { page: Page;
  /** Speak (and caption) the scene's next sentence once the previous one has finished; false when the cut has no more. */
  say: () => Promise<boolean>;
  /** Speak whatever sentences are left, one after another. */
  sayRest: () => Promise<void>;
  hold: (ms: number) => Promise<void>; spot: (selector: string) => Promise<void>; unspot: () => Promise<void>;
  scrollTo: (selector: string, block?: "start" | "center") => Promise<void>; moveTo: (selector: string) => Promise<void>; }
interface Scene { id: string; url: (c: { mint: string; nft: string; wallet: string }) => string; run: (c: Ctx) => Promise<void> }

const SCENES: Scene[] = [
  { id: "hook", url: () => `${MAINNET}/`, run: async (c) => { await c.sayRest(); } },
  { id: "split", url: () => `${MAINNET}/`, run: async (c) => {
    await c.scrollTo("#tax", "center");
    await c.say();
    await c.moveTo("#tax"); await slide(c, "#tax", 8); await slide(c, "#tax", 5);
    await c.say();
    await c.spot("#bar");
    await slide(c, "#lp", 10); await slide(c, "#burn", 40);
    if (await c.say()) { await slide(c, "#burn", 25); await slide(c, "#lp", 25); }
    await c.sayRest();
    await c.unspot();
  } },
  { id: "launch", url: () => `${TESTNET}/launch`, run: async (c) => {
    await c.scrollTo("#launchForm", "start");
    await c.say();
    await type(c, 'input[name="name"]', "Demo Coin");
    await type(c, 'input[name="symbol"]', "DEMO");
    await c.scrollTo("label:has(output.fixed-pct)", "center");
    await c.say();
    await c.spot("label:has(output.fixed-pct)");
    await c.say();
    await c.unspot(); await c.scrollTo("#payoutRow", "center"); await c.spot("#payoutRow");
    await c.say();
    await c.unspot(); await c.scrollTo('select[name="lock"]', "center"); await c.spot('select[name="lock"]');
    await c.moveTo("#launchBtn");
    await c.sayRest();
    await c.unspot();
  } },
  { id: "curve", url: () => `${TESTNET}/curve`, run: async (c) => {
    await c.say();
    await scrollBy(c, 600);
    await c.sayRest();
  } },
  { id: "vault", url: (x) => `${MAINNET}/nft/${x.nft}`, run: async (c) => {
    await c.say();
    await c.scrollTo("#vault", "start"); await c.spot("#vault");
    await c.say();
    await c.say();
    await c.unspot(); await c.scrollTo('#vault h4:has-text("Recent activity")', "start");
    await c.sayRest();
  } },
  { id: "run-vault", url: (x) => `${MAINNET}/nft/${x.nft}`, run: async (c) => {
    await c.scrollTo("#vault", "start");
    const btn = 'button:has-text("Run the vault now"), button:has-text("Ejecutar la bóveda ahora")';
    await c.say();
    await c.moveTo(btn); await c.spot(btn);
    await c.sayRest();
    await c.unspot();
  } },
  { id: "leaderboard", url: (x) => `${MAINNET}/leaderboard/${x.mint}`, run: async (c) => {
    await c.scrollTo("table", "start");
    await c.say();
    for (const col of cut === "tutorial" ? ["Worth now", "If sold now", "Total return"] : ["If sold now"]) {
      const th = `th:has-text("${col}")`;
      await c.moveTo(th); await c.spot(th);
      await c.say();
      await c.unspot();
    }
    await c.sayRest();
  } },
  { id: "earnings", url: (x) => `${MAINNET}/wallet/${x.wallet}`, run: async (c) => { await c.say(); await scrollBy(c, 500); await c.sayRest(); } },
  { id: "analytics", url: () => `${MAINNET}/analytics`, run: async (c) => { await c.say(); await scrollBy(c, 600); await c.sayRest(); } },
  { id: "recovery", url: () => `${MAINNET}/recovery`, run: async (c) => {
    await c.say();
    await scrollBy(c, 300);
    await c.sayRest();
  } },
  { id: "themes", url: () => `${MAINNET}/`, run: async (c) => {
    await c.say();
    for (const t of ["arcade", "space", "desert", "casino", "notebook", "lunchbag", theme]) {
      await c.page.evaluate((name: string) => {
        try { localStorage.setItem("99tax-theme", name); } catch { /* recording only */ }
        const link = document.querySelector('link[rel="stylesheet"][href^="/theme"]') as HTMLLinkElement | null;
        if (link) link.href = `/theme-${name}.css`;
        document.documentElement.dataset.theme = name;
      }, t);
      await c.hold(1100);
    }
    await c.sayRest();
  } },
  { id: "outro", url: () => `${MAINNET}/`, run: async (c) => { await c.sayRest(); } },
];

async function slide(c: Ctx, selector: string, to: number) {
  await c.moveTo(selector);
  const from = Number(await c.page.$eval(selector, (e: HTMLInputElement) => e.value));
  const steps = Math.max(1, Math.abs(to - from));
  for (let i = 1; i <= steps; i++) {
    const v = from + ((to - from) * i) / steps;
    await c.page.$eval(selector, (e: HTMLInputElement, val: number) => { e.value = String(val); e.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await c.page.waitForTimeout(45);
  }
  await c.hold(300);
}
async function type(c: Ctx, selector: string, text: string) {
  await c.moveTo(selector);
  await c.page.click(selector);
  await c.page.locator(selector).pressSequentially(text, { delay: 85 });
  await c.hold(300);
}
async function scrollBy(c: Ctx, px: number) {
  await c.page.evaluate((y: number) => window.scrollBy({ top: y, behavior: "smooth" }), px);
  await c.hold(1000);
}

// ---------- voice (ElevenLabs) ----------
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const audioLength = (f: string) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
/** A sentence and how long it takes: its voice take, or a speaking pace (~2.6 words a second) without one. */
interface Line { text: string; file: string | null; seconds: number }

async function speakAll(lines: string[]): Promise<Line[]> {
  if (!voice) return lines.map((text) => ({ text, file: null, seconds: text.split(/\s+/).length / 2.6 + 0.3 }));
  const key = process.env.ELEVENLABS_API_KEY
    ?? (() => { try { return fs.readFileSync(path.join(os.homedir(), ".config/elevenlabs/key"), "utf8").trim(); } catch { return ""; } })();
  if (!key) throw new Error("No ElevenLabs key: set ELEVENLABS_API_KEY or save it to ~/.config/elevenlabs/key (chmod 600).");
  const cache = path.join(outRoot, "voice-cache");
  fs.mkdirSync(cache, { recursive: true });
  const spoken = lines.map(speakable);
  const out: Line[] = [];
  for (const [i, text] of lines.entries()) {
    const prev = spoken[i - 1] ?? "", next = spoken[i + 1] ?? "";
    const file = path.join(cache, crypto.createHash("sha256").update(`${voice}|${model}|${spoken[i]}|${prev}|${next}`).digest("hex").slice(0, 16) + ".mp3");
    if (!fs.existsSync(file)) {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: spoken[i], model_id: model, previous_text: prev || undefined, next_text: next || undefined,
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
      });
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      process.stdout.write(".");
    }
    out.push({ text, file, seconds: audioLength(file) });
  }
  return out;
}

// ---------- overlay: caption, a visible cursor, highlights ----------
/** Caption and cursor sizes follow the video's size (1 = a 1080-pixel short side). */
const U = Math.min(viewport.width, viewport.height) / 1080 * (vertical ? 1.1 : 1) * (cut === "tutorial" ? 0.85 : 1);
const OVERLAY = (captions: boolean, z: number) => `
(() => {
  const css = \`
  #__tour-cap{position:fixed;left:50%;bottom:5vh;transform:translateX(-50%) translateY(12px);width:max-content;max-width:86vw;
    padding:${Math.round(18 * U)}px ${Math.round(34 * U)}px;border-radius:${Math.round(18 * U)}px;background:rgb(15 14 22 / .86);color:#fff;font:600 ${Math.round(40 * U)}px/1.3 system-ui,sans-serif;
    text-align:center;text-wrap:balance;opacity:0;transition:opacity .3s,transform .3s;z-index:2147483646;pointer-events:none;box-shadow:0 10px 40px rgb(0 0 0 / .35)}
  #__tour-cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
  #__tour-cur{position:fixed;left:-60px;top:-60px;width:${Math.round(30 * U)}px;height:${Math.round(30 * U)}px;border-radius:50%;background:rgb(255 210 0 / .55);
    border:${Math.max(2, Math.round(3 * U))}px solid #111;z-index:2147483647;pointer-events:none;transform:translate(-50%,-50%);transition:left .05s linear,top .05s linear}
  .__tour-spot{outline:4px solid #ffcc00 !important;outline-offset:6px !important;border-radius:6px;transition:outline-color .3s}
  \`;
  const add = () => {
    if (document.getElementById("__tour-cur")) return;
    const s = document.createElement("style"); s.textContent = css + "body{zoom:${z}}"; document.head.append(s);
    // Outside <body>, so the zoom doesn't move them off the pointer.
    const cur = document.createElement("div"); cur.id = "__tour-cur"; document.documentElement.append(cur);
    ${captions ? 'const cap = document.createElement("div"); cap.id = "__tour-cap"; document.documentElement.append(cap);' : ""}
    document.addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    // The site's own pop-ups (disclaimer, wallet hints) stay out of the shot.
    for (const g of document.querySelectorAll(".gate")) g.remove();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})();`;

// ---------- the script as Markdown (for docs/VIDEO-SCRIPT.md) ----------
function printScript() {
  for (const c of ["product", "tutorial"] as Cut[]) {
    console.log(`### ${c === "product" ? "Product video" : "Tutorial"}\n`);
    for (const s of SCENES) {
      const n = NARRATION[s.id];
      console.log(`**${n.title}** (\`${s.id}\`)\n`);
      for (const line of n[c]) console.log(`> ${line}`);
      console.log("");
    }
  }
}

// ---------- run ----------
function loadPlaywright() {
  const tries = [import.meta.url, process.env.PLAYWRIGHT_DIR && path.join(process.env.PLAYWRIGHT_DIR, "noop.js")].filter(Boolean) as string[];
  for (const from of tries) { try { return createRequire(from)("playwright"); } catch { /* next */ } }
  console.error("Playwright isn't installed. Run once:\n  npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}
interface Said { at: number; line: Line }
interface Clip { id: string; file: string; trimStart: number; said: Said[]; duration: number }

async function main() {
  if (flag("print-script")) { printScript(); return; }
  const scenes = SCENES.filter((s) => !only || only.includes(s.id));
  // Speak the whole script first (one call per sentence, cached), so the recording is timed to it.
  const all = scenes.flatMap((s) => NARRATION[s.id][cut]);
  if (voice) process.stdout.write(`Voicing ${all.length} sentences `);
  const lines = await speakAll(all);
  if (voice) console.log(" done");
  let next = 0;

  const { chromium } = loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  // A real token and wallet from the mainnet site (nothing personal is hard-coded).
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
  console.log(`Recording ${scenes.length} scene(s), ${cut} cut, ${W}x${H} (${theme}, ${mode}, ${lang})${voice ? ", voiced" : ""} → ${outDir}`);

  const browser = await chromium.launch({ headless: !flag("headed") });
  const clips: Clip[] = [];
  for (const [i, s] of scenes.entries()) {
    const mine = lines.slice(next, next + NARRATION[s.id][cut].length);
    next += mine.length;
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
    const now = () => (Date.now() - ready) / 1000;
    const said: Said[] = [];
    let k = 0, speakingUntil = 0.4; // a beat of picture before the first sentence
    let mouse = { x: viewport.width / 2, y: viewport.height / 2 };
    const waitUntil = async (t: number) => { const ms = (t - now()) * 1000; if (ms > 0) await page.waitForTimeout(ms); };
    const c: Ctx = {
      page,
      say: async () => {
        if (k >= mine.length) return false;
        await waitUntil(speakingUntil);
        const line = mine[k++];
        said.push({ at: now(), line });
        speakingUntil = now() + line.seconds + GAP;
        if (captionsOn) {
          await page.evaluate((t: string) => {
            const el = document.getElementById("__tour-cap"); if (!el) return;
            el.textContent = t; el.classList.add("on");
          }, line.text).catch(() => undefined);
        }
        return true;
      },
      sayRest: async () => { while (await c.say()) { /* one after another */ } },
      hold: (ms) => page.waitForTimeout(ms),
      spot: async (sel) => { await page.locator(sel).first().evaluate((e: Element) => e.classList.add("__tour-spot"), undefined, { timeout: 4000 }).catch(() => undefined); },
      unspot: async () => { await page.evaluate(() => document.querySelectorAll(".__tour-spot").forEach((e) => e.classList.remove("__tour-spot"))).catch(() => undefined); },
      scrollTo: async (sel, block = "start") => {
        await page.locator(sel).first().evaluate((e: Element, b: ScrollLogicalPosition) => e.scrollIntoView({ behavior: "smooth", block: b }), block, { timeout: 4000 }).catch(() => undefined);
        await page.waitForTimeout(900);
      },
      moveTo: async (sel) => {
        const box = await page.locator(sel).first().boundingBox({ timeout: 4000 }).catch(() => null);
        if (!box) return;
        const to = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
        await page.mouse.move(mouse.x, mouse.y);
        await page.mouse.move(to.x, to.y, { steps: 25 });
        mouse = to;
        await page.waitForTimeout(200);
      },
    };
    process.stdout.write(`  ${String(i + 1).padStart(2, "0")} ${s.id}… `);
    try { await s.run(c); } catch (e) { console.log(`(scene error: ${(e as Error).message.split("\n")[0]})`); }
    await c.sayRest();
    await waitUntil(speakingUntil - GAP + TAIL); // let the last sentence finish
    const duration = now();
    const video = page.video();
    await ctx.close();
    const file = path.join(outDir, `${String(i + 1).padStart(2, "0")}-${s.id}.webm`);
    fs.renameSync(await video.path(), file);
    clips.push({ id: s.id, file, trimStart: (ready - t0) / 1000, said, duration });
    console.log(`${duration.toFixed(1)} s, ${said.length} sentence(s)`);
  }
  await browser.close();
  fs.rmSync(path.join(outDir, ".raw"), { recursive: true, force: true });

  // The script as recorded (each sentence at its time), and captions as an .srt.
  const ts = (t: number) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3.6e6), m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const srt: string[] = [], md: string[] = [`# ${cut === "product" ? "Product video" : "Tutorial"}: script as recorded\n`];
  let offset = 0, n = 1;
  for (const clip of clips) {
    md.push(`**${mmss(offset)} · ${NARRATION[clip.id].title}** (\`${clip.id}\`)\n`);
    for (const sd of clip.said) {
      srt.push(`${n++}\n${ts(offset + sd.at)} --> ${ts(offset + sd.at + sd.line.seconds)}\n${sd.line.text}\n`);
      md.push(`- \`${mmss(offset + sd.at)}\` ${sd.line.text}`);
    }
    md.push("");
    offset += clip.duration;
  }
  fs.writeFileSync(path.join(outDir, `tour-${cut}.srt`), srt.join("\n"));
  fs.writeFileSync(path.join(outDir, `script-${cut}.md`), md.join("\n"));
  fs.writeFileSync(path.join(outDir, "shotlist.json"), JSON.stringify({ cut, size: `${W}x${H}`, theme, mode, lang, voice: voice ?? null, mint, nft, wallet,
    clips: clips.map((c) => ({ ...c, said: c.said.map((s) => ({ at: s.at, text: s.line.text, seconds: s.line.seconds })) })) }, null, 2));

  // MP4s (each sentence's audio at the moment its caption appeared), then one joined video.
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); } catch {
    console.log(`\nClips (.webm), the script, captions (.srt) and shotlist.json are in ${outDir}. Install ffmpeg for MP4s, the voice and one joined video.`);
    return;
  }
  const mp4s: string[] = [];
  for (const clip of clips) {
    const mp4 = clip.file.replace(/\.webm$/, ".mp4");
    const voiced = clip.said.filter((s) => s.line.file);
    const args = ["-y", "-loglevel", "error", "-ss", clip.trimStart.toFixed(2), "-i", clip.file];
    for (const s of voiced) args.push("-i", s.line.file!);
    args.push("-f", "lavfi", "-t", clip.duration.toFixed(2), "-i", "anullsrc=r=44100:cl=stereo");
    const silence = voiced.length + 1;
    const mix = voiced.map((s, j) => `[${j + 1}:a]aresample=44100,adelay=${Math.round(s.at * 1000)}:all=1[a${j}]`);
    const filter = `[0:v]scale=${W}:${H}:flags=lanczos,fps=30[v];` + mix.map((m) => m + ";").join("") +
      `[${silence}:a]${voiced.map((_, j) => `[a${j}]`).join("")}amix=inputs=${voiced.length + 1}:duration=first:normalize=0[a]`;
    args.push("-filter_complex", filter, "-map", "[v]", "-map", "[a]", "-t", clip.duration.toFixed(2),
      "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", mp4);
    sh("ffmpeg", args);
    mp4s.push(mp4);
  }
  const list = path.join(outDir, "concat.txt");
  fs.writeFileSync(list, mp4s.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = path.join(outDir, `tour-${cut}.mp4`);
  const tmp = music ? path.join(outDir, "joined-nomusic.mp4") : joined;
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", tmp]);
  fs.rmSync(list);
  if (music) {
    // Music under the voice: quiet, and quieter still while someone is speaking.
    sh("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-stream_loop", "-1", "-i", path.resolve(music), "-filter_complex",
      `[0:a]asplit=2[v1][v2];[1:a]volume=${opt("music-volume", "0.12")},aresample=44100[m];[m][v1]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[md];` +
      `[v2][md]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${(offset - 2).toFixed(2)}:d=2[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", joined]);
    fs.rmSync(tmp);
  }
  console.log(`\nDone: ${joined} (${offset.toFixed(0)} s)${voice ? ", voiced" : ""}. Script as recorded: script-${cut}.md; captions: tour-${cut}.srt.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
