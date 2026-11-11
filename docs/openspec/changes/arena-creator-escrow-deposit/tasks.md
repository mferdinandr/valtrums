# Tasks

## 1. Contract: escrow model and creation path

- [ ] 1.1 Add the creator escrow storage (standalone map, new `StorageKey` appended last) and the `lifecycle_create` message to `ft_on_transfer`; verify with a unit test that a positive allowlisted deposit creates one battle, registers the creator and holds the escrow, and that zero units, a non-allowlisted token or a bad start time return the full amount.
- [ ] 1.2 Make `create_lifecycle_battle` refuse with a message naming the new path; verify with a unit test that no state changes.
- [ ] 1.3 Add prepaid storage (`storage_deposit`, `storage_withdraw`, `get_storage_balance`) and deduct the measured storage on creation; verify with tests for a short balance (transfer returned), exact balance and withdrawing only the unused part.
- [ ] 1.4 Convert the escrow in `set_audit` and `set_backing` when the creator's community has both approvals; verify with unit tests: audit only, backing only, both in either order, and that the escrow never counts as vault, funded community or snapshot content.
- [ ] 1.5 Extend the cancel rule (uncredited creator position after the start) and the refund claim (escrow in the creator's claim, restore on failure); verify with unit tests for the stuck-escrow cancel with two other funded communities, the refused cancel when the creator is credited, and a failing refund transfer.
- [ ] 1.6 Add `get_lifecycle_creator_escrow` and events (`lifecycle_creator_escrow_held`, `lifecycle_creator_escrow_credited`); verify the views return `None` for a battle created before the change.
- [ ] 1.7 Sandbox integration test through real `ft_transfer_call`, including a redeploy over state made by the previous wasm and the gas of creation and conversion; verify with `cd contracts && cargo test` and the sandbox suite.
- [ ] 1.8 Run the `near-contract-audit` skill on the diff and record findings in `docs/security-review.md`; verify that every high and medium finding is fixed or listed with an owner decision.

## 2. Agent

- [ ] 2.1 Change the `create_battle` action preview to one `ft_transfer_call` bound to arena, mode, start time, representation and amount, with validation errors for balance, allowlist and storage balance; verify with the preview unit tests including the revalidation of an old preview.
- [ ] 2.2 Read the escrow in the indexer and read API and make the audit pass approve a battle's creator community first; verify with indexer and audit-pass tests using a held escrow.
- [ ] 2.3 Update the terminal and MCP builders and the status attribution for the new action; verify with `pnpm -C agent test`.

## 3. Web

- [ ] 3.1 Replace the three-step create, join and deposit chain on `/arena/new` with one reviewed `ft_transfer_call` (plus `storage_deposit` when the balance is short); remove the dead hook and component code; verify with unit tests for the review builder and the comparison with the service preview, and `pnpm -C web test` and `tsc`.
- [ ] 3.2 Show the escrow in "Your position" ("escrowed, waiting for the audit") and the storage balance on the create page; verify with unit tests of the reader and a read-only check of the copy. The owner checks the web UI.
- [ ] 3.3 Update the copy of the create page so it states that the first deposit happens with the creation and that no bond is charged; verify by grepping for the removed three-step wording.

## 4. Docs and rollout

- [ ] 4.1 Record D41 in `docs/findings-and-decisions.md` and update `product-spec.md`, `battle-rules.md`, `interfaces.md`, `current-state.md` and the lifecycle notes where they describe creation; verify with a grep for the old creation text.
- [ ] 4.2 Run `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive` and `scripts/pre-commit.sh --all`; verify both pass before opening the PR.
- [ ] 4.3 With the owner's approval, redeploy the testnet arena and record a creation, a conversion and a cancel-with-refund in `docs/testnet-evidence.md`; verify with the transaction hashes in the evidence file.

## Workflow follow-up

- Archive `arena-lifecycle` first, then archive this change (its `MODIFIED` delta needs the archived base spec).
- Open one PR per branch to `main`; never push to `main`; the owner approves the merge.
