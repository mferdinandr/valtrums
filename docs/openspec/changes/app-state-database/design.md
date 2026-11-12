## Context

Four stores hold state in local files today (`agent/src/mcp/actions/store.ts`, `agent/src/audit/report-archive.ts`, `agent/src/player/state.ts`, `agent/src/baseline.ts`). Each already hides its storage behind a class or interface, writes atomically and fails closed on a bad file. The dev stack runs the read API, workers and collector against one `.live-state` directory. The web app on a serverless host reaches data only through the read API. The `valtrum-near` Supabase project is empty and `hosted-agents-database` introduces the Postgres connection pattern.

## Goals / Non-Goals

**Goals:**
- Same behavior and invariants, durable and shared in Postgres.
- Queryable audit history without scanning a file.
- No change visible to the web app.

**Non-Goals:**
- The observation journal, indexer store and oracle status.
- A browser-facing database API or Supabase Auth.
- Pruning or retention policies for audit history (none is proposed).

## Decisions

1. **Postgres behind the existing interfaces, files kept.** Each store gets a Postgres implementation chosen by a database URL; the file one stays for tests and local runs. Alternative: replace the files; rejected to keep tests offline and a rollback path.
2. **Tables (public, RLS on, no policies):**
   - `actions(action_id pk, version, owner, status, record jsonb, created_at, updated_at)`; `update` is one transaction with `select … for update` on the row; the maximum count is checked in the creating transaction.
   - `audit_report_observations(observation_id pk, arena, battle_id, community, evidence_hash, domain, report jsonb, first_seen_at, last_seen_at, …)` with indexes on `(arena, battle_id, community, first_seen_at)`; a trigger raises on `update` or `delete` of identity and decision columns, so history is immutable in the database and not only in code. Idempotent re-evaluation touches only `last_seen_at` through a controlled function.
   - `player_state(agent pk, state jsonb, updated_at)` and `watchdog_baselines(key pk, liquidity_usd numeric, recorded_at)` using the keys the current stores use.
3. **Direct Postgres client (`pg`)** as in `hosted-agents-database`, one database role per service where practical so the read API can be read-only on audit data. Alternative: one shared service role; acceptable for testnet, the role split is an open question.
4. **Keep integrity checks in code and in the database.** Code validates content hashes as today; constraints and the trigger make a violation impossible even through a direct statement.
5. **Import commands** per store, idempotent (`ON CONFLICT DO NOTHING`), leaving files untouched.
6. **Sequencing:** change `hosted-agents-database` lands first (connection pattern, migration process); this change reuses them.

## Risks / Trade-offs

- **Database outage stops workers and the read API** → fail closed with a clear error; chain remains the source of truth for funds.
- **Audit immutability moves partly to a trigger** → tests that updates and deletes are rejected, including with a privileged role used by the service.
- **Action throughput under row locks** → one row per action keeps locks narrow; load is low (user actions).
- **Divergent keys between file and Postgres stores** → both implementations run the same test suite.

## Migration Plan

1. Review and apply the migration (owner approves each statement).
2. Run the import for each store with the database URL set on a copy first, compare counts.
3. Switch the service by setting the database URL; keep the files as backup.
4. Rollback by unsetting the URL (records written since are not copied back).

## Open Questions

- Are the action store and the audit report archive used in production yet (decides the order of work)?
- One database role per service, or a shared service role for testnet?
- Retention of audit observations (none proposed; growth is bounded only by the archive limit today).
- Whether the observation journal and indexer should move later (needs its own design).
