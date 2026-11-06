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

The terminal parses prompts, validates state and shows a transaction summary. Without NEAR_AI_API_KEY it uses deterministic rules. Server-only NEAR_AI_BASE_URL and NEAR_AI_MODEL can configure inference; parser output remains untrusted. NEXT_PUBLIC_FUNDING_ROUTER=intents enables the existing 1Click proxy using optional server-only ONECLICK_API_URL and ONECLICK_API_KEY. This is not verified Robinhood testnet route support.

Session keys restrict receiver, methods and gas allowance; the current expiry is checked only by the app and the key can spend the funded legacy balance/credit. A gas cap is not a token-spending cap. Users must revoke on chain to remove authority; forgetting the browser secret does not revoke it.

See [current state](../docs/current-state.md), [deployment](../docs/deployment.md) and [planned agent/MCP interfaces](../docs/interfaces.md). The target must display reward entitlement, confirmed foreign transfer and DAO principal separately and enforce player budgets/expiry outside the browser.
