## Why

An autonomous player agent today only runs if the user starts a process on their own machine with two secrets in the environment (the agent key and the NEAR AI Cloud key). That is too technical for most players, and the browser-made key is lost on page refresh. The open decision "where an autonomous agent runs for users other than the owner" (docs/player-agents.md) is now decided for the testnet release: a hosted runner, testnet only.

## What Changes

- **Target:** a platform-hosted runner starts and stops autonomous agents for a signed-in wallet owner. The user creates an agent, funds it from their own wallet and presses Start or Stop. No terminal and no secrets for the user.
- **Target:** the platform generates and stores each hosted agent key (encrypted at rest) and holds the `NEAR_AI_API_KEY`. The platform pays for NEAR AI inference.
- **Target:** abuse limits: a maximum number of hosted agents per owner account, a per-agent and a global cap on model calls, a global kill switch, and a per-agent fund cap.
- **Target:** the `/agents` "New agent" path drops the "Run it" step. It shows Start/Stop, status and a testnet-only banner stating that the operator holds the agent key and that only valueless testnet tokens may be used.
- **Target:** an "Export key" action so an owner can take over a hosted agent.
- **Removed from the page:** the grant card ("Budget for my agent"). It is a different concept (the user's own money, and the agent cannot execute a deposit yet), so it is taken off `/agents`. The `player-policy` contract and `player:run` stay.
- **Unchanged:** the agent loop and its NEAR AI decision rules, and the user-run mode (`pnpm -C agent player:auto`).
- **Deviation to record:** the project rule "infrastructure holds no authority over player funds" is relaxed only for the agent's own account, funded by the user, on testnet. Hosted keys MUST NOT be offered on any network other than testnet.
- No mainnet deployment, no TEE key custody (separate, undecided) and no automatic payout of winnings.

## Capabilities

### New Capabilities

- `hosted-player-agents`: Testnet-only hosted autonomous agents: owner authentication, key custody, start/stop lifecycle, usage caps and disclosure.

### Modified Capabilities

None. `arena-player-agents` is still a pending change (not yet in `openspec/specs/`), so its "no player-spending authority" requirement cannot take a delta. The testnet-only exception for a hosted agent's own funded account is recorded as a deviation here, in design.md and in the new spec.

## Impact

- New hosted-agent service with key storage and a runner process (a separate worker, not a serverless function), reusing `agent/src/player/autonomous.ts`.
- New owner-authenticated API for create, fund-address, start, stop, status and export.
- `web/src/app/agents/page.tsx` and `web/src/components/agents/autonomous-agent.tsx` change; `agent-grants.tsx` is removed.
- New secrets: a key-encryption key and `NEAR_AI_API_KEY` held by the service. New spend: NEAR AI Cloud usage (about USD 0.0003 per decision; at most 12 calls per agent per hour by default).
- Open: where the worker runs, owner authentication scheme and the exact caps. See design.md. Future mainnet, bring-your-own-key and fees are out of scope.
