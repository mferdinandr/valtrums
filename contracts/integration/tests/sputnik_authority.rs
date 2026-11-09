mod common;

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

// Protocol authority under a SputnikDAO (issue #113, owner decisions of 2026-11-09).
//
// REAL: the arena and backing contracts of this repository and the official
// SputnikDAO v3.31 wasm (code hash AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH),
// fetched read-only from the `sputnikv2.testnet` factory by
// `scripts/fetch-sputnikdao-wasm.py` and verified against that hash. Contracts
// run in the NEAR sandbox.
// NOT proven here: the factory `create` call and its deposit, a live testnet DAO,
// real council accounts, and any funded battle. The DAO is deployed directly
// with the same `new(config, policy)` arguments the factory would pass.
//
// Run: python3 scripts/fetch-sputnikdao-wasm.py && cargo test -p valtrum-integration \
//        --test sputnik_authority -- --test-threads=2
// The wasm is not committed. Without it the tests fail with these instructions
// (never silently pass).

const DAO_GAS: &str = "100000000000000";

fn sputnik_wasm() -> Vec<u8> {
    let path =
        std::env::var("SPUTNIK_WASM")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace dir")
            .join("target/sputnik/sputnikdao2-AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH.wasm")
            });
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "SputnikDAO wasm missing at {}: {e}. Run `python3 scripts/fetch-sputnikdao-wasm.py` first.",
            path.display()
        )
    })
}

fn yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

struct World {
    worker: Worker<Sandbox>,
    dao: Contract,
    arena: Contract,
    backing: Contract,
    /// Holds the deploy key: owner of the arena and the registry. Not the protocol.
    deploy_owner: Account,
    council: Vec<Account>,
    outsider: Account,
    next_proposal: u64,
}

async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let deploy_owner = worker.dev_create_account().await?;
    let payout = worker.dev_create_account().await?;
    let outsider = worker.dev_create_account().await?;
    let mut council = Vec::new();
    for _ in 0..3 {
        council.push(worker.dev_create_account().await?);
    }
    // The DAO: simple majority of a 3-member council (Sputnik `Default` policy:
    // role "council", ratio 1/2 of role weight, so 2 of 3).
    let dao = worker.dev_deploy(&sputnik_wasm()).await?;
    let members: Vec<_> = council.iter().map(|a| a.id().to_string()).collect();
    dao.call("new")
        .args_json(json!({
            "config": {"name": "valtrum-protocol-test", "purpose": "protocol authority", "metadata": ""},
            "policy": members,
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    registry
        .call("new")
        .args_json(json!({"owner": deploy_owner.id(), "verifier": payout.id()}))
        .transact()
        .await?
        .into_result()?;
    let arena = worker.dev_deploy(&common::wasm("valtrum_arena")).await?;
    arena
        .call("new")
        .args_json(json!({
            "owner": deploy_owner.id(), "usdc": "usdc.fixture.near", "treasury": deploy_owner.id(),
            "bond": "0", "deposit_window_secs": "60"
        }))
        .transact()
        .await?
        .into_result()?;
    // The deploy-key owner activates the lifecycle and names the DAO as the
    // protocol account (the owner keeps the deploy key; the DAO does not).
    for (method, args) in [
        ("activate_lifecycle", json!({})),
        ("set_lifecycle_protocol", json!({"protocol": dao.id()})),
    ] {
        deploy_owner
            .call(arena.id(), method)
            .args_json(args)
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    // A backing representation owned by the DAO from initialization (there is no
    // owner transfer method, so the DAO must be the owner at `new`).
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    backing
        .call("new")
        .args_json(json!({
            "owner": dao.id(),
            "asset": {"chain_id": "46630", "token_address": format!("0x{:040x}", 1),
                      "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18},
            "name": "Representation fixture", "symbol": "TEST",
            "registry": registry.id(), "mapping_version": "1",
            "arena": arena.id(), "payout": payout.id()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        worker,
        dao,
        arena,
        backing,
        deploy_owner,
        council,
        outsider,
        next_proposal: 0,
    })
}

fn b64(args: &Value) -> String {
    base64_encode(args.to_string().as_bytes())
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

impl World {
    /// A `FunctionCall` proposal that calls `method` on `receiver` with `deposit`
    /// yocto, added by `proposer`. Returns the proposal id.
    async fn propose(
        &mut self,
        proposer: &Account,
        receiver: &Contract,
        method: &str,
        args: Value,
        deposit: &str,
    ) -> anyhow::Result<u64> {
        self.propose_to(proposer, receiver.id().as_str(), method, args, deposit)
            .await
    }

    async fn propose_to(
        &mut self,
        proposer: &Account,
        receiver: &str,
        method: &str,
        args: Value,
        deposit: &str,
    ) -> anyhow::Result<u64> {
        let id: u64 = proposer
            .call(self.dao.id(), "add_proposal")
            .args_json(json!({"proposal": {
                "description": format!("{method} via DAO"),
                "kind": {"FunctionCall": {"receiver_id": receiver, "actions": [{
                    "method_name": method, "args": b64(&args),
                    "deposit": deposit, "gas": DAO_GAS
                }]}}
            }}))
            .deposit(NearToken::from_near(1)) // the default proposal bond
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json()?;
        assert_eq!(id, self.next_proposal);
        self.next_proposal += 1;
        Ok(id)
    }

    async fn vote(&self, voter: &Account, id: u64, action: &str) -> anyhow::Result<bool> {
        Ok(voter
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({"id": id, "action": action}))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .is_ok())
    }

    async fn status(&self, id: u64) -> anyhow::Result<String> {
        let proposal: Value = self
            .dao
            .view("get_proposal")
            .args_json(json!({"id": id}))
            .await?
            .json()?;
        Ok(proposal["status"].as_str().unwrap_or("?").to_string())
    }

    /// Two council members approve: the majority of three.
    async fn pass(&self, id: u64) -> anyhow::Result<String> {
        assert!(self.vote(&self.council[0], id, "VoteApprove").await?);
        assert_eq!(
            self.status(id).await?,
            "InProgress",
            "one vote is not a majority"
        );
        assert!(self.vote(&self.council[1], id, "VoteApprove").await?);
        self.worker.fast_forward(3).await?;
        self.status(id).await
    }

    async fn direct(
        &self,
        caller: &Account,
        target: &Contract,
        method: &str,
        args: Value,
    ) -> anyhow::Result<bool> {
        Ok(caller
            .call(target.id(), method)
            .args_json(args)
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?
            .into_result()
            .is_ok())
    }
}

#[tokio::test]
async fn council_majority_changes_protocol_parameters_and_nobody_else_can() -> anyhow::Result<()> {
    let mut w = world().await?;
    let arena = w.arena.clone();
    let backing_c = w.backing.clone();
    let dao_window = || async {
        anyhow::Ok(
            arena
                .view("get_lifecycle_dao_window")
                .await?
                .json::<Value>()?,
        )
    };
    assert_eq!(dao_window().await?, Value::Null);

    // Before any proposal: the deploy-key owner, a council member acting alone and
    // an outsider all fail, because only the DAO account is the protocol.
    let window_args = json!({"window_secs": "86400"});
    for caller in [&w.deploy_owner, &w.council[0], &w.outsider] {
        assert!(
            !w.direct(
                caller,
                &w.arena,
                "set_lifecycle_dao_window",
                window_args.clone()
            )
            .await?
        );
    }

    // A council member proposes; one approval is not a majority; an outsider may
    // add proposals (Sputnik `*:AddProposal` for everyone) but cannot vote.
    let id = w
        .propose(
            &w.council[0].clone(),
            &arena,
            "set_lifecycle_dao_window",
            window_args,
            "1",
        )
        .await?;
    let outsider = w.outsider.clone();
    assert!(
        !w.vote(&outsider, id, "VoteApprove").await?,
        "non-council cannot approve"
    );
    assert_eq!(w.pass(id).await?, "Approved");
    assert_eq!(dao_window().await?, json!("86400"));

    // Fee policy: also protocol-only, also one yocto, within the contract's bounds.
    let id = w
        .propose(
            &w.council[1].clone(),
            &arena,
            "set_lifecycle_fee",
            json!({"fee_bps": 500, "creator_share_bps": 5000}),
            "1",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Approved");
    assert_eq!(
        arena.view("get_lifecycle_fee").await?.json::<Value>()?,
        json!([500, 5000])
    );

    // The proposal must attach exactly one yocto: with zero attached the arena
    // refuses, the proposal Fails, and the value is unchanged.
    let id = w
        .propose(
            &w.council[0].clone(),
            &arena,
            "set_lifecycle_dao_window",
            json!({"window_secs": "120"}),
            "0",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Failed");
    assert_eq!(dao_window().await?, json!("86400"));

    // The contract's own bounds still apply to the DAO (fee above 10% is refused).
    let id = w
        .propose(
            &w.council[0].clone(),
            &arena,
            "set_lifecycle_fee",
            json!({"fee_bps": 1001, "creator_share_bps": 5000}),
            "1",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Failed");
    assert_eq!(
        arena.view("get_lifecycle_fee").await?.json::<Value>()?,
        json!([500, 5000])
    );

    // A rejected proposal changes nothing: two rejections are a majority against.
    let id = w
        .propose(
            &w.council[0].clone(),
            &arena,
            "set_lifecycle_dao_window",
            json!({"window_secs": "3600"}),
            "1",
        )
        .await?;
    assert!(w.vote(&w.council[0], id, "VoteReject").await?);
    assert!(w.vote(&w.council[1], id, "VoteReject").await?);
    assert_eq!(w.status(id).await?, "Rejected");
    assert_eq!(dao_window().await?, json!("86400"));

    // Backing: the DAO is the owner, so the burn sink is set through a proposal,
    // once. The deploy-key owner and council members acting alone cannot set it.
    let sink = vec![0xdeu8; 20];
    for caller in [&w.deploy_owner, &w.council[0], &w.outsider] {
        assert!(
            !w.direct(caller, &w.backing, "set_dao_sink", json!({"sink": sink}))
                .await?
        );
    }
    let id = w
        .propose(
            &w.council[0].clone(),
            &backing_c,
            "set_dao_sink",
            json!({"sink": sink}),
            "1",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Approved");
    let stored: Value = w.backing.view("get_dao_sink").await?.json()?;
    assert_eq!(stored, json!(format!("0x{}", "de".repeat(20))));
    // Once only: a second proposal for another sink Fails and the first stays.
    let other = vec![0xadu8; 20];
    let id = w
        .propose(
            &w.council[0].clone(),
            &backing_c,
            "set_dao_sink",
            json!({"sink": other}),
            "1",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Failed");
    assert_eq!(
        w.backing.view("get_dao_sink").await?.json::<Value>()?,
        stored
    );

    // Membership changes go through the DAO as well (Sputnik's AddMemberToRole).
    // A new member cannot vote before the proposal passes, and can after.
    let newcomer = w.worker.dev_create_account().await?;
    let id: u64 = w.council[0]
        .call(w.dao.id(), "add_proposal")
        .args_json(json!({"proposal": {
            "description": "add council member",
            "kind": {"AddMemberToRole": {"member_id": newcomer.id(), "role": "council"}}
        }}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    w.next_proposal += 1;
    assert!(!w.vote(&newcomer, id, "VoteApprove").await?);
    assert_eq!(w.pass(id).await?, "Approved");
    let policy: Value = w.dao.view("get_policy").await?.json()?;
    let council_members = policy["roles"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == "council")
        .map(|r| r["kind"]["Group"].as_array().map(Vec::len).unwrap_or(0));
    assert_eq!(council_members, Some(4));
    Ok(())
}

#[tokio::test]
async fn the_dao_holds_no_authority_over_votes_or_escrowed_principal() -> anyhow::Result<()> {
    let mut w = world().await?;
    let escrow_id = vec![1u8; 32];
    let release_id = vec![2u8; 32];
    // Every call below is attempted by the DAO itself through a passed proposal
    // (the strongest identity the protocol layer can have). Each must Fail.
    // Backing: escrow and release methods accept the configured arena only.
    let backing_calls = [
        (
            "reserve_principal_escrow",
            json!({"escrow_id": escrow_id, "battle_id": "0", "community": 0, "amount": "1"}),
        ),
        (
            "release_escrow_return",
            json!({"escrow_id": escrow_id, "release_id": release_id,
            "beneficiary": w.outsider.id(), "amount": "1"}),
        ),
        (
            "release_escrow_burn",
            json!({"escrow_id": escrow_id, "release_id": release_id, "amount": "1"}),
        ),
        (
            "reserve_dao_burn",
            json!({"escrow_id": escrow_id, "release_id": release_id}),
        ),
    ];
    let backing = w.backing.clone();
    let proposer = w.council[0].clone();
    for (method, args) in backing_calls {
        let id = w.propose(&proposer, &backing, method, args, "1").await?;
        assert_eq!(
            w.pass(id).await?,
            "Failed",
            "{method} must be denied to the DAO"
        );
    }
    let ledger: Value = w.backing.view("get_ledger").await?.json()?;
    assert_eq!(ledger["escrow"], "0");
    assert_eq!(ledger["accounting_balanced"], true);

    // Arena: the DAO is not a participant, so it has no vote weight, and the
    // arena has no method by which the protocol account submits or overrides a
    // decision. A vote attempt by the DAO Fails.
    let arena = w.arena.clone();
    for (method, args) in [
        (
            "vote_lifecycle_disposition",
            json!({"battle_id": "0", "burn": true}),
        ),
        (
            "execute_lifecycle_disposition",
            json!({"battle_id": "0", "max_releases": 10}),
        ),
    ] {
        let id = w.propose(&proposer, &arena, method, args, "1").await?;
        assert_eq!(
            w.pass(id).await?,
            "Failed",
            "{method} must not succeed for the DAO"
        );
    }
    // Calling a method that does not exist is also a failure: there is no override entry point.
    let id = w
        .propose(
            &proposer,
            &arena,
            "set_lifecycle_disposition",
            json!({"battle_id": "0", "burn": true}),
            "1",
        )
        .await?;
    assert_eq!(w.pass(id).await?, "Failed");
    Ok(())
}
