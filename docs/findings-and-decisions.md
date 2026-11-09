# Findings and decisions log

Team log of owner decisions, research findings and the state of each work branch. Newest entries go at the top of each section. Entries are facts at the date shown; re-verify before relying on them. Nothing here is a live-integration claim: tests are fixture-based unless a row says otherwise, and the pull requests listed below were merged on 2026-11-07.

Related: [product specification](product-spec.md), [GoPlus audit policy](goplus-audit.md), [OpenSpec coordination](openspec/README.md).

## How to update this file

- Add a dated entry for every owner decision, research finding and branch change. Record the source (command, URL or commit) and what was not verified.
- When a decision changes a spec, update the affected OpenSpec change and product docs in the same pull request and list them in the entry.
- Do not turn an OPEN question into a decision without the owner's answer.

## Owner decisions (2026-11-07)

| # | Decision | Applies to | Status |
| --- | --- | --- | --- |
| D1 | Audit policy v1: buy, sell and transfer tax are each admissible up to and including 5% (above 5% rejects; exactly 100% still rejects). Privileged token administration (mint, pause, blacklist or whitelist, balance changes, tax changes) is admissible only when ownership is renounced and unrecoverable; otherwise Reject. Unknown fields stay Pending. | arena-audit | Decided; implemented (merged in #53) |
| D2 | Evidence lifetime defaults to 10 minutes, configurable, refreshed before lock. Behavior after a live token-policy change stays OPEN. | arena-audit | Decided; implemented (merged in #53) |
| D3 | Everything the audit shows a user is written down for them: per-field results, tax as percentages, each admin capability with ownership status, reasons, policy version, expiry and reference mapping. | arena-audit, later MCP/UI | Report built (merged in #53); no UI yet |
| D4 | Liquidity: independent on-chain headline value of the quote-side balance of Uniswap v2 and v3 pools, strictly above USD 10,000. A WETH quote is priced through one configured WETH/USDG pool. Minimum executable depth stays OPEN. | arena-audit | Implemented (merged in #53) |
| D5 | WETH price pool: Uniswap v3 WETH/USDG `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` with a floor of USD 1,000,000 on its stablecoin side. Address verified on-chain 2026-11-08 (token0 WETH, token1 USDG, fee 100, about USD 2.29M on the USDG side; see [goplus-audit.md](goplus-audit.md)). | arena-audit | Implemented (merged in #53) |
| D6 | GoPlus supports only Robinhood mainnet `4663` (not testnet `46630`). On testnet each mock token carries a mainnet reference token. GoPlus and liquidity are measured on the reference token, always. Approval attests the reference token, not the mock contract. Mappings come only from a protocol-controlled registry. | arena-audit, arena-lifecycle | Implemented (merged in #53) |
| D7 | The reference pair (`reference_chain_id`, `reference_address`) becomes part of the committed community mapping (`asset-identity-v2`); a later change invalidates approval. | arena-lifecycle, arena-asset-representation | Implemented (merged in #53) |
| D8 | A foreign deposit arriving after lock never enters a snapshot or vault; backing records it as unattributed and refunds the original depositor after finality. | arena-lifecycle, arena-asset-representation | Recorded in specs; refund path not implemented |
| D9 | Scoring data for mock tokens also comes from the mainnet reference token. Recorded as integration tasks, not yet specified in scoring. | arena-testnet-integrations | Recorded as tasks |
| D10 | No buy/sell simulation for now, and the whole fallback audit for tokens without GoPlus data is deferred. Tokens without GoPlus data stay Pending. | arena-audit | Deferred |
| D11 | The mock set is the tokens that have GoPlus data (see the token table below). | testnet setup | Decided; registry not built |
| D12 | `lock_lifecycle_battle` requires a non-zero attached deposit. | arena-lifecycle | Fixed (merged in #52) |
| D13 | `arena-scoring` archived (all 18 tasks complete; archived 2026-11-07). Open items remain in its notes: single trusted oracle that cannot be rotated, and provider, cadence and tolerance values. | arena-scoring | Archived (merged in #55) |
| D14 | Resume policy after an asset is suspended (deficit, reorg or unresolved reconciliation) is flexible and changeable by the owner (hackathon). Planned modes: `OwnerWithEvidence` (default: owner resumes only after an attestation shows custody covers all liabilities), `Automatic` (a later covering attestation lifts the suspension) and `Disabled`. `Automatic` trades safety for speed: a wrong or manipulated attestation could reopen payouts while a shortfall remains. | arena-asset-representation | Implemented in [#83](https://github.com/mferdinandr/valtrum/pull/83) (open) |
| D15 | A late foreign deposit is refunded to the beneficiary named in the custody deposit event (not the token sender), after finality; it never enters a snapshot or vault. Refines D8. | arena-asset-representation | Implemented in [#83](https://github.com/mferdinandr/valtrum/pull/83) (open); D15 is refined by D17 |
| D16 | The `docs/` branch prefix is allowed for documentation-only branches. | repository conventions | Merged in #56 |
| D17 | A late foreign deposit is refunded to an EVM address the depositor binds at deposit time. The deposit event currently names only a NEAR account as beneficiary, so this needs a new field in the custody contract, the verifier, the registry claim and backing, and a new mapping version. Refines D15. | arena-asset-representation | Implemented end to end (custody, verifier, registry, backing, payout) on `feat/evm-refund-address`; the beneficiary or the payout operator may start the refund, destination only the bound address (closes [#82](https://github.com/mferdinandr/valtrum/issues/82) once merged); fixtures only |
| D18 | The audit policy-hash pin checked at lock stays optional (enforced only when the owner sets it). A pass approval lasts at most 24 hours (agent choice, not in the spec) and the agent lock is opt-in (`AUDIT_LOCK_ENABLED`). | arena-audit | Implemented in [#85](https://github.com/mferdinandr/valtrum/pull/85) (open) |
| D19 | Durable audit report history (agent choices, no owner input needed): report observations are stored in one versioned JSON file keyed by a content-derived immutable `observationId` (so identical retries are idempotent, differing evaluations of the same evidence are kept, and conflicting ids are rejected not overwritten); writes are atomic and lock-guarded, corrupt/unsupported state fails loudly, limits are 64 KiB/report and 100000 observations with no prune. A read-only API keeps the immutable historical result separate from read-time freshness and never claims a current approval (`currentApproval: notEstablished`). Lifecycle sink and logs are opt-in and backward compatible; MCP/UI wiring (#70/#76/#79) and live GoPlus/LP coverage stay deferred. | arena-audit | Implemented on branch `feat/audit-report-archive` (issue [#60](https://github.com/mferdinandr/valtrum/issues/60); PR open for review) |
| D20 | Read-only arena event indexing foundation (agent choices, no owner input needed): injectable `BlockSource`, lossless u64 parsing, dedup key `network\|contract\|receiptId\|logIndex\|dataItemIndex`, a pure projection namespaced by network+contract, one atomic versioned snapshot with a single-writer lock, fork rollback only above the finalized boundary, and finality promoted only along the source-declared finalized chain. Corrupt state fails closed (never reset); a recorded source is a declared assertion, not verified finality; the indexer has no write authority. Review hardening (PR [#92](https://github.com/mferdinandr/valtrum/pull/92)): the health status is persisted so a restart never silently reports healthy; the parser authenticates the receipt executor before parsing (foreign-emitter logs are dropped without storing their raw body) and unmodelled/unsupported events from an allowlisted emitter degrade status; a block the source marks incomplete is never applied; only attention-worthy quarantine (conflicts and allowlisted-emitter integrity/coverage gaps) is persisted and bounded, while benign foreign/failed logs are counted, not stored, so an untrusted flood can neither poison health nor evict a conflict, and commit never wedges; and the CLI exits non-zero when degraded or reconciliation-required. Live NEAR/EVM adapters, custody/payout suspension on reorg, and UI/alerts stay deferred. (D19 is reserved for the audit report archive PR #60.) | arena-testnet-integrations | Implemented on branch `feat/arena-event-indexer` (issue [#59](https://github.com/mferdinandr/valtrum/issues/59); PR open for review) |
| D21 | (Owner, 2026-11-08, issue [#69](https://github.com/mferdinandr/valtrum/issues/69)) The reference-token registry lives on-chain in the arena contract: owner-only `add_reference_entry`/`remove_reference_entry` (one yocto), per-entry SHA-256 hash and a version bumped on every change; battle creation refuses unregistered or differing pairs. `AUDIT_REFERENCE_REGISTRY` is removed and startup fails if it is set. Agent choices: one entry per token, one token per reference token, change = remove then add; audit and scoring read one per-pass snapshot. Refines D6. | arena-testnet-integrations, arena-audit | Merged in [#97](https://github.com/mferdinandr/valtrum/pull/97); no entries registered (candidate tokens still unverified); fixtures only |
| D22 | (Owner, 2026-11-08, issue [#74](https://github.com/mferdinandr/valtrum/issues/74)) DAO governance of winning principal: the final winning community's participants vote burn or return, weighted by their escrowed principal; pro-rata split of votes cast applied to the whole escrow; no quorum; no delegation in v1; window opens when the final winner is recorded, length protocol-adjustable; no votes means principal stays escrowed; the arena contract tallies, anyone triggers execution; burn = verified transfer to a Robinhood sink address. SputnikDAO/Trezu not used. Design choices for review: window snapshotted per battle, votes final once cast, rounding toward return. (D21 is the reference registry, merged in PR #97.) | arena-dao-escrow | Design in [dao-governance.md](dao-governance.md); not implemented (#75) |
| D23 | Bounded player grants and atomic budget reservations (agent choices, no owner input needed): a new `contracts/player-policy` crate (`valtrum-player-policy`), pure core + persistent wrapper. Grants are user-authenticated (caller, not a JSON field), bind an immutable asset identity (never a ticker), bounded scope, `U128` per-action and cumulative caps, a declared `U64` gas bound and chain-time expiry; `GrantId = sha256(user, local_id)`, idempotency `request_key = sha256(user, local_id, request_id)` with an `action_hash` over every security field. Budgets keep the invariant `consumed + reserved <= limit`; a version bump preserves counters (no cap evasion). Reserve is one atomic transition; only the delegate or user may reserve; outcome transitions (dispatch/consume/release/reconcile) are fixture-only (`sandbox-fixtures`) and absent from the normal build, so there is no fabricated confirmation/unlock. Signed/MPC execution, deposit/position binding and MCP integration stay deferred. (D19 reserved for audit archive #60, D20 for the event indexer #59.) | arena-player-agents | Merged in [#93](https://github.com/mferdinandr/valtrum/pull/93) (issue [#58](https://github.com/mferdinandr/valtrum/issues/58)) |
| D24 | (Owner, 2026-11-08, issue [#75](https://github.com/mferdinandr/valtrum/issues/75)) DAO execution: the vote window is 1 minute to 30 days, set by the protocol account and snapshotted per battle (none set = no vote, principal stays escrowed); the burn sink is set once per token by the backing owner and can never change; a burn whose transfer provably did not happen stays reserved and is retried, never released. Agent choices: votes are final, participants are ordered by first credited deposit, per-holder `floor` rounding favours return, execution is permissionless and batched (at most 10 releases), and `request_dao_burn` is permissionless with the request deposit (operator: one yocto). | arena-dao-escrow | Merged in [#102](https://github.com/mferdinandr/valtrum/pull/102); fixtures only, no live burn |
| D25 | (Owner, 2026-11-09, issue [#76](https://github.com/mferdinandr/valtrum/issues/76)) MCP and terminal actions: only the user's wallet signs and sends (the action service never holds a key); a preview is authorized by a NEP-413 signature over its hash from a full-access key of the funds' account, or by an active player-policy grant whose delegate then signs only the contract's `reserve`; previews expire after 5 minutes and previews plus action statuses persist in one versioned JSON file. Agent choices: policy `action-preview-v1`; only `direct` deposits; grant-based payouts refused until the grant can name the backing's asset; create-battle attaches an upper-bound storage deposit (0.1 NEAR, unused refunded). | arena-mcp-terminal | Merged in [#103](https://github.com/mferdinandr/valtrum/pull/103); fixtures only |
| D26 | Player-agent proposals (agent choices within D25, issue [#77](https://github.com/mferdinandr/valtrum/issues/77)): agents may only propose deposits; a proposal is exactly one JSON object with `action`, `user`, `battleId`, `community`, `amount` and an ignored `rationale`, and any other field rejects it; which grants a delegate may use comes only from operator configuration (`PLAYER_AGENT_GRANTS`); revocation rejects unprepared actions and keeps prepared or reserved ones attributable. | arena-player-agents | Merged in [#104](https://github.com/mferdinandr/valtrum/pull/104); fixtures only, no model call |
| D27 | Account state and recovery alerts (agent choices, issue [#79](https://github.com/mferdinandr/valtrum/issues/79)): entitlements, transfers and DAO principal are three separate lists with source and observation time; alerts are recomputed per read (no stored alerts), with thresholds of 5 minutes past a round's end for missing market data and 10 minutes without an indexer commit for staleness; indexer health is read from its `state.json`, whose modification time is the last sync, and missing or unreadable state counts as degraded. | arena-testnet-integrations | Merged in [#105](https://github.com/mferdinandr/valtrum/pull/105); fixtures only |
| D28 | (Owner, 2026-11-09, issue [#113](https://github.com/mferdinandr/valtrum/issues/113)) DAO and the NEAR ecosystem: the winners' burn or return vote stays in the arena contract exactly as in D22 (no external DAO can change or veto that tally). A SputnikDAO created through `sputnikv2.testnet` becomes the owner of protocol-level authority and the recipient of the protocol fee, so privileged protocol changes and the protocol treasury go through DAO proposals. Automated roles (payout operator, relayer, agent, scheduler) are not handed to the DAO. Trezu is used only as an interface to the same DAO if it supports testnet; this is unverified. Chosen over one SputnikDAO per winning community, which would reverse D22 and was judged too risky for the 2026-11-14 deadline. Membership (owner, 2026-11-09): the DAO starts with 2 to 3 team accounts and a simple-majority threshold, and new members join through DAO proposals; fully open membership is rejected for now (many-account takeover of protocol parameters and fee) and a participants-weighted DAO needs an unproven weight adapter, so both are future work. The DAO holds only protocol-level roles and the protocol fee recipient, not automated roles, and the deploy (upgrade) key stays with the owner account during the hackathon. The owner has not yet provided the member accounts or funding. | arena-dao-escrow | Planned; amends the "SputnikDAO/Trezu not used" line of D22 |
| D29 | (Owner, 2026-11-09, issue [#114](https://github.com/mferdinandr/valtrum/issues/114)) NEAR Intents on testnet: 1Click lists no testnet asset and the hackathon handbook says none exists or is planned (it recommends mainnet with tiny amounts and `dry: true` quotes). The testnet demo uses a labelled fixture of the 1Click API with a fake solver, pinned by golden and drift tests to the recorded mainnet responses; the arena accepts an `intents-fixture` route only on testnet and keeps refusing every other route. The real Intents route stays an integration gap; the fixture never counts as a verified integration. | arena-testnet-integrations | Implemented on branch `feat/intents-fixture` (PR pending review); fixture evidence only ([intents-evidence.md](intents-evidence.md) section 5, [intents-asset-mapping.md](intents-asset-mapping.md), [fixture trace](evidence/2026-11-09-intents-fixture-trace.json)); live trace open (needs #72); the real route gap stays |
| D30 | (Owner, 2026-11-09, issue [#108](https://github.com/mferdinandr/valtrum/issues/108); answers the #93 review) Player grants: the user or the delegate may cancel a reservation that has not been dispatched and reservations expire automatically (length is a configurable agent default); a dispatched obligation is never released by timeout or revocation alone; a delegate must be an account other than the user; revocation is permanent per grant id and a version bump never re-enables it; asset identity stays immutable per grant. | arena-player-agents | Implemented on `feat/player-grant-enforcement` (#108): cancel, lazy expiry (default TTL 1 hour, owner-set 1 minute to 7 days, agent choice), delegate rule, permanent revocation; fixtures only. Open: maximum grant lifetime and deposit-backed caps |
| D31 | (Owner, 2026-11-09, issue [#109](https://github.com/mferdinandr/valtrum/issues/109); answers the #92 review) Indexer retention: finalized blocks older than a configurable depth are summarized into a hashed, labelled checkpoint and pruned so storage never wedges; restart verifies from the checkpoint; provisional blocks and the deduplication keys that prevent duplicate allocation or payment are never pruned. Agent choices: default depth 10,000 finalized blocks (`INDEXER_RETENTION_DEPTH`, minimum 1); the journal is retained in full, so only blocks stop growing and `MAX_JOURNAL` still bounds events; pruning stops below any block with conflict or integrity evidence; a reorg suspends indexer confirmations until finality reaches the highest retracted height; the indexer and the audit report archive are wired into `main.ts` behind off-by-default flags (the indexer only over a recorded chain file, as no live source exists). Open for the owner: the audit report archive still has no retention (`MAX_OBSERVATIONS` 100,000), not decided here. | arena-testnet-integrations | Implemented on `feat/indexer-restart-reorg`; fixture tests only |
| D32 | (Owner, 2026-11-09, issue [#112](https://github.com/mferdinandr/valtrum/issues/112)) Concentrated-liquidity depth for the LP threshold: keep the current policy for the hackathon (headline quote-balance value, no pool aggregation, no Uniswap v4 reading). Known limit: a concentrated pool can look deeper than what is executable near the current price. | arena-audit | Decided; no code change |

Review correction (2026-11-08, PR #87): writer locks now fail closed regardless of age; explicit abandoned-lock recovery requires all writers stopped first. HTTP and CLI text preserve the same fixture provenance, observation attribution and historical/freshness/current-approval limitations as JSON. Same-evidence time-only retries remain idempotent, while fresh provider timestamps/LP observations intentionally create new evidence history and consume the documented finite capacity; no provider cadence, audit policy or submission behavior is changed. The owning design/spec and [implementation notes](openspec/changes/arena-audit/implementation-notes.md) distinguish those cases and document recovery/capacity limits. New source regressions are added; validation results must be recorded after execution, and no live-provider evidence is claimed.

Work in progress (not yet pushed): `feat/backing-reconciliation` (asset-representation tasks: reconciliation, suspend and resume policy, late-deposit refund) and `feat/payout-mpc-signing` (chain-signatures tasks: MPC signer call from the payout contract, restart reconciliation, explicit payout states). `arena-settlement` follows once the payout status interface exists.

## Player-policy PR review corrections (2026-11-08)

PR [#93](https://github.com/mferdinandr/valtrum/pull/93), issue [#58](https://github.com/mferdinandr/valtrum/issues/58): source review identified cross-version asset changes sharing one budget, cap reductions below existing obligations, stale queued reservations admitted through a replacement grant, and non-array event data. The correction keeps the asset immutable, rejects invalid cap replacement before state changes, checks the queued reservation's current version at first dispatch, and preserves reconciliation for already-dispatched obligations. Events now use NEP-297 data arrays; canonical JSON inputs reject unknown fields. Regression tests cover these boundaries, including sandbox rollback; validation results belong to the PR. No live execution, deployment or new economic policy is introduced.

## Research findings (2026-11-07)

### GoPlus coverage on Robinhood mainnet 4663

Method: tokens found through DexScreener (224 from keyword searches plus 24 from quote-asset pool lists), then each checked against GoPlus Token Security without credentials. 13 of roughly 250 tokens had GoPlus data (about 5%). The candidate set is not exhaustive: DexScreener endpoints return at most 30 pools per query. Liquidity and pool types come from DexScreener and were not verified on-chain. Authenticity was not verified: many names have look-alike tokens at other addresses, so check each token on the official explorer before it enters the registry.

"Expected result" is our reading of audit policy v1 and the 10,000 USD liquidity rule, not the output of the audit code. It is superseded by the live run of the audit code on 2026-11-08 ([goplus-audit.md, "Live coverage"](goplus-audit.md#live-coverage-2026-11-08)): CASHCAT and BTCETHUSDT pass, STRATEGY rejects, and REBATE, OAK, Rabbit and RICO stay Pending because GoPlus omits `cannot_sell_all`.

| Token | Mainnet 4663 address | Liquidity | Pool | Expected result |
| --- | --- | --- | --- | --- |
| CASHCAT | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | $1.86M | WETH, v3 | Can pass: clean flags, zero tax, owner empty |
| BTCETHUSDT | `0xAE2Df3c1749daEE721c1BFcbbFDde5D61ae7cb99` | $38.6k | WETH, v3 | Can pass: clean flags, owner empty (name looks like a joke token) |
| REBATE | `0xb7Ff57631B97000d950236ef63bD463da5bEBA7e` | $49.6k | USDG, v4 | GoPlus clean; liquidity check blocked (v4 not readable) |
| OAK | `0x6511c233790Ec10f7d673c64DC82C3F941D57828` | $80.3k | native ETH, v4 | GoPlus clean; liquidity check blocked (v4, native ETH) |
| STRATEGY | `0x168661C52E5922288dFb2b3f323b6Cf90eb21e18` | $419.8k | MSTR, v4 | Reject: transfers pausable and owner active |
| PENNY | `0x4124277673E3ecaaF4AaDc5C6169cf1D7812d647` | $138.5k | DJT, v4 | Pending: honeypot, mint and pause unknown; source not verified |
| WIF | `0x96c5d997A462Bce2577bEE9527A1A08101927519` | $37.1k | native ETH, v4 | Pending: tax fields empty |
| Rabbit | `0xCD1cca2B3d0A11b295c42fe765ea8f895c2D0901` | $6.3k | WYFI, v4 | GoPlus clean; liquidity below $10,000 |
| ROBIN | `0x4c92177Dc03430058929f1E115E0d51a3D1d62bA` | $5.2k | WETH, v3 | GoPlus clean; liquidity below $10,000 |
| RICO | `0x36F205a6F54468FC65257eAC0D8FED8DbB486435` | $4.2k | TTWO, v4 | GoPlus clean; liquidity below $10,000 |
| VLADIUS | `0x2e6ab6302E1903AF8601Fe03B7A7982545883A02` | $3.7k | WETH, v3 | GoPlus clean; liquidity below $10,000 |
| HODL | `0xc943274a0FE0A19e8678bc2f4a61A9a6d107c026` | $3.4k | WETH, v4 | Pending: tax fields empty |
| CHAD (Boomer Son) | `0x025Be9469fB7D8c22cE5404F77302611feE74e67` | $2.0k | BOOMER, v4 | Pending: tax fields empty; owner active |

Consequences:
- With the planned v2 and v3 liquidity reading, only CASHCAT and BTCETHUSDT can currently pass (two communities, the minimum for a battle).
- 8 of 13 pools are Uniswap v4, and several quote tokens other than WETH or USDG. Reading v4 liquidity is a separate piece of work (see "Uniswap v4" below).
- Tokens with empty tax fields cannot pass until a tax or honeypot data source exists (buy/sell simulation is deferred, D10).
- Lowering the liquidity threshold for testnet would add only ROBIN and VLADIUS (thin pools) and departs from the product rule; not adopted.

### Other sources checked

| Source | Result |
| --- | --- |
| GoPlus Token Security without credentials | HTTP 200, code 1 for chains 1 and 4663. Chain `46630` returned code 2022 "main chain is not supported" on 2026-11-06 (see [GoPlus audit policy](goplus-audit.md)). The `Authorization` header scheme used when a token is set is an assumption. |
| Honeypot.is | "Invalid chain" for 4663; not usable. |
| Sourcify | Lists Robinhood Chain 4663 and testnet 46630 as supported. Verified source for 2 of 4 tokens tested (CASHCAT and HOOD `0x32aC8C1D7672667D5EbdEa22935F7B06fC8D496f`). Only useful for static admin and ownership checks. |
| Dedaub honeypot checker, Blockaid, Hood Trade, a Robinhood Chain MCP server | Appear in search results as supporting 4663. API access, terms and provenance were not verified. Do not depend on them. |
| Blockscout API | Blocked by a Cloudflare challenge when called from the command line. |
| GeckoTerminal API | Network id `robinhood` exists; repeated calls returned HTTP 429. |
| Quote assets (DexScreener, unverified) | WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`; USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. The deepest WETH/USDG pool is the v3 pool in D5 (about $10.0M liquidity, about $79M 24-hour volume); the only v2 WETH/USDG pool is about $386k with about $13k volume. |

### Uniswap v4 on Robinhood Chain (research in progress)

Third-party sources only; not checked against an official Uniswap or Robinhood page:
- PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951` appears in two sources ([jumpboxtech/rhcswap](https://github.com/jumpboxtech/rhcswap), [Dwellir blog](https://www.dwellir.com/blog/robinhood-chain-defi-data)).
- StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` and Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` appear in one source only.
- The same repository warns that Robinhood Chain ships a modified UniversalRouter and that look-alike router addresses exist.
- v4 pools share one PoolManager, so a pool's liquidity cannot be read with `balanceOf` on a pool address; it needs StateView reads and tick math. Feasibility is unconfirmed.

## Research findings (2026-11-08): scoring market data

Full record: [scoring-market-data.md](scoring-market-data.md) (issue [#68](https://github.com/mferdinandr/valtrum/issues/68)); request log in [evidence/2026-11-08-scoring-market-data.json](evidence/2026-11-08-scoring-market-data.json). Aggregator responses only, not on-chain verified.

- `docs.robinhood.com`, `rpc.chain.robinhood.com`, `rpc.testnet.chain.robinhood.com` and `explorer.chain.robinhood.com` serve a TLS certificate that expired on 2026-08-19; nothing was read from them (TLS not bypassed). Chain stack, `finalized`/`safe` heads and reorg rules remain unverified.
- Derived from aggregator trades: about 0.107 s per block (about 280 blocks per 30-second round) with 1-second timestamps.
- No compliant circulating-supply source exists for any candidate: CoinGecko lists only CASHCAT and REBATE (circulating = total), and DexScreener `marketCap` equals `fdv` for 10 of 11. Market Cap % Growth and Volume-to-Market Cap Ratio cannot be resolved for them today.
- DexScreener's shortest volume window is 5 minutes (rolling); GeckoTerminal trades lag about 10 minutes, return the latest 300 per pool and use whole-second timestamps; second-level candles are paid-only (401). Aggregators alone cannot meet the frozen 30-second policy.
- Outside CASHCAT (43%), at most about 16% of 30-second windows contain a trade, so illiquid pairs tie at zero and repeat without a cap.
- WIF and RICO had no pools on 2026-11-08 (they had pools on 2026-11-07). The two aggregators rank CASHCAT's top pool differently.
- Options for provider, cadence, boundary and anti-manipulation limits are listed in the record; none is adopted (owner decision).

## Research findings (2026-11-08): arena-audit verification

Issue [#71](https://github.com/mferdinandr/valtrum/issues/71); evidence in [evidence/2026-11-08-arena-audit-verification.json](evidence/2026-11-08-arena-audit-verification.json).

- Two keyless public RPC providers for `4663` (PublicNode, dRPC, from the chainlist registry) returned chain id `4663` and identical block hashes and state. Blocks carry `l1BlockNumber` (an Arbitrum Nitro-style chain); `finalized` trailed `latest` by about 8,200 blocks (about 14 minutes). Both free tiers refuse state older than a few seconds.
- WETH, USDG and the WETH/USDG v3 price pool are verified on-chain (D5). USDG is an upgradeable EIP-1967 proxy.
- The GoPlus reference documents `Authorization: Bearer <token>`; the client now sends that format. Unauthenticated access works and is rate limited (code `4029` observed).
- The agent's audit code run live: CASHCAT and BTCETHUSDT pass, STRATEGY rejects, ten tokens stay Pending (GoPlus omits `cannot_sell_all` for 8 tokens, v4-only liquidity, or liquidity at or below USD 10,000).

## Research findings (2026-11-08): testnet identity

Issue [#72](https://github.com/mferdinandr/valtrum/issues/72); record in [testnet-evidence.md](testnet-evidence.md).

- **NEAR testnet:** two providers agree on `chain_id` testnet and genesis hash `FWJ9kR6K…uc6b`.
- **Robinhood testnet:** two providers agree on chain id 46630 and a block hash. It has a `finalized` head (about 7,300 blocks behind the latest) and an `l1BlockNumber` (an Arbitrum Nitro-style L2 on Sepolia).
- **Robinhood's own RPCs:** the testnet RPC fails TLS, and the mainnet hosts serve an expired certificate.
- **Deployment:** the only testnet deployment (`8875bb`) is the legacy arena (`get_lifecycle_battle_count` returns MethodNotFound). The target contracts, the MPC signer, the derived custody address and gas are not deployed, so signer and receipt evidence cannot be recorded yet.

## Status note (2026-11-09): Robinhood testnet deployment and deposit

Issue [#72](https://github.com/mferdinandr/valtrum/issues/72), EVM half; record in [testnet-evidence.md](testnet-evidence.md) section 3b and [evidence/2026-11-09-evm-testnet-deploy.json](evidence/2026-11-09-evm-testnet-deploy.json). Fixtures except the network observations.

- **Done:** `TestnetDepositCustody` and six mock tokens (`mCASHCAT`, `mWALLET`, `mGOOD`, `mAI`, `mVLAD`, `mDEGEN`) deployed on 46630 with the owner-authorised deployer (custody `0xb994DCAb…7798`); code hashes match the local build; one real deposit (mapping version 3) was verified by the custody verifier after the node's `finalized` tag covered it. Total gas 0.0000357 ETH.
- **Official RPC:** `rpc.testnet.chain.robinhood.com` has valid TLS now (it failed on 2026-11-08), but its historical state is pruned inconsistently behind a load balancer.
- **Finality:** the `finalized` tag lags latest by about 7,300 to 8,500 blocks (about 18 minutes) and moves in jumps. The verifier's ancestry walk (default depth 256, one call per block) stays `pending` unless given `--max-depth`, and then took 382 to 3,522 seconds. The finality-check policy for a 30-second product is an open design question for the owner; the verifier was not weakened here.
- **D17:** the deposit needs a mapping version that invalidates receipts of the old event layout. Version 3 is a fixture value from the verifier tests; the committed value is still undecided.
- **Not verified:** source verification on the explorer (its verifier lists no compilers), a live reorg, the payout signer and every NEAR contract. Mock-to-reference mapping for the registry (D21) is proposed in the evidence file, not registered.

## Research findings (2026-11-08): Intents and Bitte

Issue [#78](https://github.com/mferdinandr/valtrum/issues/78); record in [intents-evidence.md](intents-evidence.md).

- **Robinhood mainnet:** 1Click lists it as blockchain `hood` with USDG, WETH, ETH, CASHCAT, USDe and PONS. USDG and WETH are the audit's verified addresses, and CASHCAT is a candidate reference token. Dry quotes from NEAR USDC to CASHCAT, USDG and ETH succeed (about 20 seconds estimated).
- **Testnet:** 1Click lists no testnet asset, so an Intents route for testnet funding is an integration gap. `0x…dEaD` is refused as a recipient.
- **Bitte:** no account or agent exists; orchestration and the binding of action, route and custody receipt are not verified.

## Fixture evidence (2026-11-09): Intents testnet fixture

Issue [#114](https://github.com/mferdinandr/valtrum/issues/114), D29; record in [intents-evidence.md](intents-evidence.md) section 5 and [intents-asset-mapping.md](intents-asset-mapping.md).

- **Fixture, not integration:** the `intents-fixture` route and the local 1Click fixture simulate funding on testnet. Golden and drift tests pin discovery and dry quotes to the recorded mainnet responses; the fixture trace binds action, preview, authorization, route status and custody receipt. All of it is fixture evidence.
- **Not verified:** any real solver, route, funding or refund behaviour; the live end-to-end trace (needs #72). The OpenAPI was read for field names; the recording is a summary, so some formats are checked only against the OpenAPI list.

## Work branches

All merged on 2026-11-07 with merge commits, in the order #52, #53, #54, #55, #56. #53 needed a documentation conflict fixed in `arena-lifecycle/implementation-notes.md`, and its first CI run failed because #52 and #53 each added a field to a struct that the other's new tests construct (no textual conflict); fixed in `e1d1a36`. Lesson: re-run CI after merging `main` into a branch, even when git reports no conflicts. Commits carry no AI attribution.

| PR | Branch |
| --- | --- |
| [#52](https://github.com/mferdinandr/valtrum/pull/52) | `feat/arena-lifecycle-unblocked` |
| [#53](https://github.com/mferdinandr/valtrum/pull/53) | `feat/arena-audit` |
| [#54](https://github.com/mferdinandr/valtrum/pull/54) | `chore/openspec-followups` |
| [#55](https://github.com/mferdinandr/valtrum/pull/55) | `chore/archive-arena-scoring` |
| [#56](https://github.com/mferdinandr/valtrum/pull/56) | `docs/branch-prefix-rule` (allows the `docs/` branch prefix in `Code/CLAUDE.md`) |
| [#83](https://github.com/mferdinandr/valtrum/pull/83) | `feat/backing-reconciliation` (issue #61, open) |
| [#84](https://github.com/mferdinandr/valtrum/pull/84) | `feat/payout-mpc-signing` (issue #62, open) |
| [#85](https://github.com/mferdinandr/valtrum/pull/85) | `feat/lock-audit-expiry` (issue #63, open) |

| Branch | Content | Verification so far |
| --- | --- | --- |
| `feat/lifecycle-integration` (issue #66, not pushed) | Agent-only `refresh_lifecycle_backing` reads the representation's `get_asset` and `get_ledger` and stores a 10-minute backing approval, with an owner trust list of representations; lock re-verifies backing asset and expiry; sandbox tests run the real arena with real backing, registry, audit entry point and scoring for two and three communities, protocol-created battles, mismatched, untrusted and suspended backing, duplicate lock, post-lock audit updates, late representation transfers and late foreign arrivals (refund reserved by the payout authority). All six `arena-lifecycle` tasks checked. Decisions for the owner: the trust list and the 10-minute backing lifetime (agent choices). | `cargo test -p valtrum-arena`, `cargo test -p valtrum-integration` (see PR). Fixtures only: registry claims, custody attestations, audit hashes and observations are stand-ins; no live evidence. D17 (#82) still changes the refund destination. |
| `feat/arena-lifecycle-unblocked` (10 commits on `main`) | Freeze of creator participation in the snapshot; tests for freeze, closed deposits during rounds, held winning principal, creation and lock requirements; late foreign deposit decision recorded; lock requires a non-zero deposit. Lifecycle tasks that need audit, backing or scoring integration stay unchecked. | `cargo test -p valtrum-arena`: 331 passed (re-run by the coordinator); clippy `-D warnings` and fmt clean per agent report |
| `feat/arena-audit` (23 commits on `main`) | Authenticated `submit_lifecycle_audit`; GoPlus normalization and decision precedence; audit policy v1; reference-token binding through a protocol registry; optional reference pair committed on-chain in the community asset identity (`asset-identity-v2`, both-or-neither, duplicates rejected); headline quote-balance liquidity valuation for v2 and v3 pools pinned to one block; WETH priced through a configured v3 pool with a floor and no code defaults; structured audit report; scheduled refresh with configurable lifetime; optional GoPlus credential with rate-limit handling; notes on unscheduled fallback ideas. Not done: tick-based depth, v4 and native-ETH pools, on-chain verification of the example addresses, lock refusal on expiry, live coverage. | Agent report: `pnpm -C agent test` 336 passed, `cargo test` 536 passed, clippy and fmt clean. Coordinator re-run: `pnpm -C agent test` 336 passed (34 files); `cargo test -p valtrum-arena` 332 passed. The full contract workspace (536) was not re-run. Fixtures only; no live GoPlus, mainnet RPC or testnet coverage is claimed. |
| `chore/openspec-followups` | Tasks and spec text for the late-deposit refund (asset representation), the missing MPC signer call (chain signatures) and the mainnet reference registry (testnet integrations); this log; updates to docs that listed decided items as OPEN; shortened long requirements in the settlement spec. | `openspec validate --all --strict` (see below) |
| `chore/archive-arena-scoring` | Archive of `arena-scoring` and creation of its main spec; fixed two links and the placeholder Purpose. | 317 arena tests passed on `main`-equivalent code before the archive |

OpenSpec validation on `main` after all merges: 10 passed, 0 failed (`--strict`). Baseline command: run `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`. Before the settlement fix, `arena-audit` and `arena-settlement` failed only on warnings that a requirement text exceeds 500 characters.

## Handoff: payout cluster (2026-11-07)

Update: the priority-1 issues were completed after this handoff and are open as pull requests: #61 in [#83](https://github.com/mferdinandr/valtrum/pull/83) (two of three tasks; the late-deposit refund waits for #82), #62 in [#84](https://github.com/mferdinandr/valtrum/pull/84) and #63 in [#85](https://github.com/mferdinandr/valtrum/pull/85). They are verified with fixtures and the `mock-mpc` signer only: the payout path still must not be deployed or funded. The snapshot description below is kept for history.

Work was stopped before it finished so the team can continue. Both branches below exist **only as local commits** in git worktrees on the maintainer's machine until someone pushes them: `git push -u origin feat/backing-reconciliation feat/payout-mpc-signing`. Their only commit is a snapshot ("save unfinished work for handoff"): it was **not built or tested**, and it may not compile. Treat it as a starting point, not as reviewed work. Worktree paths: `Code/.claude/worktrees/agent-a45a83ebf66dfe05c` (backing) and `Code/.claude/worktrees/agent-aec594fdf3cf7c496` (payout).

Goal: finish the open tasks of `arena-asset-representation` (3), `arena-chain-signatures` (3) and `arena-settlement` (2), then archive each only when all its tasks are verified. Current counts on `main`: 17/20, 12/15 and 14/16.

| Branch | Snapshot contents | Tasks to finish |
| --- | --- | --- |
| `feat/backing-reconciliation` (13 files, +2082/-142) | New `contracts/backing/src/suspension.rs`, a `contracts/mock-lifecycle` crate, `integration/tests/backing_reconciliation.rs`, edits to backing `lib.rs`, `normalization.rs`, `reservation.rs` and several integration tests | (1) reconcile finalized payment or disposal evidence before consuming backing, restore only after a definitive no-spend proof; (2) suspend minting and payouts on deficit, reorg or unresolved reconciliation, with the resume policy of D14; (3) record a late foreign deposit as unattributed and refund the beneficiary named in the deposit event after finality (D15) |
| `feat/payout-mpc-signing` (4 files, +1533/-310) | New `contracts/payout/src/evm.rs` (on-chain EVM transaction building), edits to payout `contract.rs`, `lib.rs` and `integration/tests/payout.rs` | (1) the payout contract calls the NEAR MPC signer itself and accepts only the signer callback's signature; (2) restart reconciliation worker in `agent/` that never creates a new spend before reconciling; (3) explicit payout states (signer response, broadcast, pending finality, revert, reconciliation required, confirmed) as a documented, stable view |
| not started: `arena-settlement` | None | Expose available, reserved, broadcast, confirmation-pending and confirmed amounts per token from the payout status view (needs the payout branch first); test independent per-token payout progress and lost-response retry |

Rules the work must keep (from `Code/CLAUDE.md` and the decisions above):
- Rust contract code: no `unwrap()`, checked math only, fail closed, privileged methods need exactly one yocto and a restricted caller. Run `near-smart-contracts` guidance before writing contract code and a `near-contract-audit` review before opening a PR.
- Do not edit `contracts/payout` from the backing branch or `contracts/backing` from the payout branch except for a minimal, documented interface change. Decide a merge order before opening PRs (backing first is natural; settlement last).
- D14: resume policy is a stored enum (`OwnerWithEvidence` default, `Automatic`, `Disabled`), owner-only to change with one yocto, every change emits an event. D15: refund goes to the beneficiary in the deposit event.
- The MPC signer interface (request shape, key version, derivation path, attached deposit, testnet signer account) must come from the official NEAR Chain Signatures documentation; the sandbox only has `contracts/mock-mpc`, so every test of signing is a fixture and not live evidence.
- Nonce gaps (a released or foreign-consumed nonce blocks later transactions) are an operational procedure to document, not a protocol rule to invent. Operator and relayer rotation is out of scope.
- Keep OpenSpec in step with the code: update each change's design, spec scenarios, notes and security review; keep each requirement under 500 characters (strict validation warns otherwise); run `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`. Check a task only after a passing test verifies it.
- One feature, one branch, one PR. Small commits in English (`feat|fix|test|docs: ...`), no AI attribution. Re-run CI after merging `main` into a branch even if git shows no conflicts (see the #52/#53 lesson above).

Known risk until this work is done: the payout contract does not call the MPC signer, so the payout path must not be deployed or funded.

## Issue index (2026-11-07)

Every unchecked OpenSpec task has an owner issue. Issues [#58](https://github.com/mferdinandr/valtrum/issues/58), [#59](https://github.com/mferdinandr/valtrum/issues/59) and [#60](https://github.com/mferdinandr/valtrum/issues/60) (assigned before this index) cover the player-grant foundation, the event indexer and the durable audit report archive. The issues below cover the rest and are labeled `priority-1` to `priority-4` (1: start now because it blocks other work or touches shared files; 4: can wait) and `blocked` when they wait on another issue, PR or decision. The only unchecked task without an issue is the `arena-audit` minimum executable-depth policy, which is an OPEN owner decision.

Known file overlaps between issues, noted as comments on them: #63 and #60 both change `agent/src/audit/lifecycle-pass.ts`; #61, #62 and #58 all touch `contracts/Cargo.toml`, `Cargo.lock` and the integration helpers; new contract events from #61, #62 and #63 need follow-up parsing in the #59 indexer; several issues edit the same `tasks.md` files.

| Priority | Issue | Title | OpenSpec tasks |
| --- | --- | --- | --- |
| P1 | [#61](https://github.com/mferdinandr/valtrum/issues/61) | backing reconciliation, suspension and late-deposit refund | asset-representation (3) |
| P1 | [#62](https://github.com/mferdinandr/valtrum/issues/62) | payout contract calls the MPC signer; explicit payout states | chain-signatures (2) |
| P1 | [#63](https://github.com/mferdinandr/valtrum/issues/63) | refuse lock on expired or changed audit evidence end to end | audit (1) |
| P2 | [#64](https://github.com/mferdinandr/valtrum/issues/64) | reconcile pending payouts after a worker restart | chain-signatures (1); implemented on `feat/restart-reconciliation` with fixtures only (agent worker `agent/src/payout-reconciler.ts`; the agent account is assumed to be the payout relayer; owner decision: the worker never holds the operator key and reports `needs_operator` proofs in the log instead) |
| P2 | [#65](https://github.com/mferdinandr/valtrum/issues/65) | payout and entitlement states per token in settlement | settlement (2) |
| P2 | [#66](https://github.com/mferdinandr/valtrum/issues/66) | connect audit and backing approvals to lifecycle; finish lifecycle verification | lifecycle (6) |
| P3 | [#67](https://github.com/mferdinandr/valtrum/issues/67) | refuse signing and receipts on RPC chain id mismatch | testnet-integrations (1) |
| P3 | [#68](https://github.com/mferdinandr/valtrum/issues/68) | verify market data sources for reference tokens (scoring inputs) | testnet-integrations (1) |
| P3 | [#69](https://github.com/mferdinandr/valtrum/issues/69) | protocol-controlled reference-token registry for audit and scoring | testnet-integrations (1) |
| P3 | [#70](https://github.com/mferdinandr/valtrum/issues/70) | MCP and terminal read-only tools with backend search | mcp-terminal (5) |
| P3 | [#71](https://github.com/mferdinandr/valtrum/issues/71) | close the remaining arena-audit verification tasks | audit (3), testnet-integrations (1) |
| P3 | [#72](https://github.com/mferdinandr/valtrum/issues/72) | verify chain identities, signer setup and recorded receipts on testnet | testnet-integrations (4) |
| P4 | [#73](https://github.com/mferdinandr/valtrum/issues/73) | verify principal escrow without a governance decision | dao-escrow (4) |
| P4 | [#74](https://github.com/mferdinandr/valtrum/issues/74) | decide the DAO governance and disposition design (owner) | dao-escrow (3) |
| P4 | [#75](https://github.com/mferdinandr/valtrum/issues/75) | execute approved DAO decisions and verify source-chain disposition | dao-escrow (6) |
| P4 | [#76](https://github.com/mferdinandr/valtrum/issues/76) | previews, authorization and action status for MCP and terminal | mcp-terminal (9) |
| P4 | [#77](https://github.com/mferdinandr/valtrum/issues/77) | player agent proposals through previews and grants; broader grant tests deferred by #58 | player-agents (4) |
| P4 | [#78](https://github.com/mferdinandr/valtrum/issues/78) | Intents and Bitte integration evidence | testnet-integrations (4) |
| P4 | [#79](https://github.com/mferdinandr/valtrum/issues/79) | entitlement, transfer and DAO states in the UI; recovery alerts | testnet-integrations (2) |
| P4 | [#80](https://github.com/mferdinandr/valtrum/issues/80) | end-to-end demos and failure recovery on testnet | testnet-integrations (6) |

### Issues opened on 2026-11-09

| Priority | Issue | Title | Source |
| --- | --- | --- | --- |
| P1 | [#113](https://github.com/mferdinandr/valtrum/issues/113) | put protocol authority and fee under a SputnikDAO on testnet | D28 |
| P2 | [#108](https://github.com/mferdinandr/valtrum/issues/108) | enforce player grants on every spending path | player-agents (10) |
| P2 | [#109](https://github.com/mferdinandr/valtrum/issues/109) | persist indexer cursors and reconcile reorgs after restart | testnet-integrations (3) |
| P2 | [#114](https://github.com/mferdinandr/valtrum/issues/114) | testnet fixture of the 1Click API pinned to recorded mainnet responses | D29 |
| P3 | [#110](https://github.com/mferdinandr/valtrum/issues/110) | verify market-data sources for mainnet reference tokens | testnet-integrations (1) |
| P3 | [#111](https://github.com/mferdinandr/valtrum/issues/111) | wire consistent audit field reasons into lifecycle logs and clients | audit (1) |
| P3, blocked | [#112](https://github.com/mferdinandr/valtrum/issues/112) | decide minimum executable-depth policy for concentrated liquidity (owner) | audit (1) |

## Open items and who acts

| Item | Needed from | Notes |
| --- | --- | --- |
| Read-only mainnet RPC (`REFERENCE_RPC_URL`, https) in a git-ignored `.env` | Owner | Needed for the liquidity fetcher and an on-chain token scan. On 2026-11-08 the Robinhood-hosted RPC served an expired certificate; keyless third-party RPCs from the chainlist registry worked for current-block reads but refuse finalized or older state without a key |
| Verify token authenticity on the official explorer before building the registry | Owner or team | Many look-alike tokens exist |
| Decide whether to add Uniswap v4 liquidity reading (would add REBATE and OAK) | Owner | Feasibility research started; see above |
| Dedicated auditor role instead of the shared agent whitelist | Owner | Today an auditor has the same authority as any whitelisted agent |
| Minimum deposit per account per community | Owner | Advice given: fix at creation and freeze in the snapshot |
| Live custody balance attestation from a finalized block | Owner and backing owner | Part of the backing task "suspend on deficit" |
| Payout contract must call the MPC signer itself | Backing and signing owner | Recorded as a task; do not deploy or fund the payout path before it exists |
| Behavior after a live token-policy change | Owner | Still OPEN; minimum executable liquidity depth decided in D32 |
| DAO governance: default vote window value and per-token sink address | Owner | Governance decided (D22); these deployment values remain |
| Testnet accounts and funds for #72 and #113 | Owner | Names of the 2 to 3 council accounts, funded NEAR testnet accounts, Robinhood testnet funds and RPC; keys only in a git-ignored `.env` (D28) |
| Retention for the audit report archive (`MAX_OBSERVATIONS` 100,000, no prune) | Owner | Not decided in #109, which covered the indexer only; the archive stops accepting observations at its limit |
| Scoring provider, cadence, boundary tolerance, anti-manipulation limits and a circulating-supply rule | Owner | Options in [scoring-market-data.md](scoring-market-data.md); a working mainnet archive RPC is a prerequisite for the recommended on-chain option |

## Planned improvements (not scheduled)

- Fallback audit for tokens GoPlus does not cover: static checks from Sourcify and on-chain reads can only fill administration and ownership context.
- Buy/sell simulation (for example `eth_call` with state overrides against the DEX router) to measure honeypot behavior and taxes. It spends no funds but needs an RPC that supports state overrides (not verified) and a decision on how simulated results map into the tax and honeypot fields.
- Uniswap v4 and native-ETH liquidity reading.
