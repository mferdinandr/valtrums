## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver goplus and liquidity audit and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-audit/spec.md).
- Integration boundary: Coordinate approval interface with lifecycle.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Approval interface: the arena method `submit_lifecycle_audit(battle_id, community, asset, result, policy_hash, evidence_hash)`, callable only by a whitelisted agent. `pass` stores an approval bound to the community's asset identity and the policy hash; `reject` and `pending` withdraw it; a locked battle refuses changes. Auditor authority currently equals the agent whitelist.
- Reference-token audit: GoPlus supports only mainnet `4663`. Testnet mock tokens carry `reference_chain_id`/`reference_address`; the mapping is trusted only from a protocol-controlled registry in configuration. Both GoPlus and liquidity are evaluated for the mainnet reference token, the record binds the testnet asset and the reference pair, and the record, `policyHash` and `evidenceHash` label it a reference-token audit. Approval attests the mainnet reference token, not the behaviour of the testnet mock contract. The reference pair lives in the evidence (committed by `evidence_hash`), not in the on-chain community mapping.
- Policy `audit-policy-v1` is one versioned object: tax admissible up to and including 0.05; admin capabilities admissible only with renounced and unrecoverable ownership; evidence TTL configurable (default 600 s). Recovery after a live token-policy change and the minimum executable-depth policy remain OPEN.
- Liquidity is read on-chain for the reference token through a separate read-only mainnet RPC; only explicitly configured stablecoin reserves are valued at 1 USD; observation time is the block timestamp; the strict > USD 10000 rule is unchanged.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.
