# Deployment: existing system and target rollout

## Web and image delivery (disabled)

[CD is disabled](ci-cd.md) at owner request; main CI does not deploy web or publish agent images. The workflow is retained only for future setup. Hosting credentials and project variables require one-time configuration. This delivery does not deploy the target contracts or start an agent process.

## Existing implementation: supported operations

These commands operate the **legacy NEAR arena**, whose recorded accounts are in the appendix of [current-state.md](current-state.md); the current lifecycle system is described at the top of that page. This documentation PR did not run them or verify a live deployment.

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

Sandbox tests may download a binary. Existing deployment scripts create accounts, deploy and initialize the legacy arena/router/mock contracts; use a fresh suffix. Reinitialization of an already initialized account fails. They do not deploy the lifecycle contracts listed below.

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

## Target contracts on NEAR testnet (deployed 2026-11-09)

An additional **read ABI staging arena** was deployed on 2026-11-10 at the user's
request for #144: `valtrum-read144-261110.testnet`, owner
`valtrum-owner-b694.testnet`. It is a new faucet-funded deployment; the existing
arena below was not upgraded. Lifecycle is **not activated**, protocol/oracle/policy
are unset, and its USDC configuration is a fixture placeholder. Public transaction,
code hash and finalized view results are in
[the deployment record](evidence/2026-11-10-application-read-deploy.json).

Live testnet deployment from the owner's accounts; details, code hashes and transactions in [testnet-evidence.md](testnet-evidence.md) and [evidence/2026-11-09-near-testnet-deploy.json](evidence/2026-11-09-near-testnet-deploy.json).

| Role | Account |
| --- | --- |
| Owner / deploy key | `valtrum-owner-b694.testnet` |
| DAO (protocol account, backing owner) | `valtrum-protocol.sputnikv2.testnet` |
| Arena (lifecycle activated, protocol = DAO) | `arena.valtrum-owner-b694.testnet` |
| Player policy (current, redeployed 2026-11-09 after #129) | `policy-v2.valtrum-owner-b694.testnet` |
| Player policy (old layout, superseded, unused) | `policy.valtrum-owner-b694.testnet` |
| Backing (fixture asset, DAO-owned) | `backing1.valtrum-owner-b694.testnet` |
| Community tokens (DAO-owned, wired 2026-11-09) | `backing-cashcat`, `backing-wallet`, `backing-good`, `backing-ai`, `backing-vlad`, `backing-degen` `.valtrum-owner-b694.testnet` |
| Infrastructure agent (in the arena whitelist, see [testnet-evidence.md](testnet-evidence.md) section 8) | `valtrum-agent-b694.testnet` |
| Faucet contract (owner-managed) | `valtrum-faucet.testnet` |
| Faucet operator (stocks the faucet) | `valtrum-operator.testnet` |

Configuration pointers (local, git-ignored files): the agent reads `agent/.env.local` and the web app `web/.env.local`. Both must point `PLAYER_POLICY_CONTRACT_ID` and `NEXT_PUBLIC_PLAYER_POLICY_CONTRACT_ID` at `policy-v2` (the old `policy` account has the layout from before PR #129), `NEXT_PUBLIC_FAUCET_CONTRACT_ID` at the faucet, and `PRICE_PREVIEW_RPC_URL` at a reachable Robinhood mainnet RPC. The faucet, its funding steps and the audit variables are described in the [agent README](../agent/README.md#testnet-faucet).

Measured storage: wasm size times 1e19 yoctoNEAR plus a small overhead (arena 664 KB is 7.0 NEAR, backing 389 KB, policy 209 KB); the DAO create cost the owner 6.1 NEAR. Deployed through a script that signs in process (keys read from the git-ignored `.env`, never passed as arguments); each account was created, keyed with the owner key, deployed and initialised in one transaction. Build: `cd contracts/<crate> && cargo near build non-reproducible-wasm --no-abi --out-dir <dir>`. Still not deployed: real-token community tokens and reference-registry entries.

The application runs on NEAR testnet only. Robinhood Chain mainnet is only read (prices, liquidity, token audits); no contract is deployed there. The earlier Robinhood testnet custody contracts are retired and the `evm/` sources were deleted. [Security review](security-review.md) and [roadmap](implementation-roadmap.md) list unfinished checks.
