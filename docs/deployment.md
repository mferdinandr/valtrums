# Deployment

## NEAR testnet

The stack is deployed on testnet with mock tokens, a mock DEX and on-chain settlement execution. The mock tokens are open-mint and the DEX uses fixed rates that its owner can change, so this deployment is for demos and testing only.

| Role | Account |
| --- | --- |
| Owner | `valtrum-8875bb.testnet` |
| Arena | `valtrum-arena-8875bb.testnet` |
| Router | `valtrum-router-8875bb.testnet` |
| Mock DEX | `valtrum-dex-8875bb.testnet` |
| Mock USDC (6 decimals) | `valtrum-usdc-8875bb.testnet` |
| Mock PEPE (18 decimals) | `valtrum-pepe-8875bb.testnet` |
| Mock SHIB (18 decimals) | `valtrum-shib-8875bb.testnet` |
| Agent | `agent.valtrum-8875bb.testnet` |
| Treasury | `treasury.valtrum-8875bb.testnet` |
| Burn account | `burn.valtrum-8875bb.testnet` |

Settings at deployment: bond 5 USDC, deposit window 300 seconds, on-chain execution through the mock DEX with the burn account above. DEX rates: 1 USDC = 1000 PEPE = 4 SHIB, with 100,000 USDC, 100,000,000 PEPE and 1,000,000 SHIB of liquidity.

Read the live configuration:

```bash
near contract call-function as-read-only valtrum-arena-8875bb.testnet get_config json-args '{}' network-config testnet now
```

Mint test tokens for an account (anyone can):

```bash
near contract call-function as-transaction valtrum-usdc-8875bb.testnet mint \
  json-args '{"account_id":"you.testnet","amount":"100000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-legacy-keychain send
```

An account must be registered with a token (`storage_deposit`) before it can receive it; `mint` registers the account it mints to.

## Demo battle

`scripts/demo-battle-testnet.sh <suffix>` plays one full battle on the deployment above and prints where the value went. It starts the agent locally (on-chain execution, market data from the mock DEX, a 40-second price window and 10-second passes), creates three players, proposes a 120-second battle between PEPE and SHIB, deposits on both sides, lets the agent lock it, moves the PEPE price up 25% through the DEX rate, waits for settlement, then claims and withdraws.

A complete run on this deployment (battle 1):

| Step | Result |
| --- | --- |
| Audit and approval | by the agent, from the DEX's liquidity and rates |
| Vaults | 400 PEPE on side A, 160 SHIB on side B |
| Prices | PEPE 0.001 to 0.00125 USD (+25%), SHIB unchanged: side A wins |
| Dump | 160 SHIB sold for 40 USDC |
| Buy | 22 USDC (55%) bought 22,000 PEPE |
| Burn | 2 USDC (5%) bought 2,000 PEPE, sent to the burn account |
| Return | 2 USDC (5%) fee booked for the treasury |
| Claim by the winner | 22,400 PEPE (400 principal + 22,000 reward) withdrawn, plus 14 USDC of credit (35%) valid for 7 days |
| Creator | the 5 USDC bond returned |
| Left in the arena | 0 PEPE and 16 USDC: the 14 USDC credit pool and the 2 USDC fee |

The numbers add up: nothing was created or lost beyond the burn.

The agent needs a node that does not rate-limit: the public `rpc.testnet.near.org` answered HTTP 429 during the first attempt and stalled the run. The script defaults to `https://test.rpc.fastnear.com`; set `NEAR_RPC_URL` to use another provider.

## Deploying your own copy

```bash
cargo install near-cli-rs --locked
scripts/deploy-testnet.sh <suffix>
```

The script builds the contracts, creates the accounts (the owner and the six contract accounts through the testnet faucet, the agent, treasury and burn accounts as sub-accounts of the owner), deploys and initialises everything, registers the holders with each token, wires the arena to the router and the DEX, and sets rates and liquidity. It prints the resulting accounts. Keys are stored by the CLI under `~/.near-credentials`.

Storage is the main cost: about 1 NEAR per 100 KB of contract code, so the arena needs about 7.3 NEAR on its own. Each faucet account receives 10 NEAR.

## The agent

Run it locally or in a container (see [deploy/README.md](../deploy/README.md) and [agent/README.md](../agent/README.md)). It needs the arena id, the agent account id and the agent's private key. On testnet it needs the mock DEX as its market data source because the mock tokens are unknown to public market APIs.

## The web app

```bash
NEXT_PUBLIC_NEAR_NETWORK=testnet \
NEXT_PUBLIC_ARENA_CONTRACT_ID=valtrum-arena-8875bb.testnet \
pnpm -F @valtrum/web dev
```

Without `NEXT_PUBLIC_ARENA_CONTRACT_ID` the app runs on built-in demo data.

## Before using real funds

Read [security-review.md](security-review.md). In particular: the mock DEX, mock tokens and mock signer are not for mainnet, storage is paid by the contract, and settlement proceeds are authenticated by value.
