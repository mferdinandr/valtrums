# Valtrum web

The existing Next.js app implements the legacy two-side arena: battle creation/deposits, portfolio, credit, claims, withdrawals and a prompt terminal. The [planned target](../docs/product-spec.md) adds multi-community modes, Robinhood rewards, principal escrow and MCP; those capabilities are not implemented here.

From repository root:

```bash
pnpm install --frozen-lockfile
pnpm -F @valtrum/web dev
pnpm -F @valtrum/web typecheck
pnpm -F @valtrum/web test
pnpm -F @valtrum/web build
```

No NEXT_PUBLIC_ARENA_CONTRACT_ID means deterministic in-memory demo data. To use the existing NEAR deployment, configure NEXT_PUBLIC_NEAR_NETWORK=testnet and NEXT_PUBLIC_ARENA_CONTRACT_ID; NEXT_PUBLIC_NEAR_RPC_URL optionally selects RPC.

The `/terminal` page is the lifecycle intent terminal (OpenSpec `arena-mcp-terminal`). A prompt in English or Bahasa Indonesia becomes one validated intent (`create_battle`, `register_position`, `deposit` or `payout`), then the same reviewed call, canonical preview comparison, wallet signature and verified receipt as the other lifecycle pages; a deposit's position credit is read separately. Communities are numbered from 1, amounts are exact whole base units, and tokens are matched by registry address through `/api/arena/v1/assets` (never invented). Payout is reviewed but cannot be submitted until spendable custody (#148) is proven and the contract exposes an entitlement. Without NEAR_AI_API_KEY the deterministic rules parse; with it, `/api/terminal/lifecycle` asks the model (server-only NEAR_AI_BASE_URL and NEAR_AI_MODEL) and still validates its reply strictly, falling back to the rules. Model output never authorizes anything. The old A/B USDC terminal panel remains only inside the legacy battle page until that page is removed.

Session keys restrict receiver, methods and gas allowance; the current expiry is checked only by the app and the key can spend the funded legacy balance/credit. A gas cap is not a token-spending cap. Users must revoke on chain to remove authority; forgetting the browser secret does not revoke it.

See [current state](../docs/current-state.md), [deployment](../docs/deployment.md) and [planned agent/MCP interfaces](../docs/interfaces.md). The target must display reward entitlement, confirmed foreign transfer and DAO principal separately and enforce player budgets/expiry outside the browser.
