# Tasks

All implementation work below is unfinished. Completing documentation does not complete these tasks.

## 1. Integration and data

- [ ] 1.1 Verify NEAR/Robinhood testnet identity, signer key/domain/path, gas and receipt evidence
- [ ] 1.2 Verify GoPlus Robinhood testnet support and required fields; label fixtures
- [ ] 1.3 Specify price, circulating supply, volume, LP, cadence and boundary/finality policy

## 2. Backing and representations

- [ ] 2.1 Design/review custody and receipt verifier; freeze identity and decimal mapping
- [ ] 2.2 Implement actual-received NEP-141 mint and receipt replay prevention
- [ ] 2.3 Implement B/M/E/P/D/U reservations, redemption, burn/disposal and reorg recovery; prove conservation

## 3. Lifecycle

- [ ] 3.1 Implement two-or-more-community state and mandatory user/protocol creator stake without bond
- [ ] 3.2 Freeze policies/deposits/fee identity; recover late deposits outside snapshot
- [ ] 3.3 Test nonempty communities, duplicate calls and immutable snapshots

## 4. Audit

- [ ] 4.1 Implement critical-risk Reject and mandatory-unknown Pending states
- [ ] 4.2 Resolve tax/admin/critical-field/freshness policy before enabling live approval
- [ ] 4.3 Integrate separate LP check strictly above USD 10000; test equality and missing evidence

## 5. Scoring and overtime

- [ ] 5.1 Implement four exact formulas with signed/rational arithmetic
- [ ] 5.2 Implement 30-second point observations and mode-specific coverage checks without TWAP
- [ ] 5.3 Implement unlimited leader-only reset rounds, closed deposits and all-vault lock; test repeated ties

## 6. Settlement and payout

- [ ] 6.1 Implement per-token 99.9/0.05/0.05 and protocol 99.9/0.1 with deterministic rounding
- [ ] 6.2 Implement stable payout IDs, reservation-bound payload/nonce signing and original-token transfers
- [ ] 6.3 Test final receipts, replacement/revert/timeout/crash retries and no double payment

## 7. DAO escrow

- [ ] 7.1 Isolate winning principal from reward entitlements
- [ ] 7.2 Obtain explicit DAO design decision; leave membership/quorum/weights/deadline/fallback OPEN until then
- [ ] 7.3 Implement decision-bound return/disposal proof and single consumption after design approval

## 8. Player AI and MCP

- [ ] 8.1 Implement enforceable bounded token budgets, scope, expiry/revocation and service-role denial
- [ ] 8.2 Integrate NEAR AI proposed actions with deterministic policy checks
- [ ] 8.3 Implement MCP/terminal reads, canonical previews, authorized execution and unsupported-route errors

## 9. UI observability and demo

- [ ] 9.1 Display available/reserved/broadcast/confirmed rewards and independent DAO escrow
- [ ] 9.2 Implement finalized event replay, deficit/stuck-data alerts and recovery runbook
- [ ] 9.3 Record two/three-community, protocol creator, negative/zero scores, repeated ties, rounding, incomplete audit and payout retry demos
- [ ] 9.4 Run target tests and independent review; preserve implementation tracker until acceptance complete
