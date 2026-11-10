# Application read v1 handoff (#143)

**#144 update:** the additive string-ID ABI and versioned readiness/stored-history
views below are now implemented and consumed when `abi.version` is explicitly
`lifecycle-application-v1`; no method-error fallback is used. See the
[lifecycle handoff](../arena-lifecycle/application-handoff.md) and
[live-source handoff](../arena-testnet-integrations/live-source-handoff.md) for actual
new testnet deployment/read evidence, reducer verification and remaining live gates.
The original #143 inventory/verification below is retained as its source snapshot.
Canonical application discovery and task 3.3 remain gated on complete deployment
coverage and cross-service acceptance, rather than the limited public probe alone.

This is source/fixture verification, not deployment verification. The implementation
extends `agent/src/mcp/{cli,http}.ts` and `web/src/lib/arena-read/{proxy,search-controller}.ts`.
There is one HTTP process, not a parallel read service. Existing `/tools`, `/session`
and optional `/actions` contracts and account ownership checks remain available.

## Inspected ABI and reuse

| Existing seam | Reused behavior | Remaining boundary |
| --- | --- | --- |
| `mcp/read-source.ts` | Exported lifecycle battle and current-round views | `get_lifecycle_battle` argument and count are bare u64; reject IDs/counts outside safe JS range |
| `mcp/search.ts` | Query validation, modes/statuses, default 20/max 50, scan 200 | V1 facade adds full namespace and snapshot cursors; old numeric cursor contract stays on `/tools` |
| Lifecycle communities | Exact chain/representation/custody identity, vault, audit hashes/expiry, backing hash | No duplicate expiry, implied backing verification or cosmetic eligibility |
| `get_lifecycle_round` | String round ID/window, candidate indices, recorded winner | No exact-score/history reconstruction; missing round read is a partial detail |
| `reference-registry.ts` | On-chain versioned registry, hashes, consistency checks, max 256 entries | Registry membership is not current audit/backing eligibility; mainnet discovery beyond this reference registry remains unsupported |
| `audit/report-query.ts` | Historical verdict, TTL freshness, reference-token limitations | Archive v1 lacks network/protocol; requires explicit scoped producer handoff |
| Web read gateway/controller | Allowlisted forwarding, no-store, abort and 300 ms debounce | V1 adds namespace checks and immediately invalidates requests during debounce |
| Existing web ArenaApi | Explicit legacy or demo UI | Opted-in application mode uses its own DTO/list and does not reinterpret lifecycle state as A/B |

## Public contract

`agent/src/mcp/application-contract.ts` is the shared exported DTO/type boundary;
the web imports its types only. `ApplicationEnvelope<T>`, `Namespace`,
`ApplicationBattleSummary` and `ApplicationPage<T>` are the handoff to #146/#149/#151.
Runtime manifest/ABI validation stays on the server. `integer(value, 64|128)`
accepts canonical decimal strings or safe nonnegative integers, enforces unsigned
range, and rejects rounded JSON numbers before coercion. Battle IDs are positive.
Community indices are bounded ordinary integers; amounts and u64 IDs/times use strings.

Implemented GET routes, at both agent HTTP and Next gateway:

| Path under `/api/arena/v1/` | Query/result |
| --- | --- |
| `capabilities` | No query; validated public manifests and per-capability support/reasons; canonical discovery disabled |
| `health` | `deployment`, `protocol`; per-component dependency probes, support/reasons and explicit noncanonical status |
| `battles` | Namespace plus `q`, `mode`, `status`, representation `community`, `limit`, `cursor`; bounded string-ID summaries |
| `battles/:id` | Namespace; validated raw lifecycle state/current round, nullable readiness/history and missing-section reasons |
| `assets` | Namespace plus `q`, `limit`, `cursor`; trusted reference-registry identities/hashes and `eligibility=notEstablished` |
| `battles/:id/audits` | Namespace plus community index, `limit`, `cursor`; historical observations, TTL classification and currentApproval=notEstablished |

These names intentionally reuse existing search parameters, not the illustrative
`query/pageSize` proposal. Defaults remain **20/50**, with at most 200 recent battle
IDs scanned per request. A count above 200 yields `truncated=true`, a partial reason
and pagination only within that recent window; it does not claim exhaustive
discovery. An outage returns a bounded 503, without an empty-success/demo fallback.
Unsupported capability is 422; unknown route is 404; invalid/foreign cursor is 400;
snapshot invalidation is 409 with an instruction to restart. Unknown/duplicate
parameters are rejected. Errors contain a request ID and no upstream exception text.

No caching is introduced. Query identity includes all namespace fields, resource
and filters. Cursors additionally bind normalized filters/default limit, ABI evidence
and a deterministic digest of the bounded read projection. Registry snapshots bind
their version and entry hashes; archive cursors bind scoped observations. A changed
projection invalidates cursors. RPC scans are **not atomic canonical snapshots**;
they cannot establish block coverage, finality or a canonical discovery watermark.
Origins are fixture/rpc for direct reads and aggregate for archives; individual
archive fixture/recorded/live labels survive. Acquisition time is distinct from
nullable observation time. Archive responses retain observation references and
sequence watermark, which is an archive watermark, never a chain watermark.

## Configuration/runbook

Build with `pnpm build`; run the existing `pnpm -F @valtrum/agent read:serve`.
Existing `NEAR_NETWORK`, `ARENA_CONTRACT_ID`, `READ_SESSION_SECRET` and
`READ_SESSION_RECIPIENT` configure compatible tool/session routes. Supply the
session secret through local secret configuration; it is not a financial signing
key. New optional `ARENA_APPLICATION_MANIFEST_PATH` points to a JSON array such as
[application-manifest.example.json](application-manifest.example.json). The example
contains placeholders, **not a verified deployed address or code hash**. The service
constructs view-only clients per declared network. RPC failure never changes adapter.
Use a new immutable deployment ID when network/address/protocol/ABI changes.

For a dedicated recorded fixture, set `adapter=fixture` explicitly and supply
`ARENA_APPLICATION_FIXTURE_PATH`. Exactly one fixture deployment is permitted per
fixture file; its shape is `{battles:[{id:"1",battle:<LifecycleView>,round:null}],registry:[]}`.
At most 200 fixture records and 256 registry entries are loaded. The loader validates
all fixture ABI fields and rejects duplicate/unsafe IDs. Fixture labels are enforced
by binding, not selected from a contract address. Missing/malformed files fail startup.

The producer's `AUDIT_REPORT_ARCHIVE_PATH` and reader's `AUDIT_ARCHIVE_PATH` must name
the **same archive file**. To enable application audit reads, set the manifest audit
capability and provide `ARENA_APPLICATION_AUDIT_SCOPE` as a JSON namespace, for example:

```json
{"deploymentId":"arena-testnet-read-v1","network":"near-testnet","arenaContract":"configured-arena.testnet","protocol":"lifecycle-v2"}
```

This is an explicit operator handoff because archive v1 cannot prove network/protocol.
Do not attach a mixed-network archive to it. Responses disclose that limitation;
this flag cannot upgrade recorded evidence into live evidence. No binding means
unsupported (422); missing/unreadable file means unavailable (503); a readable archive
without a matching observation means missing; expired historical passes retain their
verdict with expired freshness and never establish current approval. Archive storage
continues to use the existing 100,000-observation/64 KiB-per-record bounds and retention
policy; no database, pruning policy or migration is added here.

Web server: `ARENA_READ_API_URL=http://127.0.0.1:8790` (server-only). To opt the web
list into application reads, build with `NEXT_PUBLIC_ARENA_READ_DEPLOYMENT`,
`NEXT_PUBLIC_ARENA_READ_PROTOCOL=lifecycle-v2`, `NEXT_PUBLIC_NEAR_NETWORK=testnet`
and matching `NEXT_PUBLIC_ARENA_CONTRACT_ID`. Wrong/missing namespace data is an error,
not demo selection. `/arena` renders backend pages. Unsupported pages explicitly
show unavailable in this read-only mode, and no wallet action controls are exposed.
Without this opt-in, the established legacy/demo provider selection remains separate.
Text search resets its cursor, debounces 300 ms, aborts superseded requests and ignores
old responses even during debounce. Namespace changes discard the previous result;
same-namespace pending/error views label prior data stale. Client abort reaches the
gateway upstream fetch; the agent still bounds scans independently.

## Dependent handoffs and release gates

- **#144:** proposed compatible additions are `get_lifecycle_battle_count_v1() -> U64`
  and `get_lifecycle_battle_v1({battle_id:U64}) -> Option<LifecycleView>`, plus a reviewed
  activation/paused/config/backing-readiness view and canonical projection snapshot
  metadata. These are requests for owner review, **not methods implemented or assumed
  by this PR**. Old methods remain usable in the safe range. Safe detail outside that
  range is disabled. `canonicalDiscovery.enabled` is unconditionally false until the
  safe views/live source are integrated and independently verified.
- **#145:** archive reader schema is `audit-report-archive-v1` / `audit-report-v1`.
  Preserve observationId, arena/community identity, source label, reference identity,
  immutable verdict, TTL and limitations. Fixture restart tests exercise actual
  configuration and on-disk producer/consumer handoff; they are not live proof.
- **#146:** extend the versioned route allowlists deliberately for observation reads;
  reuse namespace/envelope and preserve market source times/coverage. No observation
  persistence or route exists in this foundation.
- **#149:** current-round summary is optional; exact score/history/readiness are null
  with reasons. Extend versioned DTOs without passing lifecycle data to legacy ArenaApi.
  No financial create/deposit/settlement action is implemented by this read mode.
- **#151:** private account reads stay on existing session-protected tools. V1 has no
  account/payout routes or generic contract proxy. Extend with existing account
  ownership validation and exact asset units, not public forwarding of private data.

No live deployment/indexer/archive integration was verified in #143. The gate remains
recorded explicitly in task 3.3; it does not prevent reviewing the independent read
boundary. Final cross-service live acceptance stays with #80 and prerequisite owners.

## Verification record

Implemented from main `d2cc933` (including PR #153), in an isolated worktree to
preserve unrelated local changes. Checks on 2026-11-10:

- `rtk proxy pnpm typecheck`: both packages pass.
- `rtk proxy pnpm -F @valtrum/agent test`: 71 files / 725 tests pass.
- `rtk proxy pnpm -F @valtrum/web test`: 22 files / 230 tests pass.
- `rtk proxy pnpm build`: agent and Next production build pass.
- From docs, `rtk proxy openspec validate --all --strict --no-interactive`:
  14 items pass.
- `rtk git diff --check`: clean.

Failure tests cover unsafe boundaries, namespace collisions, changed/foreign cursors,
bounded search, current-round failure, registry outage, dependency health, archive
scope/TTL/foreign arena, producer-file restart, absent archive, gateway allowlists,
session ownership and responses arriving during debounce. These use injected
providers and recorded fixtures. No browser automation, contract deployment,
activation, database schema operation or financial transaction was performed.
