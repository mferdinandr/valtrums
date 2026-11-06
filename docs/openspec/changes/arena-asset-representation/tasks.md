# Tasks

Check tasks only after implementation and verification. Custody verification, finality and reorg policy remain open design gates.

## Identity and receipt verification

- [ ] Specify verifier, custody domain, source chain/token, representation account, decimals and mapping version with lifecycle.
- [x] Define finalized receipt evidence, actual balance attribution and unique chain/transaction/log identity.
- [x] Decide and document source finality, reorg handling and verifier authority before accepting live receipts.
- [ ] Reject wrong-asset, unfinalized, duplicate or unattributed receipt evidence.
- [ ] Verify actual custody increase rather than trusting declared amounts or unrelated donations.

## Representation and ledger

- [x] Implement exact reversible decimal normalization and attribute unrepresentable residual to unallocated custody.
- [ ] Mint controlled NEP-141 units only for finalized actual received units and consume each receipt once.
- [ ] Track B, M, E, P, D and U per asset in canonical custody units and expose reconciliation status.
- [ ] Transition locked losing representations into settlement entitlements without creating or losing backing.
- [ ] Reserve payout, redemption and DAO disposal liabilities exclusively before authorizing external spends.
- [ ] Disable or burn representations when reserving redemption and retain the reservation while execution is unresolved.
- [ ] Reconcile finalized payment or disposal evidence before consuming backing; restore only after definitive no-spend proof.
- [ ] Suspend affected minting and payouts on deficit, reorg or unresolved reconciliation.

## Verification

- [ ] Test short receipts, replay, unrelated transfers, wrong source and provisional receipt reorgs.
- [x] Test minimum and maximum values, decimal mismatch and attributed residual without rounding up.
- [ ] Test concurrent redemption, payout and disposal against the same backing.
- [ ] Test lost callbacks after actual debit and restoration only after definitive no-spend evidence.
- [ ] Verify B = M + E + P + D + U across transitions and partial payout completion.
