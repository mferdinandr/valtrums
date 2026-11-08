# Tasks

Target remains Robinhood testnet `46630`. GoPlus covers only mainnet `4663`, so testnet mock tokens are audited through the mainnet reference token they represent (see [GoPlus audit policy](../../../goplus-audit.md)). Check tasks only after implementation and verification; every test here is fixture-only and none is live GoPlus, mainnet RPC or testnet coverage.

## GoPlus evidence and field mapping

- [ ] Verify the optional credential scheme (`GOPLUS_ACCESS_TOKEN`) against the live API. The endpoint works without a credential (rate limited); the client sends an `Authorization` header only when a token is set, and that scheme is an unverified assumption.
- [x] Retry a rate-limited response (HTTP 429 or provider rate-limit code) with bounded backoff and hold it Pending, never pass or reject.
- [x] Bind evidence to chain, token, representation, custody domain, mapping version, reference pair and policy.
- [x] Retain raw response, digest, provider/API version and query time for reproducible inspection.
- [x] Normalize required string flags explicitly as true, false or unknown and retain per-field reasons.
- [x] Normalize buy, sell and transfer tax as exact decimal fractions; preserve empty and malformed values as unknown.
- [x] Record ownership, proxy, source, privilege and DEX context without treating omissions as safe.
- [x] Reject mapped critical flags and a tax fraction of exactly one, retaining simultaneous unknown findings.
- [x] Hold wrong-source, unsupported, incomplete and unresolved-policy results Pending; never approve from an untrusted response.
- [x] Test `"0"`, absent flags, `cannot_sell_all`, critical-plus-missing fields, `0.05`, empty and full tax, proxy and wrong-token evidence.

## Reference-token audit

- [x] Accept a reference mapping (`reference_chain_id` 4663, `reference_address`) only from the protocol-controlled registry (originally agent configuration, now the arena's on-chain registry); a self-declared, conflicting or unregistered mapping stays Pending.
- [x] Query GoPlus and read liquidity for the mainnet reference pair; bind both the testnet asset and the reference pair, and label the record, `policyHash` and `evidenceHash` as a reference-token audit that did not audit the testnet mock itself.
- [x] Keep the direct rule for unmapped tokens: evidence for another chain or token cannot approve.
- [x] Test registry validation, held mappings, mapping change invalidation, wrong-subject GoPlus and liquidity evidence, and evidence-hash commitment to the subject.

## Committed reference pair

- [x] Commit the optional mainnet reference pair in the community asset identity (both or neither, validated and lowercased at creation, no duplicate pair, included in asset equality) and require `submit_lifecycle_audit` to name the committed pair; the agent audits the on-chain pair, compares it with the registry and holds Pending on a mismatch.
- [x] Test creation with and without the pair, one-sided and malformed pairs, duplicate pairs, an audit for a different or missing pair, and a mismatched committed pair on the agent side.

## Policy and independent liquidity

- [x] Apply owner decisions in a versioned policy (`audit-policy-v1`): tax admissible up to and including 0.05, above rejects (`tax_above_limit`); the seven admin capabilities are admissible only with renounced and unrecoverable ownership, else Reject (`admin_privilege_not_renounced`); unknown stays Pending; `policyHash` reflects the resolved decisions and parameters.
- [x] Make the evidence TTL configurable (default 600 seconds) and measure age from the older of the GoPlus query time and the oldest liquidity observation. Recovery after a live token-policy change stays OPEN.
- [x] Read pools on-chain for the reference token through a separate read-only mainnet RPC with shared retries, all reads pinned to one block; value v2 and v3 pools by quote-side balance only (`headline_quote_balance`), never the token side; observation time is the block timestamp. Fixture-only.
- [x] Value quotes only in an explicitly configured stablecoin (decimals re-read on-chain) or the configured WETH priced from one configured v3 WETH/stablecoin pool via `slot0` with a configured stable-side floor; unset or mismatched config leaves the pool unpriced and Pending (`quote_asset_unpriced`, `price_pool_floor_unset`, `price_pool_floor_not_met`, `price_pool_invalid`). No code defaults.
- [x] Label the valuation source `headline_quote_balance` in evidence, `evidenceHash`, `policyHash` and the user report as an approximation, not executable depth.
- [x] Deduplicate eligible pools; tick-based executable depth is not computed and its policy stays OPEN (not invented).
- [x] Evaluate independent exact USD valuation strictly above 10000; hold missing or unreliable evidence Pending.
- [x] Test 9999, 10000 and 10001 USD, absent LP evidence, duplicate pools and mismatched asset identity.
- [ ] Decide the minimum executable-depth policy and eligible pool aggregation for concentrated liquidity (OPEN).
- [ ] Verify the example WETH, USDG and price-pool addresses and the price pool's liquidity on-chain; they come from DexScreener and are unverified by us.

## User-facing report

- [x] Produce a structured, human-readable audit report keyed by `evidenceHash` with per-field results, tax percentages, each admin capability and ownership renounced status, reasons, policy version, TTL expiry and the reference mapping, stating in plain words that approval attests the mainnet reference token and not the testnet mock. No UI wiring in this change.

## Lifecycle and coverage

- [x] Schedule audit refresh in the agent pass (every pass, ahead of expiry, locked battles skipped, failures isolated) via a new `get_lifecycle_battle_count` view and `submit_lifecycle_audit`.
- [x] Refuse lock on expired or changed evidence end to end: audit approvals carry an expiry set only by `submit_lifecycle_audit`, `lock_lifecycle_battle` refuses an expired, missing, changed-asset or policy-mismatched approval, and the agent lock step (`lifecycle-lock.ts`, `AUDIT_LOCK_ENABLED`) sends the lock after a fresh refresh. Fixture and sandbox verified only; recovery after a live token-policy change stays OPEN.
- [ ] Integrate consistent field reasons with lifecycle logs and future clients (reports exist; no log or client wiring yet).
  - [x] Persist report observations durably with validated identity, domain/battle/community association and same-evidence history semantics (`agent/src/audit/report-archive.ts`): same-evidence time-only retries are idempotent, changed decision/evidence is preserved, conflicting ids are rejected, and atomic writes use a cross-writer lock that is never stolen based on age. Corrupt/unsupported state fails explicitly; manual lock recovery and finite capacity are documented.
  - [x] Add an optional async archive sink to `createLifecycleAuditPass` with consistent bounded structured logs (evidence/policy ids, arena/battle/community, result, reason codes, expiry, reference-token label, archive outcome), backward compatible when disabled; a sink failure is surfaced and isolated and is retryable without a provider refresh.
  - [x] Expose a passive read-only report API and runnable service (`report-query.ts`, `report-server.ts`, `report-cli.ts`): evidence lookup, backend filters, bounded stable pagination, and safe errors. JSON, HTTP text and CLI text preserve provenance, observation/attribution and historical-only limitations; freshness remains distinct from historical result and current approval is not established. No write endpoint.
  - [ ] Wire the report reasons into MCP/terminal and UI clients (deferred to #70/#76/#79).
- [ ] Verify GoPlus and independent liquidity coverage for the actual mainnet reference tokens on `4663`; record request, date and limitations.
- [x] Label fixtures as adapter verification and retain Pending for unsupported or unmapped coverage; mainnet `4663` evidence is accepted only through the registry reference mapping.
- [x] Test pre-lock expiry and changed mapping, idempotent refresh and post-lock snapshot protection.
