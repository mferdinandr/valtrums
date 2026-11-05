# Tasks

## 1. WAR contract

- [ ] 1.1 Add `contracts/war` to the workspace with NEP-141, NEP-145 and NEP-148 and an init that fixes the melt per step (4380 ppm), the step length (3600 s), the arena and USDC ids; verify `cargo build --target wasm32-unknown-unknown -p valtrum-war` succeeds
- [ ] 1.2 Implement the lazy per-account melt with an exact power and floor rounding, plus the total supply bound; verify unit tests for the spec values (90.000866 WAR after 24 steps, 81.001559 after 48), a receipt just before a step boundary, transfer round trips and supply ≥ sum of balances pass
- [ ] 1.3 Implement mint from arena USDC (refuse other senders and tokens) and `redeem` for arena-held WAR; verify unit tests for both refusals and the 1:1 burn and release pass
- [ ] 1.4 Implement `release_melt` to the arena and the backing ≥ supply check; verify a unit test that releases exactly backing minus supply and emits `melt_released`
- [ ] 1.5 Convert unused amounts to current value in `ft_resolve_transfer`; verify a unit test where a transfer call crosses a step boundary refunds the melted value
- [ ] 1.6 Add `get_params`, `get_state` and `get_account` views; verify unit tests read the next loss and next boundary
- [ ] 1.7 Document WAR rules, trust assumptions and why minting needs no sybil check in `docs/war.md`; verify the README links to it

## 2. Arena changes

- [ ] 2.1 Replace credit state with the WAR id, pending mints and the prize reserve with its fixed `draw_bps`; verify arena unit tests for init and views pass
- [ ] 2.2 Mint the credit share as WAR at `claim`, with pending mints and a public retry on failure; verify unit tests for success, failure and retry pass
- [ ] 2.3 Accept WAR deposits with an optional internal-balance top-up, redeem, route through the router, and re-mint plus restore on failure; verify unit tests for the hybrid deposit and the failed swap pass
- [ ] 2.4 Accept `prize_reserve` releases only from WAR and add the draw to the profit before the split; verify unit tests for the boosted split, stranger refunds and halted battles drawing nothing
- [ ] 2.5 Remove `deposit_with_credit` and the credit fields of the account view; verify `pnpm -F @valtrum/web test` and `pnpm -F @valtrum/agent test` still pass after their types are updated
- [ ] 2.6 Update `docs/architecture.md` and the security review for WAR and the reserve; verify the docs describe each new method

## 3. Sandbox and deployment

- [ ] 3.1 Add a sandbox scenario: battle won, WAR minted, a day passes, WAR deposit with top-up into a second battle, melt released, second battle draws from the reserve; verify `cargo test -p valtrum-integration` passes in CI
- [ ] 3.2 Extend the deploy script to launch WAR without keys and wire it to a fresh arena; verify `list-keys` shows no key on the WAR account on testnet

## 4. Web and terminal

- [ ] 4.1 Show WAR balance, next loss and countdown in place of credit; verify the web tests for the portfolio view pass
- [ ] 4.2 Map the terminal's "credit" source to a WAR transfer with top-up; verify the terminal tests for the PRD example (35 WAR + 15 USDC) pass

## 5. Parameters

- [ ] 5.1 Simulate 60 days of battles and holder behaviour with the hourly melt (4380 ppm, 10% per day) under several draw values, and record supply and reserve over time in `docs/war-simulation.md`; verify the chosen values are the ones in the deploy script

## Workflow follow-up

- Update PRD section 4 in MemePull/docs to describe WAR and the melt.
- Archive the change after review.
