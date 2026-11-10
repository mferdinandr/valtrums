# Live custody proof plan (#148 handoff to #80)

Status: a plan. No transaction in it has been sent. Every mutating step needs the owner's explicit approval for that step, with the exact command shown first.

## What is proven and what is not

Proven (fixture evidence and read-only chain reads, see `custody-compatibility.md`, `forwarder-deploy-runbook.md` and `docs/evidence/2026-11-10-*.json`):
- The old deposit contract cannot pay out; the forwarder holds nothing and sends deposits to the holder; the holder has no code and no tokens; the code on chain equals the build.
- The payout contract's registered sender for `backing-cashcat` is the holder: transaction `FQVJSyoc...NNV` (`register_backing` on `payout.valtrum-owner-b694.testnet`, success) carries `sender` = `0x0b740e3e90491f57699fccd8276400e65bc70c41` and `path` = `valtrum-custody-1`. The six backings share `custody_domain` = `0xb994dcab...7798`.
- The verifier, the gate and the retired-address refusal are tested.

Not proven: that the holder can actually spend deposited tokens through a real payout. That needs a live battle flow, which is #80's scope.

## Why the payout proof needs a battle

`payout.request_payout` reserves from a holder's **entitlement**, which only the arena can allocate after a battle result. `payout.request_late_refund` reserves from a **late deposit**: a deposit whose receipt is claimed after the battle's lock (`backing.on_claim_lock_status`). The shortest real path is the late refund:

1. A lifecycle battle that includes the asset's backing, created and locked on a deployment wired to the registry, the backing and the payout contract. At the time of writing the old target arena has 0 lifecycle battles and no `_v1` readiness view; the newer application read deployment is recorded in `docs/evidence/2026-11-10-application-read-deploy.json`.
2. EVM, forwarder (deployer owns the mock token): mint mCASHCAT to a depositor (owner-only), approve the forwarder, then `deposit(token, battleId, mappingVersion, refundAddress, beneficiary, amount)` with `mappingVersion` equal to the backing's immutable `mapping_version` and `beneficiary` a NEAR account. Expected cost: three transactions, well under 0.0001 ETH.
3. Wait until the receipt block is under the node's `finalized` tag (about an hour in the recorded run).
4. Verify: `custody-verify-cli --rpc <official> --state-rpc <dRPC> --tx <hash> --log-index 1 --token <mCASHCAT> --custody 0xEb49...5C6C --holder 0x0b74...0c41 --payout-sender 0x0b74...0c41 --custody-domain 0xb994dcab6ad9a042e7bbec3ba104ec5e6b797798 --retired 0xb994...7798 --mapping-version <n> --battle <id> --representation backing-cashcat.valtrum-owner-b694.testnet`. The default `--custody-domain` does not match the deployed backings.
5. NEAR: the verifier account attests the claim to the registry (one yocto); anyone calls `backing.claim_receipt` (storage deposit 0.02 NEAR); a locked battle records it as a late deposit.
6. NEAR: the beneficiary calls `payout.request_late_refund(backing, beneficiary, request_id, amount, refund_address)` with the request deposit (0.03 NEAR); the backing reserves it.
7. The payout relayer (#150, `pnpm -C agent payout:relayer`) requests the signature (signer gas 250 Tgas, 1 yocto), the signed transfer is broadcast from the holder (the holder has 0.002 ETH for gas), and after finality the operator (`pnpm -C agent payout:operator` with submit enabled) confirms with the finalized receipt.
8. Checks that close the proof: the holder's token balance falls by the amount, the refund address receives it, the payout state is `confirmed`, the backing reservation is consumed exactly once, and a repeat of any step changes nothing.

## Who signs what (each needs approval)

| Step | Signer | Typical cost |
| --- | --- | --- |
| Mint, approve, deposit | EVM deployer / depositor | under 0.0001 ETH |
| Attest | verifier account | a few hundredths of a NEAR in gas |
| claim_receipt | any account | 0.02 NEAR storage deposit, refunded in part |
| request_late_refund | beneficiary | 0.03 NEAR request deposit |
| request_signature | relayer | 250 Tgas, 1 yocto |
| confirm_payout | operator | 1 yocto, gas |

## Stop conditions

Stop and report if: the finalized tag does not cover the receipt within a few hours, any verdict is `rejected`, the holder's balance does not change after the signed transfer, a claim names the retired contract, or the payout contract reports `reconciliation_required`. Never fund or "test" the retired deposit contract, and do not describe this as a trustless bridge: the residual trust is the MPC signer, the payout contract's reservation checks and the trusted operator attestation.
