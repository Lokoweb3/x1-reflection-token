# Video script: how 99 + Tax works

Two cuts of the same story, both built from screen recordings of the live site:

- **Product video** (~90 s): what it is and why it's different. For X, the landing page,
  a pitch.
- **Tutorial** (~6 min): the same scenes held longer, with a voiceover that explains each
  screen. For YouTube and the docs.

`scripts/video-tour.ts` records the footage scene by scene (captions, a visible cursor and
a highlight on what each line talks about) and joins it into one MP4 with an `.srt`. Record,
add the voiceover below and music in any editor, done.

## Record the footage

```bash
npm i --no-save playwright && npx playwright install chromium   # once; ffmpeg for MP4s
npx tsx scripts/video-tour.ts                        # product cut, 1920x1080 → video/out/product/
npx tsx scripts/video-tour.ts --cut tutorial         # tutorial cut (slower, longer captions)
npx tsx scripts/video-tour.ts --vertical             # 1080x1920 for Shorts / TikTok / Reels
npx tsx scripts/video-tour.ts --theme arcade --mode dark --lang es   # another look or Spanish
npx tsx scripts/video-tour.ts --scenes vault,leaderboard             # re-shoot a few scenes
npx tsx scripts/video-tour.ts --no-captions          # clean footage; captions only in the .srt
```

Out: one `NN-scene.mp4` per scene (loading frames trimmed), `tour-<cut>.mp4` joined,
`tour-<cut>.srt` (the captions, timed to the joined video) and `shotlist.json` (which token
and wallet were shown, and when each caption appears). The token is the newest mainnet
launch and the wallet its biggest holder, both read from the site; `--mint` and `--wallet`
pick others.

The recorder only browses public pages: it never connects a wallet or signs anything.
The launch scene types "Demo Coin" into the testnet form and stops before the approvals.

## Product video (~90 s)

Voiceover: calm, confident, no hype. Music: light, steady beat, ducked under the voice.

| # | Scene (`--scenes`) | Time | On screen | Voiceover |
|---|---|---|---|---|
| 1 | `hook` | 0:00 | Landing: "Every trade pays tax. Holders get paid." | Most tax tokens ask you to trust a wallet. 99 + Tax pays holders in real XNT, from a program nobody controls. |
| 2 | `split` | 0:07 | The tax sliders move; the split bar redraws | Every trade pays a small tax, 1 to 10 percent. The creator picks the split: holders, permanent liquidity, burn and a creator reward. |
| 3 | `launch` | 0:17 | Testnet launch form: name, symbol, split, "Pay holders in", Launch | Launching takes one form and a few wallet approvals. The whole supply goes into the pool, there's no dev bag, the liquidity is locked in an NFT, and the tax can never be changed. |
| 4 | `curve` | 0:32 | Bonding curve page | Or start on a bonding curve that graduates to XDEX by itself. |
| 5 | `vault` | 0:38 | Token page, Tax Vault panel highlighted, recent activity | The tax goes to the Tax Vault program, not a wallet. It sells for XNT, adds liquidity, burns, and pays every holder from a public list on IPFS. |
| 6 | `run-vault` | 0:50 | "Run the vault now" highlighted | Anyone can run the vault, and gets paid to. No one running it can take a cent. |
| 7 | `leaderboard` | 0:56 | Holder leaderboard, "If sold now" | Every holder sees their cost, what it's worth, and what they've earned. |
| 8 | `earnings` | 1:04 | My earnings page | Your payouts, across every token, in one place. |
| 9 | `recovery` | 1:10 | Recovery page | And if we ever disappear, a recovery page on IPFS keeps every vault running. |
| 10 | `themes` | 1:18 | Seven themes flip by | Seven themes, English and Spanish. |
| 11 | `outro` | 1:24 | Landing, caption with the URL | 99 + Tax. Live on X1. Try it on testnet free, or launch on mainnet at 99tax.vercel.app. |

End card (add in the editor): **99tax.vercel.app** · github.com/Lokoweb3/x1-reflection-token ·
"Beta. Not audited yet. Not financial advice."

Skip `analytics` in this cut, or add it after `earnings` if the video can run ~95 s.

## Tutorial (~6 min)

Record with `--cut tutorial`: each scene is held about twice as long and its caption is the
full sentence. Read the voiceover below over it. Chapter titles go in the YouTube
description.

**0:00 · What 99 + Tax is** (`hook`)
> 99 + Tax is a launchpad for tax tokens on the X1 blockchain. Every time someone trades
> one of these tokens, a small tax is taken, and that tax is paid out to the people holding
> the token, in XNT, straight to their wallets. The difference from most tax tokens: the tax
> isn't held by the team's wallet. A program on the chain holds it, and it keeps working
> even if this website goes away.

**0:30 · Where the tax goes** (`split`)
> The creator sets the tax, anywhere from 1 to 10 percent, and splits it. At least 35
> percent always goes to holders. Up to half can be added to the pool as permanent
> liquidity: those liquidity tokens are burned, so it can never be pulled. Up to half can
> be burned, so the supply only goes down. And 10 percent is the creator's reward, paid in
> USDC on mainnet and vesting over seven days. Drag the sliders on the home page to see
> what a day of trading would pay.

**1:15 · Launching a token** (`launch`)
> Here's the launch form, on testnet, where XNT is free from the faucet. Name, symbol, a
> logo, and the split. New: "Pay holders in" lets you pay holders in another token instead
> of XNT; the vault swaps their share on XDEX before paying. When you press Launch, your
> wallet approves a few transactions: the token is created with the whole supply, all of
> it goes into an XDEX pool, the pool's liquidity is locked in an NFT that you hold, and
> the mint and freeze authorities are revoked. You start with zero tokens, like everyone
> else.

**2:15 · The bonding curve** (`curve`)
> On testnet you can also launch on a bonding curve. 80 percent of the supply sells on the
> curve, with no tax. When it reaches its target, from 500 to 10,000 XNT, it graduates: the
> other 20 percent and the XNT seed an XDEX pool, the liquidity is locked, and from then on
> its tax runs through the vault like any other token.

**2:45 · The Tax Vault** (`vault`)
> This is a token's page. The Tax Vault panel shows what the vault is doing. It collects
> the tax from every trade, sells it for XNT with a cap on price impact, adds liquidity,
> burns tokens and sends the creator their reward. Then it builds the rewards list: what
> every holder is owed, by balance. The list is pinned to IPFS and its fingerprint stored
> on-chain, and after a ten-minute window the vault pays each wallet exactly its line.
> Recent activity links every step to its transaction.

**3:35 · Anyone can run it** (`run-vault`)
> The site runs the vault every minute, but it doesn't have to be us. Anyone can press
> "Run the vault now": your wallet pays the small network fee, and you earn 1 percent of the
> holders' XNT from each sale, up to 0.05 XNT. The program decides every amount, so whoever
> runs it can't take anything.

**4:05 · The leaderboard** (`leaderboard`)
> The leaderboard works out every holder's average buy price from their trades on XDEX,
> including trades routed through other pools. "Worth now" is your balance at today's
> price. "If sold now" is what selling the whole bag would really return after the token's
> tax and the price impact of the sale itself, which matters for big holders. Rewards
> earned and total return add it all up.

**4:45 · My earnings and analytics** (`earnings`, `analytics`)
> My earnings shows any wallet's holdings across every token, the XNT it has received and
> its lock NFTs with fees and rewards ready to claim. Analytics adds it up across the whole
> platform: XNT paid to holders, tokens burned and liquidity added.

**5:20 · If 99 + Tax disappears** (`recovery`)
> What happens if this site goes offline? The money is on-chain, so nothing is lost. This
> recovery page is one file pinned on IPFS. It talks only to the blockchain and your
> wallet, and lets anyone run every vault. If no new rewards list is published for seven
> days, the token's creator can appoint a new publisher. After thirty days, anyone can pay
> holders from the last list. The code is open source on GitHub.

**5:50 · Wrap-up** (`themes`, `outro`)
> The site comes in seven themes and in English and Spanish. Try everything on testnet
> with free faucet XNT, then launch on mainnet. One last thing: the programs are in beta
> and haven't had a formal audit yet, and nothing here is financial advice. Thanks for
> watching.

## Voiceover and music

- **ElevenLabs, automatically:** `npx tsx scripts/video-voice.ts --voice <voice id>`
  speaks each product line in that voice (key from `ELEVENLABS_API_KEY` or
  `~/.config/elevenlabs/key`, never the repo), holds a scene's last frame when its line runs
  longer, and writes `tour-product-voiced.mp4`. `--music track.mp3` adds music ducked under
  the voice; takes are cached in `voice/`, so re-runs only pay for changed lines
  (`--regenerate` for new takes). Product cut ≈ 1,100 characters of credits.

- **Your own voice:** read the lines over the joined MP4 in any editor (CapCut, DaVinci
  Resolve, iMovie). Each scene is its own MP4, so trimming one to fit a line is easy.
- **Text-to-speech:** paste a scene's lines into any TTS tool and drop each file at its
  scene's start (the `.srt` and `shotlist.json` give the times).
- **Captions:** the recorder burns them in by default. For clean footage plus subtitles,
  record `--no-captions` and upload `tour-<cut>.srt` with the video, or burn it in with the
  `ffmpeg … -vf subtitles=…` line the recorder prints.

## Intro and outro b-roll (optional, AI video)

For an animated open before the screen recording. Prompts for any text-to-video tool:

1. *"A paper receipt printing out of a small thermal printer on a cream desk, the receipt
   reads '99¢ + TAX', warm studio light, macro, slow push-in, 5 seconds."*
2. *"Gold coins flowing from a glowing vault into many small wallets arranged in a circle,
   clean isometric 3D, dark navy background, smooth loop, 5 seconds."*
3. *"A price tag reading '99¢' flips over to reveal 'holders get paid', paper texture,
   playful stop-motion style, 4 seconds."*

Keep claims out of generated footage (no numbers, no "guaranteed"): the screen recording
shows the real figures.

## Keep it accurate

- Show live pages, not mock-ups; the numbers on screen are the chain's.
- Say "beta, not audited yet" once, and "not financial advice", as above.
- Testnet XNT has no value: say "on testnet" whenever the launch or curve scenes are on it.
- Re-record a scene after a site change rather than editing old footage.
