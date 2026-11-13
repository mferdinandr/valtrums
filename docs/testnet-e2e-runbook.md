# Testnet end-to-end runbook: battle, agent, refund, claim

How to run one whole flow on NEAR testnet, and what to check at each step. Written from the 2026-11-11 run. Every chain action here sends real testnet transactions: use the helper scripts' dry run first (they print the signer, receiver, method, arguments, gas and deposit and send nothing until `--send`).

Rules that still apply (`CLAUDE.md`): keys live only in the git-ignored `.env` and are never printed or put on a command line; small English commits; run `scripts/pre-commit.sh` before a push.

## 0. Setup

| Item | How |
| --- | --- |
| Build | `pnpm install && pnpm -C agent build` |
| NEAR RPC | The public endpoint answers HTTP 429 under this load. Use `https://test.rpc.fastnear.com` (no key). The `FASTNEAR_API_KEY` in older notes answered 403. Set `NEAR_RPC_URL`, or `AGENT_RPC_URL`, `ORACLE_RPC_URL`, `COLLECTOR_RPC_URL` for the workers. |
| Reference price relay | `python3 scripts/rpc-relay.py 18546 rpc.mainnet.chain.robinhood.com` (the collector reads Uniswap v3 `slot0` on Robinhood Chain mainnet through it). Some ISPs block the host (Indonesian "Internet Positif" redirects it); use a VPN such as Cloudflare WARP, never `curl -k`. |
| Accounts | `.env` has `TESTNET_<ROLE>_ACCOUNT_ID` and `_PRIVATE_KEY` for `OWNER`, `COUNCIL1..3`, `AGENT`, `ORACLE`, `USER1`, `USER2`. |
| Balances | `USER1` and `USER2` hold test tokens (faucet: 100 per token per claim). Watch NEAR: each account needs about 0.5 NEAR. |

## 1. Run the workers

```bash
export AGENT_RPC_URL=https://test.rpc.fastnear.com ORACLE_RPC_URL=https://test.rpc.fastnear.com COLLECTOR_RPC_URL=https://test.rpc.fastnear.com
node scripts/testnet-wiring/live-run.mjs        # agent (audit, backing, lock), oracle, collector; logs in .live-state/
```

(`pnpm dev` runs the same workers plus the web app and the read API. Press Ctrl+C once and wait: a second signal used to leave `journal.lock` and `oracle.lock` behind.)

## 2. Create a battle

`scripts/testnet-wiring/battle-e2e.mjs` (dry run unless `--send`):

```bash
# The creator prepays storage once (0.1 NEAR), then creates a PriceGain battle with 10 CASHCAT that starts in 8 minutes.
node scripts/testnet-wiring/battle-e2e.mjs call USER1 arena.valtrum-owner-b694.testnet lifecycle_storage_deposit '{}' 30 100000000000000000000000 --send
node scripts/testnet-wiring/battle-e2e.mjs create USER1 CASHCAT 10 8 --send
node scripts/testnet-wiring/battle-e2e.mjs battle <id>      # start time, communities, vaults, audit/backing flags, round
```

The start time must be 1 minute to 7 days away. The creator's deposit is held in escrow until the community's audit and backing approvals exist; then it becomes the first funded community.

## 3. Let an agent join

See [player-agents.md](player-agents.md). In short: an agent account with its own token balance runs `pnpm -C agent player:auto --config <file> --live --once`. NEAR AI decides where to play. **Run it once**: each decision is a billed NEAR AI call (about $0.0003). It needs `NEAR_AI_API_KEY` in `agent/.env.local`.

The battle needs at least two funded communities with fresh audit and backing approvals before the start time. The agent worker re-audits a joined community (about 30 s to 1 min).

## 4. Lock, rounds, winner

Nothing to run: at the start time the agent worker locks the battle, the oracle starts the rounds and opens round 1, the collector samples the reference price every second, and the oracle submits the evidence after the 30 s window. Tied leaders repeat with a new window. Expect lock about 5 s after the start and the round open about 10 to 14 s after the start.

Check with `battle-e2e.mjs battle <id>`: `locked`, then `round.id`, then `round.winner`.

Thin tokens often tie: their pools only change on a swap, and every token is priced through the same ETH/USD pool. That is the rules, not a bug.

## 5. Refund drill

A battle whose start passed with fewer than two funded communities can be cancelled by anyone; depositors then claim a refund. Use `battle-e2e.mjs call` with the arena methods `cancel_lifecycle_battle {battle_id}` and `claim_lifecycle_refund {battle_id, community}` (or the Cancel and Refund buttons of the battle page). The 2026-11-11 run did this on battle 3 (see `docs/evidence/2026-11-11-open-arena-live-run.json`).

## 6. Settlement, the winners' vote and claims

After a recorded winner the arena settles: the winners' share of each losing token becomes an **entitlement** on that token's contract, and the winning principal goes to DAO escrow.

1. **Vote.** Winning participants vote on the battle page (DAO decision panel) or with the arena method `vote_lifecycle_disposition {battle_id, burn_percent}`. After the window closes, anyone executes the decision from the same panel. Returns become entitlements; the burned share is destroyed on NEAR.
2. **Claim.** Once the vote is finished, each winner claims on `/portfolio` (**Claim all to my NEAR wallet**) or directly on the token contract:

```bash
# dry run first; one yoctoNEAR deposit
node scripts/testnet-wiring/battle-e2e.mjs call USER1 backing-wallet.valtrum-owner-b694.testnet \
  claim_entitlement_as_representation '{"amount":"<units>"}' 30 1 --send
```

Check the result with `get_ledger` on the token contract: entitlements go down by the claimed amount and the claimer's balance goes up by the same amount.

## 7. Verify

- `node scripts/testnet-wiring/battle-e2e.mjs battle <id>` for the battle.
- `node scripts/testnet-wiring/battle-e2e.mjs view backing-<token>.valtrum-owner-b694.testnet get_ledger '{}'` for each token's ledger.
- The web app: `/arena/<id>` (loader at the start, chart, result card with the winner and your position), `/portfolio` (rewards to claim and DAO decisions), `/agents` (your agent's balance and plays).
