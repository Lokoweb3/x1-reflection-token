# Liquidity audit: C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz at slot 88653698

Run Oct 26, 2026, 2:15 AM ET with `npx tsx scripts/audit-liquidity.ts` against https://rpc.mainnet.x1.xyz. Shares are of each pool's LP supply now; amounts are what that share of the reserves would withdraw.

Each column is a share of the pool's lp_supply.

| Pool | TEST in pool | Locked (burned or permanent lock) | Timed lock | Free to withdraw |
|---|---|---|---|---|
| TEST/GOOGL.X `RbAdto…` | 72,577,209 TEST | 0.00% | 0.00% | 100.00% |
| TEST/wSOL.X `JCzN5P…` | 31,836,054 TEST | 0.00% | 0.00% | 100.00% |
| TEST/XNT `6FszF7…` | 177,044,053 TEST | 19.07% | 0.00% | 80.93% |
| TEST/SPY.X `Dh97wi…` | 7,431,382 TEST | 0.00% | 0.00% | 100.00% |
| TEST/USDC.X `7drPqa…` | 149,462,713 TEST | 0.00% | 15.62% | 84.38% |
| TEST/META.X `J4TX2Q…` | 6,319,901 TEST | 0.00% | 0.00% | 100.00% |
| TEST/JACK `BkydiV…` | 35,270,147 TEST | 0.00% | 0.00% | 100.00% |
| TEST/OWL ARMY `FsLiDt…` | 11,718,003 TEST | 0.00% | 0.00% | 100.00% |

## Checks

- ✅ TEST/XNT: a simulated withdrawal of 1000000000000 LP pays 5131438392 (XNT base units) = reserves × LP ÷ the pool's lp_supply (÷ the mint's supply would be 5586407349), so burned LP stays in the pool

## Holders

### TEST/GOOGL.X `RbAdtoqyPqKMzNvyPPW68MsEFBGa4P56KmapSCVhSv5`

- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 2640985688417 LP: wallet (free to withdraw)
- `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n` 347706879305 LP: wallet (free to withdraw)
- `H93iy2APCGRYkqAFULUaUAzxzvSwoGwV1fypnwXEGTSu` 100033020218 LP: wallet (free to withdraw)

### TEST/wSOL.X `JCzN5PgCgqVCkPc1PLvKVTw1Kr6M792xMMvBzbbVbMw5`

- `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n` 6838397362144 LP: wallet (free to withdraw)
- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 734814639193 LP: wallet (free to withdraw)

### TEST/XNT `6FszF7uwrujG8vdmxUCyLLAoQMRCUNgoWuebhuzZ6sVn`

- `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n` 405102697355502 LP: wallet (free to withdraw)
- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 316867801034736 LP: wallet (free to withdraw)
- `fzTp5jCHmXaVKiAUwNzX2U9YR5ydiiwyL7zJYFmhTXf` 97467943447989 LP: locked forever (lp_locker) (lock `fzTp5jCHmXaVKiAUwNzX2U9YR5ydiiwyL7zJYFmhTXf`, permanent, fee NFT holder `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n`)

### TEST/SPY.X `Dh97wiRrASnFRpXbsdEBLACvncVxk5xct7KnVTCUTVBV`

- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 214454669267 LP: wallet (free to withdraw)

### TEST/USDC.X `7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD`

- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 8722943296874 LP: wallet (free to withdraw)
- `2KgF1UdGTsAXBA5KWRDwZfraW6r98y2xwWAXdZgm5Syr` 1865166968846 LP: timed lock (8N4E locker) (lock `2KgF1UdGTsAXBA5KWRDwZfraW6r98y2xwWAXdZgm5Syr`, unlocks Oct 4, 2027, 3:43 PM ET, fee NFT holder `undefined`)
- `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n` 994599225508 LP: wallet (free to withdraw)
- `H93iy2APCGRYkqAFULUaUAzxzvSwoGwV1fypnwXEGTSu` 254825975853 LP: wallet (free to withdraw)
- `BZ57aG6v6L3uWcA9WXBAEtrfUFaN77tX4Raw5U5nBAVW` 100000000000 LP: timed lock, expired: withdrawable (lock `BZ57aG6v6L3uWcA9WXBAEtrfUFaN77tX4Raw5U5nBAVW`, unlocks Oct 11, 2026, 3:19 PM ET, fee NFT holder `undefined`)

### TEST/META.X `J4TX2QbwRCThxkH5cNY8vnNQ7k7aBQMg5BDZ8DghhJ2E`

- `DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n` 192137372891 LP: wallet (free to withdraw)

### TEST/JACK `BkydiVjKjbuV8CJKeokn7N6LCTu3fVJfMR6wzTGQtjci`

- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 3878140835838 LP: wallet (free to withdraw)

### TEST/OWL ARMY `FsLiDtArJLoRhQ2d5HA1oMQsY95mwBvSARRBTsAoZzNv`

- `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM` 20486692632589827 LP: wallet (free to withdraw)

## Programs

- XDEX `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`: upgradeable by `cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY`
- lp_locker `5yPQ75TXYoJ8cEMYdDiQsstTnhwcgwm2skJfXPCFBe9C`: upgradeable by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`
- tax_vault `D9jtb7vgd7SAMJeqi97w9mtG8pL7yBizgsChNyb6jHxW`: upgradeable by `53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy`

## What this does and doesn't show

- Burned LP stays in the pool because XDEX divides withdrawals by the pool's own lp_supply, which a token burn doesn't lower; the simulated withdrawal above shows the deployed program doing so. That holds under the current program only: XDEX is upgradeable, and a program that divided by the mint's supply would hand burned liquidity to the remaining LP holders.
- 'Locked forever' for lp_locker likewise means under the current lp_locker program, which is upgradeable (see Programs).
- A permanent lp_locker lock keeps its principal liquidity; the fee NFT's holder can withdraw the LP that fees added since locking.
- An upgradeable program can change these rules; upgrade control is a separate check.
- It trusts the RPC it reads; rerun with `--rpc` against another provider to cross-check.
