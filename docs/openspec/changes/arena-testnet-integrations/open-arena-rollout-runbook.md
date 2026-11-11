# Open arena testnet rollout runbook

Prepared 2026-11-11 for decisions D34 to D38. Nothing in this file has been executed. **Every step is a chain action and needs the owner's explicit approval for that step alone**; approving one step never approves the next. Each step first runs as a dry run (the script prints signer, receiver, method, arguments, gas and deposit and sends nothing); only the approved step is re-run with `--send`.

Script: `scripts/testnet-wiring/open-arena.mjs` (one action per invocation). It reads keys from the repository's git-ignored `.env` (`TESTNET_<ROLE>_ACCOUNT_ID` and `TESTNET_<ROLE>_PRIVATE_KEY`); it never prints a key and never takes one as an argument. It loads `near-kit` from `agent/node_modules`, so run `pnpm install` first.

Facts used (from `docs/evidence/2026-11-09-near-testnet-wiring.json` and `docs/testnet-evidence.md`): arena `arena.valtrum-owner-b694.testnet` (deploy key: owner), DAO `valtrum-protocol.sputnikv2.testnet` (council 2 of 3, bond 1 NEAR, last recorded proposal 16), backings `backing-<symbol>.valtrum-owner-b694.testnet`, custody domain `0xb994dcab6ad9a042e7bbec3ba104ec5e6b797798`, chain 46630, mainnet references on 4663.

## Preconditions

1. PRs #185 (contract) and #186 (agent) are approved and merged; the wasm is built from the merged commit: `cd contracts/arena && cargo near build non-reproducible-wasm` (the command prints the output path; record the wasm's SHA-256, which the dry run also prints).
2. A read-only status read, if the owner wants one first: `node scripts/testnet-wiring/open-arena.mjs status` (views only: allowlist, trusted flags, last DAO proposal id).

## Steps

| # | Action | Command (dry run; add `--send` after approval) | Signer | Cost | Reversible |
| --- | --- | --- | --- | --- | --- |
| 1 | Redeploy the arena code in place (no init, state kept; battle 1 keeps the old rules) | `deploy-arena <path/to/valtrum_arena.wasm>` | OWNER | gas only | Yes, by redeploying the previous wasm (no layout change, proven by the sandbox redeploy test) |
| 2a | DAO proposal: CASHCAT joinable | `propose-joinable CASHCAT` | COUNCIL1 | 1 NEAR bond (returned on approval) | Yes, by a `remove_lifecycle_joinable_asset` proposal |
| 2b | Votes for that proposal | `vote <ID> COUNCIL2`, then `vote <ID> COUNCIL3` if still in progress | COUNCIL2, COUNCIL3 | gas (300 Tgas each) | Votes are final |
| 2c to 2f | Same for WALLET, GOOD, VLAD, DEGEN | `propose-joinable <SYMBOL>` and votes | as above | 1 NEAR bond each | as above |
| 3 | Remove AI from the trusted representations (D35) | `untrust AI` | OWNER | 1 yocto | Yes (`set_lifecycle_representation_trusted` true) |
| 4 | Create the oracle account `valtrum-oracle-b694.testnet` through the testnet helper; its key is appended to `.env` as `TESTNET_ORACLE_*` | `create-oracle` | none (helper) | free | Account stays |
| 5 | Fix the lifecycle oracle | `set-oracle` | OWNER | 1 yocto | **No: permanent, can never change** |
| 6 | Set the observation policy for future locks | `set-policy <terms.json> PriceGain` | OWNER | 1 yocto | Yes for future locks; a locked battle keeps its policy |
| 7 | Run the observation collector and the oracle worker | see "Runtime" below | ORACLE (worker) | gas per round | Stop the processes |
| 8 | Live run and cancel-and-refund drill | web or terminal, user wallets | USER1, USER2, creator | faucet tokens | Evidence only |

After each step, record the transaction hash, the read-back and anything unexpected in `docs/testnet-evidence.md` and a dated JSON under `docs/evidence/`.

## Read-backs

- After 1: the account's code hash changed and `get_lifecycle_battle_v1` of battle 1 still reads.
- After 2: `get_lifecycle_joinable_assets {"from_index":"0","limit":"50"}` lists the five tokens with the exact identities in the script; the indexer stays healthy (it models `lifecycle_joinable_asset_set`, PR #186).
- After 3: `is_lifecycle_representation_trusted` is false for AI and true for the five others.
- After 5 and 6: the readiness view shows the oracle and the policy hash.

## Observation policy (step 6): owner decision needed

The draft terms in `open-arena-observation-terms.draft.json` use on-chain `slot0` at the latest block through the relay (D39 as revised 2026-11-11) and the five allowlisted tokens' mainnet pools recorded in `docs/evidence/2026-11-09-market-data-verification.json`. The decimals (18, matching the collector's price scale), tolerance (5 s) and maximum gap (15 s) are proposals, not decisions. Offline PriceGain hash of the draft: `3d54cbd5a4421eb7f1a09ef8cc249c5be7d525e52bd9f805bf17e9c7085d9dee` (`policy-hash <terms.json> <Mode>`; the encoding mirrors `ObservationTerms::digest` and the sandbox helper `terms_digest`).

**Risk found while preparing this:** the digest includes the scoring mode, but the arena stores one observation policy for every future lock. A battle whose mode differs from the policy's mode still locks, then `start_lifecycle_rounds` refuses its terms, so its deposits stay locked with no round and no cancel (cancel is refused once two communities are funded). Until this is resolved, either keep every demo battle on the policy's mode, or have the owner change the policy before each lock of another mode. The web create form currently offers all four modes.

## Runtime (step 7)

- The oracle worker exists: `pnpm -C agent build && pnpm -C agent lifecycle:oracle` with `ORACLE_PRIVATE_KEY_FILE` (or `ORACLE_PRIVATE_KEY`), `ORACLE_TERMS_PATH` (map of policy hash to the terms above), `ARENA_APPLICATION_OBSERVATION_SCOPE`, `OBSERVATION_JOURNAL_DIR`, and `ORACLE_WRITES_ENABLED=true` only after a dry start.
- The observation collector: `python3 scripts/rpc-relay.py 18546 rpc.mainnet.chain.robinhood.com` (relay), then `pnpm -C agent observations:collect` with `ARENA_CONTRACT_ID`, `ARENA_APPLICATION_OBSERVATION_SCOPE`, `ORACLE_TERMS_PATH` (the same terms map), `OBSERVATION_JOURNAL_DIR` (the same journal the oracle reads), `REFERENCE_RPC_URL=http://127.0.0.1:18546` and `OBSERVATION_QUALIFIED_MODES=PriceGain`. It reads views only, holds no key and samples every second (`COLLECTOR_INTERVAL_MS`) while a recorded round window is open.

## Not covered

- Payout live proof (an MPC-signed token transfer from the derived address) is a separate plan: `live-custody-proof-plan.md`.
- Storage and gas constants of the agent actions are estimates; record the actual values during step 8.
