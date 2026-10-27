# 99 + Tax launch API ({{SITE}})

## Network base URLs

| Network | Base URL | Funds |
|---|---|---|
| Mainnet | https://99tax.vercel.app | Real funds |
| Testnet | https://99tax-testnet.vercel.app | Test funds |

This copy describes **{{NETWORK}}** at **{{SITE}}**. Resolve every endpoint below against that base URL, and send that same origin in POST requests. Confirm `GET /api/info` returns the expected `network`; use its network-specific fees, enabled features and explorer. Keep the same site for the entire launch and any resume. Do not reuse a mint or signed transaction across networks.

All of it is JSON over HTTPS. Every `POST` must send the header `Origin: {{SITE}}`, or the site answers 403 (see [Errors](#errors)). The same API as an OpenAPI 3.0 file, with both servers: [openapi.yaml]({{SITE}}/agents/openapi.yaml).

Transactions come back base64-encoded and unsigned by the creator. Some already carry the site's own signature (step 1 is signed by the new mint's key). Add the creator's signature without dropping the others: with `@solana/web3.js`, `VersionedTransaction.deserialize(bytes)`, then `.sign([keypair])`. Send the signed transaction to `POST /api/send`, which only relays this site's own transactions and waits for confirmation.

## Read

| Request | Returns |
|---|---|
| `GET /api/info` | `network`, `explorer`, the launch fee (`feeAmount`, `feeSymbol`, `feeMint`), `poolCreateFeeXnt`, `gasXnt`, `creatorBps`, `lockForeverOnly`, `launchesPaused`, `quoteTokens` (pairs besides XNT), `taxVault` |
| `GET /api/launches?creator=<wallet>` | this wallet's launches (newest 20), each with `mint`, `symbol` and `status`: `{token, pool, lock, lockNft, taxVault, vault, registered}` |
| `GET /api/tokens` | every registered token on the site |

## Launch

| Step | Request body | Returns |
|---|---|---|
| 1. token | `POST /api/launch/token` with `creator`, `name`, `symbol`, `supply`, `poolTokens` (= `supply`), `taxBps` (100–1000), `autoLpBps` (0–5000), `burnBps` (0–5000, `autoLpBps + burnBps` ≤ 5500), `poolXnt` (decimal string, ≥ 0.01), `lockDays` (`"forever"` or 1–3650), optional `quote` (default `XNT`), `description`, `image`, `website`, `twitter`, `telegram` | `{tx, mint}` |
| 2. pool | `POST /api/launch/pool` `{mint, creator}` | `{tx}` |
| 3. lock | `POST /api/launch/lock` `{mint, creator}` | `{tx}` |
| 4. tax vault (when `status.taxVault`) | `POST /api/launch/vault` `{mint, creator}` | `{tx}` |
| 4b. holder passes (testnet trial, when `status.holderPasses`) | `POST /api/launch/passes` `{mint, creator}` | `{tx}` |
| send each | `POST /api/send` `{tx: <signed, base64>}` (add `vaultMint: <mint>` for steps 4 and 4b) | `{signature}` |
| finish | `POST /api/launch/register` `{mint, creator}` | `{registered}` |

Each step checks the previous one has confirmed and refuses to repeat itself, so a stopped launch is continued by reading its `status` and running the steps still `false`. Step 1 checks the wallet can pay for the whole launch before it charges the fee.

Amounts: `supply` and `poolTokens` are whole tokens (9 decimals on-chain). Basis points: 100 = 1%. `autoLpBps` and `burnBps` are shares of the tax, not of each transfer. The creator gets `creatorBps` (10%) of the tax, and holders get the rest.

Limits per IP address: 120 GETs and 30 POSTs a minute, 20 sends a minute, 10 launches an hour.

## Errors

Recorded from the site's real responses:

| Status | Body | When |
|---|---|---|
| 400 | `{"error": "Invalid symbol"}` (JSON) | a setting is out of range; the message names it |
| 400 | `{"error": "Invalid JSON"}` | the body isn't JSON |
| 400 | `{"error": "Unknown launch"}` | no launch with that mint on this site (wrong site or network?) |
| 400 | `{"error": "Invalid public key input"}` | an address that isn't base58 |
| 400 | `{"error": "Step 1 (token) hasn't confirmed yet."}` | a step out of order; wait, then retry |
| 403 | `Forbidden origin` (plain text) | a POST without `Origin: {{SITE}}` |
| 403 | `Forbidden host` (plain text) | the request came in under an unknown host name |
| 404 | `Not found` (plain text) | an unknown route |
| 429 | `{"error": "Too many requests from this address; try again later."}` | rate-limited; there's no `Retry-After` header, so wait a minute (an hour for launches) |

A 400 from step 1 means nothing was charged. A 400 from `POST /api/send` (for example `Transaction is not fully signed`) means that transaction wasn't sent.
