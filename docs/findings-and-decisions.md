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
| D5 | WETH price pool: Uniswap v3 WETH/USDG `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` with a floor of USD 1,000,000 on its stablecoin side. Address comes from DexScreener and is not verified on-chain by us. | arena-audit | Implemented (merged in #53) |
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
| D17 | A late foreign deposit is refunded to an EVM address the depositor binds at deposit time. The deposit event currently names only a NEAR account as beneficiary, so this needs a new field in the custody contract, the verifier, the registry claim and backing, and a new mapping version. Refines D15. | arena-asset-representation | Issue [#82](https://github.com/mferdinandr/valtrum/issues/82) |
| D18 | The audit policy-hash pin checked at lock stays optional (enforced only when the owner sets it). A pass approval lasts at most 24 hours (agent choice, not in the spec) and the agent lock is opt-in (`AUDIT_LOCK_ENABLED`). | arena-audit | Implemented in [#85](https://github.com/mferdinandr/valtrum/pull/85) (open) |
| D20 | Read-only arena event indexing foundation (agent choices, no owner input needed): injectable `BlockSource`, lossless u64 parsing, dedup key `network\|contract\|receiptId\|logIndex\|dataItemIndex`, a pure projection namespaced by network+contract, one atomic versioned snapshot with a single-writer lock, fork rollback only above the finalized boundary, and finality promoted only along the source-declared finalized chain. Corrupt state fails closed (never reset); a recorded source is a declared assertion, not verified finality; the indexer has no write authority. Live NEAR/EVM adapters, custody/payout suspension on reorg, and UI/alerts stay deferred. (D19 is reserved for the audit report archive PR #60.) | arena-testnet-integrations | Implemented on branch `feat/arena-event-indexer` (issue [#59](https://github.com/mferdinandr/valtrum/issues/59); PR open for review) |

Work in progress (not yet pushed): `feat/backing-reconciliation` (asset-representation tasks: reconciliation, suspend and resume policy, late-deposit refund) and `feat/payout-mpc-signing` (chain-signatures tasks: MPC signer call from the payout contract, restart reconciliation, explicit payout states). `arena-settlement` follows once the payout status interface exists.

## Research findings (2026-11-07)

### GoPlus coverage on Robinhood mainnet 4663

Method: tokens found through DexScreener (224 from keyword searches plus 24 from quote-asset pool lists), then each checked against GoPlus Token Security without credentials. 13 of roughly 250 tokens had GoPlus data (about 5%). The candidate set is not exhaustive: DexScreener endpoints return at most 30 pools per query. Liquidity and pool types come from DexScreener and were not verified on-chain. Authenticity was not verified: many names have look-alike tokens at other addresses, so check each token on the official explorer before it enters the registry.

"Expected result" is our reading of audit policy v1 and the 10,000 USD liquidity rule, not the output of the audit code.

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
| P2 | [#64](https://github.com/mferdinandr/valtrum/issues/64) | reconcile pending payouts after a worker restart | chain-signatures (1) |
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

## Open items and who acts

| Item | Needed from | Notes |
| --- | --- | --- |
| Read-only mainnet RPC (`REFERENCE_RPC_URL`, https) in a git-ignored `.env` | Owner | Needed for the liquidity fetcher and an on-chain token scan |
| Verify token authenticity on the official explorer before building the registry | Owner or team | Many look-alike tokens exist |
| Decide whether to add Uniswap v4 liquidity reading (would add REBATE and OAK) | Owner | Feasibility research started; see above |
| Dedicated auditor role instead of the shared agent whitelist | Owner | Today an auditor has the same authority as any whitelisted agent |
| Minimum deposit per account per community | Owner | Advice given: fix at creation and freeze in the snapshot |
| Live custody balance attestation from a finalized block | Owner and backing owner | Part of the backing task "suspend on deficit" |
| Payout contract must call the MPC signer itself | Backing and signing owner | Recorded as a task; do not deploy or fund the payout path before it exists |
| Behavior after a live token-policy change; minimum executable liquidity depth | Owner | Still OPEN |
| DAO governance | Owner | Still OPEN |

## Planned improvements (not scheduled)

- Fallback audit for tokens GoPlus does not cover: static checks from Sourcify and on-chain reads can only fill administration and ownership context.
- Buy/sell simulation (for example `eth_call` with state overrides against the DEX router) to measure honeypot behavior and taxes. It spends no funds but needs an RPC that supports state overrides (not verified) and a decision on how simulated results map into the tax and honeypot fields.
- Uniswap v4 and native-ETH liquidity reading.
