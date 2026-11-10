# Source crosscheck and apply gates

**Historical review:** read the [main reconciliation](main-reconciliation.md)
before applying this verdict. The merged source contains additional existing
implementations and DAO decisions absent from the original inspection snapshot.

Reviewed 2026-11-10 against HEAD `4881fd76570a060659cafa7a4275e8740a5cdaf4`
plus the current working tree on `feat/living-toy-world`. This is a source/proposal
consistency review, not a security audit, deployment verification or live-funds
approval. No application implementation or transactions were performed.

## Verdict

The split proposals are suitable for **staged implementation with the gates below**.
Begin with read-only DTOs/service/fixtures. They are not permission to enable all
financial capabilities, activate a contract, upgrade/deploy custody or fund it.
OpenSpec artifact readiness verifies structure, not runtime readiness.

## Feature mapping

All source paths below are repository-relative; inspected symbols identify the
evidence rather than assuming older prose documents describe current code.

| Feature | Source evidence | Match / required implementation | Owner |
| --- | --- | --- | --- |
| Provider/protocol selection | `web/src/lib/config.ts`, `components/providers.tsx` | Missing arena ID selects mock today; target explicit protocol manifest is new, not implemented | Read API |
| Legacy ABI and IDs | `web/src/lib/arena/near.ts`, detail route `Number(id)` | Legacy A/B methods and numeric IDs confirmed; target string namespace needs adapter/route work, unsafe u64 rejected | Read API + lifecycle safe views |
| Discovery/search | Arena `PAGE=100` loop and `.filter`; portfolio fetch-all loop | Backend search/cursors required for both lists and selectors; portfolio account queries are downstream | Read API / portfolio |
| Multi-community create | `lib.rs::create_lifecycle_battle`; web Create A/B form | Source accepts 2+ assets/mode, storage funding and no bond; target UI adapter is missing | Lifecycle frontend |
| Deployment activation | `lib.rs::activate_lifecycle` | Requires owner, 1 yocto and `battle_count == 0`; cannot activate a populated legacy contract by switching UI | Lifecycle owner + deployment gate |
| Audit expiry | `lifecycle.rs::CommunityView.audit_expires_at_ms` | Already exported; corrected proposal to reuse it. Activation/config/backing readiness remains incomplete | Read API + lifecycle |
| Registration/representation | `register_lifecycle_position`, backing `claim_representation`, NEP-145 methods | Position storage is not stake; representation beneficiary must be FT-registered and spend uses caller-attributed custody | Lifecycle frontend |
| Source receipt | `custody-verifier.ts`, receipt registry `attest`, backing `claim_receipt` | Verifier library exists; runtime transport/operator attestation not wired in main | Testnet + backing |
| Custody payout compatibility | `evm/src/TestnetDepositCustody.sol` contract header and `deposit` | **Blocking:** no withdrawals/recovery. An MPC EOA cannot automatically spend tokens held here; require reviewed compatible custody path before enabling transfers | Testnet + backing |
| Audit report publication | `main.ts` supplies `AuditReportStore`; `lifecycle-pass.ts` accepts optional archive | Archive/server exist, main does not inject sink; new producer follow-up is necessary | Audit producer; read API consumer |
| Price chart | FE `getLivePrices` returns null; snapshots and synthetic demo series | Durable real history is new; legacy TWAP/spot labels and fixture isolation retained | Market observations |
| Mode inputs | `rounds_api.rs::ModeDataInput`, `market-wiring.ts` | Four scoring modes exist in contracts; main's default DexScreener chain/aliases and RAM samples do not qualify target inputs | Market collector + testnet provider owner |
| Round authority/history | `get_lifecycle_round`, `rounds.rs::Record` | Current candidates/window/winner available; exact scores/history/evidence not fully retained/exported. New view/state/event work, not just FE wiring | Lifecycle + testnet indexer |
| Oracle scheduling | `main.ts`, `rounds_api.rs` | No target scheduler in entry point. `start_lifecycle_rounds` is storage-funded public terms reveal; open/submit require oracle + 1 yocto | Testnet scheduler |
| Indexing | `indexer/types.ts::SUPPORTED_EVENTS`, recorded CLI | Only create/audit/deposit recognized; no live source. Other lifecycle/backing/payout event formats need explicit adapters/version handoffs | Testnet indexer |
| 3D arena | `battle-runtime.ts`, `battle-arena.tsx`, detail route | Integrated already; adapter takes legacy `BattleView`, multi-community is demo. Target adapter must preserve authoritative external rounds; no separate gameplay engine required | Lifecycle frontend |
| Settlement | `settle_api.rs` exported `settle_lifecycle_battle`, `get_settlement_progress` | Batched allocation available; `settlement_plan` internal, not RPC. New normalized reads required | Settlement owner / portfolio client |
| Payout/account history | `PayoutView`, `list_open_payouts`, backing account views | Open requests do not constitute full historical portfolio. Exact byte codecs and reservation identity required | Portfolio + indexer |
| Payout workers | `payout-wiring.ts`, `payout-reconciler.ts` | Reconciler does not initiate signatures and rejects operator credentials; separate runtime roles still required | Chain signatures |
| Terminal/player grants | Existing parser/sender/session key; planned MCP/player changes | Parsing and function-call key gas cap are not an MCP server or externally enforced expiring token budget; excluded from four child implementations | MCP/player owners |
| Principal/economics | `lifecycle.rs` hold + settlement policy; legacy FE payout model | Original losing-token rewards and principal hold stay separate; never import legacy 55/35/5/5 economics or invent DAO release controls | Portfolio; DAO remains OPEN locally |
| Token/model identity | `colosseum/characters.json`, generic emblem fallback | Five cosmetic demo entries are not an allowlisted asset catalog; eligibility comes from trusted registry, unknown assets use fallback | Read API registry / lifecycle UI |

## Corrections made after this review

- Reuse already exported audit expiry; scope new contract reads to genuinely missing fields.
- Document legacy activation incompatibility and deposit-only custody as independent capability gates.
- Assign round-read gateway extensions to lifecycle frontend, observation routes to market and settlement/account routes to portfolio; the read-only foundation does not inherit all eventual endpoints.
- Add matching requirement/scenario deltas for the new follow-up tasks in original owners, preserving historical checked tasks.
- Record GitHub closure reason and publication status instead of assuming closed issues or local documents prove implementation.

## Apply and release matrix

| Slice | Can start now? | Gate before live release |
| --- | --- | --- |
| Read API DTO/service/BFF and recorded tests | Yes | Verified deployment manifest, safe ABI, canonical live source; unavailable sections remain explicit |
| Collector/journal/chart against fixtures | After shared DTO boundary | Qualified mappings/providers/cadence and persistent evidence; each mode enabled independently |
| Lifecycle UI against fixtures and supported reads | After shared DTO boundary | Activated compatible deployment, audit/backing readiness, verified custody-to-payout path and authorized runtime evidence |
| Portfolio read-only client | After shared DTO boundary | Attributable account views and indexed history completeness |
| Deposits/payout requests/live full flow | Not release-ready | Resolve spendable custody, verifier transport, oracle/signer/operator wiring and actual testnet proofs |
| DAO/MCP/delegated players | Outside these four changes | Their own requirements, authorization and acceptance; no shortcut to complete UI demo |

Implementers must inspect the latest branch/source before apply and reconcile ABI
changes with owning specs. No database migration is proposed; generation and
application each need separate explicit user approval if later required. Automated
contract/transport/unit checks are appropriate; Playwright remains excluded by the
user's current instruction.

## GitHub and publication evidence

Issue discovery found only [#80](https://github.com/mferdinandr/valtrum/issues/80)
open among the first 100 repository issues returned. Existing oracle
[#134](https://github.com/mferdinandr/valtrum/issues/134) was closed with
`stateReason=NOT_PLANNED` on 2026-11-09; closure is not completion evidence. Other
closed tickets are historical references and must be checked against source/PRs
before being treated as delivery. Local product docs still mark DAO governance
OPEN; historical issue text alone does not override that unresolved local spec.

New split artifacts are currently local/uncommitted. GitHub issues must include
their scope and acceptance inline, disclose this publication gap and avoid links
that pretend these files already exist on remote main. A docs publication handoff
is required before another checkout can apply these new change names. No commit
or push is implied by issue creation. Reuse #80 for cross-service acceptance rather
than creating another duplicate acceptance checklist.

Published integration issues and dependency ordering are recorded in the
[issue index](issues/README.md); issue creation is not code delivery.
