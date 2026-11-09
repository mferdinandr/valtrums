# Protocol authority under a SputnikDAO

Design, evidence and runbook for issue [#113](https://github.com/mferdinandr/valtrum/issues/113) (owner decisions of 2026-11-09, D28). The winners' burn-or-return vote stays in the arena contract (D22, [dao-governance.md](dao-governance.md)). What moves under a SputnikDAO is **protocol-level authority and the protocol fee recipient**, so these changes need a council vote instead of one key.

**Status (2026-11-09): sandbox-verified, not deployed.** The owner has no testnet accounts or funds yet, so no DAO exists on testnet and nothing was deployed. Live evidence below is read-only; everything about the contracts running under a DAO is a sandbox test with the official SputnikDAO wasm.

## Owner decisions (issue #113, 2026-11-09)

1. Council of 2 to 3 team accounts, simple majority, new members through Sputnik's add-member proposal. Open membership and participant-weighted DAOs are out of scope (future work: open membership allows many-account takeover of protocol parameters and fee; weights from escrowed principal need an adapter that is not proven).
2. The DAO holds only protocol-level roles and the protocol fee. Payout operator, relayer, agent and scheduler stay out. The winners' vote stays in the arena (D22).
3. The DAO does not hold the deploy (upgrade) key during the hackathon. Handing it over is pre-production work.
4. Testnet accounts: none yet. Do not deploy until the owner provides them.

## Privileged-method map (source read on main at a95fa69)

Every cell is from the contract source (`contracts/*/src`). "1 yocto" means `assert_one_yocto` is in the method. The DAO column follows the owner decisions.

### Arena (`contracts/arena`)

| Method | Caller check | 1 yocto | Configured by | Target holder |
| --- | --- | --- | --- | --- |
| `set_lifecycle_dao_window(window_secs)` | `lifecycle_protocol` | yes | the protocol account | **DAO** |
| `set_lifecycle_fee(fee_bps, creator_share_bps)` | `lifecycle_protocol` | yes | the protocol account | **DAO** |
| `set_lifecycle_protocol(protocol)` | `owner` | yes | arena owner (deploy key) | **deploy-key owner** (see risk R1) |
| `activate_lifecycle`, `set_lifecycle_oracle` (once), `set_lifecycle_observation_policy`, `set_lifecycle_audit_policy_hash`, `set_lifecycle_representation_trusted` | `owner` | yes | arena owner | deploy-key owner |
| `add_reference_entry`, `remove_reference_entry` (reference-token registry) | `owner` | yes | arena owner | **open question Q1** (registry is owner-gated, not protocol-gated) |
| `add_agent`, `remove_agent`, `set_treasury`, `set_router`, `set_execution`, `set_foreign`, `set_bond`, `set_deposit_window_secs`, `set_paused` (legacy surface) | `owner` | no (a deposit is refused) | arena owner | deploy-key owner |
| `lock_lifecycle_battle`, `submit_lifecycle_audit`, `refresh_lifecycle_backing`, `approve_battle` and the other agent methods | whitelisted agent | no | owner via `add_agent` | automated role, stays out |
| `open_lifecycle_round`, `submit_lifecycle_observations` | the oracle fixed once by `set_lifecycle_oracle` | yes | owner | automated role, stays out |
| `vote_lifecycle_disposition`, `execute_lifecycle_disposition`, `reserve_lifecycle_escrow` | winning participant / anyone | n/a | none | no privileged caller exists (D22) |

The arena `owner` is set once in `new` and there is no transfer method.

### Backing (`contracts/backing`, one per token)

| Method | Caller check | 1 yocto | Configured by | Target holder |
| --- | --- | --- | --- | --- |
| `set_dao_sink(sink)` (once per token) | `owner` | yes | backing owner, set in `new` | **DAO** |
| `set_paused`, `set_operator`, `set_resume_policy`, `resume` | `owner` | yes | backing owner | the same owner as `set_dao_sink`: **open question Q2** |
| `attest_custody_balance` | `operator` | yes | owner via `set_operator` | automated role, stays out |
| `reserve_payout`, `confirm_payout`, `release_payout`, `reserve_dao_burn`, `reserve_late_refund`, `report_unresolved_reconciliation` | payout authority | partly | `payout` in `new` | automated role, stays out |
| `allocate_entitlement`, `reserve_principal_escrow`, `release_escrow_return`, `release_escrow_burn` | the configured arena only | no | `arena` in `new` | the arena contract itself; no human or DAO caller |

The backing `owner` is set once in `new`; there is no transfer method. For the DAO to own a backing, the DAO must be the `owner` argument when that backing is initialised. An already deployed backing keeps its owner.

### Payout and receipt registry

| Contract | Method | Caller | 1 yocto | Target holder |
| --- | --- | --- | --- | --- |
| payout | `register_backing` (once per backing) | `owner` | yes | deploy-key owner |
| payout | `request_signature`, `record_broadcast` | relayer | yes | automated role, stays out |
| payout | `record_pending_finality`, `require_reconciliation`, `record_revert`, `confirm_payout`, `restore_payout` | operator (some also relayer) | yes | automated roles, stay out |
| receipt-registry | `set_representation` | `owner` | no (needs a storage deposit instead) | deploy-key owner |
| receipt-registry | `set_verifier` | `owner` | yes | deploy-key owner |
| receipt-registry | `attest`, `dispute` | verifier | n/a | automated role, stays out |

### Where the protocol fee goes

`create_lifecycle_battle` snapshots `fee.protocol = lifecycle_protocol` and `protocol_created = (creator == protocol)`. Settlement allocates the protocol share as a backing entitlement to that **NEAR account** (`settlement.rs`, `Recipient::Protocol`). So the fee recipient is the protocol account. Setting the DAO as the protocol account makes the DAO account the beneficiary of future battles' protocol fee; battles created earlier keep their snapshot. Moving the entitlement to Robinhood needs the beneficiary to request a payout to a destination, which a DAO can do only through a `FunctionCall` proposal. That flow is **not tested**, and is open (Q3).

### Residual powers outside the DAO (record, do not hide)

- **R1.** The deploy-key owner can call `set_lifecycle_protocol` and re-point the protocol away from the DAO for future battles. It can also redeploy contract code (the upgrade key). The DAO is a check on protocol parameters, not yet a removal of owner trust (decision 3).
- **R2.** A DAO created by `sputnikv2.testnet` has `auto_update: true`, and the factory source lets the factory owner (`sputnikv2.testnet` itself) call `update(account_id, code_hash)` on DAOs it created. Testnet only. A council `FactoryInfoUpdate` proposal can turn `auto_update` off. The factory-source behaviour was read, not exercised.
- **R3.** Any account may add a proposal (the default policy gives `*:AddProposal` to everyone, bond 1 NEAR). Only the council role can vote, finalize or remove. Spam costs the proposer the bond but fills the proposal list.
- **R4.** A 2-of-3 council can approve any `FunctionCall` the DAO account may make, including to contracts outside this protocol, and can change its own policy. Council compromise equals protocol-parameter compromise (fee up to the contract's 10% cap, window 1 minute to 30 days, one sink per token).

## What the DAO cannot do (contract-level)

- It cannot submit or override a battle's disposition: no arena method accepts a decision from the protocol account; `vote_lifecycle_disposition` needs winning weight, and only the contract's own tally decides.
- It cannot release or move escrowed principal: `reserve_principal_escrow`, `release_escrow_return`, `release_escrow_burn` accept the configured arena only; the backing's `reserve_dao_burn` is payout-authority only.
- It cannot change a burn sink after it is set (once per token), and it cannot change fees above 1000 bps total or battles that already snapshotted their fee and window.

These are proven by the sandbox test `the_dao_holds_no_authority_over_votes_or_escrowed_principal`. Limits of that test: no funded battle exists in it, so the arena-side vote and execute attempts also fail for lack of a battle. The identity-based denials are the backing ones. The existing `lifecycle_integration` test already shows the protocol account (the owner there) denied any vote on a real tally.

## Verified SputnikDAO interface

All reads on 2026-11-09 through `https://test.rpc.fastnear.com`, block heights near 276859470 (live public service, no credentials).

- **Factory exists:** `sputnikv2.testnet`, code hash `77dkUJRCHKRxJxo6UtYgBtRP6hsEX2v4vXjmFuY7dktb`, 6.68 MB storage (it stores the DAO wasm versions), owner `sputnikv2.testnet`, 5495 DAOs created (`get_number_daos`).
- **Versions offered** (`get_contracts_metadata`): 2.0, 2.1, 3.0, 3.1, 3.2, 3.3, 3.31. Default (`get_default_code_hash`) is `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, version 3.31, upstream commit `7764926cfd3c47f62b5fcde231c251f3c3892887` (`near-daos/sputnik-dao-contract`).
- **Create method** (factory source at that commit, `sputnikdao-factory2/src/lib.rs`): `#[payable] create(name: AccountId, args: Base64VecU8)`. The new account is `<name>.sputnikv2.testnet`. The factory deploys the default code and calls `new` with `args` (decoded). If creation fails the callback `on_create` refunds the attached deposit to the caller.
- **`new` arguments** (`sputnikdao2/src/lib.rs`): `new(config: {name, purpose, metadata: base64}, policy)`. `policy` is either an array of council account ids (the `Default` policy) or a full policy object.
- **Default policy** (`policy.rs`): role `all` (everyone: `*:AddProposal`), role `council` (the given group: `*:AddProposal`, `*:VoteApprove`, `*:VoteReject`, `*:VoteRemove`, `*:Finalize`), default vote policy `RoleWeight`, quorum 0, threshold ratio 1/2, which means `floor(n/2)+1` votes (2 of 3, 3 of 4), proposal bond 1 NEAR (must be attached exactly), proposal period 7 days, bounty bond 1 NEAR.
- **FunctionCall proposal:** `add_proposal({"proposal": {"description", "kind": {"FunctionCall": {"receiver_id", "actions": [{"method_name", "args": <base64>, "deposit": "<yocto string>", "gas": "<gas string>"}]}}}})` with exactly the bond attached. A `deposit` of `"1"` is the one yocto our methods require. Voting is `act_proposal({"id", "action": "VoteApprove"|"VoteReject"|"VoteRemove"|"Finalize"})`. Views: `get_proposal`, `get_proposals`, `get_last_proposal_id`, `get_policy`.
- **Add member:** `kind: {"AddMemberToRole": {"member_id", "role": "council"}}`.
- **Wasm obtained reproducibly:** the factory serves the code through the read-only view `get_code(code_hash)`. `scripts/fetch-sputnikdao-wasm.py` downloads it (539,647 bytes) and checks that its base58 SHA-256 equals the pinned hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` (hex `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da`). The sandbox test uses it and CI runs the script first.

**Not verified:**

- The minimum factory `create` deposit. The DAO account must pay for about 540 KB of code (about 5.4 NEAR at 1e19 yocto per byte) plus state, so the deposit must exceed that; the commonly used UI value is not confirmed here. Confirm on the first real create with a dry estimate, and expect the refund path if it is too low.
- Any live DAO, because none was created (no accounts).
- That `sputnikv2.testnet` will keep offering 3.31 as default, or keep the code stored.
- Trezu on testnet: see below.
- That the DAO account can call payout to withdraw the protocol fee to Robinhood.

## Trezu

Checked 2026-11-09 through `gh api` on `NEAR-DevHub/trezu-docs` (16 doc files, all read; keyword search for testnet, mainnet and sputnik). Result: **no testnet support is documented.** The only DAO reference is that an existing mainnet `.sputnikdao.near` DAO can be imported by signing in with its creator account. `https://trezu.app` answers (HTTP 200); `https://testnet.trezu.app` does not resolve. So Trezu is **not usable for a testnet council today**, and the council uses near-cli-rs (below). If the owner later runs a mainnet DAO, Trezu can be the interface to the same Sputnik DAO; nothing in the contracts depends on it. No multisig is built.

## Evidence (sandbox, fixtures labelled)

`contracts/integration/tests/sputnik_authority.rs` (2 tests). Real: arena, backing, receipt-registry and the official SputnikDAO 3.31 wasm. Not real: the account names, the factory `create` path (the DAO is deployed directly and `new` gets the same arguments), and any funds or battle.

- `council_majority_changes_protocol_parameters_and_nobody_else_can`: with a 3-member council and the DAO as protocol account and backing owner:
  - the deploy owner, a council member alone and an outsider fail to call `set_lifecycle_dao_window`;
  - an outsider can add a proposal but cannot vote (`ERR_PERMISSION_DENIED`);
  - one approval leaves it `InProgress`, the second makes it `Approved` and the window becomes 86400;
  - the same for `set_lifecycle_fee` (500, 5000);
  - a proposal that attaches `"0"` yocto, or a fee above the bound, ends `Failed` with no change;
  - two rejections end `Rejected` with no change;
  - the backing `set_dao_sink` works through the DAO once, the second proposal `Failed`, and the owner, a member alone and an outsider cannot call it;
  - `AddMemberToRole` is refused for the newcomer before it passes and the council grows to 4 after.
- `the_dao_holds_no_authority_over_votes_or_escrowed_principal`: through passed proposals the DAO's calls to `reserve_principal_escrow`, `release_escrow_return`, `release_escrow_burn`, `reserve_dao_burn`, `vote_lifecycle_disposition`, `execute_lifecycle_disposition` and a non-existent override method all end `Failed`; the ledger shows no escrow and stays balanced.

Run: `python3 scripts/fetch-sputnikdao-wasm.py && cd contracts && cargo test -p valtrum-integration --test sputnik_authority -- --test-threads=2`.

## Runbook (testnet, when the owner provides accounts)

Do not run any of this until the owner has named the accounts and funded them. `<COUNCIL1..3>` are the owner's accounts; `<DEPLOYER>` is the owner account that pays; `<DAO>` is `<name>.sputnikv2.testnet`.

1. **Create the DAO** (factory, read the printed receipts afterwards):

```bash
ARGS=$(printf '%s' '{"config":{"name":"valtrum-protocol","purpose":"Valtrum protocol authority","metadata":""},"policy":["<COUNCIL1>","<COUNCIL2>","<COUNCIL3>"]}' | base64)
near contract call-function as-transaction sputnikv2.testnet create json-args "{\"name\":\"valtrum-protocol\",\"args\":\"$ARGS\"}" prepaid-gas '150 Tgas' attached-deposit '<DEPOSIT> NEAR' sign-as <DEPLOYER> network-config testnet sign-with-keychain send
```

2. **Record it:** `near contract call-function as-read-only <DAO> get_policy json-args '{}' network-config testnet now`, `get_config`, `get_factory_info`, and `near account view-account-summary <DAO> network-config testnet now` (code hash must equal `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`). Fund the DAO account with enough NEAR to attach one yocto per call and to pay proposal gas refunds (a few NEAR).
3. **Point the protocol at the DAO** (deploy-key owner, one yocto): `set_lifecycle_protocol`.

```bash
near contract call-function as-transaction <ARENA> set_lifecycle_protocol json-args '{"protocol":"<DAO>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config testnet sign-with-keychain send
```

4. **Backing owner:** a new backing for each token must be initialised with `"owner":"<DAO>"`; existing backings keep their owner (no transfer method). Resolve Q2 first.
5. **Optionally turn off factory auto-update** (R2): a `FactoryInfoUpdate` proposal with `{"factory_info":{"factory_id":"sputnikv2.testnet","auto_update":false}}`.

### Proposal templates

A council member adds the proposal (the bond is exactly 1 NEAR) and members vote. `B64=$(printf '%s' '<ARGS JSON>' | base64)`.

```bash
near contract call-function as-transaction <DAO> add_proposal json-args "{\"proposal\":{\"description\":\"<WHY>\",\"kind\":{\"FunctionCall\":{\"receiver_id\":\"<TARGET>\",\"actions\":[{\"method_name\":\"<METHOD>\",\"args\":\"$B64\",\"deposit\":\"1\",\"gas\":\"100000000000000\"}]}}}}" prepaid-gas '100 Tgas' attached-deposit '1 NEAR' sign-as <COUNCIL1> network-config testnet sign-with-keychain send
near contract call-function as-transaction <DAO> act_proposal json-args '{"id":<ID>,"action":"VoteApprove"}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as <COUNCIL2> network-config testnet sign-with-keychain send
near contract call-function as-read-only <DAO> get_proposal json-args '{"id":<ID>}' network-config testnet now
```

The proposal succeeds when `status` is `Approved` after the second vote; `Failed` means the target refused it (check the receipt).

| Action | `<TARGET>` and `<METHOD>` | Args JSON |
| --- | --- | --- |
| Set DAO vote window | `<ARENA>` `set_lifecycle_dao_window` | `{"window_secs":"<60..2592000>"}` |
| Set fee policy | `<ARENA>` `set_lifecycle_fee` | `{"fee_bps":<=1000,"creator_share_bps":<=10000}` |
| Set burn sink for a token (once) | `<BACKING>` `set_dao_sink` | `{"sink":[<20 bytes as numbers>]}` (the 0x...dEaD sink is eighteen `0` bytes then `222,173`; the owner must check the sink accepts transfers because it cannot change) |
| Add council member | no FunctionCall: `kind: {"AddMemberToRole":{"member_id":"<ACCOUNT>","role":"council"}}` | none |
| Remove council member | `kind: {"RemoveMemberFromRole":{"member_id":"<ACCOUNT>","role":"council"}}` | none |
| Reference-token registry add/remove | `<ARENA>` `add_reference_entry` / `remove_reference_entry` | only after Q1 is decided; today they are owner-only and the DAO is refused |

### First live demonstration (to record once accounts exist)

Set the DAO window through a passed proposal on the testnet arena: record the DAO account, factory transaction, code hash, policy, proposal id, vote transactions, the resulting `get_lifecycle_dao_window`, and the negative calls (a council member and the owner alone fail). Add the dated record to `docs/testnet-evidence.md`.

## Inputs needed from the owner

1. **Council accounts:** 2 to 3 testnet account ids and who controls each key (do not reuse any account of another purpose).
2. **DAO name** (becomes `<name>.sputnikv2.testnet`).
3. **A funded `<DEPLOYER>` testnet account** with at least about 12 NEAR (create deposit, DAO funding, proposal bonds), and keys in the near-cli-rs keychain (`sign-with-keychain`) on the machine that runs the runbook.
4. **Proposal period** (the default is 7 days) and bond (default 1 NEAR). The code and tests use the defaults.
5. **Existing testnet deployments:** the arena and backing account ids, and which accounts are their owners today, so the plan can say what needs redeploying.
6. Decisions Q1 to Q3 below.

## Open questions for the owner (not decided here)

- **Q1. Reference-token registry authority.** Decision 2 puts the registry under the protocol account, but `add_reference_entry` and `remove_reference_entry` are gated by the arena **owner**. Options: (a) change those two methods to the protocol account (small contract change, still one yocto, the registry then needs a DAO vote); (b) initialise the arena with the DAO as owner (the DAO then also controls the agent list, oracle, trusted representations and audit policy hash, which is more than decision 2); (c) keep the registry with the deploy-key owner. Recommended: (a).
- **Q2. Backing owner scope.** The one backing owner role also controls `set_paused`, `set_operator` (appoints the automated custody attestor) and `set_resume_policy`/`resume`. With the DAO as owner, pausing in an incident needs a majority vote and the DAO appoints the operator. Options: accept that (decision as written); or add a separate narrow pauser role in the contract (code change); or leave the backing owner with the deploy key and give the DAO only the sink through a code change.
- **Q3. Fee withdrawal.** Confirm the DAO account may be the protocol fee beneficiary and how its Robinhood payout destination is bound (identity and payout binding flow is OQ-IDENTITY). Not tested.

## Future work

Open membership; participant-weighted DAO; DAO as upgrade-key holder; redeploying with the DAO as arena owner. All recorded as out of scope for the hackathon.
