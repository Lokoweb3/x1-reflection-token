# Upgrade control audit

Run Oct 26, 2026, 2:29 AM ET with `npx tsx scripts/audit-upgrades.ts` against https://rpc.mainnet.x1.xyz.

| Program | Upgrade authority | Kind | Deploys/upgrades | Last deployed |
|---|---|---|---|---|
| tax_vault `D9jtb7…` | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Oct 1, 2026, 3:26 AM ET |
| lp_locker `5yPQ75…` | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Sep 27, 2026, 9:06 PM ET |
| XDEX `sEsYH9…` | `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 3 | Jan 7, 2026, 3:34 AM ET |
| 8N4E locker `8N4E3Z…` | `9ssu2qKWm3HXijnBYm951ZuyDdhnZnzynoc5bkiP3Ryc` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Oct 4, 2026, 4:13 AM ET |
| Token-2022 (TEST) `Tokenz…` | `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7` | program-derived address (only its program can sign; not a recognised multisig) | 0 | — |
| SPL Token (LP mints) `Tokenk…` | — | none: can no longer be upgraded | 0 | — |

## Checks

- ✅ tax_vault: latest deployment corroborated: the newest deploy/upgrade found (slot 82790170) is programdata's last-deployed slot
- ✅ tax_vault: deployed bytes are tax_vault.so (sha256 25e9881f2cc77f0b…, 590376 bytes)
- ✅ lp_locker: latest deployment corroborated: the newest deploy/upgrade found (slot 82022808) is programdata's last-deployed slot
- ✅ lp_locker: deployed bytes are lp_locker.so (sha256 f25f916e5bc82687…, 554776 bytes)
- ✅ XDEX: latest deployment corroborated: the newest deploy/upgrade found (slot 21171632) is programdata's last-deployed slot
- ✅ 8N4E locker: latest deployment corroborated: the newest deploy/upgrade found (slot 83503000) is programdata's last-deployed slot

## History

### tax_vault

- Oct 1, 2026, 3:26 AM ET: DeployWithMaxDataLen by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`, `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` ([tx](https://explorer.mainnet.x1.xyz/tx/3QfDcFWHF5CYUozTPeeSYZNxzXBsqaqiJtJeedWzk5CeKADZ2itx6ZWUd8BhP3NJUskZkPT1uHBpiDebFSRzqavG))
- program account: 590376 bytes, sha256 `25e9881f2cc77f0b07f218d64f4abc57b4fa9ad6ed3dc3f18304cc38332ad6f4` (reproduced: build sha256 `25e9881f2cc77f0b07f218d64f4abc57b4fa9ad6ed3dc3f18304cc38332ad6f4`)

### lp_locker

- Sep 27, 2026, 9:06 PM ET: DeployWithMaxDataLen by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`, `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` ([tx](https://explorer.mainnet.x1.xyz/tx/4x8mLvNT3F1JV5FvFTt97r2z1tNFMuyh8RDHYk71wLYYZJ52TAaNHcatvv1fhjiY9tsPcTBhx2Rx3ZarnMXAqcX7))
- program account: 554776 bytes, sha256 `f25f916e5bc82687533b81b5eeefdc99b9834b7e5256d3af2380a57c5859074b` (reproduced: build sha256 `f25f916e5bc82687533b81b5eeefdc99b9834b7e5256d3af2380a57c5859074b`)

### XDEX

- Jan 7, 2026, 3:34 AM ET: Upgrade by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/2R6B6EQA44LAAMeWGSrKDJxsCJGK7k1ZZm4MEq5BUgV7aTdczMqcL2jA3xqrQNSocDje7ixo4b6GoRAMLCnU9gdE))
- Jan 7, 2026, 3:04 AM ET: Upgrade by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/2vHjV4vnWxtoaVsTnURq1hrMBKybzz3SXwKTEkyN8J4qjNoTburHHaWGc5KsbB7qLkE1oN3LPkTASpzBsjYRfBUx))
- Jan 7, 2026, 3:04 AM ET: ExtendProgram by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/3MmcmM5iPmbLKJM9hQjL1ozGMET2vZxRJZUVFRpyr6DoHvDo5rikto93SR6HpRoA9Fg1tm6B5JrtrBeg4ThCuGmg))
- Dec 1, 2025, 1:14 AM ET: DeployWithMaxDataLen by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY`, `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` ([tx](https://explorer.mainnet.x1.xyz/tx/4G7u4bkMHgb7E6r4tfhekPVGGJZ3wzjB1ji3VHdQ3RNa7qMQcFxX3J6kDuXXq7CKXBh4GjN1i3rDDBehhA4nDmY6))
- program account: 526600 bytes, sha256 `f39c656dbb85ebf8c0d8259d2f8c89732132ebda2ef5cbf0a5ddbb34097fbe82`

### 8N4E locker

- Oct 4, 2026, 4:13 AM ET: DeployWithMaxDataLen by `9ssu2qKWm3HXijnBYm951ZuyDdhnZnzynoc5bkiP3Ryc`, `8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf` ([tx](https://explorer.mainnet.x1.xyz/tx/58sXcyyywevVq7j7rLcnCTMzfoyh4twxffuTeKTZ2eAS1QDLFWLRKTHEg6127VCMp2PgUNiHtBcTQzvPAXbvYpcM))
- program account: 410544 bytes, sha256 `c42c95d200043eb7befcea18033ad2ef3db5904e6195c0d60abec881f31d1e66`

### Token-2022 (TEST)

- note: no deploy or upgrade transaction exists (programdata says slot 0): it was installed by the runtime (genesis or a feature activation), so its history can't be checked here
- program account: 683544 bytes, sha256 `d32c6364ed5d2a0ad68a8f4b04baff9b24d2b7e60df1bcdd1894071d07d69de6`

### SPL Token (LP mints)

- note: no deploy or upgrade transaction exists (programdata says slot 85798112): it was installed by the runtime (genesis or a feature activation), so its history can't be checked here
- program account: 108600 bytes, sha256 `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697`

## What this does and doesn't show

- A plain-key authority's signature can't be constrained on-chain: there is no multisig or timelock to verify. Who holds the key is an off-chain fact.
- The code hash identifies what is deployed; it ties to source only through a reproducible build of a known commit (`--compare`; see REPRODUCE.md when present). A build that doesn't match proves nothing about the source by itself: toolchain, flags, features and dependencies change the bytes.
- The last-deployed slot check corroborates the latest deployment only; earlier history is as complete as the RPC's signature index. It trusts the RPC it reads.
