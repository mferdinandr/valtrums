//! Persistent NEAR wrapper for bounded player grants and atomic budget reservations.
//!
//! Only a user (the NEAR caller) can create or revoke their own grant; a JSON field is never
//! authentication. Only a grant's delegate (or the user) can reserve against it, so no auditor,
//! scheduler, relayer, operator or the owner gains player-spending authority. Validation and the
//! budget reservation happen in one `&mut self` transition, so there is no read-then-write gap.
//!
//! No signing, token transfer, MPC call or custody access happens here: a reservation is an
//! authorization and a budget hold, never a transfer or proof of funds.
//!
//! Outcome transitions run in the normal build. The user or delegate admits a reservation for
//! execution (`dispatch`) and may flag it for reconciliation. Consumption is confirmed only by
//! finalized source-receipt evidence: `confirm_with_receipt` reads the configured shared receipt
//! registry's active claim and consumes the obligation only when the claim binds exactly to it. No
//! executor, auditor, scheduler, relayer, operator, verifier or owner can confirm or release a
//! dispatched obligation. The normal build can only release a reservation that was never
//! dispatched: the user or delegate cancels it, or anyone releases it after its expiry. A
//! dispatched obligation is never released by timeout or revocation, and no production path
//! releases it at all (a no-execution proof path is an open decision).
use crate::{
    receipt_binds, AssetKey, BattleScope, Budget, CanonicalAction, Grant, GrantId, Hash,
    ReceiptClaim, ReceiptRef, RegistryKey, Reservation, ReservationState,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

/// Storage deposit required up front by `confirm_with_receipt` (covers the used-receipt marker;
/// the unused part is refunded).
pub const CONFIRM_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(5);
const REGISTRY_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait SharedRegistry {
    fn get_active_claim(&self, key: RegistryKey) -> Option<ReceiptClaim>;
}

/// Default lifetime of an undispatched reservation: 1 hour. Agent choice (owner decision 2026-11-09:
/// expiry exists, length is configurable); recorded as an assumption.
pub const DEFAULT_RESERVATION_TTL_NS: u64 = 3_600_000_000_000;
/// Bounds for the configurable reservation lifetime: 1 minute to 7 days.
pub const MIN_RESERVATION_TTL_NS: u64 = 60_000_000_000;
pub const MAX_RESERVATION_TTL_NS: u64 = 604_800_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Grants,
    GrantVersions,
    Budgets,
    Reservations,
    Receipts,
}

/// Immutable key for a retained historical grant version.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct VersionKey {
    pub grant: Hash,
    pub version: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredGrant {
    pub grant: Grant,
    pub revoked: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PlayerPolicy {
    owner: AccountId,
    /// Shared receipt registry whose finalized claims are the only evidence that consumes an
    /// obligation. Fixed at initialization: no setter exists.
    registry: AccountId,
    /// Only meaningful in the `sandbox-fixtures` build; unused (and unsettable) otherwise.
    executor: Option<AccountId>,
    /// Lifetime applied to new reservations; existing reservations keep their own expiry.
    reservation_ttl_ns: u64,
    grants: LookupMap<Hash, StoredGrant>,
    grant_versions: LookupMap<VersionKey, Grant>,
    budgets: LookupMap<Hash, Budget>,
    reservations: LookupMap<Hash, Reservation>,
    /// Receipts already used to settle an obligation, mapped to that reservation's request key.
    used_receipts: LookupMap<ReceiptRef, Hash>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssetInput {
    pub chain_id: U64,
    pub token: String,
    pub representation: AccountId,
    pub custody_domain: String,
    pub mapping_version: U64,
}

impl From<AssetInput> for AssetKey {
    fn from(a: AssetInput) -> Self {
        AssetKey {
            chain_id: a.chain_id.0,
            token: a.token,
            representation: a.representation,
            custody_domain: a.custody_domain,
            mapping_version: a.mapping_version.0,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BattleInput {
    pub battle_id: U64,
    pub community: Option<u32>,
}

impl From<BattleInput> for BattleScope {
    fn from(b: BattleInput) -> Self {
        BattleScope {
            battle_id: b.battle_id.0,
            community: b.community,
        }
    }
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct GrantInput {
    pub delegate: AccountId,
    pub local_id: Hash,
    pub version: U64,
    pub asset: AssetInput,
    pub contracts: Vec<AccountId>,
    pub methods: Vec<String>,
    pub destinations: Vec<String>,
    pub battle: Option<BattleInput>,
    pub per_action_cap: U128,
    pub cumulative_cap: U128,
    pub gas_cap: U64,
    pub expiry_ns: U64,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct ActionInput {
    /// Lookup key for the grant; authorization is by caller, not by this field.
    pub user: AccountId,
    pub local_id: Hash,
    pub version: U64,
    pub asset: AssetInput,
    pub target: AccountId,
    pub method: String,
    pub destination: String,
    pub amount: U128,
    pub gas: U64,
    pub request_id: Hash,
    pub battle: Option<BattleInput>,
}

#[near(serializers = [json])]
pub struct GrantView {
    pub user: AccountId,
    pub delegate: AccountId,
    pub version: U64,
    pub revoked: bool,
    pub per_action_cap: U128,
    pub cumulative_cap: U128,
    pub gas_cap: U64,
    pub expiry_ns: U64,
}

#[near(serializers = [json])]
pub struct BudgetView {
    pub authorized_limit: U128,
    pub consumed: U128,
    pub reserved: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct ReservationView {
    pub state: ReservationState,
    pub amount: U128,
    pub version: U64,
    pub action_hash: Hash,
    pub expires_ns: U64,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "valtrum_player_policy", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// Charge the caller for storage growth since `before`, refunding any excess. Fails closed if the
/// attached deposit does not cover the growth.
fn charge_storage(before: u64) {
    let bytes = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost()
        .as_yoctonear()
        .checked_mul(u128::from(bytes))
        .expect("Storage cost overflow");
    let attached = env::attached_deposit().as_yoctonear();
    require!(attached >= cost, "Insufficient storage deposit");
    if attached > cost {
        Promise::new(env::predecessor_account_id())
            .transfer(NearToken::from_yoctonear(attached - cost))
            .detach();
    }
}

#[near]
impl PlayerPolicy {
    #[init]
    pub fn new(owner: AccountId, registry: AccountId) -> Self {
        Self {
            owner,
            registry,
            executor: None,
            reservation_ttl_ns: DEFAULT_RESERVATION_TTL_NS,
            grants: LookupMap::new(StorageKey::Grants),
            grant_versions: LookupMap::new(StorageKey::GrantVersions),
            budgets: LookupMap::new(StorageKey::Budgets),
            reservations: LookupMap::new(StorageKey::Reservations),
            used_receipts: LookupMap::new(StorageKey::Receipts),
        }
    }

    /// Create a grant, or add a strictly higher version of an existing one. The user is the caller;
    /// a delegate or stranger can only create grants where they themselves are the user. Old
    /// versions and the shared budget counters are preserved, so a version change cannot reset
    /// unresolved obligations or evade the cumulative cap.
    #[payable]
    pub fn create_grant(&mut self, input: GrantInput) {
        let user = env::predecessor_account_id();
        require!(input.delegate != user, "Delegate must differ from user");
        let grant = Grant {
            user: user.clone(),
            delegate: input.delegate,
            local_id: input.local_id,
            version: input.version.0,
            asset: input.asset.into(),
            contracts: input.contracts,
            methods: input.methods,
            destinations: input.destinations,
            battle: input.battle.map(Into::into),
            per_action_cap: input.per_action_cap.0,
            cumulative_cap: input.cumulative_cap.0,
            gas_cap: input.gas_cap.0,
            expiry_ns: input.expiry_ns.0,
        }
        .validate()
        .unwrap_or_else(|_| env::panic_str("Invalid grant"));
        let id = grant.id().0;
        let before = env::storage_usage();
        if let Some(existing) = self.grants.get(&id) {
            // Revocation is permanent per grant id: a version bump never re-enables it. The user
            // continues with a new local id.
            require!(!existing.revoked, "Grant revoked");
            require!(
                grant.version > existing.grant.version,
                "Grant version must increase"
            );
            require!(
                grant.asset == existing.grant.asset,
                "Grant asset cannot change"
            );
            // Validate the new limit before changing any persisted grant/history entry.
            let mut budget = *self
                .budgets
                .get(&id)
                .unwrap_or_else(|| env::panic_str("Missing budget"));
            budget
                .relimit(grant.cumulative_cap)
                .unwrap_or_else(|_| env::panic_str("Grant cap below existing obligations"));
            let old_key = VersionKey {
                grant: id,
                version: existing.grant.version,
            };
            let old = existing.grant.clone();
            self.grant_versions.insert(old_key, old);
            self.budgets.insert(id, budget);
        } else {
            self.budgets.insert(id, Budget::new(grant.cumulative_cap));
        }
        let version = grant.version;
        self.grants.insert(
            id,
            StoredGrant {
                grant,
                revoked: false,
            },
        );
        self.grants.flush();
        self.grant_versions.flush();
        self.budgets.flush();
        charge_storage(before);
        emit(
            "grant_created",
            json!({"user": user, "grant_id": hex(&id), "version": U64(version)}),
        );
    }

    /// Revoke the caller's own grant. Permanent (no version bump or replacement re-enables it) and
    /// idempotent. Blocks new authorizations; it does not erase or release existing obligations,
    /// which remain attributable. Undispatched reservations can be cancelled or expire.
    #[payable]
    pub fn revoke_grant(&mut self, local_id: Hash) {
        near_sdk::assert_one_yocto();
        let user = env::predecessor_account_id();
        let id = GrantId::derive(&user, &local_id).0;
        let mut stored = self
            .grants
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        if !stored.revoked {
            stored.revoked = true;
            self.grants.insert(id, stored);
            emit("grant_revoked", json!({"user": user, "grant_id": hex(&id)}));
        }
    }

    /// Validate a canonical action against the stored grant and atomically reserve its budget.
    /// Idempotent per request identity: a repeat with the same bound action returns the existing
    /// reservation; a changed action under the same request identity is rejected.
    #[payable]
    pub fn reserve(&mut self, action: ActionInput) {
        let caller = env::predecessor_account_id();
        let id = GrantId::derive(&action.user, &action.local_id).0;
        let stored = self
            .grants
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        require!(
            caller == stored.grant.delegate || caller == stored.grant.user,
            "Not authorized"
        );
        require!(!stored.revoked, "Grant revoked");
        // Canonicalize the action asset (lowercase, validate) so a mixed-case address still matches.
        let asset = AssetKey::from(action.asset)
            .canonicalize()
            .unwrap_or_else(|_| env::panic_str("Invalid asset"));
        let canonical = CanonicalAction {
            user: stored.grant.user.clone(),
            local_id: action.local_id,
            version: action.version.0,
            delegate: stored.grant.delegate.clone(),
            asset,
            target: action.target,
            method: action.method,
            destination: action.destination,
            amount: action.amount.0,
            gas: action.gas.0,
            request_id: action.request_id,
            battle: action.battle.map(Into::into),
        };
        stored
            .grant
            .authorizes(&canonical, env::block_timestamp())
            .unwrap_or_else(|_| env::panic_str("Action not authorized"));
        let request_key = canonical.request_key();
        let action_hash = canonical.action_hash();
        if let Some(existing) = self.reservations.get(&request_key) {
            existing
                .matches(&action_hash)
                .unwrap_or_else(|_| env::panic_str("Conflicting request"));
            require!(
                existing.state != ReservationState::Released,
                "Reservation released; use a new request id"
            );
            require!(
                existing.state != ReservationState::Reserved
                    || env::block_timestamp() < existing.expires_ns,
                "Reservation expired"
            );
            // Idempotent: refund the whole deposit; no new storage or budget charge.
            let deposit = env::attached_deposit();
            if !deposit.is_zero() {
                Promise::new(caller).transfer(deposit).detach();
            }
            return;
        }
        let mut budget = *self
            .budgets
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Missing budget"));
        budget
            .reserve(canonical.amount)
            .unwrap_or_else(|_| env::panic_str("Budget exceeded"));
        let expires_ns = env::block_timestamp()
            .checked_add(self.reservation_ttl_ns)
            .unwrap_or_else(|| env::panic_str("Expiry overflow"));
        let reservation = Reservation {
            battle_id: canonical.battle.map(|b| b.battle_id),
            request_key,
            action_hash,
            grant: id,
            version: canonical.version,
            amount: canonical.amount,
            state: ReservationState::Reserved,
            expires_ns,
        };
        let before = env::storage_usage();
        self.budgets.insert(id, budget);
        self.reservations.insert(request_key, reservation);
        self.budgets.flush();
        self.reservations.flush();
        charge_storage(before);
        emit(
            "budget_reserved",
            json!({
                "user": stored.grant.user,
                "grant_id": hex(&id),
                "request_key": hex(&request_key),
                "amount": U128(canonical.amount),
                "reserved": U128(budget.reserved),
                "consumed": U128(budget.consumed),
                "expires_ns": U64(expires_ns),
            }),
        );
    }

    /// Cancel a reservation that has not been dispatched, restoring its budget. Callable by the
    /// grant's user or its current delegate, also after revocation or expiry. A dispatched or
    /// reconciliation-required obligation is never released here.
    #[payable]
    pub fn cancel_reservation(&mut self, user: AccountId, local_id: Hash, request_id: Hash) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        let (id, mut reservation, mut budget) =
            self.load_reservation(&user, &local_id, &request_id);
        let stored = self
            .grants
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        require!(
            caller == stored.grant.user || caller == stored.grant.delegate,
            "Not authorized"
        );
        let changed = reservation
            .release(&mut budget)
            .unwrap_or_else(|_| env::panic_str("Reservation cannot be cancelled"));
        self.store_release(id, reservation, budget, changed, "cancelled", &user);
    }

    /// Release a reservation that was never dispatched once its expiry has passed. Permissionless:
    /// it only restores unused budget and can never touch a dispatched obligation.
    #[payable]
    pub fn release_expired(&mut self, user: AccountId, local_id: Hash, request_id: Hash) {
        near_sdk::assert_one_yocto();
        let (id, mut reservation, mut budget) =
            self.load_reservation(&user, &local_id, &request_id);
        let changed = reservation
            .expire(&mut budget, env::block_timestamp())
            .unwrap_or_else(|_| env::panic_str("Reservation cannot be released"));
        self.store_release(id, reservation, budget, changed, "expired", &user);
    }

    /// Admit a reserved action for execution. Callable by the grant's user or current delegate.
    /// Current authority (version, revocation, grant expiry, reservation expiry) is re-checked
    /// only at first admission; a repeat is a no-op, so an already dispatched obligation stays
    /// reconcilable after replacement, expiry or revocation. Once dispatched, the reservation can
    /// no longer be cancelled or expired; only receipt evidence resolves it.
    #[payable]
    pub fn dispatch(&mut self, user: AccountId, local_id: Hash, request_id: Hash) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        let (id, mut reservation, _) = self.load_reservation(&user, &local_id, &request_id);
        let stored = self
            .grants
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        require!(
            caller == stored.grant.user || caller == stored.grant.delegate,
            "Not authorized"
        );
        if reservation.state == ReservationState::Reserved {
            require!(
                reservation.version == stored.grant.version,
                "Grant version changed"
            );
            require!(!stored.revoked, "Grant revoked");
            require!(
                env::block_timestamp() < stored.grant.expiry_ns,
                "Grant expired"
            );
        }
        let key = reservation.request_key;
        let changed = reservation
            .dispatch(env::block_timestamp())
            .unwrap_or_else(|_| env::panic_str("Cannot dispatch reservation"));
        if changed {
            self.reservations.insert(key, reservation);
            self.reservations.flush();
            emit(
                "obligation_dispatched",
                json!({"user": user, "grant_id": hex(&id), "request_key": hex(&key)}),
            );
        }
    }

    /// Flag a dispatched obligation whose outcome is unknown. The reservation stays held: this
    /// never restores or consumes budget.
    #[payable]
    pub fn mark_reconciliation(&mut self, user: AccountId, local_id: Hash, request_id: Hash) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        let (id, mut reservation, _) = self.load_reservation(&user, &local_id, &request_id);
        let stored = self
            .grants
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        require!(
            caller == stored.grant.user || caller == stored.grant.delegate,
            "Not authorized"
        );
        let key = reservation.request_key;
        let changed = reservation
            .mark_reconciliation()
            .unwrap_or_else(|_| env::panic_str("Not a dispatched obligation"));
        if changed {
            self.reservations.insert(key, reservation);
            self.reservations.flush();
            emit(
                "reconciliation_required",
                json!({"user": user, "grant_id": hex(&id), "request_key": hex(&key)}),
            );
        }
    }

    /// Consume a dispatched or reconciliation-required obligation with finalized source-receipt
    /// evidence. Permissionless: the caller has no authority; the registry's active (undisputed)
    /// claim for the receipt is. The claim must bind to the obligation's asset, user, battle and
    /// exact amount, and one receipt settles at most one reservation. Any other outcome (claim
    /// missing, disputed, mismatched, registry unavailable) changes nothing and refunds the
    /// deposit. The returned promise resolves to true only when this call consumed.
    #[payable]
    pub fn confirm_with_receipt(
        &mut self,
        user: AccountId,
        local_id: Hash,
        request_id: Hash,
        receipt: ReceiptRef,
    ) -> Promise {
        require!(
            env::attached_deposit() >= CONFIRM_STORAGE_DEPOSIT,
            "Insufficient storage deposit"
        );
        let (id, reservation, _) = self.load_reservation(&user, &local_id, &request_id);
        require!(
            matches!(
                reservation.state,
                ReservationState::Dispatched | ReservationState::ReconciliationRequired
            ),
            "Not an in-flight obligation"
        );
        require!(
            self.used_receipts.get(&receipt).is_none(),
            "Receipt already used"
        );
        let stored = self
            .grants
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Unknown grant"));
        let key = RegistryKey {
            chain_id: U64(stored.grant.asset.chain_id),
            transaction_hash: receipt.transaction_hash,
            log_index: receipt.log_index,
        };
        ext_registry::ext(self.registry.clone())
            .with_static_gas(REGISTRY_GAS)
            .get_active_claim(key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_attached_deposit(env::attached_deposit())
                    .on_receipt_evidence(
                        env::predecessor_account_id(),
                        user,
                        local_id,
                        request_id,
                        receipt,
                    ),
            )
    }

    /// Registry answer for `confirm_with_receipt`. Never panics on bad evidence: it returns false
    /// and refunds the whole deposit. State is re-read here, so two racing confirmations cannot
    /// both consume.
    #[private]
    #[payable]
    pub fn on_receipt_evidence(
        &mut self,
        caller: AccountId,
        user: AccountId,
        local_id: Hash,
        request_id: Hash,
        receipt: ReceiptRef,
        #[callback_result] claim: Result<Option<ReceiptClaim>, PromiseError>,
    ) -> bool {
        let attached = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        let consumed = match claim {
            Ok(Some(claim)) => self.apply_receipt(&user, &local_id, &request_id, &receipt, &claim),
            _ => false,
        };
        let cost = if consumed {
            env::storage_byte_cost()
                .as_yoctonear()
                .checked_mul(u128::from(
                    env::storage_usage()
                        .checked_sub(before)
                        .unwrap_or_else(|| env::panic_str("Storage accounting failed")),
                ))
                .unwrap_or_else(|| env::panic_str("Storage cost overflow"))
        } else {
            0
        };
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        consumed
    }

    /// Owner-only: set the lifetime of future reservations within fixed bounds. It does not change
    /// existing reservations and cannot grant spending authority.
    #[payable]
    pub fn set_reservation_ttl(&mut self, ttl_ns: U64) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        require!(
            (MIN_RESERVATION_TTL_NS..=MAX_RESERVATION_TTL_NS).contains(&ttl_ns.0),
            "TTL out of bounds"
        );
        self.reservation_ttl_ns = ttl_ns.0;
    }

    fn load_reservation(
        &self,
        user: &AccountId,
        local_id: &Hash,
        request_id: &Hash,
    ) -> (Hash, Reservation, Budget) {
        let key = request_lookup(user, local_id, request_id);
        let reservation = self
            .reservations
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown reservation"));
        let budget = *self
            .budgets
            .get(&reservation.grant)
            .unwrap_or_else(|| env::panic_str("Missing budget"));
        (reservation.grant, reservation, budget)
    }

    /// All checks first, then one mutation. Returns true only when the obligation was consumed.
    fn apply_receipt(
        &mut self,
        user: &AccountId,
        local_id: &Hash,
        request_id: &Hash,
        receipt: &ReceiptRef,
        claim: &ReceiptClaim,
    ) -> bool {
        if self.used_receipts.get(receipt).is_some() {
            return false;
        }
        let key = request_lookup(user, local_id, request_id);
        let Some(mut reservation) = self.reservations.get(&key).cloned() else {
            return false;
        };
        let grant_id = reservation.grant;
        let (Some(stored), Some(budget)) =
            (self.grants.get(&grant_id), self.budgets.get(&grant_id))
        else {
            return false;
        };
        let mut budget = *budget;
        if !matches!(
            reservation.state,
            ReservationState::Dispatched | ReservationState::ReconciliationRequired
        ) || receipt_binds(&stored.grant, &reservation, claim).is_err()
            || reservation.consume(&mut budget).is_err()
        {
            return false;
        }
        self.budgets.insert(grant_id, budget);
        self.reservations.insert(key, reservation);
        self.used_receipts.insert(receipt.clone(), key);
        self.budgets.flush();
        self.reservations.flush();
        self.used_receipts.flush();
        emit(
            "obligation_consumed",
            json!({
                "user": user,
                "grant_id": hex(&grant_id),
                "request_key": hex(&key),
                "amount": U128(claim.actual_received.0),
                "transaction_hash": hex(&receipt.transaction_hash),
                "log_index": receipt.log_index,
                "evidence_hash": hex(&claim.evidence_hash),
                "reserved": U128(budget.reserved),
                "consumed": U128(budget.consumed),
            }),
        );
        true
    }

    fn store_release(
        &mut self,
        grant: Hash,
        reservation: Reservation,
        budget: Budget,
        changed: bool,
        reason: &str,
        user: &AccountId,
    ) {
        let key = reservation.request_key;
        let amount = reservation.amount;
        self.budgets.insert(grant, budget);
        self.reservations.insert(key, reservation);
        self.budgets.flush();
        self.reservations.flush();
        if changed {
            emit(
                "reservation_released",
                json!({
                    "user": user,
                    "grant_id": hex(&grant),
                    "request_key": hex(&key),
                    "amount": U128(amount),
                    "reason": reason,
                    "reserved": U128(budget.reserved),
                    "consumed": U128(budget.consumed),
                }),
            );
        }
    }

    // --- Views (bounded, read-only) ---

    pub fn is_receipt_used(&self, receipt: ReceiptRef) -> bool {
        self.used_receipts.get(&receipt).is_some()
    }

    pub fn get_grant(&self, user: AccountId, local_id: Hash) -> Option<GrantView> {
        let id = GrantId::derive(&user, &local_id).0;
        self.grants.get(&id).map(|s| GrantView {
            user: s.grant.user.clone(),
            delegate: s.grant.delegate.clone(),
            version: U64(s.grant.version),
            revoked: s.revoked,
            per_action_cap: U128(s.grant.per_action_cap),
            cumulative_cap: U128(s.grant.cumulative_cap),
            gas_cap: U64(s.grant.gas_cap),
            expiry_ns: U64(s.grant.expiry_ns),
        })
    }

    pub fn get_budget(&self, user: AccountId, local_id: Hash) -> Option<BudgetView> {
        let id = GrantId::derive(&user, &local_id).0;
        self.budgets.get(&id).map(|b| BudgetView {
            authorized_limit: U128(b.authorized_limit),
            consumed: U128(b.consumed),
            reserved: U128(b.reserved),
            available: U128(b.available()),
        })
    }

    pub fn get_reservation(
        &self,
        user: AccountId,
        local_id: Hash,
        request_id: Hash,
    ) -> Option<ReservationView> {
        let canonical = request_lookup(&user, &local_id, &request_id);
        self.reservations.get(&canonical).map(|r| ReservationView {
            state: r.state,
            amount: U128(r.amount),
            version: U64(r.version),
            action_hash: r.action_hash,
            expires_ns: U64(r.expires_ns),
        })
    }

    pub fn fixtures_enabled(&self) -> bool {
        crate::FIXTURES_ENABLED
    }
}

/// Recompute the request key used by `reserve`, for the reservation view.
fn request_lookup(user: &AccountId, local_id: &Hash, request_id: &Hash) -> Hash {
    let action = CanonicalAction {
        user: user.clone(),
        local_id: *local_id,
        version: 0,
        delegate: user.clone(),
        asset: AssetKey {
            chain_id: 1,
            token: String::new(),
            representation: user.clone(),
            custody_domain: String::new(),
            mapping_version: 0,
        },
        target: user.clone(),
        method: String::new(),
        destination: String::new(),
        amount: 0,
        gas: 0,
        request_id: *request_id,
        battle: None,
    };
    action.request_key()
}

fn hex(bytes: &Hash) -> String {
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap_or('0'));
    }
    s
}

/// Fixture-only no-execution adapter. Dispatch, reconciliation flagging and receipt-evidence
/// consumption are production methods; the only thing the normal build deliberately lacks is a way
/// to release a dispatched obligation (no receipt evidence can prove non-execution). This adapter
/// exists to exercise that transition in sandbox tests. Compiled in only under `sandbox-fixtures`;
/// a deployed build has none of these methods. Never deploy it.
#[cfg(feature = "sandbox-fixtures")]
#[near]
impl PlayerPolicy {
    #[payable]
    pub fn set_executor(&mut self, executor: AccountId) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        self.executor = Some(executor);
    }

    /// Release a reconciliation-required obligation as not executed (synthetic proof).
    #[payable]
    pub fn fixture_release_not_executed(
        &mut self,
        user: AccountId,
        local_id: Hash,
        request_id: Hash,
    ) {
        near_sdk::assert_one_yocto();
        let executor = self
            .executor
            .clone()
            .unwrap_or_else(|| env::panic_str("Executor unset"));
        require!(env::predecessor_account_id() == executor, "Only executor");
        let (id, mut reservation, mut budget) =
            self.load_reservation(&user, &local_id, &request_id);
        let changed = reservation
            .reconcile(&mut budget, crate::Resolution::NotExecuted)
            .unwrap_or_else(|_| env::panic_str("Wrong state"));
        self.store_release(
            id,
            reservation,
            budget,
            changed,
            "fixture_not_executed",
            &user,
        );
    }
}
