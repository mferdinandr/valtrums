mod common;

use common::*;
use near_workspaces::Account;
use serde_json::json;

const PRICE: u128 = COIN; // 1.00 USD per coin, scaled by 1e18

/// Proposes and approves battle `expected_id` (PEPE vs SHIB, 10 s long).
async fn open_battle(env: &Env, creator: &Account, expected_id: u64) -> anyhow::Result<()> {
    assert_eq!(env.propose(creator, 10).await?, expected_id);
    env.arena_call(
        &env.agent,
        "approve_battle",
        json!({ "battle_id": expected_id }),
    )
    .await?
    .into_result()?;
    Ok(())
}

/// Direct deposit of the side's own coin.
async fn deposit(
    env: &Env,
    user: &Account,
    id: u64,
    side: &str,
    amount: u128,
) -> anyhow::Result<()> {
    let token = if side == "A" { &env.pepe } else { &env.shib };
    env.mint(token, user.id(), amount).await?;
    env.transfer_call(
        user,
        token,
        env.arena.id(),
        amount,
        json!({ "action": "deposit", "battle_id": id, "side": side }),
    )
    .await?
    .into_result()?;
    Ok(())
}

/// Waits for the deposit window to close, then locks the battle at equal prices.
async fn lock(env: &Env, id: u64) -> anyhow::Result<()> {
    let deadline = amount(&env.battle(id).await?["deposit_deadline_ns"]) as u64;
    env.advance_to(deadline).await?;
    env.arena_call(
        &env.agent,
        "set_initial_prices",
        json!({ "battle_id": id, "price_a": PRICE.to_string(), "price_b": PRICE.to_string() }),
    )
    .await?
    .into_result()?;
    Ok(())
}

/// Waits for the end and submits final prices (as multiples of `PRICE` in percent).
async fn settle(env: &Env, id: u64, final_a_pct: u128, final_b_pct: u128) -> anyhow::Result<()> {
    let end = amount(&env.battle(id).await?["end_time_ns"]) as u64;
    env.advance_to(end).await?;
    env.arena_call(
        &env.agent,
        "settle_battle",
        json!({
            "battle_id": id,
            "final_price_a": (PRICE * final_a_pct / 100).to_string(),
            "final_price_b": (PRICE * final_b_pct / 100).to_string(),
        }),
    )
    .await?
    .into_result()?;
    Ok(())
}

async fn exec_all_steps(env: &Env, id: u64, dump_min_out: u128) -> anyhow::Result<()> {
    for (index, min_out) in [(0u32, dump_min_out), (1, 1), (2, 1), (3, 1)] {
        env.arena_call(
            &env.agent,
            "execute_step",
            json!({ "battle_id": id, "step_index": index, "min_out": min_out.to_string() }),
        )
        .await?
        .into_result()?;
    }
    Ok(())
}

/// DEX with 1 USDC = 1000 PEPE and 4e12 SHIB = 1 USDC, plenty of liquidity.
async fn liquid_dex(env: &Env) -> anyhow::Result<()> {
    env.set_rate(&env.usdc, &env.pepe, USDC_TO_COIN_NUM, 1)
        .await?;
    env.set_rate(&env.shib, &env.usdc, 1, 4_000_000_000_000)
        .await?;
    env.add_liquidity(&env.pepe, 1_000_000 * COIN).await?;
    env.add_liquidity(&env.usdc, 1_000 * USDC).await?;
    Ok(())
}

async fn refund_and_withdraw(
    env: &Env,
    user: &Account,
    id: u64,
    token: &near_workspaces::Contract,
    expected: u128,
) -> anyhow::Result<()> {
    env.arena_call(user, "withdraw_initial_deposit", json!({ "battle_id": id }))
        .await?
        .into_result()?;
    assert_eq!(env.liquid(user.id(), token).await?, expected);
    env.arena_call_yocto(
        user,
        "withdraw_liquid",
        json!({ "token": token.id(), "amount": expected.to_string() }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.balance(token, user.id()).await?, expected);
    Ok(())
}

#[tokio::test]
async fn an_emergency_halt_refunds_everyone_in_full() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob, carol) = (
        env.user("alice").await?,
        env.user("bob").await?,
        env.user("carol").await?,
    );
    open_battle(&env, &alice, 1).await?;
    deposit(&env, &bob, 1, "A", 400 * COIN).await?;
    deposit(&env, &carol, 1, "B", 160 * COIN).await?;
    lock(&env, 1).await?;

    env.arena_call(
        &env.agent,
        "emergency_halt",
        json!({ "battle_id": 1, "reason": "liquidity drop" }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(1).await?, "EmergencyHalted");

    refund_and_withdraw(&env, &bob, 1, &env.pepe, 400 * COIN).await?;
    refund_and_withdraw(&env, &carol, 1, &env.shib, 160 * COIN).await?;
    // nothing was paid out as reward, burned, or taken as a fee
    assert_eq!(env.balance(&env.pepe, env.arena.id()).await?, 0);
    assert_eq!(env.balance(&env.shib, env.arena.id()).await?, 0);
    let config = env.arena_view("get_config", json!({})).await?;
    assert_eq!(amount(&config["treasury_accrued"]), 0);
    // the creator's bond is returned
    assert_eq!(env.liquid(alice.id(), &env.usdc).await?, BOND);
    // a halted battle cannot be settled afterwards
    let late = env
        .arena_call(
            &env.agent,
            "settle_battle",
            json!({ "battle_id": 1, "final_price_a": "1", "final_price_b": "1" }),
        )
        .await?;
    assert!(late.into_result().is_err());
    Ok(())
}

#[tokio::test]
async fn a_tie_voids_the_battle_and_refunds_everyone() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob, carol) = (
        env.user("alice").await?,
        env.user("bob").await?,
        env.user("carol").await?,
    );
    open_battle(&env, &alice, 1).await?;
    deposit(&env, &bob, 1, "A", 400 * COIN).await?;
    deposit(&env, &carol, 1, "B", 160 * COIN).await?;
    lock(&env, 1).await?;
    settle(&env, 1, 110, 110).await?;
    assert_eq!(env.status(1).await?, "Voided");

    refund_and_withdraw(&env, &bob, 1, &env.pepe, 400 * COIN).await?;
    refund_and_withdraw(&env, &carol, 1, &env.shib, 160 * COIN).await?;
    assert_eq!(env.liquid(alice.id(), &env.usdc).await?, BOND);
    Ok(())
}

#[tokio::test]
async fn a_failed_audit_seizes_the_bond_and_refuses_deposits() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob) = (env.user("alice").await?, env.user("bob").await?);
    assert_eq!(env.propose(&alice, 10).await?, 1);
    env.arena_call(
        &env.agent,
        "void_battle",
        json!({ "battle_id": 1, "reason": "honeypot" }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.status(1).await?, "Voided");

    // the bond is the treasury's, paid out on request
    env.arena_call(&bob, "flush_treasury", json!({}))
        .await?
        .into_result()?;
    assert_eq!(env.balance(&env.usdc, env.treasury.id()).await?, BOND);
    assert_eq!(env.balance(&env.usdc, alice.id()).await?, 0);
    assert_eq!(env.liquid(alice.id(), &env.usdc).await?, 0);

    // a deposit into a voided battle comes back untouched
    env.mint(&env.pepe, bob.id(), 100 * COIN).await?;
    env.transfer_call(
        &bob,
        &env.pepe,
        env.arena.id(),
        100 * COIN,
        json!({ "action": "deposit", "battle_id": 1, "side": "A" }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.balance(&env.pepe, bob.id()).await?, 100 * COIN);
    assert_eq!(env.balance(&env.pepe, env.arena.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn a_battle_with_an_empty_side_is_voided_at_lock() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob) = (env.user("alice").await?, env.user("bob").await?);
    open_battle(&env, &alice, 1).await?;
    deposit(&env, &bob, 1, "A", 400 * COIN).await?;
    lock(&env, 1).await?;
    assert_eq!(env.status(1).await?, "Voided");

    refund_and_withdraw(&env, &bob, 1, &env.pepe, 400 * COIN).await?;
    // a battle nobody joined forfeits its bond
    let config = env.arena_view("get_config", json!({})).await?;
    assert_eq!(amount(&config["treasury_accrued"]), BOND);
    assert_eq!(env.liquid(alice.id(), &env.usdc).await?, 0);
    Ok(())
}

#[tokio::test]
async fn unauthorized_callers_are_refused() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob) = (env.user("alice").await?, env.user("bob").await?);
    assert_eq!(env.propose(&alice, 10).await?, 1);

    // agent-only
    for (method, args) in [
        ("approve_battle", json!({ "battle_id": 1 })),
        ("void_battle", json!({ "battle_id": 1, "reason": "x" })),
        (
            "set_initial_prices",
            json!({ "battle_id": 1, "price_a": "1", "price_b": "1" }),
        ),
        (
            "settle_battle",
            json!({ "battle_id": 1, "final_price_a": "1", "final_price_b": "1" }),
        ),
        ("emergency_halt", json!({ "battle_id": 1, "reason": "x" })),
    ] {
        let result = env.arena_call(&bob, method, args).await?;
        assert!(result.into_result().is_err(), "{method} must be agent-only");
    }
    // owner-only
    for (method, args) in [
        ("add_agent", json!({ "account_id": bob.id() })),
        ("set_router", json!({ "router": bob.id() })),
        ("set_paused", json!({ "paused": true })),
        ("set_treasury", json!({ "treasury": bob.id() })),
    ] {
        let result = env.arena_call(&bob, method, args).await?;
        assert!(result.into_result().is_err(), "{method} must be owner-only");
    }
    // callbacks are private to the contract
    for (method, args) in [
        ("on_treasury_flushed", json!({ "amount": "1" })),
        (
            "on_liquid_paid",
            json!({ "account_id": bob.id(), "token": env.pepe.id(), "amount": "1" }),
        ),
    ] {
        let result = env.arena_call(&bob, method, args).await?;
        assert!(result.into_result().is_err(), "{method} must be private");
    }
    assert_eq!(env.status(1).await?, "Proposed");
    Ok(())
}

#[tokio::test]
async fn a_paused_arena_returns_deposits_but_still_refunds() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    let (alice, bob, carol) = (
        env.user("alice").await?,
        env.user("bob").await?,
        env.user("carol").await?,
    );
    open_battle(&env, &alice, 1).await?;
    deposit(&env, &bob, 1, "A", 400 * COIN).await?;

    env.owner
        .call(env.arena.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .transact()
        .await?
        .into_result()?;
    // new deposits bounce
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
    assert_eq!(env.balance(&env.shib, carol.id()).await?, 160 * COIN);

    // the agent can still halt, and the refund path stays open while paused
    env.arena_call(
        &env.agent,
        "emergency_halt",
        json!({ "battle_id": 1, "reason": "rug" }),
    )
    .await?
    .into_result()?;
    refund_and_withdraw(&env, &bob, 1, &env.pepe, 400 * COIN).await?;
    Ok(())
}

#[tokio::test]
async fn winnings_credit_funds_the_next_battle_and_the_principal_breaks_the_loop(
) -> anyhow::Result<()> {
    let env = Env::new(5, true).await?;
    liquid_dex(&env).await?;
    let (alice, bob, carol) = (
        env.user("alice").await?,
        env.user("bob").await?,
        env.user("carol").await?,
    );

    // battle 1: bob (A, alone on his side) beats carol (B)
    open_battle(&env, &alice, 1).await?;
    deposit(&env, &bob, 1, "A", 400 * COIN).await?;
    deposit(&env, &carol, 1, "B", 160 * COIN).await?;
    lock(&env, 1).await?;
    settle(&env, 1, 120, 105).await?;
    exec_all_steps(&env, 1, 30 * USDC).await?;
    assert_eq!(env.status(1).await?, "Settled");
    env.arena_call(&bob, "claim", json!({ "battle_id": 1 }))
        .await?
        .into_result()?;
    let account = env
        .arena_view("get_account", json!({ "account_id": bob.id() }))
        .await?;
    assert_eq!(amount(&account["credit_balance"]), 14 * USDC); // 35% of 40 USDC

    // battle 2: bob spends exactly that credit, no wallet funds needed
    open_battle(&env, &alice, 2).await?;
    env.arena_call_yocto(
        &bob,
        "deposit_with_credit",
        json!({
            "battle_id": 2,
            "side": "A",
            "total_usdc": (14 * USDC).to_string(),
            "min_token_out": "1",
        }),
    )
    .await?
    .into_result()?;
    let position = env
        .arena_view(
            "get_position",
            json!({ "battle_id": 2, "account_id": bob.id() }),
        )
        .await?;
    assert_eq!(amount(&position["coin_amount"]), 14_000 * COIN);
    assert_eq!(amount(&position["from_credit"]), 14 * USDC);
    let account = env
        .arena_view("get_account", json!({ "account_id": bob.id() }))
        .await?;
    assert_eq!(amount(&account["credit_balance"]), 0);

    // carol bets 100 SHIB on side B of battle 2; bob wins again
    deposit(&env, &carol, 2, "B", 100 * COIN).await?;
    lock(&env, 2).await?;
    settle(&env, 2, 130, 90).await?;
    exec_all_steps(&env, 2, 20 * USDC).await?;
    assert_eq!(env.status(2).await?, "Settled");

    env.arena_call(&bob, "claim", json!({ "battle_id": 2 }))
        .await?
        .into_result()?;
    // 100 SHIB sell for 25 USDC: 55% = 13.75 buys 13,750 PEPE of reward
    let reward = 13_750 * COIN;
    let principal = 14_000 * COIN;
    let before = env.liquid(bob.id(), &env.pepe).await?;
    // bob also holds the first battle's payout (400 PEPE + reward) in the liquid balance
    assert!(before >= principal + reward);
    // the principal, including the part that was credit, came back fully liquid;
    // only the profit created new credit: 35% of 25 USDC
    let account = env
        .arena_view("get_account", json!({ "account_id": bob.id() }))
        .await?;
    assert_eq!(amount(&account["credit_balance"]), 8_750_000);
    Ok(())
}

#[tokio::test]
async fn deposits_from_the_internal_balance_need_no_attached_deposit() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    liquid_dex(&env).await?;
    let (alice, bob) = (env.user("alice").await?, env.user("bob").await?);
    open_battle(&env, &alice, 1).await?;

    // one approval to fund the balance ...
    env.mint(&env.usdc, bob.id(), 20 * USDC).await?;
    env.transfer_call(
        &bob,
        &env.usdc,
        env.arena.id(),
        20 * USDC,
        json!({ "action": "fund_balance" }),
    )
    .await?
    .into_result()?;
    assert_eq!(env.liquid(bob.id(), &env.usdc).await?, 20 * USDC);

    // ... then deposits with no deposit attached (what a scoped session key can do)
    env.arena_call(
        &bob,
        "deposit_from_balance",
        json!({
            "battle_id": 1,
            "side": "A",
            "total_usdc": (20 * USDC).to_string(),
            "min_token_out": "1",
        }),
    )
    .await?
    .into_result()?;
    let position = env
        .arena_view(
            "get_position",
            json!({ "battle_id": 1, "account_id": bob.id() }),
        )
        .await?;
    assert_eq!(amount(&position["coin_amount"]), 20_000 * COIN);
    assert_eq!(env.liquid(bob.id(), &env.usdc).await?, 0);

    // a deposit beyond the balance is refused and changes nothing
    let refused = env
        .arena_call(
            &bob,
            "deposit_from_balance",
            json!({
                "battle_id": 1,
                "side": "A",
                "total_usdc": (5 * USDC).to_string(),
                "min_token_out": "1",
            }),
        )
        .await?;
    assert!(refused.into_result().is_err());
    Ok(())
}

#[tokio::test]
async fn a_swap_below_the_minimum_output_refunds_the_user_and_the_credit() -> anyhow::Result<()> {
    let env = Env::new(5, false).await?;
    liquid_dex(&env).await?;
    let (alice, dave) = (env.user("alice").await?, env.user("dave").await?);
    open_battle(&env, &alice, 1).await?;

    env.mint(&env.usdc, dave.id(), 50 * USDC).await?;
    // demands far more PEPE than the 50,000 the DEX would give
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
            "min_token_out": (60_000 * COIN).to_string(),
        }),
    )
    .await?
    .into_result()?;
    // everything came back, nothing was deposited
    assert_eq!(env.balance(&env.usdc, dave.id()).await?, 50 * USDC);
    let position = env
        .arena_view(
            "get_position",
            json!({ "battle_id": 1, "account_id": dave.id() }),
        )
        .await?;
    assert!(position.is_null());
    assert_eq!(amount(&env.battle(1).await?["vault_a"]), 0);
    Ok(())
}
