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
| D14 | Resume policy after an asset is suspended (deficit, reorg or unresolved reconciliation) is flexible and changeable by the owner (hackathon). Planned modes: `OwnerWithEvidence` (default: owner resumes only after an attestation shows custody covers all liabilities), `Automatic` (a later covering attestation lifts the suspension) and `Disabled`. `Automatic` trades safety for speed: a wrong or manipulated attestation could reopen payouts while a shortfall remains. | arena-asset-representation | In progress on `feat/backing-reconciliation` |
| D15 | A late foreign deposit is refunded to the beneficiary named in the custody deposit event (not the token sender), after finality; it never enters a snapshot or vault. Refines D8. | arena-asset-representation | In progress on `feat/backing-reconciliation` |
| D16 | The `docs/` branch prefix is allowed for documentation-only branches. | repository conventions | Merged in #56 |

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

| Branch | Content | Verification so far |
| --- | --- | --- |
| `feat/arena-lifecycle-unblocked` (10 commits on `main`) | Freeze of creator participation in the snapshot; tests for freeze, closed deposits during rounds, held winning principal, creation and lock requirements; late foreign deposit decision recorded; lock requires a non-zero deposit. Lifecycle tasks that need audit, backing or scoring integration stay unchecked. | `cargo test -p valtrum-arena`: 331 passed (re-run by the coordinator); clippy `-D warnings` and fmt clean per agent report |
| `feat/arena-audit` (23 commits on `main`) | Authenticated `submit_lifecycle_audit`; GoPlus normalization and decision precedence; audit policy v1; reference-token binding through a protocol registry; optional reference pair committed on-chain in the community asset identity (`asset-identity-v2`, both-or-neither, duplicates rejected); headline quote-balance liquidity valuation for v2 and v3 pools pinned to one block; WETH priced through a configured v3 pool with a floor and no code defaults; structured audit report; scheduled refresh with configurable lifetime; optional GoPlus credential with rate-limit handling; notes on unscheduled fallback ideas. Not done: tick-based depth, v4 and native-ETH pools, on-chain verification of the example addresses, lock refusal on expiry, live coverage. | Agent report: `pnpm -C agent test` 336 passed, `cargo test` 536 passed, clippy and fmt clean. Coordinator re-run: `pnpm -C agent test` 336 passed (34 files); `cargo test -p valtrum-arena` 332 passed. The full contract workspace (536) was not re-run. Fixtures only; no live GoPlus, mainnet RPC or testnet coverage is claimed. |
| `chore/openspec-followups` | Tasks and spec text for the late-deposit refund (asset representation), the missing MPC signer call (chain signatures) and the mainnet reference registry (testnet integrations); this log; updates to docs that listed decided items as OPEN; shortened long requirements in the settlement spec. | `openspec validate --all --strict` (see below) |
| `chore/archive-arena-scoring` | Archive of `arena-scoring` and creation of its main spec; fixed two links and the placeholder Purpose. | 317 arena tests passed on `main`-equivalent code before the archive |

OpenSpec validation on `main` after all merges: 10 passed, 0 failed (`--strict`). Baseline command: run `cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`. Before the settlement fix, `arena-audit` and `arena-settlement` failed only on warnings that a requirement text exceeds 500 characters.

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
