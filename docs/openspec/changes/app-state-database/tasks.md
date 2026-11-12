## 1. Schema

- [x] 1.1 Write the migration for `actions`, `audit_report_observations`, `player_state` and `watchdog_baselines` with RLS on, no public policy, indexes, and the immutability trigger on audit observations.
- [x] 1.2 Review the SQL with the owner and apply it to `valtrum-near` (per-statement approval); run the Supabase security advisor afterwards.

## 2. Action store

- [x] 2.1 Add a Postgres action store with atomic read-modify-write and the capacity limit, with tests for the same behaviors as the file store (idempotent update, abort, capacity, malformed record).
- [x] 2.2 Select it by database URL in the read API and the player program, and add the idempotent import command.

## 3. Audit report archive

- [x] 3.1 Add a Postgres archive with append-only semantics, conflict rejection and idempotent re-evaluation, checked for the same ids and results as the in-memory archive.
- [ ] 3.2 Serve report queries from indexed columns in the report server and CLI. Only `PgReportArchive.forBattle` (indexed) exists; the report server and CLI still read through `snapshot()`. Left for a follow-up.
- [x] 3.3 Add tests that update, delete and truncate are rejected by the database, and the import command.

## 4. Player state and baselines

- [x] 4.1 Add Postgres stores for player state and baselines behind their interfaces, with tests.
- [x] 4.2 Add the import commands.

## 5. Docs and verification

- [x] 5.1 Update agent/README.md, `.env.example` and the runbook with the database mode, imports and rollback.
- [x] 5.2 Run `scripts/pre-commit.sh` and `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`.
