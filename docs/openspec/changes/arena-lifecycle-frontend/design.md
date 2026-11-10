## Context

The frontend currently uses legacy financial calls. Target contracts accept multiple assets and modes, while current lifecycle views expose only partial readiness/round data. The 3D scene is a presentation of recorded state, not a combat engine or financial authority.

## Goals / Non-Goals

**Goals:** opt-in lifecycle UX matching actual ABI, multi-community asset identity and confirmed round presentation.

**Non-Goals:** contract ABI changes, admission policy, custody verification production, oracle scheduling, settlement math, payout workers or generic canonical preview/auth services. These retain [existing owners](../../plans/arena-application-integration/ownership.md).

## Decisions

1. Reuse existing provider and wallet-sender conventions behind explicit protocol adapters. Select from a validated manifest; never reinterpret an existing legacy URL/ID as lifecycle state. Wire modes to their actual values: `PriceGain`, `MarketCapGrowth`, `VolumeRatio`, `LowestDrawdown`.
2. Populate asset selectors using debounced/cancellable backend searches. Each selection binds chain/token/representation/custody/reference identity, not symbol. Support 2+ communities within verified deployment limits; unverified capabilities remain disabled.
3. Build wallet transaction intents from reviewed exported ABI only. `create_lifecycle_battle(assets, mode)` needs actual storage funding and activation, not the legacy USDC bond/duration. `register_lifecycle_position` funds storage, not stake. Representation deposits use `ft_transfer_call` with `lifecycle_deposit`, battle ID and community. Show chain, destination, asset and integer amount before using the existing wallet sender.
4. Separate receipt/representation steps from deposits. Prepare supported custody transactions only when verified asset mapping and verifier capabilities exist; source transaction submission is pending, not credited stake. Custody verifier transport/attestation remains a trusted operator boundary owned by testnet integration, not a cryptographic bridge claim. Never expose operator keys in the client/read service.
5. Drive the scene from confirmed candidates, interval and outcome references. New lifecycle/history/readiness ABI comes from the lifecycle owner and canonical events from the indexer owner. Missing exact scores/history remain unknown. Timer expiry shows awaiting evidence; only recorded transitions start overtime/elimination/result. Chart integration is optional and cannot resolve the battle.
6. Reuse existing transaction review for direct wallet actions. Canonical preview tokens, MCP and delegated-player authorization are separate owners; the read-only foundation is not an action backend. Oracle, signer and confirmation-operator roles remain outside the browser.

7. Consume existing `communities[].audit_expires_at_ms`; do not propose a duplicate expiry view. Activation is a deployment prerequisite: `activate_lifecycle` rejects contracts with existing legacy battles. Switching the web adapter cannot activate or migrate such a contract. The existing EVM `TestnetDepositCustody` has no withdrawal/recovery method; block fund-moving custody UX until the backing/testnet owners demonstrate a compatible payout custody path.

## Risks / Trade-offs

- Current views cannot prove all readiness conditions → disable affected actions with specific capability reasons until owner handoffs pass.
- Multi-community layout complexity → responsive ranked/community views and generic emblems for unknown identities, without ticker-derived mascots.
- Wallet rejection/retry → preserve user selections and request identity, reconcile confirmed state before retrying.
- Animation hides pending state → keep readable status/action controls available with reduced motion and WebGL fallback.

## Migration Plan

Implement against versioned fixtures first, then opt in a verified deployment. Roll back protocol selection without remapping balances or IDs. No automatic activation, upgrade or schema migration. Release financial actions only after contract/backing/audit/custody prerequisites pass; a visual demo is insufficient.

## Open Questions

Deployment limits and activation/readiness ABI require owner verification. DAO remains OPEN. Audit policy v1 remains tax at most 5%, irrecoverably renounced administration, liquidity strictly above 10,000 and configurable ten-minute evidence lifetime; unresolved provider/recovery decisions stay with audit.
