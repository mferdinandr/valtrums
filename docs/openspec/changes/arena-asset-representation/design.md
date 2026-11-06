## Context

One independently reviewed change in the arena redesign. See [coordination](../../README.md) and [product specification](../../../product-spec.md).

## Goals / Non-Goals

Deliver backed asset representation and its acceptance scenarios without claiming unrelated work or unverified network support.

## Decisions

- Contract: [capability requirements](specs/arena-asset-representation/spec.md).
- Integration boundary: Define deposit and custody interface with lifecycle.
- Asset identity binds source chain/token, NEAR representation and custody domain.
- Keep custody verifier, oracle, signer, operator and player authorization boundaries explicit. Fixtures do not prove live execution. DAO governance and provider/finality choices remain OPEN.

## Risks / Migration

Cross-chain operations must be idempotent, reconciled before retry and fail closed on missing evidence. Use isolated testnet deployments; legacy migration is out of scope.

## Receipt and liability boundary

One representation instance binds an immutable source chain, token, custody domain, source decimals and representation decimals. A receipt is uniquely identified by chain, transaction hash and log index; replay prevention must not depend on textual hash casing. Amounts are integer source units actually credited to custody, rather than the nominal transfer amount. Normalization must use the instance's fixed decimals, floor on downscaling, attribute any source residue, and reject overflow.

The receipt verifier is a trust boundary, not a claim that an operator's statement proves finality. The specific verifier, custody proof, finality/reorg policy and tax handling remain OPEN. A production path must fail closed until those decisions and authenticated evidence are in place. Test fixtures must be labeled and must not be usable as production evidence. A provisional or reorganized receipt cannot mint; a post-finality deficit must pause affected actions and preserve liabilities pending reconciliation.

Representation supply, allocated entitlements, payout/redemption reservations, DAO disposal reservations and unallocated attributed units are mutually exclusive liabilities over verified custody. Every transition must preserve `B = M + E + P + D + U`; nonrepresentable source residue is tracked separately. A reservation must remove the corresponding spendable liability before external execution, bind a unique operation identity, and remain reserved after a timeout or ambiguous callback. Restoration is permitted only after evidence establishes that no executable source-chain spend remains; neither a missing response nor a failed local callback is sufficient. Any disposition authority remains out of scope until DAO governance is designed.

The reference branch is not accepted as a verifier: its receipt method accepts caller-supplied decimal precision and its payout confirmation does not bind all evidence to the transaction and asset. Its failure handling also requires independent review for correct liability restoration. Implementations and tests must not treat those paths as proof of finalized custody or safe recovery.

Replay protection within one representation contract is insufficient if the same custody receipt can be credited by multiple representation contracts. Before enabling a verifier in production, the system must enforce a unique representation per source asset and custody domain or consume each receipt in a shared authoritative registry. That cross-instance mechanism is not established by local fixture tests.
