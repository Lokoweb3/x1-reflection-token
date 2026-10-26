# Payout audit: C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz at slot 88653301

Run Oct 26, 2026, 2:13 AM ET with `npx tsx scripts/audit-payouts.ts` against https://rpc.mainnet.x1.xyz. **All 29 checks passed.**

Vault `CeUD11HkZm6MwMaDtHyDUp83VV1wYzsMCCHKbtZQ92mr`: publisher `8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb`, guardian `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`, funded 690.075017722 XNT, paid 690.070608786 XNT.

| List | State | CID | Snapshot slot | Published | Wallets | Total XNT | Pot XNT |
|---|---|---|---|---|---|---|---|
| 748 | previous | `bafkreieuquzcxg3vje2vmfcxkpxn43mbyenv7hgqpuww64bbcr2dim7oei` | 88618779 | [xTmNKbTn5c…](https://explorer.mainnet.x1.xyz/tx/xTmNKbTn5cZWhXKiNTKM7tcFJz8sQ95nVKUdV1wPyqYK2r8cJwZtiBU5735m4sqN4SJb2DHoziqxZ75aTdmZWWW) Oct 25, 2026, 10:41 PM ET | 29 | 688.705379825 | 1.073271127 |
| 749 | active | `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` | 88648472 | [3Wo6GFZdyN…](https://explorer.mainnet.x1.xyz/tx/3Wo6GFZdyNYyrVW3WVNkUu7GEGXsN7dV4LTHmM1dYGAHJgB4ZC4MqDwW1TGDmjN7rD48Er9DZRTJ8g9gzz8KYRaU) Oct 26, 2026, 1:43 AM ET | 29 | 690.075017713 | 1.369637897 |

## Checks

- ✅ list 748: file served by IPFS hashes to the CID the next list names
- ✅ list 748: file is for this vault, mint and epoch
- ✅ list 748: entries give the root the next list names
- ✅ list 748: entries add up to the file's total (688.705379825 XNT)
- ✅ list 748: publish_list xTmNKbTn5cZW… signed by the publisher with this root, total and CID
- ✅ list 748: published (slot 88618788, Oct 25, 2026, 10:41 PM ET) after its snapshot (slot 88618779)
- ✅ list 748: previous list 747 fetched by CID gives the root it names
- ✅ list 748: pot = holdersFunded − Σ start = 1.073271127 XNT
- ✅ list 748: every entry recomputes from the inputs
- ✅ list 748: nobody's total is below the previous list
- ✅ list 748: all 21 balances it used equal the owner's TEST at its snapshot slot 88618779
- ✅ list 748: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 748: every balance used meets minHolding and no excluded owner earns
- ✅ list 749: file served by IPFS hashes to the CID stored on-chain
- ✅ list 749: file is for this vault, mint and epoch
- ✅ list 749: entries give the on-chain root
- ✅ list 749: entries add up to the on-chain total (690.075017713 XNT)
- ✅ list 749: publish_list 3Wo6GFZdyNYy… signed by the publisher with this root, total and CID
- ✅ list 749: published (slot 88648479, Oct 26, 2026, 1:43 AM ET) after its snapshot (slot 88648472)
- ✅ list 749: previous list 748 fetched by CID gives the root it names
- ✅ list 749: pot = holdersFunded − Σ start = 1.369637897 XNT
- ✅ list 749: every entry recomputes from the inputs
- ✅ list 749: nobody's total is below the previous list
- ✅ list 749: all 20 balances it used equal the owner's TEST at its snapshot slot 88648472
- ✅ list 749: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 749: every balance used meets minHolding and no excluded owner earns
- ✅ 29 PaidRecords add up to holders_paid (690.070608786 XNT)
- ✅ holders_paid ≤ list_total ≤ holders_funded
- ✅ nobody was paid more than the active list 749 gives them

## Excluded holders (≥ minHolding now)

- `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU`: 492524151.870667458 TEST (off-curve (program-owned))
- `5GjJLVFfSExiFXJpKY3cUFnnX3UexJBA6AxDA9UGXm4g`: 7439493.206072673 TEST (off-curve (program-owned))
- `44fNpT8DjpYgLzYEZqUHYogJiEreaPXajme2TigHPTnL`: 653666.552096368 TEST (off-curve (program-owned))
- `CWRTWvYTBv3uUkBmLQtp3rXCqM1BQ5nYvoW7XScWuTZS`: 9467.963387803 TEST (vault auth PDA)

## What this does and doesn't show

- The leaf, tree, CID and allocation rules are reimplemented from docs/tax-vault-spec.md, not imported from the site. The leaf sort was added to the spec after an audit found it only in the site's code.
- Snapshot balances are today's balances (read at a known slot) minus every TEST balance change after the snapshot, taken from every transaction that names the mint. That history is complete because TEST's transfer fee makes Token-2022 refuse transfers that don't name the mint; it includes accounts closed since. It trusts the RPC's transaction history; rerun with `--rpc` against another provider to cross-check.
- The builder records its snapshot slot before it scans, so its balances can be from a few slots later; the check accepts one slot between the recorded slot and publication at which every balance matches, and says which.
- An account's owner is the one its transactions report; an owner change (SetAuthority) isn't modelled.
- Program-owned (off-curve) holders are excluded by the token's rules. That is a rule, not evidence of who the tokens inside belong to: TEST held through a router, escrow or smart wallet earns nothing.
- Correct arithmetic doesn't make the rules fair, and point-in-time snapshots can be gamed when a payout outweighs the round-trip tax and price impact at that size and pool depth.
