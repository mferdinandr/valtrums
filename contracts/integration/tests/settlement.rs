mod common;

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

const TOKEN_A: &str = "0x0000000000000000000000000000000000000001";
const TOKEN_B: &str = "0x0000000000000000000000000000000000000002";

/// Fixture-only wasm is built separately so normal contract artifacts never
/// acquire the fixture methods. It proves NEAR behavior, not foreign custody.
fn fixture_arena_wasm() -> anyhow::Result<Vec<u8>> {
    let workspace = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace")
        .to_path_buf();
    let target = workspace.join("target/lifecycle-fixtures");
    let status = common::cargo_wasm_build()
        .current_dir(&workspace)
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "valtrum-arena",
            "--features",
            "sandbox-fixtures",
            "--target-dir",
        ])
        .arg(&target)
        .status()?;
    anyhow::ensure!(status.success(), "fixture wasm build failed");
    Ok(std::fs::read(target.join(
        "wasm32-unknown-unknown/release/valtrum_arena.wasm",
    ))?)
}

struct World {
    arena: Contract,
    backing_a: Contract,
    backing_b: Contract,
    alice: Account,
    bob: Account,
    treasury: Account,
    stranger: Account,
    battle_id: u64,
}

async fn mint_to_arena(
    registry: &Contract,
    verifier: &Account,
    backing: &Contract,
    arena: &Contract,
    token: &str,
    tx: u8,
    amount: &str,
) -> anyhow::Result<()> {
    let key = json!({"chain_id": "46630", "transaction_hash": vec![tx; 32], "log_index": 1});
    let claim = json!({"representation": backing.id(), "token_address": token, "custody_domain": "fixture", "mapping_version": "1", "beneficiary": arena.id(), "refund_address": vec![0xbeu8; 20], "battle_id": "1", "actual_received": amount, "block_number": "3", "block_hash": vec![2u8; 32], "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32], "evidence_hash": vec![4u8; 32]});
    verifier
        .call(registry.id(), "attest")
        .args_json(json!({"key": key, "claim": claim}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let credited = verifier
        .call(backing.id(), "claim_receipt")
        .args_json(json!({"transaction_hash": format!("0x{}", format!("{tx:02x}").repeat(32)), "log_index": 1}))
        .deposit(NearToken::from_millinear(20))
        .max_gas()
        .transact()
        .await?;
    assert!(credited.into_result()?.json::<bool>()?);
    let arena_account = arena.as_account();
    arena_account
        .call(backing.id(), "storage_deposit")
        .args_json(json!({"account_id": arena.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?
        .into_result()?;
    arena_account
        .call(backing.id(), "claim_representation")
        .args_json(json!({"beneficiary": arena.id(), "amount": amount}))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Two communities: A (alice 600, bob 400) beats B (100000 units held by carol).
/// Synthetic accounting credits stand in for deposits; the arena really holds
/// the backed representations, as after deposits.
async fn world() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let backing_a = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let backing_b = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    let arena = worker.dev_deploy(&fixture_arena_wasm()?).await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let alice = worker.dev_create_account().await?;
    let bob = worker.dev_create_account().await?;
    let carol = worker.dev_create_account().await?;
    let treasury = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    for (backing, token) in [(&backing_a, TOKEN_A), (&backing_b, TOKEN_B)] {
        backing.call("new").args_json(json!({
            "owner": owner.id(),
            "asset": { "chain_id": "46630", "token_address": token, "custody_domain": "fixture", "source_decimals": 18, "representation_decimals": 18 },
            "name": "Representation fixture", "symbol": "TEST",
            "registry": registry.id(), "mapping_version": "1", "arena": arena.id(), "payout": owner.id()
        })).max_gas().transact().await?.into_result()?;
        owner
            .call(registry.id(), "set_representation")
            .args_json(json!({"representation": backing.id(), "allowed": true}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
    }
    arena
        .call("new")
        .args_json(json!({"owner": owner.id(), "usdc": owner.id(), "treasury": treasury.id(), "bond": "0", "deposit_window_secs": "60"}))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(arena.id(), "add_agent")
        .args_json(json!({"account_id": agent.id()}))
        .transact()
        .await?
        .into_result()?;
    for (method, args) in [
        ("activate_lifecycle", json!({})),
        ("set_lifecycle_protocol", json!({"protocol": treasury.id()})),
        (
            "set_lifecycle_observation_policy",
            json!({"policy": {"version": "1", "policy_hash": "fixture-policy"}}),
        ),
    ] {
        owner
            .call(arena.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?
            .into_result()?;
    }
    let created = alice
        .call(arena.id(), "create_lifecycle_battle")
        .args_json(json!({"mode": "PriceGain", "assets": [
            { "chain_id": "46630", "token_address": TOKEN_A, "representation": backing_a.id(), "custody_domain": "fixture" },
            { "chain_id": "46630", "token_address": TOKEN_B, "representation": backing_b.id(), "custody_domain": "fixture" }
        ]}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let battle_id: u64 = created.json()?;
    for (community, user) in [(0, &alice), (0, &bob), (1, &carol)] {
        user.call(arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": battle_id, "community": community}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    for community in 0..2 {
        arena
            .call("fixture_approve_lifecycle")
            .args_json(json!({"battle_id": battle_id, "community": community}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    for (community, user, token, amount) in [
        (0, &alice, &backing_a, "600"),
        (0, &bob, &backing_a, "400"),
        (1, &carol, &backing_b, "100000"),
    ] {
        arena
            .call("fixture_credit_lifecycle")
            .args_json(json!({"battle_id": battle_id, "community": community, "account": user.id(), "token": token.id(), "amount": amount}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
    }
    // Backing asks the arena whether battle 1 is locked and treats a deposit
    // that arrives after lock as late, so the synthetic credits come first.
    mint_to_arena(&registry, &verifier, &backing_a, &arena, TOKEN_A, 1, "1000").await?;
    mint_to_arena(
        &registry, &verifier, &backing_b, &arena, TOKEN_B, 2, "100000",
    )
    .await?;
    agent
        .call(arena.id(), "lock_lifecycle_battle")
        .args_json(json!({"battle_id": battle_id}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    arena
        .call("fixture_hold_lifecycle_principal")
        .args_json(json!({"battle_id": battle_id, "winner": 0}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(World {
        arena,
        backing_a,
        backing_b,
        alice,
        bob,
        treasury,
        stranger,
        battle_id,
    })
}

async fn settle(w: &World, batch: u32) -> anyhow::Result<u32> {
    let result = w
        .stranger
        .call(w.arena.id(), "settle_lifecycle_battle")
        .args_json(json!({"battle_id": w.battle_id.to_string(), "max_entitlements": batch}))
        .deposit(NearToken::from_millinear(100))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(result.json::<u32>()?)
}

async fn entitlement(backing: &Contract, account: &Account) -> anyhow::Result<String> {
    Ok(backing
        .view("entitlement_of")
        .args_json(json!({"account": account.id()}))
        .await?
        .json()?)
}

async fn progress(w: &World) -> anyhow::Result<Value> {
    Ok(w.arena
        .view("get_settlement_progress")
        .args_json(json!({"battle_id": w.battle_id.to_string()}))
        .await?
        .json()?)
}

#[tokio::test]
async fn anyone_settles_the_losing_vault_into_conserved_entitlements_once() -> anyhow::Result<()> {
    let w = world().await?;
    assert_eq!(progress(&w).await?, json!({"recorded": 0, "total": 4}));
    // Nothing moves before the call, and the caller cannot change the outcome.
    assert_eq!(entitlement(&w.backing_b, &w.alice).await?, "0");
    assert_eq!(settle(&w, 15).await?, 4);
    // 100000 B units: alice 59940 + creator fee 50, bob 39960, protocol 50.
    assert_eq!(entitlement(&w.backing_b, &w.alice).await?, "59990");
    assert_eq!(entitlement(&w.backing_b, &w.bob).await?, "39960");
    assert_eq!(entitlement(&w.backing_b, &w.treasury).await?, "50");
    assert_eq!(progress(&w).await?, json!({"recorded": 4, "total": 4}));
    let ledger: Value = w
        .backing_b
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["custody"], "100000");
    assert_eq!(ledger["entitlements"], "100000");
    assert_eq!(ledger["minted"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    // The winning vault stays minted and held by the arena for the DAO decision.
    let winning: Value = w
        .backing_a
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(winning["minted"], "1000");
    assert_eq!(winning["entitlements"], "0");
    // Repeating changes nothing.
    assert_eq!(settle(&w, 15).await?, 4);
    assert_eq!(entitlement(&w.backing_b, &w.alice).await?, "59990");
    Ok(())
}

#[tokio::test]
async fn batches_advance_the_cursor_and_finish_with_identical_amounts() -> anyhow::Result<()> {
    let w = world().await?;
    assert_eq!(settle(&w, 3).await?, 3);
    assert_eq!(progress(&w).await?, json!({"recorded": 3, "total": 4}));
    assert_eq!(settle(&w, 3).await?, 4);
    assert_eq!(progress(&w).await?, json!({"recorded": 4, "total": 4}));
    assert_eq!(entitlement(&w.backing_b, &w.alice).await?, "59990");
    assert_eq!(entitlement(&w.backing_b, &w.bob).await?, "39960");
    assert_eq!(entitlement(&w.backing_b, &w.treasury).await?, "50");
    let ledger: Value = w
        .backing_b
        .view("get_ledger")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(ledger["accounting_balanced"], true);
    // A batch with too little deposit is refused before any call is made.
    let w2 = world().await?;
    let short = w2
        .stranger
        .call(w2.arena.id(), "settle_lifecycle_battle")
        .args_json(json!({"battle_id": w2.battle_id.to_string(), "max_entitlements": 4}))
        .deposit(NearToken::from_millinear(10))
        .max_gas()
        .transact()
        .await?;
    assert!(short.into_result().is_err());
    assert_eq!(progress(&w2).await?, json!({"recorded": 0, "total": 4}));
    Ok(())
}
