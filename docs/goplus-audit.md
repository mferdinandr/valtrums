# GoPlus token audit policy

Status: **adapter implemented (`agent/src/audit/`), fixture-verified only; no live GoPlus or mainnet liquidity coverage has been verified.** This is the selected field mapping for the testnet arena on NEAR, whose test tokens are audited through their Robinhood Chain mainnet reference tokens. The [product specification](product-spec.md) governs battle behavior. Owner decisions below (policy `audit-policy-v1`) resolve the tax limit, admin-privilege admissibility and the default evidence TTL. Still OPEN: recovery after a live token-policy change and the minimum executable-depth policy for concentrated liquidity. DAO rules are decided separately (D22).

## Owner decisions (policy `audit-policy-v1`)

Every parameter lives in one versioned policy object (`agent/src/audit/policy.ts`); `policyHash` commits to the resolved decisions and their parameters, so changing any of them changes the hash and invalidates earlier approvals.

- **Tax:** `buy_tax`, `sell_tax` and `transfer_tax` are each admissible up to and including `0.05` (exact decimal, never floats). Above `0.05` is Reject with reason `tax_above_limit`. A tax of exactly `1` is still Reject. Unknown or malformed values stay Pending, and an unknown field never hides a Reject.
- **Admin privileges:** `is_mintable`, `transfer_pausable`, `is_blacklisted`, `is_whitelisted`, `owner_change_balance`, `slippage_modifiable` and `personal_slippage_modifiable` are admissible only when ownership is renounced and unrecoverable: `owner_address` empty or the zero address, `hidden_owner` false and `can_take_back_ownership` false. An active capability with non-renounced ownership is Reject with reason `admin_privilege_not_renounced`. An active capability with unknown ownership, or any unknown capability flag, is Pending. An inactive capability needs no ownership condition.
- **Freshness:** the evidence TTL is configurable (`AUDIT_EVIDENCE_TTL_SECS`, default 600 seconds, must exceed twice the agent pass interval). Evidence age is measured from the older of the GoPlus query time and the oldest liquidity observation (block time). The scheduler re-audits before the approval's remaining life falls under two pass intervals, and a stale or changed result is submitted as Pending, which withdraws the on-chain approval. Recovery behaviour after a live token-policy change stays OPEN.

## Reference-token audit (testnet mock tokens)

GoPlus supports Robinhood mainnet `4663` only. The arena's test tokens are representative mock tokens whose metadata carries `reference_chain_id` (`4663`) and `reference_address` (the mainnet token the mock represents). Both the GoPlus query and the liquidity read use that **mainnet reference pair**, never the testnet mock's pools, because testnet pools do not represent the real market.

- The mapping is accepted only from the **protocol-controlled registry in the arena contract**. The protocol account (the SputnikDAO council in the target deployment, D33) adds or removes entries (`add_reference_entry`, `remove_reference_entry`, exactly one yocto); creators cannot. Each entry has a SHA-256 entry hash and every change bumps the registry version (`get_reference_registry`). Entries must reference chain `4663`, one token has at most one entry and one reference token backs at most one token. `create_lifecycle_battle` refuses a declared pair that is unregistered or differs from the entry, and a registered token without its pair. The agent reads the same registry once per pass, recomputes every entry hash and fails the pass closed on a malformed, inconsistent or concurrently changed read; a mapping that is absent from or disagrees with the registry holds Pending (`reference_unregistered`, `reference_conflict`). The former `AUDIT_REFERENCE_REGISTRY` variable is removed and startup fails if it is still set. Scoring inputs resolve the market-data token from the same registry (`agent/src/reference-registry.ts`). No entries are registered yet: the candidate mainnet tokens still need owner verification.
- The record binds both the testnet asset and the reference pair (with a digest of the registry entry), and labels the audit `reference_token`. The record, `policyHash` and `evidenceHash` all state that GoPlus and liquidity evidence are for the reference token and that the testnet mock was not itself audited (`assetItselfAudited: false`).
- **Approval attests the mainnet reference token, not the behaviour of the testnet mock contract.** The user-facing report says this in plain words.
- Unmapped tokens keep the earlier rule: evidence for any other chain or token cannot approve them.
- A change to the registry mapping changes the bound asset and invalidates the approval.

On 2026-11-06 22:50 UTC, an unauthenticated request to the Token Security v1 endpoint for chain `46630` and `0x0000000000000000000000000000000000000001` returned code `2022`, `The main chain is not supported`, and a null result. This is evidence that this request did not provide coverage, not proof about every GoPlus product, credential, future response, or token. The agent submits results to the arena through `submit_lifecycle_audit`, but nothing here establishes live GoPlus coverage or live liquidity. Unit-test responses are fixtures.

On the same date, a request for chain `4663` and the same address returned code `1` with an empty result. The endpoint accepted that chain ID but returned no token evidence, so this does not establish coverage of a particular token. The [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/) identifies `4663` as mainnet and `46630` as testnet; their responses cannot be substituted for one another.

No credential is required: the Token Security endpoint answers unauthenticated requests (HTTP 200, code 1) but is rate limited (verified again 2026-11-08: one of 26 requests returned code `4029` and was held Pending). `GOPLUS_ACCESS_TOKEN` is optional; when it is set the client sends `Authorization: Bearer <token>`, the format in the GoPlus token_security reference (https://docs.gopluslabs.io/reference/tokensecurityusingget_1). That scheme has not been exercised live with a real token. The reference also suggests unauthenticated calls return only the first address of a multi-address query; the client asks for one address per request. A rate-limited response (HTTP 429 or a provider rate-limit code) is retried with bounded backoff and, if it persists, holds the token Pending. An owner check on 2026-11-07 found that only 1 of 6 candidate Robinhood tokens returned GoPlus data on chain `4663`; tokens without coverage stay Pending, which is intended. These are reported observations, not repository tests.

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
| `transfer_tax` | Wallet-transfer tax fraction | Unknown/malformed: Pending; value 1: Reject as an untransferable token; above `0.05`: Reject (`tax_above_limit`); up to and including `0.05`: admissible |
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

- **Valuation source `headline_quote_balance`.** A pool's value is the balance of its **quote side only**, read at one block: the v2 reserve, or for v3 `balanceOf(pool)` of the quote token. The audited token's own side is never valued (it is self-referential and manipulable) and the quote side is not doubled. This is an **approximation, not executable depth**: v3 balances can include out-of-range liquidity and can be moved briefly. The label appears in the evidence, `evidenceHash`, `policyHash` and the user report.
- **Quote assets.** A quote must be an **explicitly configured stablecoin** (`AUDIT_STABLECOINS`, address to decimals, 1 unit = 1 USD; decimals are re-read on-chain and a disagreement fails the read) or the configured WETH. A token is never guessed to be a stablecoin; pools quoted in anything else are ignored.
- **WETH pricing.** WETH is priced from the `slot0` `sqrtPriceX96` of ONE configured WETH/stablecoin **Uniswap v3** pool (`AUDIT_WETH_ADDRESS`, `AUDIT_WETH_CHAIN_ID`, `AUDIT_WETH_PRICE_POOL`), read at the same block as the pool being valued, handling token0/token1 order; decimals cancel because the result stays in stablecoin raw units, rounded down. The price pool's `token0`/`token1` must be the configured WETH and a listed stablecoin on the audited chain (`price_pool_invalid` otherwise). The stable-side `balanceOf(pool)` must be at least `AUDIT_WETH_PRICE_POOL_MIN_USD` (`price_pool_floor_not_met`). Unset pool, floor or WETH config leaves WETH-quoted pools unpriced (`quote_asset_unpriced`, `price_pool_floor_unset`). **No code defaults exist.** Documented example values (in `.env.example`): v3 WETH/USDG pool `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca`, WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, floor 1,000,000 USD. These were **verified on-chain on 2026-11-08** through two independent public RPC providers at the same block: WETH has 18 decimals; USDG ("Global Dollar", 6 decimals) is an upgradeable EIP-1967 proxy, so its 1 unit = 1 USD treatment trusts its issuer; the pool's `token0`/`token1` are WETH/USDG with fee 100 and its factory's `getPool` returns it; the USDG side held about USD 2.29M (total about USD 10.5M). The reads were at recent blocks, not finalized blocks, and whether the factory is the official Uniswap deployment is not confirmed by Uniswap. Evidence: [`evidence/2026-11-08-arena-audit-verification.json`](evidence/2026-11-08-arena-audit-verification.json).
- An unpriced pool is not counted; since that can only understate liquidity, a counted total above USD 10,000 still passes, while one at or below it holds Pending (not Fail).
- Deduplicate pools by chain and address. Observation time is the block's own timestamp. The evidence TTL uses the older of the GoPlus query time and the oldest liquidity observation.
- The LP valuation must be **strictly greater than USD 10,000**. Exactly USD 10,000 or less fails the gate; missing or unreliable evidence (RPC for another chain, missing valuation source or time, conflicting duplicates) stays Pending. Do not count a token's market cap as liquidity or infer depth from a price alone.
- v2 and v3 pools are valued the same way. Tick-based executable depth is **not computed**; the minimum executable-depth policy was decided on 2026-11-09 (D32): the headline policy is kept for the hackathon, no depth value is invented, and the limit is documented.

A fixture can exercise the gate but must not be represented as market liquidity worth real dollars. All liquidity tests are fixture-only; no live mainnet coverage is claimed.

## Cron validation and pre-lock check

The auditor schedules validation after proposal and refreshes it before lock under a versioned freshness policy. Approval requires every community to pass; a newly added community or changed mapping invalidates the affected approval. Refuse lock if required evidence expired, changed or became incomplete. Freeze the policy/evidence references with the snapshot. Polling and retries are idempotent and do not alter the intended round boundaries.

The evidence TTL is configurable (default 600 s) and the audit pass runs inside the agent's regular pass, refreshing an approval before its remaining life falls under two pass intervals. The contract itself does not check approval expiry at lock; lock refusal on expiry relies on the pass withdrawing the approval (submitting Pending), and the agent does not yet drive `lock_lifecycle_battle`. The behavior after a live token-policy change remains OPEN: do not invent an hourly live check for a 30-second round or silently introduce a live refund rule. GoPlus signals are point-in-time evidence, not guarantees against later contract changes.

## Field reasons across surfaces

Every non-pass finding carries a reason `{ code, field?, message }`. The same codes and fields appear in three places for one decision: the lifecycle pass log line `audit report archived` (`reasons`: code, field, known; plus `reasonCodes`, `unknownReasonCodes`, `reasonsTruncated`), the archived report (`reasons`), and the read model used by the MCP `inspect_audit` tool, the terminal and the HTTP service (`reasonSummary` beside the full `report`). All are built by `summarizeReasons` in `agent/src/audit/reason-summary.ts`.

Known codes are `critical`, `unknown_field`, `wrong_source`, `reference_mismatch`, `reference_unregistered`, `reference_conflict`, `tax_policy_unresolved`, `tax_above_limit`, `admin_policy_unresolved`, `admin_privilege_not_renounced`, `ownership_unknown`, and the families `source_<status>` and `lp_<code>`. A code outside this set is passed through as-is with `known: false` (and `(unknown reason code)` in the text report); it is never dropped. The log carries codes and fields only, never the free-text message or provider responses, each value is cut at 96 characters and at most 32 reasons are listed (`reasonsTruncated` says when more existed). This is text and codes only and does not influence any approval decision.

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

## Committed reference pair

The reference pair is part of the community mapping committed at lifecycle creation (`reference_chain_id`, normalized lowercase `reference_address`, both or neither, no two communities sharing a pair; mapping label `asset-identity-v2`). `submit_lifecycle_audit` requires the approval's asset to equal the committed asset including the pair. The agent audits the pair read from the battle view, compares it with the protocol registry and holds Pending on any mismatch, on a committed pair absent from the registry, or when the registry maps a token that has no committed pair. The registry remains the authority for which mappings are acceptable. The borsh layout changed, so a fresh arena is required.

## Future improvements (not scheduled)

Not built and not tasks; no fallback code exists.

- **Fallback audit for tokens GoPlus does not cover.** Phase 1 is static: Sourcify v2 verified source and ABI plus on-chain reads such as owner, proxy slot and bytecode. It can only fill admin and ownership context, not tax or honeypot fields.
- **Buy/sell simulation** to measure honeypot behaviour and taxes, for example by `eth_call` with state overrides against the DEX router, is deferred. It needs an RPC that supports state overrides (not yet verified) and a decision on how simulated results map into the tax and honeypot fields.
- Until a source of tax and honeypot data exists, tokens without GoPlus data remain Pending under the existing rule that unknown mandatory fields hold Pending.

The corresponding [OpenSpec audit requirements](openspec/changes/arena-audit/specs/arena-audit/spec.md) are the acceptance criteria. DAO rules are independent of the audit (see [DAO governance](dao-governance.md)).

## Live coverage (2026-11-08)

The agent's own code (`fetchGoPlusTokenSecurity`, `createLpFetcher`, `evaluateCommunity` with `audit-policy-v1`) was run read-only for each candidate mainnet reference token, asset `4663`/token, with USDG as the listed stablecoin and the verified WETH price pool. Pools were the token's current Uniswap-style v2/v3 pools listed by DexScreener; other pool types cannot be read and are listed as unsupported. Two runs (15:29 and about 15:31 UTC) on two RPC providers gave the same outcomes; values below are from the first. Evidence: [`evidence/2026-11-08-arena-audit-verification.json`](evidence/2026-11-08-arena-audit-verification.json).

| Token | Result | Reasons (field) | Readable pools: headline USD | Unsupported pools |
| --- | --- | --- | --- | --- |
| CASHCAT | **pass** | none | 11 pools: 1,006,254 | 19 (v4 and other DEX types) |
| BTCETHUSDT | **pass** | none | 1 pool: 17,912 | 0 |
| STRATEGY | **reject** | `admin_privilege_not_renounced` (`transfer_pausable`), `lp_at_or_below_threshold` | 1 pool: 854 | 2 (v4, up to $415k on DexScreener) |
| OAK | pending | `unknown_field` (`cannot_sell_all`), `lp_at_or_below_threshold` | 2 pools: 4,843 | 13 (v4, up to $89k) |
| ROBIN | pending | `lp_at_or_below_threshold` | 1 pool: 1,088 | 0 |
| VLADIUS | pending | `lp_at_or_below_threshold` | 1 pool: 322 | 0 |
| REBATE | pending | `unknown_field` (`cannot_sell_all`), `lp_no_evidence` | none | 5 (v4, up to $48k) |
| Rabbit | pending | `unknown_field` (`cannot_sell_all`), `lp_no_evidence` | none | 1 (v4) |
| RICO | pending | `unknown_field` (`cannot_sell_all`), `lp_no_evidence` | none | none listed |
| WIF | pending | `unknown_field` (`cannot_sell_all`, `buy_tax`, `sell_tax`, `transfer_tax`), `lp_no_evidence` | none | none listed |
| HODL | pending | `unknown_field` (`cannot_sell_all`, taxes), `lp_no_evidence` | none | 1 (v4) |
| CHAD | pending | `unknown_field` (`cannot_sell_all`, taxes), `lp_no_evidence` | none | 2 (v4) |
| PENNY | pending | ten `unknown_field` entries (`is_honeypot`, `cannot_sell_all`, admin flags), `lp_no_evidence` | none | 4 (v4) |

Limitations:
- GoPlus returned a result for all 13 tokens, but `cannot_sell_all` is missing for 8 of them (REBATE, OAK, PENNY, WIF, Rabbit, RICO, HODL, CHAD). The policy holds a missing required field Pending, so REBATE, OAK, Rabbit and RICO, which the 2026-11-07 table called "GoPlus clean", cannot pass on GoPlus data alone.
- Only Uniswap-style v2/v3 pools are read. Most liquidity of REBATE, OAK, STRATEGY and PENNY sits in Uniswap v4 pools, which the fetcher cannot value (see "Uniswap v4" in the findings log).
- Reads used recent blocks of keyless public RPCs, not finalized blocks: both free tiers refuse state older than a few seconds. The block hash was cross-checked between the providers.
- Token authenticity (look-alike contracts) was not checked on 2026-11-08; the addresses are the findings-log candidates. A 2026-11-09 rerun against the live RPC, a wider candidate search and on-chain authenticity checks are in [reference-token-scan.md](reference-token-scan.md): 11 tokens pass today.
- No result was submitted on-chain; this is evidence only.

