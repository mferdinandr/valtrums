# Valtrum

A permissionless token-community arena coordinated on NEAR, with original-token custody and rewards on Robinhood Chain.

**Status:** the Robinhood hackathon arena is a **planned redesign** for NEAR testnet and Robinhood Chain testnet. This repository currently implements an earlier two-side NEAR arena. [Current state](docs/current-state.md) records its source/deployment limits; this documentation does not implement or deploy the redesign.

## Target game

A creator selects two or more communities and Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio or Lowest % Drawdown. Every community and the creator, including the protocol, must have real deposits before the snapshot locks. No proposal bond.

Rounds last 30 seconds without TWAP. Tied leaders compete again with reset inputs, without an overtime cap. Deposits remain closed and all original vaults remain locked.

Each losing vault pays 99.9% of its own token to final-winner participants proportionally, 0.05% to creator and 0.05% to protocol. Protocol-created battles pay the full 0.1% fee to protocol. Rewards are paid as original tokens on Robinhood. An available entitlement and a confirmed transfer are distinct.

Winning principal enters DAO escrow for a burn/return decision; rewards do not wait for it. DAO voting mechanics remain OPEN. NEP-141 representations require 1:1 actual-received backing and exclusive redemption/payout/burn reservations.

## Four demo tracks

| Product track | Target demonstration |
| --- | --- |
| Memecoin mechanics | Multi-community battles, four modes and unlimited overtime |
| Chain abstraction | NEAR state, backed representations and constrained Robinhood payouts |
| User-owned player AI | NEAR AI strategy under enforceable user budgets/permissions |
| Intent terminal and MCP | Canonical previews, authorized actions and observable execution |

These are product workstreams, not a claim of organizer award eligibility. Infrastructure agents never gain authority to spend player funds.

## Documentation and implementation tracker

| Document | Purpose |
| --- | --- |
| [Product specification](docs/product-spec.md) | Requirements, lifecycle, acceptance and OPEN questions |
| [Battle rules](docs/battle-rules.md) | Formulas, observations, comparison and overtime |
| [Token economics](docs/token-economics.md) | Fees, rounding, backing, redemption and DAO escrow |
| [Architecture](docs/architecture.md) | Components, asset flows and trust boundaries |
| [Interfaces](docs/interfaces.md) | Planned contract, event, oracle, agent and MCP APIs |
| [Ecosystem](docs/ecosystem.md) | Partners, priorities, testnet evidence and unknowns |
| [Deployment](docs/deployment.md) | Existing commands versus planned rollout |
| [Security review](docs/security-review.md) | Historical scope and unfinished target review |
| [Roadmap](docs/implementation-roadmap.md) | Dependencies and acceptance gates |
| [Current state](docs/current-state.md) | Base-commit implementation and historical demos |
| [Implementation tracker](docs/implementation-tracker.md) | Parent issue content; GitHub URL pending verified publication |
| [OpenSpec proposal](docs/openspec/changes/redesign-permissionless-robinhood-arena/proposal.md) | Unimplemented spec-driven target change |

The older [WAR/furnace flow](docs/flow.md), [WAR](docs/war.md), [furnace](docs/furnace.md) and earlier OpenSpec entries are historical context. Swap settlement, TWAP, bond and credit plans are superseded for the target. Parent-folder OpenSpec archives remain outside this repository.

## Current repository and development

Rust contracts live in contracts/ (arena, router, Ref adapter, mock tokens/DEX/signer, standalone WAR/furnace and integration tests). TypeScript infrastructure is in [agent/](agent/README.md), Next.js UI/terminal in [web/](web/README.md), container configuration in [deploy/](deploy/README.md).

Requirements: Rust stable with wasm32-unknown-unknown, Node >=22 and pnpm as pinned in package.json. These commands exercise the current implementation:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm -F @valtrum/agent test
pnpm -F @valtrum/web test
pnpm -F @valtrum/web dev
```

Without an arena ID the web uses deterministic demo data. Contract checks from contracts/:

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
