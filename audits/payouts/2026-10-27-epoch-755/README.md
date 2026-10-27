# Payout audit: C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz at slot 88896822

Run Oct 27, 2026, 3:06 AM ET with `npx tsx scripts/audit-payouts.ts` against https://rpc.mainnet.x1.xyz. **All 94 checks passed.**

Vault `CeUD11HkZm6MwMaDtHyDUp83VV1wYzsMCCHKbtZQ92mr`: publisher `8TAJEiAfT1aXLVcXMbw6TCRyDEjcYCzRHzrnJvVpdGkb`, guardian `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`, funded 698.532782502 XNT, paid 698.529601328 XNT.

| List | State | CID | Snapshot slot | Published | Wallets | Total XNT | Pot XNT |
|---|---|---|---|---|---|---|---|
| 749 | previous | `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` | 88648472 | [3Wo6GFZdyN…](https://explorer.mainnet.x1.xyz/tx/3Wo6GFZdyNYyrVW3WVNkUu7GEGXsN7dV4LTHmM1dYGAHJgB4ZC4MqDwW1TGDmjN7rD48Er9DZRTJ8g9gzz8KYRaU) Oct 26, 2026, 1:43 AM ET | 29 | 690.075017713 | 1.369637897 |
| 750 | previous | `bafkreier6nrdtq32ue5vc3skk7k6gkxcu62ngivkfzage5nqyid7yoarya` | 88748444 | [51VYesy7gS…](https://explorer.mainnet.x1.xyz/tx/51VYesy7gSFYsC1Jj5r2ewJv817zgnYf8Lm7XJRdWnmbE4yQyXLPaetJMwSp5XEfFkGSMe4kjVKNwbY7M49BuWsc) Oct 26, 2026, 11:56 AM ET | 30 | 691.561574893 | 1.486557192 |
| 751 | previous | `bafkreig2d3iqcgtjoz6wcgoqlujpzturbiwhpvopp5tv3tsc7wtsuzprmq` | 88755160 | [2gQXjejmb4…](https://explorer.mainnet.x1.xyz/tx/2gQXjejmb4RTeJ3cLT1YobtALRTB7KYHoMVfgXfWXDzHNkZNp2vfYcoHvJxsp5RwJ8TffnxWDo22DZGor1DgRsNB) Oct 26, 2026, 12:37 PM ET | 30 | 692.611001381 | 1.049426497 |
| 752 | previous | `bafkreif5oxe7xenyq43gujfj3iki5366ewhq7wz4ezhrpxidciamt26xu4` | 88757060 | [23FLqye6Qv…](https://explorer.mainnet.x1.xyz/tx/23FLqye6QvuFVZXirmvyNWffymfo6SoBFKF1TNPMmgafd9whSD3h7ZsEGuHsz5sCfnChCFqtDwrTw2JJP21K3HEm) Oct 26, 2026, 12:49 PM ET | 30 | 694.772410882 | 2.161409511 |
| 753 | previous | `bafkreiggmmj5tuvvjrviakzcm2wgipyjke37hw44jbolykjmwutbohy4gu` | 88772590 | [EAt7M5XCmh…](https://explorer.mainnet.x1.xyz/tx/EAt7M5XCmhHwfUE8rn9AF6yKKnBjkrTVEh1Xoy4jW34fYG5EMmcjavHVqAc21PtECRogR2N6SPtNyvZjBDBVqro) Oct 26, 2026, 2:24 PM ET | 30 | 696.490285999 | 1.717875126 |
| 754 | previous | `bafkreifoa4no36cei5yzow6zbpodqv32u67hnlkc7bgankspjxcagtnxnq` | 88799010 | [zKs7vxhwe3…](https://explorer.mainnet.x1.xyz/tx/zKs7vxhwe3eJ5jabvq7VUehhVZEHAAU5YgrK1XnuKhAEB5H7pd3Lj4L8qD2g295VJgnJWYL9Ros2vFpPqM7HsGx) Oct 26, 2026, 5:06 PM ET | 30 | 697.494796329 | 1.004510343 |
| 755 | active | `bafkreie3ccn4joeupdj2kcv67gpowswtyyffptoljjqndhrtxdjw5l56gm` | 88874439 | [5yfMDYpk3U…](https://explorer.mainnet.x1.xyz/tx/5yfMDYpk3Ut2drQCLoWoudQb8qvChYrru5Yup4L2u5o2WpJnzajomoTrC2qjgSwXAWar7c641kvmzLmxyt4fp8tk) Oct 27, 2026, 12:48 AM ET | 30 | 698.532782491 | 1.037986173 |

## Checks

- ✅ list 749: file served by IPFS hashes to the CID the next list names
- ✅ list 749: file is for this vault, mint and epoch
- ✅ list 749: entries give the root the next list names
- ✅ list 749: entries add up to the file's total (690.075017713 XNT)
- ✅ list 749: publish_list 3Wo6GFZdyNYy… signed by the publisher with this root, total and CID
- ✅ list 749: published (slot 88648479, Oct 26, 2026, 1:43 AM ET) after its snapshot (slot 88648472)
- ✅ list 749: previous list 748 fetched by CID gives the root it names
- ✅ list 749: pot = holdersFunded − Σ start = 1.369637897 XNT
- ✅ list 749: every entry recomputes from the inputs
- ✅ list 749: nobody's total is below the previous list
- ✅ list 749: all 20 balances it used equal the owner's TEST at its snapshot slot 88648472
- ✅ list 749: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 749: every balance used meets minHolding and no excluded owner earns
- ✅ list 750: file served by IPFS hashes to the CID the next list names
- ✅ list 750: file is for this vault, mint and epoch
- ✅ list 750: entries give the root the next list names
- ✅ list 750: entries add up to the file's total (691.561574893 XNT)
- ✅ list 750: publish_list 51VYesy7gSFY… signed by the publisher with this root, total and CID
- ✅ list 750: published (slot 88748451, Oct 26, 2026, 11:56 AM ET) after its snapshot (slot 88748444)
- ✅ list 750: previous list 749 fetched by CID gives the root it names
- ✅ list 750: pot = holdersFunded − Σ start = 1.486557192 XNT
- ✅ list 750: every entry recomputes from the inputs
- ✅ list 750: nobody's total is below the previous list
- ✅ list 750: all 21 balances it used equal the owner's TEST at its snapshot slot 88748444
- ✅ list 750: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 750: every balance used meets minHolding and no excluded owner earns
- ✅ list 751: file served by IPFS hashes to the CID the next list names
- ✅ list 751: file is for this vault, mint and epoch
- ✅ list 751: entries give the root the next list names
- ✅ list 751: entries add up to the file's total (692.611001381 XNT)
- ✅ list 751: publish_list 2gQXjejmb4RT… signed by the publisher with this root, total and CID
- ✅ list 751: published (slot 88755169, Oct 26, 2026, 12:37 PM ET) after its snapshot (slot 88755160)
- ✅ list 751: previous list 750 fetched by CID gives the root it names
- ✅ list 751: pot = holdersFunded − Σ start = 1.049426497 XNT
- ✅ list 751: every entry recomputes from the inputs
- ✅ list 751: nobody's total is below the previous list
- ✅ list 751: all 21 balances it used equal the owner's TEST at its snapshot slot 88755160
- ✅ list 751: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 751: every balance used meets minHolding and no excluded owner earns
- ✅ list 752: file served by IPFS hashes to the CID the next list names
- ✅ list 752: file is for this vault, mint and epoch
- ✅ list 752: entries give the root the next list names
- ✅ list 752: entries add up to the file's total (694.772410882 XNT)
- ✅ list 752: publish_list 23FLqye6QvuF… signed by the publisher with this root, total and CID
- ✅ list 752: published (slot 88757067, Oct 26, 2026, 12:49 PM ET) after its snapshot (slot 88757060)
- ✅ list 752: previous list 751 fetched by CID gives the root it names
- ✅ list 752: pot = holdersFunded − Σ start = 2.161409511 XNT
- ✅ list 752: every entry recomputes from the inputs
- ✅ list 752: nobody's total is below the previous list
- ✅ list 752: all 21 balances it used equal the owner's TEST at its snapshot slot 88757060
- ✅ list 752: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 752: every balance used meets minHolding and no excluded owner earns
- ✅ list 753: file served by IPFS hashes to the CID the next list names
- ✅ list 753: file is for this vault, mint and epoch
- ✅ list 753: entries give the root the next list names
- ✅ list 753: entries add up to the file's total (696.490285999 XNT)
- ✅ list 753: publish_list EAt7M5XCmhHw… signed by the publisher with this root, total and CID
- ✅ list 753: published (slot 88772596, Oct 26, 2026, 2:24 PM ET) after its snapshot (slot 88772590)
- ✅ list 753: previous list 752 fetched by CID gives the root it names
- ✅ list 753: pot = holdersFunded − Σ start = 1.717875126 XNT
- ✅ list 753: every entry recomputes from the inputs
- ✅ list 753: nobody's total is below the previous list
- ✅ list 753: all 21 balances it used equal the owner's TEST at its snapshot slot 88772590
- ✅ list 753: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 753: every balance used meets minHolding and no excluded owner earns
- ✅ list 754: file served by IPFS hashes to the CID the next list names
- ✅ list 754: file is for this vault, mint and epoch
- ✅ list 754: entries give the root the next list names
- ✅ list 754: entries add up to the file's total (697.494796329 XNT)
- ✅ list 754: publish_list zKs7vxhwe3eJ… signed by the publisher with this root, total and CID
- ✅ list 754: published (slot 88799017, Oct 26, 2026, 5:06 PM ET) after its snapshot (slot 88799010)
- ✅ list 754: previous list 753 fetched by CID gives the root it names
- ✅ list 754: pot = holdersFunded − Σ start = 1.004510343 XNT
- ✅ list 754: every entry recomputes from the inputs
- ✅ list 754: nobody's total is below the previous list
- ✅ list 754: all 21 balances it used equal the owner's TEST at its snapshot slot 88799010
- ✅ list 754: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 754: every balance used meets minHolding and no excluded owner earns
- ✅ list 755: file served by IPFS hashes to the CID stored on-chain
- ✅ list 755: file is for this vault, mint and epoch
- ✅ list 755: entries give the on-chain root
- ✅ list 755: entries add up to the on-chain total (698.532782491 XNT)
- ✅ list 755: publish_list 5yfMDYpk3Ut2… signed by the publisher with this root, total and CID
- ✅ list 755: published (slot 88874445, Oct 27, 2026, 12:48 AM ET) after its snapshot (slot 88874439)
- ✅ list 755: previous list 754 fetched by CID gives the root it names
- ✅ list 755: pot = holdersFunded − Σ start = 1.037986173 XNT
- ✅ list 755: every entry recomputes from the inputs
- ✅ list 755: nobody's total is below the previous list
- ✅ list 755: all 21 balances it used equal the owner's TEST at its snapshot slot 88874439
- ✅ list 755: no eligible owner (≥ 1000 TEST then, not excluded, including accounts closed since) is missing
- ✅ list 755: every balance used meets minHolding and no excluded owner earns
- ✅ 30 PaidRecords add up to holders_paid (698.529601328 XNT)
- ✅ holders_paid ≤ list_total ≤ holders_funded
- ✅ nobody was paid more than the active list 755 gives them

## Excluded holders (≥ minHolding now)

- `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU`: 492639285.690921366 TEST (off-curve (program-owned))
- `5GjJLVFfSExiFXJpKY3cUFnnX3UexJBA6AxDA9UGXm4g`: 7441580.04226287 TEST (off-curve (program-owned))
- `44fNpT8DjpYgLzYEZqUHYogJiEreaPXajme2TigHPTnL`: 653666.552096368 TEST (off-curve (program-owned))
- `CWRTWvYTBv3uUkBmLQtp3rXCqM1BQ5nYvoW7XScWuTZS`: 9731.881366941 TEST (vault auth PDA)

## What this does and doesn't show

- The leaf, tree, CID and allocation rules are reimplemented from docs/tax-vault-spec.md, not imported from the site. The leaf sort was added to the spec after an audit found it only in the site's code.
- Snapshot balances are today's balances (read at a known slot) minus every TEST balance change after the snapshot, taken from every transaction that names the mint. That history is complete because TEST's transfer fee makes Token-2022 refuse transfers that don't name the mint; it includes accounts closed since. It trusts the RPC's transaction history; rerun with `--rpc` against another provider to cross-check.
- The builder records its snapshot slot before it scans, so its balances can be from a few slots later; the check accepts one slot between the recorded slot and publication at which every balance matches, and says which.
- An account's owner is the one its transactions report; an owner change (SetAuthority) isn't modelled.
- Program-owned (off-curve) holders are excluded by the token's rules. That is a rule, not evidence of who the tokens inside belong to: TEST held through a router, escrow or smart wallet earns nothing.
- Correct arithmetic doesn't make the rules fair, and point-in-time snapshots can be gamed when a payout outweighs the round-trip tax and price impact at that size and pool depth.
