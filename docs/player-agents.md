# Player agents

Two kinds of player agent exist. They differ in whose money they use, and that decides how much trust they need.

| | Grant agent (first design) | Autonomous agent (current) |
| --- | --- | --- |
| Money | The **user's own account**. A grant on `player-policy` caps what the agent may spend. | The **agent's own NEAR account and token balance**. The owner funds it by sending tokens. |
| Decides with | A rule strategy, or NEAR AI in `mode: "model"` (`player:run`). | **NEAR AI Cloud, always.** There is no rule-based path. |
| Authority | Only `reserve` (a budget hold). It cannot move tokens. | Signs `join`, `register` and `deposit` itself, with no approval step. |
| Executes a deposit? | No. Executing a reservation is an open decision (`openspec/changes/arena-player-agents/design.md`). | Yes. |
| Worst case | Budget held for up to the reservation TTL. | The balance the agent account holds. |
| Code | `agent/src/player/runner.ts`, `contracts/player-policy`, the grant part of `/agents` | `agent/src/player/autonomous.ts`, `autonomous-cli.ts`, the "Autonomous agent" part of `/agents` |

The grant agent is safe but cannot actually play. The autonomous agent plays, and its risk is bounded by what you put in its account.

## Autonomous agent

### How it decides (NEAR AI Cloud)

Every play is decided by a model on [NEAR AI Cloud](https://docs.near.ai/cloud/introduction): private inference inside a TEE (Intel TDX and NVIDIA TEE GPUs), OpenAI-compatible API at `https://cloud-api.near.ai/v1`.

- The prompt holds only numbers and ids (battle, community, vault, the limit) and a one-line play style hint (`crowd`: favour the largest vault, `underdog`: the smallest). Token names and descriptions never go in, so token metadata cannot talk to the model.
- The answer is untrusted text. It must be exactly one JSON object (optionally in one ```json fence) with only `action: "deposit"`, `user` (this agent), `battleId`, `community`, `amount` and `rationale`, naming one of the offered options, with an amount that is a positive integer within **that option's** limit. Anything else is rejected (`model_answer_invalid`).
- **No fallback.** If the model gives no answer or an invalid one, the agent sits that round out. Nothing is chosen for it by rule.
- Every answer is signed by a key that never leaves the TEE. The agent logs the NEAR AI `chat_id` with each play (`decidedBy: "near-ai"`, `chatId`), and the signature can be fetched later from `GET /v1/signature/{chat_id}?model=<model>&signing_algo=ecdsa` (free, not billed), so a play can be audited against the attested signing address.
- Default model: `deepseek-ai/DeepSeek-V4.1-Flash-1017` (private, served from NEAR AI's attested TEE infrastructure). Override with `NEAR_AI_MODEL`. Check the live list with `GET /v1/models`: model ids change (`deepseek-ai/DeepSeek-V3.1`, the old default, is no longer served and made every call fail silently).

**Cost.** One decision is about 160 prompt tokens and 130 output tokens (measured live). At the model's price (input $0.30/M, output $1.20/M tokens) that is **about $0.0003 per decision**, so 1,000 plays cost about $0.30. The agent only calls the model when there is a real choice, and it protects the key's budget: after a missing or invalid answer it leaves those battles alone for 2 minutes, and `maxModelCallsPerHour` (default 12) caps calls per hour.

### What it does each round

Each round (`intervalSecs`, default 15 s) one agent:

1. Lists the arena's joinable tokens and reads its own balance of each. With no balance it does nothing (`no_funds`).
2. Looks at the newest `scanBattles` battles that are open and start at least `minStartLeadMs` from now (default 90 s: joining and the approvals take time). A battle it already played is skipped. With nothing to choose (`no_option`) the model is not called.
3. Offers the model the communities that already exist and whose token the agent holds. Only when there is none does the model get the chance to join the newest battle with a token the agent holds.
4. Takes the model's choice and amount (at most `fractionBps`, default 25%, of its balance of that token).
5. Sends, with its own key: `join_lifecycle_battle` (only to add a community), `register_lifecycle_position` (if not registered), then waits until the community has its audit and backing approvals (up to `approvalWaitMs`, default 120 s) and sends `ft_transfer_call` with the `lifecycle_deposit` message. These are the same calls the web app makes.
6. Optionally sweeps surplus tokens to the owner (see below).

It never plays a battle twice, never plays after the start time, and stops after `maxFailures` errors in a row or `maxPerHour` plays in an hour. The arena still audits every community and checks every approval; an agent cannot make a bad token pass.

### Running it

```bash
pnpm -C agent build
cp agent/player-autonomous.example.json agent/.agent-state/my-agents.json   # edit account, style, keyEnv
# Dry run: asks NEAR AI, prints the plan, signs and sends nothing.
ARENA_CONTRACT_ID=arena.valtrum-owner-b694.testnet NEAR_RPC_URL=https://test.rpc.fastnear.com \
  pnpm -C agent player:auto --config .agent-state/my-agents.json --once
# Live: signs with the key in the environment variable named by keyEnv.
PLAYER_KEY_MY_AGENT=ed25519:... pnpm -C agent player:auto --config .agent-state/my-agents.json --live
```

`pnpm -C agent player:auto` loads `agent/.env.local` (git-ignored). Put `NEAR_AI_API_KEY` there, not only in the root `.env`: loading the whole root `.env` would put every testnet account key into this process.

Config fields (`agent/player-autonomous.example.json`): `account`, `style` (`crowd` or `underdog`; the old name `strategy` is accepted), `keyEnv`, `fractionBps`, `maxPerHour`, `maxModelCallsPerHour`, `maxFailures`, `intervalSecs`, `scanBattles`, `minStartLeadMs`, `approvalWaitMs`, and the optional `sweepTo` + `keepWhole`. A `mode` field is rejected: agents always decide with NEAR AI.

### Environment variables

The `/agents` web page needs **no new variable**: it uses the arena, the RPC and the wallet the app already has. The process that runs the agent needs (also in `.env.example`):

| Variable | Needed | Meaning |
| --- | --- | --- |
| `NEAR_AI_API_KEY` | **yes** | NEAR AI Cloud key from cloud.near.ai. Put it in `agent/.env.local`. The agent refuses to start without it. |
| `ARENA_CONTRACT_ID` | yes | The arena, for example `arena.valtrum-owner-b694.testnet`. |
| The variable named by `keyEnv` (the page uses `PLAYER_KEY_MY_AGENT`) | for `--live` | The agent's `ed25519:...` secret key. Never in the config file or on a command line. |
| `NEAR_RPC_URL` | recommended | A NEAR RPC that is not rate limited, for example `https://test.rpc.fastnear.com`. The public default often answers HTTP 429. |
| `NEAR_AI_MODEL` | optional | Model id (default `deepseek-ai/DeepSeek-V4.1-Flash-1017`). |
| `NEAR_AI_BASE_URL` | optional | Default `https://cloud-api.near.ai/v1`. |
| `PLAYER_AUTONOMOUS_PATH` | optional | Config file path, instead of `--config`. |
| `PLAYER_AUTONOMOUS_STATE_PATH` | optional | State file (default `./.agent-state/player-autonomous.json`). |
| `NEAR_NETWORK` | optional | Must be `testnet` (the only network allowed). |

### The web page (`/agents`, "Autonomous agent")

1. **Create agent**: a key pair is generated in the browser (`near-kit` `generateKey`). The agent account is the key's implicit NEAR account (the 64-character hex of the public key). The secret key is shown once and never stored or sent anywhere.
2. **Play style and owner**: the style hint for the model, and an optional "send surplus tokens back to my wallet" (`sweepTo` = the connected account, with `keepWhole` tokens kept per token).
3. **Fund it from your wallet**: "Send NEAR" (a transfer for gas and storage) and "Send tokens" (one wallet transaction that registers the agent on the token with `storage_deposit` and sends it `ft_transfer`).
4. **Run it**: download the config and copy the command. The page cannot run the agent: whoever runs the process holds the key.
5. **Status**: read from the chain every 15 s: NEAR balance, token balances and the agent's deposits in the latest 8 battles.

Code: `web/src/components/agents/autonomous-agent.tsx` and `web/src/lib/arena-read/autonomous-agent.ts`.

### Sweeping surplus back to the owner

Set `sweepTo` (the owner account) and `keepWhole` (whole tokens each token balance keeps as working capital; required, no default, so working capital is never taken silently). After each round the agent sends every balance above `keepWhole` to the owner with `ft_transfer`. It moves only what the agent holds in its own account, never anything the arena holds. A token whose contract has no storage registration for the owner is skipped (`owner_not_registered`). Without `sweepTo` nothing is swept.

### Funding the agent account

The agent account needs NEAR for gas and storage (about 0.5 NEAR is plenty on testnet), and the representation tokens it will play with (for example from the faucet). Each token contract also needs `storage_deposit` for the account before it can receive that token; the page's "Send tokens" does that.

### What happens to winnings

Winnings do **not** arrive as tokens in the agent's NEAR balance. A winner's reward is an **entitlement** on the losing token's backing contract, paid out as the original token on Robinhood Chain to an EVM address through the payout flow (`payout.request_payout`, see [testnet-e2e-runbook.md](testnet-e2e-runbook.md) and `docs/openspec/changes/arena-testnet-integrations/live-custody-proof-plan.md`). So:

- A profit is not sent to the owner automatically. The agent's NEAR token balance changes only by what it deposits, by refunds of a cancelled battle, and by what it sweeps.
- The owner collects winnings by requesting a payout to their own EVM address for the agent account's entitlement. That needs the agent account's key, so today it is done by hand (`scripts/testnet-wiring/payout-proof.mjs`), not by the agent loop.

### Hosted agents (testnet only)

OpenSpec change: `docs/openspec/changes/hosted-player-agents`. The platform can run an autonomous agent for a signed-in owner, so the owner only creates, funds, starts and stops it. Code: `agent/src/hosted/` (service) and `web/src/components/agents/hosted-agent.tsx`. Run the service with `pnpm -C agent build && pnpm -C agent hosted:agents`.

- **Deviation:** the rule "infrastructure holds no authority over player funds" is relaxed here, only for the agent's own account, funded by the user, on testnet. The service refuses to start unless `NEAR_NETWORK=testnet`, and the page says the operator holds the key.
- **Owner proof:** the wallet signs a one-use challenge (NEP-413); the service checks the signature and that the key is an access key of the account, then issues a one-hour session. Every route is scoped to that owner; another owner's agent answers `not_found`.
- **Keys:** generated on the server, stored as AES-256-GCM blobs bound to the agent account, under a key-encryption key (`HOSTED_AGENT_KEK`) kept outside the state directory. Status never returns the key. `Export key` returns it once to the owner and records the export.
- **Limits (operator-set, no defaults):** agents per owner, model calls per agent per hour, model calls per hour across all agents, and the most of one token an agent may hold and still start. An agent stops itself after 3 errors in a row and shows why. Creating the file at `HOSTED_AGENT_KILL_SWITCH_PATH` stops every agent and blocks new starts.
- **Cost:** the platform pays for NEAR AI (`NEAR_AI_API_KEY` is held by the service). About USD 0.0003 per decision; the per-agent counter `modelCalls` supports cost review.
- **Storage:** `agents.json` (encrypted keys) is the one thing that cannot be rebuilt from the chain, so back it up. It is a file for one worker on testnet; use a database (for example Postgres) with the same encrypted blobs before running more than one worker.
- **Still manual:** claiming winnings (an entitlement paid out on Robinhood Chain), as for any autonomous agent.

### Other people using agents

The agent holds a key, so whoever runs it holds the money in that account.

- **Do not create and keep keys for other users on a shared server.** That makes the operator the custodian of their funds. It is acceptable only for testnet tokens that have no value, and it must be said plainly in the UI.
- Preferred shape (what the page does): each user creates their own agent account in the browser, funds it with a limited amount, and runs the agent process themselves. The platform never sees the key.
- A hosted agent for many users needs a key-custody design (for example a TEE) and a review. It is out of scope for the testnet release and is not decided.

## Live proof (testnet, 2026-11-11)

Agent account `valtrum-user2-b694.testnet` (a funded testnet account used as the agent), battle 30 created by `valtrum-user1-b694.testnet` with 10 CASHCAT:

1. The agent asked NEAR AI once, got a valid choice, sent `join_lifecycle_battle`, waited for the audit and backing approvals and deposited **7.5 WALLET** into community 1 (`decidedBy: near-ai`, `chatId: chatcmpl-dd1b99cf-2bca-4bcf-8e8c-f03adb9eeac9`).
2. The chat signature was fetched from `/v1/signature/{chat_id}` (ecdsa, TEE signing address `0xfe0071895500a9755c18044948ab4f4e1a7f337e`).
3. The rest of the battle (lock, rounds, winner, settlement) is described in [testnet-e2e-runbook.md](testnet-e2e-runbook.md).

Lessons from the run: the model id must exist in `GET /v1/models` (a missing id returns nothing and the agent skips the round); the battle view can lag a transaction by a few seconds (the agent now polls for its new community); and the public NEAR RPC answers HTTP 429, so use FastNEAR or another keyed provider.

## Grant agent (kept)

The `/agents` page also creates a grant on `policy-v2.valtrum-owner-b694.testnet`: the agent's account, a token, a per-action cap, a total budget and an expiry. The user's funds stay in the user's account, the grant can be revoked at any time (a revoked grant stays revoked), and the contract enforces the limits, not the model or the program. A grant agent proposes deposits and holds budget with `reserve`; it cannot execute them. Run it with `pnpm -C agent player:run --config <file> [--live]`. See `agent/README.md`.

## Open decisions

| Decision | Options | Status |
| --- | --- | --- |
| Where an autonomous agent runs for users other than the owner | User-controlled process (current); hosted with TEE custody; testnet-only hosted keys | Open |
| Collecting winnings for the agent account | Owner requests the payout by hand (current); a role that requests it for the agent | Open |
| Executing grant reservations (grant agent) | A reviewed executor adapter; or retire the grant agent | Open |
| Verifying the TEE attestation of the model | Fetch and verify `/v1/attestation/report` and bind it to the signing address (see the NEAR AI verification flow) | Not done: the agent records the `chat_id`, it does not verify the signature itself |
