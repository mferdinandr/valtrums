mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TOKEN: &str = "0x0000000000000000000000000000000000000001";

fn token_bytes() -> Vec<u8> {
    let mut bytes = vec![0u8; 19];
    bytes.push(1);
    bytes
}

struct World {
    backing: Contract,
    payout: Contract,
    arena: Account,
    alice: Account,
    relayer: Account,
    operator: Account,
}

/// Synthetic setup: the registry claim, operator evidence and nonces below are
/// test fixtures, not live finality or custody.
async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let payout = worker.dev_deploy(&common::wasm("valtrum_payout")).await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let arena = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    backing.call("new").args_json(json!({
        "owner": owner.id(),
        "asset": { "chain_id": "46630", "token_address": TOKEN, "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
        "name": "Representation fixture", "symbol": "TEST",
        "registry": registry.id(), "mapping_version": "1", "arena": arena.id(), "payout": payout.id()
    })).max_gas().transact().await?.into_result()?;
    payout
        .call("new")
        .args_json(json!({"owner": owner.id(), "operator": operator.id(), "relayer": relayer.id()}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(registry.id(), "set_representation")
        .args_json(json!({"representation": backing.id(), "allowed": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(payout.id(), "register_backing")
        .args_json(json!({"backing": backing.id(), "config": {
            "chain_id": "46630", "token": token_bytes(), "custody_domain": "fixture",
            "sender": vec![2u8; 20], "path": "custody-1", "first_nonce": "5"
        }}))
        .transact()
        .await?
        .into_result()?;
    // The arena receives the attested custody and holds it as the locked vault.
    let key = json!({"chain_id": "46630", "transaction_hash": vec![1u8; 32], "log_index": 1});
    let claim = json!({"representation": backing.id(), "token_address": TOKEN, "custody_domain": "fixture", "mapping_version": "1", "beneficiary": arena.id(), "battle_id": "1", "actual_received": "98", "block_number": "3", "block_hash": vec![2u8; 32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32], "evidence_hash": vec![4u8; 32]});
    verifier
        .call(registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let credited = relayer
        .call(backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", "01".repeat(32)), "log_index": 1}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(credited.into_result()?.json::<bool>()?);
    arena
        .call(backing.id(), "storage_deposit")
        .args_json(json!({"account_id": arena.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    arena
        .call(backing.id(), "claim_representation")
        .args_json(json!({"beneficiary": arena.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    arena
        .call(backing.id(), "allocate_entitlement")
        .args_json(
            json!({"allocation_id": vec![9u8; 32], "beneficiary": alice.id(), "amount": "98"}),
        )
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        backing,
        payout,
        arena,
        alice,
        relayer,
        operator,
    })
}

fn evidence(amount: &str, tx: u8) -> Value {
    json!({"chain_id": "46630", "token": token_bytes(), "sender": vec![2u8; 20], "recipient": vec![3u8; 20],
        "amount": amount, "tx_hash": vec![tx; 32], "log_index": 0, "block_hash": vec![8u8; 32],
        "block_number": "10", "finalized_head_number": "12", "finalized_head_hash": vec![9u8; 32],
        "evidence_hash": vec![7u8; 32]})
}

async fn status(w: &World, request: u8) -> anyhow::Result<Option<String>> {
    Ok(w.payout
        .view("get_payout_status")
        .args_json(json!({"backing": w.backing.id(), "holder": w.alice.id(), "request_id": vec![request; 32]}))
        .await?
        .json()?)
}

async fn request(w: &World, request: u8, amount: &str) -> anyhow::Result<bool> {
    Ok(w.alice
        .call(w.payout.id(), "request_payout")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![request; 32], "amount": amount, "destination": vec![3u8; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json::<bool>()
        .unwrap_or(false))
}

fn id(w: &World, request: u8) -> Value {
    json!({"backing": w.backing.id(), "holder": w.alice.id(), "request_id": vec![request; 32]})
}

#[tokio::test]
async fn payout_roles_are_separate_and_confirmation_consumes_backing_once() -> anyhow::Result<()> {
    let w = world().await?;
    // Only an entitlement holder can reserve; an account without one is rejected.
    let stranger = w
        .operator
        .call(w.payout.id(), "request_payout")
        .args_json(json!({"backing": w.backing.id(), "request_id": vec![1u8; 32], "amount": "10", "destination": vec![3u8; 20]}))
        .deposit(NearToken::from_millinear(30))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(!stranger.json::<bool>().unwrap_or(false));
    assert_eq!(status(&w, 1).await?, None);

    assert!(request(&w, 1, "60").await?);
    assert!(request(&w, 1, "60").await?); // identical repeat is idempotent
    assert_eq!(status(&w, 1).await?.as_deref(), Some("authorized"));
    let payload: Value = w
        .payout
        .view("get_signing_payload")
        .args_json(id(&w, 1))
        .await?
        .json()?;
    assert_eq!(payload["amount"], "60");
    assert_eq!(payload["nonce"], "5");
    let binding = payload["binding_hash"].clone();

    // Role misuse: holder, operator and the backing's other roles cannot drive signing.
    for account in [&w.alice, &w.operator, &w.arena] {
        let attempt = account
            .call(w.payout.id(), "begin_signing")
            .args_json(id(&w, 1))
            .max_gas()
            .transact()
            .await?;
        assert!(attempt.into_result().is_err());
    }
    w.relayer
        .call(w.payout.id(), "begin_signing")
        .args_json(id(&w, 1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    // A signature for changed parameters is refused.
    let mut tampered = id(&w, 1);
    tampered["tx_hash"] = json!(vec![7u8; 32]);
    tampered["binding_hash"] = json!(vec![0xEEu8; 32]);
    tampered["max_fee_per_gas"] = json!("10");
    assert!(w
        .relayer
        .call(w.payout.id(), "record_signature")
        .args_json(tampered)
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_err());
    let mut signed = id(&w, 1);
    signed["tx_hash"] = json!(vec![7u8; 32]);
    signed["binding_hash"] = binding;
    signed["max_fee_per_gas"] = json!("10");
    w.relayer
        .call(w.payout.id(), "record_signature")
        .args_json(signed)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let mut broadcast = id(&w, 1);
    broadcast["tx_hash"] = json!(vec![7u8; 32]);
    w.relayer
        .call(w.payout.id(), "record_broadcast")
        .args_json(broadcast)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(status(&w, 1).await?.as_deref(), Some("broadcast"));

    // Neither a signature nor a broadcast confirms; only the operator can, with exact evidence.
    let confirm = |amount: &str| {
        let mut args = id(&w, 1);
        args["evidence"] = evidence(amount, 7);
        args
    };
    for account in [&w.alice, &w.relayer] {
        assert!(account
            .call(w.payout.id(), "confirm_payout")
            .args_json(confirm("60"))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .is_err());
    }
    assert!(w
        .operator
        .call(w.payout.id(), "confirm_payout")
        .args_json(confirm("59"))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_err());
    assert_eq!(status(&w, 1).await?.as_deref(), Some("broadcast"));
    w.operator
        .call(w.payout.id(), "confirm_payout")
        .args_json(confirm("60"))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(status(&w, 1).await?.as_deref(), Some("confirmed"));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "38");
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["entitlements"], "38");
    assert_eq!(ledger["accounting_balanced"], true);
    // Replaying the same evidence changes nothing.
    w.operator
        .call(w.payout.id(), "confirm_payout")
        .args_json(confirm("60"))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let again: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(again["custody"], "38");
    Ok(())
}

#[tokio::test]
async fn unsigned_payouts_can_be_cancelled_but_signed_ones_need_nonce_proof() -> anyhow::Result<()>
{
    let w = world().await?;
    assert!(request(&w, 2, "38").await?);
    // Holders and relayers cannot release; the operator can cancel an unsigned payout.
    for account in [&w.alice, &w.relayer] {
        assert!(account
            .call(w.payout.id(), "restore_payout")
            .args_json({
                let mut args = id(&w, 2);
                args["proof"] = Value::Null;
                args
            })
            .max_gas()
            .transact()
            .await?
            .into_result()
            .is_err());
    }
    let cancel = |request: u8| {
        let mut args = id(&w, request);
        args["proof"] = Value::Null;
        args
    };
    w.operator
        .call(w.payout.id(), "restore_payout")
        .args_json(cancel(2))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(status(&w, 2).await?.as_deref(), Some("restored"));
    let held: String = w
        .backing
        .view("entitlement_of")
        .args_json(json!({"account": w.alice.id()}))
        .await?
        .json()?;
    assert_eq!(held, "98");

    // A requested signature may hide a signed transaction: no cancellation without proof.
    assert!(request(&w, 3, "38").await?);
    w.relayer
        .call(w.payout.id(), "begin_signing")
        .args_json(id(&w, 3))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(w
        .operator
        .call(w.payout.id(), "restore_payout")
        .args_json(cancel(3))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .is_err());
    assert_eq!(status(&w, 3).await?.as_deref(), Some("signing_requested"));
    // A proof that the custody nonce was consumed by another transaction releases it.
    let mut proof = id(&w, 3);
    proof["proof"] = json!({"chain_id": "46630", "sender": vec![2u8; 20], "finalized_nonce": "7",
        "outcome": {"ForeignTx": vec![6u8; 32]}, "finalized_head_number": "12",
        "finalized_head_hash": vec![9u8; 32]});
    w.operator
        .call(w.payout.id(), "restore_payout")
        .args_json(proof)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(status(&w, 3).await?.as_deref(), Some("restored"));
    let ledger: Value = w
        .backing
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["entitlements"], "98");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}
