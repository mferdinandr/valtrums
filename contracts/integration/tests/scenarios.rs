mod common;

use common::*;
use serde_json::json;

/// DAO escrow: the winning principal is locked, a recorded decision disposes
/// it exactly once, and the verifier confirms after execution evidence.
#[tokio::test]
async fn dao_escrow_is_disposed_exactly_once_after_a_recorded_decision() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    let bob = env.user("bob").await?;
    let carol = env.user("carol").await?;
    env.grant_representation(&alice, &env.backing_a, 500, 1)
        .await?;
    env.grant_representation(&bob, &env.backing_a, 500, 2)
        .await?;
    env.grant_representation(&carol, &env.backing_b, 1000, 3)
        .await?;
    let id = env.create_and_audit(&alice).await?;
    env.deposit(&alice, &env.backing_a, 500, id, 0)
        .await?
        .into_result()?;
    env.deposit(&bob, &env.backing_a, 500, id, 0)
        .await?
        .into_result()?;
    env.deposit(&carol, &env.backing_b, 1000, id, 1)
        .await?
        .into_result()?;
    env.lock(id).await?;
    env.submit_prices(id, 110, 105).await?;
    env.resolve(id).await?;
    assert_eq!(env.battle(id).await?["winner"], json!(0));

    // the winner vault (1000 units of token a) entered escrow
    let escrow = env.arena_view("escrow", json!({ "battle_id": id })).await?;
    assert_eq!(escrow["principal"].as_str(), Some("1000"));
    assert_eq!(escrow["status"], "Escrowed");

    // only the owner records a decision; only one per battle
    let forged = env
        .arena_call(
            &bob,
            "record_decision",
            json!({
                "battle_id": id, "kind": "Burn", "decision_ref": "gov-0",
            }),
        )
        .await?;
    assert!(forged.into_result().is_err(), "owner only");

    // confirmation before the disposal exists is refused
    let early = env
        .arena_call(&env.auditor, "confirm_disposal", json!({ "battle_id": id }))
        .await?;
    assert!(early.into_result().is_err(), "nothing is disposing yet");

    env.arena_call(
        &env.owner,
        "record_decision",
        json!({
            "battle_id": id, "kind": "Burn", "decision_ref": "gov-1",
        }),
    )
    .await?
    .into_result()?;
    let dup = env
        .arena_call(
            &env.owner,
            "record_decision",
            json!({
                "battle_id": id, "kind": "Burn", "decision_ref": "gov-2",
            }),
        )
        .await?;
    assert!(dup.into_result().is_err(), "one decision per battle");

    // disposal burns the arena's representations: M -> D
    env.arena_call(&env.owner, "dispose_principal", json!({ "battle_id": id }))
        .await?
        .into_result()?;
    let ledger = env.ledger(&env.backing_a).await?;
    assert_eq!(
        ledger["disposals_reserved"].as_str(),
        Some("1000"),
        "ledger: {ledger}"
    );
    assert_eq!(
        ledger["supply"].as_str(),
        Some("0"),
        "the arena's vault was burned"
    );
    assert!(env.invariant_holds(&env.backing_a).await?);
    assert_eq!(
        env.arena_view("escrow", json!({ "battle_id": id })).await?["status"],
        "Disposing"
    );

    // the verifier confirms with matching execution evidence
    let auditor_ledger = env.ledger(&env.backing_a).await?;
    let _ = auditor_ledger;
    env.arena_call(&env.auditor, "confirm_disposal", json!({ "battle_id": id }))
        .await?
        .into_result()?;
    assert_eq!(
        env.arena_view("escrow", json!({ "battle_id": id })).await?["status"],
        "Disposed"
    );
    let decision = env
        .arena_view("decision", json!({ "battle_id": id }))
        .await?;
    assert_eq!(decision["consumed"], true);

    // a second disposal is refused: the decision is consumed and D is spent
    let again = env
        .arena_call(&env.owner, "dispose_principal", json!({ "battle_id": id }))
        .await?;
    assert!(
        again.into_result().is_err(),
        "disposal happens exactly once"
    );
    Ok(())
}

/// A player-agent grant is spent on-chain: deposits by the agent under the
/// grant decrement the budget and the budget is an upper bound.
#[tokio::test]
async fn grant_budget_bounds_agent_deposits() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    let bob = env.user("bob").await?;
    env.grant_representation(&bob, &env.backing_a, 1000, 1)
        .await?;
    let id = env.create_and_audit(&alice).await?;
    let now = env.now().await?;

    let grant_id: u64 = env
        .arena_call(
            &alice,
            "create_grant",
            json!({
                "agent": bob.id(),
                "budget": [[env.backing_a.id(), "100"]],
                "methods": ["deposit"],
                "chains": [CHAIN_ID],
                "assets": [env.backing_a.id()],
                "expires_at_ns": (now + 3_600_000_000_000).to_string(),
            }),
        )
        .await?
        .json()?;
    assert_eq!(grant_id, 1);

    let deposit_with_grant = |amount: u128| {
        bob.call(env.backing_a.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": env.arena.id(),
                "amount": amount.to_string(),
                "memo": None::<String>,
                "msg": json!({ "battle_id": id, "community_index": 0, "grant_id": grant_id }).to_string(),
            }))
            .deposit(yocto())
            .max_gas()
            .transact()
    };

    // 30 within the 100 budget
    deposit_with_grant(30).await?.into_result()?;
    let grant = env
        .arena_view("grant", json!({ "grant_id": grant_id }))
        .await?;
    assert_eq!(grant["budget"][0][1].as_str(), Some("70"), "grant: {grant}");
    assert_eq!(
        env.arena_view(
            "position",
            json!({
                "battle_id": id, "community_index": 0, "account_id": bob.id(),
            })
        )
        .await?,
        json!("30")
    );

    // 80 exceeds the remaining 70: the arena refuses and the funds return
    deposit_with_grant(80).await?.into_result()?;
    let grant = env
        .arena_view("grant", json!({ "grant_id": grant_id }))
        .await?;
    assert_eq!(
        grant["budget"][0][1].as_str(),
        Some("70"),
        "budget unchanged"
    );
    assert_eq!(
        env.balance(&env.backing_a, &bob.id().clone()).await?,
        1000 - 30
    );
    assert_eq!(
        env.battle(id).await?["communities"][0]["vault"].as_str(),
        Some("30")
    );

    // an expired grant refuses too
    let expired: u64 = env
        .arena_call(
            &alice,
            "create_grant",
            json!({
                "agent": bob.id(),
                "budget": [[env.backing_a.id(), "100"]],
                "methods": ["deposit"],
                "chains": [CHAIN_ID],
                "assets": [env.backing_a.id()],
                "expires_at_ns": (now - 1).to_string(),
            }),
        )
        .await?
        .json()?;
    bob.call(env.backing_a.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": env.arena.id(),
            "amount": "10",
            "memo": None::<String>,
            "msg": json!({ "battle_id": id, "community_index": 0, "grant_id": expired }).to_string(),
        }))
        .deposit(yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let grant = env
        .arena_view("grant", json!({ "grant_id": expired }))
        .await?;
    assert_eq!(
        grant["budget"][0][1].as_str(),
        Some("100"),
        "expired grant not spent"
    );
    Ok(())
}

/// The independent LP gate: below the USD 10,000 floor the approval stays
/// Pending and the battle cannot lock.
#[tokio::test]
async fn lp_below_the_minimum_holds_the_approval_pending() -> anyhow::Result<()> {
    let env = Env::new().await?;
    let alice = env.user("alice").await?;
    let id = env
        .arena_call(
            &alice,
            "create_battle",
            json!({
                "mode": "PriceGain",
                "communities": [
                    token_identity("a", env.backing_a.id()),
                    token_identity("b", env.backing_b.id()),
                ],
                "protocol_created": false,
            }),
        )
        .await?
        .json::<u64>()?;

    // community 0 has a passing GoPlus check but an LP below the floor
    env.arena_call(
        &env.auditor,
        "submit_audit",
        json!({
            "battle_id": id,
            "community_index": 0,
            "goplus": env.goplus_pass("a").await?,
            "lp": {
                "usd_value_scaled": "9999999999",
                "source": "lpsource",
                "observed_at_ns": env.now().await?.to_string(),
                "evidence_hash": "h",
            },
        }),
    )
    .await?
    .into_result()?;
    env.arena_call(
        &env.auditor,
        "submit_audit",
        json!({
            "battle_id": id,
            "community_index": 1,
            "goplus": env.goplus_pass("b").await?,
            "lp": env.lp_pass().await?,
        }),
    )
    .await?
    .into_result()?;
    assert_eq!(
        env.status(id).await?,
        "Proposed",
        "below the floor holds Pending"
    );

    let deposits = env.deposit(&alice, &env.backing_a, 100, id, 0).await?;
    let _ = deposits;
    let lock = env
        .arena_call(&env.auditor, "lock", json!({ "battle_id": id }))
        .await?;
    assert!(
        lock.into_result().is_err(),
        "an unapproved battle cannot lock"
    );

    // fresh evidence above the floor approves the battle
    env.arena_call(
        &env.auditor,
        "submit_audit",
        json!({
            "battle_id": id,
            "community_index": 0,
            "goplus": env.goplus_pass("a").await?,
            "lp": env.lp_pass().await?,
        }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(id).await?, "Approved");
    Ok(())
}
