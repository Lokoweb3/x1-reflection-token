/**
 * One member of a publisher quorum (docs/tax-vault-spec.md "Publisher quorum") acting on the
 * Squads multisig: site + backup can act without the co-signer. One member key per run,
 * because the members sit on different machines. DRY RUN by default: builds and simulates,
 * sends nothing.
 *
 *   npx tsx scripts/quorum-action.ts status --network testnet|mainnet --multisig <addr> [--index n] [--limit 10]
 *   ... propose-memo          --network <net> --multisig <addr> --keypair <file> [--text <short>]
 *   ... propose-set-publisher --network <net> --multisig <addr> --keypair <file> --mint <mint> --new-publisher <pubkey>
 *   ... approve               --network <net> --multisig <addr> --keypair <file> --index n [--expect-...]
 *   ... reject                --network <net> --multisig <addr> --keypair <file> --index n [--memo <reason>]
 *   ... cancel                --network <net> --multisig <addr> --keypair <file> --index n [--memo <reason>]
 *   ... execute               --network <net> --multisig <addr> --keypair <file> --index n [--expect-...]
 *
 *   --network     required, no default. The RPC's genesis hash must match it. Picks the Squads
 *                 program (src/squads.ts) and the default RPC
 *   --rpc         default the network's public RPC
 *   --execute     sign and send. Without it: print exactly what it would do and the simulation
 *                 result. Simulation is always unsigned; the key signs only past this flag, so a
 *                 dry run never hands an RPC anything it could relay
 *   --verify-rpc  approve and execute: read the stored transaction, proposal, multisig and vault
 *                 publisher again from this RPC (another host or port, the same genesis, at or
 *                 past the first read's slot) and refuse on any difference. Required on mainnet
 *   --single-rpc-accepted  on mainnet, rely on one RPC instead. Prints a loud warning
 *   --expect-message-hash  approve and execute: the message hash the proposer printed from what
 *                 it built. Refused when the stored message differs
 *   --keypair     this member's key file: refused if group- or world-readable. It signs and
 *                 pays. Needs Initiate and Vote to propose (proposing also approves), Vote to
 *                 approve or reject, Execute to execute
 *   --expect-new-publisher  required to approve or execute a set_publisher: restate the new
 *                 publisher you agreed on; refused when the stored instruction differs
 *   --expect-mint       optional: the vault the stored set_publisher acts on is for this mint
 *   --expect-memo-hash  optional: the sha256 propose-memo printed; refused when it differs
 *   --allow-unknown     approve or execute something that is neither of the two known shapes
 *                 (exactly one memo, or exactly one set_publisher, signed by the vault PDA).
 *                 Prints a loud warning. A rewards list counts as unknown here: this tool
 *                 doesn't check lists. `scripts/cosigner.ts --once --dry-run` with this key does.
 *                 Run without --dry-run that script acts on the whole multisig: it rejects every
 *                 other open proposal this key hasn't voted on, and it EXECUTES, unchecked, any
 *                 Approved proposal this key approved. Clear those first
 *   --allow-off-curve   a new publisher that is off-curve and isn't a vault PDA of this multisig
 *   --allow-local-rpc   a validator on this machine (its genesis is neither network's). Only
 *                 with it: --squads-program <id>. --network still routes the Squads program
 *   --program     tax_vault id, default D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW; on real
 *                 mainnet only that id is accepted
 *   --priority    microlamports per CU, default 10000
 *
 * Exit codes: 0 done (or dry run OK), 1 refused or failed, 2 usage, 3 the send is AMBIGUOUS: it
 * may still land, so run `status --index n` first; 4 it is CONFIRMED but the result couldn't be
 * read back: don't re-propose or resend, run `status --index n` when the RPC answers. Nothing is
 * ever resent automatically. RPC URLs print as scheme and host only.
 *
 * What it signs comes from the chain: before approve or execute, the stored transaction is
 * decoded and printed (program, accounts, and for set_publisher the vault, current publisher
 * and new publisher). `status` and every other subcommand print the same decoding.
 *
 * AFTER AN EXECUTED set_publisher, for the site (src/factory/vault.ts). The chain decides each
 * pass (`quorumFor`, `publishMode`), so the vault stops going through the multisig at once:
 *  - The list the site was tracking (`next.proposal`) is dropped from vault-list.json ("the
 *    vault's publisher is no longer this multisig"). Its proposal stays on-chain, blocked only
 *    while the publisher differs (NotPublisher). If the publisher returns to this vault PDA it can
 *    run again, by one signature if already Approved and if its epoch and total still fit. Clear
 *    it before the publisher returns: two rejections if Active, a threshold of `cancel`s if
 *    Approved. scripts/setup-publisher-quorum.ts refuses to move a vault back until then, but a
 *    publisher's own set_publisher sent any other way doesn't ask. The site doesn't clear it.
 *  - New publisher IS the site's factory.taxVault.publisherKeypair: the site publishes directly
 *    with that key from its next pass (up to 60 s), no restart needed.
 *  - New publisher is ANY OTHER key: the site stops building lists for this vault and notes
 *    "lists are published by X… (not this site)", while still running the permissionless steps
 *    and paying the current list. Either point factory.taxVault.publisherKeypair at the new
 *    key and restart (that key then pays the crank's fees), or have that key run
 *    `scripts/crank.ts --publisher <file>`.
 *  - In both cases `factory.taxVault.quorum` is then unused for this vault: remove it and
 *    `systemctl restart reflect-mainnet-factory` when convenient, so the config says what is
 *    true. Stop the co-signer: it has nothing left to check (its loop keeps reading otherwise).
 *  - Going back to the quorum later is scripts/setup-publisher-quorum.ts again with --mint,
 *    after clearing what's open.
 *
 * NO EXPIRY: an Approved proposal stays executable by any one member with Execute until someone
 * executes it, and rejecting is closed by then (only a threshold of `cancel`s stops it). An
 * abandoned Active proposal stays open too: reject it. So approve and execute in one sitting.
 *
 * WHAT A LYING RPC CAN STILL DO. Your signature approves a proposal, not its bytes, and neither the
 * program nor this tool can tie a vote to the message you read. For a set_publisher the accounts
 * are the same whatever the target, because the target is instruction data, so an RPC colluding
 * with a proposer can show you set_publisher(A) while the chain stores set_publisher(B).
 *  - One RPC read (testnet, or --single-rpc-accepted): that RPC decides what you see.
 *  - --verify-rpc: both must lie. TWO RPCs THAT BOTH LIE STILL PASS, and the tool can't tell two
 *    URLs that reach one operator apart (it only compares host and port).
 *  - --expect-message-hash, from a proposer that built the transaction itself on a machine you
 *    trust, passed out of band: catches the RPCs lying even if all of them do, but a stolen proposer
 *    key hands you whatever hash it likes.
 * Only an on-chain check could close this (a vote or execute asserting the message hash), which
 * needs a program change and doesn't exist. Before relying on an approval, have the second member
 * read the proposal through infrastructure the proposer doesn't control. Keep in mind that the
 * execute instruction carries no message: the program runs what's stored, whatever was printed.
 *
 * Proposals this tool creates aren't the site's: it follows only the index it stored, ignores
 * every other one, and doesn't close them, so their rent stays with the account until someone
 * closes them. The co-signer rejects them and alerts its webhook; in a 2-of-3 that doesn't stop
 * two other members (cutoff voters - threshold + 1 = 2 rejections).
 */
import { quorumAction } from "../src/quorum-action.js";

process.exit(await quorumAction(process.argv.slice(2)));
