mod common;

use common::*;
use serde_json::json;

const PRICE: u128 = COIN; // 1.00 USD per coin, scaled by 1e18

async fn exec_step(env: &Env, index: u32, min_out: u128) -> anyhow::Result<()> {
    env.arena_call(
        &env.agent,
        "execute_step",
        json!({ "battle_id": 1, "step_index": index, "min_out": min_out.to_string() }),
    )
    .await?
    .into_result()?;
    Ok(())
}

#[tokio::test]
async fn a_full_battle_runs_end_to_end_and_conserves_funds() -> anyhow::Result<()> {
    let env = Env::new(5, true).await?;
    // DEX: 1 USDC buys 1000 PEPE, and 160 SHIB sell for 40 USDC; liquidity both ways
    env.set_rate(&env.usdc, &env.pepe, USDC_TO_COIN_NUM, 1)
        .await?;
    env.set_rate(&env.shib, &env.usdc, 1, 4_000_000_000_000)
        .await?;
    env.add_liquidity(&env.pepe, 1_000_000 * COIN).await?;
    env.add_liquidity(&env.usdc, 1_000 * USDC).await?;

    let alice = env.user("alice").await?; // creator
    let bob = env.user("bob").await?; // side A, deposits PEPE directly
    let carol = env.user("carol").await?; // side B, deposits SHIB directly
    let dave = env.user("dave").await?; // side A, deposits USDC through router and DEX

    // ── proposal and audit ──
    assert_eq!(env.propose(&alice, 10).await?, 1);
    assert_eq!(env.status(1).await?, "Proposed");
    env.arena_call(&env.agent, "approve_battle", json!({ "battle_id": 1 }))
        .await?
        .into_result()?;
    assert_eq!(env.status(1).await?, "Approved");

    // ── deposits ──
    env.mint(&env.pepe, bob.id(), 400 * COIN).await?;
    env.transfer_call(
        &bob,
        &env.pepe,
        env.arena.id(),
        400 * COIN,
        json!({ "action": "deposit", "battle_id": 1, "side": "A" }),
    )
    .await?
    .into_result()?;
    env.mint(&env.shib, carol.id(), 160 * COIN).await?;
    env.transfer_call(
        &carol,
        &env.shib,
        env.arena.id(),
        160 * COIN,
        json!({ "action": "deposit", "battle_id": 1, "side": "B" }),
    )
    .await?
    .into_result()?;

    // the four-hop swap: user -> usdc -> arena -> router -> dex -> router -> arena
    env.mint(&env.usdc, dave.id(), 50 * USDC).await?;
    env.transfer_call(
        &dave,
        &env.usdc,
        env.arena.id(),
        50 * USDC,
        json!({
            "action": "deposit_usdc",
            "battle_id": 1,
            "side": "A",
            "total_usdc": (50 * USDC).to_string(),
            "min_token_out": "1",
        }),
    )
    .await?
    .into_result()?;
    let position = env
        .arena_view(
            "get_position",
            json!({ "battle_id": 1, "account_id": dave.id() }),
        )
        .await?;
    assert_eq!(amount(&position["coin_amount"]), 50_000 * COIN);
    assert_eq!(amount(&position["usdc_equiv"]), 50 * USDC);
    assert_eq!(env.balance(&env.usdc, dave.id()).await?, 0);

    let battle = env.battle(1).await?;
    assert_eq!(amount(&battle["vault_a"]), 50_400 * COIN);
    assert_eq!(amount(&battle["vault_b"]), 160 * COIN);

    // ── lock, live, settle ──
    env.advance_to(amount(&battle["deposit_deadline_ns"]) as u64)
        .await?;
    env.arena_call(
        &env.agent,
        "set_initial_prices",
        json!({ "battle_id": 1, "price_a": PRICE.to_string(), "price_b": PRICE.to_string() }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(1).await?, "Live");

    let end = amount(&env.battle(1).await?["end_time_ns"]) as u64;
    env.advance_to(end).await?;
    env.arena_call(
        &env.agent,
        "settle_battle",
        json!({
            "battle_id": 1,
            "final_price_a": (PRICE * 12 / 10).to_string(), // +20%
            "final_price_b": (PRICE * 105 / 100).to_string(), // +5%
        }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(1).await?, "Settling");
    assert_eq!(env.battle(1).await?["winner"], "A");

    // ── execution through the DEX ──
    exec_step(&env, 0, 30 * USDC).await?; // dump 160 SHIB -> 40 USDC
    let plan = env
        .arena_view("get_settlement_plan", json!({ "battle_id": 1 }))
        .await?;
    assert_eq!(plan.as_array().map(Vec::len), Some(4));
    assert_eq!(amount(&plan[0]["realized"]), 40 * USDC);
    assert_eq!(amount(&plan[1]["amount"]), 22 * USDC); // 55%
    assert_eq!(amount(&plan[2]["amount"]), 2 * USDC); // 5% burn
    assert_eq!(amount(&plan[3]["amount"]), 2 * USDC); // 5% fee
    exec_step(&env, 1, 1).await?;
    exec_step(&env, 2, 1).await?;
    exec_step(&env, 3, 1).await?;
    assert_eq!(env.status(1).await?, "Settled");
    assert_eq!(env.balance(&env.pepe, env.burn.id()).await?, 2_000 * COIN);

    // ── claims and withdrawals ──
    let winner_vault = 50_400 * COIN;
    let liquid_pool = 22_000 * COIN; // 22 USDC bought at 1000 PEPE each
    let credit_pool = 14 * USDC;
    let mut paid = 0;
    let mut credit_total = 0;
    for (user, stake) in [(&bob, 400 * COIN), (&dave, 50_000 * COIN)] {
        env.arena_call(user, "claim", json!({ "battle_id": 1 }))
            .await?
            .into_result()?;
        let expected = stake + mul_div(stake, liquid_pool, winner_vault);
        assert_eq!(env.liquid(user.id(), &env.pepe).await?, expected);
        let account = env
            .arena_view("get_account", json!({ "account_id": user.id() }))
            .await?;
        let credit = mul_div(stake, credit_pool, winner_vault);
        assert_eq!(amount(&account["credit_balance"]), credit);
        credit_total += credit;

        env.arena_call_yocto(
            user,
            "withdraw_liquid",
            json!({ "token": env.pepe.id(), "amount": expected.to_string() }),
        )
        .await?
        .into_result()?;
        assert_eq!(env.balance(&env.pepe, user.id()).await?, expected);
        assert_eq!(env.liquid(user.id(), &env.pepe).await?, 0);
        paid += expected;
    }

    // the loser cannot claim
    let loser_claim = env
        .arena_call(&carol, "claim", json!({ "battle_id": 1 }))
        .await?;
    assert!(loser_claim.into_result().is_err());

    // PEPE: only rounding dust is left in the arena
    let dust = env.balance(&env.pepe, env.arena.id()).await?;
    assert_eq!(dust, winner_vault + liquid_pool - paid);
    assert!(dust <= 2, "dust was {dust}");

    // USDC: bond (liquid) + credit pool + fee; then the bond and fee leave
    assert_eq!(
        env.balance(&env.usdc, env.arena.id()).await?,
        BOND + credit_pool + 2 * USDC
    );
    env.arena_call_yocto(
        &alice,
        "withdraw_liquid",
        json!({ "token": env.usdc.id(), "amount": BOND.to_string() }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.balance(&env.usdc, alice.id()).await?, BOND);
    env.arena_call(&alice, "flush_treasury", json!({}))
        .await?
        .into_result()?;
    assert_eq!(env.balance(&env.usdc, env.treasury.id()).await?, 2 * USDC);
    let left = env.balance(&env.usdc, env.arena.id()).await?;
    assert_eq!(left, credit_pool, "the arena keeps exactly the credit pool");
    assert!(credit_pool - credit_total <= 2);
    Ok(())
}
