# Video script: how 99 + Tax works

Two cuts of the same story, both recorded from the live site:

- **Product video** (~2 min): what it is and why it's different. For X, the landing page,
  a pitch.
- **Tutorial** (~6 min): the same scenes, explained screen by screen. For YouTube and the
  docs.

**The narration below is the script.** `scripts/video-tour.ts` holds it sentence by
sentence (`NARRATION`) and records from it: each sentence is the caption while it's spoken,
the screen does what the sentence talks about while it's said (typing, scrolling, a
highlight), and the next sentence waits for it to finish. With an ElevenLabs voice the
recording is timed to the real audio, so voice, caption and screen line up. This page is
generated from the same text (`npx tsx scripts/video-tour.ts --print-script`): to change a
line, edit `NARRATION` and re-print.

## Record

```bash
npm i --no-save playwright && npx playwright install chromium   # once; ffmpeg for MP4s and voice
npx tsx scripts/video-tour.ts --voice <ElevenLabs voice id>             # product cut, voiced
npx tsx scripts/video-tour.ts --cut tutorial --voice <id>               # the tutorial
npx tsx scripts/video-tour.ts --vertical --voice <id>                   # 1080x1920 for Shorts / TikTok / Reels
npx tsx scripts/video-tour.ts --voice <id> --music track.mp3            # music ducked under the voice
npx tsx scripts/video-tour.ts --theme arcade --mode dark                # another look
npx tsx scripts/video-tour.ts                                           # no voice: timed for a read-along
```

Out, in `video/out/<cut>/`: `tour-<cut>.mp4` (joined, voiced), one `NN-scene.mp4` per scene,
`script-<cut>.md` (every sentence with the time it's spoken in this recording),
`tour-<cut>.srt` and `shotlist.json`. The ElevenLabs key is read from `ELEVENLABS_API_KEY`
or `~/.config/elevenlabs/key` (never the repo); spoken sentences are cached in
`video/out/voice-cache`, so re-recording only pays for sentences that changed. The product
cut is about 1,300 characters of credits, the tutorial about 5,000.

The recorder only browses public pages: it never connects a wallet or signs anything. The
launch scene types "Demo Coin" into the testnet form and stops before the approvals. The
token shown is the newest mainnet launch and the wallet its biggest holder (`--mint`,
`--wallet` pick others).

Without a voice, sentences are timed at a speaking pace: read them from `script-<cut>.md`
over the video (each line has its time), or record your own and replace the audio.

## Product video narration

Voice: calm, confident, no hype. End card (add in an editor if you like):
**99tax.vercel.app** · github.com/Lokoweb3/x1-reflection-token · "Beta. Not audited yet.
Not financial advice."

**What 99 + Tax is** (`hook`)

> Most tax tokens ask you to trust a wallet.
> 99 + Tax pays holders in real XNT, from a program nobody controls.

**Where the tax goes** (`split`)

> Every trade pays a small tax, from 1 to 10 percent.
> The creator picks the split: holders, permanent liquidity, burn, and a creator reward.

**Launching a token** (`launch`)

> Launching takes one form and a few wallet approvals.
> The whole supply goes into the pool, so there's no dev bag.
> Holders can be paid in XNT, or in a token you choose.
> The liquidity is locked in an NFT, and the tax can never be changed.

**The bonding curve** (`curve`)

> Or start on a bonding curve that graduates to XDEX by itself.

**The Tax Vault** (`vault`)

> The tax goes to the Tax Vault program, not to anyone's wallet.
> It sells the tax for XNT, adds liquidity, burns tokens and pays every holder.
> Every payout list is public on IPFS, and every step is on-chain.

**Anyone can run it** (`run-vault`)

> Anyone can run the vault, and gets paid to.
> No one running it can take a cent.

**The leaderboard** (`leaderboard`)

> Every holder sees their cost, what it's worth, and what they've earned.
> If sold now shows what selling would really return, after the tax and the price impact.

**My earnings** (`earnings`)

> My earnings shows your payouts across every token, in one place.

**Analytics** (`analytics`)

> Analytics adds it all up: XNT paid to holders, tokens burned and liquidity added.

**If 99 + Tax disappears** (`recovery`)

> And if we ever disappear, a recovery page on IPFS keeps every vault running.

**Themes and languages** (`themes`)

> Seven themes, in English and Spanish.

**Try it** (`outro`)

> 99 + Tax. Live on X1.
> Try it free on testnet, or launch on mainnet at 99tax.vercel.app.

## Tutorial narration

**What 99 + Tax is** (`hook`)

> 99 + Tax is a launchpad for tax tokens on the X1 blockchain.
> Every time someone trades one of these tokens, a small tax is taken, and that tax is paid to the people holding the token, in XNT, straight to their wallets.
> The difference from most tax tokens: the tax isn't held by the team's wallet. A program on the chain holds it, and it keeps working even if this website goes away.

**Where the tax goes** (`split`)

> The creator sets the tax, anywhere from 1 to 10 percent, and decides how it splits.
> At least 35 percent always goes to holders. Up to half can be added to the pool as permanent liquidity, and those liquidity tokens are burned, so it can never be pulled.
> Up to half can be burned, so the supply only goes down. And 10 percent is the creator's reward, paid in USDC on mainnet and vesting over seven days.
> Drag the sliders on the home page to see what a day of trading would pay.

**Launching a token** (`launch`)

> Here's the launch form, on testnet, where XNT is free from the faucet. A name, a symbol, a logo, and the split.
> All of the supply goes into an XDEX pool. You start with zero tokens, like everyone else.
> New: Pay holders in lets you pay holders in another token instead of XNT. The vault swaps their share on XDEX before paying.
> When you press Launch, your wallet approves a few transactions: the token is created, the pool's liquidity is locked in an NFT that you hold, and the mint and freeze authorities are revoked.

**The bonding curve** (`curve`)

> On testnet you can also launch on a bonding curve. 80 percent of the supply sells on the curve, with no tax.
> When it reaches its target, from 500 to 10,000 XNT, it graduates: the other 20 percent and the XNT seed an XDEX pool, the liquidity is locked, and from then on its tax runs through the vault like any other token.

**The Tax Vault** (`vault`)

> This is a token's page. The Tax Vault panel shows what the vault is doing.
> It collects the tax from every trade, sells it for XNT with a cap on price impact, adds liquidity, burns tokens and sends the creator their reward.
> Then it builds the rewards list: what every holder is owed, by balance. The list is pinned to IPFS with its fingerprint on-chain, and after a ten-minute window the vault pays each wallet exactly its line.
> Recent activity links every step to its transaction.

**Anyone can run it** (`run-vault`)

> The site runs the vault every minute, but it doesn't have to be us.
> Anyone can press Run the vault now: your wallet pays the small network fee, and you earn 1 percent of the holders' XNT from each sale, up to 0.05 XNT.
> The program decides every amount, so whoever runs it can't take anything.

**The leaderboard** (`leaderboard`)

> The leaderboard works out every holder's average buy price from their trades on XDEX, including trades routed through other pools.
> Worth now is your balance at today's price.
> If sold now is what selling the whole bag would really return, after the token's tax and the price impact of the sale itself. That matters for big holders.
> Rewards earned and total return add it all up.

**My earnings** (`earnings`)

> My earnings shows any wallet's holdings across every token, the XNT it has received, and its lock NFTs with fees and rewards ready to claim.

**Analytics** (`analytics`)

> Analytics adds it up across the whole platform: XNT paid to holders, tokens burned and liquidity added.

**If 99 + Tax disappears** (`recovery`)

> What happens if this site goes offline? The money is on-chain, so nothing is lost.
> This recovery page is one file pinned on IPFS. It talks only to the blockchain and your wallet, and lets anyone run every vault.
> If no new rewards list is published for seven days, the token's creator can appoint a new publisher. After thirty days, anyone can pay holders from the last list.
> And the code is open source on GitHub.

**Themes and languages** (`themes`)

> The site comes in seven themes, in English and in Spanish.

**Try it** (`outro`)

> Try everything on testnet with free faucet XNT, then launch on mainnet at 99tax.vercel.app.
> One last thing: the programs are in beta and haven't had a formal audit yet, and nothing here is financial advice. Thanks for watching.

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
