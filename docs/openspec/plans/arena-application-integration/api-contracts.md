# Proposed application API contracts

Cross-change reference, not the scope of one release. The read-API change owns the
base envelope/capabilities/list/detail/asset/audit/health surface; market observations
owns history routes; lifecycle FE owns its read/action adapter integration; Portfolio
owns its account/payout client slice. Canonical preview/authentication/MCP services
remain owned by `arena-mcp-terminal` and `arena-player-agents`.

More specifically, lifecycle frontend owns the read-service extension for round
history/current-round enrichment; market owns observation history; portfolio owns
settlement and account extensions. The read API foundation is not required to
implement these downstream routes to complete its own scope. Private action
journal reads belong to the MCP/player authorization workstream.

**All `/api/arena/v1/*` routes and DTOs in this file are proposed, not implemented.**
Existing HTTP routes remain the terminal parse/funding routes, agent health routes,
and separate `/audit-reports` reader listed in [integration-map.md](integration-map.md).
New routes are same-origin Next gateway routes backed by a read-only application
service. They are not generic proxies for contract methods or privileged workers.

## Identity, encoding and response envelope

Every query supplies `deployment=<allowlisted-id>&protocol=legacy-v1|lifecycle-v2`
except the deployment/capability listing. A deployment is immutable/versioned and
resolves network, arena address/code hash, source network and companion contracts.
Every resource/cache/action identity retains that namespace and a decimal-string
battle ID. A token symbol, logo or bare numeric ID is never a lookup authority.

All u64/u128 values, unit amounts, scaled observations and ns/ms timestamps use
decimal strings; signed score numerators permit a leading `-`, denominators are
positive strings. Community indices are bounded integers. Byte arrays in the current
ABI use reviewed hex↔[u8] codecs; the API cannot forward arbitrary malformed arrays.

Actual `ScoringMode` wire variants are `PriceGain`, `MarketCapGrowth`, `VolumeRatio`
and `LowestDrawdown` (`contracts/arena/src/lifecycle.rs`). UI labels/fixture keys
must map explicitly to these variants; the illustrative enum names in older
`docs/interfaces.md` are not the source ABI.

Illustrative envelope (placeholders, not live values):

```json
{
  "schemaVersion": "arena-application-v1",
  "namespace": {
    "deploymentId": "near-testnet-arena-dev-v1",
    "network": "near-testnet",
    "arenaContract": "configured-arena.testnet",
    "protocol": "lifecycle-v2"
  },
  "provenance": {
    "kind": "rpc",
    "blockHeight": "123",
    "blockHash": "source-block-hash",
    "finality": "finalized",
    "fetchedAtMs": "1800000000000",
    "observedAtMs": null,
    "readModelVersion": "snapshot-opaque-version",
    "health": "healthy",
    "complete": true,
    "reasons": []
  },
  "data": {}
}
```

Allowed provenance kinds distinguish `fixture`, `rpc`, `indexed`, `market` and
`aggregate`; aggregate subsections carry their own envelope/provenance. Finality
is `finalized`, `provisional`, `unknown` or `not-applicable`, never inferred from
HTTP 200. `observedAtMs=null` does not become `fetchedAtMs`. Health includes
healthy/pending/degraded/reconciliation-required/unavailable. A successful partial
read labels missing sections and reasons; it cannot render an empty account balance
or complete market coverage where the service failed.

Errors: `{schemaVersion, error:{code,message,retryable}, requestId}` with no keys,
raw RPC URLs containing credentials or provider HTML. Codes include `invalid_query`
(400), `not_authenticated` (401 for private records), `forbidden` (403), `not_found`
(404), `snapshot_changed`/`stale_preview`/`idempotency_conflict` (409),
`unsupported_capability` (422), `rate_limited` (429), `upstream_unavailable` (503).
Unsupported optional sections remain explicitly unavailable; they do not silently
switch protocol or fixture mode. Preserve existing audit reader error semantics
inside its adapter and translate them to this public envelope.

## Read route matrix

| Proposed route | Parameters / result | Adapter source |
| --- | --- | --- |
| `GET /api/arena/v1/capabilities` | Allowlisted deployments, protocol/ABI versions, independently enabled reads/actions/modes, unavailable reasons | Verified deployment manifest + per-service evidence/health; not owner private config |
| `GET /api/arena/v1/battles` | Namespace, `query`, `status`, `creator`, `assetKey`, `sort`, `cursor`, `pageSize`; `{items,nextCursor,pageSize}` | Backend indexed/current read model; no FE fetch-all loop |
| `GET /api/arena/v1/assets` | Namespace, `query`, eligibility/mapping filters, cursor/pageSize | Trusted asset registry + metadata/evidence adapters; dropdown backend search |
| `GET /api/arena/v1/battles/:id` | Battle identity, raw versioned state, communities, supported mode, snapshot/readiness, derived display phase and provenance | Actual legacy or lifecycle ABI + labeled current round/settlement sections |
| `GET /api/arena/v1/battles/:id/rounds` | Cursor/pageSize; recorded windows/candidates/outcomes/exact score references | Reviewed new round history views/events + persisted evidence; unavailable until implemented |
| `GET /api/arena/v1/battles/:id/rounds/:roundId/observations` | Community filter, `fromNs`, `toNs`, `after`, cursor/pageSize; ordered samples, gaps, coverage, nextCursor | Durable observation archive, exact namespace/policy/round binding |
| `GET /api/arena/v1/battles/:id/audits` | Community, freshness, policy/evidence filters, cursor/pageSize | Existing report query/server plus current on-chain audit reference/expiry |
| `GET /api/arena/v1/battles/:id/settlement` | Allocation progress and per-token references, not guessed paid balances | `get_settlement_progress`, backing allocations and indexed verified outcomes |
| `GET /api/arena/v1/accounts/:account/positions` | Namespace, battle/community filter, cursor/pageSize | Legacy position or lifecycle registration/credit views with asset mapping |
| `GET /api/arena/v1/accounts/:account/entitlements` | Available/reserved/late balances grouped by actual source asset | Backing entitlement/reservation/late-balance views; do not sum different token units |
| `GET /api/arena/v1/accounts/:account/payouts` | State/battle/backing filters, cursor/pageSize | Payout views + indexed historical requests; open-only list is not complete history |
| `GET /api/arena/v1/accounts/:account/principal` | Held principal by battle, governance capability and decision refs if supported | Lifecycle principal fields; DAO decision unavailable until implemented |
| `GET /api/arena/v1/actions/:actionId` | Wallet-scoped preview/submission/credit/receipt status | Non-secret action journal + contract/receipt revalidation; authenticate private records |
| `GET /api/arena/v1/health` | Per-component capabilities, lag, source/finality and pending reasons | Separate health adapters; no secret settings or claim of financial correctness |

Reuse report pagination defaults: 20 items, capped at 100. Invalid/nonpositive page
sizes fail validation. Observation queries are equally bounded and paginated; multiple
communities may return aligned pages but cannot require downloading all stored data.
Opaque cursors bind namespace, normalized filter/sort digest, snapshot version and
last stable item identity. Sort ties use deterministic resource IDs. Invalidated
cursors after a canonical reorg return `snapshot_changed` and a restart instruction.

## Minimum normalized records

`BattleRecord`: string ID; protocol; creator; trusted community array; supported
mode; raw contract fields; `displayPhase` with authority/reason; locked snapshot/
policy reference; current round if readable; recorded winner nullable; section
completeness; available actions with capability/precondition reasons. A lifecycle
record does not acquire a legacy bond, credit balance or deposit deadline by default.

`CommunityRecord`: stable community index/key; actual source chain/token; representation
account/decimals; custody domain; mapping version/hash; optional explicit mainnet
reference chain/token; symbol/icon provenance; exact credited vault units; audit/
backing evidence and quality. Cosmetic model identity is separate from eligibility.

`RoundRecord`: battle key + string round ID, actual candidate keys, start/end ns,
mode/policy hash, raw chain outcome and transaction/block reference, exact scores
if available, worker pending reason with its own source. No client timer-derived
winner, score or fabricated historical window. Missing fields stay nullable.

`ObservationRecord`: stable sample/evidence identity, community, round/mapping/policy,
source/pool/quote/scale, observed time nullable, acquisition time, source block/hash
nullable, integer-scaled price/supply/volume where valid, evidence hash, quality and
gap/revision references. Superseded/provisional evidence cannot masquerade as canonical.

`ChartResponse`: interval, fresh baseline reference, supported mode, samples through
the actual observation watermark, latest acquisition/observed watermark separately,
coverage/maximum-gap result, provisional exact scores and independently recorded
round result. Price/cap scores preserve signs; volume ratio's display conversion is
explicit; drawdown prefers lower scores and cannot treat unknown as zero. Legacy
spot-against-TWAP charts retain that label and are not target point-price evidence.

`PortfolioRecord`: asset/units and beneficiary, distinct available/reserved/pending/
confirmed/restored amounts, source receipt/payout/request IDs, principal-held amounts
separately, latest verified block/finality and unknown reasons. Never create “total
received” from a signature or broadcast. Public on-chain information stays public;
private off-chain annotations/actions require ownership-bound authentication.

## Canonical action preview and user submission

Proposed `POST /api/arena/v1/action-previews` is non-executing and typed by handler:
legacy propose/deposit/claim/withdraw; lifecycle create/register/claim-receipt/
claim-representation/deposit-representation/request-payout/request-late-refund.
This is an application registry, not arbitrary `receiver/method/args` forwarding.
Resolve permitted receivers and assets from the deployment/registry, not the prompt.

Preview response binds stable action ID, wallet identity, protocol/deployment,
typed input and integer units, actual ABI version/method/receiver/args, recipient/
refund binding, prerequisites, transaction sequence, exact/estimated costs labeled,
expected state/round/mapping/policy, expiry, canonical hash and a no-execution flag.
Persist immutable public binding data; never wallet secrets or raw authenticated
provider configuration. Unavailable prerequisites return reasons and no signable action.

The FE displays deterministic review and signs via the existing wallet sender.
If submission journaling is added, proposed `POST /api/arena/v1/actions` accepts a
wallet-authenticated action ID/hash and transaction references or a separately
validated bounded grant. It does not accept an operator credential or arbitrary
private key. Repeated same idempotency identity with changed content fails; ambiguous
network responses reconcile the same action/request before new submission.

Action states distinguish `previewed`, `awaiting_wallet`, `submitted`,
`receipt_pending`, `position_credit_pending`, `confirmed`, `rejected`, `failed`,
`reconciliation_required`. Payout financial states remain the actual contract enum,
not collapsed into these action states. Wallet cancellation cannot render success.
Revalidate before signing/submission and use contract guards at execution; a preview
is not an atomic reservation or a promise that a state race cannot reject the call.

No public action handler exposes oracle observation submission, registry attestation,
owner activation, operator payout confirmation/restoration or DAO disposition.
Future MCP calls use the same typed preview/action records only after the owning
user-authorization workstream implements grant scope, budgets, expiry and revocation.

## Frontend synchronization

- Query identity includes deployment/protocol, resource, normalized filters and account.
- Debounce text search 300 ms; reset cursor on changed filters; pass AbortSignal to
  gateway/upstream and reject responses from superseded query generations.
- Retain a visibly stale prior view during a transient error; do not replace it with
  a fake zero balance or silently create a demo battle. Discard another namespace's data.
- Poll deltas from a server-issued cursor; stop hidden-tab polling, resume with
  revalidation and backoff on errors. SSE is a later optional transport, not assumed.
- Reorg/snapshot changes clear provisional *projections* and reload authoritative
  views; they never reset user request IDs or forget in-flight financial obligations.
- Chart hover/pause/camera selection is local presentation. Backend clock, frozen
  observations, winner, settlement and deposit authorization remain independent.
