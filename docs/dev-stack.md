# Local development stack

`pnpm dev` starts the frontend, read API, reference RPC relay, audit/backing/lock
agent, observation collector and oracle. These workers submit testnet transactions.
`pnpm dev:check` validates worker settings without launching them. Use
`DEV_WORKERS=0 pnpm dev` for frontend/read development without live workers.

The launcher reads worker account credentials from root `.env` and audit settings
from `agent/.env.local`. It does not forward signing keys to the frontend.

## Approval reads after an arena redeploy

The default development manifest is tracked at `config/arena.testnet.reads.json`.
Pulling code and restarting `pnpm dev` updates the ABI consistently for the team.
The old default `.agent-state/arena.testnet.reads.json` is automatically replaced
by the shared path at startup, even if it remains in `agent/.env.local`.
Other custom `ARENA_APPLICATION_MANIFEST_PATH` overrides are preserved; those
operators manage their deployment configuration separately. Direct production
`read:serve` deployments must explicitly use the tracked manifest or their own
verified configuration. The application selects its read adapter from `abi.version`.

For `near-testnet-existing-arena`, read-only RPC probes on 2026-11-12 verified
`get_lifecycle_battle_count_v1`, `get_lifecycle_battle_v1` and
`get_lifecycle_readiness_v1` on `arena.valtrum-owner-b694.testnet`. Code hash at
block 277251181 was `FSh893uD3RjntE9LvyiEAT1imwPkCJ2tgJKgJsND3Zpn`.
That deployment's manifest must use `abi.version: lifecycle-application-v1`
instead of the former `lifecycle-source-v1`, with evidence/code hash matching
the verified deployment. Do not apply this ABI setting to unrelated deployments.

Restart the read API after editing the manifest. Check the battle endpoint's
`data.readiness.backings`: it should report the contract's actual `trusted`,
`asset_matches` and `fresh` flags. A missing readiness response is unknown, not a
pending approval. A positive vault means a deposit was credited, and is displayed
separately from current approval, which may expire later.
