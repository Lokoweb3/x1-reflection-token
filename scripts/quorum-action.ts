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
 *                 past the first read's slot) and refuse on any difference
 *   --single-rpc-accepted  rely on one RPC. On mainnet approve and execute refuse unless this or
 *                 --verify-rpc is given. Prints a loud warning, and means what it says: see WHAT A
 *                 LYING RPC CAN STILL DO below
 *   --expect-message-hash  approve and execute: the message hash the proposer printed for this
 *                 multisig and index from what it built. Refused when what the RPC reports differs
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
 * read back, or the account it should have changed is missing or doesn't decode: don't re-propose or
 * resend, run `status --index n` when the RPC answers. Nothing is
 * ever resent automatically. RPC URLs print as scheme and host only, the credentials in them are
 * scrubbed from all output, and an RPC failure prints only its operation and class: never the server's
 * words. What a successful answer holds is printed as data (decoded accounts, simulation logs and
 * error), scrubbed but not withheld: it's what you are here to read.
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
 * are the same whatever the target, because the target is instruction data. Everything printed
 * here (the decoding, the votes, the simulation, setup-publisher-quorum's scan) is what an RPC said.
 *  - --single-rpc-accepted, the official RPC only: A LYING OFFICIAL RPC CAN SHOW A DIFFERENT
 *    set_publisher THAN THE ONE STORED, AND NOTHING IN THIS TOOL DETECTS IT. The owner accepts that
 *    risk for now; the on-chain check is the fix.
 *  - --verify-rpc detects two RPCs that disagree, nothing more. Two that report the same false
 *    bytes pass, and the tool can't tell two URLs that reach one operator apart.
 *  - --expect-message-hash helps ONLY if the hash came from a machine you trust, which built the
 *    transaction itself. It's compared with what the RPC reports, not with the chain, so it doesn't
 *    prove what's stored. It covers the multisig, the index and the message, so a hash for one
 *    proposal doesn't fit another: if colluding RPCs store set_publisher(B) at #j and report an honest
 *    A message rewritten to #j, the honest hash for #i is refused at #j. It doesn't help when whoever
 *    gave you the hash is the attacker (a stolen proposer key hands you the hash of A at #j), or
 *    when you were told the right index and the RPC reports A there while B is stored.
 * Only an on-chain check closes this (a vote or execute asserting the message), which needs a
 * program change and doesn't exist yet. The execute instruction carries no message: the program runs
 * what's stored, whatever was printed.
 *
 * THE SETUP THIS IS FOR: site key + co-signer + hardware backup, 2-of-3 (threshold 2, so 2 approvals
 * pass and 2 rejections close). `scripts/setup-publisher-quorum.ts --site <pubkey> --cosigner <pubkey>
 * --backup <hardware pubkey>` needs only the backup's public key.
 *  - Site + co-signer: lists, as usual. The co-signer has no Initiate, so it can't propose.
 *  - Site + backup: the undo, or a dead co-signer. NOT USABLE THROUGH THIS TOOL YET: --keypair signs
 *    from a file, so a hardware key can't propose, vote, cancel or execute here. Until external signing
 *    is built and rehearsed with the device, don't count on that route.
 *  - Key files stay chmod 600, and each member runs this on its own machine.
 *
 * A CONFIG CHANGE DOESN'T END WHAT'S APPROVED (rehearsed on both pinned binaries). It marks every earlier
 * index stale: a stale Active, Draft or proposal-less transaction can't take votes or run, but a stale
 * Approved vault transaction still executes with one member's key and can't be closed; only a threshold
 * of cancels stops it.
 *
 * Proposals this tool creates aren't the site's: it follows only the index it stored, ignores
 * every other one, and doesn't close them, so their rent stays with the account until someone
 * closes them. The co-signer rejects them and alerts its webhook; in a 2-of-3 that doesn't stop
 * two other members (cutoff voters - threshold + 1 = 2 rejections).
 */
import { quorumAction } from "../src/quorum-action.js";

process.exit(await quorumAction(process.argv.slice(2)));
