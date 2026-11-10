## Context

Lifecycle rewards and original-token payouts differ from legacy credit claims. `settlement_plan` is an internal helper, not an RPC view; `list_open_payouts` is not complete account history. Principal release is governed by an unresolved DAO mechanism.

## Goals / Non-Goals

**Goals:** account projections, separate reward/principal balances, reviewed payout requests and truthful recovery states.

**Non-Goals:** new settlement arithmetic, reservation/signature worker implementation, confirmation authority, DAO governance or a generic delegated action service.

## Decisions

1. Extend the read foundation with account-scoped, cursor-paginated projections from verified public views/events. Query positions, settlement progress, backing entitlements/reservations and payout requests; expose history completeness/watermark. Missing historical indexing cannot become an empty confirmed history. Server-side filters and debounce/cancellation follow the foundation conventions.
2. Show eligible rewards, reserved/signing/pending amounts, delivered payouts, late funds and held principal independently by original asset. Do not sum incompatible tokens or represent a reservation as delivery. Use `get_settlement_progress` and actual exported reads; never call internal helpers as RPC methods.
3. Build wallet requests with strict integer amounts, 32-byte request IDs and 20-byte EVM destinations. Persist request identity across retries and reconcile by bound backing/account/asset/destination before creating another request. `claim_representation` consumes the caller's attributed custody; its beneficiary parameter is not authority to spend another account's custody.
4. Model authorized, signing_requested, signed, broadcast, pending_finality, reverted, reconciliation_required, confirmed and restored states distinctly. Only authoritative finality/confirmation updates paid balances. Timeout is pending/unknown, not permission to double-pay. Late-fund refunds use their separately bound path.
5. Keep signing, broadcast/reconcile and separately authorized confirmation roles in the signing owner. The client and read service hold no signer/operator keys. Custody, oracle and player delegation are likewise independent. DAO escrow never gains an owner-only release button.

6. Treat custody spendability as an independent payout prerequisite. The existing `evm/src/TestnetDepositCustody.sol` explicitly lacks withdrawals/recovery; a relayer cannot make its held tokens payable merely by signing from a configured EOA. Require backing/testnet-owner evidence that the deployed custody path actually authorizes the reservation-bound sender before enabling deposit/payout capabilities.

## Risks / Trade-offs

- Incomplete views/history → expose capability/completeness limits; coordinate indexer and contract handoffs before release.
- Double submission after interruption → stable IDs and authoritative reconciliation before retry.
- Worker not wired despite library tests → block live payout capability until signing-owner runtime evidence passes.
- Fees/gas/decimal mistakes → wallet review uses exact base units and explicit original asset/network.

## Migration Plan

Deliver read-only account fixtures first, then verified live reads, then eligible wallet actions. Keep legacy claim UX in its own adapter. Rollback disables new request creation while retaining status/reconciliation visibility. No deployment or database migration is part of this change.

## Open Questions

Final payout worker readiness, historical event coverage and deployment codecs need verification. DAO release mechanics and unresolved audit recovery decisions remain OPEN; the UI cannot resolve either.
