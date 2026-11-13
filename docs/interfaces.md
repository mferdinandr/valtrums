# Planned interfaces

**Every new API, event and schema below is planned and illustrative. None is a ready-to-call endpoint.** [Current-state.md](current-state.md) describes existing calls. Publish a versioned actual ABI before clients use these designs.

## Common records

Amounts and nanosecond timestamps are decimal strings, never JavaScript numbers. Bind addresses to their chain/token mapping. Mutations carry idempotency keys and expected state/round versions; the contract enforces uniqueness.

| Planned record | Required fields |
| --- | --- |
| AssetId | NEAR token account, decimals, Robinhood mainnet reference token (for prices and audits), mapping version |
| BattleConfig | Creator/type, authenticated fee recipients, communities, mode, audit/observation policy hashes, gathering policy |
| LockedSnapshot | Battle, original communities, positive vault totals, beneficiary deposits, creator position, destinations, config hash |
| Round | Index, candidates, start/end, mode, policy hash, evidence references, status |
| Position | Beneficiary, community, actual credited units, snapshot |
| Allocation | Battle/final round, winner, per-token total fee (floor(vault * snapshotted_fee_bps / 10000)), snapshotted creator share and protocol recipient, winner-pool remainder order, immutable allocation ID |
| Entitlement | Entitlement/allocation IDs, asset, amount, beneficiary, claimed amount |
| LedgerView | Live supply, entitlements, escrow and burns per token; whether it balances |
| Escrow | Winning asset/amount, participant attribution, backing, decision/execution references; no assumed vote parameters |

Planned mode enum: `PricePercentGain`, `MarketCapPercentGrowth`, `VolumeToInitialMarketCap`, `LowestMaximumDrawdown`.

## Planned contract calls

| Planned method / message | Caller and checks | Effect |
| --- | --- | --- |
| create_battle(config) | Creator; zero to sixteen distinct communities, one mode, start time now + 60 s to now + 7 days | Open battle; no bond |
| join_battle(battle_id, token) | Anyone before the start; allowlisted token only | Adds or reuses the community and registers the caller's position |
| cancel_battle(battle_id) | Anyone after the start; unlocked, fewer than two funded communities | Cancelled; no rounds |
| claim_refund(battle_id, community) | Depositor of a cancelled battle; one yocto | Returns the credited token units; restores the position if the transfer fails |
| set_joinable_asset(asset) / remove_joinable_asset(token) | Protocol account; one yocto | Changes the allowlist (at most 64) |
| submit_audit(battle_id, evidence) | Authorized auditor; versioned chain/token evidence | Pass, Reject or Pending per asset; no unresolved-policy bypass |
| ft_transfer_call(arena, amount, lifecycle_deposit message) | Depositor, on the community token; before the start | Credit only the units the arena actually receives |
| lock_battle(battle_id, expected_version) | Authorized trigger at or after the start; at least two funded communities with fresh audits and backing, creator stake and policy gates | Freeze funded communities and deposits atomically; empty communities excluded |
| open_round(battle_id, round_id, observations) | Scheduler/oracle; correct candidates/policy/start evidence | Record next 30-second interval |
| resolve_round(battle_id, round_id, observations) | Authorized role; complete mode-specific interval evidence | Compute winner or next tied candidates; no funds released on tie |
| allocate_settlement(battle_id, final_round_id) | Valid final state and unique allocation ID | Split losing tokens once; escrow winning principal |
| claim_entitlement_as_representation(amount) | Beneficiary, on the token contract | Mint the claimed amount into the beneficiary's NEAR wallet; consume the entitlement once |
| vote_lifecycle_disposition(battle_id, burn_percent) | Winning participant, once per battle | Record a burn share weighted by principal |
| execute_lifecycle_disposition(battle_id, max_releases) | Anyone after the window | Release escrow once: returns become entitlements, the burned share leaves the supply |
| grant_player_policy(policy), revoke_player_policy(policy_id) | User authorization | Enforce/revoke bounded delegation; preserve existing in-flight obligations |

DAO API boundaries do not decide membership, vote weights, quorum, timing, fallback or certificate format.

Planned paginated views: `get_battle`, `list_battles`, `get_round`, `get_position`, `get_audit`, `get_entitlements`, `get_ledger`, `get_principal_escrow`, `get_player_policy`.

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
| entitlement_claimed | Beneficiary, asset, amount |
| principal_escrowed / dao_disposition_recorded / principal_disposition_executed | Escrow, tally, returned and burned amounts |
| player_policy_granted / player_policy_revoked | User, scope hash, budget, expiry/revocation version; no keys |

Replay must reproduce the same projection without minting, allocating or claiming twice.

## Planned player-agent and MCP boundary

A player policy binds user, contracts/methods, chain/asset/community filters, per-action/cumulative token budgets, gas, expiry, destinations and revocation. Unused funds remain attributable/recoverable: the user or delegate may cancel an undispatched reservation, undispatched reservations expire (default 1 hour, configurable), a dispatched obligation is never released by timeout or revocation alone, a delegate differs from the user and revocation is permanent per grant id. Model output cannot widen a grant. Enforce token limits and expiry outside the browser; legacy session keys only provide narrower method/receiver/gas restrictions.

| Planned MCP tool | Permission | Result |
| --- | --- | --- |
| list_battles / inspect_battle / inspect_audit | Read | Current state with network, freshness and limitations |
| inspect_balance / inspect_entitlements / inspect_escrow | Account-scoped read | Funds, rewards to claim and DAO statuses |
| preview_create / preview_deposit / preview_claim | No execution | Canonical action, costs, assets, recipient, policy/version, expiry |
| submit_action(preview_id, authorization) | User approval or valid bounded grant | Revalidate preview and reserve budget; return action ID |
| get_action_status(action_id) | Authorized read | Pending/confirmed/reconciliation status and transaction evidence |
| revoke_delegation(policy_id) | User | Revocation receipt and in-flight obligations |

The read tools are implemented in `agent/src/mcp/` (MCP over stdio: `pnpm -C agent read:mcp`; HTTP read API for the web terminal: `pnpm -C agent read:serve`, proxied by `web/src/app/api/arena/*`). Account-scoped reads require a read session opened with a NEP-413 signature from a full-access key; the session selects whose data is read and grants no signing or spending authority. Preview, submit, action status and revocation tools remain planned. Bind previews to a canonical hash and recheck balances, audit, round openness and limits before signing. Changed/expired previews require fresh authorization unless an existing grant explicitly covers the new action. Treat provider/metadata prompt text as untrusted. Reject infrastructure credentials at player-spending APIs.