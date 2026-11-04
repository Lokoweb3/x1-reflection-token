# Restart order, 3 Nov 2026. Nothing here has been run. The owner runs every step; agents never restart anything.

Written on the server, not loaded yet: `/etc/systemd/system/reflect-gap-monitor.service.d/tokens.conf`.

| # | Window | Machine | Action | Needs first |
|---|---|---|---|---|
| 1 | Your window | Server | `systemctl daemon-reload`, then `systemctl restart reflect-gap-monitor`; check `is-active` and `journalctl -u reflect-gap-monitor -n 20` | `TELEGRAM_CHAT_ID` in `/etc/reflect-gap-monitor.env` |
| 2 | Your own | WSL | `arb-bot-own-user-runbook.md`, steps 1 to 12, including `wsl --shutdown` | Wallet backup restored once; no agents running |
| 3 | 24 h after 2 | WSL | Runbook step 13: shred the old key and `arb.env` | Bot healthy |
| 4 | Just after a list goes live | Server | `reflect-mainnet-factory`: fast-forward to the exact SHA, `npm ci`, restart this unit only | PRs merged; `package-lock.json` edit resolved |
| 5 | 1 day after 4 | Server | `reflect-mainnet-factory-distributor`, then `reflect-factory`, one at a time | Step 4 holds |
| 6 | Separate | Server | Hardened units from #24 | Keep existing drop-ins |

Each step stands alone: stop at any failure without touching the next. Never do steps 2 and 4 in the same window, or a stop in TEST's sales can't be traced to one cause.

**Never on the server:** `reflect-arb-bot` or `reflect-arb-scan`. Neither is installed. #24's rollout loop skips inactive units, but don't copy those unit files in. One wallet, one bot.

**Leave alone:** `reflect-factory-distributor`, already failed. Investigate separately.

Rollback for step 1: remove the drop-in, `daemon-reload`, restart the unit.
