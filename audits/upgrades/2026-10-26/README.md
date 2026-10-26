# Upgrade control audit

Run Oct 26, 2026, 2:21 AM ET with `npx tsx scripts/audit-upgrades.ts` against https://rpc.mainnet.x1.xyz.

| Program | Upgrade authority | Kind | Deploys/upgrades | Last deployed |
|---|---|---|---|---|
| tax_vault `D9jtb7…` | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Oct 1, 2026, 3:26 AM ET |
| lp_locker `5yPQ75…` | `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Sep 27, 2026, 9:06 PM ET |
| XDEX `sEsYH9…` | `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 3 | Jan 7, 2026, 3:34 AM ET |
| 8N4E locker `8N4E3Z…` | `9ssu2qKWm3HXijnBYm951ZuyDdhnZnzynoc5bkiP3Ryc` | plain key: one private key signs upgrades; no on-chain multisig or timelock | 1 | Oct 4, 2026, 4:13 AM ET |
| Token-2022 (TEST) `Tokenz…` | `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7` | program-derived address (only its program can sign; not a recognised multisig) | 0 | — |
| SPL Token (LP mints) `Tokenk…` | — | none: can no longer be upgraded | 0 | — |

## Checks

- ✅ tax_vault: newest deploy/upgrade found (slot 82790170) is programdata's last-deployed slot 82790170, so none is missing
- ✅ lp_locker: newest deploy/upgrade found (slot 82022808) is programdata's last-deployed slot 82022808, so none is missing
- ✅ XDEX: newest deploy/upgrade found (slot 21171632) is programdata's last-deployed slot 21171632, so none is missing
- ✅ 8N4E locker: newest deploy/upgrade found (slot 83503000) is programdata's last-deployed slot 83503000, so none is missing

## History

### tax_vault

- Oct 1, 2026, 3:26 AM ET: DeployWithMaxDataLen by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`, `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW` ([tx](https://explorer.mainnet.x1.xyz/tx/3QfDcFWHF5CYUozTPeeSYZNxzXBsqaqiJtJeedWzk5CeKADZ2itx6ZWUd8BhP3NJUskZkPT1uHBpiDebFSRzqavG))
- deployed code: 590361 bytes, sha256 `076656a3ec87af390244260ac4e8b4c665f51753b5028fde3fdc2e3670082a43`

### lp_locker

- Sep 27, 2026, 9:06 PM ET: DeployWithMaxDataLen by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`, `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C` ([tx](https://explorer.mainnet.x1.xyz/tx/4x8mLvNT3F1JV5FvFTt97r2z1tNFMuyh8RDHYk71wLYYZJ52TAaNHcatvv1fhjiY9tsPcTBhx2Rx3ZarnMXAqcX7))
- deployed code: 554761 bytes, sha256 `0fa9bb8849069005b9090b00a62fa820d7612d7c6e9e5d36ca2cec113babdc3c`

### XDEX

- Jan 7, 2026, 3:34 AM ET: Upgrade by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/2R6B6EQA44LAAMeWGSrKDJxsCJGK7k1ZZm4MEq5BUgV7aTdczMqcL2jA3xqrQNSocDje7ixo4b6GoRAMLCnU9gdE))
- Jan 7, 2026, 3:04 AM ET: Upgrade by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/2vHjV4vnWxtoaVsTnURq1hrMBKybzz3SXwKTEkyN8J4qjNoTburHHaWGc5KsbB7qLkE1oN3LPkTASpzBsjYRfBUx))
- Jan 7, 2026, 3:04 AM ET: ExtendProgram by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` ([tx](https://explorer.mainnet.x1.xyz/tx/3MmcmM5iPmbLKJM9hQjL1ozGMET2vZxRJZUVFRpyr6DoHvDo5rikto93SR6HpRoA9Fg1tm6B5JrtrBeg4ThCuGmg))
- Dec 1, 2025, 1:14 AM ET: DeployWithMaxDataLen by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY`, `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` ([tx](https://explorer.mainnet.x1.xyz/tx/4G7u4bkMHgb7E6r4tfhekPVGGJZ3wzjB1ji3VHdQ3RNa7qMQcFxX3J6kDuXXq7CKXBh4GjN1i3rDDBehhA4nDmY6))
- deployed code: 520457 bytes, sha256 `8d9118e42b1f64f175f31b27d89c6b77e4ee26387b929ce468b0396ff56f813e`

### 8N4E locker

- Oct 4, 2026, 4:13 AM ET: DeployWithMaxDataLen by `9ssu2qKWm3HXijnBYm951ZuyDdhnZnzynoc5bkiP3Ryc`, `8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf` ([tx](https://explorer.mainnet.x1.xyz/tx/58sXcyyywevVq7j7rLcnCTMzfoyh4twxffuTeKTZ2eAS1QDLFWLRKTHEg6127VCMp2PgUNiHtBcTQzvPAXbvYpcM))
- deployed code: 410529 bytes, sha256 `236ade6f1c57cb3f34ed00df29680ce51e68abdf25e7476c9ece4f2d5f17eb28`

### Token-2022 (TEST)

- note: no deploy or upgrade transaction exists (programdata says slot 0): it was installed by the runtime (genesis or a feature activation), so its history can't be checked here
- deployed code: 683529 bytes, sha256 `154c5568ca08a7d8e7704370bf5e6508cb699d033eaeb02c77ad43a4ef25a0c4`

### SPL Token (LP mints)

- note: no deploy or upgrade transaction exists (programdata says slot 85798112): it was installed by the runtime (genesis or a feature activation), so its history can't be checked here
- deployed code: 108585 bytes, sha256 `435df1e70f1ca6258eb01a4507701688c7f1a22656e3e4ef361db473bf478075`

## What this does and doesn't show

- A plain-key authority's signature can't be constrained on-chain: there is no multisig or timelock to verify. Who holds the key is an off-chain fact.
- The code hash identifies what is deployed; it ties to source only through a reproducible build of a known commit (`--compare`).
- It trusts the RPC it reads; the last-deployed slot check guards against a truncated history.
