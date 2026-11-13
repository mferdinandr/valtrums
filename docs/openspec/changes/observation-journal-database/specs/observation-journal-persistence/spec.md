## ADDED Requirements

### Requirement: Database selection
The collector, the lifecycle oracle and the read API SHALL keep the observation journal in Postgres when `OBSERVATION_JOURNAL_STORE=database` and in the file journal otherwise (`file`, the default). The database store MUST require `APP_DATABASE_URL`, and a process MUST refuse to start when it is configured to use the file journal and the database journal at once.

#### Scenario: Database configured
- **WHEN** `OBSERVATION_JOURNAL_STORE=database` and `APP_DATABASE_URL` are set for the collector, the oracle and the read API
- **THEN** the collector writes observations to Postgres and the oracle and read API read them from Postgres

#### Scenario: Default
- **WHEN** `OBSERVATION_JOURNAL_STORE` is not set, even with `APP_DATABASE_URL` set
- **THEN** every process uses the file journal exactly as before

#### Scenario: Mixed configuration
- **WHEN** `OBSERVATION_JOURNAL_STORE=database` and `OBSERVATION_JOURNAL_DIR` are both set
- **THEN** the process refuses to start

### Requirement: Append-only hash-chained journal
Each journal record SHALL be stored as one row carrying its namespace, sequence number, kind, body, previous hash and hash, where the hash covers the previous hash, the sequence number, the kind and the body, starting from a genesis hash. Sequence numbers MUST be gap-free per namespace. The database MUST refuse any update, delete or truncate of journal rows.

#### Scenario: Edit is refused
- **WHEN** a statement tries to update or delete a stored journal row
- **THEN** the database rejects it and the row is unchanged

#### Scenario: Namespaces are separate
- **WHEN** two deployments with different namespaces write to the same database
- **THEN** each has its own sequence and hash chain and neither reads the other's records

### Requirement: Durable before acknowledged
An append SHALL be acknowledged only after its transaction has committed, and the in-memory state used by readers and publishers MUST include a record only after that commit. An append that fails to commit MUST NOT be acknowledged and MUST NOT appear in the state.

#### Scenario: Commit fails
- **WHEN** the database rejects or loses the connection during an append
- **THEN** the append fails with an error and the record is not visible to any reader

### Requirement: Single writer
At most one writer SHALL append to a namespace at a time, and a second writer for the same namespace MUST fail to open with a locked error. A writer whose process ended MUST NOT block a new writer.

#### Scenario: Second writer
- **WHEN** a collector opens the journal for a namespace that another running collector holds
- **THEN** it fails with a locked error and appends nothing

#### Scenario: Crashed writer
- **WHEN** the writer's process ends without closing the journal
- **THEN** a new writer for that namespace can open it

### Requirement: Deduplication and slot conflicts
An observation whose id already exists SHALL be acknowledged as a duplicate without a new row. An observation for a source evidence slot that already holds a different observation MUST be refused with a conflict error, the first one kept, and the writer's health marked degraded.

#### Scenario: Duplicate
- **WHEN** the same observation is appended twice
- **THEN** the second append returns the existing sequence number and adds no row

#### Scenario: Conflicting slot
- **WHEN** a different observation is appended for a slot that is already filled
- **THEN** it is refused with a conflict error and the stored observation is unchanged

### Requirement: Retractions never erase
A retraction SHALL be appended as its own record naming an earlier observation of the same namespace, and the retracted observation MUST remain stored. A repeated retraction of the same observation SHALL be acknowledged as a duplicate.

#### Scenario: Retract an observation
- **WHEN** an observation is retracted
- **THEN** a retraction row is added, the observation row stays, and readers treat the observation as no longer effective

### Requirement: Verified incremental reads
Readers SHALL verify every record they load against the hash chain and SHALL, after a first full load, load only records after the head they hold. Any mismatch of sequence, previous hash or hash, and a stored head that disagrees with the stored records, MUST be reported as corruption; the reader MUST NOT reset or skip records.

#### Scenario: Catch up
- **WHEN** a reader holding records up to sequence N is asked for the state and the journal holds N+3 records
- **THEN** it loads and verifies only the three new records

#### Scenario: Tampered record
- **WHEN** a stored record's body no longer matches its hash
- **THEN** the reader reports the journal as corrupt and the oracle holds the round instead of resolving it

### Requirement: Unavailable database is never empty evidence
When the database cannot be read, the oracle SHALL hold with pending evidence, the read API SHALL answer that observations are unavailable, and the collector SHALL stop acknowledging samples and report degraded health. None of them MAY treat the journal as empty.

#### Scenario: Database down during a round
- **WHEN** the database is unreachable after a round window ends
- **THEN** the oracle submits nothing for that round and reports pending evidence

### Requirement: Capacity without pruning
The database journal SHALL enforce the same record and byte capacity as the file journal, and reaching it MUST be a visible error. No record SHALL be pruned automatically.

#### Scenario: Capacity reached
- **WHEN** an append would exceed the record capacity of the namespace
- **THEN** it is refused with a capacity error and no row is added

### Requirement: Verified import
A one-time import SHALL copy a file journal into the database with its sequence numbers, previous hashes and hashes unchanged, only after the whole file verifies. The import MUST refuse a corrupt journal and a namespace that already holds different records, and a repeated import of the same journal SHALL change nothing. The source file MUST be left unchanged.

#### Scenario: Import a valid journal
- **WHEN** a valid journal of N records is imported into an empty namespace
- **THEN** the namespace holds N rows whose head hash equals the file's head hash

#### Scenario: Corrupt source
- **WHEN** the file journal fails verification
- **THEN** the import writes nothing and reports the corruption

### Requirement: Oracle status in the database
When `OBSERVATION_JOURNAL_STORE=database`, the lifecycle oracle SHALL store its non-authoritative status as one row per namespace, updated after each pass, and only one oracle process MAY hold a namespace at a time. The read API SHALL read the status from that row with the same staleness limit as the file status.

#### Scenario: Second oracle
- **WHEN** a second oracle starts for a namespace another running oracle holds
- **THEN** it fails to start with a locked error

#### Scenario: Stale status
- **WHEN** the stored status was last updated longer ago than the staleness limit
- **THEN** the read API reports the oracle status as stale
