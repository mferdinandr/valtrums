## Why

The observation journal is the evidence the lifecycle oracle resolves every round from and the read API draws every battle chart from, yet it lives only in `journal.jsonl` on the collector's disk. The collector, the oracle and the read API must therefore share one machine and one directory, the evidence has no managed backup (a lost disk means rounds that can no longer be resolved and charts that answer 503), and both readers replay the whole file on every pass (the oracle about once a second). `app-state-database` deliberately left the journal, the indexer store and the oracle status on local files "as a separate decision"; this change is that decision for the journal and the oracle status, now that the other application state already lives in Postgres.

## What Changes

- **Target:** an observation journal in the application Postgres database (`APP_DATABASE_URL`), behind the same writer and reader interfaces as the file journal, selected by an explicit `OBSERVATION_JOURNAL_STORE=database`. The file journal stays the default, and for tests and local use.
- **Target:** every journal invariant is kept: append-only and immutable in the database itself, the per-record hash chain from genesis (any edit, reorder or gap is corruption, never reset), one writer at a time (a database lock replaces `journal.lock`), a record is acknowledged only after it is durable (the commit replaces fsync plus manifest), deduplication by observation id, refusal of a second observation for the same source evidence slot, retractions that never erase, and finite capacity that is a visible error with nothing pruned.
- **Target:** readers load the journal once and then only the records after the head they hold, verifying the chain as they go, instead of replaying everything on every pass.
- **Target:** the lifecycle oracle status (`status.json`) gets an optional Postgres home with the same single-process guard, so the read API can show it without sharing the oracle's disk. It stays non-authoritative.
- **Target:** a one-time import moves an existing `journal.jsonl` into the table with its sequence numbers and hashes unchanged, and refuses a journal that does not verify.
- **Target:** the collector and the oracle receive `APP_DATABASE_URL` and the switch (today only the agent and the read API get the URL).
- Not moved: the indexer store (fixture-only, no live block source yet) and log files.
- No breaking change: without `OBSERVATION_JOURNAL_STORE=database`, every process behaves exactly as today.

## Capabilities

### New Capabilities

- `observation-journal-persistence`: durable, append-only, hash-chained storage of market observations and retractions in Postgres with the same guarantees as the file journal, incremental verified reads, a single-writer guard and a verified import; plus optional storage of the lifecycle oracle status.

### Modified Capabilities

None. What the journal accepts, refuses and returns does not change; where it is kept and how readers catch up does.

## Impact

- `agent/src/observations/journal.ts` (writer and `loadObservationState`), `collector-main.ts`, `agent/src/lifecycle-oracle/main.ts` and `status.ts`, `agent/src/mcp/application-config.ts` (read API bindings), `agent/src/app-state/` (new Postgres implementations and the import).
- New migration under `supabase/migrations/` (journal, journal head and oracle status tables, append-only triggers, RLS with no policy, grants revoked from the public roles).
- `scripts/testnet-wiring/live-run.mjs` passes `APP_DATABASE_URL` to the collector and the oracle; `.env.example` documents it.
- Supersedes the "Not moved: the observation journal ... and the oracle status" line of `app-state-database` for those two stores.
- Decided (see design.md): observations are kept indefinitely (capacity 200,000 records per namespace, about 1 KB each), the oracle status moves in this change, and all agent services share one database credential.
