# Lifecycle views and indexing handoff (#144 to #143, #149, #151)

Fixture and unit-test evidence only. Nothing here is live provider or deployment proof.

## Contract reads (arena)

| Method | Returns | Notes |
| --- | --- | --- |
| `get_lifecycle_battle_v2(battle_id: U64)` | `{schema_version: 2, battle_id: "<u64>", battle: LifecycleView} \| null` | `battle` is the v1 view; ids are decimal strings |
| `get_lifecycle_battle_count_v2()` | `"<u64>"` | ids run from 1 to this value |
| `get_lifecycle_position_v2(battle_id: U64, community: u32, account)` | `{registered, amount: "<u128>"}` | same as v1 |
| `get_lifecycle_readiness()` | `{schema_version: 2, paused, lifecycle_activated, oracle, protocol, fee_bps, creator_share_bps, observation_policy_configured}` | stored facts only; no backing or custody claim |
| `get_lifecycle_round_commitment(battle_id: U64, round_id: U64)` | hex sha256 or `null` | `null` = unknown battle, not finalized, or finalized before the commitment existed |

v1 methods are unchanged. Schema version 2 only ever gains fields. A reader that sees a higher `schema_version` than it knows must keep unknown fields out of its UI and keep working with the fields it knows.

## Event `round_finalized` (standard `valtrum`, version `1.0.0`)

```json
{"schema":"round-finalized-v1","battle_id":"1","round_id":"2","outcome":"winner","winner":0,
 "next_candidates":[],"start_ns":"1000","end_ns":"2000","policy_hash":"pol",
 "commitment":"4f93bb7b193a54cb56f5ab4301ddf3e76bd12593c8f4026d4c92a1e40779a1fc",
 "scores":[{"community":0,"evidence_hash":"h0","negative":false,"numerator":"10","denominator":"100"},
           {"community":2,"evidence_hash":"h2","negative":true,"numerator":"5","denominator":"100"}]}
```

The sample is the cross-language vector (Rust test `the_commitment_matches_the_cross_language_vector`, TypeScript `test/indexer/round-finalized.test.ts`). Scores are exact fractions in decimal strings; do not convert them to JS numbers. `outcome` is `winner` or `overtime` (`pending` never emits).

## Indexer projection (`projection-v1`)

`BattleActivity.rounds?: RoundEntry[]` (canonical order): `roundId`, `outcome`, `winner`, `nextCandidates`, `startNs`, `endNs`, `policyHash`, `commitment`, `scores[]`, `ref` (`finalized` is derived from the finalized height). The key is absent until the first event, so a journal without it is byte-identical to before. The indexer accepts the event only if the recomputed commitment equals the emitted one; otherwise it quarantines it as `malformed_payload` and health degrades.

## Completeness and freshness semantics for readers

- **Complete** for a round: a `round_finalized` event is in the indexed journal and its commitment matches `get_lifecycle_round_commitment`.
- **Incomplete** (show as such, never invent values): a round whose battle has a recorded winner or overtime but no event in the journal (finalized before the event existed, or outside the indexed range), or a `null` commitment on a round the contract reports as finalized.
- **Indexer health** (`healthy`, `pending`, `degraded`, `reconciliation_required`) and the source label (`recorded` or `live`) decide how much a projection may be trusted. A `live` source is finalized blocks from neardata with provider-asserted finality.
- Backfill: nothing is reconstructed. The live source starts at the operator's `INDEXER_ANCHOR_HEIGHT`; earlier history is not covered.

## Live source configuration (agent)

`INDEXER_ENABLED=true`, `INDEXER_SOURCE=live`, `INDEXER_ANCHOR_HEIGHT=<first block>`, `INDEXER_ANCHOR_HASH=<hash of the block before it>`, optional `INDEXER_NEARDATA_URL` (https) and `INDEXER_MAX_BLOCKS_PER_SYNC` (default 200); `INDEXER_NEARDATA_API_KEY` is a secret. Do not set `INDEXER_RECORDED_CHAIN` in this mode.

## Open and not done

- No live provider qualification: the real neardata service's archive depth, retention, rate limits under load and null-body behavior for skipped heights are untested here. The adapter treats any unprovable null as `incomplete`.
- Arena settlement and other newly reviewed events are not added to the reducer.
- Scheduler (#147) and payout (#150) event coordination: the payout events were already modelled; #147 should emit through the same `round_finalized` path and must not rely on the event for anything but history.
