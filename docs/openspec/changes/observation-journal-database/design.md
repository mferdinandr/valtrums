## Context

The observation journal (`agent/src/observations/journal.ts`, OpenSpec `arena-market-observations`) is a directory with three files:

- `journal.jsonl`: one line per record, `{ seq, kind, body, prev, hash }`, where `hash = sha256(prev + canonicalJson({ seq, kind, body }))` from a genesis of 64 zeros. `kind` is `observation` or `retraction`.
- `manifest.json`: `{ count, headHash, bytes }`, written atomically after the line is fsynced. It may lag the journal by one record, never lead it.
- `journal.lock`: created exclusively by the single writer, never stolen by age.

The collector is the only writer. It appends a sample about every second per community during a round. The lifecycle oracle reads it with `loadObservationState(dir)`, which replays and verifies the whole file, on every pass (`ORACLE_INTERVAL_SECS`, 1 s in the testnet launcher). The read API does the same on every chart request. The testnet journal holds 1,278 records of about 1 KB each; capacity is 200,000 records or 256 MB, and nothing is ever pruned.

The oracle status (`agent/src/lifecycle-oracle/status.ts`) is one JSON document rewritten after every pass, guarded by `oracle.lock`, and read by the read API with a 60 s staleness limit. It is explicitly non-authoritative: the oracle re-derives everything from the arena and the journal.

`app-state-database` moved actions, audit reports, player state and baselines to Postgres behind their interfaces, selected by `APP_DATABASE_URL`, and kept the journal and oracle status on files as a separate decision.

Trust boundaries (unchanged by this change):

- **Collector**: writes evidence only. It holds no NEAR key and no custody, signer, operator or player authority.
- **Oracle**: holds only the dedicated oracle key and refuses other roles' keys. It submits evidence; the arena contract decides the outcome. It never resolves from the clock or from anything but persisted evidence of an allowed source kind.
- **Read API**: read-only over the journal and status.
- **Database**: holds evidence, not authority. The database credential gives no on-chain power. Someone with write access to the database could forge evidence, which is the same exposure as write access to the collector's disk today; the hash chain makes any later edit detectable, not impossible to attempt.

## Goals / Non-Goals

**Goals:**

- One durable, backed-up home for the journal that the collector, oracle and read API reach from any host.
- Exactly the file journal's guarantees: append-only, verified hash chain, single writer, durable before acknowledged, deduplication, slot conflict refusal, retractions without erasure, visible capacity limit, no silent reset.
- Readers that catch up incrementally instead of replaying everything every pass.
- An optional database home for the oracle status.
- A verified one-time import of an existing journal.

**Non-Goals:**

- Changing what is observed, how rounds are scored or resolved, or any contract behavior.
- Pruning of observations: they are kept indefinitely (see Resolved Questions).
- The indexer store and log files.
- Removing the file journal; it stays the default without `APP_DATABASE_URL`.

## Decisions

### D1. Keep the hash chain in Postgres, one row per journal line

Table `observation_journal(namespace_key, seq, kind, body jsonb, prev_hash, hash, observation_id, slot_key, battle_id, round_id, recorded_at)`, primary key `(namespace_key, seq)`. The row stores exactly the fields of a journal line, so the same verification code checks a file or a table, and the import is a straight copy.

- Unique `(namespace_key, observation_id)` for observations and `(namespace_key, slot_key)` enforce deduplication and slot conflicts in the database as well as in code.
- Triggers raise on `update`, `delete` and `truncate`, as for `audit_report_observations`.
- Alternative: rely on database immutability and drop the chain. Rejected: the chain is what lets the oracle and any auditor prove the evidence was not edited, including by someone with database access, and it keeps the import verifiable.

The namespace (deployment, network, arena contract, protocol) is part of the key so deployments that share a database never mix evidence. The file journal is one directory per deployment; the table is one chain per namespace.

### D2. Single writer through an advisory lock; gap-free sequence through the head row

The writer takes `pg_try_advisory_lock(hashtext('observation-journal:' || namespace_key))` on a dedicated session for its whole life; failing to get it is `ObservationLockedError`, as an existing `journal.lock` is today. The lock is released when the session ends, so a crashed writer does not leave a stale lock that needs manual removal (an improvement over the file lock, which is never stolen by age).

Each append runs in one transaction: lock the `observation_journal_head(namespace_key)` row `for update`, check it equals the writer's in-memory head (anything else is corruption: another writer or an edit), insert the row with `seq = head + 1` and `prev_hash = head hash`, update the head. The commit is the durability point that fsync plus manifest are today; the in-memory state applies the record only after the commit, as it does only after fsync now.

- Alternative: a Postgres sequence for `seq`. Rejected: sequences leave gaps on rollback, and a gap is corruption in this design.

### D3. Readers keep a verified in-memory state and fetch only new rows

`loadObservationState` keeps its signature. The Postgres reader holds an `ObservationState` per namespace; each call selects `seq > head` in order, verifies `prev_hash` against its head and the recomputed hash of each row, and applies it. The first call loads from `seq = 1`. A verification failure is `ObservationCorruptError` and readers degrade exactly as on a corrupt file. A head row that is behind the newest row is corruption; a head row ahead of the rows is lost evidence, also corruption.

- Alternative: keep replaying everything each pass. Rejected: about 1 MB per second of reads for the oracle today, growing with every battle.

### D4. Oracle status as one upserted row per contract, guarded by an advisory lock

`lifecycle_oracle_status(namespace_key primary key, status jsonb, updated_at)`. The oracle takes an advisory lock on `'lifecycle-oracle:' || namespace_key` at start (replacing `oracle.lock`) and upserts its status after each pass. The read API reads the row and applies the same 60 s staleness rule. It remains non-authoritative; losing it changes nothing on chain.

### D5. Selection, credentials and failure behavior

An explicit switch, `OBSERVATION_JOURNAL_STORE=file|database` (default `file`), selects the store for the collector, the oracle and the read API; the oracle status follows the same switch. `database` requires `APP_DATABASE_URL` and refuses to start when `OBSERVATION_JOURNAL_DIR` (or, for the oracle, `ORACLE_STATE_DIR`) is also set, because one process would then silently use other evidence than its peers. The launchers set the switch for all three processes together.

- Alternative: select by `APP_DATABASE_URL` alone, as the other application stores do. Rejected during implementation: `APP_DATABASE_URL` is already set for the agent and the read API (for actions, audits and baselines), and `scripts/dev.mjs` passes `OBSERVATION_JOURNAL_DIR` to the read API, so shipping this change would have switched or broken the read API before the collector and oracle moved.

A database that cannot be reached is an error, never an empty journal: the collector stops acknowledging samples (and its health turns degraded), the oracle holds with `pending_evidence` (it never resolves without evidence), and the read API answers 503 for charts. This mirrors a missing or corrupt journal file today.

The collector and the oracle get `APP_DATABASE_URL` in `live-run.mjs`. They connect with the same service credential as the agent (the owner decided against separate roles; see Resolved Questions); that is not required for correctness because the database holds no authority.

### D6. Verified import

`pnpm -C agent app:import-journal <dir> --namespace <json>` replays and verifies the file journal, refuses a corrupt one, and inserts its records with their original `seq`, `prev_hash` and `hash` in one transaction, then sets the head. It refuses to run if the table already holds records for that namespace that differ; re-running after a complete import is a no-op. The file is left untouched.

## Risks / Trade-offs

- [Network latency per append, about 20 to 60 ms to the Supabase pooler] → one append per sample per second is far below that budget; appends stay sequential per namespace as today.
- [Database outage stops evidence collection] → the same as a full or failing disk today; it is visible (degraded health, oracle `pending_evidence`) and never resolves a round wrongly. The oracle's existing reopen after the grace period still applies when a window's evidence is incomplete.
- [Session-bound advisory lock through a transaction pooler] → the writer and the oracle use a session connection (Supabase session pooler or direct connection), not the transaction pooler, for the lock session. Documented in `.env.example`.
- [Someone with database write access edits or inserts evidence] → the triggers refuse updates and deletes; any inserted or edited row breaks the hash chain and readers refuse it. The database credential stays with the agent services only, with RLS on and no public grants.
- [Unbounded growth] → capacity limits are enforced as today (visible error, no pruning); observations are kept indefinitely by the owner's decision.

## Migration Plan

1. Apply the migration (tables, head table, triggers, RLS, revoked grants) to the Supabase project. The owner applies it.
2. Stop the collector and the oracle. Run the import for the testnet namespace and check the reported head equals the file's manifest.
3. Start the collector, oracle and read API with `OBSERVATION_JOURNAL_STORE=database`. Confirm a new round is resolved and its chart is served.
4. Rollback: set `OBSERVATION_JOURNAL_STORE=file` (or unset it) for the three processes. The file journal is unchanged but misses records written to Postgres meanwhile; rounds whose evidence is only in Postgres hold and later reopen. No funds are affected, because only the arena decides outcomes.

## Resolved Questions

Decided by the owner on 2026-11-13:

- Retention: observations are kept indefinitely, with no pruning, like the file journal. The record and byte capacity per namespace stays a visible error; raising it or archiving old namespaces would be a later change.
- Oracle status (D4) ships with this change and is implemented here; there is no follow-up change for it.
- Database roles: the collector, the oracle, the read API and the agent keep the one shared service credential. No separate roles. The hash chain still makes an inserted or edited record detectable, and the arena alone decides outcomes.
