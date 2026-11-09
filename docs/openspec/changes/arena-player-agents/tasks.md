# Tasks

Check tasks only after implementation and verification. Player grants and infrastructure credentials remain separate.

## Authorization and budgets

- [x] Define user-bound grants covering chains, contracts, methods, assets, destinations, per-action and cumulative token budgets, gas, expiry and revocation.
  - [x] Grant schema and validation in `contracts/player-policy` (pure core): user/delegate identity, immutable asset identity (chain, exact token address, representation, custody domain, mapping version — never a ticker), bounded contract/method/destination scope, optional battle/community scope, checked `U128`/`U64` caps, declared gas bound, and chain-time expiry.
  - [x] #108 (D30): a delegate must differ from the user (`Delegate must differ from user`, also enforced by the pure core). Verified by unit and sandbox tests.
- [x] Store grant identity, version and revocation state in an enforcement layer outside browser-only checks.
  - [x] Persistent NEAR wrapper storing version-scoped grant history, shared version-independent budget counters and reservations, with caller-authenticated create/revoke (a JSON field is never authentication), storage charging, one-yocto guards, bounded views and NEP-297 data-array events. A version bump preserves old records and counters, keeps the asset immutable and rejects a cap below existing obligations.
  - [x] #108 (D30): revocation is permanent per grant id; a version bump of a revoked grant is rejected (`Grant revoked`) and a new local id is required to continue. Asset identity stays immutable per grant, tested for each of its five fields in unit and sandbox tests.
- [x] Validate each canonical action against its user grant and current scope before signing or spending.
  - [x] Versioned typed `CanonicalAction` with a deterministic `action_hash` binding every security-relevant field, validated against the stored grant and authenticated caller before any budget reservation. The eventual signing/spending executor is deferred.
- [x] Reserve cumulative budget atomically across concurrent actions and reconcile in-flight obligations.
  - [x] Validation and reservation in one `&mut self` transition with the invariant `consumed + reserved <= authorized_limit`; a reserved/dispatched/consumed/released/reconciliation-required transition table with exactly-once consume and safe release, exercised through a fixture-only execution adapter. Real signed execution/evidence is deferred to a reviewed adapter.
  - [x] #108 (D30), production build: the user or the current delegate can cancel an undispatched reservation (`cancel_reservation`, one yocto), and an undispatched reservation expires after a configurable lifetime (default 1 hour, owner-set within 1 minute to 7 days, `set_reservation_ttl`) and can then be released by anyone (`release_expired`, one yocto, state only). Dispatched and reconciliation-required obligations are never released by cancel, timeout or revocation. Dispatch, consume and reconcile were still fixture-only at that point.
  - [x] #108 (D30), production build: dispatch, reconciliation flagging and consumption now run in the normal build with no executor. Consumption is confirmed only by finalized registry evidence (`confirm_with_receipt` reads the registry's active claim and requires an exact match of asset, user, battle and amount; one receipt settles one reservation); a dispatched obligation is never released by timeout, cancel or revocation and no production path releases it. Verified by unit tests (normal and `sandbox-fixtures` builds) and a sandbox test against the real receipt registry. Evidence limits and the open no-execution release decision are in the design.
- [x] Reject new actions after expiry or revocation while preserving attributable in-flight obligations and unused funds.
  - [x] Expiry (chain time), persistent revocation and current grant version are checked at first execution admission; replacing a grant cannot revive old queued authorizations. Possibly-executed dispatched obligations remain reconcilable after replacement, expiry or revocation and are never released by those changes alone.
- [x] Deny auditor, scheduler, relayer and other infrastructure credentials player-spending authority.
  - [x] Only the grant's delegate or the user can reserve; no infrastructure role or the owner can originate or widen a reservation, verified in the sandbox.

## Strategy and integration

- [x] Treat NEAR AI output and token metadata as untrusted proposed actions rather than authorization.
  - [x] A proposed action is accepted only as a typed `CanonicalAction` checked against the grant; malformed, out-of-scope or metadata-driven destination/amount changes cannot create or widen authorization.
  - [x] Agent side (#77, `agent/src/mcp/actions/proposal.ts`): model output is parsed as exactly one JSON object and may only name user, battle, community, amount and a rationale that is never an input; any other field rejects the proposal. The grant comes from the operator's `PLAYER_AGENT_GRANTS`, never from the proposal.
- [x] Validate proposed actions through deterministic schema, preview and grant checks without widening scope.
  - [x] Deterministic typed schema + grant validation in the module (unknown fields/variants cannot hide a wider action).
  - [x] A proposal goes through the #76 preview, grant pre-check and revalidation path; token, recipient, route, request id and signer come from chain state and configuration; the contract's `reserve` re-checks the full scope.
- [x] Bind accepted deposits and subsequent status to the authorizing user and participant position. (`ActionService.attribution`: user, signer, battle, community, the user's current position, grant state and the on-chain reservation.)
- [x] Integrate action status and revocation with the MCP/terminal boundary. (`action_status` returns status and attribution; a revoked or expired grant rejects actions not yet prepared, while prepared or reserved ones stay attributable; MCP tool `propose_action`.)

## Verification

- [x] Test concurrent actions exceeding cumulative budget and per-action, asset, chain, method and destination limits.
  - [x] Module invariant tests plus sandbox tests: two competing reservations cannot exceed the cumulative cap, and per-action/asset/chain/method/destination/gas/battle limits each reject. Broader tests across real funded spending paths remain follow-ups.
- [x] Test expired and revoked grants across all spending paths and distinguish in-flight actions.
  - [x] Expiry/revocation reject new reservations and admission; in-flight (dispatched) obligations stay attributable and are not auto-released. Coverage across real execution paths is deferred.
  - [x] #108: the only production spending-authorization path today is `reserve`; revoked/expired grants, revoked-then-bumped grants and expired reservations are rejected there, and dispatched obligations survive cancel, expiry and revocation attempts (fixture build). No other spending path exists to test yet.
- [x] Test infrastructure-role crossover, leaked credentials and malicious metadata or strategy output.
  - [x] Role-crossover, non-executor outcome-callback and conflicting-request/changed-action tests; a leaked delegate cannot widen scope, switch user/destination, exceed caps or act after revocation.
- [x] Test multiple independently funded users and correct participant attribution.
  - [x] Two users with the same local grant id and reused request ids keep isolated identities, counters and reservations. Fixture funding is not a real funded-agent demo; funded arena positions remain follow-ups.
  - [x] #108: a sandbox test with two users sharing local grant and request ids checks separate budgets, delegates that cannot act for the other user, and cancelling one reservation leaving the other untouched. Synthetic amounts only; not a funded demo.
