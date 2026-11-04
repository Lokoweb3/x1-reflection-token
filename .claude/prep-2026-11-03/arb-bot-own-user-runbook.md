# Runbook: arb bot under its own Linux user, `reflect-arb`

Prepared 3 Nov 2026, for you to run in your own terminal, **not through an agent or a `!` command**. Nothing here has been run. No agent has touched the bot.

## Read first: three facts that change the job

1. **The live bot isn't under systemd.** It runs in WSL as `loko`, kept up by `scripts/arb-watchdog.sh`, launched from `arb-autostart.vbs` in your Windows Startup folder. systemd isn't running in this WSL (`/etc/wsl.conf` has only `[user] default=loko`), and `deploy/systemd/reflect-arb-bot.service` belongs to the server. So on this machine, step 6 turns systemd on and step 10 applies it with `wsl --shutdown`, **which ends every WSL process: Claude sessions, `arb-page`, the dashboard, `lp-mcp`.**
2. **A new user alone won't keep agents out on WSL.** Agents run as `loko`, and from there:
   - **`wsl.exe -u root`** gives root with no password while WSL interop is on. It is on: `WSLInterop` is enabled and `wsl.exe` is reachable. I didn't try it. Step 6 turns interop off.
   - **`/mnt/c`** is writable, so an agent could plant a script in your Windows Startup folder that runs at next logon, outside any Linux rule. Step 6 turns the mount off, which also stops Linux tools opening Windows files.
   - **The `docker` group** is root-equivalent when a daemon runs. No socket exists today. Step 6 removes the membership.
   - **Windows itself** can always reach into WSL. Anything running as your Windows user can still become root.
   - **SSH to the server:** `~/.ssh/id_rsa` had no passphrase on 3 Nov, which is how an agent reached the server as root. It has one now. Step 0 covers what's left.
   So this raises the bar a long way but is not a hard boundary.
3. **I found only one copy of the wallet under its name:** `arb.keypair.json`. `~/backups` holds no file with that name. Step 1 is not optional.

Other findings used below:
- `/usr/bin/node` is v18; the bot runs on nvm v22.20.0, so the unit carries its own copy.
- `src/arb-page.ts` reads the bot's state as `loko`. Step 5 gives it read access.
- `arb.sh` merges `ARB_FAST_ARGS` and `ARB_LANE_ARGS` at start, so the unit needs the merged result. After this, `arb.sh fast` and `arb.sh lane` no longer do anything: edit the env file instead.
- The running bot has `TELEGRAM_BOT_TOKEN` but no `TELEGRAM_CHAT_ID` and no `--telegram-*` flag, so it isn't sending Telegram alerts today. Nothing needs copying for that. If you want them, add both to the env file by hand.
- The bot's code is your uncommitted `limit-buy-range` work (`dc947ea` plus edits). Step 3 copies that exact tree, so **this doesn't change bot behaviour.**

Keep the window short: **the bot isn't trading from step 8 to step 11.**

Set these in that terminal:
```bash
REPO=~/X1_PROJECTS/REFLECTION_TOKEN
BASE=/opt/reflect-arb
```

## Part A: bot keeps running

### 0. Take agent access off the server key
First check what else uses this key, because automation here will stop working once it needs a passphrase. Best: move it off WSL entirely, to a hardware key or Windows-side SSH, and delete it here. Quick version:
```bash
ssh-keygen -p -f ~/.ssh/id_rsa       # already done, by a 3 Nov check; skip unless it's been removed
ssh -o BatchMode=yes -o ConnectTimeout=10 root@64.225.61.191 true; echo "exit $?"     # must fail, exit 255
```
Don't load it into a long-lived `ssh-agent`: any process running as `loko` can use that agent. Server access then means typing the passphrase each time.

### 1. Back up the wallet, off WSL
Encrypted, somewhere an agent can't read: a hardware drive or a password manager. Then check the public key, which reveals nothing secret:
```bash
solana-keygen pubkey $REPO/arb.keypair.json     # write this down: WALLET
```
Confirm you can restore the backup and get the same public key. **Stop here until you can.**

### 2. Create the user
```bash
sudo apt-get install -y acl
sudo useradd --system --home-dir $BASE --shell /usr/sbin/nologin --user-group reflect-arb
sudo install -d -o root -g root -m 755 $BASE $BASE/app
sudo install -d -o reflect-arb -g reflect-arb -m 700 $BASE/keys
sudo install -d -o reflect-arb -g reflect-arb -m 750 $BASE/state
```

### 3. Copy the runtime and the exact code
Root-owned, so the bot can't change its own code:
```bash
sudo rsync -a --delete ~/.nvm/versions/node/v22.20.0/ $BASE/node/
sudo rsync -a --delete \
  --exclude /.git --exclude /.claude --exclude /state --exclude /mainnet --exclude /factory --exclude /target \
  --exclude '*keypair*.json' --exclude '/config.json*' --exclude '/.env*' --exclude /lp-locker \
  $REPO/ $BASE/app/
sudo chown -R root:root $BASE/node $BASE/app
sudo find $BASE/app -name '*keypair*.json' -print     # must print nothing
sudo ls $BASE/app/src/factory | wc -l             # 13 or more
$BASE/node/bin/node -v                            # v22.20.0
```

### 4. Build the root-owned env file
This reproduces what `arb.sh` passes today, and prints only flag names and variable names:
```bash
cd $REPO
ARGS=$(bash -c 'eval "$(sed -n "/^TEST=/,/^\[\[ -n \$ARB_LANE_ARGS/p" scripts/arb.sh)"; printf "%s" "$ARB_BOT_ARGS"')
ARGS=${ARGS//.\/arb.keypair.json/$BASE/keys/arb.keypair.json}
printf 'ARB_BOT_ARGS="%s"\n' "$ARGS" | sudo install -o root -g reflect-arb -m 640 /dev/stdin /etc/reflect-arb-bot.env
sudo stat -c '%a %U %G %n' /etc/reflect-arb-bot.env    # 640 root reflect-arb

# Compare with the running bot. These must match, apart from the --keypair path:
diff <(tr '\0' '\n' < /proc/$(pgrep -f '[n]ode --require.*scripts/arb-bot.ts' | head -1)/cmdline | sed -n '/scripts\/arb-bot.ts/,$p' | grep '^--') \
     <(printf '%s\n' $ARGS | grep '^--') && echo "flags match"

# Anything else in arb.env the bot would lose? Names only:
grep -oE '^(export +)?[A-Za-z_][A-Za-z0-9_]*=' state/arb.env | sort -u
```
The list normally shows `ARB_BOT_ARGS`, `ARB_FAST_ARGS`, `ARB_LANE_ARGS` and `ARB_SCAN_ARGS`. **Add anything else the bot reads to the env file by hand.** If the flags don't match, stop and find out why: the bot may have been started by hand.

The env file holds no `export`, and systemd reads it as root. Only root and the `reflect-arb` group can read it.

### 5. Write the unit, not started
```bash
sudo tee /etc/systemd/system/reflect-arb-bot.service >/dev/null <<UNIT
[Unit]
Description=Arb bot for TEST and GOOGL.X pools, under its own user
After=network-online.target
Wants=network-online.target
# Won't start until the wallet has been moved (step 9)
ConditionPathExists=$BASE/keys/arb.keypair.json

[Service]
User=reflect-arb
Group=reflect-arb
WorkingDirectory=$BASE/app
EnvironmentFile=/etc/reflect-arb-bot.env
Environment=REFLECT_STATE_DIR=$BASE/state
Environment=HOME=$BASE/state
ExecStart=/bin/sh -c 'exec $BASE/node/bin/node node_modules/tsx/dist/cli.mjs scripts/arb-bot.ts \$ARB_BOT_ARGS'
StandardOutput=append:$BASE/state/arb-bot.log
StandardError=append:$BASE/state/arb-bot.log
Restart=always
RestartSec=15
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$BASE/state
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
```
**Don't enable it yet.** `ProtectHome=true` hides `/home/loko` from the bot, which tests that nothing depends on your home. If it fails with a network or path error, the first thing to try is adding `AF_NETLINK`.

### 6. Close the WSL escape routes (takes effect at step 10)
```bash
sudo tee /etc/wsl.conf >/dev/null <<'CONF'
[boot]
systemd=true

[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=false

[user]
default=loko
CONF
sudo gpasswd -d loko docker
```
**The cost:** no `/mnt/c`, no `code .`, `explorer.exe` or `clip.exe` from Linux, and Docker needs `sudo`. If you want `/mnt/c` back, you reopen the Startup folder route. That's your call; I'd keep it off.

Any of your projects under `/mnt/c`? Move them first. Long-running sessions under `/mnt/c/Users/lokot` will stop working.

**On Windows, replace `arb-autostart.vbs`** in your Startup folder, because systemd services don't keep WSL running and the old loop launches the watchdog. Keep a copy of the old one:
```vbs
' Keeps WSL running, so the reflect-arb-bot service stays up.
Set sh = CreateObject("WScript.Shell")
Do
  sh.Run "wsl.exe -d Ubuntu -- sleep infinity", 0, True
  WScript.Sleep 30000
Loop
```

## Part B: cutover

### 7. Prepare the window
Pick a quiet moment, and close Claude sessions yourself. **On Windows, end the old `wscript.exe` loop** (Task Manager) so it can't relaunch the watchdog.

### 8. Stop the bot, the supported way
**Never `pkill` it.** `arb.sh stop` leaves `state/arb-bot.stopped`, which also stops the watchdog from starting a second copy.
```bash
cd $REPO
scripts/arb.sh stop bot
sleep 5
ps -eo pid,args | grep '[a]rb-bot.ts'      # must print nothing; if it prints, the pid file was stale: stop and sort that out, never run two
ls state/arb-bot.stopped                   # must exist
pkill -f scripts/arb-watchdog.sh; ps -eo pid,args | grep '[a]rb-watchdog'   # must print nothing
```
Check for unfinished trades. Names of files mentioning pending items:
```bash
grep -l '"pending' state/peg-*.json state/limit-orders.json state/*bridge* 2>/dev/null
```
If any appear, read them and resolve them before going on. A signed trade whose result is unknown must not be forgotten.

### 9. Move the state and the wallet
State moves whole, so journals and fee counters carry on. The env file and the old markers don't go with it.
```bash
sudo rsync -a --exclude arb.env --exclude 'arb-bot.pid' --exclude 'arb-bot.stopped' --exclude 'arb-scan.*' $REPO/state/ $BASE/state/
sudo chown -R reflect-arb:reflect-arb $BASE/state
sudo chmod -R u=rwX,g=rX,o= $BASE/state
sudo install -o reflect-arb -g reflect-arb -m 400 $REPO/arb.keypair.json $BASE/keys/arb.keypair.json
sudo -u reflect-arb $BASE/node/bin/node -e "require('fs').readFileSync('$BASE/keys/arb.keypair.json'); console.log('readable by reflect-arb')"
solana-keygen pubkey <(sudo cat $BASE/keys/arb.keypair.json)   # must equal WALLET

# arb-page reads the bot's trade files as loko. Read only:
sudo setfacl -m u:loko:rx $BASE $BASE/state
sudo setfacl -d -m u:loko:r-X $BASE/state
sudo setfacl -R -m u:loko:r-X $BASE/state
ls $BASE/keys 2>&1 | head -1                    # as loko: must say Permission denied
```
Keep `state/arb.env` and the old key until step 13. `state/arb-bot.stopped` stays in the old folder, so nothing there can start the bot.

### 10. Shut WSL down, from Windows
```powershell
wsl --shutdown
```
Wait 10 seconds. **Then double-click the new `arb-autostart.vbs`** once, because nothing else will keep WSL up until your next logon. Open your terminal.
```bash
REPO=~/X1_PROJECTS/REFLECTION_TOKEN; BASE=/opt/reflect-arb
ps -p 1 -o comm=                    # systemd
systemctl is-system-running         # running, or degraded
ls /mnt/c 2>&1 | head -1            # No such file or directory
id -nG | grep -c docker             # 0
```
If systemd didn't come up, stop: see Rollback.

### 11. Start the bot under its own user
**Exactly this order, and one bot only.**
```bash
ps -eo pid,args | grep '[a]rb-bot.ts'                # must print nothing
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/reflect-arb-bot.service
sudo systemctl start reflect-arb-bot
sleep 20
sudo systemctl is-active reflect-arb-bot
ps -eo user,pid,args | grep '[a]rb-bot.ts' | cut -c1-90      # one node process tree, user reflect-arb
tail -n 25 /opt/reflect-arb/state/arb-bot.log
```
**Enable at boot only after it looks healthy:** `sudo systemctl enable reflect-arb-bot`.

Then start `arb-page` with the new state folder:
```bash
cd $REPO && REFLECT_STATE_DIR=/opt/reflect-arb/state npx tsx src/arb-page.ts
```
Its bot-running check reads a pid file that no longer exists and can't signal another user's process, so it may show the bot as stopped, and its fast-settings line goes blank without `arb.env`. Trades and logs still show. A small code change would fix this later.

### 12. Health checks
Over the first hour:
- Exactly one bot, as `reflect-arb`. `systemctl status` shows no restarts.
- The log shows the usual startup and balance lines, then scans.
- Trades append to `/opt/reflect-arb/state/arb-trades.jsonl`, and the wallet's on-chain activity matches WALLET.
- **As `loko`, these must all fail:**
  ```bash
  cat /opt/reflect-arb/keys/arb.keypair.json
  cat /etc/reflect-arb-bot.env
  tr '\0' '\n' < /proc/$(pgrep -u reflect-arb -n node)/environ
  command -v wsl.exe
  ```

### 13. Remove the old copies: at least 24 hours later
Only when the bot is healthy and the backup from step 1 has been restored successfully once.
```bash
shred -u $REPO/arb.keypair.json
shred -u $REPO/state/arb.env
sudo find ~ -xdev -name '*arb*keypair*' -not -path '*/node_modules/*'    # review
```
Leave `state/arb-bot.stopped` in place.

## Rollback
**Before step 10.** Still on the old setup:
```bash
cd $REPO; sudo rsync -a --exclude keys $BASE/state/ state/ 2>/dev/null; sudo chown -R loko:loko state
scripts/arb.sh start bot      # also clears the stopped marker
```
Restore the old `.vbs`, and start the watchdog.

**After step 10, or if the service fails:**
```bash
sudo systemctl stop reflect-arb-bot; sudo systemctl disable reflect-arb-bot
ps -eo pid,args | grep '[a]rb-bot.ts'                       # must print nothing
sudo rsync -a --exclude arb-bot.log $BASE/state/ $REPO/state/   # newest journals come back
sudo chown -R loko:loko $REPO/state
cd $REPO && scripts/arb.sh start bot
ps -eo pid,args | grep -c '[a]rb-bot.ts'                    # a single bot tree
```
- **Copy the state back**, or fee counters and open-trade journals go stale.
- **The `.vbs` to restore is the corrected one,** saved as `arb-autostart.rollback.vbs`. An older copy naming `steven` won't work:
  ```vbs
  ' Keeps the arb bot up on this Windows machine: copy into the Startup folder (Win+R, shell:startup).
  ' At logon it starts WSL (hidden) running scripts/arb-watchdog.sh, which starts the bot; if WSL shuts
  ' down (wsl --shutdown, an update, a crash) it starts it again 30 seconds later.
  Set sh = CreateObject("WScript.Shell")
  Do
    sh.Run "wsl.exe -d Ubuntu -u loko -- /home/loko/X1_PROJECTS/REFLECTION_TOKEN/scripts/arb-watchdog.sh", 0, True
    WScript.Sleep 30000
  Loop
  ```
- **Never run both.** Two bots on one wallet race each other and waste fees.
- **After step 13,** the old key is gone: restore it from your step 1 backup first.
- To undo WSL changes: put `/etc/wsl.conf` back to just `[user]` / `default=loko` (don't delete it), `sudo usermod -aG docker loko`, restore the `.vbs`, then `wsl --shutdown`.

## Things that change for you afterwards
| Before | After |
|---|---|
| `scripts/arb.sh stop` / `start` | `sudo systemctl stop` / `start reflect-arb-bot` |
| Edit `state/arb.env` | `sudo editor /etc/reflect-arb-bot.env`, then restart |
| `arb.sh fast` / `lane` | Edit `ARB_BOT_ARGS` |
| `arb.sh logs` | `tail -f /opt/reflect-arb/state/arb-bot.log` |
| Code changes live on restart | Repeat step 3's code copy, then restart |
| `--sweep`, `--close-dust` by hand | `sudo -u reflect-arb` with the same env and working folder |

## Stronger option
Run the bot on the server instead: `deploy/systemd/reflect-arb-bot.service` already exists, and there's no `wsl.exe` or `/mnt/c`. **This is a boundary only after step 0.** The same steps apply, with `User=reflect-arb` and `/etc/reflect-arb-bot.env`; skip steps 6 and 10. Check first:
- No arb runs on the server today (checked 3 Nov), so stop the WSL bot first. **One wallet, one bot.**
- Latency: the bot's speed against rival bots may differ there.
- The server's Node version, and the same uncommitted code.

## Not verified
Nothing here has run on a real system. I tested the step 4 argument builder against a fake `arb.env` (fast and lane merging, the keypair swap), ran `systemd-analyze verify` on the unit, and ran a scratch copy made with step 3's excludes with an empty environment and no keys: `arb-bot.ts` loaded and stopped at "--keypair is required". That only proves its imports resolve. Specifically unproven: trading from the copy, the hardened unit under WSL's systemd, `wsl.conf` behaviour on your Windows version, and what `state/arb.env` holds, since I'm not allowed to read it.
