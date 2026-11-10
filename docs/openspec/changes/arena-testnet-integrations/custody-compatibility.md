# Custody and payout compatibility (#148)

Status: analysis from source only. Nothing was deployed, funded or called. Fixture and code evidence, not live proof.

## Finding

**A source deposit made through `TestnetDepositCustody` cannot be paid out by the payout path.** The deposit contract keeps the tokens, has no withdrawal, sweep or execute function, and the payout contract can only spend tokens held by its configured signing account. Keep source transfers and payout readiness `false` until the holder and the signer are the same account.

## Compatibility table

| Question | Evidence in source | Result |
| --- | --- | --- |
| Where do deposited tokens end up? | `evm/src/TestnetDepositCustody.sol`: `deposit` calls `token.transferFrom(msg.sender, address(this), amount)` and measures `balanceOf(address(this))` | In the deposit contract itself |
| Can the deposit contract send them out? | Same file: only `deposit`, `nextDepositId`; no owner, withdraw, rescue, call or delegatecall. The header says "No withdrawals or recovery exist. Do not deploy or deposit real funds." | No. Tokens are locked for good |
| Who may spend for a payout? | `contracts/payout/src/contract.rs` `BackingConfigInput`: `sender` = "Custody account that signs and pays on the source chain", `path` = its MPC derivation path. `request_signature` builds the ERC-20 transfer from `sender` | The account derived from the payout contract and path (an EOA with no code) |
| Does the payout evidence check the same account? | `agent/src/payout-reconciler.ts` `findTransfer` accepts only a `Transfer` log whose `from` equals the payout's `sender` | Spending from any other holder would never confirm |
| Does the verifier treat holder and emitter as one address? | `agent/src/custody-verifier.ts` `verifyDeposit`: the `Deposited` log must come from `mapping.custody`, `Transfer` logs are summed `to` `mapping.custody`, and `balanceOfAt(token, mapping.custody, ...)` must grow | Yes: today holder == emitter == `mapping.custody` |
| Is there a configured spendable path today? | `docs/handoff-testnet-wiring.md`: the derived custody address `0x0b74...0c41` was funded with 0.002 ETH for gas only, path `valtrum-custody-1`, nonce 0. It holds no deposited tokens | No. The signing account has gas, not the deposited tokens |
| Could a prefunded balance on the signer prove the path? | Issue #148: it would show a different balance, not that deposited tokens are spendable | Rejected as evidence |

Unknown (needs on-chain reads before any live claim): the deployed custody contract's runtime code hash, the actual token balances of the deposit contract and of the signing account, and the payout contract's registered `sender` for each backing.

## Options

**A. Forwarding attribution contract (recommended for testnet).** `deposit` sends the tokens straight to a fixed `holder` (the payout signing account) and emits the same attributed `Deposited` event. The contract holds nothing, so a missing withdrawal path stops mattering. The payout path (reservation-bound MPC transfer from `holder`) is unchanged. Required changes, none made yet:
1. `evm/src/TestnetDepositCustody.sol`: immutable `holder` set at construction (non-zero, no code is checked off-chain); `transferFrom(msg.sender, holder, amount)`; `received` measured from `balanceOf(holder)`; tests for tax-on-transfer, zero holder, reentrancy and donation to `holder`.
2. `agent/src/custody-verifier.ts` `AssetMapping`: add `holder`; keep the event-emitter check on `custody` and move the `Transfer` and `balanceOfAt` checks to `holder`; tests for emitter/holder mismatch.
3. Deployment config: `holder` must equal the payout `sender` of the backing (enforced by `assessCustody`, added in this PR).
4. Disclose the unchanged boundary: the operator's attestation is a trusted assertion, not a cryptographic bridge. Donations to `holder` outside `deposit` still never create a claim; `attest_custody_balance` already compares the holder balance with liabilities.

**B. Vault with a gated withdrawal.** The contract keeps the tokens and a `withdraw` callable only by the signing account. Larger: the payout transaction becomes a call into the vault, `findTransfer` and the payout contract's transaction builder change, and a new contract holds funds (withdraw-gate and reentrancy risk).

**C. Keep deposit-only and gate it off.** Source-chain deposits stay disabled. Players use NEAR representation tokens only; no source transfer button, no payout readiness. Safe today, delivers no real source-chain flow.

## Which option matches the intended flow, and which is safer

**What the repo says it intends.** `arena-asset-representation/design.md` ("selected custody mechanism") says a dedicated source-chain custody contract records each deposit and "must not be deployed for live use until its withdrawal, reservation-bound authorization and recovery paths are implemented and reviewed". `product-spec.md` keeps OQ-CUSTODY open and says no Robinhood support may be assumed "from signing compatibility alone". **What is actually built** is different: the payout contract signs an ERC-20 transfer from an MPC-derived account (`BackingConfigInput.sender` plus `path`), and the deployed deposit contract (`0xb994...7798`, one real test deposit verified) keeps the tokens with no way out. So the design text describes a contract that can pay out, the payout code assumes an account that holds the tokens, and the deposit contract does neither: the two halves were never joined.

**Security comparison.** The trust root of any payout is the same in every option: the MPC key, reachable only through the payout contract's reservation-bound `request_signature`. The EVM side cannot verify a NEAR reservation by itself, so a vault's "reservation-bound withdrawal" would in practice reduce to "valid signature from the MPC key" again.
- **A** adds no fund-holding contract code. A forwarder holds nothing, so it cannot lock or leak funds; the only spender is the payout-controlled account; donations to the holder are harmless because only attributed events become claims. Cost: all tokens of that account share one signing identity, so a compromise of the signer or payout contract exposes them (true for B as well).
- **B** puts every deposited token in a new contract whose withdraw gate, reentrancy and upgrade/recovery paths must all be right. It repeats the same MPC trust root and adds a larger audit surface and more code to change in payout and the reconciler.
- **C** is safe because it moves no source funds.

Conclusion: A fits the payout code that exists and has the smallest attack surface; the design sentence about a "reservation-bound withdrawal" is met on NEAR by the payout contract. If A is chosen, `arena-asset-representation/design.md` should be amended to say the intended holder is the MPC-derived payout account and the deposit contract only attributes. The existing deployed deposit contract's tokens stay locked (testnet mocks); A needs a new contract deployment and a mapping version bump, which is a separate approval.

## Gates delivered with this analysis

`agent/src/custody-compat.ts` `assessCustody(facts)` returns `spendable: false` with specific reasons unless the token holder equals the payout sender, refuses a holder with contract code that has not been reviewed as spendable, refuses known deposit-only code hashes, and refuses malformed addresses. The reviewed-code and known-deposit-only hash sets are empty on purpose until real code hashes are read from chain. Wiring this into the application health and the deposit action preview is the next step once the option is chosen.

## Decision and what was built

Owner decision: option A. Built in code and tests, not deployed: the forwarder contract (`evm/src/TestnetDepositCustody.sol`, constructor `holder`, 12 Foundry tests), the verifier's separate `holder` checks (3 new tests), the CLI's `--holder` and required `--payout-sender` gate, and the amended design paragraph. Still open: deploying the new contract and the mapping version bump (separate approval), reading the holder's code hash and the payout `sender` from chain, and wiring `assessCustody` into the deposit action preview and application health.

## Original decision request (answered)

Which option to build (A, B or C). Everything else above follows from it. This issue is not permission to deploy or fund a replacement contract: any deployment or funding is a separate approval.
