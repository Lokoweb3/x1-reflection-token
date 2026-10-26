# Payout audit: C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz at slot 88648034

Run Oct 26, 2026, 1:41 AM ET with `npx tsx scripts/audit-payouts.ts` against https://rpc.mainnet.x1.xyz. **All 29 checks passed.**

Vault `CeUD11HkZm6MwMaDtHyDUp83VV1wYzsMCCHKbtZQ92mr`: publisher `8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb`, guardian `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`, funded 689.670851282 XNT, paid 688.700581365 XNT.

| List | State | CID | Snapshot slot | Published | Wallets | Total XNT | Pot XNT |
|---|---|---|---|---|---|---|---|
| 747 | previous | `bafkreiaytmecy36qvyz5g2yk2mtp56e6uj4bbn6xskopnk5qpnregsaiai` | 88606344 | [4wxRjGwGPL…](https://explorer.mainnet.x1.xyz/tx/4wxRjGwGPLQvarwaTiQx6H7Y67XnkQF5v1nkYoZ4zjwXF3AMKnMu7i4299LPYGraENHXVG44aftqpMcVmH1BhfyX) Oct 25, 2026, 9:25 PM ET | 29 | 687.632108708 | 2.911824109 |
| 748 | active | `bafkreieuquzcxg3vje2vmfcxkpxn43mbyenv7hgqpuww64bbcr2dim7oei` | 88618779 | [xTmNKbTn5c…](https://explorer.mainnet.x1.xyz/tx/xTmNKbTn5cZWhXKiNTKM7tcFJz8sQ95nVKUdV1wPyqYK2r8cJwZtiBU5735m4sqN4SJb2DHoziqxZ75aTdmZWWW) Oct 25, 2026, 10:41 PM ET | 29 | 688.705379825 | 1.073271127 |

## Checks

- ✅ list 747: file served by IPFS hashes to the CID the next list names
- ✅ list 747: file is for this vault, mint and epoch
- ✅ list 747: entries give the root the next list names
- ✅ list 747: entries add up to the file's total (687.632108708 XNT)
- ✅ list 747: publish_list 4wxRjGwGPLQv… signed by the publisher with this root, total and CID
- ✅ list 747: published (slot 88606351, Oct 25, 2026, 9:25 PM ET) after its snapshot (slot 88606344)
- ✅ list 747: previous list 746 fetched by CID gives the root it names
- ✅ list 747: pot = holdersFunded − Σ start = 2.911824109 XNT
- ✅ list 747: every entry recomputes from the inputs
- ✅ list 747: nobody's total is below the previous list
- ✅ list 747: all 21 balances it used equal the owner's TEST at slot 88606344
- ✅ list 747: no eligible owner (≥ 1000 TEST at the snapshot, not excluded) is missing
- ✅ list 747: every balance used meets minHolding and no excluded owner earns
- ✅ list 748: file served by IPFS hashes to the CID stored on-chain
- ✅ list 748: file is for this vault, mint and epoch
- ✅ list 748: entries give the on-chain root
- ✅ list 748: entries add up to the on-chain total (688.705379825 XNT)
- ✅ list 748: publish_list xTmNKbTn5cZW… signed by the publisher with this root, total and CID
- ✅ list 748: published (slot 88618788, Oct 25, 2026, 10:41 PM ET) after its snapshot (slot 88618779)
- ✅ list 748: previous list 747 fetched by CID gives the root it names
- ✅ list 748: pot = holdersFunded − Σ start = 1.073271127 XNT
- ✅ list 748: every entry recomputes from the inputs
- ✅ list 748: nobody's total is below the previous list
- ✅ list 748: all 21 balances it used equal the owner's TEST at slot 88618779
- ✅ list 748: no eligible owner (≥ 1000 TEST at the snapshot, not excluded) is missing
- ✅ list 748: every balance used meets minHolding and no excluded owner earns
- ✅ 29 PaidRecords add up to holders_paid (688.700581365 XNT)
- ✅ holders_paid ≤ list_total ≤ holders_funded
- ✅ nobody was paid more than the active list 748 gives them

## Excluded holders (≥ minHolding now)

- `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU`: 492535871.814127684 TEST (off-curve (program-owned))
- `5GjJLVFfSExiFXJpKY3cUFnnX3UexJBA6AxDA9UGXm4g`: 7439493.206072673 TEST (off-curve (program-owned))
- `44fNpT8DjpYgLzYEZqUHYogJiEreaPXajme2TigHPTnL`: 653666.552096368 TEST (off-curve (program-owned))
- `CWRTWvYTBv3uUkBmLQtp3rXCqM1BQ5nYvoW7XScWuTZS`: 9696.713726714 TEST (vault auth PDA)

## What this does and doesn't show

- The leaf, tree, CID and allocation rules are reimplemented from docs/tax-vault-spec.md, not imported from the site. The leaf sort was added to the spec after an audit found it only in the site's code.
- Snapshot balances are rebuilt per token account from the last transaction at or before the snapshot slot (or are the current balance when nothing touched the account since). This trusts the RPC's transaction history; rerun with `--rpc` against another provider to cross-check.
- Token accounts closed since the snapshot aren't enumerated, except the ATAs of wallets a list names. Owners are taken as they are now.
- Program-owned (off-curve) holders are excluded by the token's rules. That is a rule, not evidence of who the tokens inside belong to: TEST held through a router, escrow or smart wallet earns nothing.
- Correct arithmetic doesn't make the rules fair, and point-in-time snapshots can be gamed when a payout outweighs the round-trip tax and price impact at that size and pool depth.
