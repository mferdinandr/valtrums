# Tasks

## 1. Furnace contract

- [x] 1.1 Add `contracts/furnace` with `ft_on_transfer` that keeps the full amount and no method that moves coins; verify `cargo build --target wasm32-unknown-unknown -p valtrum-furnace` succeeds and a unit test confirms `ft_on_transfer` returns zero
- [x] 1.2 Record totals per coin, per battle and per sender, and emit `furnace_burned`; verify unit tests for a battle burn, a burn without a battle and two coins
- [x] 1.3 Add paged views for coins, battle burns and sender totals; verify unit tests for paging limits
- [x] 1.4 Document the furnace, what it counts and what it does not, in `docs/furnace.md`; verify the README links to it

## 2. Arena changes

- [ ] 2.1 Take the furnace id in the arena init and drop the burn account from `set_execution`; verify unit tests for init and for `set_execution` with a DEX only
- [ ] 2.2 Send the burn as `storage_deposit` then `ft_transfer_call` to the furnace with the battle id; verify an arena unit test checks the promise chain and the `burned` event
- [ ] 2.3 Keep failed burns as `pending_burn` and add `retry_burn` that zeroes before sending and restores on failure; verify unit tests for failure, retry, a second retry and retry with nothing pending
- [ ] 2.4 Make the foreign burn address the constant `0x…dEaD` and drop it from `set_foreign`; verify `mpc.rs` tests for allowed recipients and the agent's foreign-executor tests pass
- [ ] 2.5 Update the security review (findings 7 and 17) and `docs/architecture.md`; verify both describe the furnace and `retry_burn`

## 3. Sandbox and deployment

- [ ] 3.1 Add a sandbox scenario: settle a battle, burn into a furnace that was not registered with the coin, then force a failure and retry; verify `cargo test -p valtrum-integration` passes in CI
- [ ] 3.2 Launch the furnace keyless in the deploy script and pass it to the new arena; verify `list-keys` shows no key on the furnace account on testnet
- [ ] 3.3 Record in `docs/deployment.md` the amount already sent to `burn.<owner>.testnet` as "burned before the furnace"; verify the figure matches that account's balances on testnet

## 4. Burn leaderboard page

- [ ] 4.1 Read the furnace ledger and each coin's `ft_total_supply` and rank coins by burned share; verify a web unit test ranks two coins correctly
- [ ] 4.2 Show each coin's battle history with links, the furnace account and its `ft_balance_of`; verify the page renders on demo data with `pnpm -F @valtrum/web test`
- [ ] 4.3 Show the burned amount on each battle page; verify the battle page test shows it for a settled battle

## Workflow follow-up

- Archive the change after review.
