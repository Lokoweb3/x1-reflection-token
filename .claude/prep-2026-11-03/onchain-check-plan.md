# On-chain check for approvals: what it would take

Assessment, 3 Nov 2026. Nothing is built, and the design comes from reading the code. It isn't tested or reviewed. It doesn't block the Squads move.

## The problem
Squads' approve instruction votes on a proposal index. It doesn't say what the approver believes is stored there. Whoever approves learns the contents from an RPC. With one RPC, a lying one can show an honest message while a different one is stored.

The attacker needs **a stolen member key to store the bad proposal, plus a lying RPC to hide it**. That's the case the quorum exists for: a stolen site key must not get a bad list or `set_publisher` past the other signer.

## The fix: a small assert program
A new program with one instruction: `assert_stored(account, multisig, index, expected_hash)`. It fails unless:
1. the account is owned by the Squads program;
2. its address is the PDA for that multisig and index, so a hash can't be replayed on another proposal;
3. the sha256 of its bytes equals `expected_hash`.

Each vote or execution becomes one atomic transaction: `[assert_stored, proposal_approve]` or `[assert_stored, vault_transaction_execute]`.

Validators run the check against the real account, and the signed transaction can't be altered by an RPC. If the RPC lied, the assert fails and the vote never lands.

**No change to Squads or `tax_vault`,** so this doesn't need a program upgrade or the upgrade authority.

## The rule that makes it work
`expected_hash` must come from the signer's own inputs, never from the RPC. For `set_publisher`, the tool rebuilds the message from `--expect-mint` and `--expect-new-publisher`. For a list, the co-signer rebuilds it from the list it checked itself. The proposer's handoff supplies the rest, such as `creator`. If a signer hashes what the RPC returned, the check proves nothing.

## Work
| Step | What | Who |
|---|---|---|
| 1 | The program: small, no list parsing, no state, no admin | Agent |
| 2 | Local tests against both pinned Squads binaries: honest vote lands; wrong bytes, wrong index, wrong owner and wrong multisig all fail with no vote recorded | Agent |
| 3 | Quorum tool: build the expected bytes locally, add the assert to approve, reject if needed, and execute | Agent |
| 4 | Co-signer: same assert on every approval. It votes on every list, so it's the most exposed signer | Agent, after the move's dry run |
| 5 | Codex review, tests from a fresh clone | Me |
| 6 | Testnet rehearsal, including the Ledger | You |
| 7 | Deploy to mainnet, test once, then make it immutable (`--final`) | You |
| 8 | Require it by default; remove the `--single-rpc-accepted` warning path for tools that use it | Agent |

**Rough size:** steps 1 to 3 and 5 are two or three fix-and-review rounds, as with the recent PRs. That's an estimate.

**Measured cost:** rent is 0.14 XNT for a 20 KB program and 0.28 XNT for 40 KB, plus deploy fees. Each vote costs slightly more, as the requested compute goes up by the hash's cost; not yet measured. Fees on X1 are 10 lamports per requested compute unit plus about 3,001.

## Things to check when building
- **Transaction size** with the extra instruction, especially with a Ledger signing.
- **Ledger display:** an unknown program probably needs blind signing, so the device shows a hash, not the contents. Compare that hash with the tool's on a second screen. To confirm with your device.
- **The exact bytes hashed.** The whole account is simplest, but it includes fields like `creator`. Hashing only `message` plus the PDA check may be cleaner.
- **Config proposals** (threshold, members) use a different account layout. Hashing raw bytes covers them, if the tool can rebuild those bytes.
- **Existing tools:** the Lighthouse assertion program's address, recalled from memory, has no account on X1 mainnet. So plan on deploying this one, which also keeps the code small and reviewable.

## What it doesn't fix
- An RPC can still withhold transactions or misreport status, so votes can be delayed or look wrong. It can't make a vote land on different contents.
- A stolen key that's used directly signs whatever the thief wants. This only protects honest signers.
- A compromised machine running the tool can compute the wrong hash.
- Execution by a stolen key after two honest approvals of the right contents isn't an issue; a proposal's contents don't change.

## Optional second layer, later
`set_publisher` takes effect immediately (`lp-locker/programs/tax_vault/src/lib.rs:969`). A delay would give time to react even after a key theft and a deceived approver, but that's a `tax_vault` upgrade, so it needs the upgrade authority move and its own audit. I'd do the assert program first, because it needs neither.

## Until it exists
The single-RPC risk is accepted by the owner. The tool passes `--single-rpc-accepted` on mainnet, and nothing in the tool detects a lying official RPC.

## Update, 3 Nov 2026: steps 1 to 3 built (`quorum-assert`, `19e53d0`, local)
Fresh clone: tsc clean, 510/510 twice. Agent's rehearsal: 128 checks on both binaries. Codex: APPROVE for a controlled testnet deploy and owner rehearsal, using an independently verified testnet artifact and id. NOT APPROVED for mainnet.

**Before mainnet:** fix the parser-error disclosure (`src/quorum-action.ts:1035`). Reproduce and pin network-specific builds with locked dependencies and compiler. Before pinning the id, independently check executable status, loader owner, ProgramData link, deployed binary hash, and that it's immutable from first deploy. Integrate the co-signer and require the check by default. Complete the `TOO_SHORT`, checked-list execution and real-Ledger rehearsals.

**Corrections to the plan above:**
- "If a signer hashes what the RPC returned, the check proves nothing" is overstated. Codex agrees: hashing the exact bytes that were fully vetted still protects against RPC substitution. Hashing a separate, unvetted read doesn't. Rebuilding from inputs also expresses the signer's own intent, which hashing vetted bytes doesn't.
- The program isn't Anchor, and it has its own workspace. `creator` (bytes 40..72) isn't hashed, so nothing comes from a handoff.
- Lookup tables: the tool refuses them even with `--allow-unknown`. Supporting them later needs extra binding, because a proposal hash alone doesn't authenticate RPC-reported resolutions.
