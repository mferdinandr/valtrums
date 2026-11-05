# Deployment

## NEAR testnet

The stack is deployed on testnet with mock tokens, a mock DEX and on-chain settlement execution. The mock tokens are open-mint and the DEX uses fixed rates that its owner can change, so this deployment is for demos and testing only.

| Role | Account |
| --- | --- |
| Owner | `valtrum-8875bb.testnet` |
| Arena | `valtrum-arena-8875bb.testnet` |
| Router | `valtrum-router-8875bb.testnet` |
| Mock DEX (sandbox and fallback) | `valtrum-dex-8875bb.testnet` |
| Swap adapter | `valtrum-refdex-8875bb.testnet` |
| Liquidity account | `lp.valtrum-8875bb.testnet` |
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

## Swaps on the testnet exchange

Settlement and the USDC deposit route swap on the Ref Finance v1 exchange on testnet (`ref-finance-101.testnet`) through the swap adapter. The router and the arena send the adapter the same swap message they used to send the mock DEX, so only their `dex` account differs: `set_dex` on the router and `set_execution` on the arena point at the adapter.

- The adapter forwards each swap to the exchange with the caller's minimum as the floor. The exchange pays the output to the adapter with a plain transfer and does not call it back, so the adapter measures the output by its balance change, then pays the receiver. Only one swap runs at a time; a second one is refused and refunded.
- Pools are made by `scripts/setup-ref-pools.sh <suffix>` from the liquidity account: PEPE/USDC at 0.001 USDC per PEPE and SHIB/USDC at 0.25 USDC per SHIB, each with 100,000 USDC. The script prints the pool ids and routes both pairs in the adapter (`get_pool { token_in, token_out }`). The pools made for the current deployment are 2899 (PEPE) and 2900 (SHIB).
- The adapter and the liquidity account must be registered with the exchange (`storage_deposit`, then `register_tokens` for each coin), and the exchange itself must be registered with each token. Without the exchange registration a deposit is silently not credited. Every account that receives a coin (arena, router, treasury, burn account, adapter) must be registered with that token.
- The agent reads prices, depth and quotes from the pools with `MARKET_DATA=ref` and `REF_EXCHANGE_ID=ref-finance-101.testnet`.
- A settlement step can take the full 300 Tgas of a transaction (arena, adapter, exchange and back). The agent attaches that much to `execute_step`; with 200 Tgas the step is rolled back.
- Pools have a 0.3% fee and finite depth, so the amounts a demo prints are not round numbers.

The sandbox tests still use the mock DEX because the sandbox cannot host the exchange.

## Demo battle

`scripts/demo-battle-testnet.sh <suffix>` plays one full battle on the deployment above and prints where the value went. By default the swaps run on the exchange pools (`DEX_MODE=mock` uses the mock DEX instead). It starts the agent locally (on-chain execution, market data from the pools, a 40-second price window and 10-second passes), creates three players, proposes a 120-second battle between PEPE and SHIB, deposits on both sides, lets the agent lock it, moves the PEPE price up 25% with a real buy in the PEPE pool, waits for settlement, then claims and withdraws.

A complete run on the mock DEX (battle 1):

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

A complete run on the exchange pools (battle 6):

| Step | Result |
| --- | --- |
| Prices | PEPE 0.0015654 to 0.0019567 USD (+25.0%, read from its pool), SHIB flat: side A wins |
| Vaults | 400 PEPE on side A, 160 SHIB on side B |
| Dump | 160 SHIB sold in the SHIB pool for 39.832284 USDC (pool fee and price impact included) |
| Buy | 21.907756 USDC (55%) bought 11,160.88 PEPE |
| Burn | 1.991614 USDC (5%) bought 1,014.45 PEPE, sent to the burn account |
| Return | 1.991615 USDC (5%) fee booked for the treasury |
| Credit | 13.941299 USDC (35%) of locked credit for the winner, valid for 7 days |
| Claim by the winner | 11,560.88 PEPE (400 principal + 11,160.88 reward) withdrawn |
| Adapter afterwards | no swap in flight and no coin of this battle left in it |

The four profit shares add up to the 39.832284 USDC the dump produced. The pool, not a fixed rate, decides the amounts, so they differ slightly from a mock run. Each battle also moves the PEPE pool price; the demo script sizes its buy from the pool as it stands.

Run one agent per arena key. During this work a leftover agent from an earlier run (mock market data, same key) locked a battle with the wrong prices and voided another; the demo script now starts the agent as a single process and stops it on exit.

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
