# Backing security review

This is an internal review, not an independent audit or evidence of live source-chain custody.

- **Critical integration gate:** no verifier, source finality proof, or cross-instance receipt registry exists. Production receipt/mint activation must remain closed. A per-contract replay set does not prevent the same receipt being claimed in a duplicate representation contract.
- **Critical authorization gate:** receipt, reorg, reservation, broadcast and confirmation methods are Rust-only and not contract ABI methods. Future adapters must authenticate verifier and player/DAO authority, bind destination and nonce, charge storage, and independently validate source proofs. Fixture methods are self-call-only and must never be enabled in deployed builds.
- **Accounting:** unit and sandbox fixtures check actual-received amounts, exact normalization, attributed residue, duplicate receipt/debit handling and exclusive liabilities. The ledger view proves arithmetic only, not external solvency. A broadcast or timeout has no release path; confirmation compares the asset, custody, destination, amounts and transaction identity but cannot itself establish finality.
- **Reorg and storage:** a reorg pauses the asset and blocks owner unpause pending an unimplemented reconciliation mechanism. Storage unregister is disabled to prevent a pending NEP-141 refund from being burned outside the ledger. These choices fail closed but require later recovery and storage-management work.
- **Remaining scope:** source-chain proof/finality, non-execution restoration, cross-instance uniqueness, lifecycle integration, signing, DAO authorization and live testnet evidence remain outstanding. Do not archive the OpenSpec as completed on fixture results.
