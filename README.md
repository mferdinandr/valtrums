# Valtrum

Omnichain liquidity warfare for meme coins on NEAR.

Two meme-coin tribes battle. When the clock runs out, the losing vault is taken and distributed to the winners: principal comes back liquid, and profit is split into liquid winner coin, locked USDC credit for the next battle, a burn, and a protocol fee.

## Repository layout

```
contracts/   Rust workspace (near-sdk): arena and router
agent/       TypeScript automation: auditor, settlement, watchdog
web/         Frontend and AI prompt terminal
```

## Requirements

- Rust (stable) with the `wasm32-unknown-unknown` target
- Node.js 22+ and pnpm 11+

## Development

```bash
# contracts
cd contracts && cargo test

# agent and web
pnpm install
pnpm -r --if-present build
```

## License

MIT
