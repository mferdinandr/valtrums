# Testnet evidence

Dated, read-only evidence for the testnet integration tasks (issue [#72](https://github.com/mferdinandr/valtrum/issues/72)). Each item lists the request, the response and what it does not prove. Raw values are in [`evidence/2026-11-09-testnet-identity.json`](evidence/2026-11-09-testnet-identity.json). Public keyless RPC providers are named; their endpoints are not committed. Nothing was signed or sent.

## 1. Chain identity and RPC identity (recorded 2026-11-08 21:56 UTC)

**NEAR testnet.** JSON-RPC `status` to two independent providers (NEAR's official RPC and FastNEAR):

| Field | NEAR RPC | FastNEAR |
| --- | --- | --- |
| `chain_id` | `testnet` | `testnet` |
| `genesis_hash` | `FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b` | same |
| protocol version | 88 | 88 |
| syncing | false | false |

**Robinhood Chain testnet.** `eth_chainId` and `eth_getBlockByNumber` to two keyless providers (PublicNode, dRPC):

| Field | Result |
| --- | --- |
| chain id | `0xb626` = **46630** from both providers |
| block 150,568,583 | same hash from both: `0xa3907d01…dcd00` |
| `l1BlockNumber` | present (12,093,257): an Arbitrum Nitro-style L2. The chainlist registry names Ethereum Sepolia as its parent. |
| `finalized` head | 150,561,297, about 7,300 blocks behind the latest |

**Robinhood's own testnet RPC** (the one in `docs/ecosystem.md`): the TLS handshake fails (`tlsv1 alert protocol version`). The Robinhood mainnet hosts serve a certificate that expired on 2026-08-19 ([scoring market data](scoring-market-data.md)). A testnet deployment needs a working RPC in `FOREIGN_RPC_URL`. The chain-id guard (#95) refuses any RPC whose chain id differs from 46630.

**Testnet account mappings.** The only recorded deployment is the historical one (suffix `8875bb`, `docs/deployment.md`):

| Account | Exists | Code hash |
| --- | --- | --- |
| `valtrum-8875bb.testnet` (owner) | yes | none (no contract) |
| `valtrum-arena-8875bb.testnet` | yes | `7vkio81ZYuCSneKgMLir9oTzrx73XW1fKQuPm4fVcRez` |
| `valtrum-router-8875bb.testnet` | yes | `4Tk8UUEVu8xKLqSar23WAqZrZwave1Xpp1txyQAeMjbT` |
| `valtrum-dex-8875bb.testnet` | yes | `7L2qavugy3FWed9rsRdTFTjjvAukx91VZhkNkuCV8zVc` |
| `valtrum-usdc/pepe/shib-8875bb.testnet` | yes | `3whKeDVBQWBNWGNhA3yUXJv2vL55eUnPy2NNVZkNxY8P` (same mock FT) |

That arena is the **legacy two-sided arena**: `get_config` returns the old bond, router and USDC configuration, and `get_lifecycle_battle_count` fails with `MethodNotFound`. **The target arena (lifecycle, reference registry, escrow, DAO) is not deployed**, and neither are the backing, payout, receipt-registry or player-policy contracts. So no target account mapping exists to verify yet.

## 2. Signer, custody path, derived address, gas and code hashes: not verified

All of these need the isolated target deployment. Specifically:
- the arena, backing, payout, receipt registry and player-policy contracts on fresh testnet accounts;
- the payout contract's MPC signer account;
- the derived Robinhood custody address, funded with testnet ETH for gas;
- a working Robinhood testnet RPC.

None of these exist yet. Record the code hashes with `view_account` (as above) once deployed.

## 3. Source receipts, attribution, finality and reorg evidence: not verified

This needs funded deposits and payouts on the target deployment. Recorded so far: Robinhood testnet exposes a `finalized` head (about 7,300 blocks behind the latest at the time of reading). The indexer (#92) and the payout reconciler only treat source receipts as final along that head. No real receipt has been recorded.

## 4. Fixture labels

- **Runtime mock adapters** are labelled `FIXTURE` in code:
  - agent: `MockStepExecutor`, mock DEX market, honeypot and quote;
  - web: the funding router, terminal chain, environment wiring and the demo arena.
- **UI:** the navbar shows **demo data** whenever the web app runs on mocks.
- **Tests:** every unit and sandbox test uses synthetic inputs, test keys and mock contracts, so none of them is live evidence. Newer test files say so in their header; older ones follow the same convention without a header.
- **Evidence:** only files under `docs/evidence/` and the dated sections of the findings log are recorded observations of a live network, and each one states its provider, time and limitations.
