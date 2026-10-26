# Creator rewards and operator independence

Run Oct 26, 2026, 2:49 AM ET with `npx tsx scripts/audit-roles.ts` against https://rpc.mainnet.x1.xyz.

## Checks

- ✅ the vault's creator NFT BsR6qa… is an lp_locker lock on the vault's own pool
- ✅ the NFT is one of one (supply 1, no mint authority), held by DWBmisEKJ8kqXJe9GvwZEsggpPG5yZPABq2DAiac5W7n
- ✅ reward vault holds exactly deposited − claimed = vesting + claimable (37.273236)
- ✅ reward vault deposits (37.273236) cover the tax vault's total_reward_out (34.634266); anyone may add more
- ✅ burned 24.9999% of all TEST collected (burn_bps 2500)
- ✅ holders' XNT + crank rewards = 4.0000000 × the creator's (expected 4000/1000)
- ✅ LP's XNT = 1.2500000 × the creator's (expected 1250/1000: half of LP's share stays as tokens)
- ✅ the reward vault's deposits beyond the tax vault's total_reward_out are exactly the other depositors' deposits
- ✅ every deposit and claim in the reward vault's history adds up to its totals
- ✅ simulated pay 0.000994 XNT owed to DX38UJ… by someone with no role: succeeds
- ✅ simulated collect by someone with no role: fails with NothingToCollect (not refused for who the caller is)
- ✅ simulated pay_fallback before its window: fails with FallbackNotActive (expected FallbackNotActive)
- ✅ simulated publish_list by someone with no role: fails with NotPublisher (expected NotPublisher)
- ✅ simulated appoint_publisher by someone with no role: fails with NotGuardian (expected NotGuardian)
- ✅ simulated appoint_publisher by the guardian before Nov 2, 2026, 12:43 AM ET: fails with PublisherActive (expected PublisherActive)

## Who ran the vault recently

Last 300 vault transactions (Oct 25, 2026, 5:33 AM ET – Oct 26, 2026, 1:54 AM ET), by fee payer:

- publisher (operator): pay ×227, publishList ×14, fundCreator ×52, addLiquidity ×45, sell ×52, collect ×52
- 53fTZRZmMMbgWLxkLMtxgECNXcd1iXbVw8aNKrT7RxKy: fundCreator ×1, sell ×1, collect ×1

## List files on public gateways

- `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` ipfs.io: not served
- `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` dweb.link: not served
- `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` w3s.link: not served
- `bafkreide2574msxsswgfoz3osvzuc7lyqrntdrwtx4mgewjrt6rlo4zghe` gateway.pinata.cloud: served, bytes match

## What this does and doesn't show

- The windows are the deployed program's (reproduced from `7f2097d` without features); the simulations show the deployed code enforcing them now, not that it can't be upgraded (see audits/upgrades).
- A simulation uses a funded address with no role as fee payer; signatures aren't checked and nothing is sent.
- Fallback payouts need each wallet's proof, so the list file must stay retrievable. A gateway serving it today says nothing about who keeps pinning it, and a gateway refusing it (429 = rate-limited, 504 = timed out) doesn't show it's gone.
- Recent fee payers show who did run the vault, not who could; anyone may run the permissionless steps.
