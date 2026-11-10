# Finalized live source handoff (#144)

`agent/src/indexer/near-data-source.ts` implements the existing BlockSource interface
using the documented [NEAR Data finalized block API](https://docs.fastnear.com/neardata/block)
and [receipt-outcome document examples](https://docs.fastnear.com/neardata/examples).
It ingests receipt execution outcomes, not transaction hashes or incoming receipt
lists. Each event retains its actual executor, receipt ID and block/log ordering.

This is a **finalized-only** source. Its latest head is its available finalized
stream head, not an optimistic network head. Each pass revalidates RPC chain ID and
the pinned genesis block. Every document is compared against the canonical RPC
header and exact shard/chunk set; duplicate/missing shards, mismatched receipt IDs,
wrong receiver/executor, unknown execution status and unsafe numeric boundaries
fail closed. Timestamps come from string nanoseconds, not rounded numeric timestamp.
RPC heights above JS's safe range are refused explicitly; events/IDs remain lossless.

Null data below final head is incomplete, never a successful empty block. A skipped
height is accepted only when a canonical RPC successor's prev_height proves the gap;
successor search is bounded to eight heights. Each request has a 10-second deadline,
two total attempts and a 32 MiB response cap. Live sync ingests at most 20 blocks per
pass. Configuration URLs are HTTPS origins without credentials/query/redirects.
Failures are sanitized and persist degraded health promptly; a prior reconciliation
status is retained. Finalized state is not overwritten on a regression/conflict.

Completeness is **provider-declared**, checked structurally against RPC shard/header
identity. Matching a header is not a receipt/outcome Merkle proof. No code/config
flag can cryptographically certify that the provider omitted no individual outcome.
Require an explicit provider qualification record; consumers still gate canonical
discovery on deployment coverage and #80 acceptance. The public three-block probe
in [deployment evidence](../../../evidence/2026-11-10-application-read-deploy.json)
verifies live transport/schema/header/shard agreement, not exhaustive history or a
funded arena flow. No relevant arena events appeared in those sampled blocks.

## Configuration

The indexer is still off by default. Existing recorded mode remains compatible:
`INDEXER_ENABLED=true` plus `INDEXER_RECORDED_CHAIN=<fixture.json>`; source type is
always recorded, including after restart. A recorded file asserting live identity
is rejected. Select live mode separately:

```dotenv
INDEXER_ENABLED=true
INDEXER_SOURCE=near-data
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://archival-rpc.testnet.near.org
INDEXER_NEARDATA_URL=https://testnet.neardata.xyz
INDEXER_GENESIS_HEIGHT=42376888
INDEXER_GENESIS_HASH=FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b
INDEXER_PROVIDER_EVIDENCE=docs/evidence/2026-11-10-application-read-deploy.json
INDEXER_ANCHOR_HEIGHT=<first-existing-block-to-cover>
INDEXER_ANCHOR_HASH=<parent-hash-of-that-block>
INDEXER_STATE_DIR=./.agent-state/application-live-v1
INDEXER_RETENTION_DEPTH=10000
```

`ARENA_CONTRACT_ID` supplies the first allowed emitter; `INDEXER_CONTRACTS` adds
reviewed companion accounts. Do not set INDEXER_RECORDED_CHAIN in live mode. The
anchor values must come from an actual verified block, not an arbitrary recent
height if complete deployment history is claimed. A changed source mode, genesis,
provider qualification or source identity cannot reopen the same store: the live
source fingerprint is persisted in config and checked. Use a dedicated state
directory; do not relabel or erase an existing journal to bypass the check.

The existing atomic store, locks, retention checkpoint, journal limits and replay
mechanics remain unchanged. New round payload validation is additive; old streams
without these events retain their projection shape/digest. Versioned round payloads
are documented in the [lifecycle handoff](../arena-lifecycle/application-handoff.md).
There is no automatic historical score reconstruction or unbounded backfill service.
Other relevant unmodelled events continue to quarantine/degrade. Future scheduler
(#147), payout (#150) and account (#151) events require their own reviewed handoffs.

## Verification

Injected-transport tests cover network/genesis mismatch, header/shard/receipt gaps,
unsafe numbers, bounded retries, null data, restart/replay, source-mode conflicts,
finality regression and recorded-to-live refusal. Versioned round reducer tests
cover exact negative scores, malformed windows, unknown relevant events and
provisional retraction after restart. These are fixture tests. The separate dated
public source probe and new arena deploy/read verification are live evidence with
the limits stated above. Canonical application discovery remains disabled.
