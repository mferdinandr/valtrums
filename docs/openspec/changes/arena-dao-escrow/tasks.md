# Tasks

Check tasks only after implementation and verification. Governance is decided (D22, [dao-governance.md](../../../dao-governance.md)); do not add a timeout or fallback beyond it.

## Principal isolation

- [x] Bind the winning principal hold to the frozen winning asset, amount and participant attribution. (`lifecycle_guards.rs`; the escrow record is bound to battle, community and amount, `escrow_api.rs`)
- [x] Integrate an exclusive backing reservation for escrow without blocking losing-token entitlements. (backing `escrow` bucket and `reserve_principal_escrow`, arena `reserve_lifecycle_escrow`; sandbox-tested)
- [x] Keep principal escrowed indefinitely while no valid governance decision exists. (no method moves units out of `escrow`; the D22 vote is #75)
- [x] Test unresolved governance, independent reward availability and denial of owner-only or worker-only disposition.

## Governance design gate

- [x] Obtain explicit decisions on DAO membership, voting weight, quorum, deadlines, delegation and fallback. (Owner, 2026-11-08, D22.)
- [x] Specify authorized decision verification, eligible burn/return proportions and execution authority for review. (`docs/dao-governance.md`.)
- [x] Obtain approval of the governance and disposition design before implementing an authoritative decision path. (Approved by the owner on 2026-11-08 by merging PR #99.)

## Decision-bound execution

- [x] Bind each approved decision to escrow identity, authorized burn/return portions and destination or disposal action. (`arena/src/dao_api.rs`: releases derive from the contract's own tally, carry ids bound to arena, battle and position, and name the escrow id; returns name the winner, the burn the backing's frozen sink.)
- [x] Ensure total reserved portions do not exceed escrow and the same backing cannot be returned, redeemed and burned. (`backing/src/dao.rs`: per-escrow release totals are bounded by the escrow; returns move escrow to entitlements, the burn to disposal; one id cannot be both.)
- [x] Execute each decision portion at most once through exclusive reservations. (Idempotent release ids in the backing; batched execution with a cursor that only advances after every backing call succeeded.)
- [x] Verify source-chain return or underlying burn/sink separately from destruction of NEAR representations. (A burn is confirmed only by a finalized debit to the sink through `confirm_payout`; returns pay out through the entitlement payout path. Representation burns at escrow time never count.)
- [x] Expose pending versus confirmed source disposition accurately. (`get_lifecycle_disposition` and `get_lifecycle_disposition_releases` on the arena; `get_escrow_disposition` on the backing separates burn pending and burn confirmed.)
- [x] Test split decisions, replay, competing reservations, unauthorized decisions and representation-only burn evidence. (Unit tests in `dao_api.rs` and backing `lib.rs`; sandbox: `lifecycle_integration` two-community battle votes, executes and confirms the burn; `payout` DAO burn through signing and confirmation. Fixtures only.)

## Protocol authority under a SputnikDAO (#113)

- [x] Map every privileged arena, backing, payout and receipt-registry method (caller, one yocto, where configured) and classify it as DAO-owned, automated role or deploy-key owner. (`docs/sputnik-authority.md`, from source at a95fa69.)
- [x] Verify the SputnikDAO factory, policy and `FunctionCall` proposal interface from official sources and record what is unverified. (Read-only RPC on 2026-11-09 and upstream source at commit 7764926; Trezu has no documented testnet support.)
- [x] Show in the sandbox, with the real arena and backing and the official SputnikDAO 3.31 wasm, that a council majority proposal with one yocto changes the DAO window, fee and burn sink, and that a non-council account, a lone member and the deploy owner cannot. (`contracts/integration/tests/sputnik_authority.rs`; fixtures: sandbox accounts, direct DAO deploy.)
- [x] Show that the DAO cannot release escrowed principal or submit a disposition. (Same file; no funded battle in that test, see the limits in the doc.)
- [x] Write the council setup runbook, proposal templates and the list of inputs needed from the owner. (`docs/sputnik-authority.md`.)
- [x] Owner decisions Q1 to Q3 (D33). Q1 changed the arena: the reference-registry methods require the protocol account and one yocto (unit tests in `reference_registry.rs`, sandbox tests `reference_registry.rs` and `sputnik_authority.rs`). Q2 (the DAO is the backing owner from initialisation) and Q3 (the fee stays a DAO entitlement; EVM withdrawal is a known gap) need no code.
- [x] Initialise each testnet backing with the DAO as `owner` (deployment prerequisite; the owner cannot be changed afterwards).
  - Done 2026-11-09 (`docs/evidence/2026-11-09-near-testnet-wiring.json`, `docs/testnet-evidence.md` section 6): the six `backing-<symbol>` accounts were initialised with `valtrum-protocol.sputnikv2.testnet` as owner, and each burn sink was then set through a passed DAO proposal (read back as `0x...dead`). The backing has no owner view; ownership is shown by the constructor argument and by the proposals executing.
  - Partly verified 2026-11-09 (`docs/evidence/2026-11-09-near-testnet-deploy.json`): `backing1.valtrum-owner-b694.testnet` was initialised with `owner` = `valtrum-protocol.sputnikv2.testnet` (fixture asset, token `0x...01`); the owner account gets `Only owner` on `set_paused`, and 2-of-3 council proposals on it ended `Approved` (proposals 1 and 2). Unchecked because every real-token backing still has to be initialised the same way once the mock token addresses exist.
- [x] Create the DAO on testnet through `sputnikv2.testnet` and record account, factory transaction, code hash, policy and date. (2026-11-09: `valtrum-protocol.sputnikv2.testnet`, tx `7mPdsL7ZjtkJjgskKAactY3jtm98eaCMyCxjXGaevKVK`, code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, council 1 to 3, default policy; live testnet evidence from the owner's accounts.)
- [x] Execute one real change through a passed proposal on the testnet contracts and record proposal id, transactions and the negative calls. (2026-11-09: proposal 0 set the arena DAO window to 86400 after two council approvals; the owner and a lone council member got `Only the protocol account can change the DAO window`, a non-member vote got `ERR_PERMISSION_DENIED`; see the evidence JSON.)
