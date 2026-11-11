# Design

## Context

See proposal.md for the motivation (D41). Relevant current state:

- `create_lifecycle_battle` is a payable method that needs no token. The creator rule is enforced only at lock: `Lifecycle::lock` returns `CreatorHasNoPosition` when `creator_has_position` is false (`contracts/arena/src/lifecycle.rs`).
- `Lifecycle::credit` refuses a deposit unless the target community has both `audit` and `backing` set. Both are written per battle and per community by the whitelisted agent (`submit_lifecycle_audit`, `refresh_lifecycle_backing`) after the community exists. A community with a zero vault is still audited and backed so deposits can open.
- `ft_on_transfer` already handles `lifecycle_deposit` messages from the representation token; the arena trusts `predecessor` as the token and `sender_id` as the depositor.
- The cancel rule needs fewer than two funded communities after the start. With two or more nobody can cancel, so a funded community whose approvals lapse locks its depositors (see the open-arena notes, Risks).

Trust boundaries (unchanged in kind, one new custody point): the representation token contract authenticates the sender and amount; the agent holds only the audit and backing approval authority and never moves tokens; the protocol account owns the allowlist; the arena holds tokens in the vault and, new in this change, in the creator escrow.

## Goals / Non-Goals

**Goals:**
- A battle cannot be created without the creator's tokens arriving in the same transaction.
- The creator pays no bond and no fee beyond refundable-style storage.
- The escrow cannot be spent, scored or counted before approval, and always has an exit (conversion or refund).
- Existing battles and the storage layout survive a redeploy.

**Non-Goals:**
- Changing audit or backing rules, the allowlist, the lock, rounds or settlement. Per-asset (battle-independent) audit approvals were considered and rejected for this change (see Alternatives).
- Deciding the DAO disposition of winning principal (still OPEN) or the audit policy beyond v1.
- Mainnet.

## Decisions

### D1. Creation moves to `ft_on_transfer` with a `lifecycle_create` message
`{"action":"lifecycle_create","mode":"PriceGain","start_at_ms":"<u64>"}`. `predecessor` is the representation, `sender_id` is the creator, `amount` must be positive and the representation must be on the allowlist. One call creates the battle, adds the creator's community with the allowlisted asset identity, registers the creator and records the escrow, then returns 0 unused. Any failure returns the full amount (the existing refund path), so a refused creation never keeps tokens.

`create_lifecycle_battle` stays in the ABI (no renames, INTERFACE v1) but panics with a message that names the new path. This is the only way to make "no battle without a deposit" true on chain; leaving it creatable would keep the old gap. It is a **BREAKING** ABI behavior and needs the agent, terminal, web and test fixtures updated together.

Alternatives: keep the method and add a flag for deposit-required (rejected: the old path would remain open and the rule would be optional); a two-call create plus deposit with a pending state (rejected: that is the current gap with extra state).

### D2. Escrow is a standalone record, not vault
`LifecycleCreatorEscrow: battle_id -> { creator, representation, amount }` under a new `StorageKey` variant appended at the end; no field is added to `Arena`, `Battle`, `Community` or `Snapshot`. The escrow is invisible to `communities[i].vault`, the snapshot, scoring and the funded count (`vault > 0`). Rationale: `credit` exists so that unaudited, unbacked tokens never enter a vault; holding the tokens beside the vault keeps that invariant.

Alternative: credit the vault immediately and gate only the snapshot (rejected: an unapproved token would sit in a vault and count as funded, breaking the audit rule and the two-community rule).

### D3. Conversion happens inside the approval calls
`set_audit` and `set_backing` on the battle (the agent calls that complete the approval) check, after writing, whether the creator's community now has both approvals and an escrow exists. If so they run the same logic as `credit` (vault, position, `creator_has_position`) and delete the escrow in the same call, emitting `lifecycle_creator_escrow_credited`. No extra agent call and no permissionless conversion method. If the approval is later withdrawn, the credited vault follows the existing rules (a funded community whose approval lapses).

Alternative: a separate permissionless `convert_creator_escrow(battle_id)` (rejected: an extra transaction nobody is paid to send, and the web would have to send it).

### D4. Storage is prepaid NEAR on the arena (owner choice, D41)
`ft_on_transfer` carries no NEAR. The creator prepays with `storage_deposit` (payable, credited to the caller, optional beneficiary) and withdraws with `storage_withdraw` (one yocto, only the unused part). A creation measures the storage it adds and deducts it from the creator's balance; a short balance fails the creation and returns the tokens. This is not a bond: it is returned on request and nothing in it is slashed.

Alternative: protocol pays (rejected: anyone with one allowlisted token could create many battles and drain the protocol balance; would need a rate limit).

### D5. Cancel also when the creator position is uncredited (owner choice, D41)
After the start time, an unlocked battle whose `creator_has_position` is false can be cancelled by anyone regardless of the funded count. Cancel stays refused when the creator position is credited and two or more communities are funded. The existing refund claim is extended: for the creator's community the claim returns the position and, if it still exists, the escrow, in one transfer with the existing failure restore. Without this a creator whose token never passes the audit would lock every other depositor.

### D6. Refund and failure behavior reuse existing paths
The escrow refund uses `ft_transfer` of the representation to the creator through the same callback shape as `claim_lifecycle_refund`; a failed transfer restores the escrow and emits the failure event.

### D7. Reads
New views `get_lifecycle_creator_escrow(battle_id) -> Option<{creator, representation, amount, credited: false}>` and `get_storage_balance(account)`. The lifecycle view and the `_v1` view stay as they are; the escrow is read through the new view so the old view's shape does not change. Battles created earlier return `None`.

### D8. Agent, web and terminal
The agent's `create_battle` action preview becomes one `ft_transfer_call` on the representation (receiver the arena, one yocto, 100 Tgas, the `lifecycle_create` message), bound to the arena, mode, start time, representation and amount, and compared with the reviewed call like every other action. The audit pass already audits zero-vault communities; it must also treat a battle with a held escrow as needing its creator community approved first. The web `/arena/new` shows the prepaid storage balance, offers the same token picker and amount, and sends one transaction; the battle page shows "escrowed, waiting for the audit" in Your position. The three-step web chain is deleted.

## Risks / Trade-offs

- [New custody before approval: a bug could let escrow be spent or double counted] → the escrow has two exits only (conversion, refund to the creator); unit tests for each, plus a sandbox test of refund failure; `near-contract-audit` before the PR.
- [Creator escrow stuck if the agent never audits the token] → D5 cancel plus refund; documented in the notes.
- [Agent downtime means no conversion, so the battle cannot lock] → unchanged dependency on the agent for approvals; the web explains the waiting state instead of failing.
- [A new creator needs a small NEAR balance step first] → the web does `storage_deposit` and the create in order and explains it; not a bond.
- [Breaking the old create path] → agent preview, terminal, mocks and integration tests change in the same PR; battles 1 to 13 remain readable.
- [`MODIFIED` delta targets a spec that is not archived yet] → `openspec validate --strict` passes; archive `arena-lifecycle` first, then this change.
- [Gas] → creation does an allowlist read, three writes and an event; measure in the sandbox against the 100 Tgas call budget.

## Migration Plan

1. Land the contract change with tests, including a redeploy over state built with the previous wasm (the existing `previous_main_state_survives_a_redeploy_of_the_new_code` pattern).
2. Redeploy the testnet arena (owner approval required). Battles 1 to 13 stay as they are and keep `None` escrow.
3. Update the agent action, indexer, web and terminal in the same release; the old `create_battle` request kind keeps its name and changes its transaction.
4. Rollback: redeploy the previous wasm. State added by this change sits in standalone maps and is ignored by older code; an escrow held at that time would only be reachable again after redeploying the new wasm, so do not roll back while an escrow is held.

## Open Questions

None that change the specs. Parameters not decided here (minimum deposit amount, escrow expiry) are deliberately not invented: any positive amount is accepted and the exit is cancel plus refund.
