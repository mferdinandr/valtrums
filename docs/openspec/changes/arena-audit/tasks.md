# Tasks

Target remains Robinhood testnet `46630`. GoPlus covers only mainnet `4663`, so testnet mock tokens are audited through the mainnet reference token they represent (see [GoPlus audit policy](../../../goplus-audit.md)). Check tasks only after implementation and verification; every test here is fixture-only and none is live GoPlus, mainnet RPC or testnet coverage.

## GoPlus evidence and field mapping

- [ ] Verify the authenticated provider boundary (GoPlus credential and request scheme) against the live API; the client currently sends the credential from the environment as an assumed `Authorization` header and is fixture-verified only.
- [x] Bind evidence to chain, token, representation, custody domain, mapping version, reference pair and policy.
- [x] Retain raw response, digest, provider/API version and query time for reproducible inspection.
- [x] Normalize required string flags explicitly as true, false or unknown and retain per-field reasons.
- [x] Normalize buy, sell and transfer tax as exact decimal fractions; preserve empty and malformed values as unknown.
- [x] Record ownership, proxy, source, privilege and DEX context without treating omissions as safe.
- [x] Reject mapped critical flags and a tax fraction of exactly one, retaining simultaneous unknown findings.
- [x] Hold wrong-source, unsupported, incomplete and unresolved-policy results Pending; never approve from an untrusted response.
- [x] Test `"0"`, absent flags, `cannot_sell_all`, critical-plus-missing fields, `0.05`, empty and full tax, proxy and wrong-token evidence.

## Reference-token audit

- [x] Accept a reference mapping (`reference_chain_id` 4663, `reference_address`) only from a protocol-controlled registry in configuration; a self-declared, conflicting or unregistered mapping stays Pending.
- [x] Query GoPlus and read liquidity for the mainnet reference pair; bind both the testnet asset and the reference pair, and label the record, `policyHash` and `evidenceHash` as a reference-token audit that did not audit the testnet mock itself.
- [x] Keep the direct rule for unmapped tokens: evidence for another chain or token cannot approve.
- [x] Test registry validation, held mappings, mapping change invalidation, wrong-subject GoPlus and liquidity evidence, and evidence-hash commitment to the subject.

## Policy and independent liquidity

- [x] Apply owner decisions in a versioned policy (`audit-policy-v1`): tax admissible up to and including 0.05, above rejects (`tax_above_limit`); the seven admin capabilities are admissible only with renounced and unrecoverable ownership, else Reject (`admin_privilege_not_renounced`); unknown stays Pending; `policyHash` reflects the resolved decisions and parameters.
- [x] Make the evidence TTL configurable (default 600 seconds) and measure age from the older of the GoPlus query time and the oldest liquidity observation. Recovery after a live token-policy change stays OPEN.
- [x] Read pool reserves on-chain for the reference token through a separate read-only mainnet RPC with shared retries; value only configured stablecoin reserves at 1 USD; observation time is the block timestamp. Fixture-only.
- [x] Deduplicate eligible pools and distinguish headline liquidity from concentrated-liquidity executable depth; concentrated pools stay Pending until a minimum executable-depth policy exists (OPEN, not invented).
- [x] Evaluate independent exact USD valuation strictly above 10000; hold missing or unreliable evidence Pending.
- [x] Test 9999, 10000 and 10001 USD, absent LP evidence, duplicate pools and mismatched asset identity.
- [ ] Decide the minimum executable-depth policy and eligible pool aggregation for concentrated liquidity (OPEN).

## User-facing report

- [x] Produce a structured, human-readable audit report keyed by `evidenceHash` with per-field results, tax percentages, each admin capability and ownership renounced status, reasons, policy version, TTL expiry and the reference mapping, stating in plain words that approval attests the mainnet reference token and not the testnet mock. No UI wiring in this change.

## Lifecycle and coverage

- [x] Schedule audit refresh in the agent pass (every pass, ahead of expiry, locked battles skipped, failures isolated) via a new `get_lifecycle_battle_count` view and `submit_lifecycle_audit`.
- [ ] Refuse lock on expired or changed evidence end to end: the agent does not yet drive `lock_lifecycle_battle`, and the contract checks only that an approval is present, not its expiry, so a lapse is prevented only by the pass withdrawing the approval.
- [ ] Integrate consistent field reasons with lifecycle logs and future clients (reports exist; no log or client wiring yet).
- [ ] Verify GoPlus and independent liquidity coverage for the actual mainnet reference tokens on `4663`; record request, date and limitations.
- [x] Label fixtures as adapter verification and retain Pending for unsupported or unmapped coverage; mainnet `4663` evidence is accepted only through the registry reference mapping.
- [x] Test pre-lock expiry and changed mapping, idempotent refresh and post-lock snapshot protection.
