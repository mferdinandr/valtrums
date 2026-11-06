# Ecosystem and testnet integration map

Status checked against public documentation on **2026-11-06**. Documentation availability is not an end-to-end integration test. Priority P0 blocks the target demo; P1 improves it; P2 is optional.

| Partner / component | Function | Priority | Testnet evidence and limits | Repository status |
| --- | --- | --- | --- | --- |
| NEAR Protocol / NEP-141 | Battle state and transferable asset representations | P0 | NEAR testnet exists; backing verification is application work, not a token-standard guarantee | Legacy NEAR contracts exist; target planned |
| NEAR Chain Signatures | Constrained Robinhood transaction signatures | P0 | [Official implementation guide](https://docs.near.org/chain-abstraction/chain-signatures/implementation) lists v1.signer-prod.testnet; verify current key, domain, derivation and Robinhood transaction compatibility | Legacy EVM signer/relay source exists; target transfer policy unimplemented |
| Robinhood Chain | Original-token custody, deposits and payouts | P0 | [Official connection guide](https://docs.robinhood.com/chain/connecting/) lists testnet chain ID 46630, ETH gas and public RPC https://rpc.testnet.chain.robinhood.com; endpoints are rate limited | No target deployment or verified payout |
| GoPlus | Critical token-risk evidence | P0 | [Token Security API](https://docs.gopluslabs.io/reference/tokensecurityusingget_1) and [supported-chain discovery](https://docs.gopluslabs.io/reference/getchainslistusingget) must be checked specifically for Robinhood testnet; coverage is unverified | Planned; existing heuristic is not GoPlus |
| Independent LP/market-data adapter | LP > USD 10,000, price, supply, interval volume and drawdown samples | P0 | Provider, eligible pools, circulating-supply source, coverage and cadence OPEN | Legacy Ref/mock/DexScreener adapters do not satisfy target requirements |
| NEAR AI Cloud | Player strategy and intent interpretation | P1 | [Quickstart](https://docs.near.ai/cloud/quickstart) documents authenticated inference; service access is distinct from blockchain testnet support | Existing terminal has configurable inference parsing; autonomous bounded player agent planned |
| NEAR Intents / 1Click | Optional funding routes | P1 | [Official docs](https://docs.near-intents.org/index) describe token discovery, quotes and execution status; Robinhood testnet routes are unverified and must not be assumed | Legacy terminal adapter exists; target route acceptance pending |
| Bitte | Optional agent discovery/UX | P2 | [Open Agents docs](https://docs.bitte.ai/) describe API/OpenAPI agents; chain/testnet execution compatibility unverified | Candidate integration, not an installed solver or bridge |
| FastNEAR | NEAR RPC and indexed data | P1 | [Provider reference](https://docs.fastnear.com/) separates canonical RPC from indexed APIs; verify selected testnet endpoint and rate limits | Legacy demo uses a FastNEAR testnet RPC |
| Wallet connection | User signing and revocation | P0 | Existing HOT connector code must be tested against actual target grants; cannot infer token caps from gas allowance | Legacy web integration present |
| DAO tooling | Winning-principal decisions | P0 design gate | Provider and governance mechanism OPEN; no quorum, weight, deadline or fallback selected | No target DAO integration |

## Evidence required before claiming integration

Record chain ID, endpoint, token/custody addresses, code hashes, source commit, timestamp, request/response evidence, finality policy and transaction/receipt links. Keep credentials out of records. Explicitly label fixture versus public-service evidence.

First prove deposit receipt attribution, 1:1 mint, redemption and a constrained original-token payout. Then test all market-data fields for a 30-second interval and GoPlus's mandatory fields. An unsupported chain or missing field holds approval Pending; a canned response may test adapters but cannot be presented as a live audit.

Intents and Bitte are optional funding/UX dependencies, not settlement swaps. Direct Robinhood testnet deposits may support the core demo once verified. NEAR AI inference does not grant wallet authority. Signatures do not provide a bridge or execution proof.
