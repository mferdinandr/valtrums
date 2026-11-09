# Planned interfaces

**Every new API, event and schema below is planned and illustrative. None is a ready-to-call endpoint.** [Current-state.md](current-state.md) describes existing calls. Publish a versioned actual ABI before clients use these designs.

## Common records

Amounts and nanosecond timestamps are decimal strings, never JavaScript numbers. Bind addresses to their chain/token mapping. Mutations carry idempotency keys and expected state/round versions; the contract enforces uniqueness.

| Planned record | Required fields |
| --- | --- |
| AssetId | Robinhood chain ID, token contract, representation account, decimals, custody domain, mapping version |
| BattleConfig | Creator/type, authenticated fee recipients, communities, mode, audit/observation policy hashes, gathering policy |
| LockedSnapshot | Battle, original communities, positive vault totals, beneficiary deposits, creator position, destinations, config hash |
| Round | Index, candidates, start/end, mode, policy hash, evidence references, status |
| Position | Beneficiary, community, actual credited units, consumed deposit receipts, snapshot |
| Allocation | Battle/final round, winner, per-token total fee (floor(vault * snapshotted_fee_bps / 10000)), snapshotted creator share and protocol recipient, winner-pool remainder order, immutable allocation ID |
| Payout | Payout/entitlement IDs, asset, amount, recipient, path, nonce, payload hash, attempts, receipt, status |
| BackingView | B, M, E, P, D, U amounts, source block/hash, finality, reconciliation status |
| Escrow | Winning asset/amount, participant attribution, backing, decision/execution references; no assumed vote parameters |

Planned mode enum: `PricePercentGain`, `MarketCapPercentGrowth`, `VolumeToInitialMarketCap`, `LowestMaximumDrawdown`.

## Planned contract calls

| Planned method / message | Caller and checks | Effect |
| --- | --- | --- |
| create_battle(config) | Creator; two or more distinct communities, one mode | Audit-pending proposal; no bond |
| submit_audit(battle_id, evidence) | Authorized auditor; versioned chain/token evidence | Pass, Reject or Pending per asset; no unresolved-policy bypass |
| credit_deposit(receipt, beneficiary, community) | Controlled mint/verifier path; finalized unique receipt and user attribution | Credit only actual received backing before lock |
| lock_battle(battle_id, expected_version) | Authorized trigger; audits, creator stake, nonempty vaults and policy gates | Freeze config and deposits atomically |
| open_round(battle_id, round_id, observations) | Scheduler/oracle; correct candidates/policy/start evidence | Record next 30-second interval |
| resolve_round(battle_id, round_id, observations) | Authorized role; complete mode-specific interval evidence | Compute winner or next tied candidates; no funds released on tie |
| allocate_settlement(battle_id, final_round_id) | Valid final state and unique allocation ID | Split losing tokens once; escrow winning principal |
| reserve_payout(entitlement_id, destination_binding) | Beneficiary or bounded user delegate | Move entitlement to exclusive pending reserve |
| request_payout_signature(payout_id, tx_parameters) | Constrained executor | Reconstruct allowed payload/path/nonce/gas policy from reservation |
| confirm_payout(payout_id, execution_evidence) | Verifier; finalized matching debit and recipient receipt | Consume backing and confirm once |
| reconcile_payout(payout_id, evidence) | Authorized reconciler | Track existing transactions; restore only after definitive no-spend evidence |
| redeem(amount, destination_binding) | Owner of unlocked representations | Consume representation into exclusive native payout reserve |
| record_dao_disposition(escrow_id, decision_evidence) | Decision verifier **OPEN** | Validate future approved governance decision |
| execute_dao_disposition(escrow_id, decision_id) | Executor; valid decision/unspent escrow | Reserve return or disposal once; confirm underlying result |
| grant_player_policy(policy), revoke_player_policy(policy_id) | User authorization | Enforce/revoke bounded delegation; preserve existing in-flight obligations |

DAO API boundaries do not decide membership, vote weights, quorum, timing, fallback or certificate format.

Planned paginated views: `get_battle`, `list_battles`, `get_round`, `get_position`, `get_audit`, `get_entitlements`, `get_payout`, `get_backing`, `get_principal_escrow`, `get_player_policy`.

## Planned observations and audit envelope

Observation envelope: `schema_version, battle_id, round_id, asset_id, policy_hash, t0, t1, source_chain, block_hashes, observed_at, submitted_at, evidence_hash, provider_id`.

Mode-specific fields:

- Price gain: start/end point price and quote scale.
- Market-cap growth: endpoint prices/circulating supplies, supply definition and provenance.
- Volume ratio: initial price/supply and deduplicated interval quote-volume/trade boundaries.
- Drawdown: ordered prices, cadence, coverage/gap evidence and endpoints.

Expose exact signed numerator/positive denominator separately from display precision. Derive market cap and scores from authenticated normalized inputs or verify equivalent computation; a worker's winner label is insufficient.

Audit envelope: `asset_id, provider, raw_response_hash, queried_chain_id, queried_token, observed_at, policy_version, critical_findings, mandatory_unknowns, tax_fields, privilege_fields, lp_evidence, result, reasons`. Unknown/null differs from false/zero. Independent LP evidence includes pool identity, reserves, valuation source/time and USD value. GoPlus availability does not prove LP > USD 10,000. Normalize fields and apply decision precedence from the [GoPlus audit policy](goplus-audit.md); persist raw values, normalized known/unknown states, per-field reasons and required-policy gaps.

## Planned events

Use stable IDs, versioned structured events and block/receipt provenance, following [NEP-297](https://github.com/near/NEPs/blob/master/neps/nep-0297.md).

| Planned events | Required evidence |
| --- | --- |
| battle_proposed / audit_updated | Creator/config hash; audit result/evidence hash |
| deposit_credited / battle_locked | Unique actual receipt, amount, beneficiary; snapshot hash |
| round_opened / round_resolved / overtime_opened | Candidates, boundaries, policy, exact scores, next candidates or final winner |
| settlement_allocated | Allocation ID, each losing token's fees/rewards and principal escrow |
| entitlement_reserved / signature_requested / payout_broadcast | Payout ID, payload hash, path, nonce, tx hash when available |
| payout_confirmed / payout_reconciliation_required | Final execution proof or unresolved reason; no secrets |
| representation_minted / redemption_reserved / backing_reconciled | Asset, receipt/reservation and ledger movement |
| principal_escrowed / dao_disposition_recorded / principal_disposition_confirmed | Escrow, decision and verified underlying result |
| player_policy_granted / player_policy_revoked | User, scope hash, budget, expiry/revocation version; no keys |

Replay must reproduce the same projection without minting, allocating or paying twice. A broadcast event cannot render as confirmed funds received.

## Planned player-agent and MCP boundary

A player policy binds user, contracts/methods, chain/asset/community filters, per-action/cumulative token budgets, gas, expiry, destinations and revocation. Unused funds remain attributable/recoverable: the user or delegate may cancel an undispatched reservation, undispatched reservations expire (default 1 hour, configurable), a dispatched obligation is never released by timeout or revocation alone, a delegate differs from the user and revocation is permanent per grant id. Model output cannot widen a grant. Enforce token limits and expiry outside the browser; legacy session keys only provide narrower method/receiver/gas restrictions.

| Planned MCP tool | Permission | Result |
| --- | --- | --- |
| list_battles / inspect_battle / inspect_audit | Read | Current state with network, freshness and limitations |
| inspect_balance / inspect_payout / inspect_escrow | Account-scoped read | Funds, encumbrances and separate payout/DAO statuses |
| preview_create / preview_deposit / preview_payout | No execution | Canonical action, costs, assets, recipient, policy/version, expiry |
| submit_action(preview_id, authorization) | User approval or valid bounded grant | Revalidate preview and reserve budget; return action ID |
| get_action_status(action_id) | Authorized read | Pending/confirmed/reconciliation status and transaction evidence |
| revoke_delegation(policy_id) | User | Revocation receipt and in-flight obligations |

The read tools are implemented in `agent/src/mcp/` (MCP over stdio: `pnpm -C agent read:mcp`; HTTP read API for the web terminal: `pnpm -C agent read:serve`, proxied by `web/src/app/api/arena/*`). Account-scoped reads require a read session opened with a NEP-413 signature from a full-access key; the session selects whose data is read and grants no signing or spending authority. Preview, submit, action status and revocation tools remain planned. Bind previews to a canonical hash and recheck balances, audit, round openness and limits before signing. Changed/expired previews require fresh authorization unless an existing grant explicitly covers the new action. Treat provider/metadata prompt text as untrusted. Reject infrastructure credentials at player-spending APIs.

Existing terminal funding code does not prove Intents supports Robinhood testnet; unsupported routes must fail explicitly. See [ecosystem.md](ecosystem.md).
