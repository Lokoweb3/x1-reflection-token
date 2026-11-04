# Exposed tokens: not rotated or revoked

**What happened:** on 3 Nov, about 1:00 to 1:36 AM ET, third-party build scripts for the Lombard reproduction ran with network on and could read the inherited environment. No misuse seen; it can't be ruled out. That the agent's shell held these exact variables is inferred: they're in mine, and `sbox.sh` didn't clear them.

**Correction:** `~/.nvm/.npmrc` holds no credential (`package-lock` only), and `npm whoami` reports not logged in. `~/.cargo` holds no credentials file. Neither needs action.

| Token | Provider | Stored | Used by | Still active? | Permission | Immediate privileged access? |
|---|---|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram, bot `X1_AI_clawd_bot` | `~/.bashrc`; server env files unknown | `arb-bot`, `arb-scan`, `gap-monitor`; a server unit may use it | **Yes**, `getMe` succeeded; no webhook | Send as the bot, read messages sent to it, change its webhook | **Yes for the bot**: fake alerts, read its messages. **Not funds** |
| `CLAUDE_CODE_MESSAGING_TOKEN` | Claude Code (internal) | Session environment; not in `.bashrc` | Claude Code sessions | Not tested, deliberately | Scope unknown. May let a holder message local sessions | **Unknown: treat as high.** Agent sessions can act on messages. Likely local socket only, which isn't verified |
| `LP_BLOCKSCOUT_KEY` | Blockscout PRO (`proapi_` format) | `~/.bashrc` | `~/uniswap-collector` (`blockscout.js`, `basis.js`), and running `lp-mcp` processes inherit it | Unclear: my one call returned 403 and may be the wrong call | Read-only data, quota | No |
| `X1_NINJA_API_KEY` | x1.ninja | `~/.bashrc` | No code use found in `~/X1_PROJECTS` or `~/uniswap-collector` | Unclear: 401 with two header styles; may be expired or use another format | API data | No, as far as known |

**My checks sent each of the first, third and fourth values to its own provider over HTTPS, and I printed none.** Telegram and x1.ninja requests may appear in their logs. The Blockscout key went in a URL query string.

## Sequence, when you approve
**Order:** messaging token, then Telegram, then Blockscout, then x1.ninja.

**Telegram**
1. BotFather `/revoke` gives a new token and kills the old one at once, so have a window ready: there's no overlap.
2. Update `~/.bashrc`, and on the server any `/etc/reflect-*.env` naming it (check by name only). Check `state/arb.env` too, which I didn't read.
3. **Running processes keep the old token until restarted, so the arb bot's alerts fail until its next restart.** You decide when: I won't restart it. Trading itself shouldn't depend on this, from reading; verify `scripts/arb-bot.ts` first.
4. Verify: `getMe` with the new token, then one test alert per service.

**Blockscout**
1. Create a new key at dev.blockscout.com, and update `~/.bashrc`.
2. Restart `~/uniswap-collector` processes in your window.
3. Verify a real lookup, then delete the old key. Overlap is possible here.

**x1.ninja**
Check its dashboard. If unused, revoke and remove it from `.bashrc`.

**`CLAUDE_CODE_MESSAGING_TOKEN`**
No provider console is known. End and restart sessions; check whether the value changes. Ask Anthropic support if it doesn't.

**Afterwards:** move secrets out of `~/.bashrc`, so every shell and child process stops inheriting them. Keep `--clearenv` in sandboxes.
