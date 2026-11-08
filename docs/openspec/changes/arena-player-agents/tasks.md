# Tasks

Check tasks only after implementation and verification. Player grants and infrastructure credentials remain separate.

## Authorization and budgets

- [ ] Define user-bound grants covering chains, contracts, methods, assets, destinations, per-action and cumulative token budgets, gas, expiry and revocation.
  - [x] Grant schema and validation in `contracts/player-policy` (pure core): user/delegate identity, immutable asset identity (chain, exact token address, representation, custody domain, mapping version — never a ticker), bounded contract/method/destination scope, optional battle/community scope, checked `U128`/`U64` caps, declared gas bound, and chain-time expiry.
- [ ] Store grant identity, version and revocation state in an enforcement layer outside browser-only checks.
  - [x] Persistent NEAR wrapper storing version-scoped grant history, shared version-independent budget counters and reservations, with caller-authenticated create/revoke (a JSON field is never authentication), storage charging, one-yocto guards, bounded views and versioned events. A version bump preserves old records and counters so it cannot reset obligations or evade the cumulative cap.
- [ ] Validate each canonical action against its user grant and current scope before signing or spending.
  - [x] Versioned typed `CanonicalAction` with a deterministic `action_hash` binding every security-relevant field, validated against the stored grant and authenticated caller before any budget reservation. The eventual signing/spending executor is deferred.
- [ ] Reserve cumulative budget atomically across concurrent actions and reconcile in-flight obligations.
  - [x] Validation and reservation in one `&mut self` transition with the invariant `consumed + reserved <= authorized_limit`; a reserved/dispatched/consumed/released/reconciliation-required transition table with exactly-once consume and safe release, exercised through a fixture-only execution adapter. Real signed execution/evidence is deferred to a reviewed adapter.
- [ ] Reject new actions after expiry or revocation while preserving attributable in-flight obligations and unused funds.
  - [x] Expiry (chain time) and persistent revocation block new reservations and are rechecked at the execution-admission (dispatch) boundary; a possibly-executed dispatched obligation is never released by timeout/revocation alone and is retained for reconciliation.
- [ ] Deny auditor, scheduler, relayer and other infrastructure credentials player-spending authority.
  - [x] Only the grant's delegate or the user can reserve; no infrastructure role or the owner can originate or widen a reservation, verified in the sandbox.

## Strategy and integration

- [ ] Treat NEAR AI output and token metadata as untrusted proposed actions rather than authorization.
  - [x] A proposed action is accepted only as a typed `CanonicalAction` checked against the grant; malformed, out-of-scope or metadata-driven destination/amount changes cannot create or widen authorization. NEAR AI and canonical preview persistence remain out of scope.
- [ ] Validate proposed actions through deterministic schema, preview and grant checks without widening scope.
  - [x] Deterministic typed schema + grant validation in the module (unknown fields/variants cannot hide a wider action). The preview/MCP surface remains out of scope.
- [ ] Bind accepted deposits and subsequent status to the authorizing user and participant position.
- [ ] Integrate action status and revocation with the MCP/terminal boundary.

## Verification

- [ ] Test concurrent actions exceeding cumulative budget and per-action, asset, chain, method and destination limits.
  - [x] Module invariant tests plus sandbox tests: two competing reservations cannot exceed the cumulative cap, and per-action/asset/chain/method/destination/gas/battle limits each reject. Broader tests across real funded spending paths remain follow-ups.
- [ ] Test expired and revoked grants across all spending paths and distinguish in-flight actions.
  - [x] Expiry/revocation reject new reservations and admission; in-flight (dispatched) obligations stay attributable and are not auto-released. Coverage across real execution paths is deferred.
- [ ] Test infrastructure-role crossover, leaked credentials and malicious metadata or strategy output.
  - [x] Role-crossover, non-executor outcome-callback and conflicting-request/changed-action tests; a leaked delegate cannot widen scope, switch user/destination, exceed caps or act after revocation.
- [ ] Test multiple independently funded users and correct participant attribution.
  - [x] Two users with the same local grant id and reused request ids keep isolated identities, counters and reservations. Fixture funding is not a real funded-agent demo; funded arena positions remain follow-ups.
