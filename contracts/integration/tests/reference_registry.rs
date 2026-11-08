mod common;

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

// Fixture mappings exercise the deployed contract's registry only. They are not
// verified Robinhood mainnet reference tokens.

const MOCK: &str = "0x0000000000000000000000000000000000000001";
const REFERENCE: &str = "0x00000000000000000000000000000000000000BB";

fn asset(index: u32, representation: &str, reference: Option<&str>) -> Value {
    let mut value = json!({
        "chain_id": "46630",
        "token_address": format!("0x{index:040x}"),
        "representation": representation,
        "custody_domain": "fixture",
    });
    if let Some(reference) = reference {
        value["reference_chain_id"] = json!("4663");
        value["reference_address"] = json!(reference);
    }
    value
}

#[tokio::test]
async fn owner_controlled_registry_gates_reference_pairs_at_creation() -> anyhow::Result<()> {
    let env = common::Env::new(60, false).await?;
    env.arena_call_yocto(&env.owner, "activate_lifecycle", json!({}))
        .await?
        .into_result()?;
    env.arena_call_yocto(
        &env.owner,
        "set_lifecycle_protocol",
        json!({"protocol": env.treasury.id()}),
    )
    .await?
    .into_result()?;
    let creator = env.user("registry-creator").await?;
    let pepe = env.pepe.id().to_string();
    let shib = env.shib.id().to_string();
    let entry = json!({
        "chain_id": "46630",
        "token_address": MOCK,
        "reference_chain_id": "4663",
        "reference_address": REFERENCE,
    });

    // A creator cannot add an entry.
    assert!(env
        .arena_call_yocto(&creator, "add_reference_entry", entry.clone())
        .await?
        .into_result()
        .is_err());

    let create = |assets: Vec<Value>| {
        creator
            .call(env.arena.id(), "create_lifecycle_battle")
            .args_json(json!({ "mode": "PriceGain", "assets": assets }))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
    };
    // Self-declared before registration: refused.
    assert!(create(vec![
        asset(1, &pepe, Some(REFERENCE)),
        asset(2, &shib, None)
    ])
    .await?
    .into_result()
    .is_err());

    env.arena_call_yocto(&env.owner, "add_reference_entry", entry.clone())
        .await?
        .into_result()?;
    // Duplicate registration: refused.
    assert!(env
        .arena_call_yocto(&env.owner, "add_reference_entry", entry)
        .await?
        .into_result()
        .is_err());

    let page = env.arena_view("get_reference_registry", json!({})).await?;
    assert_eq!(page["version"], "1");
    assert_eq!(page["total"], 1);
    assert_eq!(
        page["entries"][0]["reference_address"],
        REFERENCE.to_ascii_lowercase()
    );
    assert_eq!(
        page["entries"][0]["entry_hash"].as_str().map(str::len),
        Some(64)
    );

    // Registered pair is accepted; a registered token without its pair is refused.
    let created: u64 = create(vec![
        asset(1, &pepe, Some(REFERENCE)),
        asset(2, &shib, None),
    ])
    .await?
    .into_result()?
    .json()?;
    assert_eq!(created, 1);
    assert!(create(vec![asset(1, &pepe, None), asset(2, &shib, None)])
        .await?
        .into_result()
        .is_err());
    Ok(())
}
