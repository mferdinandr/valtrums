# GoPlus token audit policy

Status: **adapter implemented (`agent/src/audit/`), fixture-verified only; no live GoPlus or mainnet liquidity coverage has been verified.** This is the selected field mapping for the Robinhood testnet arena. The [product specification](product-spec.md) governs battle behavior. Owner decisions below (policy `audit-policy-v1`) resolve the tax limit, admin-privilege admissibility and the default evidence TTL. Still OPEN: recovery after a live token-policy change, the minimum executable-depth policy for concentrated liquidity, and the DAO rules.

## Owner decisions (policy `audit-policy-v1`)

Every parameter lives in one versioned policy object (`agent/src/audit/policy.ts`); `policyHash` commits to the resolved decisions and their parameters, so changing any of them changes the hash and invalidates earlier approvals.

- **Tax:** `buy_tax`, `sell_tax` and `transfer_tax` are each admissible up to and including `0.05` (exact decimal, never floats). Above `0.05` is Reject with reason `tax_above_limit`. A tax of exactly `1` is still Reject. Unknown or malformed values stay Pending, and an unknown field never hides a Reject.
- **Admin privileges:** `is_mintable`, `transfer_pausable`, `is_blacklisted`, `is_whitelisted`, `owner_change_balance`, `slippage_modifiable` and `personal_slippage_modifiable` are admissible only when ownership is renounced and unrecoverable: `owner_address` empty or the zero address, `hidden_owner` false and `can_take_back_ownership` false. An active capability with non-renounced ownership is Reject with reason `admin_privilege_not_renounced`. An active capability with unknown ownership, or any unknown capability flag, is Pending. An inactive capability needs no ownership condition.
- **Freshness:** the evidence TTL is configurable (`AUDIT_EVIDENCE_TTL_SECS`, default 600 seconds, must exceed twice the agent pass interval). Evidence age is measured from the older of the GoPlus query time and the oldest liquidity observation (block time). The scheduler re-audits before the approval's remaining life falls under two pass intervals, and a stale or changed result is submitted as Pending, which withdraws the on-chain approval. Recovery behaviour after a live token-policy change stays OPEN.

## Reference-token audit (testnet mock tokens)

GoPlus supports Robinhood mainnet `4663` only. On testnet `46630` the project uses representative mock tokens whose metadata carries `reference_chain_id` (`4663`) and `reference_address` (the mainnet token the mock represents). Both the GoPlus query and the liquidity read use that **mainnet reference pair**, never the testnet mock's pools, because testnet pools do not represent the real market.

- The mapping is accepted only from a **protocol-controlled registry in configuration** (`AUDIT_REFERENCE_REGISTRY`). A mapping a token merely declares about itself, or one that disagrees with the registry, holds Pending (`reference_unregistered`, `reference_conflict`). Registry entries must reference chain `4663`.
- The record binds both the testnet asset and the reference pair (with a digest of the registry entry), and labels the audit `reference_token`. The record, `policyHash` and `evidenceHash` all state that GoPlus and liquidity evidence are for the reference token and that the testnet mock was not itself audited (`assetItselfAudited: false`).
- **Approval attests the mainnet reference token, not the behaviour of the testnet mock contract.** The user-facing report says this in plain words.
- Unmapped tokens keep the earlier rule: evidence for any other chain or token cannot approve them.
- A change to the registry mapping changes the bound asset and invalidates the approval.

On 2026-11-06 22:50 UTC, an unauthenticated request to the Token Security v1 endpoint for chain `46630` and `0x0000000000000000000000000000000000000001` returned code `2022`, `The main chain is not supported`, and a null result. This is evidence that this request did not provide coverage, not proof about every GoPlus product, credential, future response, or token. The agent submits results to the arena through `submit_lifecycle_audit`, but nothing here establishes live GoPlus coverage or live liquidity. Unit-test responses are fixtures.

On the same date, a request for chain `4663` and the same address returned code `1` with an empty result. The endpoint accepted that chain ID but returned no token evidence, so this does not establish coverage of a particular token. The [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/) identifies `4663` as mainnet and `46630` as testnet; their responses cannot be substituted for one another.

## Evidence and normalization

Source: [GoPlus Token Security Response Details](https://docs.gopluslabs.io/reference/response-details), reviewed 2026-11-06; request schema: [Token Security API](https://docs.gopluslabs.io/reference/tokensecurityusingget_1). Preserve the raw response and its hash so later API/schema changes can be detected.

Bind each audit to chain ID, token address, provider/API version, queried time, policy version, evidence hash and the battle's asset mapping. Check the source token, not its NEAR wrapper. A response for another network or address cannot approve a token. A provider error, incomplete result or unsupported network is not a clean audit.

Normalize documented flag values explicitly: string `"1"` means true, `"0"` means false; missing, null or an unexpected representation means Unknown. Do not use JavaScript truthiness for `"0"`. Tax fields are decimal fractions: `0.05` represents 5%, not 0.05%; retain exact decimal precision, never binary floating point for policy comparison. Missing or empty tax values are Unknown, not zero. An empty `owner_address` can mean no owner; preserve it separately from missing/unknown ownership.

## Selected field mapping

The descriptions below identify signals; the action column is Valtrum's eligibility policy, not a guarantee supplied by GoPlus.

| Fields | Signal | Valtrum action |
| --- | --- | --- |
| `is_honeypot` | Honeypot detection | True: Reject; Unknown: Pending |
| `cannot_sell_all` | Restriction on selling the entire holding | True: Reject for this arena; Unknown: Pending; do not describe it as proof that every sale is impossible |
| `cannot_buy` | Buying restriction | True: Reject for this traded-token arena; Unknown: Pending; a detection is an eligibility failure, not proof of malicious intent |
| `buy_tax`, `sell_tax` | Buy/sell tax fractions | Unknown/malformed: Pending; value 1: Reject as an unusable trading path; above `0.05`: Reject (`tax_above_limit`); up to and including `0.05`: admissible |
| `transfer_tax` | Wallet-transfer tax fraction | Unknown/malformed: Pending; value 1: Reject as an unusable custody/payout path; above `0.05`: Reject (`tax_above_limit`); up to and including `0.05`: admissible |
| `slippage_modifiable` | Modifiable trading tax | Active: admissible only if ownership is renounced and unrecoverable, else Reject (`admin_privilege_not_renounced`); unknown: Pending |
| `personal_slippage_modifiable` | Address-specific tax changes | Same rule as above |
| `transfer_pausable` | Ability to pause transfers | Same rule as above |
| `owner_change_balance` | Ability to modify holder balances | Same rule as above |
| `is_blacklisted`, `is_whitelisted` | Address-list controls | Same rule as above |
| `is_mintable` | Mint capability | Same rule as above |
| `is_open_source`, `is_proxy` | Inspection context | Record coverage limitations; neither a proxy nor closed source alone proves a scam. Missing mandatory dependent checks keep Pending |
| `owner_address`, `hidden_owner`, `can_take_back_ownership` | Ownership context | Renounced and unrecoverable means owner empty or zero address, `hidden_owner` false and `can_take_back_ownership` false; used only to judge active admin capabilities, never to override a honeypot or tax result |
| `is_in_dex`, `dex` | Reported DEX context | Record discovered markets; do not substitute their aggregate liquidity for the independent LP gate |

The three critical flags and three tax fields are required normalized outputs. Privilege fields must have known results or an evidenced, policy-approved not-applicable explanation before approval; a provider omission cannot become not-applicable by default. Ownership and inspection context must explain whether checks are meaningful. Informational DEX context is not an alternative to independent pool evidence.

## Decision precedence

1. **Reject** if authenticated, correctly attributed evidence contains a selected critical flag set to true, a tax fraction of exactly 1 or above `0.05`, or an active admin capability with non-renounced ownership. A simultaneous missing field does not hide an established rejection.
2. Otherwise **Pending** for unknown/malformed required fields, missing source coverage, an unresolved policy (the default `UNRESOLVED_POLICY` holds everything Pending), stale evidence, missing independent LP proof, an unresolved reference mapping or conflicting observations. Unknown does not become false when retried.
3. **Pass** only when critical checks are known and clear, tax and admin policies are resolved and satisfied, and independent LP evidence is valid and strictly above USD 10,000. Zero tax alone does not satisfy the other gates.

A risk capability being present is different from a confirmed attack; the admin rule above is the owner's admissibility decision, not a claim that every capability is an attack. Liquidity at or below USD 10,000 withholds approval as Pending (it can grow), not Reject. Persist per-field reasons and the overall decision; the audit report (`agent/src/audit/report.ts`, keyed by `evidenceHash`) shows the same reasons, tax percentages, each admin capability and ownership status, the policy version, TTL expiry and the reference mapping.

## Independent liquidity depth

Liquidity depth is **measured on the mainnet reference token** (chain `4663`, the registry's `reference_address`), never on the testnet mock's pools. The fetcher (`agent/src/audit/lp-fetcher.ts`) reads configured pools' reserves on-chain through a separate read-only mainnet RPC (`REFERENCE_RPC_URL`, https only, http for localhost; distinct from the testnet `FOREIGN_RPC_URL`), with the shared transient-failure retry. The URL and any key stay in the git-ignored environment and never enter evidence.

- Only the reserve of an **explicitly configured stablecoin** (`AUDIT_STABLECOINS`, address to decimals) is valued, at 1 unit = 1 USD. A token is never guessed to be a stablecoin; pools whose other side is not on the list are ignored. The paired token side is not valued, so a pool is never credited more than its stablecoin reserve.
- Deduplicate pools by chain and address. Observation time is the block's own timestamp. The evidence TTL uses the older of the GoPlus query time and the oldest liquidity observation.
- The LP valuation must be **strictly greater than USD 10,000**. Exactly USD 10,000 or less fails the gate; missing or unreliable evidence (RPC for another chain, missing valuation source or time, conflicting duplicates) stays Pending. Do not count a token's market cap as liquidity or infer depth from a price alone.
- Constant-product (`v2`) pools are read from `getReserves`. Concentrated-liquidity (`v3`) pools expose the stablecoin balance as headline value only; their executable depth is **not computed**, so they cannot satisfy the gate. The minimum executable-depth policy stays OPEN and no value is invented.

A fixture can exercise the gate but must not be represented as market liquidity worth real dollars. All liquidity tests are fixture-only; no live mainnet coverage is claimed.

## Cron validation and pre-lock check

The auditor schedules validation after proposal and refreshes it before lock under a versioned freshness policy. Approval requires every community to pass; a newly added community or changed mapping invalidates the affected approval. Refuse lock if required evidence expired, changed or became incomplete. Freeze the policy/evidence references with the snapshot. Polling and retries are idempotent and do not alter the intended round boundaries.

The evidence TTL is configurable (default 600 s) and the audit pass runs inside the agent's regular pass, refreshing an approval before its remaining life falls under two pass intervals. The contract itself does not check approval expiry at lock; lock refusal on expiry relies on the pass withdrawing the approval (submitting Pending), and the agent does not yet drive `lock_lifecycle_battle`. The behavior after a live token-policy change remains OPEN: do not invent an hourly live check for a 30-second round or silently introduce a live refund rule. GoPlus signals are point-in-time evidence, not guarantees against later contract changes.

## Required scenarios

- Critical flag true plus another field absent: Reject with both reasons preserved.
- `cannot_sell_all = "1"`: Reject without claiming that all sales necessarily fail.
- Flag `"0"` is parsed as false; absent/null/empty required flag stays Unknown/Pending.
- `buy_tax = "0.05"` is recorded as 5% and is admissible; `0.050000001` rejects with `tax_above_limit`; empty tax is Unknown, not zero; out-of-range or nonnumeric fractions stay Pending as malformed evidence.
- Any tax of 1 rejects; otherwise clear critical flags cannot bypass an unresolved tax/admin policy.
- An active admin capability with a non-zero owner, hidden owner or recoverable ownership rejects with `admin_privilege_not_renounced`; with renounced ownership it is admissible.
- A mapped testnet token needs mainnet reference evidence for both GoPlus and liquidity; evidence for the mock itself, or an unregistered or self-declared mapping, cannot approve.
- Proxy or closed-source responses omit dependent fields: Pending unless the required coverage is established, never automatic Pass.
- Renounced ownership does not override a honeypot result or unknown transfer restrictions.
- Correct evidence for the wrong chain/token cannot approve the proposal.
- LP values 9,999, 10,000 and 10,001: the first two fail the gate; only 10,001 can satisfy it, subject to all other gates.
- GoPlus passes but independent LP evidence is absent: Pending.
- A recheck expires before lock or a new community is added: refresh affected evidence before locking.
- Fixture-backed test succeeds: mark it as adapter verification, not a live integration.

The corresponding [OpenSpec audit requirements](openspec/changes/arena-audit/specs/arena-audit/spec.md) are the acceptance criteria. DAO rules remain independent and OPEN.
