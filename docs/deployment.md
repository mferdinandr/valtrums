# Deployment: existing system and target rollout

## Existing implementation: supported operations

These commands operate the **legacy NEAR arena**, whose rules and recorded accounts are in [current-state.md](current-state.md). This documentation PR did not run them or verify a live deployment.

Requirements: Rust stable with wasm32-unknown-unknown, near-cli-rs, Node >=22 and the pnpm version pinned in package.json. From repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm -F @valtrum/agent test
pnpm -F @valtrum/web test
```

Contract checks, from contracts/:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --exclude valtrum-integration
cargo test -p valtrum-integration
```

Sandbox tests may download a binary. Existing deployment scripts create accounts, deploy and initialize the legacy arena/router/mock contracts; use a fresh suffix. Reinitialization of an already initialized account fails. They do not deploy the target Robinhood system.

```bash
scripts/deploy-testnet.sh <fresh-suffix>
DEX_MODE=mock scripts/demo-battle-testnet.sh <suffix>
```

The default demo uses Ref exchange pools instead. It requires the Ref adapter already deployed, registered and wired, followed by scripts/setup-ref-pools.sh <suffix>. That script creates new pools on every run. Historical exchange: ref-finance-101.testnet, pools 2899/2900 for suffix 8875bb. Query configuration rather than assuming these remain current.

The exchange adapter, exchange and every receiving account must have token storage registration; exchange internal token registration is also required. Ref settlement dispatch uses 300 Tgas. The demo uses a 40-second TWAP window, 10-second passes and a 120-second battle: these are legacy settings, not the target 30-second/no-TWAP rule. Run only one agent per arena key.

Read the historically recorded arena configuration:

```bash
near contract call-function as-read-only valtrum-arena-8875bb.testnet get_config json-args '{}' network-config testnet now
```

Mock tokens are open-mint and have fixture values. Minting registers its recipient:

```bash
near contract call-function as-transaction valtrum-usdc-8875bb.testnet mint \
  json-args '{"account_id":"you.testnet","amount":"100000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-legacy-keychain send
```

Keys from the legacy script use ~/.near-credentials. Contract storage needs funded NEAR; actual cost depends on deployed code/state. Historical arena storage was about 7.3 NEAR, not a target estimate.

Run the web with deterministic demo data using pnpm -F @valtrum/web dev. To connect to the legacy arena:

```bash
NEXT_PUBLIC_NEAR_NETWORK=testnet \
NEXT_PUBLIC_ARENA_CONTRACT_ID=valtrum-arena-8875bb.testnet \
pnpm -F @valtrum/web dev
```

The agent needs ARENA_CONTRACT_ID, AGENT_ACCOUNT_ID and exactly one private-key source. See [agent README](../agent/README.md) and [container instructions](../deploy/README.md). A TS start script does not automatically load the root .env file; export the values or use Compose's env_file. Public RPC throttling can stall work.

## Planned target rollout: no ready-to-run deploy command

Target only NEAR testnet and Robinhood Chain testnet. No target custody, representation, four-mode arena, DAO or MCP deployment script exists yet.

1. Verify [integration gates](ecosystem.md): chain 46630, signer identity/key, gas, tokens, GoPlus coverage and observation providers.
2. Resolve custody/receipt/finality policy and audit approval policy. Deploy isolated test custody and backed representations with separate infrastructure/player credentials.
3. Prove actual-received minting, duplicate-receipt rejection, redemption and reservation conservation.
4. Deploy new arena lifecycle, 30-second observation scheduling, exact scoring and unlimited overtime.
5. Implement per-token allocation and constrained Robinhood payout; demonstrate lost-response retry without double payment.
6. Add principal escrow. Keep governance OPEN until explicitly decided; fixture decisions must be labeled.
7. Add bounded player delegation, NEAR AI and MCP/terminal previews; verify revocation and infrastructure-role rejection.
8. Record addresses, code hashes, policy versions, signer paths, finality, receipts and failures for a two/three-community demo.

This rollout must not overwrite the historical deployment or claim an unsupported Intents/testnet route. [Security review](security-review.md) and [roadmap](implementation-roadmap.md) list unfinished checks.
