//! Testnet token faucet for NEP-141 representation tokens.
//!
//! The faucet never mints. It holds representation tokens that were already minted from finalized custody
//! (`claim_representation` on the backing contract) and sent to this account, and gives a fixed amount of each to
//! a caller who asks. The claimer is always the caller: no argument can name another recipient.
//!
//! Limits: one claim per account and token per cooldown, and an optional daily budget per token that bounds how
//! much one day of claims can take, so a script that makes many accounts cannot empty the stock in one go. The
//! faucet pays the token's storage registration for a new holder from its own NEAR balance (the daily budget bounds
//! that too); the claimer pays only for the claim record they add.
//!
//! State is updated before any external call. If the transfer fails, the callback restores the claim record, the
//! daily budget and refunds the record deposit, so a failed claim costs the claimer neither their cooldown nor
//! their deposit.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise,
};

const NANOS_PER_SEC: u64 = 1_000_000_000;
/// Default time between two claims of the same token by the same account.
pub const DEFAULT_COOLDOWN_SECS: u64 = 24 * 60 * 60;
pub const MIN_COOLDOWN_SECS: u64 = 60;
pub const MAX_COOLDOWN_SECS: u64 = 30 * 24 * 60 * 60;
/// The daily budget window.
pub const WINDOW_NS: u64 = 24 * 60 * 60 * NANOS_PER_SEC;
/// Most tokens the faucet can offer, so listing them stays bounded.
pub const MAX_TOKENS: u32 = 32;
pub const MAX_SYMBOL_LEN: usize = 16;
/// NEP-145 minimum storage deposit for a new holder (0.00125 NEAR), paid by the faucet.
pub const REGISTRATION_DEPOSIT: NearToken =
    NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_STORAGE: Gas = Gas::from_tgas(15);
const GAS_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_WITHDRAW: Gas = Gas::from_tgas(30);
/// A claim chains three calls; it fails closed unless enough gas is attached for all of them.
pub const MIN_CLAIM_GAS: Gas = Gas::from_tgas(100);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Tokens,
    LastClaim,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct TokenState {
    /// A short display name set by the owner, for example `CASHCAT`. Never an identity.
    symbol: String,
    /// Base units per claim.
    amount: u128,
    /// Most base units handed out per 24 hours; 0 means no daily bound.
    daily_budget: u128,
    window_start_ns: u64,
    window_spent: u128,
}

#[near(serializers = [json])]
pub struct TokenView {
    pub token: AccountId,
    pub symbol: String,
    pub amount: U128,
    pub daily_budget: U128,
    /// What is left of today's budget, or null when the token has no daily bound.
    pub budget_left: Option<U128>,
}

#[near(serializers = [json])]
pub struct ClaimStatus {
    pub last_claim_ns: Option<U64>,
    /// When the account may claim again; 0 when it may claim now.
    pub next_claim_ns: U64,
    pub can_claim: bool,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub paused: bool,
    pub cooldown_secs: U64,
    pub token_count: u32,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Faucet {
    owner: AccountId,
    paused: bool,
    cooldown_ns: u64,
    tokens: IterableMap<AccountId, TokenState>,
    /// `"{account}|{token}"` to the time of the last claim.
    last_claim: LookupMap<String, u64>,
}

fn claim_key(account: &AccountId, token: &AccountId) -> String {
    format!("{account}|{token}")
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "valtrum_faucet", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Faucet {
    #[init]
    pub fn new(owner: AccountId, cooldown_secs: Option<U64>) -> Self {
        let cooldown = cooldown_secs.map_or(DEFAULT_COOLDOWN_SECS, |s| s.0);
        require!(
            (MIN_COOLDOWN_SECS..=MAX_COOLDOWN_SECS).contains(&cooldown),
            "Cooldown is out of range"
        );
        Self {
            owner,
            paused: false,
            cooldown_ns: cooldown * NANOS_PER_SEC,
            tokens: IterableMap::new(StorageKey::Tokens),
            last_claim: LookupMap::new(StorageKey::LastClaim),
        }
    }

    // ── Claiming ───────────────────────────────────────────────────────────────────────────────────

    /// Gives the caller the configured amount of `token`. The first claim of a token attaches a small deposit for
    /// the claim record; the unused part is refunded. Attach at least 100 Tgas.
    #[payable]
    pub fn claim(&mut self, token: AccountId) -> Promise {
        require!(!self.paused, "Faucet is paused");
        require!(
            env::prepaid_gas() >= MIN_CLAIM_GAS,
            "Attach at least 100 Tgas"
        );
        // The claimer is always the caller, never an argument.
        let user = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mut state = self
            .tokens
            .get(&token)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Token is not offered"));
        let key = claim_key(&user, &token);
        let previous = self.last_claim.get(&key).copied();
        if let Some(prev) = previous {
            require!(
                now >= prev.saturating_add(self.cooldown_ns),
                "Cooldown has not passed"
            );
        }
        if now.saturating_sub(state.window_start_ns) >= WINDOW_NS {
            state.window_start_ns = now;
            state.window_spent = 0;
        }
        let spent = state
            .window_spent
            .checked_add(state.amount)
            .unwrap_or_else(|| env::panic_str("Budget overflow"));
        require!(
            state.daily_budget == 0 || spent <= state.daily_budget,
            "Daily budget is used up"
        );
        state.window_spent = spent;
        let amount = state.amount;
        let window_start = state.window_start_ns;

        // State first, external calls after.
        let before = env::storage_usage();
        self.last_claim.insert(key, now);
        self.last_claim.flush();
        let grown = env::storage_usage().saturating_sub(before);
        let record_cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(grown))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        self.tokens.insert(token.clone(), state);
        self.tokens.flush();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= record_cost,
            "Attach the storage deposit for the claim record"
        );
        let excess = attached - record_cost;
        if excess > 0 {
            Promise::new(user.clone())
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }

        ext_ft::ext(token.clone())
            .with_static_gas(GAS_STORAGE)
            .with_attached_deposit(REGISTRATION_DEPOSIT)
            .storage_deposit(Some(user.clone()), Some(true))
            .then(
                ext_ft::ext(token.clone())
                    .with_static_gas(GAS_TRANSFER)
                    .with_attached_deposit(NearToken::from_yoctonear(1))
                    .ft_transfer(user.clone(), U128(amount), None),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_claimed(
                        user,
                        token,
                        U128(amount),
                        previous.map(U64),
                        U64(window_start),
                        U128(record_cost),
                    ),
            )
    }

    /// Finishes a claim. If the transfer failed (no stock, a paused token, a failed registration) the claim record,
    /// the daily budget and the record deposit are restored.
    #[private]
    pub fn on_claimed(
        &mut self,
        user: AccountId,
        token: AccountId,
        amount: U128,
        previous: Option<U64>,
        window_start: U64,
        record_cost: U128,
    ) -> bool {
        if env::promise_result_checked(0, 64).is_ok() {
            emit(
                "claimed",
                json!({"account": user, "token": token, "amount": amount, "at": U64(env::block_timestamp())}),
            );
            return true;
        }
        let key = claim_key(&user, &token);
        match previous {
            Some(p) => {
                self.last_claim.insert(key, p.0);
            }
            None => {
                self.last_claim.remove(&key);
            }
        }
        self.last_claim.flush();
        if let Some(mut state) = self.tokens.get(&token).cloned() {
            // Only give the budget back when the window it was taken from is still the current one.
            if state.window_start_ns == window_start.0 {
                state.window_spent = state.window_spent.saturating_sub(amount.0);
                self.tokens.insert(token.clone(), state);
                self.tokens.flush();
            }
        }
        if previous.is_none() && record_cost.0 > 0 {
            Promise::new(user.clone())
                .transfer(NearToken::from_yoctonear(record_cost.0))
                .detach();
        }
        emit(
            "claim_failed",
            json!({"account": user, "token": token, "amount": amount}),
        );
        false
    }

    // ── Views ──────────────────────────────────────────────────────────────────────────────────────

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            paused: self.paused,
            cooldown_secs: U64(self.cooldown_ns / NANOS_PER_SEC),
            token_count: self.tokens.len(),
        }
    }

    pub fn get_tokens(&self) -> Vec<TokenView> {
        let now = env::block_timestamp();
        self.tokens
            .iter()
            .map(|(token, s)| view_of(token, s, now))
            .collect()
    }

    pub fn get_claim_status(&self, account_id: AccountId, token: AccountId) -> ClaimStatus {
        let last = self
            .last_claim
            .get(&claim_key(&account_id, &token))
            .copied();
        let now = env::block_timestamp();
        let next = last.map_or(0, |l| l.saturating_add(self.cooldown_ns));
        let can_claim = !self.paused && self.tokens.contains_key(&token) && now >= next;
        ClaimStatus {
            last_claim_ns: last.map(U64),
            next_claim_ns: U64(if now >= next { 0 } else { next }),
            can_claim,
        }
    }

    // ── Owner ──────────────────────────────────────────────────────────────────────────────────────

    /// Offers `token` (or changes its amounts). `daily_budget` of 0 means no daily bound.
    pub fn set_token(
        &mut self,
        token: AccountId,
        symbol: String,
        amount: U128,
        daily_budget: U128,
    ) {
        self.assert_owner();
        require!(
            (1..=MAX_SYMBOL_LEN).contains(&symbol.len())
                && symbol.bytes().all(|b| b.is_ascii_alphanumeric()),
            "The symbol must be 1 to 16 letters or digits"
        );
        require!(amount.0 > 0, "The claim amount must be positive");
        require!(
            daily_budget.0 == 0 || daily_budget.0 >= amount.0,
            "The daily budget must cover at least one claim"
        );
        let existing = self.tokens.get(&token).cloned();
        if existing.is_none() {
            require!(self.tokens.len() < MAX_TOKENS, "Too many tokens");
        }
        let (window_start_ns, window_spent) =
            existing.map_or((0, 0), |s| (s.window_start_ns, s.window_spent));
        self.tokens.insert(
            token.clone(),
            TokenState {
                symbol: symbol.clone(),
                amount: amount.0,
                daily_budget: daily_budget.0,
                window_start_ns,
                window_spent,
            },
        );
        self.tokens.flush();
        emit(
            "token_set",
            json!({"token": token, "symbol": symbol, "amount": amount, "daily_budget": daily_budget}),
        );
    }

    pub fn remove_token(&mut self, token: AccountId) {
        self.assert_owner();
        require!(self.tokens.remove(&token).is_some(), "Token is not offered");
        self.tokens.flush();
        emit("token_removed", json!({"token": token}));
    }

    pub fn set_cooldown_secs(&mut self, secs: U64) {
        self.assert_owner();
        require!(
            (MIN_COOLDOWN_SECS..=MAX_COOLDOWN_SECS).contains(&secs.0),
            "Cooldown is out of range"
        );
        self.cooldown_ns = secs.0 * NANOS_PER_SEC;
        emit("cooldown_set", json!({"secs": secs}));
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("paused_set", json!({"paused": paused}));
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        emit("owner_set", json!({"owner": owner}));
        self.owner = owner;
    }

    /// Sends stock back out. One yoctoNEAR is required by the token's `ft_transfer`.
    #[payable]
    pub fn withdraw_ft(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> Promise {
        self.assert_owner();
        assert_one_yocto();
        require!(amount.0 > 0, "Amount must be positive");
        emit(
            "withdrawn",
            json!({"token": token, "receiver": receiver_id, "amount": amount}),
        );
        ext_ft::ext(token)
            .with_static_gas(GAS_WITHDRAW)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .ft_transfer(receiver_id, amount, None)
    }

    /// Sends NEAR back out (the runtime keeps what storage still needs).
    pub fn withdraw_near(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "Amount must be positive");
        emit(
            "near_withdrawn",
            json!({"receiver": receiver_id, "amount": amount}),
        );
        Promise::new(receiver_id).transfer(NearToken::from_yoctonear(amount.0))
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner"
        );
    }
}

fn view_of(token: &AccountId, s: &TokenState, now: u64) -> TokenView {
    let current = if now.saturating_sub(s.window_start_ns) >= WINDOW_NS {
        0
    } else {
        s.window_spent
    };
    TokenView {
        token: token.clone(),
        symbol: s.symbol.clone(),
        amount: U128(s.amount),
        daily_budget: U128(s.daily_budget),
        budget_left: (s.daily_budget > 0).then(|| U128(s.daily_budget.saturating_sub(current))),
    }
}

#[cfg(test)]
mod tests;
