use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const DAY: u64 = 86_400 * NS_PER_SEC;
const T0: u64 = 1_000 * NS_PER_SEC;
const MIN: u128 = 100;

fn acc(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

fn me() -> AccountId {
    acc("valt")
}

fn at(predecessor: &AccountId, ts: u64) {
    at_with(predecessor, ts, 0);
}

fn at_with(predecessor: &AccountId, ts: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(me())
        .predecessor_account_id(predecessor.clone())
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .build());
}

fn config() -> LaunchConfig {
    LaunchConfig {
        name: "Valtrum War Drum".into(),
        symbol: "VALT".into(),
        decimals: 18,
        icon: None,
        war_chest: U128(10_000),
        allocations: ["alice", "bob", "carol", "dave"]
            .iter()
            .map(|n| Allocation {
                account_id: acc(n),
                amount: U128(1_000),
            })
            .collect(),
        day_length_secs: U64(86_400),
        muster_target: 3,
        mint_per_muster: U128(10),
        burn_bps: 1_000,
        min_balance: U128(MIN),
        max_supply: U128(1_000_000),
    }
}

fn launch_with(c: LaunchConfig) -> Valt {
    at(&acc("deployer"), T0);
    Valt::new(c)
}

fn launch() -> Valt {
    launch_with(config())
}

fn muster(v: &mut Valt, who: &str, ts: u64) -> MusterResult {
    at(&acc(who), ts);
    v.muster()
}

fn balance(v: &Valt, who: &str) -> u128 {
    v.ft_balance_of(acc(who)).0
}

fn events(name: &str) -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|b| near_sdk::serde_json::from_str::<Value>(b).unwrap())
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
fn launch_mints_the_chest_and_allocations_with_events() {
    let v = launch();
    assert_eq!(v.ft_total_supply(), U128(14_000));
    assert_eq!(v.ft_balance_of(me()), U128(10_000));
    assert_eq!(balance(&v, "alice"), 1_000);
    let mints = events("ft_mint");
    assert_eq!(mints.len(), 5);
    assert_eq!(mints[0]["data"][0]["memo"], "war chest");
    assert_eq!(mints[1]["data"][0]["memo"], "launch allocation");
}

#[test]
fn params_are_readable() {
    let v = launch();
    let p = v.get_params();
    assert_eq!(p.launch_ns, U64(T0));
    assert_eq!(p.day_length_secs, U64(86_400));
    assert_eq!(p.muster_target, 3);
    assert_eq!(p.mint_per_muster, U128(10));
    assert_eq!(p.burn_bps, 1_000);
    assert_eq!(p.min_balance, U128(MIN));
    assert_eq!(p.max_supply, U128(1_000_000));
    assert_eq!(v.ft_metadata().symbol, "VALT");
}

type Edit = fn(&mut LaunchConfig);

#[test]
fn launch_refuses_bad_rules() {
    let cases: Vec<(Edit, &str)> = vec![
        (|c| c.day_length_secs = U64(59), "Day length"),
        (|c| c.day_length_secs = U64(MAX_DAY_SECS + 1), "Day length"),
        (|c| c.muster_target = 0, "muster target"),
        (|c| c.mint_per_muster = U128(0), "muster mint"),
        (|c| c.burn_bps = 99, "burn must be"),
        (|c| c.burn_bps = 5_001, "burn must be"),
        (|c| c.min_balance = U128(0), "minimum balance"),
        (|c| c.war_chest = U128(0), "war chest"),
        (|c| c.max_supply = U128(13_999), "exceeds the maximum"),
        (|c| c.name = String::new(), "Name and symbol"),
        (|c| c.decimals = 25, "24 decimals"),
        (
            |c| c.allocations[1].account_id = acc("alice"),
            "one launch allocation",
        ),
        (|c| c.allocations[0].account_id = me(), "war chest"),
        (|c| c.allocations[0].amount = U128(0), "must not be empty"),
    ];
    for (edit, msg) in cases {
        let mut c = config();
        edit(&mut c);
        let err = panics(|| {
            launch_with(c);
        });
        assert!(err.contains(msg), "expected {msg:?}, got {err:?}");
    }
}

#[test]
fn there_is_no_way_to_change_the_rules() {
    // The rules have no setter: this test documents that the only state-changing
    // methods are the ritual, transfers, burns and storage management.
    let v = launch();
    let before = v.get_params();
    let mut v = v;
    muster(&mut v, "alice", T0 + 1);
    at(&acc("anyone"), T0 + 5 * DAY);
    v.close_days();
    assert_eq!(v.get_params(), before);
}

// ─── Mustering ────────────────────────────────────────────────────────

#[test]
fn muster_counts_once_per_account_per_day() {
    let mut v = launch();
    let r = muster(&mut v, "alice", T0 + 10);
    assert_eq!((r.day, r.musters, r.muster_target), (0, 1, 3));
    let err = panics(|| {
        muster(&mut v, "alice", T0 + 20);
    });
    assert!(err.contains("Already mustered today"));
    let r = muster(&mut v, "bob", T0 + 30);
    assert_eq!(r.musters, 2);
    assert_eq!(v.get_state().today_musters, 2);
    assert_eq!(events("muster").len(), 1);
}

#[test]
fn muster_needs_the_minimum_balance() {
    let mut v = launch();
    let err = panics(|| {
        muster(&mut v, "stranger", T0 + 1);
    });
    assert!(err.contains("minimum balance"));
}

#[test]
fn the_war_chest_cannot_muster() {
    let mut v = launch();
    at(&me(), T0 + 1);
    let err = panics(|| {
        v.muster();
    });
    assert!(err.contains("war chest cannot muster"));
}

#[test]
fn a_day_that_meets_the_target_mints_each_musterer_once() {
    let mut v = launch();
    for who in ["alice", "bob", "carol"] {
        muster(&mut v, who, T0 + 10);
    }
    // Day 1: alice musters again and receives the day 0 reward.
    let r = muster(&mut v, "alice", T0 + DAY + 1);
    assert_eq!(r.claimed, U128(10));
    assert_eq!(r.day, 1);
    assert_eq!(balance(&v, "alice"), 1_010);
    let s = v.get_state();
    assert_eq!((s.streak, s.longest_streak), (1, 1));
    assert_eq!(s.longest_streak_end_day, Some(0));
    assert_eq!(s.unclaimed_rewards, U128(20));
    assert_eq!(s.total_minted, U128(10));
    assert_eq!(s.total_supply, U128(14_010));

    // Bob claims without mustering; a second claim returns nothing.
    at(&acc("anyone"), T0 + DAY + 2);
    assert_eq!(v.claim_reward(acc("bob")), U128(10));
    assert_eq!(v.claim_reward(acc("bob")), U128(0));
    assert_eq!(balance(&v, "bob"), 1_010);
    assert_eq!(v.get_state().unclaimed_rewards, U128(10));
    // The chest is untouched on a good day.
    assert_eq!(v.ft_balance_of(me()), U128(10_000));
}

#[test]
fn a_reward_cannot_be_claimed_while_its_day_is_open() {
    let mut v = launch();
    muster(&mut v, "alice", T0 + 1);
    at(&acc("alice"), T0 + 2);
    assert_eq!(v.claim_reward(acc("alice")), U128(0));
}

#[test]
fn a_missed_day_burns_a_slice_of_the_chest_and_resets_the_streak() {
    let mut v = launch();
    for who in ["alice", "bob", "carol"] {
        muster(&mut v, who, T0 + 1);
    }
    // Day 1: only two musters.
    muster(&mut v, "alice", T0 + DAY + 1);
    muster(&mut v, "bob", T0 + DAY + 2);
    at(&acc("anyone"), T0 + 2 * DAY);
    assert_eq!(v.close_days(), 1);
    let s = v.get_state();
    assert_eq!(s.streak, 0);
    assert_eq!(s.longest_streak, 1);
    assert_eq!(s.war_chest, U128(9_000));
    assert_eq!(s.total_burned, U128(1_000));
    let burns = events("ft_burn");
    assert_eq!(burns.len(), 1);
    assert_eq!(burns[0]["data"][0]["owner_id"], "valt.testnet");
    assert_eq!(burns[0]["data"][0]["amount"], "1000");
    assert_eq!(burns[0]["data"][0]["memo"], "missed muster");
    // The missed day grants nothing.
    assert_eq!(v.claim_reward(acc("alice")), U128(0));
}

#[test]
fn idle_days_burn_once_each_and_are_logged_as_one_entry() {
    let mut v = launch();
    // Day 0 has no musters; days 1 and 2 pass idle too. Closed on day 3.
    at(&acc("anyone"), T0 + 3 * DAY + 5);
    let pending = v.get_pending_log();
    assert_eq!(pending.len(), 2);
    assert_eq!(v.close_days(), 2);
    let log = v.get_log(0, 10);
    assert_eq!(log, pending);
    assert_eq!(
        (log[0].from_day, log[0].to_day, log[0].burned),
        (0, 0, U128(1_000))
    );
    // 9000 -> 8100 -> 7290: 1710 over days 1 and 2.
    assert_eq!(
        (log[1].from_day, log[1].to_day, log[1].burned),
        (1, 2, U128(1_710))
    );
    assert_eq!(log[1].war_chest, U128(7_290));
    assert_eq!(v.ft_total_supply(), U128(4_000 + 7_290));
    assert_eq!(events("day_closed").len(), 2);
}

#[test]
fn closing_twice_does_nothing() {
    let mut v = launch();
    at(&acc("anyone"), T0 + DAY);
    assert_eq!(v.close_days(), 1);
    assert_eq!(v.close_days(), 0);
    assert_eq!(v.get_log(0, 10).len(), 1);
}

#[test]
fn the_view_projects_days_that_were_not_closed() {
    let mut v = launch();
    for who in ["alice", "bob", "carol"] {
        muster(&mut v, who, T0 + 1);
    }
    at(&acc("anyone"), T0 + DAY + 1);
    let s = v.get_state();
    assert_eq!(s.day, 1);
    assert_eq!(s.streak, 1);
    assert_eq!(s.today_musters, 0);
    assert_eq!(s.unclaimed_rewards, U128(30));
    assert_eq!(s.pending_entries, 1);
    assert_eq!(s.log_len, 0);
    assert_eq!(s.day_ends_at_ns, U64(T0 + 2 * DAY));
    assert_eq!(v.get_account(acc("alice")).pending_reward, U128(10));
}

#[test]
fn the_longest_streak_is_kept_as_a_high_score() {
    let mut v = launch();
    for day in 0..4u64 {
        for who in ["alice", "bob", "carol"] {
            muster(&mut v, who, T0 + day * DAY + 1);
        }
    }
    // Day 4 is missed.
    at(&acc("anyone"), T0 + 5 * DAY + 1);
    v.close_days();
    let s = v.get_state();
    assert_eq!((s.streak, s.longest_streak), (0, 4));
    assert_eq!(s.longest_streak_end_day, Some(3));
}

#[test]
fn rewards_stop_at_the_supply_cap() {
    let mut c = config();
    c.max_supply = U128(14_025);
    let mut v = launch_with(c);
    for who in ["alice", "bob", "carol"] {
        muster(&mut v, who, T0 + 1);
    }
    at(&acc("anyone"), T0 + DAY);
    v.close_days();
    // Headroom 25 shared by 3: 8 each.
    assert_eq!(v.get_log(0, 1)[0].reward_per_muster, U128(8));
    for who in ["alice", "bob", "carol"] {
        v.claim_reward(acc(who));
    }
    assert_eq!(v.ft_total_supply(), U128(14_024));
}

// ─── The balance lock (sybil resistance) ──────────────────────────────

#[test]
fn a_musterer_cannot_move_its_minimum_out_the_same_day() {
    let mut v = launch();
    muster(&mut v, "alice", T0 + 1);
    at_with(&acc("alice"), T0 + 2, 1);
    let err = panics(|| v.ft_transfer(acc("bob"), U128(901), None));
    assert!(err.contains("keep the minimum balance"));
    // Anything above the minimum can move.
    at_with(&acc("alice"), T0 + 3, 1);
    v.ft_transfer(acc("bob"), U128(900), None);
    assert_eq!(balance(&v, "alice"), MIN);
    let lock = v.get_account(acc("alice")).locked_until_ns;
    assert_eq!(lock, Some(U64(T0 + DAY)));
    // After the day ends the lock is gone.
    at_with(&acc("alice"), T0 + DAY, 1);
    v.ft_transfer(acc("bob"), U128(MIN), None);
    assert_eq!(balance(&v, "alice"), 0);
}

#[test]
fn the_same_coins_cannot_muster_twice_through_two_accounts() {
    let mut c = config();
    c.allocations = vec![Allocation {
        account_id: acc("whale"),
        amount: U128(MIN),
    }];
    let mut v = launch_with(c);
    at_with(&acc("sybil"), T0 + 1, 10u128.pow(22));
    v.storage_deposit(Some(acc("sybil")), None);
    muster(&mut v, "whale", T0 + 2);
    at_with(&acc("whale"), T0 + 3, 1);
    let err = panics(|| v.ft_transfer(acc("sybil"), U128(MIN), None));
    assert!(err.contains("keep the minimum balance"));
}

#[test]
fn the_lock_also_applies_to_transfer_calls_and_burns() {
    let mut v = launch();
    muster(&mut v, "alice", T0 + 1);
    at_with(&acc("alice"), T0 + 2, 1);
    let err = panics(|| {
        let _ = v.ft_transfer_call(acc("bob"), U128(1_000), None, String::new());
    });
    assert!(err.contains("keep the minimum balance"));
    at_with(&acc("alice"), T0 + 3, 1);
    let err = panics(|| v.burn(U128(1_000)));
    assert!(err.contains("keep the minimum balance"));
}

#[test]
fn an_account_with_a_pending_muster_cannot_unregister() {
    let mut v = launch();
    muster(&mut v, "alice", T0 + 1);
    at_with(&acc("alice"), T0 + DAY, 1);
    let err = panics(|| {
        v.storage_unregister(Some(true));
    });
    assert!(err.contains("Claim the muster reward"));
}

// ─── Burns and the chest ──────────────────────────────────────────────

#[test]
fn holders_can_burn_their_own_coins() {
    let mut v = launch();
    at_with(&acc("alice"), T0 + 1, 1);
    v.burn(U128(250));
    assert_eq!(balance(&v, "alice"), 750);
    assert_eq!(v.ft_total_supply(), U128(13_750));
    assert_eq!(v.get_state().total_burned, U128(250));
    let burns = events("ft_burn");
    assert_eq!(burns[0]["data"][0]["memo"], "holder burn");
}

#[test]
fn burn_needs_one_yocto() {
    let mut v = launch();
    at(&acc("alice"), T0 + 1);
    let err = panics(|| v.burn(U128(1)));
    assert!(err.contains("1 yoctoNEAR"));
}

#[test]
fn anyone_can_feed_the_war_chest() {
    let mut v = launch();
    at_with(&acc("alice"), T0 + 1, 1);
    v.ft_transfer(me(), U128(500), None);
    assert_eq!(v.get_state().war_chest, U128(10_500));
    // A missed day now burns 10% of the larger chest.
    at(&acc("anyone"), T0 + DAY);
    v.close_days();
    assert_eq!(v.get_log(0, 1)[0].burned, U128(1_050));
}

#[test]
fn log_pages_are_capped() {
    let mut v = launch();
    // 150 single missed days, closed one by one.
    for day in 1..=150u64 {
        at(&acc("anyone"), T0 + day * DAY);
        v.close_days();
    }
    assert_eq!(v.get_state().log_len, 150);
    assert_eq!(v.get_log(0, 1_000).len(), MAX_PAGE as usize);
    assert_eq!(v.get_log(140, 100).len(), 10);
    assert!(v.get_log(500, 10).is_empty());
}
