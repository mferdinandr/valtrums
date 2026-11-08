mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TOKEN: &str = "0x0000000000000000000000000000000000000001";

/// All registry claims, operator attestations and source evidence below are
/// synthetic fixtures. They exercise NEAR behavior, not live Robinhood custody.
struct World {
    registry: Contract,
    backing: Contract,
    arena: Account,
    arena_contract: Contract,
    owner: Account,
    verifier: Account,
    operator: Account,
    payout: Account,
    alice: Account,
    relayer: Account,
}

async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let arena_contract = worker
        .dev_deploy(&common::wasm("valtrum_mock_lifecycle"))
        .await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let payout = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    arena_contract.call("new").transact().await?.into_result()?;
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
        "registry": registry.id(), "mapping_version": "1", "arena": arena_contract.id(), "payout": payout.id()
    })).max_gas().transact().await?.into_result()?;
    owner
        .call(registry.id(), "set_representation")
        .args_json(json!({"representation": backing.id(), "allowed": true}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(backing.id(), "set_operator")
        .args_json(json!({"operator": operator.id()}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    let arena = arena_contract.as_account().clone();
    Ok(World {
        registry,
        backing,
        arena,
        arena_contract,
        owner,
        verifier,
        operator,
        payout,
        alice,
        relayer,
    })
}

async fn set_battle(w: &World, battle: u64, locked: bool) -> anyhow::Result<()> {
    w.arena_contract
        .call("set_battle")
        .args_json(json!({"battle_id": battle.to_string(), "locked": locked}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn attest_receipt(
    w: &World,
    tx: u8,
    beneficiary: &Account,
    battle: u64,
    amount: &str,
) -> anyhow::Result<()> {
    let key = json!({"chain_id": "46630", "transaction_hash": vec![tx; 32], "log_index": 1});
    let claim = json!({"representation": w.backing.id(), "token_address": TOKEN, "custody_domain": "fixture", "mapping_version": "1", "beneficiary": beneficiary.id(), "refund_address": vec![3u8; 20], "battle_id": battle.to_string(), "actual_received": amount, "block_number": "3", "block_hash": vec![2u8; 32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32], "evidence_hash": vec![4u8; 32]});
    w.verifier
        .call(w.registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn claim_receipt(w: &World, tx: u8) -> anyhow::Result<bool> {
    Ok(w.relayer
        .call(w.backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", format!("{tx:02x}").repeat(32)), "log_index": 1}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json::<bool>()?)
}

async fn view(w: &World, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(w.backing.view(method).args_json(args).await?.json()?)
}

async fn attest_balance(w: &World, block: u64, balance: &str) -> anyhow::Result<bool> {
    Ok(w.operator
        .call(w.backing.id(), "attest_custody_balance")
        .args_json(json!({
            "source_block_number": block.to_string(), "source_block_hash": vec![block as u8; 32],
            "finalized_head_number": (block + 1).to_string(), "finalized_head_hash": vec![200u8; 32],
            "balance": balance, "evidence_hash": vec![5u8; 32]
        }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json::<bool>()?)
}

fn debit(amount: &str, tx: u8) -> Value {
    json!({"chain_id": "46630", "token_address": TOKEN, "custody_domain": "fixture",
        "destination": vec![3u8; 20], "source_amount": amount, "recipient_received": amount,
        "transaction_hash": vec![tx; 32], "log_index": 0, "block_hash": vec![8u8; 32]})
}

async fn suspension(w: &World) -> anyhow::Result<Value> {
    view(w, "get_suspension", json!({})).await
}

#[tokio::test]
async fn deposit_after_lock_is_unattributed_refund_only_and_unknown_battle_fails_closed(
) -> anyhow::Result<()> {
    let w = world().await?;
    // The arena does not know battle 2 yet: fail closed, nothing is credited.
    attest_receipt(&w, 1, &w.alice, 2, "98").await?;
    assert!(!claim_receipt(&w, 1).await?);
    assert_eq!(view(&w, "get_ledger", json!({})).await?["custody"], "0");
    // The battle is locked: the receipt becomes a late deposit.
    set_battle(&w, 2, true).await?;
    assert!(claim_receipt(&w, 1).await?);
    assert!(!claim_receipt(&w, 1).await?);
    let ledger = view(&w, "get_ledger", json!({})).await?;
    assert_eq!(ledger["unallocated"], "98");
    assert_eq!(ledger["late_refundable"], "98");
    assert_eq!(ledger["accounting_balanced"], true);
    assert_eq!(
        view(&w, "late_balance_of", json!({"account": w.alice.id()})).await?,
        "98"
    );
    assert_eq!(
        view(
            &w,
            "unallocated_balance_of",
            json!({"account": w.alice.id()})
        )
        .await?,
        "0"
    );
    // It cannot be turned into representation supply.
    w.alice
        .call(w.backing.id(), "storage_deposit")
        .args_json(json!({"account_id": w.alice.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    let mint = w
        .alice
        .call(w.backing.id(), "claim_representation")
        .args_json(json!({"beneficiary": w.alice.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(mint.into_result().is_err());
    assert_eq!(view(&w, "ft_total_supply", json!({})).await?, "0");
    // The refund can only go to the address bound at deposit time (D17).
    let wrong_destination = w
        .payout
        .call(w.backing.id(), "reserve_late_refund")
        .args_json(json!({"beneficiary": w.alice.id(), "request_id": vec![1u8; 32], "amount": "98", "destination": vec![4u8; 20]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(wrong_destination.into_result().is_err());
    // Only the payout authority, with one yocto, can start the refund.
    let args = json!({"beneficiary": w.alice.id(), "request_id": vec![1u8; 32], "amount": "98", "destination": vec![3u8; 20]});
    let outsider = w
        .alice
        .call(w.backing.id(), "reserve_late_refund")
        .args_json(args.clone())
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(outsider.into_result().is_err());
    let no_yocto = w
        .payout
        .call(w.backing.id(), "reserve_late_refund")
        .args_json(args.clone())
        .transact()
        .await?;
    assert!(no_yocto.into_result().is_err());
    let reserved = w
        .payout
        .call(w.backing.id(), "reserve_late_refund")
        .args_json(args)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?
        .json::<Value>()?;
    assert_eq!(reserved["source_amount"], "98");
    let ledger = view(&w, "get_ledger", json!({})).await?;
    assert_eq!(ledger["payouts"], "98");
    assert_eq!(ledger["late_refundable"], "0");
    // Confirmation with the matching finalized debit consumes the backing once.
    let confirm = |tx: u8, amount: &str| {
        w.payout
            .call(w.backing.id(), "confirm_payout")
            .args_json(json!({"beneficiary": w.alice.id(), "request_id": vec![1u8; 32], "evidence": debit(amount, tx)}))
            .max_gas()
            .transact()
    };
    assert!(confirm(7, "97").await?.into_result().is_err());
    assert!(confirm(7, "98").await?.into_result()?.json::<bool>()?);
    assert!(!confirm(7, "98").await?.into_result()?.json::<bool>()?);
    let ledger = view(&w, "get_ledger", json!({})).await?;
    assert_eq!(ledger["custody"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}

#[tokio::test]
async fn deficit_attestation_suspends_and_owner_resume_needs_a_later_covering_attestation(
) -> anyhow::Result<()> {
    let w = world().await?;
    set_battle(&w, 1, false).await?;
    attest_receipt(&w, 1, &w.alice, 1, "98").await?;
    assert!(claim_receipt(&w, 1).await?);
    // Operator only, one yocto.
    let outsider = w
        .relayer
        .call(w.backing.id(), "attest_custody_balance")
        .args_json(json!({"source_block_number": "10", "source_block_hash": vec![10u8; 32], "finalized_head_number": "11", "finalized_head_hash": vec![200u8; 32], "balance": "0", "evidence_hash": vec![5u8; 32]}))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(outsider.into_result().is_err());
    assert!(attest_balance(&w, 10, "98").await?);
    assert_eq!(suspension(&w).await?["suspended"], false);
    assert!(!attest_balance(&w, 11, "97").await?);
    let state = suspension(&w).await?;
    assert_eq!(state["suspended"], true);
    assert_eq!(state["deficit"], true);
    // Liabilities stay, and minting is blocked.
    let ledger = view(&w, "get_ledger", json!({})).await?;
    assert_eq!(ledger["unallocated"], "98");
    assert_eq!(ledger["reconciliation_required"], true);
    attest_receipt(&w, 2, &w.alice, 1, "5").await?;
    // A suspended asset rejects claims at the entry point (deposit returned).
    let blocked = w
        .relayer
        .call(w.backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", "02".repeat(32)), "log_index": 1}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(blocked.into_result().is_err());
    assert_eq!(view(&w, "get_ledger", json!({})).await?["custody"], "98");
    let resume = |caller: &Account| {
        caller
            .call(w.backing.id(), "resume")
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
    };
    // No covering attestation after the deficit yet.
    assert!(resume(&w.owner).await?.into_result().is_err());
    assert!(attest_balance(&w, 12, "98").await?);
    assert_eq!(suspension(&w).await?["suspended"], true);
    assert!(resume(&w.relayer).await?.into_result().is_err());
    assert!(resume(&w.owner).await?.into_result()?.json::<bool>()?);
    assert_eq!(suspension(&w).await?["suspended"], false);
    assert!(claim_receipt(&w, 2).await?);
    Ok(())
}

#[tokio::test]
async fn resume_policy_is_owner_only_logged_and_selects_the_resume_path() -> anyhow::Result<()> {
    let w = world().await?;
    set_battle(&w, 1, false).await?;
    attest_receipt(&w, 1, &w.alice, 1, "98").await?;
    assert!(claim_receipt(&w, 1).await?);
    assert_eq!(
        suspension(&w).await?["resume_policy"],
        "owner_with_evidence"
    );
    let set = |caller: &Account, policy: &str, deposit: u128| {
        caller
            .call(w.backing.id(), "set_resume_policy")
            .args_json(json!({"policy": policy}))
            .deposit(NearToken::from_yoctonear(deposit))
            .transact()
    };
    assert!(set(&w.relayer, "automatic", 1)
        .await?
        .into_result()
        .is_err());
    assert!(set(&w.owner, "automatic", 0).await?.into_result().is_err());
    let changed = set(&w.owner, "disabled", 1).await?;
    assert!(changed
        .logs()
        .iter()
        .any(|line| line.contains("resume_policy_changed") && line.contains("disabled")));
    changed.into_result()?;
    assert!(!attest_balance(&w, 10, "1").await?);
    assert!(attest_balance(&w, 11, "98").await?);
    assert_eq!(suspension(&w).await?["suspended"], true);
    let denied = w
        .owner
        .call(w.backing.id(), "resume")
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(denied.into_result().is_err());
    set(&w.owner, "automatic", 1).await?.into_result()?;
    assert!(attest_balance(&w, 12, "98").await?);
    assert_eq!(suspension(&w).await?["suspended"], false);
    // Automatic now lifts a later deficit as soon as a covering attestation follows.
    assert!(!attest_balance(&w, 13, "0").await?);
    assert_eq!(suspension(&w).await?["suspended"], true);
    assert!(attest_balance(&w, 14, "98").await?);
    assert_eq!(suspension(&w).await?["suspended"], false);
    Ok(())
}

#[tokio::test]
async fn unresolved_payout_reconciliation_suspends_until_matching_evidence() -> anyhow::Result<()> {
    let w = world().await?;
    set_battle(&w, 1, false).await?;
    // The arena account holds the credit, as the locked vault does.
    attest_receipt(&w, 1, &w.arena, 1, "98").await?;
    assert!(claim_receipt(&w, 1).await?);
    w.arena
        .call(w.backing.id(), "storage_deposit")
        .args_json(json!({"account_id": w.arena.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    w.arena
        .call(w.backing.id(), "claim_representation")
        .args_json(json!({"beneficiary": w.arena.id(), "amount": "98"}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    w.arena
        .call(w.backing.id(), "allocate_entitlement")
        .args_json(
            json!({"allocation_id": vec![9u8; 32], "beneficiary": w.alice.id(), "amount": "98"}),
        )
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    let reserve = |request: u8, amount: &str| {
        w.payout
            .call(w.backing.id(), "reserve_payout")
            .args_json(json!({"beneficiary": w.alice.id(), "request_id": vec![request; 32], "amount": amount, "destination": vec![3u8; 20]}))
            .transact()
    };
    reserve(1, "60").await?.into_result()?;
    let report = |caller: &Account, deposit: u128| {
        caller
            .call(w.backing.id(), "report_unresolved_reconciliation")
            .args_json(json!({"holder": w.alice.id(), "request_id": vec![1u8; 32]}))
            .deposit(NearToken::from_yoctonear(deposit))
            .transact()
    };
    assert!(report(&w.relayer, 1).await?.into_result().is_err());
    assert!(report(&w.payout, 0).await?.into_result().is_err());
    assert!(report(&w.payout, 1).await?.into_result()?.json::<bool>()?);
    let state = suspension(&w).await?;
    assert_eq!(state["suspended"], true);
    assert_eq!(state["unresolved"], "1");
    // New reservations are refused; the reservation and liabilities remain.
    assert!(reserve(2, "10").await?.into_result().is_err());
    assert_eq!(view(&w, "get_ledger", json!({})).await?["payouts"], "60");
    // Owner resume cannot clear it; only a matching finalized debit (or a
    // no-spend release) can.
    let resume = w
        .owner
        .call(w.backing.id(), "resume")
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(resume.into_result().is_err());
    let wrong = w
        .payout
        .call(w.backing.id(), "confirm_payout")
        .args_json(json!({"beneficiary": w.alice.id(), "request_id": vec![1u8; 32], "evidence": debit("59", 7)}))
        .max_gas()
        .transact()
        .await?;
    assert!(wrong.into_result().is_err());
    assert_eq!(suspension(&w).await?["suspended"], true);
    let confirmed = w
        .payout
        .call(w.backing.id(), "confirm_payout")
        .args_json(json!({"beneficiary": w.alice.id(), "request_id": vec![1u8; 32], "evidence": debit("60", 7)}))
        .max_gas()
        .transact()
        .await?;
    assert!(confirmed.into_result()?.json::<bool>()?);
    assert_eq!(suspension(&w).await?["suspended"], false);
    let ledger = view(&w, "get_ledger", json!({})).await?;
    assert_eq!(ledger["custody"], "38");
    assert_eq!(ledger["payouts"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}
