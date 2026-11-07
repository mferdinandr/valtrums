use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod credit;
pub mod events;
pub mod lifecycle;
pub mod math;
pub mod mpc;
pub mod rounds;
pub mod rounds_api;
pub mod scoring;
pub mod settle_api;
pub mod settlement;
pub mod types;
pub mod views;

use credit::plan_funding;
use math::Outcome;
use mpc::{
    ForeignCall, ForeignConfig, ForeignConfigInput, ForeignTxParams, SignRequest, SignStatus,
};
use types::{
    Account, Battle, BattleStatus, Settlement, SettlementStep, Side, StepKind, UserPosition,
    NS_PER_SECOND,
};
use views::{
    AccountView, BattleView, ConfigView, ForeignConfigView, FundingPreview, PositionView,
    SettlementStepView, SignRequestView,
};

/// Longest battle a proposer can request.
const MAX_DURATION_SECS: u64 = 30 * 24 * 60 * 60;
/// Gas for the USDC transfer out to the treasury and its callback.
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
/// Minimum gas for the USDC hop to the router; the rest of the call's gas is
/// handed to it (via unused-gas weight) because the swap spans several hops.
const ROUTER_HOP_GAS: Gas = Gas::from_tgas(30);
const SWAP_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Minimum gas for the hop to the execution DEX; the rest of the call's gas follows it.
const EXECUTION_HOP_GAS: Gas = Gas::from_tgas(60);
/// Gas for the MPC signer call and for the callback that stores its answer.
const MPC_SIGN_GAS: Gas = Gas::from_tgas(250);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// A failed signing request can be retried this many times.
const MAX_SIGN_ATTEMPTS: u32 = 5;
/// Most battles `get_battles` returns in one call.
const MAX_PAGE_SIZE: u64 = 100;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agents,
    Battles,
    Accounts,
    Positions,
    Liquid,
    SignRequests,
    LifecycleBattles,
    LifecyclePositions,
    LifecycleRounds,
    LifecycleParticipants,
    LifecycleParticipantCounts,
    LifecycleSettlement,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

/// Messages accepted through `ft_transfer_call`.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
enum TransferMsg {
    Propose {
        token_a: AccountId,
        token_b: AccountId,
        duration_secs: u64,
    },
    DepositUsdc {
        battle_id: u64,
        side: Side,
        total_usdc: U128,
        min_token_out: U128,
    },
    /// Deposit a registered position using its configured representation token.
    LifecycleDeposit { battle_id: u64, community: u32 },
    /// Adds the transferred USDC to the sender's internal balance.
    FundBalance,
    /// Output of a settlement step, paid back by the execution DEX.
    StepProceeds { battle_id: u64, step_index: u32 },
    Deposit {
        battle_id: u64,
        side: Side,
        /// Only honored when the sender is the configured router.
        beneficiary: Option<AccountId>,
        usdc_equiv: Option<U128>,
        from_credit: Option<U128>,
    },
}

/// Where settlement steps are executed when the arena does it itself.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
struct ExecutionConfig {
    dex: AccountId,
    burn_account: AccountId,
}

/// A validated USDC deposit, ready to be forwarded to the router.
struct PreparedDeposit {
    router: AccountId,
    msg: String,
    from_credit: u128,
    from_wallet: u128,
    credit_expires_at_ns: u64,
}

/// Deposit details attached by the router after a swap.
struct RoutedDeposit {
    beneficiary: AccountId,
    usdc_equiv: u128,
    from_credit: u128,
}

/// Battle arena contract: battle lifecycle, vaults, positions and settlement.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Arena {
    owner: AccountId,
    usdc: AccountId,
    treasury: AccountId,
    /// Bond (USDC base units) paid when proposing a battle.
    bond: u128,
    /// How long deposits stay open after the agent approves a battle.
    deposit_window_secs: u64,
    agents: IterableSet<AccountId>,
    /// Router that swaps USDC into a side's coin and delivers the deposit.
    router: Option<AccountId>,
    execution: Option<ExecutionConfig>,
    paused: bool,
    /// USDC owed to the treasury, paid out by `flush_treasury`.
    treasury_accrued: u128,
    battles: LookupMap<u64, Battle>,
    battle_count: u64,
    accounts: LookupMap<AccountId, Account>,
    /// One position per (battle, account).
    positions: LookupMap<(u64, AccountId), UserPosition>,
    /// Withdrawable balances per (account, token).
    liquid: LookupMap<(AccountId, AccountId), u128>,
    /// Foreign-chain settings; `None` disables cross-chain signing.
    foreign: Option<ForeignConfig>,
    sign_requests: LookupMap<u64, SignRequest>,
    sign_request_count: u64,
    /// Redesign state; existing deployments require a new deployment, not migration.
    lifecycle_battles: LookupMap<u64, lifecycle::Battle>,
    lifecycle_positions: LookupMap<(u64, u32, AccountId), u128>,
    lifecycle_battle_count: u64,
    lifecycle_protocol: Option<AccountId>,
    lifecycle_observation_policy: Option<lifecycle::ObservationPolicy>,
    lifecycle_exclusive: bool,
    /// The only account that opens rounds and submits observations. Set once.
    lifecycle_oracle: Option<AccountId>,
    lifecycle_rounds: LookupMap<u64, rounds::Rounds>,
    /// Registered positions in registration order, so settlement can enumerate
    /// a community's participants: (battle, community, index) -> account.
    lifecycle_participants: LookupMap<(u64, u32, u32), AccountId>,
    lifecycle_participant_counts: LookupMap<(u64, u32), u32>,
    /// Entitlements already handed to the backings, per battle.
    lifecycle_settlement: LookupMap<u64, u32>,
    /// Fee settings snapshotted into each new lifecycle battle.
    lifecycle_fee_bps: u16,
    lifecycle_creator_share_bps: u16,
}

/// Total fee on a losing vault can never be set above 10%.
pub const MAX_LIFECYCLE_FEE_BPS: u16 = 1_000;
const MAX_BPS: u16 = 10_000;

#[near]
impl Arena {
    #[init]
    pub fn new(
        owner: AccountId,
        usdc: AccountId,
        treasury: AccountId,
        bond: U128,
        deposit_window_secs: U64,
    ) -> Self {
        require!(
            (1..=MAX_DURATION_SECS).contains(&deposit_window_secs.0),
            "Deposit window must be between 1 second and 30 days"
        );
        Self {
            owner,
            usdc,
            treasury,
            bond: bond.0,
            deposit_window_secs: deposit_window_secs.0,
            agents: IterableSet::new(StorageKey::Agents),
            router: None,
            execution: None,
            paused: false,
            treasury_accrued: 0,
            battles: LookupMap::new(StorageKey::Battles),
            battle_count: 0,
            accounts: LookupMap::new(StorageKey::Accounts),
            positions: LookupMap::new(StorageKey::Positions),
            liquid: LookupMap::new(StorageKey::Liquid),
            foreign: None,
            sign_requests: LookupMap::new(StorageKey::SignRequests),
            sign_request_count: 0,
            lifecycle_battles: LookupMap::new(StorageKey::LifecycleBattles),
            lifecycle_positions: LookupMap::new(StorageKey::LifecyclePositions),
            lifecycle_battle_count: 0,
            lifecycle_protocol: None,
            lifecycle_observation_policy: None,
            lifecycle_exclusive: false,
            lifecycle_oracle: None,
            lifecycle_rounds: LookupMap::new(StorageKey::LifecycleRounds),
            lifecycle_participants: LookupMap::new(StorageKey::LifecycleParticipants),
            lifecycle_participant_counts: LookupMap::new(StorageKey::LifecycleParticipantCounts),
            lifecycle_settlement: LookupMap::new(StorageKey::LifecycleSettlement),
            lifecycle_fee_bps: 10,
            lifecycle_creator_share_bps: 5_000,
        }
    }

    /// Protocol only. Sets the total fee on each losing vault (at most 10%) and
    /// the creator's share of that fee (0-100%) for battles created afterwards.
    /// Existing battles keep the fee they were created with.
    #[payable]
    pub fn set_lifecycle_fee(&mut self, fee_bps: u16, creator_share_bps: u16) {
        near_sdk::assert_one_yocto();
        require!(
            self.lifecycle_protocol.as_ref() == Some(&env::predecessor_account_id()),
            "Only the protocol account can change fees"
        );
        require!(
            fee_bps <= MAX_LIFECYCLE_FEE_BPS,
            "Total fee cannot exceed 1000 bps"
        );
        require!(
            creator_share_bps <= MAX_BPS,
            "Creator share cannot exceed 10000 bps"
        );
        self.lifecycle_fee_bps = fee_bps;
        self.lifecycle_creator_share_bps = creator_share_bps;
    }

    /// Fee settings that the next lifecycle battle will snapshot, as
    /// (total fee bps, creator share bps).
    pub fn get_lifecycle_fee(&self) -> (u16, u16) {
        (self.lifecycle_fee_bps, self.lifecycle_creator_share_bps)
    }

    /// Fix the oracle account once. It cannot be changed or removed afterwards,
    /// so the owner cannot swap the data source after battles lock.
    #[payable]
    pub fn set_lifecycle_oracle(&mut self, oracle: AccountId) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        require!(self.lifecycle_oracle.is_none(), "Oracle is already set");
        self.lifecycle_oracle = Some(oracle);
    }

    /// Permanently isolate a fresh contract from legacy battles before enabling
    /// lifecycle custody. Existing deployments and positions are not migrated.
    #[payable]
    pub fn activate_lifecycle(&mut self) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        require!(
            self.battle_count == 0,
            "Legacy battles prevent lifecycle activation"
        );
        self.lifecycle_exclusive = true;
    }

    /// Configure the protocol identity for future lifecycle battles. Existing
    /// battles retain their creation-time identity and fee policy.
    #[payable]
    pub fn set_lifecycle_protocol(&mut self, protocol: AccountId) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        self.lifecycle_protocol = Some(protocol);
    }

    /// Set the observation policy used by future locks. Existing snapshots
    /// retain the policy that was committed when they locked.
    #[payable]
    pub fn set_lifecycle_observation_policy(&mut self, policy: lifecycle::ObservationPolicyInput) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        let policy: lifecycle::ObservationPolicy = policy.into();
        require!(policy.is_valid(), "Observation policy is invalid");
        self.lifecycle_observation_policy = Some(policy);
    }

    /// Freeze the credited positions and policy. A repeated call preserves the
    /// original snapshot. Starting rounds remains the scoring integration's job.
    #[payable]
    pub fn lock_lifecycle_battle(&mut self, battle_id: u64) {
        self.assert_agent();
        require!(!self.paused, "Arena is paused");
        let policy = self
            .lifecycle_observation_policy
            .clone()
            .unwrap_or_else(|| env::panic_str("Observation policy is not configured"));
        let caller = env::predecessor_account_id();
        let before = env::storage_usage();
        self.lifecycle_lock(battle_id, policy)
            .unwrap_or_else(|_| env::panic_str("Lifecycle battle cannot be locked"));
        self.lifecycle_battles.flush();
        let bytes = env::storage_usage()
            .checked_sub(before)
            .unwrap_or_else(|| env::panic_str("Storage accounting failed"));
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        let refund = attached - cost;
        if refund > 0 {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
    }

    /// Create an audit-pending battle without a proposal bond. The attached
    /// NEAR pays for the record's actual storage; excess is returned. No token
    /// deposit can be credited until the backing and audit adapters are wired.
    #[payable]
    pub fn create_lifecycle_battle(
        &mut self,
        assets: Vec<lifecycle::AssetInput>,
        mode: lifecycle::ScoringMode,
    ) -> u64 {
        require!(!self.paused, "Arena is paused");
        require!(self.lifecycle_exclusive, "Lifecycle is not activated");
        require!(
            assets.iter().all(|asset| asset.representation != self.usdc),
            "USDC cannot be a lifecycle representation"
        );
        let protocol = self
            .lifecycle_protocol
            .clone()
            .unwrap_or_else(|| env::panic_str("Lifecycle protocol is not configured"));
        let creator = env::predecessor_account_id();
        let fee = lifecycle::FeePolicy {
            fee_bps: self.lifecycle_fee_bps,
            creator_share_bps: self.lifecycle_creator_share_bps,
            protocol_created: creator == protocol,
            creator: creator.clone(),
            protocol,
        };
        let assets = assets.into_iter().map(Into::into).collect();
        let battle = lifecycle::Battle::new(assets, mode, fee)
            .unwrap_or_else(|_| env::panic_str("Invalid lifecycle battle"));
        let before = env::storage_usage();
        let id = self
            .lifecycle_insert(battle)
            .unwrap_or_else(|_| env::panic_str("Battle count overflow"));
        self.lifecycle_battles.flush();
        let bytes = env::storage_usage()
            .checked_sub(before)
            .unwrap_or_else(|| env::panic_str("Storage accounting failed"));
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        let refund = attached - cost;
        if refund > 0 {
            Promise::new(creator.clone())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
        events::emit(
            "lifecycle_battle_created",
            json!({ "battle_id": id, "creator": creator }),
        );
        id
    }

    /// Read the lifecycle state; evidence references are not proof of live backing.
    pub fn get_lifecycle_battle(&self, battle_id: u64) -> Option<lifecycle::LifecycleView> {
        self.lifecycle_battles
            .get(&battle_id)
            .map(lifecycle::Battle::view)
    }

    pub fn get_lifecycle_position(
        &self,
        battle_id: u64,
        community: u32,
        account: AccountId,
    ) -> lifecycle::LifecyclePositionView {
        let position = self
            .lifecycle_positions
            .get(&(battle_id, community, account))
            .copied();
        lifecycle::LifecyclePositionView {
            registered: position.is_some(),
            amount: U128(position.unwrap_or(0)),
        }
    }

    /// Reserve storage for one position. This is storage payment, not a stake.
    #[payable]
    pub fn register_lifecycle_position(&mut self, battle_id: u64, community: u32) {
        require!(!self.paused, "Arena is paused");
        let account = env::predecessor_account_id();
        let before = env::storage_usage();
        self.lifecycle_register_position(battle_id, community, &account)
            .unwrap_or_else(|_| env::panic_str("Cannot register position"));
        self.lifecycle_positions.flush();
        self.lifecycle_participants.flush();
        self.lifecycle_participant_counts.flush();
        let bytes = env::storage_usage()
            .checked_sub(before)
            .unwrap_or_else(|| env::panic_str("Storage accounting failed"));
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        let refund = attached - cost;
        if refund > 0 {
            Promise::new(account)
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }
    }

    // ─── Owner configuration ────────────────────────────────────────────

    pub fn add_agent(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.agents.insert(account_id);
    }

    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.agents.remove(&account_id);
    }

    pub fn set_treasury(&mut self, treasury: AccountId) {
        self.assert_owner();
        self.treasury = treasury;
    }

    /// Sets (or clears) the router that is trusted to deliver swapped deposits.
    pub fn set_router(&mut self, router: Option<AccountId>) {
        self.assert_owner();
        self.router = router;
    }

    /// Turns on on-chain execution of settlement steps through `dex`, sending burned
    /// coins to `burn_account` (it must be registered with the coin). Pass both as
    /// `None` to return to agent-reported execution.
    pub fn set_execution(&mut self, dex: Option<AccountId>, burn_account: Option<AccountId>) {
        self.assert_owner();
        self.execution = match (dex, burn_account) {
            (Some(dex), Some(burn_account)) => Some(ExecutionConfig { dex, burn_account }),
            (None, None) => None,
            _ => env::panic_str("Set both the DEX and the burn account, or neither"),
        };
    }

    /// Sets (or clears) the foreign chain and MPC signer used for cross-chain steps.
    pub fn set_foreign(&mut self, config: Option<ForeignConfigInput>) {
        self.assert_owner();
        self.foreign = config.map(|input| {
            ForeignConfig::from_input(input)
                .unwrap_or_else(|_| env::panic_str("Invalid foreign address"))
        });
    }

    pub fn set_bond(&mut self, bond: U128) {
        self.assert_owner();
        self.bond = bond.0;
    }

    pub fn set_deposit_window_secs(&mut self, secs: U64) {
        self.assert_owner();
        require!(
            (1..=MAX_DURATION_SECS).contains(&secs.0),
            "Deposit window must be between 1 second and 30 days"
        );
        self.deposit_window_secs = secs.0;
    }

    /// Pauses new proposals and deposits. Refunds and claims stay available.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    // ─── Agent: audit decision ──────────────────────────────────────────

    /// Audit passed: opens the deposit window.
    pub fn approve_battle(&mut self, battle_id: u64) {
        self.assert_agent();
        let window_ns = self.deposit_window_secs * NS_PER_SECOND;
        let battle = self.battle_in_status(battle_id, BattleStatus::Proposed);
        let deadline = env::block_timestamp() + window_ns;
        battle.status = BattleStatus::Approved;
        battle.deposit_deadline_ns = deadline;
        events::emit(
            "battle_approved",
            json!({ "battle_id": battle_id, "deposit_deadline_ns": U64(deadline) }),
        );
    }

    /// Audit failed: the proposal is cancelled and the bond is seized.
    pub fn void_battle(&mut self, battle_id: u64, reason: String) {
        self.assert_agent();
        let battle = self.battle_in_status(battle_id, BattleStatus::Proposed);
        battle.status = BattleStatus::Voided;
        let bond = battle.bond;
        self.accrue_treasury(bond);
        events::emit(
            "battle_voided",
            json!({ "battle_id": battle_id, "reason": reason, "bond_seized": U128(bond) }),
        );
    }

    // ─── Agent: lock ────────────────────────────────────────────────────

    /// Closes the deposit window, records the initial prices once, and starts
    /// the battle timer. A battle with an empty side is voided instead: its
    /// deposits become refundable and the bond stays with the treasury.
    pub fn set_initial_prices(&mut self, battle_id: u64, price_a: U128, price_b: U128) {
        self.assert_agent();
        require!(price_a.0 > 0 && price_b.0 > 0, "Prices must be non-zero");
        let now = env::block_timestamp();
        let battle = self.battle_in_status(battle_id, BattleStatus::Approved);
        require!(
            now >= battle.deposit_deadline_ns,
            "Deposit window is still open"
        );

        if battle.vault_a == 0 || battle.vault_b == 0 {
            battle.status = BattleStatus::Voided;
            let bond = battle.bond;
            self.accrue_treasury(bond);
            events::emit(
                "battle_voided",
                json!({ "battle_id": battle_id, "reason": "empty side", "bond_seized": U128(bond) }),
            );
            return;
        }

        let end_time = now
            .checked_add(battle.duration_ns)
            .unwrap_or_else(|| env::panic_str("End time overflow"));
        battle.initial_price_a = Some(price_a.0);
        battle.initial_price_b = Some(price_b.0);
        battle.status = BattleStatus::Live;
        battle.start_time_ns = now;
        battle.end_time_ns = end_time;
        events::emit(
            "battle_locked",
            json!({
                "battle_id": battle_id,
                "start_time_ns": U64(now),
                "end_time_ns": U64(end_time),
                "initial_price_a": price_a,
                "initial_price_b": price_b,
            }),
        );
    }

    // ─── Agent: settlement ──────────────────────────────────────────────

    /// Submits the final prices after the battle ends. A tie voids the battle
    /// (deposits refundable); otherwise the winner is set and the settlement
    /// plan starts with selling the loser vault.
    pub fn settle_battle(&mut self, battle_id: u64, final_price_a: U128, final_price_b: U128) {
        self.assert_agent();
        require!(
            final_price_a.0 > 0 && final_price_b.0 > 0,
            "Prices must be non-zero"
        );
        let now = env::block_timestamp();
        let battle = self.battle_in_status(battle_id, BattleStatus::Live);
        require!(now >= battle.end_time_ns, "Battle has not ended");
        let (Some(initial_a), Some(initial_b)) = (battle.initial_price_a, battle.initial_price_b)
        else {
            env::panic_str("Initial prices missing")
        };
        let outcome =
            math::determine_winner(initial_a, final_price_a.0, initial_b, final_price_b.0)
                .unwrap_or_else(|_| env::panic_str("Price calculation failed"));
        battle.final_price_a = Some(final_price_a.0);
        battle.final_price_b = Some(final_price_b.0);

        match outcome {
            Outcome::Tie => {
                battle.status = BattleStatus::Voided;
                let (creator, bond) = (battle.creator.clone(), battle.bond);
                events::emit(
                    "battle_voided",
                    json!({ "battle_id": battle_id, "reason": "tie" }),
                );
                self.return_bond(&creator, bond);
            }
            Outcome::Winner(side) => {
                let loser_vault = match side {
                    Side::A => battle.vault_b,
                    Side::B => battle.vault_a,
                };
                battle.winner = Some(side);
                battle.status = BattleStatus::Settling;
                battle.settlement = Some(Settlement {
                    steps: vec![SettlementStep {
                        kind: StepKind::Dump,
                        amount: loser_vault,
                        done: false,
                        realized: 0,
                        min_out: None,
                    }],
                    ..Settlement::default()
                });
                events::emit(
                    "battle_settling",
                    json!({
                        "battle_id": battle_id,
                        "winner": side,
                        "loser_vault": U128(loser_vault),
                    }),
                );
            }
        }
    }

    /// Records the result of one execution step, in order. Reporting the sale of
    /// the loser vault fixes the 55/35/5/5 split of the proceeds and appends the
    /// remaining steps; the last report settles the battle.
    pub fn report_execution(&mut self, battle_id: u64, step_index: u32, realized_amount: U128) {
        self.assert_agent();
        require!(self.execution.is_none(), "Execution runs on-chain");
        self.complete_step(battle_id, step_index, realized_amount.0);
    }

    /// Sends one settlement step to the execution DEX (`Return` is settled right
    /// away). `min_out` is the least output that counts as this step's proceeds;
    /// the DEX refuses the swap below it and the arena rejects any proceeds
    /// below it, so a bad price cannot be booked.
    pub fn execute_step(
        &mut self,
        battle_id: u64,
        step_index: u32,
        min_out: U128,
    ) -> PromiseOrValue<bool> {
        self.assert_agent();
        let execution = self
            .execution
            .clone()
            .unwrap_or_else(|| env::panic_str("On-chain execution is not configured"));
        let usdc = self.usdc.clone();
        let battle = self.battle_in_status(battle_id, BattleStatus::Settling);
        let winner = battle
            .winner
            .unwrap_or_else(|| env::panic_str("Winner missing"));
        let (token_a, token_b) = (battle.token_a.clone(), battle.token_b.clone());
        let (winner_token, loser_token) = match winner {
            Side::A => (token_a, token_b),
            Side::B => (token_b, token_a),
        };
        let settlement = battle
            .settlement
            .as_mut()
            .unwrap_or_else(|| env::panic_str("Settlement missing"));
        let index = step_index as usize;
        require!(index < settlement.steps.len(), "Unknown step");
        require!(!settlement.steps[index].done, "Step already reported");
        require!(
            settlement.steps[..index].iter().all(|step| step.done),
            "Steps must be reported in order"
        );
        require!(
            settlement.steps[index].min_out.is_none(),
            "Step already dispatched"
        );
        let (kind, amount) = (settlement.steps[index].kind, settlement.steps[index].amount);

        if kind == StepKind::Return || amount == 0 {
            let realized = if kind == StepKind::Return { amount } else { 0 };
            self.complete_step(battle_id, step_index, realized);
            return PromiseOrValue::Value(true);
        }

        require!(min_out.0 > 0, "Minimum output must be positive");
        settlement.steps[index].min_out = Some(min_out.0);
        let (token_in, token_out) = match kind {
            StepKind::Dump => (loser_token, usdc),
            _ => (usdc, winner_token),
        };
        let receiver_msg = json!({
            "action": "step_proceeds",
            "battle_id": battle_id,
            "step_index": step_index,
        })
        .to_string();
        let msg = json!({
            "action": "swap",
            "token_out": token_out,
            "min_amount_out": min_out,
            "receiver_id": env::current_account_id(),
            "receiver_msg": receiver_msg,
        })
        .to_string();
        PromiseOrValue::Promise(
            ext_ft::ext(token_in)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(EXECUTION_HOP_GAS)
                .with_unused_gas_weight(1)
                .ft_transfer_call(execution.dex, U128(amount), None, msg)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_step_sent(battle_id, step_index, U128(amount)),
                ),
        )
    }

    /// If the DEX refused the swap, makes the step dispatchable again.
    #[private]
    pub fn on_step_sent(
        &mut self,
        battle_id: u64,
        step_index: u32,
        amount: U128,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        if matches!(result, Ok(used) if used.0 == amount.0) {
            return;
        }
        if let Some(step) = self
            .battles
            .get_mut(&battle_id)
            .and_then(|battle| battle.settlement.as_mut())
            .and_then(|settlement| settlement.steps.get_mut(step_index as usize))
        {
            if !step.done {
                step.min_out = None;
            }
        }
        events::emit(
            "step_dispatch_failed",
            json!({ "battle_id": battle_id, "step_index": step_index }),
        );
    }

    /// Reports whether the burn transfer went through.
    #[private]
    pub fn on_burn_sent(
        &mut self,
        battle_id: u64,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let event = if result.is_ok() {
            "burned"
        } else {
            "burn_failed"
        };
        events::emit(event, json!({ "battle_id": battle_id, "amount": amount }));
    }

    // ─── Agent: emergency halt ──────────────────────────────────────────

    /// Stops a battle whose token is being rugged. No rewards are paid, and every
    /// depositor can take back their deposit; the creator's bond is returned.
    pub fn emergency_halt(&mut self, battle_id: u64, reason: String) {
        self.assert_agent();
        let battle = self
            .battles
            .get_mut(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            matches!(battle.status, BattleStatus::Approved | BattleStatus::Live),
            "Battle cannot be halted"
        );
        battle.status = BattleStatus::EmergencyHalted;
        let (creator, bond) = (battle.creator.clone(), battle.bond);
        events::emit(
            "emergency_halt",
            json!({ "battle_id": battle_id, "reason": reason }),
        );
        self.return_bond(&creator, bond);
    }

    // ─── Claims and withdrawals ─────────────────────────────────────────

    /// Winners claim their principal plus their pro-rata share of the liquid
    /// reward (as withdrawable winner coin) and of the new locked credit.
    pub fn claim(&mut self, battle_id: u64) {
        let account_id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let battle = self
            .battles
            .get(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            battle.status == BattleStatus::Settled,
            "Battle is not settled"
        );
        let winner = battle
            .winner
            .unwrap_or_else(|| env::panic_str("Winner missing"));
        let (winner_token, winner_vault) = match winner {
            Side::A => (battle.token_a.clone(), battle.vault_a),
            Side::B => (battle.token_b.clone(), battle.vault_b),
        };
        let settlement = battle
            .settlement
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Settlement missing"));
        let (liquid_pool, credit_pool) = (settlement.liquid_pool, settlement.credit_pool);

        let position = self
            .positions
            .get_mut(&(battle_id, account_id.clone()))
            .unwrap_or_else(|| env::panic_str("No position in this battle"));
        require!(position.side == winner, "Nothing to claim");
        require!(!position.claimed, "Already claimed");
        position.claimed = true;
        let stake = position.coin_amount;

        let liquid_share = math::mul_div_floor(stake, liquid_pool, winner_vault)
            .unwrap_or_else(|_| env::panic_str("Reward calculation failed"));
        let credit_share = math::mul_div_floor(stake, credit_pool, winner_vault)
            .unwrap_or_else(|_| env::panic_str("Reward calculation failed"));
        let payout = stake
            .checked_add(liquid_share)
            .unwrap_or_else(|| env::panic_str("Payout overflow"));

        self.add_liquid(&account_id, &winner_token, payout);
        if credit_share > 0 {
            self.grant_credit(&account_id, credit_share, now);
        }
        events::emit(
            "claim",
            json!({
                "battle_id": battle_id,
                "account_id": account_id,
                "token": winner_token,
                "principal": U128(stake),
                "liquid_reward": U128(liquid_share),
                "credit_granted": U128(credit_share),
            }),
        );
    }

    /// Takes back a deposit in full after a halt, or after a battle was voided at
    /// lock (empty side) or by a tie. The coin lands in the liquid balance.
    pub fn withdraw_initial_deposit(&mut self, battle_id: u64) {
        let account_id = env::predecessor_account_id();
        let battle = self
            .battles
            .get(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            matches!(
                battle.status,
                BattleStatus::EmergencyHalted | BattleStatus::Voided
            ),
            "Refunds are not available"
        );
        let (token_a, token_b) = (battle.token_a.clone(), battle.token_b.clone());

        let position = self
            .positions
            .get_mut(&(battle_id, account_id.clone()))
            .unwrap_or_else(|| env::panic_str("No position in this battle"));
        require!(!position.claimed, "Already refunded");
        position.claimed = true;
        let (side, amount) = (position.side, position.coin_amount);
        let token = match side {
            Side::A => token_a,
            Side::B => token_b,
        };
        self.add_liquid(&account_id, &token, amount);
        events::emit(
            "refund",
            json!({
                "battle_id": battle_id,
                "account_id": account_id,
                "token": token,
                "amount": U128(amount),
            }),
        );
    }

    /// Pays out part of a liquid balance. Requires 1 yoctoNEAR. Stays available
    /// while the contract is paused.
    #[payable]
    pub fn withdraw_liquid(&mut self, token: AccountId, amount: U128) -> Promise {
        near_sdk::assert_one_yocto();
        require!(amount.0 > 0, "Amount must be positive");
        let account_id = env::predecessor_account_id();
        let key = (account_id.clone(), token.clone());
        let balance = self.liquid.get(&key).copied().unwrap_or(0);
        require!(balance >= amount.0, "Insufficient liquid balance");
        self.liquid.insert(key, balance - amount.0);
        ext_ft::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(account_id.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_liquid_paid(account_id, token, amount),
            )
    }

    /// Restores the balance if the payout failed, so funds are never lost.
    #[private]
    pub fn on_liquid_paid(
        &mut self,
        account_id: AccountId,
        token: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.add_liquid(&account_id, &token, amount.0);
            events::emit(
                "withdraw_failed",
                json!({ "account_id": account_id, "token": token, "amount": amount }),
            );
        }
    }

    // ─── Agent: cross-chain signing ─────────────────────────────────────

    /// Builds a foreign-chain transaction for a battle and asks the MPC signer to
    /// sign it from the battle's own derivation path. The signed transaction is
    /// stored (and announced) by `on_signature`; the agent broadcasts it. Needs
    /// about 280 TGas attached. With `step_index` the call must fit that step.
    pub fn request_signature(
        &mut self,
        battle_id: u64,
        call: ForeignCall,
        params: ForeignTxParams,
        step_index: Option<u32>,
    ) -> Promise {
        self.assert_agent();
        let config = self
            .foreign
            .clone()
            .unwrap_or_else(|| env::panic_str("Cross-chain signing is not configured"));
        let battle = self
            .battles
            .get(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            matches!(
                battle.status,
                BattleStatus::Approved | BattleStatus::Live | BattleStatus::Settling
            ),
            "Battle is not active"
        );
        if let Some(index) = step_index {
            require!(
                battle.status == BattleStatus::Settling,
                "Steps can only be signed while settling"
            );
            let step = battle
                .settlement
                .as_ref()
                .and_then(|settlement| settlement.steps.get(index as usize))
                .unwrap_or_else(|| env::panic_str("Unknown step"));
            require!(!step.done, "Step already reported");
            match (step.kind, &call) {
                (StepKind::Dump | StepKind::Buy, ForeignCall::SwapExactIn { .. }) => {}
                (StepKind::Burn, ForeignCall::SwapExactIn { recipient, .. }) => require!(
                    mpc::parse_address(recipient) == Ok(config.burn),
                    "A burn swap must pay the burn address"
                ),
                (StepKind::Return, ForeignCall::Transfer { to, .. }) => require!(
                    mpc::parse_address(to) == Ok(config.treasury),
                    "The fee must go to the treasury address"
                ),
                _ => env::panic_str("Call does not fit this step"),
            }
        }

        let tx = mpc::build_tx(&config, &call, &params).unwrap_or_else(|error| {
            env::panic_str(match error {
                mpc::CallError::BadAddress => "Invalid foreign address",
                mpc::CallError::ZeroAmount => "Amount must be positive",
                mpc::CallError::SpenderNotRouter => "Approvals are only allowed for the router",
                mpc::CallError::RecipientNotAllowed => {
                    "Transfers are only allowed to the treasury or burn address"
                }
            })
        });
        let request_id = self
            .sign_request_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Request id overflow"));
        self.sign_request_count = request_id;
        let payload_hash = tx.signing_hash();
        self.sign_requests.insert(
            request_id,
            SignRequest {
                battle_id,
                step_index,
                path: format!("valtrum-battle-{battle_id}"),
                tx,
                status: SignStatus::Pending,
                signed_tx: None,
                attempts: 0,
            },
        );
        events::emit(
            "signature_requested",
            json!({
                "request_id": request_id,
                "battle_id": battle_id,
                "step_index": step_index,
                "payload_hash": mpc::hex_encode(&payload_hash),
            }),
        );
        self.send_to_signer(request_id)
    }

    /// Asks the signer again for a request whose attempt failed.
    pub fn retry_signature(&mut self, request_id: u64) -> Promise {
        self.assert_agent();
        let request = self
            .sign_requests
            .get_mut(&request_id)
            .unwrap_or_else(|| env::panic_str("Request not found"));
        require!(
            request.status == SignStatus::Failed,
            "Only a failed request can be retried"
        );
        require!(
            request.attempts < MAX_SIGN_ATTEMPTS,
            "Too many failed attempts"
        );
        request.status = SignStatus::Pending;
        self.send_to_signer(request_id)
    }

    /// Stores the MPC signature as a signed transaction, or marks the attempt as
    /// failed so it can be retried. Never panics.
    #[private]
    pub fn on_signature(
        &mut self,
        request_id: u64,
        #[callback_result] result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        let Some(request) = self.sign_requests.get_mut(&request_id) else {
            return;
        };
        if request.status != SignStatus::Pending {
            return;
        }
        let outcome = match result {
            Ok(response) => mpc::parse_signature(&response)
                .map_err(|_| "unusable signer response")
                .map(|signature| request.tx.signed(&signature)),
            Err(_) => Err("signer call failed"),
        };
        match outcome {
            Ok(signed) => {
                let tx_hash = mpc::hex_encode(&mpc::tx_hash(&signed));
                let event = json!({
                    "request_id": request_id,
                    "battle_id": request.battle_id,
                    "step_index": request.step_index,
                    "signed_tx": mpc::hex_encode(&signed),
                    "tx_hash": tx_hash,
                });
                request.signed_tx = Some(signed);
                request.status = SignStatus::Signed;
                events::emit("signature_ready", event);
            }
            Err(reason) => {
                request.attempts += 1;
                request.status = SignStatus::Failed;
                events::emit(
                    "signature_failed",
                    json!({
                        "request_id": request_id,
                        "battle_id": request.battle_id,
                        "reason": reason,
                        "attempts": request.attempts,
                    }),
                );
            }
        }
    }

    // ─── Treasury ───────────────────────────────────────────────────────

    /// Pays accrued USDC to the treasury. Anyone may call; the destination is fixed.
    pub fn flush_treasury(&mut self) -> Promise {
        let amount = self.treasury_accrued;
        require!(amount > 0, "Nothing to flush");
        self.treasury_accrued = 0;
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(self.treasury.clone(), U128(amount), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_treasury_flushed(U128(amount)),
            )
    }

    /// Restores the accrued amount if the transfer failed, so funds are never lost.
    #[private]
    pub fn on_treasury_flushed(
        &mut self,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            self.accrue_treasury(amount.0);
            events::emit("treasury_flush_failed", json!({ "amount": amount }));
        } else {
            events::emit("treasury_flushed", json!({ "amount": amount }));
        }
    }

    // ─── Token receiver ─────────────────────────────────────────────────

    /// NEP-141 receiver. USDC with a `propose` message creates a battle and keeps
    /// the bond; a side's own coin with a `deposit` message joins that side.
    /// Anything unexpected is returned in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let parsed = serde_json::from_str::<TransferMsg>(&msg);
        // Settlement proceeds must still arrive while paused, or a step would stall.
        if self.paused && !matches!(parsed, Ok(TransferMsg::StepProceeds { .. })) {
            return PromiseOrValue::Value(amount);
        }
        let unused = match parsed {
            Ok(TransferMsg::Propose {
                token_a,
                token_b,
                duration_secs,
            }) if token == self.usdc => {
                self.handle_propose(sender_id, amount.0, token_a, token_b, duration_secs)
            }
            Ok(TransferMsg::DepositUsdc {
                battle_id,
                side,
                total_usdc,
                min_token_out,
            }) if token == self.usdc => {
                return match self.start_usdc_deposit(
                    sender_id,
                    amount.0,
                    battle_id,
                    side,
                    total_usdc.0,
                    min_token_out.0,
                ) {
                    Some(promise) => PromiseOrValue::Promise(promise),
                    None => PromiseOrValue::Value(amount),
                };
            }
            Ok(TransferMsg::Deposit {
                battle_id,
                side,
                beneficiary,
                usdc_equiv,
                from_credit,
            }) => {
                let from_router = self.router.as_ref() == Some(&sender_id);
                let routed = match (beneficiary, usdc_equiv, from_credit) {
                    (Some(beneficiary), Some(usdc_equiv), Some(from_credit)) if from_router => {
                        Some(RoutedDeposit {
                            beneficiary,
                            usdc_equiv: usdc_equiv.0,
                            from_credit: from_credit.0,
                        })
                    }
                    _ => None,
                };
                self.handle_deposit(sender_id, token, amount.0, battle_id, side, routed)
            }
            Ok(TransferMsg::LifecycleDeposit {
                battle_id,
                community,
            }) => {
                if self.lifecycle_exclusive
                    && self
                        .lifecycle_credit(battle_id, community, &token, &sender_id, amount.0)
                        .is_ok()
                {
                    events::emit(
                        "lifecycle_deposit",
                        json!({ "battle_id": battle_id, "community": community, "account_id": sender_id, "amount": amount }),
                    );
                    0
                } else {
                    amount.0
                }
            }
            Ok(TransferMsg::FundBalance) if token == self.usdc => {
                if amount.0 > 0 {
                    self.add_liquid(&sender_id, &token, amount.0);
                    events::emit(
                        "balance_funded",
                        json!({ "account_id": sender_id, "amount": amount }),
                    );
                }
                0
            }
            Ok(TransferMsg::StepProceeds {
                battle_id,
                step_index,
            }) => self.handle_step_proceeds(sender_id, token, amount.0, battle_id, step_index),
            _ => amount.0,
        };
        PromiseOrValue::Value(U128(unused))
    }

    /// Deposits USDC from the caller's internal balance (credit first). It needs no
    /// attached deposit, so a scoped session key can call it; the arena attaches
    /// its own yoctoNEAR to the router hop. The balance is funded with a
    /// `fund_balance` transfer.
    pub fn deposit_from_balance(
        &mut self,
        battle_id: u64,
        side: Side,
        total_usdc: U128,
        min_token_out: U128,
    ) -> Promise {
        require!(!self.paused, "Deposits are paused");
        let account_id = env::predecessor_account_id();
        let usdc = self.usdc.clone();
        let balance = self
            .liquid
            .get(&(account_id.clone(), usdc.clone()))
            .copied()
            .unwrap_or(0);
        let prepared = self
            .prepare_usdc_deposit(
                &account_id,
                balance,
                battle_id,
                side,
                total_usdc.0,
                min_token_out.0,
            )
            .unwrap_or_else(|| env::panic_str("Deposit refused"));
        if prepared.from_wallet > 0 {
            self.liquid
                .insert((account_id.clone(), usdc), balance - prepared.from_wallet);
        }
        self.forward_to_router(&prepared, total_usdc.0).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SWAP_CALLBACK_GAS)
                .on_balance_deposit_done(
                    account_id,
                    U128(prepared.from_wallet),
                    total_usdc,
                    U128(prepared.from_credit),
                    U64(prepared.credit_expires_at_ns),
                ),
        )
    }

    /// If the swap did not go through, gives the credit and the balance back.
    #[private]
    pub fn on_balance_deposit_done(
        &mut self,
        account_id: AccountId,
        from_wallet: U128,
        total_usdc: U128,
        from_credit: U128,
        credit_expires_at_ns: U64,
        #[callback_result] result: Result<U128, PromiseError>,
    ) {
        if matches!(result, Ok(used) if used.0 == total_usdc.0) {
            return;
        }
        self.restore_credit(&account_id, from_credit.0, credit_expires_at_ns.0);
        let usdc = self.usdc.clone();
        self.add_liquid(&account_id, &usdc, from_wallet.0);
        events::emit(
            "deposit_usdc_refunded",
            json!({
                "account_id": account_id,
                "refunded": from_wallet,
                "credit_restored": from_credit,
            }),
        );
    }

    /// Deposits entirely from locked credit (no wallet USDC needed). Requires 1 yoctoNEAR.
    #[payable]
    pub fn deposit_with_credit(
        &mut self,
        battle_id: u64,
        side: Side,
        total_usdc: U128,
        min_token_out: U128,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(!self.paused, "Deposits are paused");
        self.start_usdc_deposit(
            env::predecessor_account_id(),
            0,
            battle_id,
            side,
            total_usdc.0,
            min_token_out.0,
        )
        .unwrap_or_else(|| env::panic_str("Deposit refused"))
    }

    /// Settles the USDC deposit once the router's hop resolves. Returns how much of
    /// the user's transfer to give back: only the excess on success, everything on
    /// failure (with the credit that was spent restored).
    #[private]
    pub fn on_swap_deposit_done(
        &mut self,
        account_id: AccountId,
        amount_sent: U128,
        total_usdc: U128,
        from_credit: U128,
        credit_expires_at_ns: U64,
        #[callback_result] result: Result<U128, PromiseError>,
    ) -> U128 {
        if matches!(result, Ok(used) if used.0 == total_usdc.0) {
            let from_wallet = total_usdc.0 - from_credit.0;
            return U128(amount_sent.0 - from_wallet);
        }
        self.restore_credit(&account_id, from_credit.0, credit_expires_at_ns.0);
        events::emit(
            "deposit_usdc_refunded",
            json!({
                "account_id": account_id,
                "refunded": amount_sent,
                "credit_restored": from_credit,
            }),
        );
        amount_sent
    }

    // ─── Views ──────────────────────────────────────────────────────────

    pub fn get_battle(&self, battle_id: u64) -> Option<BattleView> {
        self.battles
            .get(&battle_id)
            .map(|battle| BattleView::new(battle_id, battle))
    }

    pub fn get_position(&self, battle_id: u64, account_id: AccountId) -> Option<PositionView> {
        self.positions
            .get(&(battle_id, account_id))
            .map(PositionView::new)
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let now = env::block_timestamp();
        let account = self.accounts.get(&account_id).cloned().unwrap_or_default();
        let credit = account.available_credit(now);
        AccountView {
            credit_balance: U128(credit),
            credit_expires_at_ns: U64(if credit > 0 {
                account.credit_expires_at_ns
            } else {
                0
            }),
        }
    }

    /// Shows how a USDC deposit of `total_usdc` would split between credit and wallet.
    pub fn preview_funding(&self, account_id: AccountId, total_usdc: U128) -> FundingPreview {
        let credit = self.accounts.get(&account_id).map_or(0, |account| {
            account.available_credit(env::block_timestamp())
        });
        let plan = plan_funding(credit, total_usdc.0);
        FundingPreview {
            from_credit: U128(plan.from_credit),
            from_wallet: U128(plan.from_wallet),
        }
    }

    pub fn get_settlement_plan(&self, battle_id: u64) -> Vec<SettlementStepView> {
        self.battles
            .get(&battle_id)
            .and_then(|battle| battle.settlement.as_ref())
            .map(|settlement| {
                settlement
                    .steps
                    .iter()
                    .enumerate()
                    .map(|(index, step)| SettlementStepView::new(index, step))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_liquid_balance(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        U128(
            self.liquid
                .get(&(account_id, token_id))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_signature_request(&self, request_id: u64) -> Option<SignRequestView> {
        self.sign_requests.get(&request_id).map(|request| {
            let signed = request.signed_tx.as_deref();
            SignRequestView {
                battle_id: request.battle_id,
                step_index: request.step_index,
                path: request.path.clone(),
                status: request.status,
                unsigned_tx: mpc::hex_encode(&request.tx.unsigned()),
                payload_hash: mpc::hex_encode(&request.tx.signing_hash()),
                signed_tx: signed.map(mpc::hex_encode),
                tx_hash: signed.map(|bytes| mpc::hex_encode(&mpc::tx_hash(bytes))),
                attempts: request.attempts,
            }
        })
    }

    pub fn get_signature_request_count(&self) -> u64 {
        self.sign_request_count
    }

    pub fn get_foreign_config(&self) -> Option<ForeignConfigView> {
        self.foreign.as_ref().map(|config| ForeignConfigView {
            mpc_contract: config.mpc_contract.clone(),
            chain_id: U64(config.chain_id),
            router: mpc::hex_encode(&config.router),
            treasury: mpc::hex_encode(&config.treasury),
            burn: mpc::hex_encode(&config.burn),
        })
    }

    pub fn get_battle_count(&self) -> u64 {
        self.battle_count
    }

    /// Battles in ascending id order. `from_index` is a zero-based offset.
    pub fn get_battles(&self, from_index: u64, limit: u64) -> Vec<BattleView> {
        let limit = limit.min(MAX_PAGE_SIZE);
        (from_index.saturating_add(1)..=self.battle_count)
            .take(limit as usize)
            .filter_map(|id| self.get_battle(id))
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            usdc: self.usdc.clone(),
            treasury: self.treasury.clone(),
            bond: U128(self.bond),
            deposit_window_secs: U64(self.deposit_window_secs),
            agents: self.agents.iter().cloned().collect(),
            router: self.router.clone(),
            execution_dex: self.execution.as_ref().map(|e| e.dex.clone()),
            burn_account: self.execution.as_ref().map(|e| e.burn_account.clone()),
            paused: self.paused,
            treasury_accrued: U128(self.treasury_accrued),
        }
    }
}

impl Arena {
    /// Calls the MPC signer for a stored request and chains the callback.
    fn send_to_signer(&self, request_id: u64) -> Promise {
        let config = self
            .foreign
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Cross-chain signing is not configured"));
        let request = self
            .sign_requests
            .get(&request_id)
            .unwrap_or_else(|| env::panic_str("Request not found"));
        let args = json!({
            "request": {
                "path": request.path,
                "payload_v2": { "Ecdsa": mpc::hex_encode(&request.tx.signing_hash()) },
                "domain_id": 0,
            }
        })
        .to_string()
        .into_bytes();
        Promise::new(config.mpc_contract.clone())
            .function_call(
                "sign".to_string(),
                args,
                NearToken::from_yoctonear(1),
                MPC_SIGN_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGN_CALLBACK_GAS)
                    .on_signature(request_id),
            )
    }

    /// Books one finished step in order. Reporting the sale of the loser vault
    /// fixes the 55/35/5/5 split of the proceeds and appends the remaining steps;
    /// the last step settles the battle.
    fn complete_step(&mut self, battle_id: u64, step_index: u32, realized: u128) {
        let battle = self.battle_in_status(battle_id, BattleStatus::Settling);
        let settlement = battle
            .settlement
            .as_mut()
            .unwrap_or_else(|| env::panic_str("Settlement missing"));
        let index = step_index as usize;
        require!(index < settlement.steps.len(), "Unknown step");
        require!(!settlement.steps[index].done, "Step already reported");
        require!(
            settlement.steps[..index].iter().all(|step| step.done),
            "Steps must be reported in order"
        );

        settlement.steps[index].done = true;
        settlement.steps[index].realized = realized;
        let mut fee_to_treasury = 0;
        match settlement.steps[index].kind {
            StepKind::Dump => {
                let split = math::split_profit(realized)
                    .unwrap_or_else(|_| env::panic_str("Split calculation failed"));
                settlement.credit_pool = split.credit;
                for (kind, amount) in [
                    (StepKind::Buy, split.liquid),
                    (StepKind::Burn, split.burn),
                    (StepKind::Return, split.fee),
                ] {
                    settlement.steps.push(SettlementStep {
                        kind,
                        amount,
                        done: false,
                        realized: 0,
                        min_out: None,
                    });
                }
            }
            StepKind::Buy => settlement.liquid_pool = realized,
            StepKind::Burn => settlement.burned = realized,
            StepKind::Return => fee_to_treasury = realized,
        }
        let finished = settlement.steps.iter().all(|step| step.done);
        let mut bond_refund = None;
        if finished {
            battle.status = BattleStatus::Settled;
            bond_refund = Some((battle.creator.clone(), battle.bond));
        }
        events::emit(
            "execution_reported",
            json!({
                "battle_id": battle_id,
                "step_index": step_index,
                "realized": U128(realized),
            }),
        );
        if finished {
            events::emit("battle_settled", json!({ "battle_id": battle_id }));
        }
        if let Some((creator, bond)) = bond_refund {
            self.return_bond(&creator, bond);
        }
        if fee_to_treasury > 0 {
            self.accrue_treasury(fee_to_treasury);
        }
    }

    /// Proceeds of a dispatched step, paid by the execution DEX. Returns the
    /// amount not accepted.
    fn handle_step_proceeds(
        &mut self,
        sender_id: AccountId,
        token: AccountId,
        amount: u128,
        battle_id: u64,
        step_index: u32,
    ) -> u128 {
        let Some(execution) = self.execution.clone() else {
            return amount;
        };
        if sender_id != execution.dex {
            return amount;
        }
        let Some(battle) = self.battles.get(&battle_id) else {
            return amount;
        };
        let (Some(winner), Some(settlement)) = (battle.winner, battle.settlement.as_ref()) else {
            return amount;
        };
        let index = step_index as usize;
        let Some(step) = settlement.steps.get(index) else {
            return amount;
        };
        let Some(min_out) = step.min_out else {
            return amount;
        };
        let in_order = settlement.steps[..index].iter().all(|earlier| earlier.done);
        let winner_token = match winner {
            Side::A => &battle.token_a,
            Side::B => &battle.token_b,
        };
        let expected = match step.kind {
            StepKind::Dump => &self.usdc,
            StepKind::Buy | StepKind::Burn => winner_token,
            StepKind::Return => return amount,
        };
        let kind = step.kind;
        let acceptable = battle.status == BattleStatus::Settling
            && !step.done
            && in_order
            && &token == expected
            && amount >= min_out;
        if !acceptable {
            return amount;
        }

        self.complete_step(battle_id, step_index, amount);
        if kind == StepKind::Burn {
            let _ = ext_ft::ext(token)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(FT_TRANSFER_GAS)
                .ft_transfer(execution.burn_account, U128(amount), None)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_burn_sent(battle_id, U128(amount)),
                );
        }
        0
    }

    fn add_liquid(&mut self, account_id: &AccountId, token: &AccountId, amount: u128) {
        let key = (account_id.clone(), token.clone());
        let balance = self.liquid.get(&key).copied().unwrap_or(0);
        let balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Balance overflow"));
        self.liquid.insert(key, balance);
    }

    /// The creation bond goes back to the creator once the battle ran or ended
    /// through no fault of theirs.
    fn return_bond(&mut self, creator: &AccountId, bond: u128) {
        let usdc = self.usdc.clone();
        self.add_liquid(creator, &usdc, bond);
    }

    /// Puts back credit that was spent on a deposit that did not complete. The
    /// expiry never moves earlier.
    fn restore_credit(&mut self, account_id: &AccountId, amount: u128, expires_at_ns: u64) {
        if amount == 0 {
            return;
        }
        let mut account = self.accounts.get(account_id).cloned().unwrap_or_default();
        account.restore_credit(amount, expires_at_ns);
        self.accounts.insert(account_id.clone(), account);
    }

    /// Adds locked credit and restarts the 7-day timer for the whole balance.
    fn grant_credit(&mut self, account_id: &AccountId, amount: u128, now: u64) {
        let mut account = self.accounts.get(account_id).cloned().unwrap_or_default();
        account.sweep_expired(now);
        account.credit_balance = account
            .credit_balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Credit overflow"));
        account.credit_expires_at_ns = now + types::CREDIT_TTL_NS;
        self.accounts.insert(account_id.clone(), account);
    }

    /// Validates a USDC deposit and spends its credit part. `wallet_available` is
    /// what the caller can cover on the wallet side. Returns `None` (nothing
    /// changed) when the deposit is not allowed.
    fn prepare_usdc_deposit(
        &mut self,
        account_id: &AccountId,
        wallet_available: u128,
        battle_id: u64,
        side: Side,
        total_usdc: u128,
        min_token_out: u128,
    ) -> Option<PreparedDeposit> {
        let router = self.router.clone()?;
        let now = env::block_timestamp();
        let battle = self.battles.get(&battle_id)?;
        if total_usdc == 0
            || battle.status != BattleStatus::Approved
            || now >= battle.deposit_deadline_ns
        {
            return None;
        }
        let token_out = match side {
            Side::A => battle.token_a.clone(),
            Side::B => battle.token_b.clone(),
        };
        if self
            .positions
            .get(&(battle_id, account_id.clone()))
            .is_some_and(|position| position.side != side)
        {
            return None;
        }

        let mut account = self.accounts.get(account_id).cloned().unwrap_or_default();
        let plan = plan_funding(account.available_credit(now), total_usdc);
        if wallet_available < plan.from_wallet {
            return None;
        }
        let credit_expires_at_ns = account.credit_expires_at_ns;
        if plan.from_credit > 0 {
            account
                .consume_credit(now, plan.from_credit)
                .unwrap_or_else(|_| env::panic_str("Credit unavailable"));
            self.accounts.insert(account_id.clone(), account);
        }

        let msg = json!({
            "action": "swap_deposit",
            "battle_id": battle_id,
            "side": side,
            "beneficiary": account_id,
            "token_out": token_out,
            "min_token_out": U128(min_token_out),
            "from_credit": U128(plan.from_credit),
        })
        .to_string();
        Some(PreparedDeposit {
            router,
            msg,
            from_credit: plan.from_credit,
            from_wallet: plan.from_wallet,
            credit_expires_at_ns,
        })
    }

    /// Sends the full USDC amount of a prepared deposit to the router.
    fn forward_to_router(&self, prepared: &PreparedDeposit, total_usdc: u128) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(ROUTER_HOP_GAS)
            .with_unused_gas_weight(1)
            .ft_transfer_call(
                prepared.router.clone(),
                U128(total_usdc),
                None,
                prepared.msg.clone(),
            )
    }

    /// Begins a USDC deposit paid by a token transfer: credit first, the wallet
    /// part from `wallet_amount`, the total forwarded to the router.
    fn start_usdc_deposit(
        &mut self,
        account_id: AccountId,
        wallet_amount: u128,
        battle_id: u64,
        side: Side,
        total_usdc: u128,
        min_token_out: u128,
    ) -> Option<Promise> {
        let prepared = self.prepare_usdc_deposit(
            &account_id,
            wallet_amount,
            battle_id,
            side,
            total_usdc,
            min_token_out,
        )?;
        Some(
            self.forward_to_router(&prepared, total_usdc).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SWAP_CALLBACK_GAS)
                    .on_swap_deposit_done(
                        account_id,
                        U128(wallet_amount),
                        U128(total_usdc),
                        U128(prepared.from_credit),
                        U64(prepared.credit_expires_at_ns),
                    ),
            ),
        )
    }

    /// Deposit of a side's own coin, either sent directly or delivered by the
    /// router after a swap. Returns the amount not accepted.
    ///
    /// Direct deposits need the window to be open. Routed deposits are accepted
    /// until the agent locks the battle, because the user's USDC was already
    /// swapped and cannot be unwound.
    fn handle_deposit(
        &mut self,
        sender_id: AccountId,
        token: AccountId,
        amount: u128,
        battle_id: u64,
        side: Side,
        routed: Option<RoutedDeposit>,
    ) -> u128 {
        let now = env::block_timestamp();
        let Some(battle) = self.battles.get(&battle_id) else {
            return amount;
        };
        let side_token = match side {
            Side::A => &battle.token_a,
            Side::B => &battle.token_b,
        };
        let open = battle.status == BattleStatus::Approved
            && (routed.is_some() || now < battle.deposit_deadline_ns);
        if amount == 0 || !open || &token != side_token {
            return amount;
        }
        let (account_id, usdc_equiv, from_credit) = match routed {
            Some(routed) => (routed.beneficiary, routed.usdc_equiv, routed.from_credit),
            None => (sender_id, 0, 0),
        };
        let key = (battle_id, account_id.clone());
        if self
            .positions
            .get(&key)
            .is_some_and(|position| position.side != side)
        {
            return amount;
        }

        let battle = self
            .battles
            .get_mut(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        let vault = match side {
            Side::A => &mut battle.vault_a,
            Side::B => &mut battle.vault_b,
        };
        *vault = vault
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Vault overflow"));

        let total = if let Some(position) = self.positions.get_mut(&key) {
            position.coin_amount = position
                .coin_amount
                .checked_add(amount)
                .unwrap_or_else(|| env::panic_str("Position overflow"));
            position.usdc_equiv = position
                .usdc_equiv
                .checked_add(usdc_equiv)
                .unwrap_or_else(|| env::panic_str("Position overflow"));
            position.from_credit = position
                .from_credit
                .checked_add(from_credit)
                .unwrap_or_else(|| env::panic_str("Position overflow"));
            position.coin_amount
        } else {
            self.positions.insert(
                key,
                UserPosition {
                    side,
                    coin_amount: amount,
                    usdc_equiv,
                    from_credit,
                    claimed: false,
                },
            );
            amount
        };
        events::emit(
            "deposit",
            json!({
                "battle_id": battle_id,
                "account_id": account_id,
                "side": side,
                "coin_amount": U128(amount),
                "position_total": U128(total),
                "usdc_equiv": U128(usdc_equiv),
                "from_credit": U128(from_credit),
            }),
        );
        0
    }

    fn accrue_treasury(&mut self, amount: u128) {
        self.treasury_accrued = self
            .treasury_accrued
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Treasury overflow"));
    }

    /// Loads a battle and requires it to be in `expected`.
    fn battle_in_status(&mut self, battle_id: u64, expected: BattleStatus) -> &mut Battle {
        let battle = self
            .battles
            .get_mut(&battle_id)
            .unwrap_or_else(|| env::panic_str("Battle not found"));
        require!(
            battle.status == expected,
            "Battle is not in the required status"
        );
        battle
    }

    fn handle_propose(
        &mut self,
        creator: AccountId,
        amount: u128,
        token_a: AccountId,
        token_b: AccountId,
        duration_secs: u64,
    ) -> u128 {
        let invalid_tokens = token_a == token_b || token_a == self.usdc || token_b == self.usdc;
        let invalid_duration = duration_secs == 0 || duration_secs > MAX_DURATION_SECS;
        if self.lifecycle_exclusive || invalid_tokens || invalid_duration || amount < self.bond {
            return amount;
        }

        let battle_id = self
            .battle_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Battle id overflow"));
        self.battle_count = battle_id;
        self.battles.insert(
            battle_id,
            Battle {
                creator: creator.clone(),
                token_a: token_a.clone(),
                token_b: token_b.clone(),
                bond: self.bond,
                duration_ns: duration_secs * NS_PER_SECOND,
                deposit_deadline_ns: 0,
                status: BattleStatus::Proposed,
                vault_a: 0,
                vault_b: 0,
                start_time_ns: 0,
                end_time_ns: 0,
                initial_price_a: None,
                initial_price_b: None,
                final_price_a: None,
                final_price_b: None,
                winner: None,
                settlement: None,
            },
        );
        events::emit(
            "battle_proposed",
            json!({
                "battle_id": battle_id,
                "creator": creator,
                "token_a": token_a,
                "token_b": token_b,
                "bond": U128(self.bond),
            }),
        );
        amount - self.bond
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Only the owner can call this method"
        );
    }

    fn assert_agent(&self) {
        require!(
            self.agents.contains(&env::predecessor_account_id()),
            "Only a whitelisted agent can call this method"
        );
    }
}

// Only a dedicated sandbox build includes these self-call-only fixtures. They
// are not an audit, custody, scoring, or governance integration.
#[cfg(feature = "sandbox-fixtures")]
#[near]
impl Arena {
    #[private]
    pub fn fixture_approve_lifecycle(&mut self, battle_id: u64, community: u32) {
        let view = self
            .get_lifecycle_battle(battle_id)
            .unwrap_or_else(|| env::panic_str("Unknown battle"));
        let item = view
            .communities
            .get(community as usize)
            .unwrap_or_else(|| env::panic_str("Unknown community"));
        let asset = lifecycle::AssetIdentity {
            chain_id: item.chain_id.0,
            token_address: item.token_address.clone(),
            representation: item.representation.clone(),
            custody_domain: item.custody_domain.clone(),
        };
        self.lifecycle_set_audit(
            battle_id,
            community as usize,
            Some(lifecycle::AuditApproval {
                asset: asset.clone(),
                policy_hash: "p".repeat(256),
                evidence_hash: "a".repeat(256),
            }),
        )
        .unwrap_or_else(|_| env::panic_str("Fixture audit rejected"));
        self.lifecycle_set_backing(
            battle_id,
            community as usize,
            Some(lifecycle::BackingApproval {
                asset,
                evidence_hash: "b".repeat(256),
            }),
        )
        .unwrap_or_else(|_| env::panic_str("Fixture backing rejected"));
    }

    /// Synthetic accounting credit for gas tests only; no token moves.
    #[private]
    pub fn fixture_credit_lifecycle(
        &mut self,
        battle_id: u64,
        community: u32,
        account: AccountId,
        token: AccountId,
        amount: U128,
    ) {
        self.lifecycle_credit(battle_id, community, &token, &account, amount.0)
            .unwrap_or_else(|_| env::panic_str("Fixture credit rejected"));
    }

    #[private]
    pub fn fixture_hold_lifecycle_principal(&mut self, battle_id: u64, winner: u32) {
        self.lifecycle_hold_principal(battle_id, winner)
            .unwrap_or_else(|_| env::panic_str("Fixture winner rejected"));
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    pub fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    pub fn set_context(predecessor: &str, timestamp_ns: u64) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(acc(predecessor))
            .block_timestamp(timestamp_ns)
            .build();
        testing_env!(ctx);
    }

    pub fn new_arena() -> Arena {
        set_context("owner", 0);
        Arena::new(
            acc("owner"),
            acc("usdc"),
            acc("treasury"),
            U128(5_000_000),
            U64(3_600),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::*;
    use super::*;

    #[test]
    fn init_stores_config() {
        let arena = new_arena();
        let config = arena.get_config();
        assert_eq!(config.owner, acc("owner"));
        assert_eq!(config.usdc, acc("usdc"));
        assert_eq!(config.treasury, acc("treasury"));
        assert_eq!(config.bond, U128(5_000_000));
        assert_eq!(config.deposit_window_secs, U64(3_600));
        assert!(config.agents.is_empty());
        assert_eq!(config.router, None);
        assert!(!config.paused);
        assert_eq!(config.treasury_accrued, U128(0));
    }

    #[test]
    #[should_panic(expected = "Deposit window must be between 1 second and 30 days")]
    fn init_rejects_zero_window() {
        set_context("owner", 0);
        Arena::new(acc("owner"), acc("usdc"), acc("treasury"), U128(1), U64(0));
    }

    #[test]
    #[should_panic(expected = "Deposit window must be between 1 second and 30 days")]
    fn init_rejects_a_window_over_the_cap() {
        set_context("owner", 0);
        Arena::new(
            acc("owner"),
            acc("usdc"),
            acc("treasury"),
            U128(1),
            U64(MAX_DURATION_SECS + 1),
        );
    }

    #[test]
    #[should_panic(expected = "Deposit window must be between 1 second and 30 days")]
    fn the_owner_cannot_set_a_window_over_the_cap() {
        let mut arena = new_arena();
        arena.set_deposit_window_secs(U64(MAX_DURATION_SECS + 1));
    }

    #[test]
    #[should_panic(expected = "Deposit window must be between 1 second and 30 days")]
    fn the_owner_cannot_set_a_zero_window() {
        let mut arena = new_arena();
        arena.set_deposit_window_secs(U64(0));
    }

    #[test]
    fn the_window_cap_itself_is_allowed() {
        let mut arena = new_arena();
        arena.set_deposit_window_secs(U64(MAX_DURATION_SECS));
        assert_eq!(
            arena.get_config().deposit_window_secs,
            U64(MAX_DURATION_SECS)
        );
    }

    #[test]
    fn owner_rotates_agents() {
        let mut arena = new_arena();
        arena.add_agent(acc("agent1"));
        assert_eq!(arena.get_config().agents, vec![acc("agent1")]);

        arena.remove_agent(acc("agent1"));
        arena.add_agent(acc("agent2"));
        assert_eq!(arena.get_config().agents, vec![acc("agent2")]);

        set_context("agent2", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn removed_agent_loses_access() {
        let mut arena = new_arena();
        arena.add_agent(acc("agent1"));
        arena.remove_agent(acc("agent1"));
        set_context("agent1", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn stranger_is_not_an_agent() {
        let arena = new_arena();
        set_context("stranger", 0);
        arena.assert_agent();
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_add_agent() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.add_agent(acc("stranger"));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_change_treasury() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_treasury(acc("stranger"));
    }

    #[test]
    fn owner_updates_config() {
        let mut arena = new_arena();
        arena.set_treasury(acc("treasury2"));
        arena.set_bond(U128(9));
        arena.set_deposit_window_secs(U64(60));
        arena.set_paused(true);
        let config = arena.get_config();
        assert_eq!(config.treasury, acc("treasury2"));
        assert_eq!(config.bond, U128(9));
        assert_eq!(config.deposit_window_secs, U64(60));
        assert!(config.paused);
    }

    fn propose_msg(token_a: &str, token_b: &str, duration_secs: u64) -> String {
        json!({
            "action": "propose",
            "token_a": acc(token_a),
            "token_b": acc(token_b),
            "duration_secs": duration_secs,
        })
        .to_string()
    }

    fn returned(result: PromiseOrValue<U128>) -> u128 {
        match result {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("expected an immediate value"),
        }
    }

    fn propose(arena: &mut Arena, sender: &str, amount: u128, msg: String) -> u128 {
        set_context("usdc", 0);
        returned(arena.ft_on_transfer(acc(sender), U128(amount), msg))
    }

    #[test]
    fn lifecycle_activation_rejects_future_legacy_proposals() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let mut arena = new_arena();
        let context = VMContextBuilder::new()
            .predecessor_account_id(acc("owner"))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build();
        testing_env!(context);
        arena.activate_lifecycle();
        let amount = 5_000_000;
        assert_eq!(
            propose(
                &mut arena,
                "creator",
                amount,
                propose_msg("tokena", "tokenb", 30)
            ),
            amount
        );
        assert_eq!(arena.battle_count, 0);
    }

    #[test]
    #[should_panic(expected = "Legacy battles prevent lifecycle activation")]
    fn lifecycle_cannot_activate_with_legacy_battles() {
        use near_sdk::test_utils::VMContextBuilder;
        use near_sdk::testing_env;
        let mut arena = new_arena();
        assert_eq!(
            propose(
                &mut arena,
                "creator",
                5_000_000,
                propose_msg("tokena", "tokenb", 30)
            ),
            0
        );
        let context = VMContextBuilder::new()
            .predecessor_account_id(acc("owner"))
            .attached_deposit(NearToken::from_yoctonear(1))
            .build();
        testing_env!(context);
        arena.activate_lifecycle();
    }

    #[test]
    fn valid_proposal_creates_battle_and_keeps_bond() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 86_400),
        );
        assert_eq!(unused, 0);
        assert_eq!(arena.get_battle_count(), 1);

        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.creator, acc("alice"));
        assert_eq!(battle.token_a, acc("pepe"));
        assert_eq!(battle.token_b, acc("shib"));
        assert_eq!(battle.status, BattleStatus::Proposed);
        assert_eq!(battle.bond, U128(5_000_000));
        assert_eq!(battle.duration_ns, U64(86_400 * NS_PER_SECOND));
        assert_eq!(battle.deposit_deadline_ns, U64(0));
        assert!(battle.initial_price_a.is_none());
    }

    #[test]
    fn proposal_emits_event() {
        let mut arena = new_arena();
        propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 60),
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_proposed\"")));
    }

    #[test]
    fn excess_bond_is_returned() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            8_000_000,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 3_000_000);
        assert_eq!(arena.get_battle_count(), 1);
    }

    #[test]
    fn insufficient_bond_is_returned_in_full() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            4_999_999,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 4_999_999);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn identical_tokens_are_returned_in_full() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "pepe", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn usdc_cannot_be_a_battle_token() {
        let mut arena = new_arena();
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("usdc", "shib", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn invalid_duration_is_returned_in_full() {
        let mut arena = new_arena();
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", 0)
            ),
            5_000_000
        );
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", MAX_DURATION_SECS + 1)
            ),
            5_000_000
        );
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn malformed_message_is_returned_in_full() {
        let mut arena = new_arena();
        assert_eq!(propose(&mut arena, "alice", 7, "not json".to_string()), 7);
        assert_eq!(
            propose(
                &mut arena,
                "alice",
                7,
                json!({"action": "unknown"}).to_string()
            ),
            7
        );
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn unexpected_token_is_returned_in_full() {
        let mut arena = new_arena();
        set_context("scam", 0);
        let result = arena.ft_on_transfer(
            acc("alice"),
            U128(5_000_000),
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(returned(result), 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn paused_contract_returns_proposals() {
        let mut arena = new_arena();
        arena.set_paused(true);
        let unused = propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 60),
        );
        assert_eq!(unused, 5_000_000);
        assert_eq!(arena.get_battle_count(), 0);
    }

    #[test]
    fn battles_are_paginated_in_ascending_order() {
        let mut arena = new_arena();
        for _ in 0..5 {
            propose(
                &mut arena,
                "alice",
                5_000_000,
                propose_msg("pepe", "shib", 60),
            );
        }
        let ids = |from, limit| -> Vec<u64> {
            arena
                .get_battles(from, limit)
                .iter()
                .map(|b| b.id)
                .collect()
        };
        assert_eq!(ids(0, 100), vec![1, 2, 3, 4, 5]);
        assert_eq!(ids(1, 2), vec![2, 3]);
        assert_eq!(ids(4, 10), vec![5]);
        assert!(ids(5, 10).is_empty());
        assert!(arena.get_battle(6).is_none());
    }

    fn arena_with_proposal() -> Arena {
        let mut arena = new_arena();
        arena.add_agent(acc("agent"));
        propose(
            &mut arena,
            "alice",
            5_000_000,
            propose_msg("pepe", "shib", 86_400),
        );
        arena
    }

    #[test]
    fn agent_approval_opens_deposit_window() {
        let mut arena = arena_with_proposal();
        set_context("agent", 1_000);
        arena.approve_battle(1);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Approved);
        assert_eq!(
            battle.deposit_deadline_ns,
            U64(1_000 + 3_600 * NS_PER_SECOND)
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_approved\"")));
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_approve() {
        let mut arena = arena_with_proposal();
        set_context("alice", 0);
        arena.approve_battle(1);
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_approve_twice() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(1);
        arena.approve_battle(1);
    }

    #[test]
    #[should_panic(expected = "Battle not found")]
    fn cannot_approve_unknown_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(99);
    }

    #[test]
    fn void_seizes_bond_for_the_treasury() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "low liquidity".to_string());
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Voided);
        assert_eq!(arena.get_config().treasury_accrued, U128(5_000_000));
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("low liquidity")));
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_void() {
        let mut arena = arena_with_proposal();
        set_context("alice", 0);
        arena.void_battle(1, "x".to_string());
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_void_an_approved_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(1);
        arena.void_battle(1, "late".to_string());
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_approve_a_voided_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());
        arena.approve_battle(1);
    }

    #[test]
    fn agents_keep_working_while_paused() {
        let mut arena = arena_with_proposal();
        set_context("owner", 0);
        arena.set_paused(true);
        set_context("agent", 0);
        arena.approve_battle(1);
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Approved);
    }

    #[test]
    fn flush_clears_accrual_and_failed_transfer_restores_it() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());

        set_context("anyone", 0);
        let _ = arena.flush_treasury();
        assert_eq!(arena.get_config().treasury_accrued, U128(0));

        arena.on_treasury_flushed(U128(5_000_000), Err(PromiseError::Failed));
        assert_eq!(arena.get_config().treasury_accrued, U128(5_000_000));
    }

    #[test]
    fn successful_flush_leaves_accrual_at_zero() {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.void_battle(1, "honeypot".to_string());
        set_context("anyone", 0);
        let _ = arena.flush_treasury();
        arena.on_treasury_flushed(U128(5_000_000), Ok(()));
        assert_eq!(arena.get_config().treasury_accrued, U128(0));
    }

    #[test]
    #[should_panic(expected = "Nothing to flush")]
    fn flush_requires_accrued_funds() {
        let mut arena = new_arena();
        let _ = arena.flush_treasury();
    }

    /// Puts coins in each vault, standing in for deposits (added in a later change).
    fn fund(arena: &mut Arena, battle_id: u64, vault_a: u128, vault_b: u128) {
        let battle = arena.battles.get_mut(&battle_id).unwrap();
        battle.vault_a = vault_a;
        battle.vault_b = vault_b;
    }

    fn approved_arena() -> Arena {
        let mut arena = arena_with_proposal();
        set_context("agent", 0);
        arena.approve_battle(1);
        arena
    }

    const WINDOW_NS: u64 = 3_600 * NS_PER_SECOND;

    #[test]
    fn lock_records_prices_and_starts_the_timer() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 60);
        set_context("agent", WINDOW_NS + 5);
        arena.set_initial_prices(1, U128(100), U128(250));

        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Live);
        assert_eq!(battle.initial_price_a, Some(U128(100)));
        assert_eq!(battle.initial_price_b, Some(U128(250)));
        assert_eq!(battle.start_time_ns, U64(WINDOW_NS + 5));
        assert_eq!(
            battle.end_time_ns,
            U64(WINDOW_NS + 5 + 86_400 * NS_PER_SECOND)
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_locked\"")));
    }

    #[test]
    fn lock_is_allowed_exactly_at_the_deadline() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 1, 1);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Live);
    }

    #[test]
    #[should_panic(expected = "Deposit window is still open")]
    fn lock_before_deadline_fails() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 60);
        set_context("agent", WINDOW_NS - 1);
        arena.set_initial_prices(1, U128(100), U128(250));
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn initial_prices_cannot_be_set_twice() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 60);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(100), U128(250));
        arena.set_initial_prices(1, U128(1), U128(1));
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_lock_a_proposed_battle() {
        let mut arena = arena_with_proposal();
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
    }

    #[test]
    #[should_panic(expected = "Prices must be non-zero")]
    fn zero_prices_are_rejected() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 60);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(0), U128(1));
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_lock() {
        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 60);
        set_context("alice", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
    }

    #[test]
    fn empty_side_voids_the_battle_at_lock() {
        for (a, b) in [(100, 0), (0, 100), (0, 0)] {
            let mut arena = approved_arena();
            fund(&mut arena, 1, a, b);
            set_context("agent", WINDOW_NS);
            arena.set_initial_prices(1, U128(1), U128(1));

            let battle = arena.get_battle(1).unwrap();
            assert_eq!(battle.status, BattleStatus::Voided);
            assert!(battle.initial_price_a.is_none());
            assert_eq!(battle.start_time_ns, U64(0));
            assert_eq!(arena.get_config().treasury_accrued, U128(5_000_000));
        }
    }

    fn grant_test_credit(arena: &mut Arena, name: &str, amount: u128, expires_at_ns: u64) {
        arena.accounts.insert(
            acc(name),
            Account {
                credit_balance: amount,
                credit_expires_at_ns: expires_at_ns,
            },
        );
    }

    #[test]
    fn unknown_account_has_empty_balances() {
        let arena = new_arena();
        let view = arena.get_account(acc("nobody"));
        assert_eq!(view.credit_balance, U128(0));
        assert_eq!(view.credit_expires_at_ns, U64(0));
    }

    #[test]
    fn account_view_shows_only_valid_credit() {
        let mut arena = new_arena();
        let expiry = 7 * 24 * 3_600 * NS_PER_SECOND;
        grant_test_credit(&mut arena, "alice", 35, expiry);

        set_context("owner", expiry - 1);
        let view = arena.get_account(acc("alice"));
        assert_eq!(view.credit_balance, U128(35));
        assert_eq!(view.credit_expires_at_ns, U64(expiry));

        set_context("owner", expiry);
        let view = arena.get_account(acc("alice"));
        assert_eq!(view.credit_balance, U128(0));
        assert_eq!(view.credit_expires_at_ns, U64(0));
    }

    #[test]
    fn preview_splits_the_prd_example() {
        let mut arena = new_arena();
        grant_test_credit(&mut arena, "alice", 35, 1_000);
        set_context("owner", 10);
        let preview = arena.preview_funding(acc("alice"), U128(50));
        assert_eq!(preview.from_credit, U128(35));
        assert_eq!(preview.from_wallet, U128(15));
    }

    #[test]
    fn preview_ignores_expired_credit() {
        let mut arena = new_arena();
        grant_test_credit(&mut arena, "alice", 35, 1_000);
        set_context("owner", 1_000);
        let preview = arena.preview_funding(acc("alice"), U128(50));
        assert_eq!(preview.from_credit, U128(0));
        assert_eq!(preview.from_wallet, U128(50));
    }

    #[test]
    fn preview_for_account_without_credit_is_all_wallet() {
        let arena = new_arena();
        let preview = arena.preview_funding(acc("bob"), U128(50));
        assert_eq!(preview.from_credit, U128(0));
        assert_eq!(preview.from_wallet, U128(50));
    }

    #[test]
    fn missing_position_is_none() {
        let arena = new_arena();
        assert!(arena.get_position(1, acc("alice")).is_none());
    }

    fn deposit_msg(battle_id: u64, side: Side) -> String {
        json!({ "action": "deposit", "battle_id": battle_id, "side": side }).to_string()
    }

    /// Sends `amount` of `token` to the arena as a deposit message. Returns the unused amount.
    fn deposit_coin(
        arena: &mut Arena,
        sender: &str,
        token: &str,
        amount: u128,
        side: Side,
        timestamp_ns: u64,
    ) -> u128 {
        set_context(token, timestamp_ns);
        returned(arena.ft_on_transfer(acc(sender), U128(amount), deposit_msg(1, side)))
    }

    #[test]
    fn deposit_joins_a_side_and_fills_its_vault() {
        let mut arena = approved_arena();
        let unused = deposit_coin(&mut arena, "bob", "pepe", 400, Side::A, 10);
        assert_eq!(unused, 0);

        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.vault_a, U128(400));
        assert_eq!(battle.vault_b, U128(0));
        let position = arena.get_position(1, acc("bob")).unwrap();
        assert_eq!(position.side, Side::A);
        assert_eq!(position.coin_amount, U128(400));
        assert!(!position.claimed);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("\"event\":\"deposit\"")));
    }

    #[test]
    fn deposit_on_side_b_uses_token_b() {
        let mut arena = approved_arena();
        assert_eq!(
            deposit_coin(&mut arena, "carol", "shib", 250, Side::B, 10),
            0
        );
        assert_eq!(arena.get_battle(1).unwrap().vault_b, U128(250));
    }

    #[test]
    fn topping_up_adds_to_the_same_position() {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 400, Side::A, 10);
        deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 20);
        assert_eq!(
            arena.get_position(1, acc("bob")).unwrap().coin_amount,
            U128(500)
        );
        assert_eq!(arena.get_battle(1).unwrap().vault_a, U128(500));
    }

    #[test]
    fn opposite_side_is_returned_in_full() {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 400, Side::A, 10);
        let unused = deposit_coin(&mut arena, "bob", "shib", 300, Side::B, 20);
        assert_eq!(unused, 300);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.vault_a, U128(400));
        assert_eq!(battle.vault_b, U128(0));
        assert_eq!(arena.get_position(1, acc("bob")).unwrap().side, Side::A);
    }

    #[test]
    fn wrong_coin_for_the_side_is_returned() {
        let mut arena = approved_arena();
        assert_eq!(
            deposit_coin(&mut arena, "bob", "shib", 300, Side::A, 10),
            300
        );
        assert_eq!(
            deposit_coin(&mut arena, "bob", "usdc", 300, Side::A, 10),
            300
        );
        assert!(arena.get_position(1, acc("bob")).is_none());
    }

    #[test]
    fn deposit_window_is_exclusive_of_the_deadline() {
        let mut arena = approved_arena();
        assert_eq!(
            deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, WINDOW_NS - 1),
            0
        );
        assert_eq!(
            deposit_coin(&mut arena, "carol", "pepe", 100, Side::A, WINDOW_NS),
            100
        );
        assert_eq!(arena.get_battle(1).unwrap().vault_a, U128(100));
    }

    #[test]
    fn deposits_are_rejected_unless_the_battle_is_approved() {
        let mut arena = arena_with_proposal();
        assert_eq!(
            deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 1),
            100
        );

        let mut arena = approved_arena();
        fund(&mut arena, 1, 100, 100);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
        assert_eq!(
            deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, WINDOW_NS + 1),
            100
        );

        let mut arena = approved_arena();
        set_context("pepe", 1);
        let result = arena.ft_on_transfer(acc("bob"), U128(5), deposit_msg(99, Side::A));
        assert_eq!(returned(result), 5);
    }

    #[test]
    fn zero_amount_deposit_is_returned() {
        let mut arena = approved_arena();
        assert_eq!(deposit_coin(&mut arena, "bob", "pepe", 0, Side::A, 10), 0);
        assert!(arena.get_position(1, acc("bob")).is_none());
    }

    #[test]
    fn paused_contract_returns_deposits() {
        let mut arena = approved_arena();
        set_context("owner", 0);
        arena.set_paused(true);
        assert_eq!(
            deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 10),
            100
        );
        assert_eq!(arena.get_battle(1).unwrap().vault_a, U128(0));
    }

    #[test]
    fn direct_deposits_do_not_touch_credit() {
        let mut arena = approved_arena();
        grant_test_credit(&mut arena, "bob", 35, WINDOW_NS * 100);
        deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 10);
        set_context("owner", 10);
        assert_eq!(arena.get_account(acc("bob")).credit_balance, U128(35));
        assert_eq!(
            arena.get_position(1, acc("bob")).unwrap().from_credit,
            U128(0)
        );
    }

    #[test]
    fn vaults_always_equal_the_sum_of_positions() {
        let mut arena = approved_arena();
        let deposits = [
            ("a1", "pepe", Side::A, 100u128),
            ("a2", "pepe", Side::A, 250),
            ("b1", "shib", Side::B, 75),
            ("a1", "pepe", Side::A, 50),
            ("b2", "shib", Side::B, 1_000),
            ("a2", "shib", Side::B, 9), // rejected: opposite side
        ];
        for (who, token, side, amount) in deposits {
            deposit_coin(&mut arena, who, token, amount, side, 10);
        }
        let sum = |side: Side| -> u128 {
            ["a1", "a2", "b1", "b2"]
                .iter()
                .filter_map(|who| arena.get_position(1, acc(who)))
                .filter(|p| p.side == side)
                .map(|p| p.coin_amount.0)
                .sum()
        };
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.vault_a.0, sum(Side::A));
        assert_eq!(battle.vault_b.0, sum(Side::B));
        assert_eq!(battle.vault_a, U128(400));
        assert_eq!(battle.vault_b, U128(1_075));
    }

    #[test]
    fn owner_sets_and_clears_the_router() {
        let mut arena = new_arena();
        arena.set_router(Some(acc("router")));
        assert_eq!(arena.get_config().router, Some(acc("router")));
        arena.set_router(None);
        assert_eq!(arena.get_config().router, None);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_set_the_router() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_router(Some(acc("stranger")));
    }

    fn routed_msg(beneficiary: &str, usdc_equiv: u128, from_credit: u128, side: Side) -> String {
        json!({
            "action": "deposit",
            "battle_id": 1,
            "side": side,
            "beneficiary": acc(beneficiary),
            "usdc_equiv": U128(usdc_equiv),
            "from_credit": U128(from_credit),
        })
        .to_string()
    }

    fn router_deliver(
        arena: &mut Arena,
        token: &str,
        amount: u128,
        msg: String,
        timestamp_ns: u64,
    ) -> u128 {
        set_context(token, timestamp_ns);
        returned(arena.ft_on_transfer(acc("router"), U128(amount), msg))
    }

    fn arena_with_router() -> Arena {
        let mut arena = approved_arena();
        set_context("owner", 0);
        arena.set_router(Some(acc("router")));
        arena
    }

    #[test]
    fn router_deposit_credits_the_beneficiary() {
        let mut arena = arena_with_router();
        let msg = routed_msg("alice", 50_000_000, 35_000_000, Side::A);
        assert_eq!(router_deliver(&mut arena, "pepe", 900, msg, 10), 0);

        let position = arena.get_position(1, acc("alice")).unwrap();
        assert_eq!(position.side, Side::A);
        assert_eq!(position.coin_amount, U128(900));
        assert_eq!(position.usdc_equiv, U128(50_000_000));
        assert_eq!(position.from_credit, U128(35_000_000));
        assert!(arena.get_position(1, acc("router")).is_none());
        assert_eq!(arena.get_battle(1).unwrap().vault_a, U128(900));
    }

    #[test]
    fn router_deposits_are_accepted_after_the_deadline_until_lock() {
        let mut arena = arena_with_router();
        let msg = routed_msg("alice", 10, 0, Side::A);
        assert_eq!(
            router_deliver(&mut arena, "pepe", 5, msg, WINDOW_NS + 10),
            0
        );
        assert_eq!(arena.get_battle(1).unwrap().vault_a, U128(5));
    }

    #[test]
    fn router_deposits_are_rejected_once_the_battle_is_live() {
        let mut arena = arena_with_router();
        fund(&mut arena, 1, 100, 100);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
        let msg = routed_msg("alice", 10, 0, Side::A);
        assert_eq!(router_deliver(&mut arena, "pepe", 5, msg, WINDOW_NS + 1), 5);
        assert!(arena.get_position(1, acc("alice")).is_none());
    }

    #[test]
    fn beneficiary_fields_are_ignored_for_other_senders() {
        let mut arena = arena_with_router();
        set_context("pepe", 10);
        let result = arena.ft_on_transfer(
            acc("mallory"),
            U128(100),
            routed_msg("alice", 999, 999, Side::A),
        );
        assert_eq!(returned(result), 0);
        assert!(arena.get_position(1, acc("alice")).is_none());
        let position = arena.get_position(1, acc("mallory")).unwrap();
        assert_eq!(position.usdc_equiv, U128(0));
        assert_eq!(position.from_credit, U128(0));
    }

    #[test]
    fn router_deposit_respects_the_one_side_rule() {
        let mut arena = arena_with_router();
        deposit_coin(&mut arena, "alice", "pepe", 100, Side::A, 10);
        let msg = routed_msg("alice", 10, 0, Side::B);
        assert_eq!(router_deliver(&mut arena, "shib", 7, msg, 20), 7);
        assert_eq!(arena.get_battle(1).unwrap().vault_b, U128(0));
    }

    #[test]
    fn router_top_up_accumulates_accounting_fields() {
        let mut arena = arena_with_router();
        router_deliver(
            &mut arena,
            "pepe",
            100,
            routed_msg("alice", 50, 20, Side::A),
            10,
        );
        router_deliver(
            &mut arena,
            "pepe",
            40,
            routed_msg("alice", 30, 0, Side::A),
            20,
        );
        let position = arena.get_position(1, acc("alice")).unwrap();
        assert_eq!(position.coin_amount, U128(140));
        assert_eq!(position.usdc_equiv, U128(80));
        assert_eq!(position.from_credit, U128(20));
    }

    const CREDIT_EXPIRY: u64 = WINDOW_NS * 100;

    fn usdc_msg(side: Side, total: u128) -> String {
        json!({
            "action": "deposit_usdc",
            "battle_id": 1,
            "side": side,
            "total_usdc": U128(total),
            "min_token_out": U128(100),
        })
        .to_string()
    }

    fn send_usdc(
        arena: &mut Arena,
        sender: &str,
        amount: u128,
        msg: String,
        timestamp_ns: u64,
    ) -> PromiseOrValue<U128> {
        set_context("usdc", timestamp_ns);
        arena.ft_on_transfer(acc(sender), U128(amount), msg)
    }

    fn is_promise(result: &PromiseOrValue<U128>) -> bool {
        matches!(result, PromiseOrValue::Promise(_))
    }

    fn credit_of(arena: &Arena, name: &str, timestamp_ns: u64) -> u128 {
        set_context("owner", timestamp_ns);
        arena.get_account(acc(name)).credit_balance.0
    }

    #[test]
    fn hybrid_deposit_spends_35_credit_and_forwards_50() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        let result = send_usdc(&mut arena, "alice", 15, usdc_msg(Side::A, 50), 10);
        assert!(is_promise(&result));
        assert_eq!(credit_of(&arena, "alice", 10), 0);
    }

    #[test]
    fn deposit_without_credit_is_all_wallet() {
        let mut arena = arena_with_router();
        let result = send_usdc(&mut arena, "bob", 50, usdc_msg(Side::A, 50), 10);
        assert!(is_promise(&result));
    }

    #[test]
    fn excess_wallet_usdc_is_returned_after_success() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        let result = send_usdc(&mut arena, "alice", 20, usdc_msg(Side::A, 50), 10);
        assert!(is_promise(&result));

        set_context("arena", 11);
        let unused = arena.on_swap_deposit_done(
            acc("alice"),
            U128(20),
            U128(50),
            U128(35),
            U64(CREDIT_EXPIRY),
            Ok(U128(50)),
        );
        assert_eq!(unused, U128(5));
        assert_eq!(credit_of(&arena, "alice", 11), 0);
    }

    #[test]
    fn failed_swap_restores_credit_and_refunds_the_whole_transfer() {
        for failure in [
            Err(PromiseError::Failed),
            Ok(U128(0)),
            Ok(U128(10)), // partial use is treated as failure
        ] {
            let mut arena = arena_with_router();
            grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
            let _ = send_usdc(&mut arena, "alice", 15, usdc_msg(Side::A, 50), 10);
            assert_eq!(credit_of(&arena, "alice", 10), 0);

            set_context("arena", 11);
            let unused = arena.on_swap_deposit_done(
                acc("alice"),
                U128(15),
                U128(50),
                U128(35),
                U64(CREDIT_EXPIRY),
                failure,
            );
            assert_eq!(unused, U128(15));
            assert_eq!(credit_of(&arena, "alice", 12), 35);
            assert_eq!(
                arena.get_account(acc("alice")).credit_expires_at_ns,
                U64(CREDIT_EXPIRY)
            );
        }
    }

    #[test]
    fn failed_swap_without_credit_only_refunds() {
        let mut arena = arena_with_router();
        let _ = send_usdc(&mut arena, "bob", 50, usdc_msg(Side::A, 50), 10);
        set_context("arena", 11);
        let unused = arena.on_swap_deposit_done(
            acc("bob"),
            U128(50),
            U128(50),
            U128(0),
            U64(0),
            Err(PromiseError::Failed),
        );
        assert_eq!(unused, U128(50));
        assert_eq!(credit_of(&arena, "bob", 12), 0);
    }

    #[test]
    fn refused_deposits_return_everything_and_keep_credit() {
        let refused = |arena: &mut Arena, amount: u128, msg: String, ts: u64| {
            let result = send_usdc(arena, "alice", amount, msg, ts);
            assert_eq!(returned(result), amount);
            assert_eq!(credit_of(arena, "alice", ts), 35);
        };

        // wallet part too small for what credit cannot cover
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        refused(&mut arena, 14, usdc_msg(Side::A, 50), 10);
        // zero total
        refused(&mut arena, 15, usdc_msg(Side::A, 0), 10);
        // window closed
        refused(&mut arena, 15, usdc_msg(Side::A, 50), WINDOW_NS);
        // unknown battle
        let unknown = json!({"action":"deposit_usdc","battle_id":9,"side":"A","total_usdc":"50","min_token_out":"1"});
        refused(&mut arena, 15, unknown.to_string(), 10);

        // no router configured
        let mut arena = approved_arena();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        refused(&mut arena, 15, usdc_msg(Side::A, 50), 10);

        // battle not approved
        let mut arena = arena_with_proposal();
        set_context("owner", 0);
        arena.set_router(Some(acc("router")));
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        refused(&mut arena, 15, usdc_msg(Side::A, 50), 10);

        // opposite side of an existing position
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        deposit_coin(&mut arena, "alice", "pepe", 100, Side::A, 5);
        refused(&mut arena, 15, usdc_msg(Side::B, 50), 10);
    }

    #[test]
    fn expired_credit_cannot_cover_the_deposit() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, 1_000);
        let result = send_usdc(&mut arena, "alice", 15, usdc_msg(Side::A, 50), 1_000);
        assert_eq!(returned(result), 15);
        let result = send_usdc(&mut arena, "alice", 50, usdc_msg(Side::A, 50), 1_000);
        assert!(is_promise(&result));
    }

    #[test]
    fn paused_contract_returns_usdc_deposits() {
        let mut arena = arena_with_router();
        set_context("owner", 0);
        arena.set_paused(true);
        let result = send_usdc(&mut arena, "bob", 50, usdc_msg(Side::A, 50), 10);
        assert_eq!(returned(result), 50);
    }

    fn call_as(name: &str, timestamp_ns: u64, yocto: u128) {
        let ctx = near_sdk::test_utils::VMContextBuilder::new()
            .predecessor_account_id(acc(name))
            .block_timestamp(timestamp_ns)
            .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto))
            .build();
        near_sdk::testing_env!(ctx);
    }

    #[test]
    fn credit_alone_can_fund_a_deposit() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 60, CREDIT_EXPIRY);
        call_as("alice", 10, 1);
        let _ = arena.deposit_with_credit(1, Side::A, U128(50), U128(100));
        assert_eq!(credit_of(&arena, "alice", 10), 10);
    }

    #[test]
    #[should_panic(expected = "Deposit refused")]
    fn credit_only_deposit_needs_enough_credit() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        call_as("alice", 10, 1);
        let _ = arena.deposit_with_credit(1, Side::A, U128(50), U128(100));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn credit_only_deposit_requires_one_yocto() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 60, CREDIT_EXPIRY);
        call_as("alice", 10, 0);
        let _ = arena.deposit_with_credit(1, Side::A, U128(50), U128(100));
    }

    const DAY_NS: u64 = 24 * 3_600 * NS_PER_SECOND;
    const END_NS: u64 = WINDOW_NS + DAY_NS;

    /// Battle 1 is Live: bob holds 400 pepe (A), carol 160 shib (B), prices 100/100.
    fn live_arena() -> Arena {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 400, Side::A, 10);
        deposit_coin(&mut arena, "carol", "shib", 160, Side::B, 10);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(100), U128(100));
        arena
    }

    fn settle_with(arena: &mut Arena, final_a: u128, final_b: u128) {
        set_context("agent", END_NS);
        arena.settle_battle(1, U128(final_a), U128(final_b));
    }

    fn report(arena: &mut Arena, index: u32, realized: u128) {
        set_context("agent", END_NS + 1);
        arena.report_execution(1, index, U128(realized));
    }

    #[test]
    fn winner_is_decided_and_the_plan_starts_with_the_dump() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Settling);
        assert_eq!(battle.winner, Some(Side::A));
        assert_eq!(battle.final_price_a, Some(U128(120)));

        let plan = arena.get_settlement_plan(1);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].kind, StepKind::Dump);
        assert_eq!(plan[0].amount, U128(160)); // loser (B) vault
        assert!(!plan[0].done);
        assert!(plan[0].realized.is_none());
    }

    #[test]
    fn side_b_can_win() {
        let mut arena = live_arena();
        settle_with(&mut arena, 90, 101);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.winner, Some(Side::B));
        assert_eq!(arena.get_settlement_plan(1)[0].amount, U128(400));
    }

    #[test]
    fn a_tie_voids_the_battle() {
        let mut arena = live_arena();
        settle_with(&mut arena, 110, 110);
        let battle = arena.get_battle(1).unwrap();
        assert_eq!(battle.status, BattleStatus::Voided);
        assert!(battle.winner.is_none());
        assert!(arena.get_settlement_plan(1).is_empty());
    }

    #[test]
    #[should_panic(expected = "Battle has not ended")]
    fn cannot_settle_before_the_end() {
        let mut arena = live_arena();
        set_context("agent", END_NS - 1);
        arena.settle_battle(1, U128(120), U128(105));
    }

    #[test]
    #[should_panic(expected = "Prices must be non-zero")]
    fn settlement_rejects_zero_prices() {
        let mut arena = live_arena();
        settle_with(&mut arena, 0, 105);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_settle() {
        let mut arena = live_arena();
        set_context("alice", END_NS);
        arena.settle_battle(1, U128(120), U128(105));
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_settle_twice() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        settle_with(&mut arena, 120, 105);
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn cannot_settle_a_battle_that_is_not_live() {
        let mut arena = approved_arena();
        settle_with(&mut arena, 120, 105);
    }

    #[test]
    fn reporting_the_dump_fixes_the_split_and_appends_steps() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40); // PRD example: 40 -> 22 / 14 / 2 / 2

        let plan = arena.get_settlement_plan(1);
        let steps: Vec<(StepKind, u128)> = plan.iter().map(|s| (s.kind, s.amount.0)).collect();
        assert_eq!(
            steps,
            vec![
                (StepKind::Dump, 160),
                (StepKind::Buy, 22),
                (StepKind::Burn, 2),
                (StepKind::Return, 2),
            ]
        );
        assert_eq!(plan[0].realized, Some(U128(40)));
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Settling);
        assert_eq!(
            arena
                .battles
                .get(&1)
                .unwrap()
                .settlement
                .as_ref()
                .unwrap()
                .credit_pool,
            14
        );
    }

    #[test]
    fn the_last_report_settles_the_battle_and_books_the_fee() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40);
        report(&mut arena, 1, 220);
        report(&mut arena, 2, 10);
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Settling);
        report(&mut arena, 3, 2);

        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Settled);
        assert_eq!(arena.get_config().treasury_accrued, U128(2));
        let settlement = arena.battles.get(&1).unwrap().settlement.clone().unwrap();
        assert_eq!(settlement.liquid_pool, 220);
        assert_eq!(settlement.burned, 10);
        assert_eq!(settlement.credit_pool, 14);
        assert!(arena.get_settlement_plan(1).iter().all(|s| s.done));
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.contains("\"event\":\"battle_settled\"")));
    }

    #[test]
    #[should_panic(expected = "Step already reported")]
    fn a_step_cannot_be_reported_twice() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40);
        report(&mut arena, 0, 40);
    }

    #[test]
    #[should_panic(expected = "Steps must be reported in order")]
    fn steps_must_be_reported_in_order() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40);
        report(&mut arena, 2, 10);
    }

    #[test]
    #[should_panic(expected = "Unknown step")]
    fn unknown_steps_are_rejected() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 7, 1);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_report_execution() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        set_context("alice", END_NS + 1);
        arena.report_execution(1, 0, U128(40));
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn reports_need_a_settling_battle() {
        let mut arena = live_arena();
        report(&mut arena, 0, 40);
    }

    #[test]
    fn a_dump_that_realizes_nothing_still_completes() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 0);
        for index in 1..4 {
            report(&mut arena, index, 0);
        }
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Settled);
    }

    #[test]
    fn the_plan_view_of_an_unsettled_battle_is_empty() {
        let arena = live_arena();
        assert!(arena.get_settlement_plan(1).is_empty());
        assert!(arena.get_settlement_plan(99).is_empty());
    }

    /// Fully settled battle 1: A (bob, 400 pepe) beat B (carol, 160 shib).
    /// The dump realized 40 USDC: 220 pepe bought, 10 burned, 2 USDC fee.
    fn settled_arena() -> Arena {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40);
        report(&mut arena, 1, 220);
        report(&mut arena, 2, 10);
        report(&mut arena, 3, 2);
        arena
    }

    fn claim_as(arena: &mut Arena, name: &str, timestamp_ns: u64) {
        set_context(name, timestamp_ns);
        arena.claim(1);
    }

    fn liquid(arena: &Arena, name: &str, token: &str) -> u128 {
        arena.get_liquid_balance(acc(name), acc(token)).0
    }

    #[test]
    fn winner_claims_principal_reward_and_credit() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);

        // principal 400 + liquid reward 220 (bob holds 100% of the winner vault)
        assert_eq!(liquid(&arena, "bob", "pepe"), 620);
        assert_eq!(credit_of(&arena, "bob", END_NS + 5), 14);
        assert_eq!(
            arena.get_account(acc("bob")).credit_expires_at_ns,
            U64(END_NS + 5 + 7 * DAY_NS)
        );
        assert!(arena.get_position(1, acc("bob")).unwrap().claimed);
    }

    #[test]
    fn winners_share_rewards_pro_rata() {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 300, Side::A, 10);
        deposit_coin(&mut arena, "dave", "pepe", 100, Side::A, 10);
        deposit_coin(&mut arena, "carol", "shib", 160, Side::B, 10);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(100), U128(100));
        settle_with(&mut arena, 120, 105);
        for (index, realized) in [(0, 40), (1, 220), (2, 10), (3, 2)] {
            report(&mut arena, index, realized);
        }

        claim_as(&mut arena, "bob", END_NS + 5);
        claim_as(&mut arena, "dave", END_NS + 5);
        // bob 75%: 300 + 165, dave 25%: 100 + 55
        assert_eq!(liquid(&arena, "bob", "pepe"), 465);
        assert_eq!(liquid(&arena, "dave", "pepe"), 155);
        // credit pool 14: bob floor(10.5) = 10, dave floor(3.5) = 3
        assert_eq!(credit_of(&arena, "bob", END_NS + 5), 10);
        assert_eq!(credit_of(&arena, "dave", END_NS + 5), 3);
        // payouts never exceed what was realized plus the principals
        assert!(liquid(&arena, "bob", "pepe") + liquid(&arena, "dave", "pepe") <= 400 + 220);
    }

    #[test]
    #[should_panic(expected = "Nothing to claim")]
    fn losers_cannot_claim() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "carol", END_NS + 5);
    }

    #[test]
    #[should_panic(expected = "Already claimed")]
    fn a_position_is_claimed_once() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);
        claim_as(&mut arena, "bob", END_NS + 6);
    }

    #[test]
    #[should_panic(expected = "No position in this battle")]
    fn claiming_without_a_position_fails() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "stranger", END_NS + 5);
    }

    #[test]
    #[should_panic(expected = "Battle is not settled")]
    fn nothing_can_be_claimed_before_settlement() {
        let mut arena = live_arena();
        claim_as(&mut arena, "bob", END_NS + 5);
    }

    #[test]
    #[should_panic(expected = "Battle is not settled")]
    fn nothing_can_be_claimed_while_settling() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        report(&mut arena, 0, 40);
        claim_as(&mut arena, "bob", END_NS + 5);
    }

    #[test]
    fn new_credit_resets_the_timer_for_the_whole_balance() {
        let mut arena = settled_arena();
        grant_test_credit(&mut arena, "bob", 6, END_NS + 2 * DAY_NS);
        claim_as(&mut arena, "bob", END_NS + DAY_NS);
        assert_eq!(credit_of(&arena, "bob", END_NS + DAY_NS), 6 + 14);
        assert_eq!(
            arena.get_account(acc("bob")).credit_expires_at_ns,
            U64(END_NS + DAY_NS + 7 * DAY_NS)
        );
    }

    #[test]
    fn expired_credit_is_dropped_when_new_credit_arrives() {
        let mut arena = settled_arena();
        grant_test_credit(&mut arena, "bob", 6, 1);
        claim_as(&mut arena, "bob", END_NS + 5);
        assert_eq!(credit_of(&arena, "bob", END_NS + 5), 14);
    }

    #[test]
    fn the_creator_gets_the_bond_back_when_the_battle_settles() {
        let arena = settled_arena();
        assert_eq!(liquid(&arena, "alice", "usdc"), 5_000_000);
    }

    #[test]
    fn the_creator_gets_the_bond_back_when_the_battle_ties() {
        let mut arena = live_arena();
        settle_with(&mut arena, 110, 110);
        assert_eq!(liquid(&arena, "alice", "usdc"), 5_000_000);
    }

    #[test]
    fn the_bond_is_not_returned_before_the_battle_ends() {
        let arena = live_arena();
        assert_eq!(liquid(&arena, "alice", "usdc"), 0);
    }

    #[test]
    fn withdrawing_debits_the_liquid_balance_and_can_be_restored() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);

        call_as("bob", END_NS + 6, 1);
        let _ = arena.withdraw_liquid(acc("pepe"), U128(600));
        assert_eq!(liquid(&arena, "bob", "pepe"), 20);

        arena.on_liquid_paid(
            acc("bob"),
            acc("pepe"),
            U128(600),
            Err(PromiseError::Failed),
        );
        assert_eq!(liquid(&arena, "bob", "pepe"), 620);

        arena.on_liquid_paid(acc("bob"), acc("pepe"), U128(600), Ok(()));
        assert_eq!(liquid(&arena, "bob", "pepe"), 620);
    }

    #[test]
    #[should_panic(expected = "Insufficient liquid balance")]
    fn cannot_withdraw_more_than_the_balance() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);
        call_as("bob", END_NS + 6, 1);
        let _ = arena.withdraw_liquid(acc("pepe"), U128(621));
    }

    #[test]
    #[should_panic(expected = "Amount must be positive")]
    fn cannot_withdraw_zero() {
        let mut arena = settled_arena();
        call_as("bob", END_NS + 6, 1);
        let _ = arena.withdraw_liquid(acc("pepe"), U128(0));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdrawing_requires_one_yocto() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);
        call_as("bob", END_NS + 6, 0);
        let _ = arena.withdraw_liquid(acc("pepe"), U128(1));
    }

    #[test]
    fn withdrawals_work_while_paused() {
        let mut arena = settled_arena();
        claim_as(&mut arena, "bob", END_NS + 5);
        set_context("owner", END_NS + 5);
        arena.set_paused(true);
        call_as("bob", END_NS + 6, 1);
        let _ = arena.withdraw_liquid(acc("pepe"), U128(620));
        assert_eq!(liquid(&arena, "bob", "pepe"), 0);
    }

    fn halt_as_agent(arena: &mut Arena, timestamp_ns: u64) {
        set_context("agent", timestamp_ns);
        arena.emergency_halt(1, "liquidity drop".to_string());
    }

    fn refund_as(arena: &mut Arena, name: &str, timestamp_ns: u64) {
        set_context(name, timestamp_ns);
        arena.withdraw_initial_deposit(1);
    }

    #[test]
    fn a_halted_live_battle_refunds_both_sides_in_full() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        assert_eq!(
            arena.get_battle(1).unwrap().status,
            BattleStatus::EmergencyHalted
        );

        refund_as(&mut arena, "bob", WINDOW_NS + 200);
        refund_as(&mut arena, "carol", WINDOW_NS + 200);
        assert_eq!(liquid(&arena, "bob", "pepe"), 400);
        assert_eq!(liquid(&arena, "carol", "shib"), 160);
        assert!(arena.get_position(1, acc("bob")).unwrap().claimed);
    }

    #[test]
    fn a_halt_pays_no_rewards_or_fees() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        refund_as(&mut arena, "bob", WINDOW_NS + 200);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("\"event\":\"refund\"")));
        assert_eq!(arena.get_config().treasury_accrued, U128(0));
        assert_eq!(credit_of(&arena, "bob", WINDOW_NS + 200), 0);
    }

    #[test]
    fn a_halt_returns_the_bond_to_the_creator() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        assert_eq!(liquid(&arena, "alice", "usdc"), 5_000_000);
    }

    #[test]
    fn an_approved_battle_can_be_halted_during_the_gathering_window() {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 10);
        halt_as_agent(&mut arena, 20);
        refund_as(&mut arena, "bob", 30);
        assert_eq!(liquid(&arena, "bob", "pepe"), 100);
    }

    #[test]
    #[should_panic(expected = "Already refunded")]
    fn a_deposit_is_refunded_once() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        refund_as(&mut arena, "bob", WINDOW_NS + 200);
        refund_as(&mut arena, "bob", WINDOW_NS + 300);
    }

    #[test]
    #[should_panic(expected = "Battle cannot be halted")]
    fn a_settled_battle_cannot_be_halted() {
        let mut arena = settled_arena();
        halt_as_agent(&mut arena, END_NS + 10);
    }

    #[test]
    #[should_panic(expected = "Battle cannot be halted")]
    fn a_settling_battle_cannot_be_halted() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        halt_as_agent(&mut arena, END_NS + 10);
    }

    #[test]
    #[should_panic(expected = "Battle cannot be halted")]
    fn a_proposed_battle_cannot_be_halted() {
        let mut arena = arena_with_proposal();
        halt_as_agent(&mut arena, 10);
    }

    #[test]
    #[should_panic(expected = "Battle cannot be halted")]
    fn a_battle_cannot_be_halted_twice() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        halt_as_agent(&mut arena, WINDOW_NS + 200);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_halt() {
        let mut arena = live_arena();
        set_context("alice", WINDOW_NS + 100);
        arena.emergency_halt(1, "x".to_string());
    }

    #[test]
    #[should_panic(expected = "Battle is not in the required status")]
    fn a_halted_battle_cannot_be_settled() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        settle_with(&mut arena, 120, 105);
    }

    #[test]
    #[should_panic(expected = "Battle not found")]
    fn halting_an_unknown_battle_fails() {
        let mut arena = live_arena();
        set_context("agent", WINDOW_NS + 100);
        arena.emergency_halt(42, "x".to_string());
    }

    #[test]
    fn deposits_are_refundable_after_a_void_at_lock() {
        let mut arena = approved_arena();
        deposit_coin(&mut arena, "bob", "pepe", 100, Side::A, 10);
        set_context("agent", WINDOW_NS);
        arena.set_initial_prices(1, U128(1), U128(1));
        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Voided);

        refund_as(&mut arena, "bob", WINDOW_NS + 10);
        assert_eq!(liquid(&arena, "bob", "pepe"), 100);
        // the bond of a battle nobody joined stays with the treasury
        assert_eq!(liquid(&arena, "alice", "usdc"), 0);
    }

    #[test]
    fn deposits_are_refundable_after_a_tie() {
        let mut arena = live_arena();
        settle_with(&mut arena, 110, 110);
        refund_as(&mut arena, "bob", END_NS + 5);
        refund_as(&mut arena, "carol", END_NS + 5);
        assert_eq!(liquid(&arena, "bob", "pepe"), 400);
        assert_eq!(liquid(&arena, "carol", "shib"), 160);
    }

    #[test]
    #[should_panic(expected = "Refunds are not available")]
    fn a_live_battle_has_no_refunds() {
        let mut arena = live_arena();
        refund_as(&mut arena, "bob", WINDOW_NS + 10);
    }

    #[test]
    #[should_panic(expected = "Refunds are not available")]
    fn a_settled_battle_has_no_refunds() {
        let mut arena = settled_arena();
        refund_as(&mut arena, "bob", END_NS + 10);
    }

    #[test]
    #[should_panic(expected = "No position in this battle")]
    fn refunds_need_a_position() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        refund_as(&mut arena, "stranger", WINDOW_NS + 200);
    }

    #[test]
    fn refunds_work_while_paused() {
        let mut arena = live_arena();
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        set_context("owner", WINDOW_NS + 100);
        arena.set_paused(true);
        refund_as(&mut arena, "bob", WINDOW_NS + 200);
        assert_eq!(liquid(&arena, "bob", "pepe"), 400);
    }

    #[test]
    fn agents_can_still_halt_while_paused() {
        let mut arena = live_arena();
        set_context("owner", WINDOW_NS + 50);
        arena.set_paused(true);
        halt_as_agent(&mut arena, WINDOW_NS + 100);
        assert_eq!(
            arena.get_battle(1).unwrap().status,
            BattleStatus::EmergencyHalted
        );
    }

    /// Settling battle 1 (A won) with on-chain execution through `dex`.
    fn execution_arena() -> Arena {
        let mut arena = live_arena();
        set_context("owner", END_NS);
        arena.set_execution(Some(acc("dex")), Some(acc("burn")));
        settle_with(&mut arena, 120, 105);
        arena
    }

    fn exec_step(arena: &mut Arena, index: u32, min_out: u128) -> PromiseOrValue<bool> {
        set_context("agent", END_NS + 1);
        arena.execute_step(1, index, U128(min_out))
    }

    fn proceeds_from(
        arena: &mut Arena,
        sender: &str,
        token: &str,
        amount: u128,
        index: u32,
    ) -> u128 {
        set_context(token, END_NS + 2);
        let msg =
            json!({"action": "step_proceeds", "battle_id": 1, "step_index": index}).to_string();
        returned(arena.ft_on_transfer(acc(sender), U128(amount), msg))
    }

    fn plan_dispatched(arena: &Arena, index: usize) -> bool {
        arena.get_settlement_plan(1)[index].dispatched
    }

    #[test]
    fn the_full_plan_runs_on_chain_and_settles() {
        let mut arena = execution_arena();

        // Dump: 160 loser coin -> at least 30 USDC; the DEX paid 40
        assert!(matches!(
            exec_step(&mut arena, 0, 30),
            PromiseOrValue::Promise(_)
        ));
        assert!(plan_dispatched(&arena, 0));
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 0);
        assert_eq!(arena.get_settlement_plan(1).len(), 4);

        // Buy: 22 USDC -> winner coin; Burn: 2 USDC -> winner coin, burned
        let _ = exec_step(&mut arena, 1, 200);
        assert_eq!(proceeds_from(&mut arena, "dex", "pepe", 220, 1), 0);
        let _ = exec_step(&mut arena, 2, 9);
        assert_eq!(proceeds_from(&mut arena, "dex", "pepe", 10, 2), 0);

        // Return: the fee is booked without a swap
        assert!(matches!(
            exec_step(&mut arena, 3, 1),
            PromiseOrValue::Value(true)
        ));

        assert_eq!(arena.get_battle(1).unwrap().status, BattleStatus::Settled);
        assert_eq!(arena.get_config().treasury_accrued, U128(2));
        let settlement = arena.battles.get(&1).unwrap().settlement.clone().unwrap();
        assert_eq!(settlement.liquid_pool, 220);
        assert_eq!(settlement.burned, 10);
        assert_eq!(settlement.credit_pool, 14);
        assert_eq!(liquid(&arena, "alice", "usdc"), 5_000_000);
    }

    #[test]
    fn the_realized_amount_is_what_the_dex_actually_paid() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        proceeds_from(&mut arena, "dex", "usdc", 100, 0); // better than the minimum
        let plan = arena.get_settlement_plan(1);
        assert_eq!(plan[0].realized, Some(U128(100)));
        assert_eq!(plan[1].amount, U128(55)); // 55% of what really arrived
    }

    #[test]
    fn proceeds_below_the_minimum_are_rejected() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 29, 0), 29);
        assert!(!arena.get_settlement_plan(1)[0].done);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 30, 0), 0);
        assert!(arena.get_settlement_plan(1)[0].done);
    }

    #[test]
    fn proceeds_need_a_dispatched_step() {
        let mut arena = execution_arena();
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 40);
        assert!(!arena.get_settlement_plan(1)[0].done);
    }

    #[test]
    fn proceeds_from_anyone_but_the_dex_are_rejected() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        assert_eq!(proceeds_from(&mut arena, "mallory", "usdc", 40, 0), 40);
        assert!(!arena.get_settlement_plan(1)[0].done);
    }

    #[test]
    fn proceeds_in_the_wrong_token_are_rejected() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        assert_eq!(proceeds_from(&mut arena, "dex", "pepe", 40, 0), 40);
        assert_eq!(proceeds_from(&mut arena, "dex", "shib", 40, 0), 40);
        assert!(!arena.get_settlement_plan(1)[0].done);
    }

    #[test]
    fn a_step_cannot_be_booked_twice() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 0);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 40);
    }

    #[test]
    fn proceeds_are_ignored_without_execution_config() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 40);
    }

    #[test]
    fn proceeds_are_accepted_while_paused() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        set_context("owner", END_NS + 1);
        arena.set_paused(true);
        assert_eq!(proceeds_from(&mut arena, "dex", "usdc", 40, 0), 0);
    }

    #[test]
    #[should_panic(expected = "Step already dispatched")]
    fn a_step_cannot_be_dispatched_twice() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        let _ = exec_step(&mut arena, 0, 30);
    }

    #[test]
    #[should_panic(expected = "Steps must be reported in order")]
    fn steps_are_dispatched_in_order() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        proceeds_from(&mut arena, "dex", "usdc", 40, 0);
        let _ = exec_step(&mut arena, 2, 1);
    }

    #[test]
    #[should_panic(expected = "Minimum output must be positive")]
    fn a_swap_step_needs_a_positive_minimum() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 0);
    }

    #[test]
    #[should_panic(expected = "On-chain execution is not configured")]
    fn executing_needs_the_dex_to_be_configured() {
        let mut arena = live_arena();
        settle_with(&mut arena, 120, 105);
        let _ = exec_step(&mut arena, 0, 30);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_execute_steps() {
        let mut arena = execution_arena();
        set_context("alice", END_NS + 1);
        let _ = arena.execute_step(1, 0, U128(30));
    }

    #[test]
    #[should_panic(expected = "Execution runs on-chain")]
    fn reported_amounts_are_refused_when_execution_is_on_chain() {
        let mut arena = execution_arena();
        report(&mut arena, 0, 40);
    }

    #[test]
    fn a_refused_swap_makes_the_step_dispatchable_again() {
        for failure in [Err(PromiseError::Failed), Ok(U128(0))] {
            let mut arena = execution_arena();
            let _ = exec_step(&mut arena, 0, 30);
            assert!(plan_dispatched(&arena, 0));
            set_context("arena", END_NS + 3);
            arena.on_step_sent(1, 0, U128(160), failure);
            assert!(!plan_dispatched(&arena, 0));
            let _ = exec_step(&mut arena, 0, 30);
            assert!(plan_dispatched(&arena, 0));
        }
    }

    #[test]
    fn an_accepted_swap_keeps_the_step_dispatched() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        set_context("arena", END_NS + 3);
        arena.on_step_sent(1, 0, U128(160), Ok(U128(160)));
        assert!(plan_dispatched(&arena, 0));
    }

    #[test]
    fn a_failed_callback_never_reopens_a_finished_step() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 30);
        proceeds_from(&mut arena, "dex", "usdc", 40, 0);
        set_context("arena", END_NS + 3);
        arena.on_step_sent(1, 0, U128(160), Err(PromiseError::Failed));
        assert!(arena.get_settlement_plan(1)[0].done);
    }

    #[test]
    fn a_zero_amount_swap_step_completes_without_the_dex() {
        let mut arena = execution_arena();
        let _ = exec_step(&mut arena, 0, 1);
        proceeds_from(&mut arena, "dex", "usdc", 1, 0); // 1 USDC: every share rounds to 0 except fee
        let plan = arena.get_settlement_plan(1);
        assert_eq!(plan[1].amount, U128(0));
        assert!(matches!(
            exec_step(&mut arena, 1, 1),
            PromiseOrValue::Value(true)
        ));
        assert!(arena.get_settlement_plan(1)[1].done);
    }

    #[test]
    fn execution_is_configured_by_the_owner_with_both_accounts() {
        let mut arena = new_arena();
        arena.set_execution(Some(acc("dex")), Some(acc("burn")));
        let config = arena.get_config();
        assert_eq!(config.execution_dex, Some(acc("dex")));
        assert_eq!(config.burn_account, Some(acc("burn")));
        arena.set_execution(None, None);
        assert_eq!(arena.get_config().execution_dex, None);
    }

    #[test]
    #[should_panic(expected = "Set both the DEX and the burn account, or neither")]
    fn execution_needs_both_accounts() {
        let mut arena = new_arena();
        arena.set_execution(Some(acc("dex")), None);
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_the_owner_configures_execution() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_execution(Some(acc("dex")), Some(acc("burn")));
    }

    fn fund_msg() -> String {
        json!({ "action": "fund_balance" }).to_string()
    }

    fn fund_usdc(arena: &mut Arena, name: &str, amount: u128) -> u128 {
        let result = send_usdc(arena, name, amount, fund_msg(), 10);
        returned(result)
    }

    fn from_balance(arena: &mut Arena, name: &str, total: u128, timestamp_ns: u64) -> Promise {
        // no attached deposit: this is what a scoped session key can do
        call_as(name, timestamp_ns, 0);
        arena.deposit_from_balance(1, Side::A, U128(total), U128(100))
    }

    #[test]
    fn funding_the_balance_credits_liquid_usdc() {
        let mut arena = arena_with_router();
        assert_eq!(fund_usdc(&mut arena, "bob", 50), 0);
        assert_eq!(liquid(&arena, "bob", "usdc"), 50);
        assert_eq!(fund_usdc(&mut arena, "bob", 25), 0);
        assert_eq!(liquid(&arena, "bob", "usdc"), 75);
    }

    #[test]
    fn funding_with_zero_changes_nothing() {
        let mut arena = arena_with_router();
        assert_eq!(fund_usdc(&mut arena, "bob", 0), 0);
        assert_eq!(liquid(&arena, "bob", "usdc"), 0);
    }

    #[test]
    fn only_usdc_can_fund_the_balance() {
        let mut arena = arena_with_router();
        set_context("pepe", 10);
        let result = arena.ft_on_transfer(acc("bob"), U128(50), fund_msg());
        assert_eq!(returned(result), 50);
        assert_eq!(liquid(&arena, "bob", "pepe"), 0);
    }

    #[test]
    fn a_paused_contract_returns_balance_funding() {
        let mut arena = arena_with_router();
        set_context("owner", 0);
        arena.set_paused(true);
        assert_eq!(fund_usdc(&mut arena, "bob", 50), 50);
    }

    #[test]
    fn a_hybrid_deposit_spends_credit_then_balance() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        fund_usdc(&mut arena, "alice", 20);
        let _ = from_balance(&mut arena, "alice", 50, 10);
        assert_eq!(credit_of(&arena, "alice", 10), 0);
        assert_eq!(liquid(&arena, "alice", "usdc"), 5); // 20 - 15 from the wallet side
    }

    #[test]
    fn a_deposit_without_credit_spends_only_the_balance() {
        let mut arena = arena_with_router();
        fund_usdc(&mut arena, "bob", 80);
        let _ = from_balance(&mut arena, "bob", 50, 10);
        assert_eq!(liquid(&arena, "bob", "usdc"), 30);
    }

    #[test]
    fn credit_alone_can_fund_a_deposit_from_balance() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 60, CREDIT_EXPIRY);
        let _ = from_balance(&mut arena, "alice", 50, 10);
        assert_eq!(credit_of(&arena, "alice", 10), 10);
        assert_eq!(liquid(&arena, "alice", "usdc"), 0);
    }

    #[test]
    #[should_panic(expected = "Deposit refused")]
    fn an_insufficient_balance_refuses_the_deposit() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        fund_usdc(&mut arena, "alice", 14);
        let _ = from_balance(&mut arena, "alice", 50, 10);
    }

    #[test]
    fn a_refused_deposit_leaves_credit_and_balance_untouched() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        fund_usdc(&mut arena, "alice", 14);
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = from_balance(&mut arena, "alice", 50, 10);
        }));
        assert!(attempt.is_err());
        assert_eq!(credit_of(&arena, "alice", 10), 35);
        assert_eq!(liquid(&arena, "alice", "usdc"), 14);
    }

    #[test]
    #[should_panic(expected = "Deposit refused")]
    fn balance_deposits_need_a_router() {
        let mut arena = approved_arena();
        fund_usdc(&mut arena, "bob", 80);
        let _ = from_balance(&mut arena, "bob", 50, 10);
    }

    #[test]
    #[should_panic(expected = "Deposit refused")]
    fn balance_deposits_respect_the_one_side_rule() {
        let mut arena = arena_with_router();
        deposit_coin(&mut arena, "bob", "shib", 100, Side::B, 5);
        fund_usdc(&mut arena, "bob", 80);
        let _ = from_balance(&mut arena, "bob", 50, 10);
    }

    #[test]
    #[should_panic(expected = "Deposit refused")]
    fn balance_deposits_need_an_open_window() {
        let mut arena = arena_with_router();
        fund_usdc(&mut arena, "bob", 80);
        let _ = from_balance(&mut arena, "bob", 50, WINDOW_NS);
    }

    #[test]
    #[should_panic(expected = "Deposits are paused")]
    fn balance_deposits_stop_while_paused() {
        let mut arena = arena_with_router();
        fund_usdc(&mut arena, "bob", 80);
        set_context("owner", 10);
        arena.set_paused(true);
        let _ = from_balance(&mut arena, "bob", 50, 10);
    }

    #[test]
    fn a_failed_balance_deposit_gives_back_credit_and_balance() {
        for (i, failure) in [Err(PromiseError::Failed), Ok(U128(0)), Ok(U128(10))]
            .into_iter()
            .enumerate()
        {
            // a separate account per round: collections flush to storage when dropped
            let user = format!("user{i}");
            let user = user.as_str();
            let mut arena = arena_with_router();
            grant_test_credit(&mut arena, user, 35, CREDIT_EXPIRY);
            fund_usdc(&mut arena, user, 20);
            let _ = from_balance(&mut arena, user, 50, 10);

            set_context("arena", 11);
            arena.on_balance_deposit_done(
                acc(user),
                U128(15),
                U128(50),
                U128(35),
                U64(CREDIT_EXPIRY),
                failure,
            );
            assert_eq!(credit_of(&arena, user, 12), 35);
            assert_eq!(liquid(&arena, user, "usdc"), 20);
        }
    }

    #[test]
    fn a_completed_balance_deposit_keeps_the_spend() {
        let mut arena = arena_with_router();
        grant_test_credit(&mut arena, "alice", 35, CREDIT_EXPIRY);
        fund_usdc(&mut arena, "alice", 20);
        let _ = from_balance(&mut arena, "alice", 50, 10);
        set_context("arena", 11);
        arena.on_balance_deposit_done(
            acc("alice"),
            U128(15),
            U128(50),
            U128(35),
            U64(CREDIT_EXPIRY),
            Ok(U128(50)),
        );
        assert_eq!(credit_of(&arena, "alice", 12), 0);
        assert_eq!(liquid(&arena, "alice", "usdc"), 5);
    }

    #[test]
    fn the_returned_bond_can_fund_a_deposit() {
        let mut arena = settled_arena();
        // alice (the creator) got her 5 USDC bond back as liquid USDC; open a new battle for it
        assert_eq!(liquid(&arena, "alice", "usdc"), 5_000_000);
        set_context("owner", END_NS + 10);
        arena.set_router(Some(acc("router")));
        let msg = json!({
            "action": "propose",
            "token_a": acc("pepe"),
            "token_b": acc("shib"),
            "duration_secs": 60,
        })
        .to_string();
        let result = send_usdc(&mut arena, "alice", 5_000_000, msg, END_NS + 10);
        assert_eq!(returned(result), 0);
        set_context("agent", END_NS + 11);
        arena.approve_battle(2);
        call_as("alice", END_NS + 12, 0);
        let _ = arena.deposit_from_balance(2, Side::A, U128(5_000_000), U128(1));
        assert_eq!(liquid(&arena, "alice", "usdc"), 0);
    }

    const F_ROUTER: &str = "2626664c2603336e57b271c5c0b26f421741e481";
    const F_TREASURY: &str = "00000000000000000000000000000000000a11ce";
    const F_BURN: &str = "000000000000000000000000000000000000dead";
    const F_USDC: &str = "833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const F_COIN: &str = "4200000000000000000000000000000000000006";

    fn foreign_input() -> ForeignConfigInput {
        ForeignConfigInput {
            mpc_contract: acc("signer"),
            chain_id: U64(8453),
            router: F_ROUTER.into(),
            treasury: F_TREASURY.into(),
            burn: F_BURN.into(),
        }
    }

    fn tx_params() -> ForeignTxParams {
        ForeignTxParams {
            nonce: U64(3),
            max_priority_fee_per_gas: U128(1_000_000),
            max_fee_per_gas: U128(2_000_000_000),
            gas_limit: U64(150_000),
        }
    }

    fn swap_call(recipient: &str) -> ForeignCall {
        ForeignCall::SwapExactIn {
            token_in: F_COIN.into(),
            token_out: F_USDC.into(),
            fee: 3000,
            recipient: recipient.into(),
            amount_in: U128(500),
            min_out: U128(400),
        }
    }

    fn fee_call(to: &str) -> ForeignCall {
        ForeignCall::Transfer {
            token: F_USDC.into(),
            to: to.into(),
            amount: U128(2_000_000),
        }
    }

    /// Battle 1 is Settling (A won, plan = [Dump]) and the foreign chain is configured.
    fn signing_arena() -> Arena {
        let mut arena = live_arena();
        set_context("owner", END_NS);
        arena.set_foreign(Some(foreign_input()));
        settle_with(&mut arena, 120, 105);
        arena
    }

    fn sign_as_agent(arena: &mut Arena, call: ForeignCall, step_index: Option<u32>) -> Promise {
        set_context("agent", END_NS + 1);
        arena.request_signature(1, call, tx_params(), step_index)
    }

    fn good_response(recovery_id: u64) -> near_sdk::serde_json::Value {
        json!({
            "Secp256k1": {
                "big_r": format!("02{}", "ab".repeat(32)),
                "s": "11".repeat(32),
                "recovery_id": recovery_id,
            }
        })
    }

    fn deliver(
        arena: &mut Arena,
        request_id: u64,
        result: Result<near_sdk::serde_json::Value, PromiseError>,
    ) {
        set_context("arena", END_NS + 2);
        arena.on_signature(request_id, result);
    }

    #[test]
    fn the_owner_configures_the_foreign_chain() {
        let mut arena = new_arena();
        assert!(arena.get_foreign_config().is_none());
        arena.set_foreign(Some(foreign_input()));
        let view = arena.get_foreign_config().unwrap();
        assert_eq!(view.chain_id, U64(8453));
        assert_eq!(view.router, F_ROUTER);
        assert_eq!(view.mpc_contract, acc("signer"));
        arena.set_foreign(None);
        assert!(arena.get_foreign_config().is_none());
    }

    #[test]
    #[should_panic(expected = "Invalid foreign address")]
    fn a_bad_foreign_address_is_refused() {
        let mut arena = new_arena();
        let mut input = foreign_input();
        input.router = "0x1234".into();
        arena.set_foreign(Some(input));
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_the_owner_configures_the_foreign_chain() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_foreign(Some(foreign_input()));
    }

    #[test]
    #[should_panic(expected = "Cross-chain signing is not configured")]
    fn signing_needs_the_foreign_chain() {
        let mut arena = live_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_request_signatures() {
        let mut arena = signing_arena();
        set_context("alice", END_NS + 1);
        let _ = arena.request_signature(1, swap_call(F_BURN), tx_params(), None);
    }

    #[test]
    #[should_panic(expected = "Battle is not active")]
    fn signing_needs_an_active_battle() {
        let mut arena = arena_with_proposal();
        set_context("owner", 0);
        arena.set_foreign(Some(foreign_input()));
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
    }

    #[test]
    fn a_request_is_stored_pending_with_the_payload_hash_and_a_battle_path() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("signature_requested")));

        assert_eq!(arena.get_signature_request_count(), 1);
        let view = arena.get_signature_request(1).unwrap();
        assert_eq!(view.status, SignStatus::Pending);
        assert_eq!(view.path, "valtrum-battle-1");
        assert_eq!(view.attempts, 0);
        assert!(view.signed_tx.is_none());
        let tx = arena.sign_requests.get(&1).unwrap().tx.clone();
        assert_eq!(view.payload_hash, mpc::hex_encode(&tx.signing_hash()));
        assert_eq!(view.unsigned_tx, mpc::hex_encode(&tx.unsigned()));
        assert_eq!(tx.nonce, 3);
        assert_eq!(tx.chain_id, 8453);
    }

    #[test]
    fn every_request_gets_its_own_id() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        let _ = sign_as_agent(&mut arena, fee_call(F_TREASURY), None);
        assert_eq!(arena.get_signature_request_count(), 2);
        assert_ne!(
            arena.get_signature_request(1).unwrap().payload_hash,
            arena.get_signature_request(2).unwrap().payload_hash
        );
    }

    #[test]
    #[should_panic(expected = "Steps can only be signed while settling")]
    fn steps_are_only_signed_while_settling() {
        let mut arena = approved_arena();
        set_context("owner", 0);
        arena.set_foreign(Some(foreign_input()));
        set_context("agent", 1);
        let _ = arena.request_signature(1, swap_call(F_BURN), tx_params(), Some(0));
    }

    #[test]
    fn a_call_must_fit_its_step() {
        let mut arena = signing_arena();
        // the dump step takes a swap
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), Some(0));
        // after the dump is reported the plan grows to Buy, Burn, Return
        report(&mut arena, 0, 40);
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), Some(2)); // burn: swap paying the burn address
        let _ = sign_as_agent(&mut arena, fee_call(F_TREASURY), Some(3)); // return: fee to the treasury
        assert_eq!(arena.get_signature_request_count(), 3);
    }

    #[test]
    #[should_panic(expected = "Call does not fit this step")]
    fn a_transfer_does_not_fit_the_dump_step() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, fee_call(F_TREASURY), Some(0));
    }

    #[test]
    #[should_panic(expected = "A burn swap must pay the burn address")]
    fn a_burn_swap_must_pay_the_burn_address() {
        let mut arena = signing_arena();
        report(&mut arena, 0, 40);
        let _ = sign_as_agent(&mut arena, swap_call(F_TREASURY), Some(2));
    }

    #[test]
    #[should_panic(expected = "The fee must go to the treasury address")]
    fn the_fee_must_go_to_the_treasury() {
        let mut arena = signing_arena();
        report(&mut arena, 0, 40);
        let _ = sign_as_agent(&mut arena, fee_call(F_BURN), Some(3));
    }

    #[test]
    #[should_panic(expected = "Step already reported")]
    fn a_finished_step_cannot_be_signed_again() {
        let mut arena = signing_arena();
        report(&mut arena, 0, 40);
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), Some(0));
    }

    #[test]
    #[should_panic(expected = "Unknown step")]
    fn an_unknown_step_is_refused() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), Some(9));
    }

    #[test]
    #[should_panic(expected = "Approvals are only allowed for the router")]
    fn approvals_for_other_spenders_are_refused() {
        let mut arena = signing_arena();
        let call = ForeignCall::Approve {
            token: F_COIN.into(),
            spender: F_BURN.into(),
            amount: U128(1),
        };
        let _ = sign_as_agent(&mut arena, call, None);
    }

    #[test]
    #[should_panic(expected = "Transfers are only allowed to the treasury or burn address")]
    fn transfers_to_strangers_are_refused() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(
            &mut arena,
            fee_call("00000000000000000000000000000000000bad01"),
            None,
        );
    }

    #[test]
    fn a_good_signature_becomes_a_signed_transaction() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Ok(good_response(1)));

        let view = arena.get_signature_request(1).unwrap();
        assert_eq!(view.status, SignStatus::Signed);
        let tx = arena.sign_requests.get(&1).unwrap().tx.clone();
        let expected = tx.signed(&mpc::EcdsaSignature {
            r: [0xab; 32],
            s: [0x11; 32],
            y_parity: 1,
        });
        assert_eq!(view.signed_tx, Some(mpc::hex_encode(&expected)));
        assert_eq!(
            view.tx_hash,
            Some(mpc::hex_encode(&mpc::tx_hash(&expected)))
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("signature_ready")));
    }

    #[test]
    fn a_high_s_signature_is_stored_normalized() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        // the group order minus five: valid, but far above half the order
        let high_s = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd036413c".to_string();
        let response =
            json!({ "big_r": format!("02{}", "ab".repeat(32)), "s": high_s, "recovery_id": 0 });
        deliver(&mut arena, 1, Ok(response));
        let signed =
            mpc::hex_decode(&arena.get_signature_request(1).unwrap().signed_tx.unwrap()).unwrap();
        // tail = yParity, 0xa0 + r (32 bytes), s. The stored s is 5 (n - (n - 5)), which
        // RLP writes as the single byte 0x05, and the parity flipped from 0 to 1.
        let len = signed.len();
        assert_eq!(signed[len - 1], 0x05);
        assert_eq!(signed[len - 34], 0xa0);
        assert_eq!(signed[len - 35], 0x01);
    }

    #[test]
    fn a_signer_error_marks_the_request_failed() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Err(PromiseError::Failed));
        let view = arena.get_signature_request(1).unwrap();
        assert_eq!(view.status, SignStatus::Failed);
        assert_eq!(view.attempts, 1);
        assert!(view.signed_tx.is_none());
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|l| l.contains("signature_failed")));
    }

    #[test]
    fn an_unusable_response_marks_the_request_failed() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(
            &mut arena,
            1,
            Ok(json!({ "Ed25519": { "signature": [1, 2] } })),
        );
        assert_eq!(
            arena.get_signature_request(1).unwrap().status,
            SignStatus::Failed
        );
    }

    #[test]
    fn a_late_answer_for_a_finished_request_is_ignored() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Ok(good_response(0)));
        let signed = arena.get_signature_request(1).unwrap().signed_tx;
        deliver(&mut arena, 1, Err(PromiseError::Failed));
        deliver(&mut arena, 1, Ok(good_response(1)));
        let view = arena.get_signature_request(1).unwrap();
        assert_eq!(view.status, SignStatus::Signed);
        assert_eq!(view.signed_tx, signed);
        assert_eq!(view.attempts, 0);
    }

    #[test]
    fn an_answer_for_an_unknown_request_does_not_panic() {
        let mut arena = signing_arena();
        deliver(&mut arena, 77, Ok(good_response(0)));
        assert_eq!(arena.get_signature_request_count(), 0);
    }

    #[test]
    fn a_failed_request_can_be_retried_and_then_succeeds() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Err(PromiseError::Failed));

        set_context("agent", END_NS + 3);
        let _ = arena.retry_signature(1);
        assert_eq!(
            arena.get_signature_request(1).unwrap().status,
            SignStatus::Pending
        );
        deliver(&mut arena, 1, Ok(good_response(0)));
        let view = arena.get_signature_request(1).unwrap();
        assert_eq!(view.status, SignStatus::Signed);
        assert_eq!(view.attempts, 1);
    }

    #[test]
    fn retrying_keeps_the_same_payload() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        let before = arena.get_signature_request(1).unwrap().payload_hash;
        deliver(&mut arena, 1, Err(PromiseError::Failed));
        set_context("agent", END_NS + 3);
        let _ = arena.retry_signature(1);
        assert_eq!(arena.get_signature_request(1).unwrap().payload_hash, before);
    }

    #[test]
    #[should_panic(expected = "Only a failed request can be retried")]
    fn a_pending_request_cannot_be_retried() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        set_context("agent", END_NS + 3);
        let _ = arena.retry_signature(1);
    }

    #[test]
    #[should_panic(expected = "Only a failed request can be retried")]
    fn a_signed_request_cannot_be_retried() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Ok(good_response(0)));
        set_context("agent", END_NS + 3);
        let _ = arena.retry_signature(1);
    }

    #[test]
    #[should_panic(expected = "Request not found")]
    fn an_unknown_request_cannot_be_retried() {
        let mut arena = signing_arena();
        set_context("agent", END_NS + 3);
        let _ = arena.retry_signature(5);
    }

    #[test]
    #[should_panic(expected = "Only a whitelisted agent")]
    fn only_agents_retry() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        deliver(&mut arena, 1, Err(PromiseError::Failed));
        set_context("alice", END_NS + 3);
        let _ = arena.retry_signature(1);
    }

    #[test]
    #[should_panic(expected = "Too many failed attempts")]
    fn retries_stop_after_the_attempt_limit() {
        let mut arena = signing_arena();
        let _ = sign_as_agent(&mut arena, swap_call(F_BURN), None);
        for _ in 0..MAX_SIGN_ATTEMPTS {
            deliver(&mut arena, 1, Err(PromiseError::Failed));
            set_context("agent", END_NS + 3);
            let _ = arena.retry_signature(1);
        }
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn non_owner_cannot_pause() {
        let mut arena = new_arena();
        set_context("stranger", 0);
        arena.set_paused(true);
    }
}
