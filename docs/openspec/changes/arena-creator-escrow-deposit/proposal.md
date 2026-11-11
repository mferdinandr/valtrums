# Proposal

## Why

The product rule is that a battle cannot exist without a real creator position, but the current contract only checks it at lock (`CreatorHasNoPosition`). `create_lifecycle_battle` accepts a call with no token at all, so a battle can sit open with no creator deposit, and the web flow that creates, joins and deposits in three separate transactions leaves exactly that state whenever a later step fails (battles #12 and #13 on testnet). The owner decision of 2026-11-11 (D41) is: no fee or bond to create, but the creator must be the first account to bring a meme token into the arena, in the same transaction that creates it. The open arena then stays open until the start time for everyone else.

A plain "create and deposit in one call" is not possible with the current rules: `credit` refuses a deposit until the target community has an audit approval and a backing approval, and the agent writes those per battle and per community after the community exists. The creator's tokens therefore have to be held in escrow until those approvals arrive.

## What Changes

- **BREAKING** Battle creation moves to `ft_on_transfer` on the arena. The representation token calls it through `ft_transfer_call` with a `lifecycle_create` message (mode and start time). The same transaction creates the battle, adds the creator's community from the protocol allowlist, registers the creator's position and takes the tokens into a creator escrow. `create_lifecycle_battle` no longer creates a battle (it is refused with a message that names the new path). Protocol-created battles use the same path.
- The escrow is separate from the community vault. It is not funded vault, does not count towards the two funded communities and does not enter the snapshot or the scores.
- When the creator's community has both its audit approval and its backing approval, the escrow converts to the creator's credited position and vault in the same call that completes the approvals. Until then a battle without a credited creator position cannot lock (unchanged).
- Anyone can cancel a battle whose start time has passed while the creator position is still uncredited, even with two or more funded communities, so a stuck creator escrow cannot lock other depositors in. The creator takes the escrow back through the existing refund claim.
- Storage for the new battle is paid from a NEAR balance the creator prepaid on the arena (`storage_deposit` style), because `ft_on_transfer` carries no NEAR. The creation refuses (and the token transfer is returned) when the balance is short.
- Read views for the escrow, so the battle page can show "escrowed, waiting for audit" instead of an empty position.
- Agent action `create_battle`, the web create page and the terminal builder move to the single `ft_transfer_call` transaction; the web three-step chain (create, join, deposit) is removed.

Not changed: the allowlist, audit and backing rules, joining and depositing by other accounts before the start, the lock, rounds, settlement and the fee split. Battles created before this change keep working; no field of `Arena`, `Battle` or `Community` is added (new state sits in standalone maps).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `arena-lifecycle`: creation requires an escrowed creator deposit in the same transaction; the creator escrow converts when the community is approved; cancel is also allowed when the creator position is uncredited after the start. (The base requirements live in the in-flight change `changes/arena-lifecycle`; the delta here restates the changed requirement in full.)

## Impact

- Contract: `contracts/arena` (`ft_on_transfer` message, creator escrow storage, `set_audit` and `set_backing` hooks, refund claim, new views, storage prepay). Unit and sandbox integration tests, including a redeploy over existing state.
- Agent: `agent/src/mcp/actions/preview.ts` and `lifecycle-actions.ts` (the `create_battle` preview becomes an `ft_transfer_call`), the indexer and read API (escrow in the lifecycle view), the audit pass (already audits communities with a zero vault).
- Web: `/arena/new` becomes one wallet transaction; `/arena/<id>` shows the escrow in "Your position". The hook `use-create-and-deposit` and `creator-first-deposit` logic are replaced.
- Testnet: the arena contract is redeployed (state compatible) and the new method path needs the owner's approval; battles 1 to 13 are untouched and stay creator-less where they are.
- Docs: D41 in `findings-and-decisions.md`, `product-spec.md`, `battle-rules.md`, `interfaces.md` and the lifecycle notes.
- Security: new custody of tokens before approval. Requires `near-contract-audit` before the contract PR; the escrow must never be spendable except by conversion or a refund to its own creator.
