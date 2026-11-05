use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const HOUR: u64 = 3_600 * NS_PER_SEC;
const T0: u64 = 1_000 * NS_PER_SEC;
const WAR: u128 = 1_000_000;
const RATE: u32 = 4_380;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn me() -> AccountId {
    acc("war")
}

fn ctx(predecessor: &AccountId, ts: u64, yocto: u128) -> near_sdk::VMContext {
    VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .prepaid_gas(Gas::from_tgas(300))
        .build()
}

fn at(predecessor: &AccountId, ts: u64) {
    testing_env!(ctx(predecessor, ts, 0));
}

fn at_yocto(predecessor: &AccountId, ts: u64) {
    testing_env!(ctx(predecessor, ts, 1));
}

fn at_with_result(predecessor: &AccountId, ts: u64, result: PromiseResult) {
    testing_env!(
        ctx(predecessor, ts, 0),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn launch() -> War {
    at(&acc("deployer"), T0);
    War::new(acc("arena"), acc("usdc"), RATE, U64(3_600))
}

/// The arena pays `amount` USDC into WAR to mint for `who`.
fn mint(w: &mut War, who: &str, amount: u128, ts: u64) -> U128 {
    at(&acc("usdc"), ts);
    let msg = format!(r#"{{"action":"mint","receiver_id":"{}"}}"#, acc(who));
    match w.ft_on_transfer(acc("arena"), U128(amount), msg) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("mint returned a promise"),
    }
}

fn register(w: &mut War, who: &str, ts: u64) {
    testing_env!(ctx(&acc(who), ts, 10u128.pow(22)));
    w.storage_deposit(None, None);
}

fn balance(w: &War, who: &str) -> u128 {
    w.ft_balance_of(acc(who)).0
}

fn events(name: &str) -> Vec<near_sdk::serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|b| serde_json::from_str::<near_sdk::serde_json::Value>(b).unwrap())
        .filter(|v| v["event"] == name)
        .collect()
}

fn panics<F: FnOnce()>(f: F) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_err();
    err.downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ─── Launch ───────────────────────────────────────────────────────────

#[test]
fn launch_fixes_the_rules_and_metadata() {
    let w = launch();
    let p = w.get_params();
    assert_eq!(p.launch_ns, U64(T0));
    assert_eq!(p.step_secs, U64(3_600));
    assert_eq!(p.melt_ppm, 4_380);
    assert_eq!(p.arena, acc("arena"));
    assert_eq!(p.usdc, acc("usdc"));
    let m = w.ft_metadata();
    assert_eq!((m.symbol.as_str(), m.decimals), ("WAR", 6));
    assert_eq!(w.ft_total_supply(), U128(0));
}

#[test]
fn launch_refuses_bad_rules() {
    let cases: Vec<(AccountId, AccountId, u32, u64, &str)> = vec![
        (acc("arena"), acc("arena"), RATE, 3_600, "must differ"),
        (me(), acc("usdc"), RATE, 3_600, "its own arena"),
        (acc("arena"), acc("usdc"), 0, 3_600, "between 1 and 999999"),
        (
            acc("arena"),
            acc("usdc"),
            1_000_000,
            3_600,
            "between 1 and 999999",
        ),
        (acc("arena"), acc("usdc"), RATE, 59, "step must be"),
        (acc("arena"), acc("usdc"), RATE, 86_401, "step must be"),
    ];
    for (arena, usdc, rate, step, msg) in cases {
        at(&acc("deployer"), T0);
        let err = panics(|| {
            War::new(arena, usdc, rate, U64(step));
        });
        assert!(err.contains(msg), "expected {msg:?}, got {err:?}");
    }
}

// ─── Minting ──────────────────────────────────────────────────────────

#[test]
fn the_arena_mints_against_usdc() {
    let mut w = launch();
    assert_eq!(mint(&mut w, "alice", 14 * WAR, T0), U128(0));
    assert_eq!(balance(&w, "alice"), 14 * WAR);
    let s = w.get_state();
    assert_eq!(s.total_supply, U128(14 * WAR));
    assert_eq!(s.backing, U128(14 * WAR));
    assert_eq!(s.melted_backing, U128(0));
    let mints = events("ft_mint");
    assert_eq!(mints[0]["data"][0]["owner_id"], "alice.testnet");
    assert_eq!(mints[0]["data"][0]["amount"], "14000000");
}

#[test]
fn anyone_else_is_refunded() {
    let mut w = launch();
    let msg = format!(r#"{{"action":"mint","receiver_id":"{}"}}"#, acc("alice"));
    // USDC from someone other than the arena.
    at(&acc("usdc"), T0);
    let r = w.ft_on_transfer(acc("mallory"), U128(5 * WAR), msg.clone());
    assert!(matches!(r, PromiseOrValue::Value(U128(v)) if v == 5 * WAR));
    // Another token sent by the arena.
    at(&acc("fake-usdc"), T0);
    let r = w.ft_on_transfer(acc("arena"), U128(5 * WAR), msg);
    assert!(matches!(r, PromiseOrValue::Value(U128(v)) if v == 5 * WAR));
    // A message WAR does not understand.
    at(&acc("usdc"), T0);
    let r = w.ft_on_transfer(acc("arena"), U128(5 * WAR), "{}".into());
    assert!(matches!(r, PromiseOrValue::Value(U128(v)) if v == 5 * WAR));
    assert_eq!(w.ft_total_supply(), U128(0));
    assert_eq!(balance(&w, "alice"), 0);
}

// ─── Melting ──────────────────────────────────────────────────────────

#[test]
fn balances_melt_hourly_to_the_spec_values() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("anyone"), T0 + 24 * HOUR);
    assert_eq!(balance(&w, "alice"), 90_000_866);
    at(&acc("anyone"), T0 + 48 * HOUR);
    assert_eq!(balance(&w, "alice"), 81_001_559);
    at(&acc("anyone"), T0 + 168 * HOUR);
    assert_eq!(balance(&w, "alice"), 47_832_913);
}

#[test]
fn nothing_melts_between_boundaries() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("anyone"), T0 + HOUR - 1);
    assert_eq!(balance(&w, "alice"), 100 * WAR);
}

#[test]
fn receiving_just_before_a_boundary_costs_one_step() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0 + HOUR - 60 * NS_PER_SEC);
    at(&acc("anyone"), T0 + HOUR);
    assert_eq!(100 * WAR - balance(&w, "alice"), 438_000);
}

#[test]
fn the_supply_covers_the_balances_and_the_backing_covers_the_supply() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("anyone"), T0 + 24 * HOUR);
    let s = w.get_state();
    // The supply is rounded up by at most 2 units.
    assert_eq!(s.total_supply, U128(90_000_868));
    assert_eq!(s.melted_backing, U128(9_999_132));
    assert!(s.total_supply.0 >= balance(&w, "alice"));
    assert_eq!(s.backing.0, s.total_supply.0 + s.melted_backing.0);
}

#[test]
fn transfers_carry_current_value() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    register(&mut w, "bob", T0);
    at_yocto(&acc("alice"), T0 + 24 * HOUR);
    w.ft_transfer(acc("bob"), U128(90 * WAR), None);
    at(&acc("anyone"), T0 + 48 * HOUR);
    assert_eq!(balance(&w, "bob"), 81_000_779);
}

#[test]
fn a_round_trip_does_not_dodge_the_melt() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    register(&mut w, "alice2", T0);
    at_yocto(&acc("alice"), T0 + 1);
    w.ft_transfer(acc("alice2"), U128(100 * WAR), None);
    at_yocto(&acc("alice2"), T0 + 2);
    w.ft_transfer(acc("alice"), U128(100 * WAR), None);
    at(&acc("anyone"), T0 + 24 * HOUR);
    assert_eq!(balance(&w, "alice"), 90_000_866);
}

#[test]
fn transfers_need_one_yocto_and_registered_receivers() {
    let mut w = launch();
    mint(&mut w, "alice", 10 * WAR, T0);
    at(&acc("alice"), T0);
    let err = panics(|| w.ft_transfer(acc("bob"), U128(1), None));
    assert!(err.contains("1 yoctoNEAR"));
    at_yocto(&acc("alice"), T0);
    let err = panics(|| w.ft_transfer(acc("bob"), U128(1), None));
    assert!(err.contains("not registered"));
}

#[test]
fn the_supply_stays_above_the_balances_under_mixed_activity() {
    let mut w = launch();
    for who in ["a", "b", "c"] {
        register(&mut w, who, T0);
    }
    mint(&mut w, "a", 123_456_789, T0);
    mint(&mut w, "b", 98_765_432, T0 + 3 * HOUR);
    let mut ts = T0 + 5 * HOUR;
    for i in 0..40u64 {
        ts += (i % 5 + 1) * HOUR + 17;
        let (from, to) = [("a", "b"), ("b", "c"), ("c", "a")][(i % 3) as usize];
        let have = balance(&w, from);
        if have > 1 {
            at_yocto(&acc(from), ts);
            w.ft_transfer(acc(to), U128(have / 3 + 1), None);
        }
        if i % 7 == 0 {
            mint(&mut w, to, 1_000_000 + i as u128, ts);
        }
        let sum: u128 = ["a", "b", "c"].iter().map(|n| balance(&w, n)).sum();
        let s = w.get_state();
        assert!(
            s.total_supply.0 >= sum,
            "step {i}: supply {} < sum {sum}",
            s.total_supply.0
        );
        assert!(s.backing.0 >= s.total_supply.0);
    }
}

// ─── Redemption ───────────────────────────────────────────────────────

#[test]
fn only_the_arena_redeems_and_it_burns_one_for_one() {
    let mut w = launch();
    mint(&mut w, "alice", 35 * WAR, T0);
    register(&mut w, "arena", T0);
    at_yocto(&acc("alice"), T0);
    w.ft_transfer(acc("arena"), U128(35 * WAR), None);

    at(&acc("alice"), T0);
    let err = panics(|| {
        let _ = w.redeem(U128(1));
    });
    assert!(err.contains("Only the arena"));

    at(&acc("arena"), T0);
    let _ = w.redeem(U128(35 * WAR));
    assert_eq!(balance(&w, "arena"), 0);
    let s = w.get_state();
    assert_eq!((s.total_supply, s.backing), (U128(0), U128(0)));
    let burns = events("ft_burn");
    assert_eq!(burns[0]["data"][0]["memo"], "redeem");
}

#[test]
fn a_failed_usdc_payment_puts_the_war_back() {
    let mut w = launch();
    mint(&mut w, "arena", 35 * WAR, T0);
    at(&acc("arena"), T0);
    let _ = w.redeem(U128(35 * WAR));
    at(&me(), T0);
    assert!(!w.on_redeemed(U128(35 * WAR), Err(PromiseError::Failed)));
    assert_eq!(balance(&w, "arena"), 35 * WAR);
    assert_eq!(w.get_state().backing, U128(35 * WAR));
    assert!(w.on_redeemed(U128(1), Ok(())));
}

#[test]
fn the_arena_cannot_redeem_more_than_it_holds() {
    let mut w = launch();
    mint(&mut w, "arena", 5 * WAR, T0);
    at(&acc("arena"), T0);
    let err = panics(|| {
        let _ = w.redeem(U128(6 * WAR));
    });
    assert!(err.contains("enough balance"));
}

// ─── Melt release ─────────────────────────────────────────────────────

#[test]
fn anyone_releases_the_melt_to_the_prize_reserve() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("stranger"), T0 + 24 * HOUR);
    let _ = w.release_melt();
    let s = w.get_state();
    assert_eq!(s.backing, s.total_supply);
    assert_eq!(s.melted_backing, U128(0));

    let used = serde_json::to_vec(&U128(9_999_132)).unwrap();
    at_with_result(&me(), T0 + 24 * HOUR, PromiseResult::Successful(used));
    assert_eq!(w.on_melt_released(U128(9_999_132)), U128(9_999_132));
    let released = events("melt_released");
    assert_eq!(released[0]["data"][0]["amount"], "9999132");
    assert_eq!(released[0]["standard"], "war");
}

#[test]
fn a_refused_release_becomes_backing_again() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("stranger"), T0 + 24 * HOUR);
    let _ = w.release_melt();
    at_with_result(&me(), T0 + 24 * HOUR, PromiseResult::Failed);
    assert_eq!(w.on_melt_released(U128(9_999_132)), U128(0));
    assert_eq!(w.get_state().melted_backing, U128(9_999_132));
    assert!(events("melt_released").is_empty());
}

#[test]
fn releasing_nothing_is_refused() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("stranger"), T0 + 1);
    let err = panics(|| {
        let _ = w.release_melt();
    });
    assert!(err.contains("Nothing has melted"));
}

// ─── Transfer calls ───────────────────────────────────────────────────

#[test]
fn a_refund_after_a_boundary_is_melted() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    register(&mut w, "shop", T0);
    at_yocto(&acc("alice"), T0);
    let _ = w.ft_transfer_call(acc("shop"), U128(50 * WAR), None, "x".into());
    // The receiver hands everything back a day later.
    let unused = serde_json::to_vec(&U128(50 * WAR)).unwrap();
    at_with_result(&me(), T0 + 24 * HOUR, PromiseResult::Successful(unused));
    let used = w.ft_resolve_transfer(acc("alice"), acc("shop"), U128(50 * WAR), U64(0));
    assert_eq!(used, U128(0));
    // Both halves melted for a day; nothing was restored.
    assert_eq!(balance(&w, "shop"), 0);
    assert_eq!(balance(&w, "alice"), 2 * melt::melt(50 * WAR, RATE, 24));
}

#[test]
fn a_failed_transfer_call_refunds_in_full_within_the_step() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    register(&mut w, "shop", T0);
    at_yocto(&acc("alice"), T0);
    let _ = w.ft_transfer_call(acc("shop"), U128(50 * WAR), None, "x".into());
    at_with_result(&me(), T0 + 1, PromiseResult::Failed);
    let used = w.ft_resolve_transfer(acc("alice"), acc("shop"), U128(50 * WAR), U64(0));
    assert_eq!(used, U128(0));
    assert_eq!(balance(&w, "alice"), 100 * WAR);
}

// ─── Views and storage ────────────────────────────────────────────────

#[test]
fn the_account_view_shows_the_next_loss() {
    let mut w = launch();
    mint(&mut w, "alice", 100 * WAR, T0);
    at(&acc("anyone"), T0 + 10);
    let a = w.get_account(acc("alice"));
    assert_eq!(a.balance, U128(100 * WAR));
    assert_eq!(a.next_loss, U128(438_000));
    assert_eq!(a.next_step_at_ns, U64(T0 + HOUR));
}

#[test]
fn storage_registration_and_unregistration() {
    let mut w = launch();
    let bounds = w.storage_balance_bounds();
    assert!(bounds.min.as_yoctonear() > 0);
    register(&mut w, "bob", T0);
    assert!(w.storage_balance_of(acc("bob")).is_some());
    at_yocto(&acc("bob"), T0);
    assert!(w.storage_unregister(None));
    assert!(w.storage_balance_of(acc("bob")).is_none());
}

#[test]
fn forced_unregister_burns_the_balance() {
    let mut w = launch();
    mint(&mut w, "alice", 10 * WAR, T0);
    at_yocto(&acc("alice"), T0);
    let err = panics(|| {
        w.storage_unregister(None);
    });
    assert!(err.contains("without force"));
    at_yocto(&acc("alice"), T0);
    assert!(w.storage_unregister(Some(true)));
    assert_eq!(w.ft_total_supply(), U128(0));
    // The backing stays and is released as melt.
    assert_eq!(w.get_state().melted_backing, U128(10 * WAR));
    assert_eq!(events("ft_burn")[0]["data"][0]["memo"], "forced unregister");
}
