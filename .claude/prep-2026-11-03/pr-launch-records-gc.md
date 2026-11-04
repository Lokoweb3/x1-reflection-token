# PR draft: not opened

**Title:** Launch records: removal needs the journal's finalized proof, not one plain read
**Branch:** `audit-launch-records-gc` at `19af09c`
**Base:** merge #29 first, then base on `main`. This branch contains #29 (`597116d`) and uses its `provenNeverLanded`, so it can't merge alone. Until then, target `audit-followups`.

## Why
`gcLaunchRecords` removed `launches/<mint>/`, including `distributor.json`, for an unregistered launch over a day old after one `confirmed` read. A lagging node answering null could destroy a landed launch's only distributor key and strand its tax. Reproduced through the real flow.

## What changes
- Removal needs the proof journals use: a finalized read past the step's last valid block height, with mint and wallet in one response.
- `launches/<mint>/step.json` carries that evidence over. Written key, step, record, with the journal removed last. `launch.json` is unchanged.
- Records with no evidence are kept and logged once per server start.
- `provenNeverLanded` is stricter: a missing slot, a missing `context.slot`, a wrong-length answer, or any non-null wallet account counts as no proof. This also affects journal cleanup.

## Evidence
- Fresh clone at 19af09c: 415/415 TS tests, `tsc` clean.
- With the fix reverted, 12 of 38 tests in the two affected files fail. 17 single-line mutations caught.
- Codex: FIXED, approve for this scoped fix. It read the code and ran no tests.
- Fakes only: no real RPC, chain or server.

## After deploy
- Every existing record has no `step.json`, so none is removed automatically again. Each is logged once per start, and may name a healthy token.
- For each logged mint: read mint and wallet at `finalized`. If the mint exists, leave it. If neither exists, archive the directory rather than deleting it, because it holds a key. Don't hand-write `step.json`.

## Rollback
Safe per reading: old code treats `step.json` as "got further" and keeps the record.

## Unverified on X1
`minContextSlot` at finalized, `getEpochInfo` block height, `lastValidBlockHeight` scale, zero-lamport accounts reading null. If any fails, nothing is removed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
