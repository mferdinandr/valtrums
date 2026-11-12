## 1. Service foundations

- [x] 1.1 Add the hosted-agent service skeleton with a testnet-only start guard and configuration for caps and the kill switch.
- [x] 1.2 Add the agent store (owner, account, encrypted key, settings, counters, state) and encrypted key storage with a key-encryption key held outside the store.

## 2. Owner authentication

- [x] 2.1 Add a NEP-413 challenge and verify flow with short-lived sessions.
- [x] 2.2 Enforce owner isolation on every endpoint, with tests for unauthenticated and cross-owner calls.

## 3. Runner and API

- [x] 3.1 Add endpoints: create, status, start, stop, export (export recorded, key shown once).
- [x] 3.2 Run started agents with the existing autonomous loop in a worker, resuming from stored state.
- [x] 3.3 Enforce agents-per-owner, per-agent and global model-call caps, the fund cap and the kill switch, with tests.
- [x] 3.4 Count model calls per agent and log the chat id with each play; keep the NEAR AI key server-side only.

## 4. Web

- [x] 4.1 Replace the "New agent" flow: Create, Fund (existing fund transactions), Start/Stop and status; remove the "Run it" step and the browser-only key.
- [x] 4.2 Add the testnet-only banner and the Export key action.
- [x] 4.3 Keep the user-run mode documented as an advanced option.

## 5. Docs and verification

- [x] 5.1 Update docs/player-agents.md (hosted mode, custody deviation, caps, environment variables) and `.env.example`.
- [x] 5.2 Run `scripts/pre-commit.sh` and `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`.
- [ ] 5.3 Record the deployment decision (worker host, storage, cap values) before enabling for users. Left open on purpose: the operator decides it, not this change.
