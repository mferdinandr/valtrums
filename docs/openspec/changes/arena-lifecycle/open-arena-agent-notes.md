# Open arena agent notes (phase P2)

Interface notes for the UI. The contract side is in [open-arena-contract-notes.md](open-arena-contract-notes.md). Everything here lives in `agent/`. No action signs or sends: each action is previewed, authorized with a NEP-413 signature over the preview hash, revalidated, and handed back as one unsigned transaction for the user's wallet. A transaction hash or a signature is never treated as paid; only a verified final receipt confirms an action.

## Flow (unchanged)

`preview_action {request}` -> `authorize_action` -> `prepare_action` (revalidates against fresh chain reads; a changed binding rejects the action) -> wallet signs -> `report_broadcast` -> `action_status`. The `request` object below is the `request` argument of `preview_action`. Unknown fields are refused.

## Action kinds

All integers are exact: `battleId` is a positive safe integer, `community` is 0 to 15, amounts are positive integer strings, request ids are 32 non-zero bytes of lowercase hex, EVM addresses are `0x` plus 40 hex, non-zero. Each preview carries `transaction.receiverId`, `methodName`, `args`, `gas`, `deposit` and `costs.notes`; `binding` is what the user approves.

| kind | request | receiver and method | deposit | notes |
| --- | --- | --- | --- | --- |
| `create_battle` | `{assets: Asset[] (0..16), mode, startAtMs?}` | arena `create_lifecycle_battle` | 0.1 NEAR upper bound | `startAtMs` is a decimal string (a safe integer number is accepted too) and must be between now + 60 s and now + 7 days or the preview fails with `invalid_request`. The preview shows the ISO start time and warns that the creator must deposit before the start. Without a start time the preview warns the battle can never be cancelled or refunded, and `start_at_ms` is omitted from the args. |
| `join_battle` | `{battleId, representation}` | arena `join_lifecycle_battle {battle_id, representation}` | 0.02 NEAR storage budget (arena refunds the excess) | Names a representation, never an index. The binding holds the allowlisted asset identity read from `get_lifecycle_joinable_asset`; a changed allowlist entry rejects the prepared action. The limitations say whether it joins community N or adds a new one. Moves no tokens; deposit follows with the existing `deposit` action after the community passes audit and backing. |
| `cancel_battle` | `{battleId}` | arena `cancel_lifecycle_battle {battle_id}` | 0 | Anyone. Only with a start time, start passed, not locked, not cancelled, fewer than 2 funded communities. |
| `claim_refund` | `{battleId, community}` | arena `claim_lifecycle_refund {battle_id, community}` | 1 yocto | Cancelled battles only; the caller needs a position above 0. Pull-based: the refund is real only after the `lifecycle_refund` event (a callback restores the position on failure). |
| `settle_battle` | `{battleId}` | arena `settle_lifecycle_battle {battle_id: "<id>", max_entitlements}` | 0.01 NEAR times the batch | Reads `get_settlement_progress`. Batch is min(15, remaining). Binding holds recorded, total and batch, so after another caller advances the cursor the prepare step rejects and the UI previews again. Repeat until recorded equals total (`already_settled` afterwards). Gas 300 TGas. |
| `reserve_escrow` | `{battleId}` | arena `reserve_lifecycle_escrow {battle_id: "<id>"}` | 0.01 NEAR | Permissionless precondition of `execute_disposition`; `already_done` once reserved. |
| `vote_disposition` | `{battleId, burnPercent: 0 to 100}` | arena `vote_lifecycle_disposition {battle_id: "<id>", burn_percent}` | 0.01 NEAR storage budget | Only winning participants (position above 0 in the principal community) inside the window. One vote, final; there is no view of who voted, so a second vote is refused by the contract, not the preview. |
| `execute_disposition` | `{battleId}` | arena `execute_lifecycle_disposition {battle_id: "<id>", max_releases}` | 0.01 NEAR times the batch | Permissionless after the window; needs status `decided` and the escrow reserved. Batch is min(10, remaining). Repeat until released equals total. Gas 250 TGas. |
| `request_dao_burn` | `{battleId}` | payout `request_dao_burn {backing, holder, request_id, destination}` | 0.03 NEAR | Every argument is derived, none comes from the caller: backing is the winning community's representation, holder is the arena, request id is the recorded burn release id, destination is the backing's frozen sink (`get_dao_sink`). Needs the burn release recorded (`release_not_recorded` otherwise) and a sink set (`sink_not_set`). Needs a configured payout contract. A burn counts only after a finalized debit to the sink. |
| `payout` (existing) | `{backing, amount, destination, requestId?, grant?}` | payout `request_payout` | 0.03 NEAR | Unchanged. Use it for entitlements. |
| `late_refund` | `{backing, amount, destination, requestId?}` | payout `request_late_refund {backing, beneficiary, request_id, amount, refund_address}` | 0.03 NEAR | The beneficiary is always the caller. The backing checks the address is the one bound at deposit; the preview cannot pre-check it (no view by address). `requestId` is assigned at preview and then fixed. |
| `register_position`, `deposit` (existing) | unchanged | | | Kept for backwards compatibility. They now also refuse a cancelled battle (`battle_cancelled`) and a battle past its start time (`battle_started`). A deposit needs only the target community's audit and backing. |

## Error codes (`ActionError.code`, surfaced as `<code>: <message>`)

Existing: `invalid_request`, `unsupported_route`, `battle_not_found`, `battle_locked`, `audit_missing`, `audit_expired`, `backing_missing`, `not_registered`, `already_registered`, `insufficient_balance`, `insufficient_entitlement`, `grant_invalid`, `not_configured`.

New: `battle_cancelled`, `battle_started`, `battle_not_started`, `battle_full`, `not_joinable`, `not_cancellable`, `not_cancelled`, `nothing_to_refund`, `winner_not_resolved`, `already_settled`, `already_done`, `vote_not_open`, `vote_closed`, `not_a_winner`, `escrow_not_reserved`, `nothing_to_execute`, `release_not_recorded`, `sink_not_set`.

## Read model (DTOs)

- Battle schema (`get_lifecycle_battle_v1` and the application detail route): `communities` may be empty (0 to 16); new optional `start_at_ms` (u64 string or null) and `cancelled` (boolean). An older contract without the fields still parses. Community and round indices are capped at 0..15.
- Battle list items (`GET battles`, and `searchBattles`): new `startAtMs` (string or null), `cancelled`, `enteredCount` (communities with a deposit), `pendingCount` (zero vault) and a `funded` flag on every community. `status` gains `cancelled` (also a valid `status` filter); `open`, `locked`, `decided` are unchanged. A pending community is one that exists but has no deposit yet; it does not count as entered and is excluded from the lock.
- New read tool `inspect_endgame {battleId}` (needs the state source): `settlement {recorded, total, complete}`, `vote {status, windowSecs, opensAtNs, closesAtNs, open, burnWeight, returnWeight}`, `escrow {reserved, escrowId}`, `execution {released, total, burnTotal, returnTotal}` and `releases[]` (id, kind, beneficiary, amount, recorded). A null section means the contract has no value yet.
- Indexer projection per battle: optional `communitiesAdded[]` (community, representation, accountId), `cancelled` (event ref), `refunds[]`, `refundedByCommunity` and `refundFailures[]` (a failed transfer; the arena restored the position, nothing was paid). Per arena contract: optional `joinableRepresentations` (representation -> joinable, last allowlist event wins; joinable is not trusted). Present only when the events were recorded. All arena events of the open arena are modelled, so allowlist proposals keep the indexer healthy.

## Automation (agent runtime)

- Every community, funded or not, is audited and backed so a deposit can open it. The lock runs only when now is at or past the start (if any), at least 2 communities are funded, every funded community has a fresh passing record and a fresh backing approval, and it passes `expected_communities` (the total count). A cancelled battle is skipped everywhere. A community appended between passes is picked up on the next pass.
- Backing refresh: the agent calls `refresh_lifecycle_backing {battle_id, community}` (100 TGas, 0.01 NEAR, the contract refunds the excess) when an approval is missing, withdrawn or has under 3 minutes left (approvals live 10 minutes). It skips communities whose audit does not pass and untrusted representations, and waits 30 s between sends for the same community.
- Cancel pass: `cancel_lifecycle_battle {battle_id}` when the start passed with fewer than 2 funded communities, behind `AUDIT_CANCEL_ENABLED`.

## Environment variables

| name | default | meaning |
| --- | --- | --- |
| `AUDIT_LOCK_ENABLED` | off | agent may send `lock_lifecycle_battle` (final) |
| `AUDIT_CANCEL_ENABLED` | off | agent may send `cancel_lifecycle_battle` |
| `AUDIT_BACKING_REFRESH_ENABLED` | on with `AUDIT_ENABLED=true`; set `false` to stop | agent sends `refresh_lifecycle_backing`; the agent account must be whitelisted on the arena and pays the storage deposit (mostly refunded) |

## Terminal

The agent has no intent parser of its own; the web terminal turns text into the `request` objects above and calls `preview_action`. All new kinds go through that single path, so the owner's terminal files only need to build these request shapes.
