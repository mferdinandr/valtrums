# Valtrum web

One Next.js application for the lifecycle arena on NEAR testnet. There is no legacy two-side mode and no in-memory demo data: every page reads the deployed contracts, directly over RPC or through the read service.

| Route | What it does |
| --- | --- |
| `/` | Landing scene |
| `/arena`, `/arena/new`, `/arena/<id>` | Battle list, creation, and one battle (communities, deposits, rounds) |
| `/portfolio` | Your positions and payout state |
| `/terminal` | Lifecycle intent terminal (see below) |
| `/agents` | Grant and revoke player-agent budgets on the player-policy contract |
| `/faucet` | Claim test tokens from the faucet contract (up to two tokens per wallet approval) |

From repository root (`pnpm dev` starts web, the agent read service and the local RPC relay together; see `scripts/dev.sh`):

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm -F @valtrum/web dev
pnpm -F @valtrum/web typecheck
pnpm -F @valtrum/web test
pnpm -F @valtrum/web build
```

Configuration lives in `web/.env.local` (see [.env.example](../.env.example) for every variable). Public, browser-visible values are `NEXT_PUBLIC_NEAR_NETWORK`, `NEXT_PUBLIC_ARENA_CONTRACT_ID`, `NEXT_PUBLIC_ARENA_READ_DEPLOYMENT`, `NEXT_PUBLIC_PLAYER_POLICY_CONTRACT_ID` and `NEXT_PUBLIC_FAUCET_CONTRACT_ID`. Server-only values never use the `NEXT_PUBLIC_` prefix: `ARENA_READ_API_URL`, `NEAR_AI_*` and `PRICE_PREVIEW_RPC_URL`.

## Terminal

The `/terminal` page is the lifecycle intent terminal (OpenSpec `arena-mcp-terminal`). A prompt in English or Bahasa Indonesia becomes one validated intent (`create_battle`, `register_position`, `deposit` or `payout`), then the same reviewed call, canonical preview comparison, wallet signature and verified receipt as the other lifecycle pages; a deposit's position credit is read separately. Communities are numbered from 1, amounts are exact whole base units, and tokens are matched by registry address through `/api/arena/v1/assets` (never invented). Payout is reviewed but cannot be submitted until spendable custody (#148) is proven and the contract exposes an entitlement. Without `NEAR_AI_API_KEY` the deterministic rules parse; with it, `/api/terminal/lifecycle` asks the model (server-only `NEAR_AI_BASE_URL` and `NEAR_AI_MODEL`) and still validates its reply strictly, falling back to the rules. Model output never authorizes anything. Previews and signing also need the read service with actions enabled (`ACTION_STORE_PATH` in the agent environment).

## Faucet

`/faucet` reads the faucet contract (`NEXT_PUBLIC_FAUCET_CONTRACT_ID`) over RPC and signs `claim` calls from the user's wallet. There is no faucet server and no faucet key. The contract only hands out already backed representation tokens; funding it is described in the [agent README](../agent/README.md#testnet-faucet).

## Live price preview

A battle that is not locked yet shows a display-only chart of the competing tokens' reference prices. `/api/reference-price` reads the `slot0` price of each token's Uniswap v3 WETH pool on Robinhood Chain mainnet (4663) once per second through `PRICE_PREVIEW_RPC_URL` (falling back to `REFERENCE_RPC_URL`) and shares one reading per second between viewers; the pools are a fixed table in `src/lib/reference-price/pools.ts`. The chart plots percent change since the page opened.

- It is a market reference, **not scoring evidence**. The contract scores a round only from the oracle's recorded observations after the crews lock in, and the locked-battle chart (`ObservationChart`) shows only those persisted observations.
- A token without a v3 WETH pool (currently AI) is not drawn. If the RPC is unreachable the chart says so and draws nothing in its place.
- Lines stay flat while a pool has no trades, because the price only changes on a swap.
- If a restricted network blocks the RPC host, point `PRICE_PREVIEW_RPC_URL` at a reachable relay. Use the dedicated name: a `REFERENCE_RPC_URL` exported in the shell would otherwise override `.env.local` for the dev server.

See [current state](../docs/current-state.md), [deployment](../docs/deployment.md) and [planned agent/MCP interfaces](../docs/interfaces.md). The target must display reward entitlement, confirmed foreign transfer and DAO principal separately and enforce player budgets/expiry outside the browser.
