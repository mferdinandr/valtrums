## Why

Hosted agents (change `hosted-player-agents`) keep encrypted keys, settings and per-agent state in local JSON files, and the sign-in session only lives in the browser tab. Files cannot be shared by more than one worker, have no managed backup, and the encrypted key file is the one thing that cannot be rebuilt from the chain. The session is lost on every reload. A managed Postgres (Supabase project `valtrum-near`) fixes all three.

## What Changes

- **Target:** hosted agent records, per-agent play state, an event log and sessions move to Postgres tables. Keys stay encrypted by the service before they are written; the key-encryption key never goes to the database.
- **Target:** the service reads and writes through one repository interface with two implementations: the existing file store (tests and local use without a database) and a Postgres store. The Postgres store is used when `HOSTED_AGENT_DATABASE_URL` is set.
- **Target:** sessions are rows (token stored as a hash) delivered as an `httpOnly` cookie, replacing the `sessionStorage` token in the page.
- **Target:** the per-owner agent limit is enforced atomically in the database, so two concurrent creates cannot exceed it.
- **Target:** a one-time import command moves an existing `agents.json` and per-agent state files into the tables.
- **Target:** every table has row-level security enabled with no policy for `anon` or `authenticated`; only the service (service role or a dedicated database role) reads or writes.
- Unchanged: key encryption (AES-256-GCM, bound to the account), owner proof (NEP-413), caps, the kill switch, the autonomous loop and the testnet-only rule.
- No mainnet use, no Supabase Auth (the owner is a NEAR wallet, not a Supabase user) and no browser access to the database.

## Capabilities

### New Capabilities

- `hosted-agent-persistence`: durable, access-restricted storage of hosted agents, their state, events and sessions in Postgres.

### Modified Capabilities

None. `hosted-player-agents` is still a pending change (not yet in `openspec/specs/`), so its storage requirement cannot take a delta; this change adds the database behind it.

## Impact

- `agent/src/hosted/` gains a repository interface, a Postgres store, a session table and an import command; `AgentStore` becomes one implementation. The manager and server call an async repository.
- `web/src/lib/hosted-agents.ts` drops `sessionStorage` and sends credentials with the cookie; the service sets CORS for credentials.
- New secret: `HOSTED_AGENT_DATABASE_URL`, held only by the service. New migrations under `supabase/migrations/`, applied by the owner.
- Depends on PR #201 (`hosted-player-agents`). See design.md for open questions (connection mode, cookie settings across sites).
