## 1. Schema

- [x] 1.1 Write the migration for `observation_journal` (primary key namespace and sequence, unique observation id and slot per namespace), `observation_journal_head` and `lifecycle_oracle_status`, with triggers refusing update, delete and truncate on journal rows, RLS on with no policy and grants revoked from `anon` and `authenticated`.
- [x] 1.2 Add PGlite tests that the triggers refuse edits, that the unique constraints hold and that the public roles have no access.
- [x] 1.3 Review the SQL with the owner and apply it to the Supabase project (per-statement approval); run the Supabase security advisor afterwards. (Applied 2026-11-13 to `jmdufefhhzpcwwgqfeoc`; the advisor reports only the intended INFO "RLS enabled, no policy" for every service-only table.)

## 2. Shared verification

- [x] 2.1 Extract the line hash, record verification and `apply` from `journal.ts` so the file and the database journal use the same code, with no change to the file journal's behavior (its existing tests pass unchanged).

## 3. Database journal writer

- [x] 3.1 Add the Postgres writer: session advisory lock per namespace (locked error when held, released when the session ends), first load with full verification, and an append transaction that locks the head row, checks it against the in-memory head, inserts `seq = head + 1` and updates the head.
- [x] 3.2 Keep the writer's guarantees: acknowledge only after commit, duplicate and slot-conflict handling, retractions, capacity errors and degraded health reasons; test each against the same cases as the file journal.
- [x] 3.3 Select it in `collector-main.ts` by `OBSERVATION_JOURNAL_STORE=database` (requires `APP_DATABASE_URL`), and refuse a mixed file and database configuration.

## 4. Database journal readers

- [x] 4.1 Add the incremental verified reader (full load once, then only rows after the held head; corruption on any mismatch, including a head row that disagrees with the rows) behind `loadObservationState`'s contract.
- [x] 4.2 Use it in the lifecycle oracle and the read API bindings; an unreachable database is an error, never an empty state (oracle `pending_evidence`, read API unavailable).
- [x] 4.3 Test catch-up, tampered rows, a missing row and an unreachable database.

## 5. Oracle status

- [x] 5.1 Add the Postgres status store with a session advisory lock per namespace and an upsert after each pass; read it in the read API with the existing staleness limit; test the second-oracle refusal and staleness. (Staleness is the read API's existing `staleAfterMs` rule on `updatedAtMs`, independent of where the status is read from; the new tests cover the stored and read-back status, the lock and malformed rows.)

## 6. Import

- [x] 6.1 Add `app:import-journal` that verifies a file journal, refuses a corrupt one or a namespace holding different records, copies records with their original sequence and hashes in one transaction, sets the head and is a no-op when repeated; test each case.

## 7. Wiring, docs and verification

- [x] 7.1 Add the `OBSERVATION_JOURNAL_STORE` switch to the launchers (`live-run.mjs`, `dev.mjs`), pass `APP_DATABASE_URL` to the collector and the oracle in `scripts/testnet-wiring/live-run.mjs`; document the session-pooler requirement, the import and the rollback in `.env.example` and the agent runbook.
- [ ] 7.2 Import the testnet journal, run a battle end to end on the database journal and confirm the round resolves and the chart is served. (Import done 2026-11-13: 1,278 records, head `95aed091…` equal to the file manifest, verified by a full reader load from Postgres; a second import was a no-op. The end-to-end worker run awaits the owner's approval, because the agent and oracle send testnet transactions.)
- [x] 7.3 Run `scripts/pre-commit.sh` and `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`.
