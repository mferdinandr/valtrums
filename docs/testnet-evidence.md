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

## 2. Signer, custody path, derived address, gas and code hashes: custody and code hashes verified, signer not

Update 2026-11-09: the Robinhood custody contract and six mock tokens are deployed, with gas cost and code-hash comparison, in section 3b. The Robinhood official RPC now has valid TLS. The payout MPC signer, the derived custody address and every NEAR contract are still not deployed. Original 2026-11-08 note:

All of these need the isolated target deployment. Specifically:
- the arena, backing, payout, receipt registry and player-policy contracts on fresh testnet accounts;
- the payout contract's MPC signer account;
- the derived Robinhood custody address, funded with testnet ETH for gas;
- a working Robinhood testnet RPC.

None of these exist yet. Record the code hashes with `view_account` (as above) once deployed.

## 3. Source receipts, attribution, finality and reorg evidence: partly verified

Update 2026-11-09: a real fixture deposit on Robinhood testnet was verified end to end through the custody verifier (section 3b). Payout receipts, the NEAR side, and a live reorg are still not verified. Original 2026-11-08 note: this needs funded deposits and payouts on the target deployment. Recorded then: Robinhood testnet exposes a `finalized` head (about 7,300 blocks behind the latest at the time of reading). The indexer (#92) and the payout reconciler only treat source receipts as final along that head. No real receipt has been recorded.

## 3b. Robinhood testnet: custody, mock tokens, one real deposit (recorded 2026-11-09)

Raw values: [`evidence/2026-11-09-evm-testnet-deploy.json`](evidence/2026-11-09-evm-testnet-deploy.json). Addresses and the rebuild recipe: [deployment.md](deployment.md). All contracts and the deposit are **fixtures** (mock tokens, no value); only the observations of the network are live evidence. Not covered: any NEAR contract, the MPC signer, a payout, or a signed registry attestation.

**Identity (re-verified).** `https://rpc.testnet.chain.robinhood.com` now serves a valid certificate (the 2026-11-08 TLS failure is gone) and reports chain id `0xb626` = 46630. dRPC agrees on the chain id and on block hashes (it may share an upstream, so this is weak independence). The explorer `explorer.testnet.chain.robinhood.com` is reachable and runs Blockscout. The `safe` and `finalized` tags exist: at 03:56Z `finalized` was about 7,300 blocks (18 minutes) behind latest and `safe` about 5,200 blocks; `finalized` moves in jumps of 2,000 to 3,000 blocks.

**Historical state.** The official RPC sits behind a load balancer with inconsistent pruning: reads 1,000 blocks back succeed, at about 7,300 blocks back they succeed about 1 time in 6, and at 12,000 or more they fail. dRPC served 40,000 blocks back consistently. A receipt block is only finalized once it is more than 7,300 blocks old, so the official RPC alone often cannot answer the verifier's `balanceOf` at the receipt block.

**Deployment.** Custody `0xb994DCAb6aD9a042e7bBec3Ba104Ec5e6b797798` and six mock tokens (`mCASHCAT`, `mWALLET`, `mGOOD`, `mAI`, `mVLAD`, `mDEGEN`, each marked "Mock", 18 decimals, mint only by the deployer) were deployed from `0xcE806A7E…75c6`. Forge tests pass (9). On-chain code hashes equal the local build (custody directly; the mocks after patching the owner immutable). Gas for everything including the deposit: 0.0000357 ETH. Explorer source verification is blocked on the explorer side (its verifier lists no compilers); the compiler settings and hashes are recorded instead.

**Deposit.** Tx `0xf80c2d84…052b`, block 150,680,936, log index 1: 100 mCASHCAT for battle 1, beneficiary `valtrum-user1-b694.testnet`, refund address the deployer, mapping version 3 (fixture value; D17 needs a new version for the changed event layout and none is committed). `received` equals `requested`.

**Verifier.** Before finality: `pending` ("receipt is not finalized", 04:00:57Z). The node's `finalized` tag covered the block about 18 minutes after the deposit. With the default ancestry depth of 256 the verifier stays `pending` ("receipt too far below finalized head"). With `--max-depth 30000` and historical balances read from dRPC it returned **verified** at 05:49:37Z: token, battle, beneficiary, refund address and `actualReceived` 100e18 attributed, finalized head 150,694,540. The unsigned attestation has no signer; the registry signer is not deployed.

**Finding.** The ancestry walk is one RPC call per block: 382 seconds for 4,175 blocks, 3,522 seconds for about 14,000. A 30-second product cannot use it as is; the policy (trust the `finalized` tag plus a by-number hash equality check, or batched reads) needs an owner decision, and it changes the verifier's trust assumption, so it was not changed here.

**Reorg verification.** Procedure: re-read the deposit block by number from two endpoints and compare hash and parent hash, repeat after a delay, check it is at or below `finalized`, and walk parents to the finalized head. Done at 04:32Z and 05:49Z: the hash was stable and both endpoints agreed. This cannot show a reorg: none occurred, the chain is a single-sequencer Arbitrum-style L2, the two endpoints may share an upstream, and "finalized" is the node's own label, not a check against Ethereum Sepolia. The retract and suspend path stays fixture-tested.

## 4. Fixture labels

- **EVM testnet fixtures (section 3b):** the six `m*` mock tokens, `TestnetDepositCustody` (a prototype whose source says no real funds), mapping version 3, and the deposit itself.

- **Runtime mock adapters** are labelled `FIXTURE` in code:
  - agent: `MockStepExecutor`, mock DEX market, honeypot and quote;
  - web: the funding router, terminal chain, environment wiring and the demo arena.
- **UI:** the navbar shows **demo data** whenever the web app runs on mocks.
- **Tests:** every unit and sandbox test uses synthetic inputs, test keys and mock contracts, so none of them is live evidence. Newer test files say so in their header; older ones follow the same convention without a header.
- **Evidence:** only files under `docs/evidence/` and the dated sections of the findings log are recorded observations of a live network, and each one states its provider, time and limitations.
