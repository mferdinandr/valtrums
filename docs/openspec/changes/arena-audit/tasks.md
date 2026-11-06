# Tasks

Deferred for now; target remains Robinhood testnet `46630`. Check tasks only after implementation and verification; fixtures and mainnet responses are not testnet coverage.

## GoPlus evidence and field mapping

- [ ] Define the authenticated provider boundary and bind evidence to chain, token, representation, custody domain, mapping version and policy.
- [ ] Retain raw response, digest, provider/API version and query time for reproducible inspection.
- [ ] Normalize required string flags explicitly as true, false or unknown and retain per-field reasons.
- [ ] Normalize buy, sell and transfer tax as exact decimal fractions; preserve empty and malformed values as unknown.
- [ ] Record ownership, proxy, source, privilege and DEX context without treating omissions as safe.
- [ ] Reject mapped critical flags and a tax fraction of exactly one, retaining simultaneous unknown findings.
- [ ] Hold wrong-source, unsupported, incomplete and unresolved-policy results Pending; never approve from an untrusted response.
- [ ] Test `"0"`, absent flags, `cannot_sell_all`, critical-plus-missing fields, `0.05`, empty and full tax, proxy and wrong-token evidence.

## Policy and independent liquidity

- [ ] Obtain explicit tax-threshold and privileged-admin admissibility decisions before enabling live approval.
- [ ] Obtain a versioned freshness policy including evidence TTL and refresh cadence; leave live-change recovery open until decided.
- [ ] Define independently verifiable eligible pools, reserves or active positions, quote asset, valuation source and observation block/time.
- [ ] Deduplicate eligible pools and distinguish headline liquidity from concentrated-liquidity executable depth.
- [ ] Evaluate independent exact USD valuation strictly above 10000; hold missing or unreliable evidence Pending.
- [ ] Test 9999, 10000 and 10001 USD, absent LP evidence, duplicate pools and mismatched asset identity.

## Lifecycle and coverage

- [ ] Refresh affected community evidence before lock and invalidate approval on expiry or asset mapping change.
- [ ] Integrate authenticated per-community approval and consistent field reasons with lifecycle, logs and future clients.
- [ ] Verify GoPlus and independent liquidity coverage for actual Robinhood testnet tokens; record request, date and limitations.
- [ ] Label fixtures and retain Pending for unsupported coverage; do not substitute mainnet `4663` for testnet `46630`.
- [ ] Test pre-lock expiry and changed mapping, idempotent refresh and post-lock snapshot protection.
