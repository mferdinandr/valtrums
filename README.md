# Valtrum

Omnichain liquidity warfare for meme coins on NEAR.

Two meme-coin tribes battle. When the clock runs out, the losing vault is taken and distributed to the winners: principal comes back liquid, and profit is split into liquid winner coin, locked USDC credit for the next battle, a burn, and a protocol fee.

- Contracts in Rust (`near-sdk` 5) hold the battles, vaults, credit and settlement math.
- An agent audits proposals, sets prices, watches liquidity, and drives settlement.
- A web app with an AI prompt terminal turns "Deposit 50 USDC to $WIF" into one validated transaction.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit, [docs/flow.md](docs/flow.md) for the flow with war bonds and the furnace, [docs/war.md](docs/war.md) for the WAR war bonds, [docs/furnace.md](docs/furnace.md) for the furnace, [docs/deployment.md](docs/deployment.md) for the testnet deployment, and [docs/security-review.md](docs/security-review.md) for known risks.

## Repository layout

```
contracts/
  arena/         battles, vaults, positions, credit, settlement, signing requests
  furnace/       keyless sink that keeps burned coins forever and records every burn
  router/        swaps USDC into a side's coin and deposits it
  mock-dex/      fixed-rate DEX for testnet and the sandbox
  mock-ft/       open-mint NEP-141 token for testnet and the sandbox
  mock-mpc/      stand-in MPC signer for the sandbox
  war/           WAR war bonds: USDC-backed NEP-141 that melts 10% a day, minted and redeemed by the arena
  integration/   sandbox tests (near-workspaces)
agent/           TypeScript automation: auditor, settlement, watchdog
web/             Next.js app and the AI prompt terminal
deploy/          container and compose files for the agent
docs/            architecture, deployment, security review
  openspec/      specs of current behaviour and proposed changes (OpenSpec)
```

## Specs and proposed changes

`docs/openspec` follows [OpenSpec](https://github.com/Fission-AI/OpenSpec): `specs/` describes how the system behaves today, and `changes/` holds proposals with their spec deltas, design and tasks. Validate them from `docs/`:

```bash
cd docs && npx @fission-ai/openspec validate --all --strict
```

## Requirements

- Rust (stable) with the `wasm32-unknown-unknown` target
- Node.js 22+ and pnpm 11+
- Docker (optional, for the agent image)

## Development

```bash
# contracts: unit tests, then the sandbox tests (the first run downloads the sandbox binary)
cd contracts
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cargo test --workspace --exclude valtrum-integration
cargo test -p valtrum-integration

# agent and web
pnpm install
pnpm typecheck && pnpm build
pnpm -F @valtrum/agent test
pnpm -F @valtrum/web test
pnpm -F @valtrum/web dev      # runs on demo data until a contract id is configured
```

## License

MIT
