# Valtrum

Omnichain liquidity warfare for meme coins on NEAR.

Two meme-coin tribes battle. When the clock runs out, the losing vault is taken and distributed to the winners: principal comes back liquid, and profit is split into liquid winner coin, locked USDC credit for the next battle, a burn, and a protocol fee.

- Contracts in Rust (`near-sdk` 5) hold the battles, vaults, credit and settlement math.
- An agent audits proposals, sets prices, watches liquidity, and drives settlement.
- A web app with an AI prompt terminal turns "Deposit 50 USDC to $WIF" into one validated transaction.
- **VALT**, the war-drum coin: an NEP-141 memecoin with a daily muster ritual in the contract. Days that meet the community target mint a small reward to everyone who checked in; missed days burn a slice of the war chest and reset the streak. The rules are fixed at launch, there is no owner, and the contract account has no keys. See [docs/valt.md](docs/valt.md), including the limits of its sybil resistance.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit, [docs/valt.md](docs/valt.md) for the VALT rules, [docs/deployment.md](docs/deployment.md) for the testnet deployment, and [docs/security-review.md](docs/security-review.md) for known risks.

## Repository layout

```
contracts/
  arena/         battles, vaults, positions, credit, settlement, signing requests
  router/        swaps USDC into a side's coin and deposits it
  mock-dex/      fixed-rate DEX for testnet and the sandbox
  mock-ft/       open-mint NEP-141 token for testnet and the sandbox
  mock-mpc/      stand-in MPC signer for the sandbox
  valt/          VALT: NEP-141 coin with the daily muster, streak and war-chest burn
  integration/   sandbox tests (near-workspaces)
agent/           TypeScript automation: auditor, settlement, watchdog
web/             Next.js app and the AI prompt terminal
deploy/          container and compose files for the agent
docs/            architecture, deployment, security review
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
