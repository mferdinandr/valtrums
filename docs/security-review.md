# Security review and target threat model

This documentation is **not an external audit or a new security certification**. Historical findings summarize the earlier development self-review of arena, router, Ref adapter, mock DEX and mock FT at the [base commit](current-state.md). Previously reported unit/sandbox checks were not rerun for this documentation PR and do not cover the planned Robinhood arena.

## Historical scope and findings

The earlier checklist covered caller checks, private callbacks, updates before cross-contract calls, one-yocto checks, storage prefixes, initialization, arithmetic, pagination and sandbox lifecycle/gas. Its statement about no panic paths is not a source-wide guarantee: the arena uses validation panics. No new callback/panic audit is asserted here.

| ID | Historical severity | Finding and historical disposition |
| --- | --- | --- |
| H1 | Low | Missing deposit-window bounds; reported fixed with 1-second to 30-day bound/tests |
| H2 | Medium | Contract-funded storage lets dust positions consume NEAR. Accepted for legacy testnet; storage funding/minima/monitoring still needed |
| H3 | Medium | DEX/router proceeds authenticated by value rather than exclusive message identity. Legacy min_out bounds displacement; stronger receipt/balance reconciliation needed |
| H4 | Medium | Malicious selected token can fake deposit reports; heuristic audit is not a sell simulation |
| H5 | Medium | Agent-reported execution trusts realized amounts; compromised key can inflate rewards |
| H6 | Low | Dispatched DEX step that never pays has no arena reset; agent logs stuck step |
| H7 | Low | Unregistered burn recipient can fail legacy burn; funds remain in arena with event |
| H8 | Low | Native JSON integer IDs assume values below 2^53 |
| H9 | Low | Late routed deposits become stranded; beneficiary uses claim_stranded |
| H10 | Informational | Open-mint mock FT and fixed-rate DEX are demo fixtures |
| H11 | Medium | Ref adapter balance-delta measurement can count concurrent donations as output; previously accepted, stronger attribution needed |
| H12 | Low | Serialized adapter swaps can stall later swaps; retry/owner-clear needs operational review |
| H13 | Low | Receiver-returned adapter coins require owner recovery |
| H14 | Informational | Project-funded testnet prices are fixtures, not independent market prices |

Legacy owner controls agents/configuration; agent controls audit/prices/timing; foreign execution reporting is trusted; TWAP/baselines use local history. Legacy session expiry is client-side. Method/receiver/gas restrictions do not bound token losses.

Standalone WAR/furnace, deployment key removal, target representations/custody/DAO, GoPlus, MCP, NEAR AI and Robinhood integration are outside that historical review.

## Target trust boundaries

The target requires authenticated source receipts, versioned audit/observation policy and constrained MPC payloads. The receipt verifier/custody mechanism and finality assumptions are OPEN; treat these as trusted dependencies until implemented evidence proves otherwise.

| Threat | Required target control | Outstanding verification |
| --- | --- | --- |
| Fake/replayed deposit, donation contamination, decimal inflation | Actual received units, unique chain/tx/log identity, attribution, exact normalization | Adversarial tokens, reorgs, verifier trust |
| Underbacking or duplicate spend | Per-asset B = M + E + P + D + U and exclusive reservations | Conservation/property/recovery tests |
| 30-second oracle manipulation | Frozen sources, endpoint/cadence policy, provenance, exact scores, complete coverage | Supply trust, wash-volume and manipulation limits OPEN |
| Late/duplicate scheduling | Immutable interval, expected round/state checks, once-only transitions | Outage/restart/repeated-overtime tests |
| Audit fail-open | Critical GoPlus risk rejects; unknown mandatory data stays Pending; independent LP > USD 10,000 | Use the [selected field map](goplus-audit.md); audit policy v1 fixes tax/admin admissibility and evidence lifetime; coverage and live-change behavior remain OPEN |
| Creator/protocol spoofing | Actual mandatory creator stake and frozen authenticated fee identity | Protocol verification policy OPEN |
| Arbitrary MPC transaction | Exact chain/token/recipient/amount/path/nonce from reservation | Tampering, signer, nonce/replacement/gas tests |
| Lost response / duplicate payout | Durable identity and reserve; reconcile before new spend; finalized matching receipt | Restart reconciliation worker (read and report only, never holds the operator key; startup refuses operator variables) covers crash, timeout, same-transaction rebroadcast, replacement, revert and mismatched evidence with fixtures only; a pending `needs_operator` report depends on a human or separate operator process acting; live node, finality tag support and concurrent workers are unverified |
| Principal seizure or silent release | Independent escrow, no automatic timeout, decision-bound single execution | Upgrade authority OPEN. DAO (D22): only the contract tally of authenticated winner votes decides; no quorum, so a single voter can decide; with no votes, principal stays escrowed |
| Player-agent theft | Enforceable token cap, method/asset/destination scope, expiry/revocation | Leaked key, malicious strategy, concurrent spend |
| Infrastructure gains player authority | Separate credentials and role checks | Negative authorization tests across APIs/MCP |
| Prompt injection | Typed bounded actions, canonical preview hash and revalidation | Metadata/provider injection and mismatch tests |
| Indexer reorg/stale status | Finalized cursor/hash, provisional labels, replay/reconciliation | Finality policy/recovery drills |
| Storage/gas exhaustion | Pagination, funded storage, bounded work with continuation | Limits OPEN; cannot impose an overtime cap |
| Tax/rebase/admin token risk | Actual receipt credit, explicit eligibility policy, deficit detection | Audit policy v1 applies (tax at most 5%, renounced-only admin); short receipt cannot count as full payment |
| Operator/signer compromise | Least privilege, disclosed powers, constrained signing, monitoring | Rotation/revocation and incident response |

Rewards remain independent of DAO decisions while still requiring valid backing and payout authorization. Available rights must never imply confirmed Robinhood receipt.

## TEE provenance

The current /attestation endpoint reports operator metadata, not cryptographic remote attestation. A target TEE service needs verified workload/hardware evidence, image identity and bound secret release. NEAR AI inference verification is separate from verification of the entire custody/scheduler service. Neither authenticates market data or grants spending permission.

## Required work before target live acceptance

- Specify/review custody proofs, finality, reorg recovery, reservations and upgrade controls.
- Resolve audit policies and GoPlus testnet coverage; exercise unknown data and strict LP threshold.
- Test all scoring modes, signed/rational edges, gaps and unlimited overtime.
- Prove token conservation, decimal safety, payout retries, redemption/disposal exclusion and DAO independence.
- Enforce player budget/expiry/revocation and reject infrastructure-role crossover.
- Review deployed artifacts/account powers, provenance, monitoring and recovery runbooks.
- Independently review the implemented target; historical risk acceptance does not carry forward automatically.

[Roadmap](implementation-roadmap.md) and [OpenSpec tasks](openspec/README.md) track unfinished work. This PR moves no funds and deploys no contracts.
