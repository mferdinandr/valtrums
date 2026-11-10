## Outcome

Tracking: #148. Financial-release gate for #149, #150 and #151; coordinate custody sender/path with #150. Read-only #143 and recorded chart work #146 can proceed while this gate remains blocked. Final cross-service acceptance: #80.

Resolve the custody-to-payout compatibility blocker and deliver the trusted source-receipt verification handoff before enabling frontend source deposits.

## Blocking source finding

`evm/src/TestnetDepositCustody.sol` explicitly has no withdrawals/recovery. Tokens held by that contract are not automatically spendable by a separately configured MPC EOA. Existing deposit/verifier fixtures do not demonstrate end-to-end payout of held assets. Keep source-transfer UI disabled until this is resolved.

## Scope

Canonical owners: `arena-testnet-integrations` custody runtime/compatibility follow-ups and `arena-asset-representation` backing invariants.

- Review the deployed custody/address/code and reservation-bound payout sender/path. Prepare a concrete custody design/handoff for financial/security review if current code is incompatible; do not silently change economics or deposit into a sink.
- Wire actual receipt/finality/balance verification transport, trusted protocol registry mapping and verifier-only attestation to the receipt registry.
- Distinguish trusted operator assertions from a cryptographic bridge; preserve actual-received amounts, beneficiary/refund binding, replay protection and dispute/reorg handling.
- Publish receipt/backing/readiness evidence to read API and lifecycle frontend.

## Acceptance

- Reviewed evidence proves the selected custody path permits its authorized reservation-bound sender to spend exactly the held source asset; absent proof means capability false.
- Receipt attribution, wrong-chain/token/mapping, duplicate, late/refund and reorg cases verified; no optimistic credit on transaction submission.
- Any redesign/deployment/funding is a separate explicitly reviewed action, not authorized by this issue creation. No migration generation/application without separate explicit approvals.

## Dependencies and delivery

Coordinate payout runtime and lifecycle/backing contract owners. Existing closed custody tickets are historical context, not verification. Cross-service acceptance remains [#80](https://github.com/mferdinandr/valtrum/issues/80).

Snapshot: local `feat/living-toy-world`, HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4` plus dirty tree, reviewed 2026-11-10. New follow-up docs/crosscheck are uncommitted; publish/reconcile before apply elsewhere. No Playwright requested.
