//! VALT: the Valtrum war-drum coin. An NEP-141 token with a daily ritual in the
//! contract itself.
//!
//! - Every day, each holder with at least `min_balance` may **muster** once.
//! - When a day closes with at least `muster_target` musters, every musterer is
//!   granted `mint_per_muster` new VALT (newly minted, capped by `max_supply`)
//!   and the community streak grows by one.
//! - When a day closes short of the target, `burn_bps` of the war chest (the VALT
//!   held by this contract's own account) is burned and the streak resets. A day
//!   with no musters at all counts as missed.
//! - The longest streak is kept as a high score.
//!
//! All rules are set once in `new` and can be read with `get_params`. There is no
//! owner and no method that changes them. Days close lazily: the first muster,
//! claim or `close_days` call after a day ends closes it (and any idle days).
//!
//! Sybil resistance is capital-based: an account that mustered must keep
//! `min_balance` until the day ends, so the same coins cannot muster twice in a
//! day through several accounts. Its limits are described in the README.

pub mod rules;

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault,
    PromiseOrValue,
};
use rules::{Closed, DayOutcome, Rules, Tally, MAX_BURN_BPS, MIN_BURN_BPS};

const NS_PER_SEC: u64 = 1_000_000_000;
/// Shortest allowed day (for demos); a real launch uses 86_400.
pub const MIN_DAY_SECS: u64 = 60;
/// Longest allowed day.
pub const MAX_DAY_SECS: u64 = 30 * 86_400;
/// Most accounts that can receive coins at launch.
pub const MAX_ALLOCATIONS: usize = 50;
/// Largest page returned by `get_log`.
pub const MAX_PAGE: u64 = 100;

const EVENT_STANDARD: &str = "valt";
const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Rewards,
    LastMuster,
    Log,
}

/// Coins minted to one account at launch.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Allocation {
    pub account_id: AccountId,
    pub amount: U128,
}

/// Everything fixed at launch. Nothing here can change afterwards.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub icon: Option<String>,
    /// Coins held by the contract itself; missed days burn a slice of it.
    pub war_chest: U128,
    /// Coins minted to holders at launch.
    pub allocations: Vec<Allocation>,
    pub day_length_secs: U64,
    /// Musters needed for a day to count.
    pub muster_target: u32,
    /// New coins granted to each musterer of a day that counted.
    pub mint_per_muster: U128,
    /// Share of the war chest burned on a missed day, in basis points.
    pub burn_bps: u16,
    /// Balance an account needs to muster, kept until the day ends.
    pub min_balance: U128,
    /// Supply can never grow past this.
    pub max_supply: U128,
}

#[near(serializers = [borsh])]
struct Params {
    day_ns: u64,
    muster_target: u32,
    mint_per_muster: u128,
    burn_bps: u16,
    min_balance: u128,
    max_supply: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
struct LogEntry {
    from_day: u64,
    to_day: u64,
    musters: u32,
    target_met: bool,
    reward_per_muster: u128,
    minted: u128,
    burned: u128,
    streak: u32,
    war_chest: u128,
    total_supply: u128,
}

impl From<&Closed> for LogEntry {
    fn from(c: &Closed) -> Self {
        Self {
            from_day: c.from_day,
            to_day: c.to_day,
            musters: c.musters,
            target_met: c.outcome == DayOutcome::Streak,
            reward_per_muster: c.reward_per_muster,
            minted: c.minted,
            burned: c.burned,
            streak: c.tally.streak,
            war_chest: c.tally.war_chest,
            total_supply: c.tally.total_supply,
        }
    }
}

/// A closed day (or a run of idle days) as shown in the public log.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntryView {
    pub from_day: u64,
    pub to_day: u64,
    pub musters: u32,
    pub target_met: bool,
    pub reward_per_muster: U128,
    /// Reward granted to the day's musterers; it is minted as they claim.
    pub minted: U128,
    pub burned: U128,
    pub streak: u32,
    pub war_chest: U128,
    /// Supply right after the entry (claimed rewards are counted when claimed).
    pub total_supply: U128,
}

impl From<&LogEntry> for LogEntryView {
    fn from(e: &LogEntry) -> Self {
        Self {
            from_day: e.from_day,
            to_day: e.to_day,
            musters: e.musters,
            target_met: e.target_met,
            reward_per_muster: U128(e.reward_per_muster),
            minted: U128(e.minted),
            burned: U128(e.burned),
            streak: e.streak,
            war_chest: U128(e.war_chest),
            total_supply: U128(e.total_supply),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParamsView {
    pub launch_ns: U64,
    pub day_length_secs: U64,
    pub muster_target: u32,
    pub mint_per_muster: U128,
    pub burn_bps: u16,
    pub min_balance: U128,
    pub max_supply: U128,
}

/// The token page in one call. Days that ended but were not closed yet are
/// projected, so the view is always current.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateView {
    pub day: u64,
    pub day_ends_at_ns: U64,
    pub today_musters: u32,
    pub muster_target: u32,
    pub streak: u32,
    pub longest_streak: u32,
    pub longest_streak_end_day: Option<u64>,
    pub war_chest: U128,
    pub total_supply: U128,
    pub unclaimed_rewards: U128,
    pub total_minted: U128,
    pub total_burned: U128,
    /// Entries stored in the log.
    pub log_len: u64,
    /// Entries that `close_days` would add now (shown by `get_pending_log`).
    pub pending_entries: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountView {
    pub balance: U128,
    pub mustered_today: bool,
    /// Reward waiting to be minted for an earlier muster.
    pub pending_reward: U128,
    /// While set, the balance cannot drop below `min_balance`.
    pub locked_until_ns: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MusterResult {
    pub day: u64,
    pub musters: u32,
    pub muster_target: u32,
    /// Reward minted for the caller's previous muster during this call.
    pub claimed: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Valt {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    params: Params,
    launch_ns: u64,
    open_day: u64,
    open_musters: u32,
    streak: u32,
    longest_streak: u32,
    longest_streak_end_day: u64,
    unclaimed: u128,
    /// Muster rewards minted so far (launch coins not included).
    total_minted: u128,
    total_burned: u128,
    /// Reward per musterer for each day that met the target.
    rewards: LookupMap<u64, u128>,
    /// Day of each account's latest muster whose reward is not claimed yet.
    last_muster: LookupMap<AccountId, u64>,
    log: Vector<LogEntry>,
}

#[near]
impl Valt {
    #[init]
    pub fn new(config: LaunchConfig) -> Self {
        let c = config;
        require!(
            !c.name.is_empty() && !c.symbol.is_empty(),
            "Name and symbol are required"
        );
        require!(c.decimals <= 24, "At most 24 decimals");
        require!(
            (MIN_DAY_SECS..=MAX_DAY_SECS).contains(&c.day_length_secs.0),
            "Day length must be between 60 seconds and 30 days"
        );
        require!(c.muster_target >= 1, "The muster target must be at least 1");
        require!(
            c.mint_per_muster.0 >= 1,
            "The muster mint must be at least 1"
        );
        require!(
            (MIN_BURN_BPS..=MAX_BURN_BPS).contains(&c.burn_bps),
            "The burn must be between 1% and 50% (100 to 5000 bps)"
        );
        require!(
            c.min_balance.0 >= 1,
            "The minimum balance must be at least 1"
        );
        require!(c.war_chest.0 >= 1, "The war chest must not be empty");
        require!(
            c.allocations.len() <= MAX_ALLOCATIONS,
            "At most 50 launch allocations"
        );

        let me = env::current_account_id();
        let mut initial = c.war_chest.0;
        for a in &c.allocations {
            require!(
                a.account_id != me,
                "Put the contract's coins in the war chest"
            );
            require!(a.amount.0 >= 1, "Launch allocations must not be empty");
            initial = initial
                .checked_add(a.amount.0)
                .unwrap_or_else(|| env::panic_str("Launch supply overflows"));
        }
        require!(
            initial <= c.max_supply.0,
            "Launch supply exceeds the maximum supply"
        );

        let mut this = Self {
            token: FungibleToken::new(StorageKey::Token),
            metadata: FungibleTokenMetadata {
                spec: FT_METADATA_SPEC.to_string(),
                name: c.name,
                symbol: c.symbol,
                icon: c.icon,
                reference: None,
                reference_hash: None,
                decimals: c.decimals,
            },
            params: Params {
                day_ns: c.day_length_secs.0 * NS_PER_SEC,
                muster_target: c.muster_target,
                mint_per_muster: c.mint_per_muster.0,
                burn_bps: c.burn_bps,
                min_balance: c.min_balance.0,
                max_supply: c.max_supply.0,
            },
            launch_ns: env::block_timestamp(),
            open_day: 0,
            open_musters: 0,
            streak: 0,
            longest_streak: 0,
            longest_streak_end_day: 0,
            unclaimed: 0,
            total_minted: 0,
            total_burned: 0,
            rewards: LookupMap::new(StorageKey::Rewards),
            last_muster: LookupMap::new(StorageKey::LastMuster),
            log: Vector::new(StorageKey::Log),
        };

        this.token.internal_register_account(&me);
        this.token.internal_deposit(&me, c.war_chest.0);
        FtMint {
            owner_id: &me,
            amount: c.war_chest,
            memo: Some("war chest"),
        }
        .emit();
        for a in &c.allocations {
            require!(
                !this.token.accounts.contains_key(&a.account_id),
                "Each account can receive one launch allocation"
            );
            this.token.internal_register_account(&a.account_id);
            this.token.internal_deposit(&a.account_id, a.amount.0);
            FtMint {
                owner_id: &a.account_id,
                amount: a.amount,
                memo: Some("launch allocation"),
            }
            .emit();
        }
        this
    }

    // ─── The ritual ─────────────────────────────────────────────────────

    /// Checks in for today. Closes ended days first and mints the reward of the
    /// caller's previous muster if its day met the target.
    pub fn muster(&mut self) -> MusterResult {
        self.close_elapsed();
        let account = env::predecessor_account_id();
        require!(
            account != env::current_account_id(),
            "The war chest cannot muster"
        );
        let claimed = self.claim_pending(&account);
        require!(
            !self.last_muster.contains_key(&account),
            "Already mustered today"
        );
        let balance = self.token.accounts.get(&account).unwrap_or(0);
        require!(
            balance >= self.params.min_balance,
            "Hold at least the minimum balance to muster"
        );
        let day = self.open_day;
        self.last_muster.insert(account.clone(), day);
        self.open_musters += 1;
        emit(
            "muster",
            json!({
                "account_id": account,
                "day": day,
                "musters": self.open_musters,
                "muster_target": self.params.muster_target,
            }),
        );
        MusterResult {
            day,
            musters: self.open_musters,
            muster_target: self.params.muster_target,
            claimed: U128(claimed),
        }
    }

    /// Mints the reward for `account_id`'s last muster if its day is closed and
    /// met the target. Anyone may call it; the coins only go to `account_id`.
    pub fn claim_reward(&mut self, account_id: AccountId) -> U128 {
        self.close_elapsed();
        U128(self.claim_pending(&account_id))
    }

    /// Closes every day that has ended. Anyone may call it. Returns the number of
    /// log entries added.
    pub fn close_days(&mut self) -> u32 {
        self.close_elapsed()
    }

    /// Burns the caller's own coins.
    #[payable]
    pub fn burn(&mut self, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "The amount should be a positive number");
        let account = env::predecessor_account_id();
        self.assert_can_spend(&account, amount.0);
        self.token.internal_withdraw(&account, amount.0);
        self.total_burned += amount.0;
        FtBurn {
            owner_id: &account,
            amount,
            memo: Some("holder burn"),
        }
        .emit();
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_params(&self) -> ParamsView {
        ParamsView {
            launch_ns: U64(self.launch_ns),
            day_length_secs: U64(self.params.day_ns / NS_PER_SEC),
            muster_target: self.params.muster_target,
            mint_per_muster: U128(self.params.mint_per_muster),
            burn_bps: self.params.burn_bps,
            min_balance: U128(self.params.min_balance),
            max_supply: U128(self.params.max_supply),
        }
    }

    pub fn get_state(&self) -> StateView {
        let today = self.current_day();
        let pending = self.pending_close(today);
        let tally = pending.last().map_or(self.tally(), |c| c.tally);
        let pending_burn: u128 = pending.iter().map(|c| c.burned).sum();
        StateView {
            day: today,
            day_ends_at_ns: U64(self.day_start_ns(today + 1)),
            today_musters: if pending.is_empty() {
                self.open_musters
            } else {
                0
            },
            muster_target: self.params.muster_target,
            streak: tally.streak,
            longest_streak: tally.longest_streak,
            longest_streak_end_day: (tally.longest_streak > 0)
                .then_some(tally.longest_streak_end_day),
            war_chest: U128(tally.war_chest),
            total_supply: U128(tally.total_supply),
            unclaimed_rewards: U128(tally.unclaimed),
            total_minted: U128(self.total_minted),
            total_burned: U128(self.total_burned + pending_burn),
            log_len: u64::from(self.log.len()),
            pending_entries: pending.len() as u32,
        }
    }

    /// Stored log entries, oldest first.
    pub fn get_log(&self, from_index: u64, limit: u64) -> Vec<LogEntryView> {
        let len = u64::from(self.log.len());
        let end = from_index.saturating_add(limit.min(MAX_PAGE)).min(len);
        (from_index..end)
            .filter_map(|i| self.log.get(i as u32))
            .map(LogEntryView::from)
            .collect()
    }

    /// Entries that the next `close_days` would add (days that ended but are not closed).
    pub fn get_pending_log(&self) -> Vec<LogEntryView> {
        self.pending_close(self.current_day())
            .iter()
            .map(|c| LogEntryView::from(&LogEntry::from(c)))
            .collect()
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let today = self.current_day();
        let balance = self.token.accounts.get(&account_id).unwrap_or(0);
        let last = self.last_muster.get(&account_id).copied();
        let pending_reward = match last {
            Some(day) if day < today => match self.rewards.get(&day) {
                Some(&rpm) => rpm,
                // The day ended but is not closed yet: project it.
                None if day == self.open_day => self
                    .pending_close(today)
                    .first()
                    .filter(|c| c.outcome == DayOutcome::Streak)
                    .map_or(0, |c| c.reward_per_muster),
                None => 0,
            },
            _ => 0,
        };
        AccountView {
            balance: U128(balance),
            mustered_today: last == Some(today),
            pending_reward: U128(pending_reward),
            locked_until_ns: (last == Some(today)).then(|| U64(self.day_start_ns(today + 1))),
        }
    }

    // ─── Internals ──────────────────────────────────────────────────────

    fn current_day(&self) -> u64 {
        (env::block_timestamp().saturating_sub(self.launch_ns)) / self.params.day_ns
    }

    fn day_start_ns(&self, day: u64) -> u64 {
        self.launch_ns + day * self.params.day_ns
    }

    fn rules(&self) -> Rules {
        Rules {
            muster_target: self.params.muster_target,
            mint_per_muster: self.params.mint_per_muster,
            burn_bps: self.params.burn_bps,
            max_supply: self.params.max_supply,
        }
    }

    fn tally(&self) -> Tally {
        Tally {
            streak: self.streak,
            longest_streak: self.longest_streak,
            longest_streak_end_day: self.longest_streak_end_day,
            war_chest: self
                .token
                .accounts
                .get(&env::current_account_id())
                .unwrap_or(0),
            total_supply: self.token.total_supply,
            unclaimed: self.unclaimed,
        }
    }

    fn pending_close(&self, today: u64) -> Vec<Closed> {
        rules::close_days(
            &self.rules(),
            self.tally(),
            self.open_day,
            self.open_musters,
            today,
        )
    }

    fn close_elapsed(&mut self) -> u32 {
        let today = self.current_day();
        let closed = self.pending_close(today);
        let Some(last) = closed.last().copied() else {
            return 0;
        };
        let me = env::current_account_id();
        for c in &closed {
            if c.burned > 0 {
                self.token.internal_withdraw(&me, c.burned);
                self.total_burned += c.burned;
                FtBurn {
                    owner_id: &me,
                    amount: U128(c.burned),
                    memo: Some("missed muster"),
                }
                .emit();
            }
            if c.outcome == DayOutcome::Streak && c.reward_per_muster > 0 {
                self.rewards.insert(c.from_day, c.reward_per_muster);
            }
            let entry = LogEntry::from(c);
            emit("day_closed", log_json(&LogEntryView::from(&entry)));
            self.log.push(entry);
        }
        self.streak = last.tally.streak;
        self.longest_streak = last.tally.longest_streak;
        self.longest_streak_end_day = last.tally.longest_streak_end_day;
        self.unclaimed = last.tally.unclaimed;
        self.open_day = today;
        self.open_musters = 0;
        closed.len() as u32
    }

    /// Mints the reward of `account`'s last muster once its day is closed.
    /// Call after `close_elapsed`.
    fn claim_pending(&mut self, account: &AccountId) -> u128 {
        let Some(&day) = self.last_muster.get(account) else {
            return 0;
        };
        if day >= self.open_day {
            return 0;
        }
        self.last_muster.remove(account);
        let reward = self.rewards.get(&day).copied().unwrap_or(0);
        if reward == 0 {
            return 0;
        }
        self.unclaimed -= reward;
        if !self.token.accounts.contains_key(account) {
            // Unregistered accounts forfeit; the reward is simply never minted.
            return 0;
        }
        self.token.internal_deposit(account, reward);
        self.total_minted += reward;
        FtMint {
            owner_id: account,
            amount: U128(reward),
            memo: Some("muster reward"),
        }
        .emit();
        reward
    }

    /// An account that mustered today keeps `min_balance` until the day ends.
    fn assert_can_spend(&self, account: &AccountId, amount: u128) {
        if self.last_muster.get(account) == Some(&self.current_day()) {
            let balance = self.token.accounts.get(account).unwrap_or(0);
            require!(
                balance.saturating_sub(amount) >= self.params.min_balance,
                "Mustered today: keep the minimum balance until the day ends"
            );
        }
    }
}

fn log_json(e: &LogEntryView) -> Value {
    near_sdk::serde_json::to_value(e).unwrap_or(Value::Null)
}

/// Emits a NEP-297 event: `EVENT_JSON:{...}`.
fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near]
impl FungibleTokenCore for Valt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.assert_can_spend(&env::predecessor_account_id(), amount.0);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.assert_can_spend(&env::predecessor_account_id(), amount.0);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Valt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        // The standard already emits `ft_burn` for coins it could not refund.
        self.total_burned += burned;
        U128(used)
    }
}

#[near]
impl StorageManagement for Valt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let account = env::predecessor_account_id();
        require!(
            !self.last_muster.contains_key(&account),
            "Claim the muster reward before unregistering"
        );
        if let Some((account, balance)) = self.token.internal_storage_unregister(force) {
            if balance > 0 {
                self.total_burned += balance;
                FtBurn {
                    owner_id: &account,
                    amount: U128(balance),
                    memo: Some("forced unregister"),
                }
                .emit();
            }
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Valt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests;
