//! Pure rules of the daily muster. No storage and no environment access, so the
//! same arithmetic can be mirrored exactly by the simulation and the web page.

/// Basis points denominator (100% = 10_000).
pub const BPS: u128 = 10_000;
/// Smallest allowed burn slice (1%). Lower values would make long idle gaps
/// expensive to close, because the burn is applied once per missed day.
pub const MIN_BURN_BPS: u16 = 100;
/// Largest allowed burn slice (50%).
pub const MAX_BURN_BPS: u16 = 5_000;

/// `floor(amount * bps / BPS)` without overflowing for any `u128` amount.
pub fn bps_of(amount: u128, bps: u16) -> u128 {
    let bps = u128::from(bps);
    (amount / BPS) * bps + (amount % BPS) * bps / BPS
}

/// What a missed day burns from the war chest.
pub fn missed_day_burn(war_chest: u128, burn_bps: u16) -> u128 {
    bps_of(war_chest, burn_bps)
}

/// Total burned over `days` consecutive missed days, applying the slice once per
/// day to what is left. Stops early once a slice rounds down to zero, so the loop
/// is bounded by the chest size, not by the number of days.
pub fn missed_days_burn(war_chest: u128, burn_bps: u16, days: u64) -> u128 {
    let mut left = war_chest;
    let mut day = 0;
    while day < days {
        let burn = missed_day_burn(left, burn_bps);
        if burn == 0 {
            break;
        }
        left -= burn;
        day += 1;
    }
    war_chest - left
}

/// Reward per musterer for a day that hit the target. Each musterer gets
/// `mint_per_muster`, unless that would push supply past the cap; then the
/// remaining headroom is shared equally (floor).
pub fn reward_per_muster(musters: u32, mint_per_muster: u128, headroom: u128) -> u128 {
    if musters == 0 {
        return 0;
    }
    let musters = u128::from(musters);
    match mint_per_muster.checked_mul(musters) {
        Some(total) if total <= headroom => mint_per_muster,
        _ => headroom / musters,
    }
}

/// Outcome of one closed day, or of a run of idle days.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayOutcome {
    /// The muster target was reached: musterers are minted a reward.
    Streak,
    /// The target was missed: a slice of the war chest burned and the streak reset.
    Missed,
}

/// Scalars that change when days close.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    pub streak: u32,
    pub longest_streak: u32,
    /// Last day of the longest streak (only meaningful when `longest_streak > 0`).
    pub longest_streak_end_day: u64,
    pub war_chest: u128,
    pub total_supply: u128,
    /// Rewards granted to musterers but not minted yet.
    pub unclaimed: u128,
}

/// One entry of the public log: a single closed day, or a run of idle days.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Closed {
    pub from_day: u64,
    pub to_day: u64,
    pub musters: u32,
    pub outcome: DayOutcome,
    pub reward_per_muster: u128,
    /// Total reward granted to the day's musterers (minted as they claim).
    pub minted: u128,
    pub burned: u128,
    /// State right after this entry.
    pub tally: Tally,
}

/// Fixed rules used to close days.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub muster_target: u32,
    pub mint_per_muster: u128,
    pub burn_bps: u16,
    pub max_supply: u128,
}

/// Closes the open day `open_day` (with `musters` check-ins) and every idle day up
/// to `today - 1`. Returns the log entries (one or two) and the resulting tally.
/// Returns no entries when `open_day >= today`.
pub fn close_days(
    rules: &Rules,
    tally: Tally,
    open_day: u64,
    musters: u32,
    today: u64,
) -> Vec<Closed> {
    let mut out = Vec::new();
    if open_day >= today {
        return out;
    }
    let mut t = tally;

    if musters >= rules.muster_target {
        t.streak += 1;
        if t.streak > t.longest_streak {
            t.longest_streak = t.streak;
            t.longest_streak_end_day = open_day;
        }
        let headroom = rules
            .max_supply
            .saturating_sub(t.total_supply)
            .saturating_sub(t.unclaimed);
        let rpm = reward_per_muster(musters, rules.mint_per_muster, headroom);
        let minted = rpm * u128::from(musters);
        t.unclaimed += minted;
        out.push(Closed {
            from_day: open_day,
            to_day: open_day,
            musters,
            outcome: DayOutcome::Streak,
            reward_per_muster: rpm,
            minted,
            burned: 0,
            tally: t,
        });
    } else {
        let burned = missed_day_burn(t.war_chest, rules.burn_bps);
        t.war_chest -= burned;
        t.total_supply -= burned;
        t.streak = 0;
        out.push(Closed {
            from_day: open_day,
            to_day: open_day,
            musters,
            outcome: DayOutcome::Missed,
            reward_per_muster: 0,
            minted: 0,
            burned,
            tally: t,
        });
    }

    let idle = today - open_day - 1;
    if idle > 0 {
        let burned = missed_days_burn(t.war_chest, rules.burn_bps, idle);
        t.war_chest -= burned;
        t.total_supply -= burned;
        t.streak = 0;
        out.push(Closed {
            from_day: open_day + 1,
            to_day: today - 1,
            musters: 0,
            outcome: DayOutcome::Missed,
            reward_per_muster: 0,
            minted: 0,
            burned,
            tally: t,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULES: Rules = Rules {
        muster_target: 3,
        mint_per_muster: 10,
        burn_bps: 1_000,
        max_supply: 1_000_000,
    };

    fn tally(war_chest: u128, total_supply: u128) -> Tally {
        Tally {
            streak: 0,
            longest_streak: 0,
            longest_streak_end_day: 0,
            war_chest,
            total_supply,
            unclaimed: 0,
        }
    }

    #[test]
    fn bps_of_is_exact_floor_and_never_overflows() {
        assert_eq!(bps_of(1_000, 1_000), 100);
        assert_eq!(bps_of(9_999, 1), 0);
        assert_eq!(bps_of(19_999, 5_000), 9_999);
        let max = u128::MAX;
        assert_eq!(bps_of(max, 10_000), max);
        assert_eq!(bps_of(max, 5_000), max / 2);
    }

    #[test]
    fn missed_days_burn_compounds_per_day() {
        // 1000 -> 900 -> 810 -> 729: 271 burned over three days.
        assert_eq!(missed_days_burn(1_000, 1_000, 3), 271);
        assert_eq!(missed_days_burn(1_000, 1_000, 0), 0);
    }

    #[test]
    fn missed_days_burn_stops_when_the_slice_rounds_to_zero() {
        // 10% of 9 is 0, so a chest of 9 never burns further, even over many days.
        assert_eq!(missed_days_burn(9, 1_000, u64::MAX), 0);
        let burned = missed_days_burn(u128::MAX, MIN_BURN_BPS, u64::MAX);
        assert!(burned < u128::MAX);
    }

    #[test]
    fn reward_is_full_until_the_cap_then_shared() {
        assert_eq!(reward_per_muster(3, 10, 100), 10);
        assert_eq!(reward_per_muster(3, 10, 30), 10);
        assert_eq!(reward_per_muster(3, 10, 29), 9);
        assert_eq!(reward_per_muster(3, 10, 2), 0);
        assert_eq!(reward_per_muster(0, 10, 100), 0);
        assert_eq!(reward_per_muster(2, u128::MAX, u128::MAX), u128::MAX / 2);
    }

    #[test]
    fn nothing_closes_before_the_day_ends() {
        assert!(close_days(&RULES, tally(1_000, 2_000), 4, 9, 4).is_empty());
        assert!(close_days(&RULES, tally(1_000, 2_000), 5, 9, 4).is_empty());
    }

    #[test]
    fn hitting_the_target_extends_the_streak_and_grants_rewards() {
        let out = close_days(&RULES, tally(1_000, 2_000), 0, 4, 1);
        assert_eq!(out.len(), 1);
        let c = out[0];
        assert_eq!(c.outcome, DayOutcome::Streak);
        assert_eq!((c.reward_per_muster, c.minted, c.burned), (10, 40, 0));
        assert_eq!(c.tally.streak, 1);
        assert_eq!(c.tally.longest_streak, 1);
        assert_eq!(c.tally.unclaimed, 40);
        // Supply only grows when rewards are claimed.
        assert_eq!(c.tally.total_supply, 2_000);
        assert_eq!(c.tally.war_chest, 1_000);
    }

    #[test]
    fn missing_the_target_burns_and_resets() {
        let mut t = tally(1_000, 2_000);
        t.streak = 5;
        t.longest_streak = 5;
        t.longest_streak_end_day = 9;
        let out = close_days(&RULES, t, 10, 2, 11);
        assert_eq!(out.len(), 1);
        let c = out[0];
        assert_eq!(c.outcome, DayOutcome::Missed);
        assert_eq!(c.burned, 100);
        assert_eq!(c.tally.war_chest, 900);
        assert_eq!(c.tally.total_supply, 1_900);
        assert_eq!(c.tally.streak, 0);
        assert_eq!(
            (c.tally.longest_streak, c.tally.longest_streak_end_day),
            (5, 9)
        );
    }

    #[test]
    fn idle_days_are_logged_as_one_missed_run() {
        let out = close_days(&RULES, tally(1_000, 2_000), 0, 3, 4);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].outcome, DayOutcome::Streak);
        let idle = out[1];
        assert_eq!((idle.from_day, idle.to_day, idle.musters), (1, 3, 0));
        assert_eq!(idle.outcome, DayOutcome::Missed);
        assert_eq!(idle.burned, 271);
        assert_eq!(idle.tally.war_chest, 729);
        assert_eq!(idle.tally.streak, 0);
        assert_eq!(idle.tally.longest_streak, 1);
    }

    #[test]
    fn longest_streak_only_moves_when_beaten() {
        let mut t = tally(1_000, 2_000);
        t.streak = 1;
        t.longest_streak = 3;
        t.longest_streak_end_day = 2;
        let c = close_days(&RULES, t, 7, 3, 8)[0];
        assert_eq!(c.tally.streak, 2);
        assert_eq!(
            (c.tally.longest_streak, c.tally.longest_streak_end_day),
            (3, 2)
        );
        let mut t = c.tally;
        t.streak = 3;
        let c = close_days(&RULES, t, 8, 3, 9)[0];
        assert_eq!(
            (c.tally.longest_streak, c.tally.longest_streak_end_day),
            (4, 8)
        );
    }

    #[test]
    fn rewards_respect_the_supply_cap_including_unclaimed() {
        let rules = Rules {
            max_supply: 2_050,
            ..RULES
        };
        let mut t = tally(1_000, 2_000);
        t.unclaimed = 20;
        // Headroom is 2050 - 2000 - 20 = 30, shared by 4 musterers: 7 each.
        let c = close_days(&rules, t, 0, 4, 1)[0];
        assert_eq!((c.reward_per_muster, c.minted), (7, 28));
        assert_eq!(c.tally.unclaimed, 48);
    }
}
