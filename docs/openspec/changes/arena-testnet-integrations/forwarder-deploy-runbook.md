# Forwarder deployment runbook (#148)

Status: analysis from source only. Nothing in this document was executed, deployed, funded or read from a live chain. Each step that touches a chain needs the owner's explicit approval for that step.

## What a redeploy does and does not force (from source)

| Question | Source evidence | Answer |
| --- | --- | --- |
| Does a backing store the deposit contract address? | `contracts/backing/src/lib.rs`: the asset carries `custody_domain` (a free string, at most 256 characters) and `mapping_version`; no EVM address is stored. Claims must match both exactly (`registry_claim.rs`, line with `claim.custody_domain == asset.custody_domain` and `claim.mapping_version.0 == mapping_version`) | No |
| Does the receipt registry store it? | `contracts/receipt-registry/src/lib.rs`: a claim holds chain, transaction hash, log index, domain, mapping version, amounts; replay key is chain, hash, log index | No |
| Where is the deposit contract address configured? | Only in the verifier's `AssetMapping.custody` and now `holder` (`agent/src/custody-verifier.ts`, `custody-verify-cli.ts`) | Operator tooling only |
| Are `custody_domain` and `mapping_version` changeable on an existing backing? | Set in `Backing::new` and then immutable (`mapping_version` is a plain field, checked on every claim) | No: changing either needs a new backing instance |
| Can the old and the new deposit contract both produce valid-looking claims for the same domain and version? | Both emit the same event shape; nothing on chain distinguishes the emitter | Yes, unless the operator never attests the old one |

## The one real risk of redeploying under the same domain and version

The previously deployed deposit-only contract can still receive deposits and emit valid events. If the operator ever attests one, the backing would mint representation for tokens that can never be paid out (an under-collateralized asset). Nothing on chain prevents that under an unchanged domain and version; only operator discipline does, and `custody-verify-cli.ts` now refuses a path whose holder is not the payout sender.

## Two ways to go

**R1: keep the domain label and mapping version (no new backings).**
- Deploy the forwarder with `holder` = the payout signing account; point the verifier config at it.
- Cost: one EVM deployment (gas, a few cents of testnet ETH). No NEAR transaction, no DAO proposal, no new backing, no new `set_dao_sink`.
- Safeguard: written rule and a configured allow-list that the operator verifies receipts only from the forwarder address; the old contract's address is recorded as retired; a startup check refuses a mapping whose `custody` is on that list.
- Residual risk: an operator mistake can attest an old-contract deposit.

**R2: new mapping version (or domain label), new backings.**
- A new backing per token (about 4.3 NEAR each in the recorded run, six tokens), DAO-owned initialization, registry representation and trust wiring, and payout registration. `set_dao_sink` is irreversible once per token and may already be set.
- Cost and owner effort are high; the old contract is fully separated on chain.

Recommendation: R1 for this testnet, because the old contract holds only mock tokens, the operator is the owner, and the tooling now refuses the old path. Choose R2 only if you want on-chain separation or a clean audit trail.

## Read-only checks (run 2026-11-10; evidence: `docs/evidence/2026-11-10-custody-readonly-checks.json`)

1. **Old contract:** the runtime code hash is unchanged and equals the recorded deposit-only build; it still holds the 100 mCASHCAT of the one test deposit. Confirmed.
2. **Recorded deposit:** `get_claim` on the registry for that transaction returns `null`: it was never attested, so nothing was minted from the locked tokens. Confirmed.
3. **Holder:** `0x0b74...0c41` has no code, nonce 0, no tokens, 0.002 ETH of gas. Confirmed. The payout contract's registered `sender` per backing is **not readable** (no view exists), so it stays unconfirmed until the `register_backing` transaction or a real payout shows it.
4. **Deployer:** 0.008064 ETH; gas price 0.01 gwei; the deployment should cost about 4 microETH. Confirmed.

Limit: read through dRPC only because the official RPC refused connections; re-read through the official RPC before deploying.

## Steps for R1 (each needs your approval when reached)

1. Record the checks above in `docs/evidence/`.
2. Build and test: `forge test` in `evm/` (done in CI), then `forge build` and record the creation bytecode hash.
3. Deploy `TestnetDepositCustody(holder)` from the owner-authorized deployer; record the address, transaction hash and runtime code hash. Confirm `holder()` equals the payout `sender` and has no code.
4. Verify on chain: `holder()`, `nextDepositId() == 0`, the contract's token balances are zero.
5. Configure the verifier mapping (`custody` = new address, `holder` = payout sender, unchanged domain and version) and `ARENA_APPLICATION_CUSTODY_PATHS` so health reports the path; the retired address is recorded and refused.
6. One small test deposit of a mock token, verify it with `custody-verify-cli.ts`, attest it, then run one payout of the same amount through the payout contract and confirm the holder's balance and the finalized receipt. This is the live proof that closes #148 and feeds #80.

## Not covered

DAO or NEAR transactions (none needed for R1), mainnet, real tokens, and any claim that the MPC signer is a trust-minimized bridge: the residual trust is the signer and the payout contract's reservation checks.
