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

Live testnet evidence from the owner's accounts; data in [`evidence/2026-11-09-near-testnet-deploy.json`](evidence/2026-11-09-near-testnet-deploy.json).

- **Signer** `v1.signer-prod.testnet` (docs.near.org lists it as the testnet MPC contract): code hash `CpGX8ywXJwvWPgZFDDCTCuPJBHF7BATT51gSfc3APERJ`, contract `version` 3.18.0, balance about 2050.9 NEAR. `state` is `Running`, epoch 27, domain 0 is `CaitSith` secp256k1 with purpose `Sign` (reconstruction threshold 11); `public_key` (domain 0) is `secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3`. `latest_key_version` and `experimental_signature_deposit` are not methods of this version.
- **Derivation:** `derived_public_key({path:"valtrum-custody-1", predecessor:"payout.valtrum-owner-b694.testnet", domain_id:0})` = `secp256k1:2nhnxaGQiwaF7ZBuetRGTM7js1hZdey36BHyEwAaHf5tE1RgcXu3EGjw3NYR9GXQV92G5TaFaN1GdAwEuNK6sg9i`. Derived EVM address (keccak256 of the 64-byte key, last 20 bytes): **`0x0b740E3E90491f57699fCCD8276400E65BC70c41`**. The address algorithm was checked against the generator point's known address. The path name is a proposal and is immutable once registered in payout; the address is not funded and not registered.
- **`sign` interface, one live test:** the owner account called `sign` once with `{"request":{"path":"valtrum-interface-test","payload_v2":{"Ecdsa":"<sha256 of a fixed text>"},"domain_id":0}}`, 1 yoctoNEAR and 300 Tgas (tx `Cdby3uvfjtPtjEhtoqfyASSGU4usS7ncJmUFzJ2n4uDD`, about 8.2 Tgas burnt). It is zero value, controls no funds and uses the owner's own derivation, not the payout custody. Response shape: `{"scheme":"Secp256k1","big_r":{"affine_point":"02..."},"s":{"scalar":"..."},"recovery_id":1}`. Offline, the signature recovers to the address derived for that owner and path (`0x4d527620ECaC81fC876b1E21aEe8ff2fdd54B1C5`), so path, `payload_v2`, `domain_id` 0 and the 1 yocto deposit are verified. The payout contract's `parse_signature` accepts this shape by code reading; it was not executed live (no payout is registered).
- **Code hashes** (NEAR on-chain hash equals the base58 SHA-256 of the built wasm, `cargo near build non-reproducible-wasm --no-abi`, host build): arena `6zKvCSoYBrTKrLkYtUfjLohFWaYvzAQbvtoMXwntAJR5`, receipt registry `CzEeVAYx9Ksj3cdNSUMdANxv7GR9VmMde4S77Q4mrPpK`, payout `8d5h3HWoW8DRzTRZytpKnyctQ9kt2NSWZdQHBxTtKwa1`, player policy `kqDPt6QeJhQREee6FukM2GZqLLbjt1E9rgadBaek79X`, backing `EQQ5NmcTF6Zkrdpux2zf5iU8WKax7n1b9xue5VdVH5d5`.
- **Not verified:** gas funding of the custody address on Robinhood testnet (needs a working RPC and testnet ETH), a payout signature for a real custody transfer, and the deposit the signer charges when load is high (only the 1 yocto minimum was observed).

## 3. Source receipts, attribution, finality and reorg evidence: not verified

This needs funded deposits and payouts on the target deployment. Recorded so far: Robinhood testnet exposes a `finalized` head (about 7,300 blocks behind the latest at the time of reading). The indexer (#92) and the payout reconciler only treat source receipts as final along that head. No real receipt has been recorded.

## 4. Fixture labels

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
