# GoPlus token audit policy

Status: **planned, unimplemented**. This is the selected field mapping for the Robinhood testnet arena, not a claim that the API supports every test token. The [product specification](product-spec.md) governs battle behavior. Tax limits, admissibility of admin privileges and evidence freshness remain OPEN; the field mapping and critical rejection rules below are defined.

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
| `buy_tax`, `sell_tax` | Buy/sell tax fractions | Unknown/malformed: Pending; value 1: Reject as an unusable trading path; acceptance of other nonzero taxes awaits the OPEN threshold policy |
| `transfer_tax` | Wallet-transfer tax fraction | Unknown/malformed: Pending; value 1: Reject as an unusable custody/payout path; other values require the OPEN transfer-tax policy |
| `slippage_modifiable` | Modifiable trading tax | Record effective privilege and owner evidence; admissibility OPEN |
| `personal_slippage_modifiable` | Address-specific tax changes | Record custody/recipient exposure; admissibility OPEN |
| `transfer_pausable` | Ability to pause transfers | Record capability and effective authority; admissibility OPEN |
| `owner_change_balance` | Ability to modify holder balances | Record custody/backing exposure; admissibility OPEN |
| `is_blacklisted`, `is_whitelisted` | Address-list controls | Record capability and possible custody/recipient restrictions; admissibility OPEN |
| `is_mintable` | Mint capability | Record supply/backing/scoring exposure; admissibility OPEN |
| `is_open_source`, `is_proxy` | Inspection context | Record coverage limitations; neither a proxy nor closed source alone proves a scam. Missing mandatory dependent checks keep Pending |
| `owner_address`, `hidden_owner`, `can_take_back_ownership` | Ownership context | Preserve effective and recoverable authority evidence; no automatic safe verdict for renounced ownership |
| `is_in_dex`, `dex` | Reported DEX context | Record discovered markets; do not substitute their aggregate liquidity for the independent LP gate |

The three critical flags and three tax fields are required normalized outputs. Privilege fields must have known results or an evidenced, policy-approved not-applicable explanation before approval; a provider omission cannot become not-applicable by default. Ownership and inspection context must explain whether checks are meaningful. Informational DEX context is not an alternative to independent pool evidence.

## Decision precedence

1. **Reject** if authenticated, correctly attributed evidence contains a selected critical flag set to true, or a tax fraction of exactly 1. A simultaneous missing field does not hide an established rejection.
2. Otherwise **Pending** for unknown/malformed required fields, missing source coverage, unresolved required tax/admin policy, stale evidence, missing independent LP proof or conflicting observations. Unknown does not become false when retried.
3. **Pass** only when critical checks are known and clear, tax/admin policies are explicitly resolved and satisfied, and independent LP evidence is valid and strictly above USD 10,000. Zero tax alone does not resolve the other gates.

A risk capability being present is different from a confirmed attack. Until the admin policy is decided, record the finding and hold Pending rather than label every owner capability critical or approve with an unimplemented warning. Persist per-field reasons and the overall decision; show the same reasons in UI, MCP and the auditor logs.

## Independent liquidity depth

Verify the eligible Robinhood pool(s), reserves or active positions, quote asset, valuation source, observation time/block and deduplication. The LP valuation must be **strictly greater than USD 10,000**. Exactly USD 10,000 or less fails the liquidity gate; missing or unreliable valuation stays Pending. Do not count a token's market cap as liquidity or infer depth from a price alone.

Report active/executable depth alongside headline pool value where the DEX uses concentrated liquidity; the minimum executable-depth policy and eligible pool aggregation remain part of the OPEN market-data design. A fixture can exercise the gate but must not be represented as market liquidity worth real dollars.

## Cron validation and pre-lock check

The auditor schedules validation after proposal and refreshes it before lock under a versioned freshness policy. Approval requires every community to pass; a newly added community or changed mapping invalidates the affected approval. Refuse lock if required evidence expired, changed or became incomplete. Freeze the policy/evidence references with the snapshot. Polling and retries are idempotent and do not alter the intended round boundaries.

The cron cadence, evidence TTL, retry deadline and behavior after a live token-policy change remain OPEN. Do not invent an hourly live check for a 30-second round or silently introduce a live refund rule. GoPlus signals are point-in-time evidence, not guarantees against later contract changes.

## Required scenarios

- Critical flag true plus another field absent: Reject with both reasons preserved.
- `cannot_sell_all = "1"`: Reject without claiming that all sales necessarily fail.
- Flag `"0"` is parsed as false; absent/null/empty required flag stays Unknown/Pending.
- `buy_tax = "0.05"` is recorded as 5%; empty tax is Unknown, not zero; out-of-range or nonnumeric fractions stay Pending as malformed evidence.
- Any tax of 1 rejects; otherwise clear critical flags cannot bypass unresolved tax/admin policies.
- Proxy or closed-source responses omit dependent fields: Pending unless the required coverage is established, never automatic Pass.
- Renounced ownership does not override a honeypot result or unknown transfer restrictions.
- Correct evidence for the wrong chain/token cannot approve the proposal.
- LP values 9,999, 10,000 and 10,001: the first two fail the gate; only 10,001 can satisfy it, subject to all other gates.
- GoPlus passes but independent LP evidence is absent: Pending.
- A recheck expires before lock or a new community is added: refresh affected evidence before locking.
- Fixture-backed test succeeds: mark it as adapter verification, not a live integration.

The corresponding [OpenSpec audit requirements](openspec/changes/arena-audit/specs/arena-audit/spec.md) are acceptance criteria for future implementation. DAO rules remain independent and OPEN.
