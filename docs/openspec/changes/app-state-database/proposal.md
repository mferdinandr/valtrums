## Why

The read API and the workers keep user-facing state in local files: the action store (`actions.json`, rewritten whole on every change and capped at 10,000), the append-only audit report archive, player agent state and the watchdog liquidity baselines. The web app runs on a serverless host and cannot read worker disks, files have no managed backup, and several processes in the dev stack share one directory only by convention. Postgres on the Supabase project `valtrum-near` gives these a shared, structured, backed-up home.

## What Changes

- **Target:** the action store, the audit report archive, the player agent state and the baseline store each get a Postgres implementation behind their existing interface, selected by a database URL. The file implementations stay for tests and local use.
- **Target:** every current invariant is kept: idempotent action identity and atomic read-modify-write, an immutable append-only audit history keyed by `observationId`, fail-closed on a malformed store and no silent reset.
- **Target:** audit report history becomes queryable by arena, battle, community and time, which the report server uses instead of scanning a file.
- **Target:** row-level security on with no public policy; only the service roles that already own each store connect.
- **Target:** one-time import commands move existing files into the tables.
- Not moved: the observation journal (hash-chained, fsync and lock based), the indexer store and the oracle status. Their integrity or recovery design is tied to local files and is a separate decision.
- Depends on `hosted-agents-database` for the connection settings, the repository pattern and the migration process.

## Capabilities

### New Capabilities

- `app-state-persistence`: durable Postgres storage for actions, audit report observations, player state and baselines with the same guarantees as the file stores.

### Modified Capabilities

None. The behavior of each store does not change; where it is kept does.

## Impact

- `agent/src/mcp/actions/store.ts`, `agent/src/audit/report-archive.ts` (and `report-query.ts`, `report-server.ts`), `agent/src/player/state.ts` and `agent/src/baseline.ts` gain Postgres implementations.
- New migrations under `supabase/migrations/`; new secrets `ACTION_DATABASE_URL`-style variables, held only by the services that use them.
- The web app is unchanged: it keeps calling the read API.
- Open: whether the action store and the report archive are used in production yet (order of work), and the retention of audit observations (see design.md).
