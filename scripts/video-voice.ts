/**
 * Adds a voiceover to a video recorded by scripts/video-tour.ts: each scene's line from
 * docs/VIDEO-SCRIPT.md is spoken by an ElevenLabs voice, each scene is lengthened (its last
 * frame held) when the line runs longer than the footage, and everything is joined into
 * tour-<cut>-voiced.mp4, with optional background music ducked under the voice.
 *
 *   npx tsx scripts/video-voice.ts --voice <voice id>                    # product cut
 *   npx tsx scripts/video-voice.ts --voice <id> --music track.mp3         # with music
 *   npx tsx scripts/video-voice.ts --voice <id> --regenerate              # new takes
 *
 * The API key is read from ELEVENLABS_API_KEY or ~/.config/elevenlabs/key (never from the
 * repo). Generated lines are kept in video/out/<cut>/voice/ and reused, so re-running only
 * pays for lines whose text changed (or all of them with --regenerate).
 *
 * Options: --cut product (tutorial lines aren't per-scene yet) · --dir <recording dir> ·
 * --model eleven_multilingual_v2 · --music <file> · --music-volume 0.12 · --regenerate
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name: string) => argv.includes(`--${name}`);
const cut = opt("cut", "product")!;
const dir = path.resolve(opt("dir", `video/out/${cut}`)!);
const voice = opt("voice");
const model = opt("model", "eleven_multilingual_v2")!;
const music = opt("music");
const musicVolume = Number(opt("music-volume", "0.12"));
const LEAD = 0.35, TAIL = 0.6; // seconds of silence before and after each line

if (!voice) { console.error("Pass --voice <ElevenLabs voice id> (Voices → the voice → ID)."); process.exit(1); }
const key = process.env.ELEVENLABS_API_KEY
  ?? (() => { try { return fs.readFileSync(path.join(os.homedir(), ".config/elevenlabs/key"), "utf8").trim(); } catch { return ""; } })();
if (!key) { console.error("No ElevenLabs key: set ELEVENLABS_API_KEY or save it to ~/.config/elevenlabs/key (chmod 600)."); process.exit(1); }

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const duration = (f: string) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));

/** The product cut's voiceover: the "Voiceover" column of the table in docs/VIDEO-SCRIPT.md. */
function productLines(): Map<string, string> {
  const doc = fs.readFileSync(path.resolve("docs/VIDEO-SCRIPT.md"), "utf8");
  const lines = new Map<string, string>();
  for (const row of doc.split("\n")) {
    const m = /^\| \d+ \| `([a-z-]+)` \| [^|]+\| [^|]+\| (.+) \|$/.exec(row);
    if (m) lines.set(m[1], m[2].trim());
  }
  return lines;
}
/** Spelled the way a voice should say it (only for speech; the captions keep the real text). */
const speakable = (t: string) => t
  .replace(/99tax\.vercel\.app/g, "ninety-nine tax dot vercel dot app")
  .replace(/99 \+ Tax/g, "Ninety-nine plus Tax")
  .replace(/\bXDEX\b/g, "X-DEX")
  .replace(/\bIPFS\b/g, "I-P-F-S")
  .replace(/\bNFT\b/g, "N-F-T")
  .replace(/\b1 to 10 percent\b/g, "one to ten percent");

async function tts(text: string, prev: string, next: string, out: string) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, previous_text: prev || undefined, next_text: next || undefined,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

async function main() {
  if (cut !== "product") throw new Error("Only the product cut has per-scene lines so far.");
  const shot = JSON.parse(fs.readFileSync(path.join(dir, "shotlist.json"), "utf8")) as { clips: { id: string; file: string; duration: number }[] };
  const lines = productLines();
  const voiceDir = path.join(dir, "voice");
  fs.mkdirSync(voiceDir, { recursive: true });
  const spoken = shot.clips.map((c) => (lines.has(c.id) ? speakable(lines.get(c.id)!) : ""));

  // 1. One take per line (cached by text + voice + model).
  const takes: (string | null)[] = [];
  for (const [i, c] of shot.clips.entries()) {
    const text = spoken[i];
    if (!text) { takes.push(null); continue; }
    const tag = crypto.createHash("sha256").update(`${voice}|${model}|${text}`).digest("hex").slice(0, 10);
    const file = path.join(voiceDir, `${path.basename(c.file, path.extname(c.file))}-${tag}.mp3`);
    if (flag("regenerate") || !fs.existsSync(file)) {
      process.stdout.write(`  voice ${c.id}… `);
      await tts(text, spoken.slice(0, i).filter(Boolean).pop() ?? "", spoken.slice(i + 1).find(Boolean) ?? "", file);
      console.log(`${duration(file).toFixed(1)} s`);
    }
    takes.push(file);
  }

  // 2. Each scene with its line: footage held on its last frame if the line is longer.
  const parts: string[] = [];
  for (const [i, c] of shot.clips.entries()) {
    const video = c.file.replace(/\.webm$/, ".mp4");
    const vlen = duration(video);
    const take = takes[i];
    const alen = take ? duration(take) : 0;
    const len = Math.max(vlen, take ? LEAD + alen + TAIL : vlen);
    const out = path.join(voiceDir, `scene-${String(i + 1).padStart(2, "0")}.mp4`);
    const hold = Math.max(0, len - vlen);
    const vf = `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}`;
    const args = ["-y", "-loglevel", "error", "-i", video];
    if (take) args.push("-i", take); else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
    args.push("-filter_complex", take
      ? `[0:v]${vf}[v];[1:a]adelay=${Math.round(LEAD * 1000)}|${Math.round(LEAD * 1000)},aresample=44100,apad[a]`
      : `[0:v]${vf}[v];[1:a]aresample=44100[a]`,
    "-map", "[v]", "-map", "[a]", "-t", len.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", out);
    sh("ffmpeg", args);
    parts.push(out);
    console.log(`  scene ${c.id}: ${vlen.toFixed(1)} s footage, ${alen.toFixed(1)} s voice → ${len.toFixed(1)} s`);
  }

  // 3. Join, then music under the voice (ducked further whenever the voice speaks).
  const list = path.join(voiceDir, "concat.txt");
  fs.writeFileSync(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const joined = path.join(dir, `tour-${cut}-voiced.mp4`);
  const tmp = music ? path.join(voiceDir, "joined.mp4") : joined;
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", tmp]);
  fs.rmSync(list);
  if (music) {
    sh("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-stream_loop", "-1", "-i", path.resolve(music), "-filter_complex",
      `[0:a]asplit=2[v1][v2];[1:a]volume=${musicVolume},aresample=44100[m];[m][v1]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[md];` +
      `[v2][md]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${(duration(tmp) - 2).toFixed(2)}:d=2[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", joined]);
    fs.rmSync(tmp);
  }
  console.log(`\nDone: ${joined} (${duration(joined).toFixed(0)} s). Takes are in ${voiceDir}; re-run with --regenerate for new ones.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
