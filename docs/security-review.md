# Security review

Scope: `contracts/arena`, `contracts/router`, `contracts/mock-dex` (testnet only) and `contracts/mock-ft` (testnet only, open mint).
Method: a detector checklist for NEAR contracts (access control, callbacks, reentrancy, one-yocto checks, storage prefixes, initialization, arithmetic, gas, storage cost) applied to the source, plus the unit tests and the sandbox scenarios in `contracts/integration`.

This is a self-review done during development, not an external audit. Do not deploy the contracts with real funds on the strength of it.

## Checks that came out clean

| Check | Result |
| --- | --- |
| Callbacks without `#[private]` | None: every `on_*` method is private. The sandbox test calls two of them from an outside account and they are refused |
| State change after a cross-contract call | State is updated before the promise is created (credit spent, balance debited, step marked dispatched, claim flag set); callbacks restore it on failure |
| Missing caller checks | Agent-only and owner-only methods are covered by unit tests and by the sandbox test |
| Missing `assert_one_yocto` | Present on `withdraw_liquid`, `deposit_with_credit` and the router's `claim_stranded`. `deposit_from_balance` deliberately has none so a scoped key can call it; it can only spend the caller's own internal balance and credit |
| Storage prefix collisions | Every collection has its own `StorageKey` variant |
| Initialization | `#[init]` plus `PanicOnDefault` on all three contracts |
| Arithmetic | `overflow-checks = true` in the release profile, checked math on amounts, 256-bit multiplication for 18-decimal values, no floating point, no `unwrap` or `panic!` in contract code paths |
| Panics inside callbacks | Callbacks restore state and emit events; they do not rely on panics |
| Unbounded loops | Page size capped at 100; plans have at most four steps; the agent list is owner-controlled |
| Randomness | Not used |
| Gas | The four-hop USDC swap and the on-chain settlement run in the sandbox with the maximum prepaid gas. Smaller prepaid amounts were not profiled |

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Low | The deposit window had no upper bound. A mistaken owner setting could make `approve_battle` overflow and fail until corrected | Fixed: the window must be between 1 second and 30 days, enforced in `new` and in the setter, with tests |
| 2 | Medium | Storage is paid by the contract. Anyone can create positions, balances and proposals by sending small token amounts, which slowly spends the contract's NEAR. Proposals cost a bond, so the practical exposure is dust deposits and dust balance funding | Accepted for the testnet build. Mitigations before real funds: per-account storage deposits or minimum amounts, and monitoring of the contract balance |
| 3 | Medium | Settlement proceeds are authenticated by value, not by message. A DEX forwards whatever message its caller supplies, so a stranger can route their own tokens to the arena with a `step_proceeds` message. The agent's `min_out` floor bounds what this can displace to the accepted slippage, and the stranger pays for it. The router has the same property for its swap receipts | Accepted for the mock DEX. A production integration should also reconcile against balance snapshots |
| 4 | Medium | Battle tokens are chosen by the proposer. A malicious token contract could report deposits it never made. The agent's audit (liquidity and honeypot checks) is the only gate | Accepted: the audit must stay strict, and the honeypot check is a heuristic until a real sell simulation exists |
| 5 | Medium | With on-chain execution off, the amounts the agent reports are trusted. A compromised agent key could inflate rewards | Accepted: use on-chain execution (the default for demos), keep the agent account minimal, and rotate it with the owner key |
| 6 | Low | A swap the DEX accepted but never paid out leaves a settlement step dispatched with no reset method | Known gap. The agent logs it loudly after a timeout |
| 7 | Low | The burn account must be registered with the coin or the burn transfer fails and the coin stays in the arena (`burn_failed` event) | Documented |
| 8 | Low | `battle_id` and `step_index` use native integers in JSON. They stay far below 2^53 | Accepted |
| 9 | Low | A routed deposit that arrives after the agent locked the battle is refused and ends up as the beneficiary's stranded balance in the router | Documented. The user recovers it with `claim_stranded` |
| 10 | Info | `mock-ft` mints to anyone and `mock-dex` uses fixed rates. They exist for testnet and sandbox use only | By design |

## Trust assumptions

- The owner can pause deposits, rotate agents, and change the treasury, router and execution settings. Withdrawals, refunds and claims keep working while paused.
- The agent decides audits, prices and settlement timing. Prices come from a 30-minute average of a public API.
- A function-call session key scoped to the arena can at most spend the funded internal balance and valid credit on deposits.
