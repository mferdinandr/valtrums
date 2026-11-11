# Valtrum

[![CI](https://github.com/mferdinandr/valtrum/actions/workflows/ci.yml/badge.svg)](https://github.com/mferdinandr/valtrum/actions/workflows/ci.yml)

A permissionless token-community arena coordinated on NEAR, with original-token custody and rewards on Robinhood Chain.

**Status:** the Robinhood hackathon arena is a **planned redesign** for NEAR testnet and Robinhood Chain testnet. This repository currently implements an earlier two-side NEAR arena. [Current state](docs/current-state.md) records its source/deployment limits; this documentation does not implement or deploy the redesign.

## Target game

A creator selects two or more communities and Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio or Lowest % Drawdown. Every community and the creator, including the protocol, must have real deposits before the snapshot locks. No proposal bond.

Rounds last 30 seconds without TWAP. Tied leaders compete again with reset inputs, without an overtime cap. Deposits remain closed and all original vaults remain locked.

At default settings each losing vault pays 99.9% of its own token to final-winner participants proportionally, 0.05% to creator and 0.05% to protocol. Protocol-created battles pay the full configured fee to protocol. Protocol can adjust fee and creator share for future battles; each battle snapshots its settings at creation. Rewards are paid as original tokens on Robinhood. An available entitlement and a confirmed transfer are distinct.

Winning principal enters DAO escrow for a burn/return decision; rewards do not wait for it. DAO voting mechanics remain OPEN. NEP-141 representations require 1:1 actual-received backing and exclusive redemption/payout/burn reservations.

## Four hackathon tracks

| Hackathon track | Target demonstration |
| --- | --- |
| Memecoins With Mechanics | Token-community battles, explicit prize rules and DAO-directed source-token burn |
| Games With Real Economies | Four scoring modes, locked vaults, native-token rewards and unlimited overtime |
| Social Money | Proportional community entitlements and collective disposition of winning principal |
| AI Swarms | Multiple user-funded NEAR AI player agents competing under bounded policies through shared MCP tools |

These are the project's selected [NEAR Hackathon tracks](https://nearhackathon.com/#tracks), not a claim of completed integration or award eligibility. AI Swarms acceptance needs multiple independently funded player agents; one prompt parser or an infrastructure scheduler alone is insufficient. Infrastructure agents never gain authority to spend player funds.

Technical workstreams remain chain abstraction, scoring/settlement, player AI, and terminal/MCP; they support the tracks rather than replace their names. Governance details remain OPEN.

## Documentation and implementation tracker

| Document | Purpose |
| --- | --- |
| [Product specification](docs/product-spec.md) | Requirements, lifecycle, acceptance and OPEN questions |
| [Battle rules](docs/battle-rules.md) | Formulas, observations, comparison and overtime |
| [GoPlus audit policy](docs/goplus-audit.md) | Selected fields, critical rejection, Pending states and independent LP checks |
| [Token economics](docs/token-economics.md) | Fees, rounding, backing, redemption and DAO escrow |
| [Architecture](docs/architecture.md) | Components, asset flows and trust boundaries |
| [Interfaces](docs/interfaces.md) | Planned contract, event, oracle, agent and MCP APIs |
| [Ecosystem](docs/ecosystem.md) | Partners, priorities, testnet evidence and unknowns |
| [CI/CD and signatures](docs/ci-cd.md) | CI gates, disabled CD configuration, signatures and setup |
| [Deployment](docs/deployment.md) | Existing commands versus planned rollout |
| [Security review](docs/security-review.md) | Historical scope and unfinished target review |
| [Roadmap](docs/implementation-roadmap.md) | Dependencies and acceptance gates |
| [Current state](docs/current-state.md) | Base-commit implementation and historical demos |
| [Implementation tracker](docs/implementation-tracker.md) | Parent issue content; GitHub URL pending verified publication |
| [OpenSpec proposal](docs/openspec/README.md) | Unimplemented spec-driven target change |

Swap settlement, TWAP, bond and credit plans from the earlier two-side arena no longer apply; the product specification above is the only source of truth for the game.

## Current repository and development

Rust contracts live in contracts/ (arena, router, Ref adapter, mock tokens/DEX/signer, standalone WAR/furnace and integration tests). TypeScript infrastructure is in [agent/](agent/README.md), Next.js UI/terminal in [web/](web/README.md), container configuration in [deploy/](deploy/README.md).

Requirements: Rust stable with wasm32-unknown-unknown, Node >=22 and pnpm as pinned in package.json. These commands exercise the current implementation:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm -F @valtrum/agent test
pnpm -F @valtrum/web test
pnpm dev
```

`pnpm dev` builds the agent, then starts the web, read API, Robinhood price relay, token audit/backing/lock agent, observation collector and round oracle for `arena.valtrum-owner-b694.testnet`. **The agent and oracle submit testnet transactions automatically.** Worker credentials come from the git-ignored root `.env`; audit settings come from `agent/.env.local`. Each worker receives its own credentials. Worker logs and shared observation/oracle state live in `.live-state/`. Ctrl+C stops the processes launched by this command; an existing relay is reused and left running.

Run `pnpm dev:check` first to check worker configuration without starting processes or sending transactions. Use `DEV_WORKERS=0 pnpm dev` for only the UI, read API and relay. Stop an existing process on ports 3000 or 8790 before starting the stack. `DEV_RELAY=0` skips the mainnet reference relay; `DEV_RELAY_TESTNET=1` adds the source testnet relay on 18545.

See [local stack and approval-read configuration](docs/dev-stack.md) when an arena
redeploy changes the read ABI or the UI reports approval status unavailable.

Payout relayer/operator start separately when their `PAYOUT_RELAYER_*` / `PAYOUT_OPERATOR_*` credentials and shared payout settings are configured. Otherwise startup explicitly reports them as not configured; the core arena stack still runs. Their credentials remain isolated; operator submission still follows `PAYOUT_OPERATOR_SUBMIT`.

Contract checks from contracts/:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --exclude valtrum-integration
cargo test -p valtrum-integration
```

Validate documentation proposals using an installed OpenSpec CLI:

```bash
cd docs
openspec validate --all --strict --no-interactive
```

No target Robinhood deploy or MCP command exists yet.

## License

MIT
