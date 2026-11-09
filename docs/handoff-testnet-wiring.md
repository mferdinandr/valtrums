# Handoff: testnet wiring (issues #72 and #113)

Branch `chore/testnet-wiring` (from origin/main 0da9ce5). Nothing was pushed. Testnet only. Written 2026-11-09 when the run was interrupted. No irreversible action was executed.

## Done and verified live

1. **Custody gas funding (task 1).** Deployer `0xcE806A7Ef30c7e96bC22bbA2665BAFcC78A575c6` sent 0.002 ETH to the derived custody address `0x0b740E3E90491f57699fCCD8276400E65BC70c41` on Robinhood testnet 46630. Tx `0x89e922d9366a99967fdbe8b6b39543c8b8209e76ba10ef127b5bea3cbdd469e7`, block 150727320, status 1, gas 21000 at 0.01 gwei. Balances after: deployer 0.008064 ETH, custody 0.002 ETH, custody nonce 0 (first nonce for `register_backing` is 0 unless something else sends from it; re-read with `cast nonce`).
2. **Contract change (b), code only.** `MIN_DAO_WINDOW_SECS` 60 to 30 in `contracts/arena/src/dao_api.rs` (max stays 30 days, panic text "DAO window must be between 30 seconds and 30 days", docs comments updated). Unit test extended (29 refused, 30 and 300 accepted); sandbox test `lifecycle_integration` now asserts 29 fails and 30 passes. Results: `cargo test -p valtrum-arena` 402 passed; `cargo test -p valtrum-integration --test lifecycle_integration -- --test-threads=2` 3 passed. Not yet run: clippy -D warnings, the `sputnik_authority` and `reference_registry` sandbox tests (unaffected by the bound, window 86400 there). Arena wasm built (`cargo near build non-reproducible-wasm --no-abi`): 663,592 bytes, sha256 hex `a327b1fdd946277f8f44e2fff8cb7fcaceee8ade06ea6b0c43b87d1e93160796`, bs58 `BytZZh1GuSTCqZBtzQ5VRrPP2ZkmC2yiZUmpB5qiL6nh`. The file lives in the session scratch dir and must be rebuilt (contracts/target was not cleaned).
3. **Trusted-flag question (task 5), probable cause from the evidence (not yet re-read live).** The deploy evidence lists only `activate_lifecycle`, `set_lifecycle_protocol` and registry `set_representation` for `backing1`. `arena.set_lifecycle_representation_trusted(backing1, true)` was never called, and it is a separate owner-only list from the registry's list, so `is_lifecycle_representation_trusted` correctly returned false. Confirm with a view before and after wiring.

## In progress / not started (nothing below was executed)

- Arena code redeploy (not done; current on-chain hash `6zKvCSoYBrTKrLkYtUfjLohFWaYvzAQbvtoMXwntAJR5`). Before: record `get_config`, `get_lifecycle_dao_window` (null today, or 86400 from DAO proposal 0 per old evidence, check), protocol account (`valtrum-protocol.sputnikv2.testnet`). Deploy code only (DeployContract action, no init), then re-read all of them and the new hash.
- Verifier account `valtrum-verifier-b694.testnet` (faucet) and registry `set_verifier`: not created.
- Six backings `backing-<symbol>.valtrum-owner-b694.testnet`: NOT deployed. IRREVERSIBLE when done: backing `owner` (must be the DAO `valtrum-protocol.sputnikv2.testnet`). Existing `backing1` (fixture asset, owner = DAO) is unchanged.
- registry `set_representation`, arena `set_lifecycle_representation_trusted`, payout `register_backing`: not run.
- DAO proposals (none created; last known proposal ids 0, 1, 2 are from the earlier run): six `add_reference_entry`, six `set_dao_sink` (IRREVERSIBLE, once per token, sink `0x000000000000000000000000000000000000dEaD` = 18 zero bytes then 222,173), window 30 s, `FactoryInfoUpdate` auto_update false. Not executed: no sink set, no proposals.
- Negative checks, read-back, evidence JSON, doc updates, D34 row: not started.

## Irreversible actions status

| Action | Executed |
| --- | --- |
| Any backing initialised with DAO owner (this run) | no |
| `set_dao_sink` for any token | no |
| Arena redeploy | no |
| Any DAO proposal this run | no |
| Any NEAR transaction this run | no (only the one EVM transfer) |

## Balances (NEAR, read 2026-11-09)

owner `valtrum-owner-b694.testnet` 7.6616; council1 9.9990; council2 9.9992; council3 9.9977; agent 5.0000; operator 10.0000; relayer 10.0000; user1 1.0000; user2 1.0000. No helper accounts created. Need about 26 NEAR at the owner for six backings (about 4.3 each); spare funds: operator and relayer 10 each, agent 5, councils above 3 each.

## Scripts

`scripts/testnet-wiring/` (no secrets; they read `.env` at runtime and sign in process): `lib.mjs` (env loader, retrying views, `call` helper that never throws and returns the hash and error text, `appendEnv`), `t0.mjs` (balances and addresses), `mkks.mjs` (builds a Foundry keystore in a scratch dir from the deployer key, because `cast wallet import` has no non-interactive private-key input except `--private-key`). Needs `npm i near-api-js@7` in a scratch dir next to them. Foundry use: `cast send ... --keystore <dir>/deployer --password-file <dir>/pw --rpc-url https://rpc.testnet.chain.robinhood.com`, delete the keystore afterwards (it currently exists in the session scratch dir `.../scratchpad/ks`).

## Next commands, in order

1. Rebuild arena wasm, run clippy and the two other sandbox tests, `near-contract-audit` note.
2. Read arena state, deploy the code to `arena.valtrum-owner-b694.testnet`, re-read, record the hash.
3. Create the verifier account, store key with `appendEnv` (mode 600), `registry.set_verifier` (owner, 1 yocto).
4. Fund the owner from operator, relayer, agent (record each transfer), deploy six backings after double checking every constructor argument (read `Backing::new` in `contracts/backing/src/lib.rs`, line 249, and the `Asset` struct near line 100; custody domain derived from the custody contract as the code and docs require), reusing the `backing1` wasm if the code hash matches main.
5. Wire: registry `set_representation`, arena `set_lifecycle_representation_trusted`, payout `register_backing` (custody sender the derived address, path `valtrum-custody-1`, nonce from RPC).
6. DAO proposals (council1 proposes with 1 NEAR, council2 and 3 vote), negative checks, read-back, evidence JSON, docs and D34.

## Known blockers and notes

- In this agent environment a hook rewrites plain `git` into `rtk git`, which the worktree guard refuses; `git -C "<worktree>" <cmd>` works.
- The public RPCs rate-limit; `lib.mjs` retries.
- Nothing needs an owner answer yet.
