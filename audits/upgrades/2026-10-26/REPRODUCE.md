# Reproducing the deployed mainnet programs

Run 2026-10-26 in clean `git worktree` checkouts. Nothing was deployed or changed on-chain.

| Program | Source | Build sha256 (bytes) | Chain |
|---|---|---|---|
| tax_vault `D9jtb7vg…` (v3) | `7f2097d` | `25e9881f2cc77f0b07f218d64f4abc57b4fa9ad6ed3dc3f18304cc38332ad6f4` (590,376) | byte-identical, no padding |
| lp_locker `5yPQ75TX…` | `7f2097d`, and again at `285489a` (main) | `f25f916e5bc82687533b81b5eeefdc99b9834b7e5256d3af2380a57c5859074b` (554,776) | byte-identical, no padding |

Pinned build inputs:
- `cargo-build-sbf` from Agave **3.1.15** (`solana-cargo-build-sbf 3.1.15`, release src `40a31afe`),
  platform-tools **v1.52**, rustc **1.89.0**;
- each commit's own `lp-locker/Cargo.lock`;
- no `--features`: these are the mainnet network constants.

The deployed ELFs embed only relative source paths (`programs/<name>/src/lib.rs`) and the platform-tools CI's standard-library paths, so the checkout directory doesn't change the bytes.

```bash
git worktree add --detach /tmp/src 7f2097d && cd /tmp/src/lp-locker
cargo-build-sbf --manifest-path programs/tax_vault/Cargo.toml --sbf-out-dir /tmp/tv
cargo-build-sbf --manifest-path programs/lp_locker/Cargo.toml --sbf-out-dir /tmp/lp
cd - && npx tsx scripts/audit-upgrades.ts --compare tax_vault=/tmp/tv/tax_vault.so --compare lp_locker=/tmp/lp/lp_locker.so
```

`--compare` passes only when the deployed account's bytes start with the build, byte for byte, and everything after it is zeros.

What this does and doesn't establish:
- The deployed code is what this source and toolchain produce. Reading that source is a separate review.
- The lp_locker source is unchanged from `fd136f3` through `main`, so `main` is what runs.
- `main`'s tax_vault source is **not** what runs. It carries v4 changes made after `7f2097d`. To review the deployed tax_vault, read `7f2097d`.
- XDEX and the 8N4E locker aren't in this repository, so their deployed code isn't tied to any source here.
