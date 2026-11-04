# Runbook: moving TEST's keys to Squads

Prepared 2 Nov 2026, updated 3 Nov. **Nothing here has been executed.** Owner's decision, 2 Nov 2026: the move isn't gated on finding 23. Move the publisher using `main`'s co-signer with `--max-moved-bps 100`. Every step is run by the owner.

Two separate moves, in this order:

- **Part 1:** TEST's publisher (`8TAJ…`) to a publisher quorum. No program change.
- **Part 2:** upgrade authority (`53fT…`) to its own multisig. Any `tax_vault` deploy stays blocked until this is done.

## Facts (read from X1 mainnet, 2 Nov 2026)

| Item | Value |
|---|---|
| TEST mint | `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz` |
| `tax_vault` | `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW`, vault v3, upgrade authority `53fT…` |
| `lp_locker` | `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C`, upgrade authority `53fT…` |
| Publisher | `8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb`, 8.50 XNT |
| Guardian | `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`, 1.92 XNT; can't be rotated |
| Upgrade key | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`, 0.44 XNT |
| List state | Epoch 800 active, none pending, 0 cancels in a row |
| Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, executable; program config exists |
| Squads upgrade authority | `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7`. **Who controls it is unverified.** Whoever does can change the program your quorum relies on |

## Decisions (owner, 3 Nov 2026)

1. **Co-signer:** the owner runs it, on a separate device from the bot machine. This protects against theft of the server key and against agents on the bot machine, not against the operator, who now holds two of three roles' access.
2. **Backup key: yes, 2-of-3:** site key, co-signer, and a third key offline on a hardware wallet.
3. **Co-signer version:** A with `--max-moved-bps 100`, in `--dry-run` first. B's redesign is stopped until after the move.
4. **No second RPC and no node (changed 3 Nov).** The tool runs against the official X1 RPC only, passing `--single-rpc-accepted` on mainnet. This replaces the earlier choice of an own node.
5. **Single-RPC risk accepted by the owner, for now.** With it, a lying official RPC plus a stolen member key could get a signer to approve something other than what it was shown, and nothing in the tool detects that. The fix is the on-chain check (`prep-2026-11-03/onchain-check-plan.md`). It's the priority follow-up and doesn't block this move.

6. **Co-signer version confirmed again, 3 Nov, knowing the fabricated-wallet gap.** The move runs on `main`'s co-signer, `--max-moved-bps 100`, `--dry-run` first. It doesn't wait for `cosigner-bad-cid` or the fake-wallet fix. See "Known co-signer limits" below.
7. **Lost site key: the co-signer gets Initiate (3 Nov).** **Don't create the mainnet multisig from `41d9458` or `main`:** their setup script gives the co-signer Vote and Execute only. Use the `cosigner-initiate` branch once it's reviewed. Status: Codex NOT APPROVED at `72906b3` and `54f815d`; waiting on the owner.
8. **#26 stays merged. The server deploys at `5cb0e40`,** not `main`. No plain `git pull` on the server.
9. **`node-hid`: `--omit=optional` on servers,** applied with the Ledger PR, as `main` and #33 don't include `node-hid`.

## Known co-signer limits at the move (`main`'s code)

- **Fabricated wallets:** a wallet stated at exactly `minHolding` isn't counted as moved. About 2.35% of the pot at 10,000 such wallets, 19.4% at 100,000, zero flags (in-memory, list 755). So the co-signer doesn't fully check list contents. A very large list, or a large rise in wallet count, is a warning sign: check any list that jumps by hand. Fix is agreed for after the co-signer fix passes, or after the move.
- **Bad CID stops the pass:** a proposal with an unsupported CID codec stops each pass with only a log line, so later lists stall. Read the co-signer's log for `pass failed`, and clear the proposal with `reject` or `cancel` using the quorum tool.
- **Empty RPC answers and gateway outages cast reject votes.** A single rejection doesn't close a 2-of-3. Check the memo before reacting.
- **A failed reject send isn't retried,** and long reasons may not fit a transaction.
- **Don't run it with `--allow-rebuild`.**
- **`main` doesn't re-check a list before executing.** An Approved proposal the co-signer voted for can run later without another check. Re-check contents by hand right before anything executes, and cancel Approved proposals you no longer want.

**Hand checks during the move (Codex, 3 Nov):** check every beneficiary, balance and eligibility rule on each list yourself, since `--max-moved-bps 100` and `--strict` don't close the fake-wallet gap. Keep the proposed and previous list files valid and available. Clear malformed proposals that block others. Read outcomes from the chain rather than trusting logs, and don't restart into an uncertain send.

## If the site's key is lost (co-signer Initiate, branch `cosigner-initiate`, not yet reviewed)

**Stop `scripts/cosigner.ts` first.** `main`'s co-signer executes any proposal from its own key, unchecked, 1 to 5 seconds after the second vote, and raises no alert for it. Before restarting it, clear anything Approved with its vote.

```bash
npx tsx scripts/quorum-action.ts propose-set-publisher --network mainnet --multisig <ms> \
  --keypair <co-signer> --mint <mint> --new-publisher <key> --execute
npx tsx scripts/quorum-action.ts approve --network mainnet --multisig <ms> --keypair <backup> --index <n> \
  --expect-new-publisher <key> --expect-mint <mint> --expect-message-hash <hash> --single-rpc-accepted --execute
npx tsx scripts/quorum-action.ts execute --network mainnet --multisig <ms> --keypair <co-signer> --index <n> \
  --expect-new-publisher <key> --expect-mint <mint> --expect-message-hash <hash> --single-rpc-accepted --execute
```

- **Status:** `72906b3`. Rehearsed by the agent on both Squads binaries with a key-file backup and `--single-rpc-accepted`, through a local proxy, with the mainnet flag form on the mainnet binary. Through the Ledger it's unproven, and this branch can't sign with one yet. **Codex NOT APPROVED for creating the mainnet multisig (3 Nov):** see the stall finding below.
- **`--expect-*` values must come from your own out-of-band agreement,** never from the proposer's message alone. A stolen co-signer key can hand you its own hash.
- **What it can't do:** publish a list by hand, or replace the lost member in this multisig. Lists stop until the publisher moves. Moving to a new 2-of-3 (`--allow-off-curve`) was rehearsed, but a site running on the new key wasn't.
- **Rent:** the old multisig's rent collector stays the lost key.

**A stolen co-signer key:** can write any proposal holding 1 of 2 approvals, and `cosigner.ts` and the site won't alert on it. So check `status` by hand regularly. It can execute anything Approved at once, so stopping `cosigner.ts` doesn't guarantee a window to cancel.

**Fix round on the stall, `54f815d` (3 Nov), local, one round as the owner set: Codex NOT APPROVED, stopped.** `cosigner.ts` now reads all unresolved indexes, alerts on its own key's proposals and doesn't vote on or execute them, and one bad proposal no longer stops the pass. Fresh clone 474/474 twice; rehearsal on both binaries (138 and 139 checks); with the fix removed the stall section fails. **What remains (Codex P1):** after a first vote attempt on #k fails or waits, a stolen Initiate key adding about 949 indexes per pass stops the sweep wrapping back to #k. It costs about 5.7 XNT per pass (roughly 1,000 XNT an hour at the 20 s loop; less with proposal-less transactions) and holds only while the spending continues. Codex's remedy: freeze each sweep's upper boundary or schedule retries separately. P3, not fixed: README's recovery paragraph and `scripts/quorum-action.ts` lines 39-43 and 170-172 still describe the old own-proposal behaviour. The text below describes `72906b3`.

**Stall (Codex P1, 3 Nov):** after a site proposal #k, about 51 more proposals (roughly 0.3 XNT) push #k out of `cosigner.ts`'s scan, while the site keeps waiting on #k with no timer and defers its fallback payments. Stopping the spam or restarting doesn't clear it. The way out by hand is to resolve #k: site + backup approve it, or reject or cancel it. A stolen site key could already do this on `main`; Initiate gives the co-signer key the same ability.

**Moving to a new multisig isn't covered by the "AFTER AN EXECUTED" section** of the tool's header (Codex P2): the site must be configured with the replacement site key and new quorum address and restarted, the co-signer retargeted, and all three commands need `--allow-off-curve`. Resumed publishing there isn't rehearsed.

## X1's Squads site (`multisig.mainnet.x1.xyz`), read 3 Nov, not tested
Same mainnet Squads program (`SQDS4ep…`). Open-source fork, `x1-labs/squads-v4-ui`, with a Ledger adapter. Whether the hosted bundle matches the repo isn't verified.
- **Possible use:** viewing proposals and Ledger votes. Test on `multisig.testnet.x1.xyz` first, including what the Ledger shows.
- **Don't create the multisig there:** it generates its own create key, so `setup-publisher-quorum.ts` can't find that multisig, and its threshold defaults to 1. `set_publisher` still needs 8TAJ's signature from the server, so the move stays with the script.
- **Correction:** members and permissions aren't fixed for good. The site can propose config changes (add or remove a member, change threshold), which take 2 of 3. Our tool doesn't make those, `cosigner.ts` would reject one, and this route isn't rehearsed. A config change marks earlier proposals stale, and a stale Approved one can still execute.

## Co-signer device

**What it needs:**
- Linux or macOS, physically separate from the bot machine, with no Claude Code, Codex or other agent on it, and no copy of the bot machine's SSH keys.
- Always on. If it's off, new lists stop (payouts from the current list continue), and only site + hardware key can approve. A laptop that sleeps won't do; a small always-on box or a separate VPS you alone can reach will.
- Outbound HTTPS to the RPC and IPFS gateways. It needs no inbound ports.
- Node 22, git, and this repo at the merged commit: `git clone`, then `git checkout <exact sha>`, `npm ci`.
- A webhook URL that reaches you, for rejection alerts.

**Create the key there, and never move it:**
```bash
solana-keygen new --no-bip39-passphrase -o ~/cosigner.json
chmod 600 ~/cosigner.json
solana-keygen pubkey ~/cosigner.json
```
Back it up offline. Send only the **public key** for the setup command. Fund it with about 0.01 XNT.

**Run it under a service with a restart policy,** with the flags from step 5, keeping `--max-moved-bps 100`.

## Hardware wallet (third key)

**Owner's choice, 3 Nov:** Ledger with the Solana app. Signing support is queued after the current fix round; the owner tests it on testnet.

Get its public key, no funds needed. X1's docs show this for Ledger with the Solana app open:
```bash
solana-keygen pubkey "usb://ledger?key=0/0"
```
Use it as `--backup <pubkey>` in steps 3 and 7. Setting up the multisig needs only the public key.

**Gap: approving with it doesn't work yet.** `scripts/quorum-action.ts` signs only from a key file, so a hardware wallet can't vote through it today. Until that's built and rehearsed on testnet with the real device, the route "site + backup" for undoing a move or covering a dead co-signer is **not usable**. Decide this before step 7.

Fund it with about 0.01 XNT when it first needs to pay for a vote.

## Roadmap, after the move

- **Priority: on-chain check** so a vote can only land on the contents the signer expects. Plan: `prep-2026-11-03/onchain-check-plan.md`. Needs no program upgrade.
- **Hardware wallet signing in the tool,** if it isn't done before step 7.
- **Co-signer fixes:** `cosigner-bad-cid` is parked at `3472b84` (Codex not approved; two alert-text findings; no more rounds without the owner). Fake-wallet fix comes after the move.
- **The 1% ambiguity budget** for the co-signer (see the audit report).

## Co-signer version

The co-signer is off-chain, so this choice isn't permanent. Going from A to B means restarting one process on a new commit, with no on-chain step.

| | A: `main` with `--max-moved-bps 100` (**chosen**) | B: stopped until after the move (scan-based redesign, replaces `751f22e`) |
|---|---|---|
| Exists today | Yes, `main` from `5f8234d` | No. `751f22e` was **not approved by Codex (6 blockers)**. Replacement `audit-cosigner-scan` (`42265aa`), local, **also not approved (3 blockers, 2 Nov 2026)**; next design is in the merged report |
| Publisher naming an old slot where it held more | Not checked either, but the live comparison limits it | To be settled in the redesign; needs an on-chain expiry to hold at execution |
| Rehearsed end to end | Yes, locally against the testnet Squads program, at the default moved limit | No |
| Honest seller after the snapshot | Passes if under 1% of weight moved; a larger move rejects that list and the site rebuilds | Must pass, by design |
| Publisher inflating a stated balance | **Passes up to the larger of 5% of its own stated balance and 1% of total weight** | Must be rejected |
| Rejects a list if over 1% of weight moved | Yes, with this flag | Yes |

**Version A rules:**
- Always pass `--max-moved-bps 100`. The default is 10%. If the process restarts without it, the protection silently widens, so put it in the service definition and not a shell history.
- Don't use `--strict`. Any moved balance flags a list and `--strict` turns flags into rejections, so an active token would see many rejected lists (rehearsal step D shows this).
- The cost of 1%: if honest holders move over 1% of the weight between snapshot and scan, that list is rejected and rebuilt on a later pass. Holders keep being paid from the current list. This setting hasn't been rehearsed, so watch it in `--dry-run` first (step 5 and step 8).

**What A still protects against:** a stolen site key can't publish alone, redirect wallets, lower anyone's total or change rules. **What it doesn't:** that key can overstate its own balance within the limit above, until you move to B. The bound comes from reading `src/list-verify.ts:244-256`: a wallet within 5% of its stated balance isn't counted as moved, and a larger difference has to fit in the 1% of weight.

## Part 1: publisher quorum

### Stop conditions
Stop if any step's check fails. Until step 7, nothing affects TEST. **Step 7 is the point that's hard to undo.**

### 1. Preflight (read-only)
- Server and co-signer machine both run `main` at `5f8234d` or later: `sudo -u reflect git rev-parse --short HEAD`, and `scripts/setup-publisher-quorum.ts` exists. `audit-publisher-quorum` and the fix branches are held and shouldn't be on either machine.
- Backups of `publisher.keypair.json` exist and verify **by public key only**.
- Co-signer key funded with about 0.01 XNT and a webhook alert that reaches you.
- Hardware wallet public key recorded, and its signing route rehearsed on testnet.
- Find out who controls Squads authority `2sXr…`.

### 2. Close the rehearsal gap
The existing rehearsal is local and uses the **testnet** Squads program. **The mainnet Squads deployment has never been exercised by this code.** Before moving TEST:
- Rerun `scripts/publisher-quorum-rehearsal.ts` locally against `main`. It doesn't pass `--max-moved-bps 100` by itself, so add the flag or check that case separately.
- Clone mainnet Squads in place of testnet's, if the script can be adapted (`SQUADS` is hard-coded there).
- **Tool:** `scripts/quorum-action.ts` on local branch `quorum-action-tool` (`41d9458`) does this and passed local rehearsal on both Squads binaries. **Codex approved it on 3 Nov 2026 (fifth pass, malformed-CID fix) for mainnet use by the owner under the accepted risks: official RPC only, and no Ledger signing yet. Codex read the code and ran isolated checks. The full tests and rehearsal were run separately.** Not yet on `main`. The undo path is otherwise untested. The builders exist in `src/squads.ts` (`proposeIxs`, `approveIx`, `executeIx`).
- **Tool changes at `7f075a0`:** mainnet `approve` and `execute` need `--single-rpc-accepted`. Message hashes are now v2 and cover one index, so a re-proposal gets a new hash. Exit 4 also means a read-back was missing or undecodable: don't resend, run `status --index n`. `setup-publisher-quorum.ts` can refuse on a stale Approved proposal or an incomplete scan: clear those with `cancel`, or retry the scan.
- **Tool changes at `41d9458`:** a proposal with an unusable list file ID, or an undecodable transaction account, now shows in `status` and can be cleared with `reject` or `cancel`. `approve` and `execute` refuse it, even with `--allow-unknown`. An all-zero list file ID is refused too.
- **Stale proposals:** an Approved vault transaction below the stale index can still execute with one key on both Squads binaries, including after a config change. Cancelling takes a threshold of cancels. Never assume a config change killed an old approval.

### 3. Create the multisig (no change to TEST)
Run on the server, as `reflect`, with the mainnet environment (`REFLECT_CONFIG`, `REFLECT_FACTORY_DIR`, `REFLECT_STATE_DIR`, as in `docs/MAINNET-ROLLOUT.md`).

**Pass `--network mainnet`. Both scripts default to testnet.** Keep the create-key file outside the repo.

```bash
node node_modules/tsx/dist/cli.mjs scripts/setup-publisher-quorum.ts \
  --rpc https://rpc.mainnet.x1.xyz --network mainnet \
  --keypair mainnet/publisher.keypair.json --create-key <file outside repo> \
  --site 8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb --cosigner <co-signer pubkey> --backup <backup pubkey>
```

Check the dry run: threshold 2 of 3, no config authority, time lock 0, simulation OK. Write down the multisig and vault PDA. Rerun with `--execute`.

### 4. Prove the multisig works
With the tool from step 2, have site + backup execute a harmless transaction from the vault PDA. This tests real mainnet Squads and the undo route while nothing depends on them.

### 5. Start the co-signer in dry run
On the co-signer's own machine, with `PINATA_JWT` in its environment if it should pin a second copy:

```bash
npx tsx scripts/cosigner.ts --rpc https://rpc.mainnet.x1.xyz --network mainnet \
  --keypair <co-signer key> --multisig <multisig> --webhook <url> --loop 20 --max-moved-bps 100 --dry-run
```

The tax program defaults to `D9jt…`, which is correct here. Check that it starts and prints the expected members and vault PDA. Keep `--max-moved-bps 100` in every later start of this process.

### 6. Tell the site about the quorum
In `mainnet/config.json`, under `factory.taxVault`:

```json
"quorum": { "multisig": "<multisig>", "labels": { "<co-signer pubkey>": "co-signer", "<backup pubkey>": "backup" } }
```

Then `systemctl restart reflect-mainnet-factory`. A vault whose publisher is still a plain key keeps its current behaviour, so TEST should publish normally. Wait for one normal crank pass.

### 7. Move the publisher: **hard to undo**
Choose a quiet window, just after a list has gone live, with someone watching for an hour. Dry run with the mint, confirm the simulation, then execute:

```bash
node node_modules/tsx/dist/cli.mjs scripts/setup-publisher-quorum.ts \
  --rpc https://rpc.mainnet.x1.xyz --network mainnet \
  --keypair mainnet/publisher.keypair.json --create-key <same file> \
  --site 8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb --cosigner <co-signer pubkey> --backup <backup pubkey> \
  --mint C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz            # then again with --execute
```

Check: the vault's publisher reads back as the vault PDA, and the token page shows the multisig.

### 8. First list
With the co-signer still in dry run, the site's first proposal can't execute, which is safe. Read the co-signer's verdict and flags:
- **Sensible:** restart it without `--dry-run`, keeping `--max-moved-bps 100`.
- **Reject:** find out why before going live. Holders are still paid from the current list.

Confirm the list executes, goes live and pays.

### 9. Watch
Check daily for a week: new lists land, the co-signer is alive, no unexplained rejections, 8TAJ's balance holds. The GitHub backup crank doesn't publish lists and doesn't serve mainnet as configured, so it won't cover this.

## If something goes wrong

| Situation | Effect | Response |
|---|---|---|
| Co-signer offline | New lists stop; wallets on the current list are still paid; XNT accumulates | Restart it. Otherwise site + backup can approve (tool from step 2) |
| Repeated rejections | No new lists | Read the reason in the vote memo. Moved over 1% several lists running means the limit is too tight for current trading: pause and decide; don't raise it without a reason. Rejections don't move the recovery clocks |
| Bad proposal from a stolen site key | Co-signer rejects, alert fires | Treat `8TAJ` as compromised. Replace it through the multisig or the guardian route |
| Want a single key again | | Site + backup approve `set_publisher`; the co-signer refuses by design |
| Co-signer and backup both lost | | Guardian `appoint_publisher` after 7 days without a list (`scripts/appoint-publisher.ts`). Fallback opens at 30 days. This ends the quorum |
| Before step 7 | Nothing depends on the multisig | Remove `quorum` from config, restart |

Two colluding members can still publish anything that fits on-chain, and the guardian keeps its two cancels.

## Later: going from version A to B
Only once a B version exists and has passed review.
1. Check out that commit on the co-signer's machine.
2. Run it with `--dry-run` alongside a live list if possible.
3. Restart the real process. No on-chain step is needed for the co-signer itself.

## Part 2: upgrade authority

**Keep this separate from the publisher multisig.** Different job, different members, ideally stricter. From `docs/MAINNET-ROLLOUT.md`, P4 and P5, both still to do:

1. **Create the multisig**, e.g. 2-of-3: main wallet, hardware or second device, trusted third party. Note its **vault address**, not the multisig account address. That mix-up is the classic way to lose upgrades. The site named in the rollout doc is `multisig.mainnet.x1.xyz`; confirm it's genuine before connecting a wallet.
2. **Trial on testnet (P5):** move a test program's authority and do one full upgrade through Squads, so the process is known before it guards mainnet.
3. **List every program under `53fT`.** `tax_vault` and `lp_locker` are confirmed above. Check the bonding curve and anything else deployed on mainnet.
4. **Move each one:**
   ```bash
   solana program set-upgrade-authority <program> --new-upgrade-authority <squad vault address> \
     --skip-new-upgrade-authority-signer-check --keypair ~/.config/solana/id.json --url https://rpc.mainnet.x1.xyz
   ```
   **The skip flag means a wrong address can't be recovered, and there's no undo.** Check the address twice and do the least important program first.
5. **Check:** `solana program show <program>` lists the squad's vault as authority.
6. **Fund future upgrades.** 53fT has 0.44 XNT, enough for these authority changes but not a deploy. The last upgrade needed about 5.7 XNT, mostly a refundable buffer.

Only after this can `audit-tax-vault` and the finding 5 program change be deployed, and each of those still needs its own go-ahead.

## Part 3: turning on `checkedPublish` (later, after Part 2)

Closes the finding 5 race. Not part of the publisher move, and it can't happen before the program has `publish_list_checked`. That needs Part 2, an upgrade and its own go-ahead. It also needs branch `audit-fallback-race-dagpb`, which is unmerged and **not approved by Codex at `0770058` (1 blocker, 3 should-fixes)**, so recheck these steps against the merged code. **Don't follow the floor recovery in `docs/tax-vault-spec.md` yet:** Codex found it can remove protection against a real proposal.

**With the option on, the site and crank build no list and the site holds its own `pay_fallback` while any plain `publish_list` proposal could still execute.** `pay` keeps running. There's no automatic clean-up: every open plain proposal is cleared by hand.

### Clear-by-hand checklist
1. **Check the multisig has a rent collector** before anything else. Without one, a stale Active or Draft proposal can't be closed and blocks permanently (from reading the Squads source, not tested).
2. **Enable both together:** `factory.taxVault.checkedPublish` on the site and `--checked-publish` on the co-signer.
3. **Read the blocking list.** The site's notes and error log show `checkedPublish: no new list ...` with `#i (kind, status)`. It only appears when a list would be built or a fallback payment made. Old-epoch proposals count too: there's no exemption.
4. **Clear each index:**

   | What it shows | How to clear it |
   |---|---|
   | Active | Rejections up to the cutoff (voters − threshold + 1); 2 of 3 members in a 2-of-3 |
   | Approved | A threshold's worth of cancels. An Approved proposal can't simply be closed |
   | Draft | Activate, then reject |
   | No proposal | `proposal_create`, then reject |
   | Stale Active or Draft | Can't be voted on. `vault_transaction_accounts_close`, which needs the rent collector from step 1 |
   | `batch` or `tax-program` | Inspect by hand, then clear by status |
   | `unknown`, or "the scan can't vouch" | Treat as an RPC or data problem. Check both; don't assume it's safe |

5. **Do Approved proposals first if a fallback window is open.** Third parties can still call `pay_fallback` after 30 days, which is when an Approved plain proposal is most dangerous.
6. **Until it's closed, a member with Execute can still run it.** The gate limits our own callers, not the Squads program. Tell members not to execute anything while clearing.
7. **Confirm:** the next pass shows no blocked note, and a list builds and goes through `publish_list_checked`.

The repo has no tool for these votes yet (same gap as step 2 of Part 1), and the rejected and closed routes on this list have only partly been exercised: Active, Approved, Rejected, Cancelled and Executed on a local validator with the testnet Squads clone. Build and rehearse the tool first.

## Not verified
- Who controls Squads authority `2sXr…`, and whether the mainnet Squads binary is the official build.
- Any of this code against mainnet Squads.
- Mainnet Squads fees. The step 3 dry run shows a simulation result only, so check the payer's balance change.
- The commit the server runs. It can't be read from here.
- `--max-moved-bps 100` on TEST's real trading pattern.
