# Ledger test on X1 testnet: quorum-action.ts

For the owner, with the real device. Testnet only, on a throwaway multisig that nothing else uses. It's about 45 minutes.

**Why it's needed:** the tool has only ever signed through a software stand-in. Nothing has been run against a real Ledger. Until this sheet passes, don't count on site + backup.

**Marks used below**
- **[RUN]**: seen in the rehearsal on a local validator, with the stand-in.
- **[UNVERIFIED]**: from memory or from reading Ledger's code. This test is what checks it. If the device differs, write down what it did: that's a finding, not your mistake.

Stop and report if a command that should send something sends something else, if a hash doesn't match, or if anything mentions mainnet.

## 1. Before you start

**Code:** the `quorum-ledger` branch, in its own worktree.

```bash
cd /home/loko/X1_PROJECTS/REFLECTION_TOKEN-quorum-ledger
git log --oneline -1      # note this SHA for the report
npm ci
```

**Where to run it.** The tool needs to see the Ledger over USB. This machine is WSL2, which can't see USB devices by default. Either way is fine; say which you used:
- **WSL2 with usbipd-win [UNVERIFIED]:** in an admin PowerShell, `usbipd list`, `usbipd bind --busid <id>`, then `usbipd attach --wsl --busid <id> --auto-attach`. The device may change USB identity when you open an app, which is why `--auto-attach` is there. Inside WSL you may also need Ledger's udev rules, or `sudo`-level access to the USB node.
- **A normal Linux or Windows machine with Node 22.** Linux needs Ledger's udev rules [UNVERIFIED on this tool].

If it says "no Ledger found" with the device attached and unlocked, run `ls /dev/hidraw* /dev/bus/usb/*/*` and report the result along with what you tried.

**Close Ledger Live and any browser wallet** while testing. They can hold the device.

**Device [UNVERIFIED for all of this]:**
- Firmware and Solana app up to date. Note the model and both versions.
- Leave **blind signing off** to begin with. Step 6 tests what happens. On Nano models the setting is, from memory, in the Solana app under Settings ("Allow blind signing"); Stax and Flex may differ.
- Use the derivation path you intend for the real backup. This sheet uses `usb://ledger?key=0/0`, which is `m/44'/501'/0'/0'`. Change it everywhere if yours differs.

A signature made here can't be replayed on mainnet: it covers a testnet blockhash and a throwaway multisig's accounts.

## 2. How much testnet XNT

| Key | Fund with | Spent on | Basis |
|---|---|---|---|
| Throwaway site key | 0.1 XNT | Multisig rent and fees, about 0.0025; about 0.0057 rent per proposal (6 proposals); its own votes | [RUN] for rent, on a local validator with the same rent formula |
| Throwaway co-signer | 0.01 XNT | Two votes | |
| Ledger key | 0.02 XNT | About 0.00015 a vote or cancel, up to 0.0005 an execute; no rent | Formula from rehearsed CU; the real figures are one of the things to report |

Total about 0.13 XNT. The Ledger address is on testnet only for this test; send from your usual testnet wallet.

## 3. Setup

Keys are generated in a temp folder outside the repo. Don't use any real key here, for site or co-signer.

On this WSL machine `solana-keygen` isn't on the Linux PATH (only the Windows `.exe`), and `active_release` points at another user's home, so name a Linux install directly. 3.1.15 is the one the rehearsal used:

```bash
export PATH=~/.local/share/solana/install/releases/stable-40a31afec617906273511e2936ad098a9b52b39c/solana-release/bin:$PATH
export T=$(mktemp -d /tmp/ledgertest.XXXX); chmod 700 $T
solana-keygen new --no-bip39-passphrase -s -o $T/site.json
solana-keygen new --no-bip39-passphrase -s -o $T/cosigner.json
chmod 600 $T/*.json
export SITE=$(solana-keygen pubkey $T/site.json) COSIGNER=$(solana-keygen pubkey $T/cosigner.json)
alias qa='npx tsx scripts/quorum-action.ts'
```

### Step 1: no device attached

```bash
qa ledger-address --ledger "usb://ledger?key=0/0"; echo "exit $?"
```
**Expect:** `REFUSED: no Ledger found...`, exit 1. [RUN]

### Step 2: read the address, and check it on the device

Plug in, unlock, open the Solana app.

```bash
qa ledger-address --ledger "usb://ledger?key=0/0"
```
**Expect:** it prints the path and address, then asks you to check it on the device. The device shows an address and asks you to confirm [UNVERIFIED].

**Compare:** the address on the screen against the one printed, every character. If you have the Solana CLI, also `solana-keygen pubkey "usb://ledger?key=0/0"`: this should match too, which confirms the path means what the CLI means by it [UNVERIFIED].

```bash
export LEDGER=<the address>
export L="--ledger usb://ledger?key=0/0 --signer-pubkey $LEDGER"
```
Quote it if your shell objects to the `?`.

### Step 3: fund, and create the multisig

Send the XNT from section 2 to `$SITE`, `$COSIGNER` and `$LEDGER`. Then:

```bash
npx tsx scripts/setup-publisher-quorum.ts --rpc https://rpc.testnet.x1.xyz --network testnet --keypair $T/site.json \
  --create-key $T/create.json --site $SITE --cosigner $COSIGNER --backup $LEDGER         # dry run: read it
npx tsx scripts/setup-publisher-quorum.ts --rpc https://rpc.testnet.x1.xyz --network testnet --keypair $T/site.json \
  --create-key $T/create.json --site $SITE --cosigner $COSIGNER --backup $LEDGER --execute

export MS=<the multisig address it printed>
export N="--network testnet --multisig $MS"
qa status $N
```
**Expect:** threshold 2 of 3, and three members. `$LEDGER` has initiate, vote and execute.

## 4. The test

### Step 4: a proposal, from the site's key file

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 1" --execute
```
**Expect:** `#1`, with one approval (the site's). Note the `sha256` and `message hash` it prints.

### Step 5: dry run with the device unplugged

Unplug it. This one needs no device and no secret.

```bash
qa approve $N --signer-pubkey $LEDGER --index 1; echo "exit $?"
qa approve $N $L --index 1; echo "exit $?"
```
**Expect:** both exit 0, say `touches no device and no secret`, `simulation OK` and `nothing was signed or sent`. `qa status $N --index 1` still shows 1 of 2. [RUN]

Plug it back in, unlock it, open the Solana app.

### Step 6: blind signing off

With the setting **off**:

```bash
qa approve $N $L --index 1 --execute; echo "exit $?"
```
Read the `signer` line: it reports the app version and whether blind signing reads as on or off.

**Expect, one of:**
- The tool says `the Solana app refuses to blind-sign (status 0x6808)...`, exit 1, nothing sent. This is what Ledger's own code suggests [UNVERIFIED].
- The device shows a prompt anyway. Then **reject it on the device**, note what the screen showed, and carry on.

Then **turn blind signing on**.

### Step 7: the real vote

```bash
qa approve $N $L --index 1 --execute; echo "exit $?"
```
The tool prints an `ON THE DEVICE` block: the decoded memo, the key, the blockhash, and `MESSAGE HASH <base58>`.

**The device should show** a blind-signing warning and a message hash, then confirm and reject options [UNVERIFIED: the exact screens, the wording, and whether a fee payer also appears are all from memory].

**Compare, before confirming:** the hash on the device against the `MESSAGE HASH` line, every character. The tool computes base58 of the sha256 of the message, which is what the app is understood to show [UNVERIFIED]. **If they don't match, reject on the device and report it.** That's the most important result on this sheet. It doesn't necessarily mean an attack: it may only mean the app hashes something else.

Confirm on the device.

**Expect:**
- `the signature verifies against this message and <address>`
- `checked again after the signature: the proposal, stored transaction and multisig are as they were`
- `CONFIRMED: approve #1, signature ...`
- `read back: #1 Approved: 2 of 2 approvals`
- exit 0

Note the seconds you took, and the line `this key's balance moved ... XNT`: that's the real fee.

### Step 8: execute, from the device

```bash
qa execute $N $L --index 1 --execute; echo "exit $?"
```
Compare the hash again and confirm.

**Expect:** `the vault PDA signed: the memo program logged "Signed by ..."`, then `Executed` on `qa status $N --index 1`. Note the fee.

### Step 9: a rejection on the device

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 2" --execute
qa approve $N $L --index 2 --execute; echo "exit $?"
```
**Reject on the device.**

**Expect:** `REFUSED: rejected on the device (status 0x6985)...`, exit 1. `qa status $N --index 2` still shows 1 of 2, and the Ledger's balance is unchanged. Report the status it printed: `0x6985` is from Ledger's code [UNVERIFIED].

### Step 10: too slow on purpose, past the blockhash's expiry

Have a timer ready. A blockhash lasted about 53 s in one sample per network (149-150 blocks at 353-362 ms, 2026-11-03), and the tool stops about 5 s before that.

```bash
qa approve $N $L --index 2 --execute; echo "exit $?"
```
1. Note the first `MESSAGE HASH`. **Wait 70 seconds** with the prompt on the screen, then confirm. If the device times out or locks itself first, report that.
2. **Expect:** `signed, but too late: ... That signature is dropped, never sent, and can't land`, then `prompt 2 of at most 3: the SAME action again, with a new blockhash`, and a **different** hash.
3. **Compare** the new hash on the device with the new line. Confirm promptly.
4. **Expect:** one `CONFIRMED: approve #2`, followed by `that's ONE action, not 2: ...`, exit 0.

**Then check:**
- `qa status $N --index 2` is Approved, with exactly one `approved by` line for `$LEDGER`.
- The Ledger's balance fell by one fee, not two.

Finish it from the site's key:
```bash
qa execute $N --keypair $T/site.json --index 2 --execute
```

Also note how many seconds the tool's `Confirm within about ... s` line promised, and whether that felt right.

### Step 10b: something changes during a prompt

The tool reads everything again after each signature, and any difference stops it. You need a second terminal with the same `export`s and the alias.

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 2b" --execute     # note its index, n
qa approve $N $L --index <n> --execute; echo "exit $?"                          # first terminal: leave the prompt up
qa approve $N --keypair $T/cosigner.json --index <n> --execute                  # second terminal
```
When the second terminal shows `#<n>` Approved, confirm on the device.

**Expect:** `REFUSED: checked again after the device was asked: #<n> is Approved: only an Active proposal takes votes...`, `Nothing was sent`, exit 1. `qa status $N --index <n>` has no `approved by` line for `$LEDGER`, and the Ledger's balance is unchanged. [RUN]

Finish it from the site's key: `qa execute $N --keypair $T/site.json --index <n> --execute`.

From here the indexes on this sheet are one higher: step 11's `#3` is `#4`, step 12's `#4` is `#5`, and step 13's `#5` is `#6`.

### Step 11: a rejection vote, on-chain

This is a real vote against, unlike step 9.

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 3" --execute
qa reject $N $L --index 3 --memo "test" --execute; echo "exit $?"
qa status $N --index 3
```
**Expect:** the Ledger's rejection counted, `#3` still Active, with the site's approval standing: `1 of 2 rejections`. Then close it with the site changing its vote:

```bash
qa reject $N --keypair $T/site.json --index 3 --execute
```
**Expect:** `#3 is Rejected`.

### Step 12: a cancel

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 4" --execute
qa approve $N --keypair $T/cosigner.json --index 4 --execute
qa cancel $N $L --index 4 --execute; echo "exit $?"
qa cancel $N --keypair $T/site.json --index 4 --execute
```
**Expect:** after the Ledger's cancel, `still Approved, NOT cleared`; after the site's, `#4 is Cancelled`.

### Step 13: refusals and device states

Use one more proposal. **None of these should change it.** Check `qa status $N --index 5` at the end: 1 of 2, not Approved.

```bash
qa propose-memo $N --keypair $T/site.json --text "ledger test 5" --execute
A="approve $N $L --index 5 --execute"
```

| # | Do this | Command | Expect | Basis |
|---|---|---|---|---|
| a | Lock the device | `qa $A` | `the device is locked`, exit 1 | status word [UNVERIFIED] |
| b | Unlock, stay on the home screen, no app open | `qa $A` | `the Solana app isn't the app that's open`, exit 1 | status word [UNVERIFIED] |
| c | Open another app, such as Ethereum, if installed | `qa $A` | The same, or `answered N bytes for an address`, exit 1 | [UNVERIFIED] |
| d | Solana app open. Don't touch the device for 2 minutes | `qa $A` | After 120 s, `the device didn't answer within 120 s...`, exit 1. Then reject on the device | [RUN] for the tool; the device side is [UNVERIFIED] |
| e | Right after (d) | `qa $A`, reject on the device | A normal prompt. If the device or tool seems stuck, say so | [UNVERIFIED] |
| f | Another path | `qa approve $N --ledger "usb://ledger?key=1/0" --signer-pubkey $LEDGER --index 5 --execute` | `the device's key at m/44'/501'/1'/0' is ..., not the ...`, no prompt | [RUN] |
| g | A key that isn't a member | `qa approve $N --ledger "usb://ledger?key=1/0" --signer-pubkey $COSIGNER2 --index 5 --execute`, with `COSIGNER2=$(solana-keygen pubkey $T/create.json)` | `isn't a member`, no device access | [RUN] |
| h | Propose with the Ledger | `qa propose-memo $N $L --execute` | `a proposal can't be made with a Ledger`, exit 1 | [RUN] |
| i | Ledger Live open and holding the device, if you're willing | `qa $A` | `can't be opened`, or it works; say which | [UNVERIFIED] |
| j | Unplug during a prompt | `qa $A`, pull the cable | `the device stopped answering`, exit 1, and it doesn't hang | [UNVERIFIED] |

For (a) to (c), report the status it printed.

## 5. Clean up

```bash
qa status $N --limit 10     # for the report
rm -rf "$T"
unset T SITE COSIGNER LEDGER L MS N A COSIGNER2
```
The throwaway multisig stays on testnet. It holds nothing and has no power over anything. Whatever is left in the Ledger's address on testnet can stay.

If you attached the device through usbipd, `usbipd detach --busid <id>`.

## 6. What to report back

1. The branch SHA, device model, firmware, Solana app version, and where you ran it (WSL with usbipd, or another machine and OS).
2. **Step 7: did the device's hash match the tool's `MESSAGE HASH`?** Yes or no, for every prompt.
3. **Step 6: must blind signing be on?** What happened with it off, and what the setting is called on your device.
4. What the device showed, screen by screen, for one vote. A phone photo is fine. Did it show a fee payer, or anything else the tool should tell you to compare?
5. Step 2: the address on the screen against the tool's, and against `solana-keygen` if you ran it.
6. Step 10: the seconds waited, both hashes, whether the first prompt stayed up 70 s, and the Ledger's balance before and after. Paste the output.
7. Real fees on X1 for an approve, a reject, a cancel and an execute (the `this key's balance moved` lines). Compare them with 0.00015 and 0.0005.
8. The table in step 13: for each letter, the printed line and exit code, marked with what didn't happen as described.
9. Any hang, a crash, a raw library error, or a message that was unclear at the moment you needed it. The tool shouldn't print anything from the device or library in its own words beyond a status code.
10. The full terminal output, if you can. It holds only public data here: addresses, signatures, testnet RPC.

## What this doesn't cover

- **Mainnet.** Nothing here runs there, and this sheet doesn't authorize it.
- **A real `set_publisher`.** The undo needs a testnet vault, so it was rehearsed with the stand-in only. Voting on one uses the same path as a memo vote. Its execute is a slightly different instruction, and on mainnet it's the one that matters. A second pass on a testnet vault is worth doing before relying on it.
- **Whether what's printed is what's on-chain.** The hash ties the device to this machine's message. It says nothing about what an RPC told this machine: see WHAT A LYING RPC CAN STILL DO in `scripts/quorum-action.ts`.
- **A lost site key.** The Ledger can't propose through this tool and the co-signer has no Initiate, so co-signer + backup can only vote on what's already proposed.
