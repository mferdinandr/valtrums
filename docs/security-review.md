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
| Underbacking or duplicate spend | Per-asset B = M + E + P + D + U + X (X = principal escrow) and exclusive reservations | Conservation/property/recovery tests |
| 30-second oracle manipulation | Frozen sources, endpoint/cadence policy, provenance, exact scores, complete coverage | Supply trust, wash-volume and manipulation limits OPEN |
| Late/duplicate scheduling | Immutable interval, expected round/state checks, once-only transitions | Outage/restart/repeated-overtime tests |
| Audit fail-open | Critical GoPlus risk rejects; unknown mandatory data stays Pending; independent LP > USD 10,000 | Use the [selected field map](goplus-audit.md); audit policy v1 fixes tax/admin admissibility and evidence lifetime; coverage and live-change behavior remain OPEN |
| Creator/protocol spoofing | Actual mandatory creator stake and frozen authenticated fee identity | Protocol verification policy OPEN |
| Arbitrary MPC transaction | Exact chain/token/recipient/amount/path/nonce from reservation | Tampering, signer, nonce/replacement/gas tests |
| Lost response / duplicate payout | Durable identity and reserve; reconcile before new spend; finalized matching receipt | Restart reconciliation worker (read and report only, never holds the operator key; startup refuses operator variables) covers crash, timeout, same-transaction rebroadcast, replacement, revert and mismatched evidence with fixtures only; a pending `needs_operator` report depends on a human or separate operator process acting; live node, finality tag support and concurrent workers are unverified |
| Principal seizure or silent release | Independent escrow, no automatic timeout, decision-bound single execution | Escrow (#73): backing `escrow` bucket recorded only by the arena, once per battle. Execution (#75): escrow leaves only through arena releases derived from the contract tally (returns to winners' entitlements, the burn to a disposal reservation for a sink set once by the backing owner); release ids are once-only and bounded by the escrow; a burn is confirmed only by a finalized debit to the sink and is never released back. Lows: a failed backing call's deposit stays with the arena (as in settlement); the owner must verify the sink accepts transfers before setting it, since it cannot change. Sandbox-tested with fixtures. Upgrade authority OPEN. DAO (D22): only the contract tally of authenticated winner votes decides; no quorum, so a single voter can decide; with no votes, principal stays escrowed |
| Player-agent theft | Enforceable token cap, method/asset/destination scope, expiry/revocation | Leaked key, malicious strategy, concurrent spend |
| Infrastructure gains player authority | Separate credentials and role checks | Negative authorization tests across APIs/MCP |
| Prompt injection | Typed bounded actions, canonical preview hash and revalidation | Metadata/provider injection and mismatch tests. Action boundary (#76): requests are strictly validated (unknown fields refused); model output is never an authorization; only a NEP-413 signature over the exact preview hash (single-use nonce) or a grant delegate's on-chain `reserve` authorizes; `prepare` refuses any change in the binding hash; the service holds no key; a receipt must match the prepared signer, receiver, method, arguments and deposit. Fixture-tested. |
| Indexer reorg/stale status | Finalized cursor/hash, provisional labels, replay/reconciliation; persisted reorg suspension of confirmations until finality returns; every allowlisted event projected or reported degraded; retention checkpoint (a summary) that never prunes provisional blocks or dedup keys and re-verifies on restart (#109) | Finality policy/recovery drills; live provider evidence; journal growth bounded only by its event limit |
| Storage/gas exhaustion | Pagination, funded storage, bounded work with continuation | Limits OPEN; cannot impose an overtime cap |
| Open arena join, cancel and refund (D34 to D37) | Protocol-only allowlist (one yocto, 64 entries, exact identity, still needs a trusted backing); join, register and deposit closed at the start; lock only after the start over at least two funded communities with fresh approvals; permissionless cancel only below two funded; pull refunds of the caller's own position with rollback on a failed transfer | Sandbox-tested, including a redeploy over the previous wasm. Residual: a funded community whose approval lapses blocks both lock and cancel until the agent refreshes it (backing refresh on by default); registered but unfunded positions leave orphaned storage after a cancel; battles without a start time cannot be cancelled; three new events are not yet modelled by the indexer. Not deployed |
| Tax/rebase/admin token risk | Actual receipt credit, explicit eligibility policy, deficit detection | Audit policy v1 applies (tax at most 5%, renounced-only admin); short receipt cannot count as full payment |
| Operator/signer compromise | Least privilege, disclosed powers, constrained signing, monitoring | Rotation/revocation and incident response |
| Single-key protocol authority | A SputnikDAO council (simple majority) holds the protocol account and the backing owner; automated roles and the deploy key stay outside it | Sandbox test with the official SputnikDAO 3.31 wasm ([sputnik-authority.md](sputnik-authority.md)). Residual: the deploy-key owner can re-point the protocol and redeploy (R1); the factory owner can update factory-created DAOs unless `auto_update` is disabled (R2); council compromise controls fee up to 10%, window and sinks (R4); the registry now needs the protocol account (D33); backing pause needs a council vote; fee withdrawal to EVM is a known gap. Not deployed |

Rewards remain independent of DAO decisions while still requiring valid backing and payout authorization. Available rights must never imply confirmed Robinhood receipt.

### Escrow reservation self-review (#73)

Development self-review with the NEAR contract checklist, not an external audit. No high or medium finding. `on_reserve_escrow` is `#[private]`; `reserve_principal_escrow` accepts only the arena; arena state changes only in the callback, and concurrent calls are safe because the backing is idempotent per escrow id; new storage keys are appended. Low: the backing's unused storage refund, and the deposit of a failed backing call, return to the arena rather than the caller (same as settlement); the arena pays the storage of its escrow flag.

## TEE provenance

The current /attestation endpoint reports operator metadata, not cryptographic remote attestation. A target TEE service needs verified workload/hardware evidence, image identity and bound secret release. NEAR AI inference verification is separate from verification of the entire custody/scheduler service. Neither authenticates market data or grants spending permission.

## Creator escrow self-review (D41, 2026-11-11)

Scope: `contracts/arena/src/creator_escrow.rs` and its wiring (`ft_on_transfer` message `lifecycle_create`, the conversion hooks in `submit_lifecycle_audit` and the backing refresh, the cancel rule in `open_arena.rs`). This is a manual review of the diff against the NEAR detector list (non-private callback, reentrancy, unsaved changes, owner check, one yocto, storage collision, gas griefing, storage cost, unsafe math). It is **not an external audit**; no NEAR-specific static analyser was run, only `cargo clippy -D warnings` and the unit tests. It was done before the sandbox tests of the new path exist, so items marked "to prove" are not yet exercised on a sandbox.

| ID | Severity | Finding and disposition |
| --- | --- | --- |
| E1 | Checked, no finding | `on_lifecycle_escrow_refund` is `#[private]`; the escrow is removed before the `ft_transfer` and restored by the callback on failure, so a repeated claim cannot pay twice (unit tests). `lifecycle_storage_withdraw` reduces the balance before the transfer |
| E2 | Checked, no finding | Entry points: storage withdraw and escrow claim need one yocto and the caller to be the owner or creator; conversion is internal and reachable only from the two agent-authenticated approval calls. `ft_on_transfer` trusts `predecessor` as the token only if it is on the protocol allowlist |
| E3 | Checked, no finding | New storage keys are appended at the end of `StorageKey`; no field of `Arena`, `Battle`, `Community` or `Snapshot` changed. Maps written by the new code are flushed. To prove: the redeploy-over-old-state sandbox test |
| E4 | Medium, accepted with mitigation | The escrow holds user tokens before any approval. Only conversion and a refund to the creator release it; both remove the record first. A battle whose creator community is never approved can be cancelled by anyone after the start, so other depositors are not locked in. To prove: sandbox test of that cancel with two funded communities |
| E5 | Low | A creator cannot take the escrow back before the start (up to 7 days) even by mistake; the only exit is conversion or cancel plus refund. Accepted: an early exit would allow a battle with no creator deposit. |
| E6 | Low | Storage freed when the escrow record is deleted at conversion stays with the contract; the participant index entry added at conversion is also contract-paid. Both are small and the net is about neutral. Not refunded to the creator |
| E7 | Low | A validation failure after state writes (short prepaid storage, a mode without an observation policy) panics, which reverts the call and makes the token return the whole transfer. This relies on the token's `ft_resolve_transfer` treating a failed receiver as a full refund (true for NEP-141). The unit-test mock keeps writes of a panicking call, so this is only proven on a sandbox |
| E8 | Low | Conversion silently stays undone when the participant index is full (`TooManyParticipants`); it is retried at the next approval call. The battle cannot lock without the creator position, so it fails closed |
| E9 | Informational | Prepaid storage can be credited to any account (`lifecycle_storage_deposit` beneficiary). It only adds NEAR to that account's own balance |

Not covered: gas of the creation call on a sandbox (must fit the 100 Tgas the token forwards), a malicious allowlisted token, and any interaction with the agent audit pass. Open before the contract PR is merged: the sandbox tests behind E3, E4 and E7.

## Required work before target live acceptance

- Specify/review custody proofs, finality, reorg recovery, reservations and upgrade controls.
- Resolve audit policies and GoPlus testnet coverage; exercise unknown data and strict LP threshold.
- Test all scoring modes, signed/rational edges, gaps and unlimited overtime.
- Prove token conservation, decimal safety, payout retries, redemption/disposal exclusion and DAO independence.
- Enforce player budget/expiry/revocation and reject infrastructure-role crossover.
- Review deployed artifacts/account powers, provenance, monitoring and recovery runbooks.
- Independently review the implemented target; historical risk acceptance does not carry forward automatically.

[Roadmap](implementation-roadmap.md) and [OpenSpec tasks](openspec/README.md) track unfinished work. This PR moves no funds and deploys no contracts.
