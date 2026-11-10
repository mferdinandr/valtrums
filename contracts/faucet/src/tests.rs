use super::*;
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};

const DAY: u64 = 24 * 60 * 60 * NANOS_PER_SEC;
const T0: u64 = 1_000 * DAY;
const AMOUNT: u128 = 100_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn faucet_id() -> AccountId {
    acc("faucet.testnet")
}
fn token() -> AccountId {
    acc("backing-cashcat.testnet")
}
fn other_token() -> AccountId {
    acc("backing-wallet.testnet")
}

fn ctx(pred: &str, deposit: NearToken, ts: u64, gas_tgas: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(faucet_id())
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .attached_deposit(deposit)
        .block_timestamp(ts)
        .prepaid_gas(Gas::from_tgas(gas_tgas));
    b
}
fn at(pred: &str, ts: u64) {
    testing_env!(ctx(pred, NearToken::from_millinear(10), ts, 150).build());
}
fn callback_ctx(ts: u64, result: PromiseResult) {
    let c = ctx("faucet.testnet", NearToken::from_yoctonear(0), ts, 100).build();
    testing_env!(
        c,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn fresh() -> Faucet {
    at("owner.testnet", T0);
    let mut f = Faucet::new(acc("owner.testnet"), None);
    f.set_token(token(), "CASHCAT".into(), U128(AMOUNT), U128(0));
    f
}

#[test]
fn init_uses_a_day_and_rejects_a_cooldown_out_of_range() {
    at("owner.testnet", T0);
    let f = Faucet::new(acc("owner.testnet"), None);
    assert_eq!(f.get_config().cooldown_secs.0, DEFAULT_COOLDOWN_SECS);
    assert!(!f.get_config().paused);
}
#[test]
#[should_panic(expected = "Cooldown is out of range")]
fn init_rejects_a_tiny_cooldown() {
    at("owner.testnet", T0);
    Faucet::new(acc("owner.testnet"), Some(U64(1)));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_can_set_a_token() {
    let mut f = fresh();
    at("alice.testnet", T0);
    f.set_token(other_token(), "WALLET".into(), U128(1), U128(0));
}
#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_can_pause() {
    let mut f = fresh();
    at("alice.testnet", T0);
    f.set_paused(true);
}
#[test]
#[should_panic(expected = "symbol must be 1 to 16")]
fn a_bad_symbol_is_refused() {
    let mut f = fresh();
    f.set_token(other_token(), "bad symbol!".into(), U128(1), U128(0));
}
#[test]
fn the_view_lists_the_symbol() {
    let f = fresh();
    assert_eq!(f.get_tokens()[0].symbol, "CASHCAT");
}
#[test]
#[should_panic(expected = "claim amount must be positive")]
fn a_zero_amount_is_refused() {
    let mut f = fresh();
    f.set_token(other_token(), "WALLET".into(), U128(0), U128(0));
}
#[test]
#[should_panic(expected = "daily budget must cover")]
fn a_budget_below_one_claim_is_refused() {
    let mut f = fresh();
    f.set_token(other_token(), "WALLET".into(), U128(10), U128(5));
}
#[test]
#[should_panic(expected = "Too many tokens")]
fn the_token_list_is_bounded() {
    let mut f = fresh();
    for i in 0..MAX_TOKENS {
        f.set_token(
            acc(&format!("t{i}.testnet")),
            format!("T{i}"),
            U128(1),
            U128(0),
        );
    }
}

#[test]
fn a_claim_records_the_account_and_starts_the_cooldown() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(token());
    let s = f.get_claim_status(acc("alice.testnet"), token());
    assert_eq!(s.last_claim_ns.unwrap().0, T0);
    assert!(!s.can_claim);
    assert_eq!(
        s.next_claim_ns.0,
        T0 + DEFAULT_COOLDOWN_SECS * NANOS_PER_SEC
    );
    // Another account is unaffected.
    assert!(f.get_claim_status(acc("bob.testnet"), token()).can_claim);
}
#[test]
#[should_panic(expected = "Cooldown has not passed")]
fn a_second_claim_inside_the_cooldown_is_refused() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(token());
    at("alice.testnet", T0 + DAY / 2);
    let _ = f.claim(token());
}
#[test]
fn after_the_cooldown_a_claim_needs_no_new_record_deposit() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(token());
    testing_env!(ctx("alice.testnet", NearToken::from_yoctonear(0), T0 + DAY, 150).build());
    let _ = f.claim(token());
    assert_eq!(
        f.get_claim_status(acc("alice.testnet"), token())
            .last_claim_ns
            .unwrap()
            .0,
        T0 + DAY
    );
}
#[test]
#[should_panic(expected = "Attach the storage deposit")]
fn a_first_claim_without_the_record_deposit_is_refused() {
    let mut f = fresh();
    testing_env!(ctx("alice.testnet", NearToken::from_yoctonear(0), T0, 150).build());
    let _ = f.claim(token());
}
#[test]
fn the_unused_part_of_the_deposit_is_refunded_to_the_caller() {
    let mut f = fresh();
    testing_env!(ctx("alice.testnet", NearToken::from_near(1), T0, 150).build());
    let _ = f.claim(token());
    let refunded = get_created_receipts().iter().any(|r| {
        r.receiver_id == acc("alice.testnet") && format!("{:?}", r.actions).contains("Transfer")
    });
    assert!(refunded, "the excess deposit must go back to the claimer");
}
#[test]
#[should_panic(expected = "Token is not offered")]
fn an_unknown_token_is_refused() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(other_token());
}
#[test]
#[should_panic(expected = "Faucet is paused")]
fn a_paused_faucet_refuses_claims() {
    let mut f = fresh();
    f.set_paused(true);
    at("alice.testnet", T0);
    let _ = f.claim(token());
}
#[test]
#[should_panic(expected = "Attach at least 100 Tgas")]
fn a_claim_with_too_little_gas_is_refused() {
    let mut f = fresh();
    testing_env!(ctx("alice.testnet", NearToken::from_millinear(10), T0, 50).build());
    let _ = f.claim(token());
}

#[test]
fn the_daily_budget_bounds_what_many_accounts_can_take() {
    let mut f = fresh();
    f.set_token(token(), "CASHCAT".into(), U128(AMOUNT), U128(AMOUNT * 2));
    for name in ["a.testnet", "b.testnet"] {
        at(name, T0);
        let _ = f.claim(token());
    }
    assert_eq!(f.get_tokens()[0].budget_left.unwrap().0, 0);
    // The next day the budget is whole again.
    at("c.testnet", T0 + DAY);
    let _ = f.claim(token());
    assert_eq!(f.get_tokens()[0].budget_left.unwrap().0, AMOUNT);
}
#[test]
#[should_panic(expected = "Daily budget is used up")]
fn a_claim_past_the_daily_budget_is_refused() {
    let mut f = fresh();
    f.set_token(token(), "CASHCAT".into(), U128(AMOUNT), U128(AMOUNT));
    at("a.testnet", T0);
    let _ = f.claim(token());
    at("b.testnet", T0 + 1);
    let _ = f.claim(token());
}

#[test]
fn a_failed_transfer_gives_back_the_cooldown_and_the_budget() {
    let mut f = fresh();
    f.set_token(token(), "CASHCAT".into(), U128(AMOUNT), U128(AMOUNT * 3));
    at("alice.testnet", T0);
    let _ = f.claim(token());
    assert!(!f.get_claim_status(acc("alice.testnet"), token()).can_claim);
    callback_ctx(T0 + 1, PromiseResult::Failed);
    let ok = f.on_claimed(
        acc("alice.testnet"),
        token(),
        U128(AMOUNT),
        None,
        U64(T0),
        U128(0),
    );
    assert!(!ok);
    let s = f.get_claim_status(acc("alice.testnet"), token());
    assert!(
        s.can_claim,
        "a failed claim must not cost the claimer their cooldown"
    );
    assert!(s.last_claim_ns.is_none());
    assert_eq!(f.get_tokens()[0].budget_left.unwrap().0, AMOUNT * 3);
}
#[test]
fn a_failed_repeat_claim_restores_the_previous_record() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(token());
    testing_env!(ctx("alice.testnet", NearToken::from_yoctonear(0), T0 + DAY, 150).build());
    let _ = f.claim(token());
    callback_ctx(T0 + DAY + 1, PromiseResult::Failed);
    f.on_claimed(
        acc("alice.testnet"),
        token(),
        U128(AMOUNT),
        Some(U64(T0)),
        U64(T0 + DAY),
        U128(0),
    );
    assert_eq!(
        f.get_claim_status(acc("alice.testnet"), token())
            .last_claim_ns
            .unwrap()
            .0,
        T0
    );
}
#[test]
fn a_successful_transfer_keeps_the_claim() {
    let mut f = fresh();
    at("alice.testnet", T0);
    let _ = f.claim(token());
    callback_ctx(T0 + 1, PromiseResult::Successful(vec![]));
    assert!(f.on_claimed(
        acc("alice.testnet"),
        token(),
        U128(AMOUNT),
        None,
        U64(T0),
        U128(0)
    ));
    assert!(!f.get_claim_status(acc("alice.testnet"), token()).can_claim);
}
#[test]
fn a_failed_claim_does_not_touch_a_newer_budget_window() {
    let mut f = fresh();
    f.set_token(token(), "CASHCAT".into(), U128(AMOUNT), U128(AMOUNT * 5));
    at("alice.testnet", T0);
    let _ = f.claim(token());
    // A new window opens before the callback of the old claim runs.
    at("bob.testnet", T0 + DAY);
    let _ = f.claim(token());
    callback_ctx(T0 + DAY + 1, PromiseResult::Failed);
    f.on_claimed(
        acc("alice.testnet"),
        token(),
        U128(AMOUNT),
        None,
        U64(T0),
        U128(0),
    );
    assert_eq!(
        f.get_tokens()[0].budget_left.unwrap().0,
        AMOUNT * 4,
        "only the current window's own claim stays counted"
    );
}
// `on_claimed` is `#[private]`. That guard lives in the exported wrapper the macro generates, so a direct Rust
// call in a unit test cannot exercise it; it needs a sandbox test (see the integration crate).

#[test]
fn the_owner_can_tune_the_faucet_and_list_it() {
    let mut f = fresh();
    f.set_token(other_token(), "WALLET".into(), U128(7), U128(70));
    f.set_cooldown_secs(U64(3_600));
    assert_eq!(f.get_config().cooldown_secs.0, 3_600);
    assert_eq!(f.get_config().token_count, 2);
    f.remove_token(other_token());
    assert_eq!(f.get_tokens().len(), 1);
    f.set_owner(acc("new-owner.testnet"));
    assert_eq!(f.get_config().owner, acc("new-owner.testnet"));
}
#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdrawing_stock_needs_one_yocto() {
    let mut f = fresh();
    testing_env!(ctx("owner.testnet", NearToken::from_yoctonear(0), T0, 100).build());
    let _ = f.withdraw_ft(token(), acc("owner.testnet"), U128(1));
}
#[test]
#[should_panic(expected = "Only the owner")]
fn only_the_owner_can_withdraw() {
    let mut f = fresh();
    testing_env!(ctx("alice.testnet", NearToken::from_yoctonear(1), T0, 100).build());
    let _ = f.withdraw_ft(token(), acc("alice.testnet"), U128(1));
}
