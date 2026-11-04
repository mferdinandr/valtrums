use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn set_context(predecessor: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("dex"))
        .predecessor_account_id(acc(predecessor))
        .build());
}

fn funded_dex() -> MockDex {
    set_context("owner");
    let mut dex = MockDex::new(acc("owner"));
    // 1 USDC (6 decimals) -> 1000 PEPE (18 decimals)
    dex.set_rate(
        acc("usdc"),
        acc("pepe"),
        U128(1_000_000_000_000_000),
        U128(1),
    );
    set_context("pepe");
    let _ = dex.ft_on_transfer(
        acc("owner"),
        U128(10u128.pow(30)),
        r#"{"action":"add_liquidity"}"#.to_string(),
    );
    dex
}

/// Function calls created so far as (receiver, method, json args).
fn calls() -> Vec<(AccountId, String, Value)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name, args, ..
            } = action
            {
                out.push((
                    receipt.receiver_id.clone(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(Value::Null),
                ));
            }
        }
    }
    out
}

fn swap_msg(min_out: &str) -> String {
    json!({
        "action": "swap",
        "token_out": "pepe.testnet",
        "min_amount_out": min_out,
        "receiver_id": "router.testnet",
        "receiver_msg": "{\"swap_id\":7}",
    })
    .to_string()
}

fn unused(result: PromiseOrValue<U128>) -> u128 {
    match result {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

#[test]
fn owner_sets_and_reads_rate() {
    let dex = funded_dex();
    assert_eq!(dex.get_rate(acc("usdc"), acc("pepe")).unwrap().den, U128(1));
    assert!(dex.get_rate(acc("pepe"), acc("usdc")).is_none());
}

#[test]
#[should_panic(expected = "Only the owner")]
fn stranger_cannot_set_rate() {
    let mut dex = funded_dex();
    set_context("stranger");
    dex.set_rate(acc("usdc"), acc("pepe"), U128(1), U128(1));
}

#[test]
#[should_panic(expected = "Rate parts must be positive")]
fn zero_rate_is_rejected() {
    let mut dex = funded_dex();
    set_context("owner");
    dex.set_rate(acc("usdc"), acc("pepe"), U128(0), U128(1));
}

#[test]
fn add_liquidity_requires_owner() {
    let mut dex = funded_dex();
    let before = dex.get_liquidity(acc("pepe")).0;
    set_context("pepe");
    let result = dex.ft_on_transfer(
        acc("stranger"),
        U128(5),
        r#"{"action":"add_liquidity"}"#.to_string(),
    );
    assert_eq!(unused(result), 5);
    assert_eq!(dex.get_liquidity(acc("pepe")).0, before);
}

#[test]
fn swap_pays_output_and_reports_input_used() {
    let mut dex = funded_dex();
    let start = dex.get_liquidity(acc("pepe")).0;
    set_context("usdc");
    let result = dex.ft_on_transfer(acc("router"), U128(2_000_000), swap_msg("1"));
    assert_eq!(unused(result), 0);
    let out = 2_000u128 * 10u128.pow(18);
    assert_eq!(dex.get_liquidity(acc("pepe")).0, start - out);
    assert_eq!(dex.get_liquidity(acc("usdc")).0, 2_000_000);

    let calls = calls();
    assert_eq!(calls.len(), 2);
    let (receiver, method, args) = &calls[0];
    assert_eq!(receiver, &acc("pepe"));
    assert_eq!(method, "ft_transfer_call");
    assert_eq!(args["receiver_id"], "router.testnet");
    assert_eq!(args["amount"], "2000000000000000000000");
    assert_eq!(args["msg"], r#"{"swap_id":7}"#);
    assert_eq!(calls[1].1, "on_output_sent");
}

#[test]
fn slippage_returns_whole_input() {
    let mut dex = funded_dex();
    let too_much = (2_000u128 * 10u128.pow(18) + 1).to_string();
    set_context("usdc");
    let result = dex.ft_on_transfer(acc("router"), U128(2_000_000), swap_msg(&too_much));
    assert_eq!(unused(result), 2_000_000);
    assert!(calls().is_empty());
}

#[test]
fn missing_liquidity_returns_whole_input() {
    let mut dex = funded_dex();
    set_context("usdc");
    let amount = 10u128.pow(16);
    let result = dex.ft_on_transfer(acc("router"), U128(amount), swap_msg("1"));
    assert_eq!(unused(result), amount);
}

#[test]
fn unknown_pair_and_bad_message_return_whole_input() {
    let mut dex = funded_dex();
    set_context("other");
    assert_eq!(
        unused(dex.ft_on_transfer(acc("router"), U128(9), swap_msg("1"))),
        9
    );
    set_context("usdc");
    assert_eq!(
        unused(dex.ft_on_transfer(acc("router"), U128(9), "garbage".to_string())),
        9
    );
}

#[test]
fn zero_output_is_refused() {
    let mut dex = funded_dex();
    set_context("owner");
    dex.set_rate(acc("usdc"), acc("pepe"), U128(1), U128(1_000));
    set_context("usdc");
    let result = dex.ft_on_transfer(acc("router"), U128(5), swap_msg("0"));
    assert_eq!(unused(result), 5);
}

fn callback_context() {
    set_context("dex");
}

#[test]
fn callback_restores_unused_output() {
    let mut dex = funded_dex();
    let start = dex.get_liquidity(acc("pepe")).0;
    callback_context();
    dex.on_output_sent(acc("pepe"), U128(100), Ok(U128(40)));
    assert_eq!(dex.get_liquidity(acc("pepe")).0, start + 60);
}

#[test]
fn callback_keeps_liquidity_when_fully_used() {
    let mut dex = funded_dex();
    let start = dex.get_liquidity(acc("pepe")).0;
    callback_context();
    dex.on_output_sent(acc("pepe"), U128(100), Ok(U128(100)));
    assert_eq!(dex.get_liquidity(acc("pepe")).0, start);
}

#[test]
fn callback_restores_everything_on_promise_failure() {
    let mut dex = funded_dex();
    let start = dex.get_liquidity(acc("pepe")).0;
    callback_context();
    dex.on_output_sent(acc("pepe"), U128(100), Err(PromiseError::Failed));
    assert_eq!(dex.get_liquidity(acc("pepe")).0, start + 100);
}
