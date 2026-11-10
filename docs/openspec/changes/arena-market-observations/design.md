## Context

Existing chart series are fixtures; the legacy runtime samples into memory and uses a TWAP policy. Target lifecycle rounds require frozen, mode-specific evidence. The current main market reader does not establish Robinhood coverage simply because its client library accepts aliases. See the [source inventory](../../plans/arena-application-integration/integration-map.md).

## Goals / Non-Goals

**Goals:** persist qualified samples, expose bounded history and connect honest charts to real evidence.

**Non-Goals:** qualify providers, implement oracle scheduling, change scoring rules or declare four-mode live acceptance. Those belong to [testnet integrations](../arena-testnet-integrations/tasks.md) and the [scoring spec](../../specs/arena-scoring/spec.md).

## Decisions

1. Persist an append journal before publication, with atomic manifests, bounded retention/capacity and deterministic replay/deduplication. Reuse archive conventions rather than add a database now. Corruption/conflicts degrade service. Any future database migration needs separate approval before generation and application.
2. Key evidence by full deployment/protocol/battle/round/community and frozen mapping/policy versions. Normalize addresses according to chain rules; retain source and reference identities. Acquisition time never substitutes for unknown provider observation time.
3. Extend the foundation read service/BFF with bounded observation queries, cursors, revisions, gaps and watermarks. Default two-second display polling is a UX proposal, not a provider sampling guarantee. Background collection continues while visuals pause; rejected/retracted evidence invalidates affected projections explicitly.
4. Deliver price display first when its provider evidence qualifies. Market-cap requires circulating supply, volume requires exact interval trades/counters plus initial cap, and drawdown requires qualified ordered coverage. Rolling 24-hour volume and FDV are not substitutes. The service consumes qualification output; its tests cannot self-certify live providers.
5. Display exact rational score inputs separately from floating-point chart coordinates and recorded contract outcomes. Legacy spot/TWAP comparison remains labeled legacy; unavailable evidence remains a gap. The chart never picks a winner or drives payout.

## Risks / Trade-offs

- Source cadence misses boundaries → retain incomplete coverage and pending resolution instead of interpolating authoritative endpoints.
- Storage grows → explicit capacity alarms and bounded queries; do not silently remove evidence needed for unresolved rounds.
- Reorg changes provisional evidence → cursor revision/snapshot reconciliation, preserving financial request identity.
- Trust escalation → collector/read service receives no custody, oracle-signing, payout-operator or player authority. Oracle submission consumes persisted evidence through the independently authorized scheduler.

## Migration Plan

Verify journal replay and recorded histories before enabling a chart deployment capability. Enable qualified modes independently; disable chart delivery on failure without changing contract lifecycle. Fixtures remain an explicit separate source. No contract or database migration is authorized here.

## Open Questions

Provider coverage/cadence, reference mappings and live acceptance remain owner gates. DAO policy and unresolved audit recovery decisions remain OPEN; neither is inferred from chart state.
