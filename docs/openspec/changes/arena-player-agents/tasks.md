# Tasks

Check tasks only after implementation and verification. Player grants and infrastructure credentials remain separate.

## Authorization and budgets

- [ ] Define user-bound grants covering chains, contracts, methods, assets, destinations, per-action and cumulative token budgets, gas, expiry and revocation.
- [ ] Store grant identity, version and revocation state in an enforcement layer outside browser-only checks.
- [ ] Validate each canonical action against its user grant and current scope before signing or spending.
- [ ] Reserve cumulative budget atomically across concurrent actions and reconcile in-flight obligations.
- [ ] Reject new actions after expiry or revocation while preserving attributable in-flight obligations and unused funds.
- [ ] Deny auditor, scheduler, relayer and other infrastructure credentials player-spending authority.

## Strategy and integration

- [ ] Treat NEAR AI output and token metadata as untrusted proposed actions rather than authorization.
- [ ] Validate proposed actions through deterministic schema, preview and grant checks without widening scope.
- [ ] Bind accepted deposits and subsequent status to the authorizing user and participant position.
- [ ] Integrate action status and revocation with the MCP/terminal boundary.

## Verification

- [ ] Test concurrent actions exceeding cumulative budget and per-action, asset, chain, method and destination limits.
- [ ] Test expired and revoked grants across all spending paths and distinguish in-flight actions.
- [ ] Test infrastructure-role crossover, leaked credentials and malicious metadata or strategy output.
- [ ] Test multiple independently funded users and correct participant attribution.
