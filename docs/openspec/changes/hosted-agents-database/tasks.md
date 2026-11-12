## 1. Schema

- [x] 1.1 Write the migration under `supabase/migrations/` for `hosted_agents`, `hosted_agent_state`, `hosted_agent_events` and `hosted_sessions`, with RLS enabled, no public policy and default grants revoked from `anon` and `authenticated`.
- [x] 1.2 Review the SQL with the owner and apply it to the `valtrum-near` project (per-statement approval); run the Supabase security advisor afterwards.

## 2. Repository

- [x] 2.1 Introduce an async `HostedRepository` interface and move the file store behind it without changing behavior.
- [x] 2.2 Add the Postgres store (`pg`) including the atomic per-owner limit and event appends, enabled by `HOSTED_AGENT_DATABASE_URL`.
- [x] 2.3 Store per-agent play state in the database and keep the in-memory `PlayerState` semantics.
- [x] 2.4 Fail closed on an unreachable database or a malformed row, with tests for both.
- [x] 2.5 Add a shared repository test suite that runs against the file store and, when a test database URL is set, the Postgres store.

## 3. Sessions

- [x] 3.1 Add the sessions table store (hashed token, expiry, cleanup on write) and issue an `httpOnly` cookie from `/auth/verify`; add a sign-out route.
- [x] 3.2 Set CORS for credentials with the exact allowed origin, and the cookie `SameSite`/`Secure` settings per environment.
- [x] 3.3 Replace the `sessionStorage` token in `web/src/lib/hosted-agents.ts` with `credentials: "include"` and drop the script-readable token.

## 4. Import and docs

- [x] 4.1 Add the idempotent `hosted:import` command for `agents.json` and `state-*.json`.
- [x] 4.2 Update docs/player-agents.md, `.env.example` and the runbook with the database mode, the migration and the rollback.
- [x] 4.3 Run `scripts/pre-commit.sh` and `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`.
