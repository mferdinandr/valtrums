# Testnet evidence

Dated evidence for the testnet integration tasks (issue [#72](https://github.com/mferdinandr/valtrum/issues/72)). Each item lists the request, the response and what it does not prove. Raw values are in [`evidence/2026-11-09-testnet-identity.json`](evidence/2026-11-09-testnet-identity.json). Public keyless RPC providers are named; their endpoints are not committed. Sections 1 to 4 were read-only and nothing was signed; section 5 records the live NEAR testnet transactions of 2026-11-09 from the owner's accounts.

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

## 2. Signer, custody path, derived address, gas and code hashes (NEAR side verified 2026-11-09)

Robinhood side (2026-11-09): the custody contract and six mock tokens are deployed, with gas cost and code-hash comparison, in section 3b, and the official Robinhood testnet RPC now has valid TLS.

Live testnet evidence from the owner's accounts; data in [`evidence/2026-11-09-near-testnet-deploy.json`](evidence/2026-11-09-near-testnet-deploy.json).

- **Signer** `v1.signer-prod.testnet` (docs.near.org lists it as the testnet MPC contract): code hash `CpGX8ywXJwvWPgZFDDCTCuPJBHF7BATT51gSfc3APERJ`, contract `version` 3.18.0, balance about 2050.9 NEAR. `state` is `Running`, epoch 27, domain 0 is `CaitSith` secp256k1 with purpose `Sign` (reconstruction threshold 11); `public_key` (domain 0) is `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3`. `latest_key_version` and `experimental_signature_deposit` are not methods of this version.
- **Derivation:** `derived_public_key({path:"valtrum-custody-1", predecessor:"payout.valtrum-owner-b694.testnet", domain_id:0})` = `secp256k1:2nhnxaGQiwaF7ZBuetRGTM7js1hZdey36BHyEwAaHf5tE1RgcXu3EGjw3NYR9GXQV92G5TaFaN1GdAwEuNK6sg9i`. Derived EVM address (keccak256 of the 64-byte key, last 20 bytes): **`0x0b740E3E90491f57699fCCD8276400E65BC70c41`**. The address algorithm was checked against the generator point's known address. The path name is a proposal and is immutable once registered in payout; the address is not funded and not registered.
- **`sign` interface, one live test:** the owner account called `sign` once with `{"request":{"path":"valtrum-interface-test","payload_v2":{"Ecdsa":"<sha256 of a fixed text>"},"domain_id":0}}`, 1 yoctoNEAR and 300 Tgas (tx `Cdby3uvfjtPtjEhtoqfyASSGU4usS7ncJmUFzJ2n4uDD`, about 8.2 Tgas burnt). It is zero value, controls no funds and uses the owner's own derivation, not the payout custody. Response shape: `{"scheme":"Secp256k1","big_r":{"affine_point":"02..."},"s":{"scalar":"..."},"recovery_id":1}`. Offline, the signature recovers to the address derived for that owner and path (`0x4d527620ECaC81fC876b1E21aEe8ff2fdd54B1C5`), so path, `payload_v2`, `domain_id` 0 and the 1 yocto deposit are verified. The payout contract's `parse_signature` accepts this shape by code reading; it was not executed live (no payout is registered).
- **Code hashes** (NEAR on-chain hash equals the base58 SHA-256 of the built wasm, `cargo near build non-reproducible-wasm --no-abi`, host build): arena `6zKvCSoYBrTKrLkYtUfjLohFWaYvzAQbvtoMXwntAJR5`, receipt registry `CzEeVAYx9Ksj3cdNSUMdANxv7GR9VmMde4S77Q4mrPpK`, payout `8d5h3HWoW8DRzTRZytpKnyctQ9kt2NSWZdQHBxTtKwa1`, player policy `kqDPt6QeJhQREee6FukM2GZqLLbjt1E9rgadBaek79X`, backing `EQQ5NmcTF6Zkrdpux2zf5iU8WKax7n1b9xue5VdVH5d5`.
- **Not verified:** gas funding of the custody address on Robinhood testnet (needs a working RPC and testnet ETH), a payout signature for a real custody transfer, and the deposit the signer charges when load is high (only the 1 yocto minimum was observed).

## 3. Source receipts, attribution, finality and reorg evidence: partly verified

Update 2026-11-09: a real fixture deposit on Robinhood testnet was verified end to end through the custody verifier (section 3b). Payout receipts, the NEAR side, and a live reorg are still not verified. Original 2026-11-08 note: this needs funded deposits and payouts on the target deployment. Recorded then: Robinhood testnet exposes a `finalized` head (about 7,300 blocks behind the latest at the time of reading). The indexer (#92) and the payout reconciler only treat source receipts as final along that head. No real receipt has been recorded.

## 3b. Robinhood testnet: custody, mock tokens, one real deposit (recorded 2026-11-09)

Raw values: [`evidence/2026-11-09-evm-testnet-deploy.json`](evidence/2026-11-09-evm-testnet-deploy.json). Addresses and the rebuild recipe: [deployment.md](deployment.md). All contracts and the deposit are **fixtures** (mock tokens, no value); only the observations of the network are live evidence. Not covered: any NEAR contract, the MPC signer, a payout, or a signed registry attestation.

**Identity (re-verified).** `https://rpc.testnet.chain.robinhood.com` now serves a valid certificate (the 2026-11-08 TLS failure is gone) and reports chain id `0xb626` = 46630. dRPC agrees on the chain id and on block hashes (it may share an upstream, so this is weak independence). The explorer `explorer.testnet.chain.robinhood.com` is reachable and runs Blockscout. The `safe` and `finalized` tags exist: at 03:56Z `finalized` was about 7,300 blocks (18 minutes) behind latest and `safe` about 5,200 blocks; `finalized` moves in jumps of 2,000 to 3,000 blocks.

**Historical state.** The official RPC sits behind a load balancer with inconsistent pruning: reads 1,000 blocks back succeed, at about 7,300 blocks back they succeed about 1 time in 6, and at 12,000 or more they fail. dRPC served 40,000 blocks back consistently. A receipt block is only finalized once it is more than 7,300 blocks old, so the official RPC alone often cannot answer the verifier's `balanceOf` at the receipt block.

**Deployment.** (Update 2026-11-10: this custody contract is deposit-only and RETIRED; the forwarder `0xEb49d8E71A5B2f5B4fA9Da33C3b1838e249F5C6C` replaces it, see `evidence/2026-11-10-forwarder-deploy.json`.) Custody `0xb994DCAb6aD9a042e7bBec3Ba104Ec5e6b797798` and six mock tokens (`mCASHCAT`, `mWALLET`, `mGOOD`, `mAI`, `mVLAD`, `mDEGEN`, each marked "Mock", 18 decimals, mint only by the deployer) were deployed from `0xcE806A7E…75c6`. Forge tests pass (9). On-chain code hashes equal the local build (custody directly; the mocks after patching the owner immutable). Gas for everything including the deposit: 0.0000357 ETH. Explorer source verification is blocked on the explorer side (its verifier lists no compilers); the compiler settings and hashes are recorded instead.

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

## 5. NEAR testnet deployment and DAO (2026-11-09, live)

Identity re-verified at 2026-11-09 03:56 UTC: both providers report `chain_id` `testnet`, genesis hash `FWJ9kR6KFWoyMoNjpLXXGHeuiy7tEY6GmoFeCA5yuc6b`, protocol version 88. The nine owner accounts exist, 10 NEAR each, no contracts. Created and deployed (all accounts are `*.valtrum-owner-b694.testnet` except the DAO):

| Account | Contract | Storage funding | Constructor (no secrets) |
| --- | --- | --- | --- |
| `valtrum-protocol.sputnikv2.testnet` | SputnikDAO 3.31 | 6 NEAR deposit | council `valtrum-council1..3-b694`, default policy |
| `arena` | arena | 7.04 NEAR | owner = owner account, `usdc` `usdc.fixture.testnet` (FIXTURE, does not exist), treasury = owner, bond 0, window 60; then `activate_lifecycle`, `set_lifecycle_protocol` = DAO |
| `registry` | receipt registry | 2.01 NEAR | owner = owner account, verifier = `valtrum-operator-b694.testnet` (assumption: no verifier rule exists yet) |
| `payout` | payout | 3.44 NEAR | owner, operator `valtrum-operator-b694`, relayer `valtrum-relayer-b694`, signer `v1.signer-prod.testnet` |
| `policy` | player policy | 2.49 NEAR | owner = owner account |
| `backing1` | backing | 4.29 NEAR | owner = the DAO, FIXTURE asset chain 46630 token `0x00..01`, `custody_domain` `fixture`, 18/18 decimals, registry, arena, payout above |

The registry also authorised `backing1` (`set_representation`). Deployment transactions and proposals are in the evidence file and in [sputnik-authority.md](sputnik-authority.md). The measured storage cost is 1e19 yoctoNEAR per byte; each contract was funded with its code plus 0.4 NEAR. Owner balance: 10 NEAR before, 7.66 NEAR after (after moving 23 NEAR in from the user1, user2 and agent accounts). The router, legacy contracts and mock tokens were not deployed.

What this does not prove: no funded battle, deposit, payout or Robinhood custody exists; the backing and arena `usdc` are fixtures; wasm was built on the host (not reproducible).

## 6. Testnet wiring run (2026-11-09, live; issues #72 and #113)

Raw data: [`evidence/2026-11-09-near-testnet-wiring.json`](evidence/2026-11-09-near-testnet-wiring.json). All token assets are FIXTURES (mock tokens, no value); the NEAR transactions are live testnet evidence from the owner's accounts.

- **Custody gas funding.** The deployer sent 0.002 ETH to the derived custody address `0x0b740E3E90491f57699fCCD8276400E65BC70c41` on Robinhood testnet (tx `0x89e922d9366a99967fdbe8b6b39543c8b8209e76ba10ef127b5bea3cbdd469e7`, block 150727320). Re-read through dRPC during the run: balance 0.002 ETH, nonce 0. The official RPC reset the connection at that time, so this read is dRPC only.
- **Arena code redeploy.** New minimum DAO window of 30 seconds. Hash `6zKvCSoY...AJR5` to `BzeN3FKT...fCN9` (equals the wasm sha256 `a35938b8...3e06`), tx `2CpHDKG4...vRqP`. State unchanged.
- **Verifier.** `valtrum-verifier-b694.testnet` created through the testnet helper; `registry.set_verifier` succeeded. The registry has no view for the verifier, so only the successful owner call proves it.
- **Six backings** deployed, DAO-owned, `custody_domain` the lowercase custody contract `0xb994dcab6ad9a042e7bbec3ba104ec5e6b797798` (immutable: with the forwarder the verifier mapping must still use this exact string as `custodyDomain`, see `openspec/changes/arena-testnet-integrations/forwarder-deploy-runbook.md`), then wired (all transactions in the JSON). Payout binding: sender the derived custody address, path `valtrum-custody-1`, first nonce 0, gas limit 200,000 and max fee cap 1 gwei. **The last two values were chosen by the agent, not the owner**; the binding is immutable per backing.
- **Trusted flag question.** Answered: the arena trusted list is separate from the registry list and was never set for `backing1`; after the call it is true for the six new backings.
- **DAO.** Proposals 3 to 16 passed and were read back; see [sputnik-authority.md](sputnik-authority.md).
- **Funding moves.** The owner received 7 NEAR from the operator, 7 from the relayer and 4.5 from the agent to pay for the six accounts (about 25.7 NEAR).

**Limitations.** No funded battle, deposit-to-mint, payout signature or live reorg. The official Robinhood RPC was unreachable during this run (connection reset), so nonce and balance came from dRPC. The wasm is a host build and is not reproducible; the backing hash differs from `backing1` because it is a fresh build.

## 7. Player policy redeploy (2026-11-09, live testnet)

PR #129 changed the `player-policy` init signature (`new(owner, registry)`) and stored reservation layout, so the old `policy.valtrum-owner-b694.testnet` (initialised, old layout) cannot be upgraded in place. A new account `policy-v2.valtrum-owner-b694.testnet` was created, the new wasm deployed and initialised in one transaction (owner `valtrum-owner-b694.testnet`, registry `registry.valtrum-owner-b694.testnet`; tx `AxKcwmn81sQRvCWC5UT3aoGcoSKm8kZuZG37xugfiSAk`). On-chain code hash `7ky2Quhr6SpFtsjNcSjdQrShhivr93YYaCHeLP2qadkM` equals the base58 SHA-256 of the host-built wasm (hex `6469717ae168237e7a7ffd093c964e20d6f093acdb1f5840fbcc9c7e99cda4aa`, 246.3 KB). The owner was funded with 2.9 NEAR from `valtrum-council2-b694.testnet` for this (tx `BKzweG64RDi6r1iAAYakgdaTSGYyJcbBaPYHbWsmy5B2`). The old account was not touched. Limits: a successful init in the deploying transaction is the only proof of the init arguments (the contract has no config view); no grant, reservation or receipt was exercised live. The wasm is a host build and is not reproducible. Anything reading `PLAYER_POLICY_CONTRACT_ID` should now use the new id.

## 8. Faucet, agent registration and custody deposits (2026-11-10 to 2026-11-11, live testnet; times are the owner's local UTC+7 date)

All assets are FIXTURES (mock tokens, no value). Nothing here proves a mint, a payout or a played round.

- **Accounts.** `valtrum-operator.testnet` (faucet operator) and `valtrum-faucet.testnet` (faucet contract) were created with keys in the OS keychain. The faucet contract (`contracts/faucet`, 26 unit tests) was deployed and initialized in one call. It holds no stock and no token is configured yet.
- **Agent registration.** The arena whitelist was empty (`get_config.agents` was `[]`). The owner called `add_agent` for `valtrum-agent-b694.testnet` (transaction `J6YQ7pe4Z4Yzvvc31WU4o4cwiMxk6tp2cqB4JEZbozE6`, 0.311 Tgas burned); a later `get_config` returned the agent in `agents`. `remove_agent` exists, so the whitelist can be corrected.
- **Policy contract pointer.** The local configuration of the agent and the web app pointed at the old `policy` account; it was corrected to `policy-v2` (see section 7). No chain change.
- **Custody deposits on Robinhood testnet (46630).** One deposit per mock token, `mapping_version` 3, battle 1, beneficiary `valtrum-operator.testnet` (decoded from the transaction input), amount 1,000,000 tokens each, from the deployer `0xcE806A7Ef30c7e96bC22bbA2665BAFcC78A575c6`:

| Token | Transaction | Block |
| --- | --- | --- |
| CASHCAT `0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6` | `0x92dacbe0811b927f95dbfe9c372b4bc37d1eee56e40a432d4e481b10eaead8cf` | `0x90790d7` |
| WALLET `0x78e7621559bc0e3cc10f8bb61dc2a371afe66e27` | `0xcb70a2bbf7da472ccc222b638bd600d22ff9806f51dc35585c6fd6253643b40e` | `0x90790f1` |
| GOOD `0xaed11a367b102f2da3ac2dfcf1de9cc97a47a850` | `0xe283464ea26b06672f3fa840c3919e44bd23958d7d0a5d16f669dfdce418f7a1` | `0x9079104` |
| AI `0x973c4e0601c03a4899b8c9643b299aaaece4ba0a` | `0x76729017dfb995d2639f4d1b8017371b41759b9eb28282e6bb006058000dd7dd` | `0x907911e` |
| VLAD `0xd879e8483d63265abe2549a347017e59a04a15bc` | `0x5de5a6cc7e0fd605a50f86d210ef32e9c52bf26a913c6ef249780c9622ff56be` | `0x9079136` |
| DEGEN `0x209aa417c2aa45a13304acc51c4c393d0ac5ba84` | `0x8b7de280a1601327ff9ed4b6c9f72dc6f2d1a75f9bbf0196d2b46dd768767fba` | `0x9079150` |

- **Audit dry run (read only).** The production audit pass ran against battle 1 with a recording transport that sent nothing. Result: CASHCAT, WALLET, GOOD, VLAD and DEGEN `pass`; AI `pending` (`unknown_field`, `lp_no_evidence`, `evidence_time_missing`) because its only pool is a v4 pool with no liquidity evidence the reader supports. The output was not archived in the repository.

**Limitations.** The deposits had not been verified as finalized when this was written (they never were; see section 9, which uses six new deposits). The official Robinhood RPC hosts were unreachable from the owner's network; reads went through a local DNS-over-HTTPS relay that is not part of the repository. The amounts and the deposit count come from the owner's session notes and the transaction input, not from a re-read of every receipt.

## 9. Faucet stocked from verified custody deposits (2026-11-11, live testnet)

All assets are FIXTURES (mock tokens, no value). This is the first live run of the custody to receipt to representation to faucet path.

- **First verification failed.** The six deposits of section 8 were never verified: every run ended `pending` with "receipt too far below finalized head". The verifier proves ancestry only up to `maxAncestryDepth` (default 256) blocks below the finalized head, but the finalized head of Robinhood testnet moves in steps of 2,700 to 6,500 blocks (observed heads 151,484,534, 151,491,061, 151,493,739, 151,499,436) and the run polled every 60 seconds, so the head was beyond the limit at the first sighting. Those deposits stay in custody unclaimed (depth about 133,700 blocks a few hours later). No NEAR transaction used them.
- **Second run.** On the owner's decision six new deposits were sent (mint, approve, deposit per token; 18 EVM transactions, all status `0x1`, battle 1, mapping version 3, beneficiary `valtrum-operator.testnet`, 1,000,000 tokens each) and verified with `--poll-seconds 10 --max-depth 12000`. All six verdicts are `verified` at finalized head 151,632,412 (about 20 minutes after the deposits). The local relay (`scripts/rpc-relay.py`) was changed to cache finalized blocks and prefetch 40 headers per batch; the public RPC answers HTTP 429 to a batch of 100.
- **Attest.** The first attempt with the 1 yoctoNEAR deposit of the earlier plan panicked with "Insufficient storage deposit" (no state change). With 0.02 NEAR attached (the registry refunds the rest) all six succeeded, signed by `valtrum-verifier-b694.testnet`. `get_claim` for WALLET returns the stored claim. The funding plan generator was corrected to 0.02 NEAR and to the verification flags above.
- **Operator and faucet.** The operator registered storage on each backing, ran `claim_receipt` (returned `true`) and `claim_representation` (1,000,000 of each token minted to `valtrum-operator.testnet`), registered the faucet contract for storage, transferred 1,000,000 of each token to `valtrum-faucet.testnet` and called `set_token` (100 per claim, 100,000 per day).
- **Read back.** `ft_balance_of` of the faucet is 1,000,000 for each of the six backings; `get_tokens` lists CASHCAT, WALLET, GOOD, AI, VLAD and DEGEN with `amount` 100 and `budget_left` 100,000; `get_config` shows `paused` false and a 24 hour cooldown. The `/faucet` page shows six tokens as ready with stock 1,000,000 ("Claim all (6)", three wallet approvals) and no page errors.

| Token | Deposit (EVM) | attest | claim_receipt | claim_representation | set_token |
| --- | --- | --- | --- | --- | --- |
| CASHCAT | `0xf078cb8ebb61fa921c11f0b8217a50d0e7a3b8c88ea98ecc865a0c231ce322d3` (block `0x909b32c`) | `3GmTGmSxGXZucUvkQm41LHWfrZiVFWj26Q7PReSMgcwU` | `ELC3M9Fk7Bqp4ub8UgomQKf4WBTNhQjFZCicajBFKxH7` | `4deSzKxu3NEcaSao31MzU6Bw5MjkxrvBFfmJPShg3RYZ` | `AwwjYhkUBQAC5gMLdZSpLuJkwfUuet6DkPuuCpjNrPz9` |
| WALLET | `0xfc60ab0d5da966412f22d9db71ba607368e3d1126365fc1b93d8d4f68657f7a7` (block `0x909b353`) | `BmV5hnDjM65npoFjjsoeoYtLTDxDQQVt6rHBhxYk4bX` | `EW4Pp5kKDBozd7WFnFCrgR9YxoiEpSJgaoYKF9sWq5uL` | `6L2niKE8omFLv7rtFAavowZoWBkooU9ofvmrVLxCmqvX` | `HmoWjupwbLe1fRamEK3wfic13bHYnGbhvbGn3qT4pLGH` |
| GOOD | `0x0561e180afdc4071f5fa50c9c401302f544707095445aad622238f6704517098` (block `0x909b37c`) | `yYS4ebqsHD8sdeJUsRUYca3xzQZ9oAQcK7H6VrbVgKp` | `Gtf1KoRjBJNNYHEec8595AuyQ1EMg3Tao66jGpqsgVK2` | `DgxxKEzH6SN8hyW97RVBhQyg19pUrGv7BGCTNkg6pPy3` | `7nQzEXzwwKvafqRYuSPet8PTjPbs5GYx1VwqxkycPwBx` |
| AI | `0xf310e31815d3fce7e1280533dc3fe314d637761d4d4aeb29f95d6ca692113bde` (block `0x909b3ad`) | `DXtZxJTF8pqJnwH8NzJbJ1ZuougrQkeHbaCmTUi33N2d` | `E8koQb6UAqSxr352MVecjJZ6SMFgNvCj5f2VfqTkwaqR` | `EejWY72KqpzoRaMmijpVUvz2tJLmDoCWhHJaMMxayeZz` | `2TZPtD7WdiFeQAPBx4Wr1QHzHzEDDrmPawoMytL4UfoT` |
| VLAD | `0x5520739dd840bb0091d1b007b2d2fe1bf338d7a85bc66c3cb23d5b9aa3ca77d1` (block `0x909b3de`) | `8zrBtbS54ubxtsUsawiwHfMPv7B9JL5YWFk2bsEx3cK5` | `13Tfb1G4vxhGt4PHjTikEMKdTbM15YM8ZSV6k4MKaxbT` | `E7nwLeZG5JkdGgKyck5AmU3ajPrAZqbxm6FryQmR5vc5` | `Bc4AU6iKGVU3sN6hoNWTZBcm3H6CdGTpESRygghsLiEa` |
| DEGEN | `0x136bb2555d27eba595b09e4f6d08369de0f2328304b4a5b747aecdf485445bc3` (block `0x909b40d`) | `G5vEDEnuRYoA2jsBRpmAZuCS9xhWdtQjSYyLh2n6evhZ` | `C6BzYqQNtkhCpivu1wPPisbBSMVSasEgbhW5RGafBNX7` | `CRK4ZZX7ZVPvZfGkV4Wx3zbAu4aRwAAniRAuSShoj8Gn` | `G3gatWzPxaKge7xmgHbLtM5iJ6MHXtm9R3AmAv61gZzB` |

**Limitations.** No user claim was made yet (a wallet-signed `claim` from the page is untested). Nothing here proves a played round, a lock or a payout. Hashes come from the command output of the run; the first six deposits remain unverified.

## 10. Open arena rollout, steps 1 to 3 (2026-11-11, live testnet)

Owner-approved action by action, with `scripts/testnet-wiring/open-arena.mjs` (dry run first). Full record: [evidence/2026-11-11-open-arena-rollout.json](evidence/2026-11-11-open-arena-rollout.json).

- **Arena code redeploy.** wasm from `main` `87185c5` (727,107 bytes, sha256 `332cbeb6...2af8`, host build), signed by the arena account with the owner's deploy key, code only: tx `CFve6fmmEnF4H1HeEjs2EPgy9m47KtQtP7oEyuTGJc7u`. Three earlier attempts failed with no state change (two signed by the owner account, `ActorNoPermission`; one `LackBalanceForState`). Council3 sent 0.5 NEAR for the larger code (tx `X4jGJvxXCekh6vf4QuHCFvxgs35QVxXrwzTe46WoCzR`) because the owner had 0.32 NEAR available. Read back: the allowlist view exists and was empty; battle 1 still reads (6 communities, no start time, not cancelled); oracle and observation policy unset.
- **Allowlist (D35).** DAO proposals 17 to 21 (CASHCAT, WALLET, GOOD, VLAD, DEGEN; `set_lifecycle_joinable_asset`) by council1, approved by council2 and council3; all `Approved`. `get_lifecycle_joinable_assets` lists the five backings.
- **AI untrusted.** `set_lifecycle_representation_trusted(backing-ai..., false)`: tx `2UHo85bPAgkJFYK5WNQDE3ceZanLTERgv7gFSbUkwvA8`; trusted flags read back true for the five and false for AI.

**Not done.** Oracle account, `set_lifecycle_oracle` (permanent) and the observation policy wait for the owner's approval and the confirmed terms; the GeckoTerminal live source and the collector are not built; no open arena battle has been created, locked, played, cancelled or refunded on testnet.

## 11. Creator escrow redeploy (2026-11-12, live testnet; D41)

- **Top-up.** The new wasm is 23,952 bytes larger than the deployed one and the arena account had about 19,415 free bytes of storage, so the owner sent 0.1 NEAR to `arena.valtrum-owner-b694.testnet`: tx `GMXc2F4uwHn4szwXzJZ9WHn2rCf9GUbtyUYCizDWioNU`. Owner balance before: about 0.33 NEAR.
- **Arena code redeploy.** wasm from `main` (753,934 bytes, sha256 `d698812790fa6122ec5d824fb765cd2cbc6c7b49313aa3ae2124f89cc8dc9883`, bs58 `FSh893uD3RjntE9LvyiEAT1imwPkCJ2tgJKgJsND3Zpn`, `cargo near build non-reproducible-wasm --no-abi`), signed by the arena account with the owner's deploy key, code only (no init, state kept): tx `HSHFRxNE6eFtpV1Y23veNHD7mfYtqY9AqtBgrQZiUCkp`, status `SuccessValue`. Previous code hash `JEDkRGnFP96oRVND7A8qkRDeu56UyovPQY2csqYSaF6`, kept for rollback (do not roll back while a creator escrow is held).
- **Read back after the deploy (finalized views).** The account code hash equals the build hash. `get_lifecycle_battle_count` is still 14 and battle 13 reads as before (one community, not locked). The new views answer: `get_lifecycle_creator_escrow(13)` is `null` (a battle created before the change has no escrow) and `get_lifecycle_storage_balance` is `0` for the owner. The five joinable assets are unchanged.
- **Behavior change.** `create_lifecycle_battle` no longer creates a battle on this arena; creation is `ft_transfer_call` with a `lifecycle_create` message plus prepaid storage (`lifecycle_storage_deposit`). Battles 1 to 14 were created without a creator deposit and stay as they are.
- **Not verified.** No creator escrow has been created, converted or refunded on testnet yet. The agent audit pass that writes the approvals which convert an escrow is not running here, so a new battle will hold its escrow until it is. The sandbox suite covers the new path only in `lifecycle_open_arena`; five other sandbox files still use the removed creation method.

## 7. Redeploy for the burn percentage vote and the NEAR claim (2026-11-12, live; D43 and D44)

Code-only redeploy from `main` at `46afc64` (no init, state kept), signed by each account with the owner's deploy key. Builds: `cargo near build non-reproducible-wasm --no-abi`. All token assets are FIXTURES; the NEAR transactions are live testnet evidence from the owner's accounts.

| Account | Wasm sha256 (prefix) | Code hash before | Code hash after | Tx |
| --- | --- | --- | --- | --- |
| `arena.valtrum-owner-b694.testnet` | `3459c5ba...` | `FSh893uD...Zpn` | `4XMbY3Rt...SRSf` | `3icQBr19...3vAM` |
| `backing-cashcat`, `-wallet`, `-good`, `-vlad`, `-degen` (`.valtrum-owner-b694.testnet`) | `94d5fdc1...` | `7zp4qbFS...xSDwt` | `B1zbTsYt...DKx` | `JDiCkvoe...zXUiC`, `7fvZKuqi...EpMDt`, `CgfTvCSv...52dc`, `6ebT9qUt...yEGHt`, `gSJuXefm...x8iFL` |

- **Read back (finalized views, before and after, identical).** Arena `get_lifecycle_dao_window` is `"60"` and 5 joinable assets. Each backing `get_ledger` is `accounting_balanced: true` with unchanged custody, minted and entitlements (`backing-wallet` holds an entitlement of `49000000000000000000`), and `ft_total_supply` equals minted.
- **What the new code adds.** Arena `vote_lifecycle_disposition(battle_id, burn_percent)` (argument changed from `burn: bool`); backing `claim_entitlement_as_representation(amount)`.
- **Not redeployed.** `backing1` (fixture, not on the arena allowlist), payout, registry and policy are unchanged.
- **Not verified.** No vote with a percentage and no entitlement claim has been run on testnet yet. The sandbox stage fails on `main` too (`WebAssembly trap: unreachable`), so these paths are covered by unit tests only. Use battles created after this redeploy; one that was mid-vote at the swap would mix scaled and unscaled tallies.
