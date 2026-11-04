# Second RPC for the quorum tool's --verify-rpc

Checked 3 Nov 2026, read-only. **No independent public HTTPS provider verified.** The tool's requirement stays as is.

| Endpoint | Result | Independent of the official RPC? |
|---|---|---|
| `https://rpc.mainnet.x1.xyz` | Official. Regional load balancer (`x-lb: …infrafc.org`), Interserver IPs, node identity `2skZy1Hi` | The primary |
| `http://67.217.48.178:8899` | Same identity `2skZy1Hi` | **No: same node, as far as it reports** |
| `http://204.13.232.66:8899` | Different identity, same host company as the official balancer | Weak |
| `http://135.181.57.237:8899` | Hetzner, `2hPwCh4m`. Finalized TEST vault bytes and the Squads program hash **match** the official RPC | **Candidate.** Operator unknown; **no TLS** |
| `http://65.109.20.83:8899` | Hetzner, `FNRi5MH6`. Healthy, but a finalized read failed | Not usable yet |
| `rpc.x1.ninja` | Timed out | Not verified |
| `rpc.x1galaxy.io`, `rpc.owlnet.dev` | Connection refused | Not verified |
| `rpc.xolana.xen.network`, `x1-mainnet.xen.network` | TLS failure | Not verified |
| `xolana.xen.network` | **Wrong genesis: testnet.** The tool would refuse it | No |

Those hostnames were my guesses to probe, not listed providers. X1's docs name only the official endpoint.

The cluster advertises 363 nodes with RPC. Of the first 80, 75 answered and 73 were healthy, across several hosts. They're plain HTTP validators whose operators haven't offered a service.

## Limits
- A node reports its own identity, and hosting company doesn't identify the operator. **I can't prove separate upstream infrastructure** for any of these.
- Plain HTTP means anyone on the network path can alter answers, which matters for exactly the attack this check is for.

**Superseded 3 Nov 2026: no second RPC and no node.** The owner runs against the official RPC only and accepts the risk; see `onchain-check-plan.md`. Kept for the record.

## Options
1. **Your own read-only node** on separate infrastructure (docs.x1.xyz has a guide). Strongest: you control it. Costs a server.
2. **A named operator:** ask X1's team or a validator you trust for a TLS endpoint, and record who runs it.
3. **A public validator like `135.181.57.237`:** usable today, but only detects a lying official RPC, not a network attacker or a collusion.

**This doesn't clear the tool.** Codex's remaining blocker survives any second RPC if both lie.
