## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver goplus and liquidity audit and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-audit/spec.md).
- Integration boundary: Coordinate approval interface with lifecycle.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Approval interface: the arena method `submit_lifecycle_audit(battle_id, community, asset, result, policy_hash, evidence_hash)`, callable only by a whitelisted agent. `pass` stores an approval bound to the community's asset identity and the policy hash; `reject` and `pending` withdraw it; a locked battle refuses changes. Auditor authority currently equals the agent whitelist.
- Reference-token audit: GoPlus supports only mainnet `4663`. Testnet mock tokens carry `reference_chain_id`/`reference_address`; the mapping is trusted only from a protocol-controlled registry in configuration. Both GoPlus and liquidity are evaluated for the mainnet reference token, the record binds the testnet asset and the reference pair, and the record, `policyHash` and `evidenceHash` label it a reference-token audit. Approval attests the mainnet reference token, not the behaviour of the testnet mock contract. The reference pair is also committed in the on-chain community mapping (`asset-identity-v2`), so `submit_lifecycle_audit` requires the approval's asset to equal the committed asset including the pair; the agent compares the committed pair with the registry and holds Pending on any mismatch.
- Lock-time freshness: the arena method is now `submit_lifecycle_audit(battle_id, community, asset, result, policy_hash, evidence_hash, expires_at_ms)`. `expires_at_ms` (block time in milliseconds, U64 string in JSON) is required for `pass` (it must be in the future and at most 24 hours ahead; otherwise the call panics) and ignored for `reject` and `pending`, so withdrawals are unchanged. It is accepted only through this whitelisted-agent call, and the stored approval binds asset, policy hash, evidence hash and expiry. `lock_lifecycle_battle` refuses (fails closed, nothing changes) when any community's approval is missing, is at or after its expiry, no longer equals the committed asset, or, when the owner pinned a policy with `set_lifecycle_audit_policy_hash`, carries another policy hash. A repeated lock on a locked battle returns the original snapshot and never re-checks expiry. Deposits still need only a present approval. Behavior after a live token-policy change stays OPEN.
- Agent lock step (`agent/src/audit/lifecycle-lock.ts`, enabled by `AUDIT_LOCK_ENABLED=true`, off by default because a lock is final): after a refresh that leaves every community ready, and only if every record is a pass with at least 60 seconds of life left, the agent sends `lock_lifecycle_battle` with a 0.1 NEAR deposit (the contract keeps the storage cost and refunds the rest). It re-reads the chain before sending, never resends a locked battle, backs off 30 seconds after a failure and returns bounded errors. The contract check, not the agent, is the authority.
- Policy `audit-policy-v1` is one versioned object: tax admissible up to and including 0.05; admin capabilities admissible only with renounced and unrecoverable ownership; evidence TTL configurable (default 600 s). Recovery after a live token-policy change and the minimum executable-depth policy remain OPEN.
- Liquidity is read on-chain for the reference token through a separate read-only mainnet RPC. Valuation source `headline_quote_balance`: only the quote-side balance of each v2 or v3 pool at one block, an approximation and not executable depth. Quotes are an explicitly configured stablecoin (1 USD) or WETH priced from one configured v3 WETH/stablecoin pool's `slot0` with a configured floor; nothing is defaulted in code. Observation time is the block timestamp; the strict > USD 10000 rule is unchanged.

## Future improvements (not scheduled)

- Fallback audit for tokens GoPlus does not cover: Phase 1 static (Sourcify v2 verified source and ABI, plus on-chain owner, proxy slot and bytecode reads) can only fill admin and ownership context.
- Buy/sell simulation (for example `eth_call` with state overrides against the DEX router) is deferred: it needs an RPC with state-override support (not verified) and a decision on mapping simulated results into tax and honeypot fields.
- Until a tax and honeypot data source exists, tokens without GoPlus data stay Pending under the unknown-mandatory-field rule.

## Decisions (continued)
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
