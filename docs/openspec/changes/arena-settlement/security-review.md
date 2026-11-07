# Settlement, rounds and payout security review

This is an internal review (`cargo audit`, a pattern pass over the NEAR detector list, and manual reading), not an independent audit or evidence of live custody. It covers the arena round and settlement entry points, fee settings, and the backing, registry and payout contracts they call.

## Fixed in this change

- **Settlement denial of service (medium).** Settlement reads every winning participant on each call, and position registration is open to anyone, so many empty registrations could push a call past its gas limit and lock rewards. Participants now enter the index only when they first hold a credited deposit, and a community accepts at most 300 depositors (`MAX_PARTICIPANTS_PER_COMMUNITY`). Remaining trade-off: someone holding real backed tokens can fill the slots with dust before lock. A minimum deposit would close that; it is an economics decision that is still open, as is a design whose cost does not grow with the number of participants.
- **One-yocto guard (low).** The oracle methods (`open_lifecycle_round`, `submit_lifecycle_observations`) and the payout methods for owner, relayer and operator now require exactly one yocto, so a function-call-only access key cannot drive them. The oracle, relayer and operator bots therefore need full-access keys.
- **Round window (medium).** A round's start must be within five minutes of the block time in either direction, so the oracle cannot choose a historical window or park a battle on a distant future one.

## Open before any deployment

- **Payout signing is not constrained on chain (high).** The payout contract does not call the MPC signer; the relayer reports a transaction hash the contract cannot tie to the authorized parameters. Only evidence matching the exact amount, recipient, token, sender and an attempted hash can confirm a payout, but nothing stops a party that can obtain a signature for the custody path from signing something else. The custody path must be reachable only through this contract, which must request the signature for the payload it reconstructs.
- **Single trusted accounts (medium).** The oracle and the protocol fee account are fixed, cannot be rotated, and are fully trusted: the oracle can decide any battle with prices nobody verifies, and the protocol account sets the fee (capped at 10%) before players join. The operator and relayer in the payout contract are fixed in the same way.
- **Storage paid by the contracts (low).** The arena pays for round history and the settlement cursor, the payout contract for attempts and backing registration, and unused storage refunds from the backing go to the arena. No withdrawal path exists.
- **Large communities (low).** Settlement recomputes the plan on every call; the 300-depositor cap keeps this inside one call, but the plan is not stored.
- **Older raw integers (low).** Some existing arena lifecycle methods still take a bare `u64` in JSON (`register_lifecycle_position`, `lock_lifecycle_battle`); clients must not send values above 2^53.

## Checked and clean

All callbacks are `#[private]`. No state is changed after a cross-contract call before its callback, and a failed or out-of-gas callback is recoverable by repeating the call because the backing, registry and payout operations are idempotent per identity. Storage prefixes are unique and new keys were appended. Initializers are marked, there is no floating point or randomness, and arithmetic is checked. `cargo audit` reports `crypto-bigint` (RUSTSEC-2026-0387), which is not in the contract's wasm dependency tree, and two unmaintained crates inherited from `near-sdk`.
