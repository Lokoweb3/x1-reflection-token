---
name: x1-token-launchpad
description: Launch a tax token on the X1 blockchain through the 99 + Tax launchpad ({{SITE}}), or check and finish a launch already started. Use when someone asks an agent to create, launch or deploy a token on X1 or on 99 + Tax.
---

# 99 + Tax token launchpad (X1)

This site ({{SITE}}, X1 {{NETWORK}}) launches Token-2022 tax tokens. Every transfer pays a tax (1–10%) that is split between the token's holders (paid in XNT), its liquidity, an optional burn and the creator (10%). A launch is four or five transactions that the person's wallet signs: create the token, create its XDEX pool, lock the pool's liquidity, start the tax vault (vault launches), then register.

The script `launch.mjs` does all of it with a local keypair file. The key never leaves the machine: the site builds each transaction, the script signs it locally and sends the signed transaction back.

## Choose the network

- Mainnet: https://99tax.vercel.app (real funds).
- Testnet: https://99tax-testnet.vercel.app (test funds; faucet at /faucet).

Use the selected site's /skill.md, /agents/reference.md and /agents/launch.mjs. Pass that same base URL as `--site` for check, launch, resume and status. Read `/api/info` and confirm its `network` agrees with the selected site before signing. Never switch networks to get around a failed step; a resumed mint belongs to its original network.

## Rules

1. **Never launch without the person's explicit go-ahead** on the exact settings and cost. A launch spends real money (on mainnet), and the tax rate and a forever lock can never be changed. Always run the check (no `--live`) first and show its output.
2. **Never print, upload or paste the keypair's contents.** Only pass its file path to the script.
3. Start on **testnet** when the person is trying things out (`--site https://99tax-testnet.vercel.app`; free coins at its `/faucet`).
4. If a step fails, don't start a new launch: rerun with `--resume <mint>` to continue the same one.
5. Pass `--max-cost <XNT>` when the person gave a budget.

## Steps

1. Set up once, in an empty folder:
   ```
   curl -O {{SITE}}/agents/launch.mjs
   npm i @solana/web3.js@1
   ```
2. Collect the settings. Ask for anything missing; suggest the defaults in brackets:
   - name (≤ 32 chars), symbol (≤ 10, letters/digits), description [none], logo URL [none; https:// or ipfs:// PNG/JPG/WebP/GIF]
   - supply in whole tokens (1,000–10,000,000,000). All of it goes into the pool; the creator starts with none.
   - tax % (1–10) [5]; liquidity share of the tax % [25]; burn share % [0]. Liquidity + burn ≤ 55%.
   - pool size in XNT (≥ 0.01): sets the starting price, supply ÷ pool XNT tokens per XNT
   - lock: `forever` [default] or a number of days. Forever means the liquidity can never be withdrawn.
   - website / X / Telegram links [none]
   - the keypair file to sign with (Solana CLI JSON format)
3. Check (sends nothing):
   ```
   node launch.mjs --site {{SITE}} --keypair <wallet.json> --name "<name>" --symbol <SYM> --supply <n> --tax <pct> --pool <xnt> --lock forever
   ```
   It prints the settings, the total cost (launch fee, pool XNT, XDEX's pool fee, network fees) and the wallet's balances, and stops with an error if anything is wrong or short.
4. Show that output to the person and ask for a clear yes.
5. Launch: the same command plus `--live`. It prints each step's transaction, the mint address and the token's explorer link. It takes about a minute.
   ```
   node launch.mjs --site {{SITE}} --keypair <wallet.json> --name "<name>" --symbol <SYM> --supply <n> --tax <pct> --pool <xnt> --lock forever --live
   ```
6. Report the mint and links. Status of this wallet's launches:
   ```
   node launch.mjs --site {{SITE}} --keypair <wallet.json> --status
   ```

## If something fails

- The error printed is the site's own message (e.g. `Invalid symbol`, `Pool XNT must be at least 0.01`, or that the wallet is short). Fix the input and check again.
- Failed after step 1? Note the printed mint and continue it on the **same** site. Each step is skipped once it's done, and nothing is charged twice:
  ```
  node launch.mjs --site {{SITE}} --keypair <wallet.json> --resume <mint> --live
  ```
- `reports mainnet, expected testnet` (or the reverse): the site isn't on the network you meant. Stop and check the URL; don't switch networks.
- Rate limits: up to 10 launches per hour from one IP address.

The site's HTTP API, step by step and with its error responses, is in [reference.md]({{SITE}}/agents/reference.md), and as an OpenAPI 3.0 file in [openapi.yaml]({{SITE}}/agents/openapi.yaml). Use them if you can't run Node or want to sign another way.
