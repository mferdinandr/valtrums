## Context

The hosted service (change `hosted-player-agents`) stores agents in `agents.json` and per-agent state in `state-<account>.json`, and the web page keeps the session token in `sessionStorage`. The Supabase project `valtrum-near` (ap-southeast-1, Postgres 17) exists and is empty. Trust boundaries are unchanged: the service holds agent keys (encrypted) and is the only database client; the browser never talks to the database; the key-encryption key lives outside the database.

## Goals / Non-Goals

**Goals:**
- Durable, shared, backed-up storage for hosted agents, state, events and sessions.
- Sessions that survive reload without a script-readable token.
- An atomic per-owner limit and a safe one-time import.

**Non-Goals:**
- Moving actions, audit reports, baselines (change `app-state-database`), the observation journal or the indexer.
- Supabase Auth, PostgREST access from the browser, or client-side database calls.
- Key custody changes (KMS or TEE): the encrypted blob and a KEK outside the database stay as they are.

## Decisions

1. **Direct Postgres from the service (`pg`), not PostgREST.** The service needs transactions (the atomic limit), advisory locks and plain SQL. Alternative: `supabase-js` with the service role; rejected because it adds an HTTP layer and cannot do multi-statement transactions. Connection string from `HOSTED_AGENT_DATABASE_URL` (direct or session-mode pooler).
2. **A repository interface with two implementations.** `HostedRepository` (async) is implemented by the file store (tests, local use without a database) and a Postgres store. The manager and server only see the interface. Alternative: replace the file store; rejected to keep tests offline and to allow a rollback.
3. **Schema (all in `public`, RLS enabled, no policies):**
   - `hosted_agents(account pk, owner, public_key, encrypted_key, style, sweep, keep_whole, label, running, last_error, model_calls, created_at, updated_at)`, index on `owner`.
   - `hosted_agent_state(account pk references hosted_agents, state jsonb, updated_at)`.
   - `hosted_agent_events(id bigserial pk, account, kind, detail jsonb, at)`; kinds `create|start|stop|error|export|kill_switch`.
   - `hosted_sessions(token_hash pk, owner, created_at, expires_at)`, index on `expires_at`; expired rows are deleted on write.
   RLS with no policy denies `anon` and `authenticated` by default; the service connects with a role that bypasses RLS (the project's service role through the connection string, or a dedicated role). Revoke default grants on these tables from `anon` and `authenticated` as defense in depth.
4. **Atomic limit** with one transaction: lock the owner's rows with `pg_advisory_xact_lock(hashtext(owner))`, count, insert. Alternative: a trigger; rejected as harder to test.
5. **Sessions** are random 32-byte tokens; only `sha256(token)` is stored. Set as a cookie `HttpOnly; Secure` (not `Secure` on `http://localhost`), `SameSite=Lax` when the web app and service share a site (local dev) and `SameSite=None; Secure` with CORS `Access-Control-Allow-Credentials` and the exact allowed origin otherwise. Alternative: keep the stateless HMAC token; kept only for the file store.
6. **Import command** (`hosted:import`) reads `agents.json` and `state-*.json`, upserts by `account` with `ON CONFLICT DO NOTHING`, and prints counts. It never decrypts keys.
7. **Migrations** are SQL files under `supabase/migrations/`, reviewed in the PR and applied by the owner (or via the Supabase MCP after explicit approval per statement). Not generated or applied silently.

## Risks / Trade-offs

- **Database holds encrypted keys** → blob bound to the account, KEK outside the database, RLS with no public policy, service-only credential, a test that the public key reads nothing.
- **Pooler transaction mode breaks session features** (advisory locks across statements) → use the direct or session-mode connection, document it; the lock is transaction-scoped so transaction mode also works.
- **Cross-site cookies** can be blocked by browsers → keep web and service on one site (a subdomain of the same registrable domain) in deployment; local dev is same-site.
- **Database outage stops all agents** → fail closed; agents resume when it returns, and the game state is on chain.
- **Free-tier pause or limits** → noted as an operational risk; backups and project upgrade are the operator's decision.

## Migration Plan

1. Review and apply the migration to `valtrum-near` (owner approves each statement).
2. Deploy the service with `HOSTED_AGENT_DATABASE_URL`; run `hosted:import` once.
3. Verify counts, then stop using the files (keep `agents.json` as a backup until confirmed).
4. Rollback: unset `HOSTED_AGENT_DATABASE_URL` to return to the file store (data created since is not copied back).

## Open Questions

- Direct connection or session-mode pooler for the worker, and the exact database role (service role vs a dedicated role).
- Production cookie domain and whether web and service will share a site.
- Retention of `hosted_agent_events` (no pruning is proposed here).
- Worker host remains open (see `hosted-player-agents`).
