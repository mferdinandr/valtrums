## ADDED Requirements

### Requirement: Durable hosted agent storage
The service SHALL persist each hosted agent (account, public key, owner, settings, running state, last error, model-call count and creation time) and its encrypted key in Postgres, and a restart or a second worker MUST see the same agents without a local file.

#### Scenario: Restart keeps agents
- **WHEN** the service restarts with `HOSTED_AGENT_DATABASE_URL` set
- **THEN** every previously created agent is listed for its owner with the same settings and running state

#### Scenario: Two workers share state
- **WHEN** one worker creates an agent
- **THEN** a second worker connected to the same database reads that agent

### Requirement: Keys stay encrypted
The database SHALL only ever hold the encrypted key blob. The key-encryption key MUST NOT be stored in the database, and a database read alone MUST NOT yield a secret key.

#### Scenario: Stored value is ciphertext
- **WHEN** a hosted agent row is read directly from the database
- **THEN** the key column is an encrypted blob bound to the agent account and contains no `ed25519:` secret

### Requirement: Restricted database access
Every hosted-agent table SHALL have row-level security enabled with no policy for `anon` or `authenticated`, and only the service SHALL connect with a credential that can read or write them. The browser MUST NOT receive a database credential.

#### Scenario: Public roles are denied
- **WHEN** a request with the project's public (anon) key reads a hosted-agent table
- **THEN** it returns no rows and cannot insert, update or delete

#### Scenario: Web bundle has no database secret
- **WHEN** the web build is inspected
- **THEN** it contains no database URL, service role key or key-encryption key

### Requirement: Atomic per-owner limit
The per-owner agent limit SHALL be enforced inside the database transaction that creates the agent, so concurrent creates cannot exceed it.

#### Scenario: Concurrent creates at the limit
- **WHEN** an owner one agent below the limit sends two create requests at once
- **THEN** exactly one succeeds and the other is rejected as over the limit

### Requirement: Database-backed sessions
A session SHALL be a database row holding only a hash of the token, the owner and an expiry, delivered to the browser as an `httpOnly` cookie. Expired or revoked sessions MUST be rejected, and the page MUST NOT keep the token in script-readable storage.

#### Scenario: Reload keeps the session
- **WHEN** the owner reloads the page within the session lifetime
- **THEN** the service accepts the cookie and the owner is not asked to sign again

#### Scenario: Expired session
- **WHEN** a request carries a cookie whose session has expired
- **THEN** the service rejects it as unauthorized

#### Scenario: Token is not stored in clear
- **WHEN** the sessions table is read directly
- **THEN** it holds a hash and no usable token

### Requirement: Per-agent play state and events
The per-agent play state (the record that stops an agent playing a battle twice) SHALL be stored per agent in the database, and start, stop, error and key-export events SHALL be appended to an event log with a timestamp.

#### Scenario: No repeat play after restart
- **WHEN** an agent has played a battle and the service restarts
- **THEN** the agent does not play that battle again

#### Scenario: Export recorded
- **WHEN** the owner exports a key
- **THEN** an export event with the time and account is appended

### Requirement: Fail closed
If the database is unreachable or a stored record is malformed, the service SHALL NOT start an agent or sign anything for it, and SHALL report the failure instead of falling back to another store.

#### Scenario: Database down
- **WHEN** the database cannot be reached during a round
- **THEN** no transaction is signed for that round and the error is logged

### Requirement: One-time import
A documented import command SHALL load an existing `agents.json` and per-agent state files into the tables without changing any key, and SHALL be safe to run twice.

#### Scenario: Import is idempotent
- **WHEN** the import command runs twice on the same files
- **THEN** the tables hold each agent once and no value changes on the second run
