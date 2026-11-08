//! One NEP-141 representation of one source-chain asset.
//!
//! Minting and source-chain execution are deliberately unavailable until an
//! authenticated receipt verifier and finality policy are integrated.

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
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};

pub mod ledger;
pub mod normalization;
pub mod receipt;
pub mod registry_claim;
pub mod reservation;
pub mod suspension;

use ledger::Ledger;
use registry_claim::{RegistryClaim, RegistryKey};
use suspension::{CustodyAttestation, ResumePolicy, Suspension, SuspensionView};

/// Upper bound on storage a first claim can add (receipt plus two account maps).
const CLAIM_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
const REGISTRY_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const ARENA_GAS: Gas = Gas::from_tgas(10);
/// The first callback schedules the arena lock query and the second callback.
const CLAIM_STAGE_GAS: Gas = Gas::from_tgas(60);

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait SharedRegistry {
    fn get_active_claim(&self, key: RegistryKey) -> Option<RegistryClaim>;
    fn is_disputed(&self, key: RegistryKey) -> bool;
}

/// Subset of the arena's existing `get_lifecycle_battle` view that backing reads.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleLockStatus {
    pub locked: bool,
}

#[ext_contract(ext_arena)]
#[allow(dead_code)]
trait ArenaLifecycle {
    fn get_lifecycle_battle(&self, battle_id: u64) -> Option<BattleLockStatus>;
}

/// A finalized deposit that arrived after its battle locked. It never entered a
/// snapshot or vault and is refundable to `beneficiary` only.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LateDeposit {
    pub battle_id: U64,
    pub beneficiary: AccountId,
    /// EVM address bound at deposit time; the only refund destination for these units (D17).
    pub refund_address: [u8; 20],
    /// Representation units recorded in bucket U.
    pub units: U128,
    /// Sub-unit source residue attributed to the beneficiary.
    pub source_residue: U128,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Receipts,
    Unallocated,
    Residual,
    Reservations,
    ConfirmedDebits,
    Allocations,
    EntitlementBalances,
    Late,
    LateReceipts,
    LateByRefund,
}

/// Identity and precision are immutable for this contract instance.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub chain_id: U64,
    pub token_address: String,
    pub custody_domain: String,
    pub source_decimals: u8,
    pub representation_decimals: u8,
}

#[near(serializers = [json])]
pub struct LedgerView {
    pub custody: U128,
    pub minted: U128,
    pub entitlements: U128,
    pub payouts: U128,
    pub disposal: U128,
    pub unallocated: U128,
    /// Arithmetic consistency only; does not verify current source custody.
    pub accounting_balanced: bool,
    pub paused: bool,
    pub reconciliation_required: bool,
    pub source_residue: U128,
    /// Part of `unallocated` that is a late deposit, refundable only.
    pub late_refundable: U128,
}

/// Locally accounted values in source atomic units, not a live custody proof.
#[near(serializers = [json])]
pub struct CustodyLedgerView {
    pub custody: U128,
    pub minted: U128,
    pub entitlements: U128,
    pub payouts: U128,
    pub disposal: U128,
    pub unallocated: U128,
    pub accounting_balanced: bool,
    pub reconciliation_required: bool,
}

/// Result of reserving a payout: the exact amount in source atomic units that
/// the source-chain transfer must carry.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservedPayout {
    pub created: bool,
    pub source_amount: U128,
}

/// JSON form of a finalized source debit, with amounts as decimal strings.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedDebitInput {
    pub chain_id: U64,
    pub token_address: String,
    pub custody_domain: String,
    pub destination: [u8; 20],
    pub source_amount: U128,
    pub recipient_received: U128,
    pub transaction_hash: [u8; 32],
    pub log_index: u32,
    pub block_hash: [u8; 32],
}

impl From<FinalizedDebitInput> for reservation::FinalizedDebit {
    fn from(value: FinalizedDebitInput) -> Self {
        Self {
            chain_id: value.chain_id.0,
            token_address: value.token_address,
            custody_domain: value.custody_domain,
            destination: value.destination,
            source_amount: value.source_amount.0,
            recipient_received: value.recipient_received.0,
            transaction_hash: value.transaction_hash,
            log_index: value.log_index,
            block_hash: value.block_hash,
        }
    }
}

/// Immutable record of one settlement allocation converted into an entitlement.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allocation {
    pub beneficiary: AccountId,
    pub amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Backing {
    owner: AccountId,
    asset: Asset,
    /// Shared receipt registry and mapping version are immutable instance identity.
    registry: AccountId,
    mapping_version: u64,
    /// The only account allowed to convert its locked representations into entitlements.
    arena: AccountId,
    /// The only account allowed to reserve, confirm or release payouts.
    payout: AccountId,
    paused: bool,
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    ledger: Ledger,
    receipts: LookupMap<receipt::ReceiptId, receipt::Receipt>,
    unallocated_by_account: LookupMap<AccountId, u128>,
    residual_by_account: LookupMap<AccountId, u128>,
    residual_total: u128,
    reconciliation_required: bool,
    reservations: LookupMap<(AccountId, [u8; 32]), reservation::Reservation>,
    confirmed_debits: LookupMap<receipt::ReceiptId, (AccountId, [u8; 32])>,
    allocations: LookupMap<[u8; 32], Allocation>,
    entitlement_balances: LookupMap<AccountId, u128>,
    /// Aggregate of the suspension reasons; liabilities are never touched by it.
    suspension: Suspension,
    resume_policy: ResumePolicy,
    /// Account allowed to attest the custody balance; unset until the owner sets it.
    operator: Option<AccountId>,
    attestation: Option<CustodyAttestation>,
    attestation_sequence: u64,
    late_by_account: LookupMap<AccountId, u128>,
    /// Same units as `late_by_account`, split by the refund address bound at deposit.
    late_by_refund: LookupMap<(AccountId, [u8; 20]), u128>,
    late_total: u128,
    late_receipts: LookupMap<receipt::ReceiptId, LateDeposit>,
}

#[near]
impl Backing {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        asset: Asset,
        name: String,
        symbol: String,
        registry: AccountId,
        mapping_version: U64,
        arena: AccountId,
        payout: AccountId,
    ) -> Self {
        require!(mapping_version.0 > 0, "Invalid mapping version");
        let mut asset = asset;
        require!(asset.chain_id.0 > 0, "Invalid chain ID");
        let address = asset
            .token_address
            .strip_prefix("0x")
            .or_else(|| asset.token_address.strip_prefix("0X"));
        require!(
            address.is_some_and(
                |value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            ),
            "Invalid EVM token address"
        );
        require!(
            address.is_some_and(|value| value.bytes().any(|byte| byte != b'0')),
            "Zero token address"
        );
        asset.token_address = asset.token_address.to_ascii_lowercase();
        require!(
            !asset.custody_domain.trim().is_empty() && asset.custody_domain.len() <= 256,
            "Invalid custody domain"
        );
        require!(
            !name.trim().is_empty()
                && name.len() <= 128
                && !symbol.trim().is_empty()
                && symbol.len() <= 32,
            "Invalid token metadata"
        );
        require!(
            normalization::normalize(0, asset.source_decimals, asset.representation_decimals)
                .is_ok(),
            "Unsupported decimal scale"
        );
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: asset.representation_decimals,
        };
        Self {
            owner,
            asset,
            registry,
            mapping_version: mapping_version.0,
            arena,
            payout,
            paused: false,
            token: FungibleToken::new(StorageKey::Token),
            metadata,
            ledger: Ledger::default(),
            receipts: LookupMap::new(StorageKey::Receipts),
            unallocated_by_account: LookupMap::new(StorageKey::Unallocated),
            residual_by_account: LookupMap::new(StorageKey::Residual),
            residual_total: 0,
            reconciliation_required: false,
            reservations: LookupMap::new(StorageKey::Reservations),
            confirmed_debits: LookupMap::new(StorageKey::ConfirmedDebits),
            allocations: LookupMap::new(StorageKey::Allocations),
            entitlement_balances: LookupMap::new(StorageKey::EntitlementBalances),
            suspension: Suspension::default(),
            resume_policy: ResumePolicy::default(),
            operator: None,
            attestation: None,
            attestation_sequence: 0,
            late_by_account: LookupMap::new(StorageKey::Late),
            late_by_refund: LookupMap::new(StorageKey::LateByRefund),
            late_total: 0,
            late_receipts: LookupMap::new(StorageKey::LateReceipts),
        }
    }

    /// Pull a registry-attested, finalized receipt into attributed unallocated
    /// custody. Anyone may call; the registry claim is the only authority and
    /// credits only the claim's beneficiary. The attached deposit pays storage
    /// and the unused part is refunded.
    #[payable]
    pub fn claim_receipt(&mut self, transaction_hash: String, log_index: u32) -> Promise {
        require!(
            !self.paused && !self.reconciliation_required,
            "Asset paused"
        );
        require!(
            env::attached_deposit() >= CLAIM_STORAGE_DEPOSIT,
            "Insufficient storage deposit"
        );
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &transaction_hash, log_index)
            .unwrap_or_else(|_| env::panic_str("Invalid receipt hash"));
        let key = RegistryKey {
            chain_id: self.asset.chain_id,
            transaction_hash: id.transaction_hash,
            log_index,
        };
        ext_registry::ext(self.registry.clone())
            .with_static_gas(REGISTRY_GAS)
            .get_active_claim(key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CLAIM_STAGE_GAS)
                    .with_attached_deposit(env::attached_deposit())
                    .on_claim_receipt(env::predecessor_account_id(), transaction_hash, log_index),
            )
    }

    /// Stage one: validate the registry claim against this asset, then ask the
    /// arena whether the claim's battle is locked. Every other outcome
    /// (unavailable, disputed, mismatched, suspended) credits nothing and
    /// refunds the full deposit to the caller.
    #[private]
    #[payable]
    pub fn on_claim_receipt(
        &mut self,
        caller: AccountId,
        transaction_hash: String,
        log_index: u32,
        #[callback_result] claim: Result<Option<RegistryClaim>, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let attached = env::attached_deposit();
        if let (Ok(Some(claim)), false) = (claim, self.paused || self.reconciliation_required) {
            if self.claim_is_creditable(&transaction_hash, log_index, &claim) {
                return PromiseOrValue::Promise(
                    ext_arena::ext(self.arena.clone())
                        .with_static_gas(ARENA_GAS)
                        .get_lifecycle_battle(claim.battle_id.0)
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(CALLBACK_GAS)
                                .with_attached_deposit(attached)
                                .on_claim_lock_status(caller, transaction_hash, log_index, claim),
                        ),
                );
            }
        }
        if attached.as_yoctonear() > 0 {
            Promise::new(caller).transfer(attached).detach();
        }
        PromiseOrValue::Value(false)
    }

    /// Stage two. Returns true only when this call credited new custody. A
    /// battle that is unknown or whose lock state is unavailable fails closed.
    /// A locked battle records the deposit as a late deposit (bucket U, refund
    /// only); an open battle credits ordinary attributed custody.
    #[private]
    #[payable]
    pub fn on_claim_lock_status(
        &mut self,
        caller: AccountId,
        transaction_hash: String,
        log_index: u32,
        claim: RegistryClaim,
        #[callback_result] battle: Result<Option<BattleLockStatus>, PromiseError>,
    ) -> bool {
        let attached = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        let credited = match (battle, self.paused || self.reconciliation_required) {
            (Ok(Some(status)), false) => {
                self.apply_registry_claim(&transaction_hash, log_index, &claim, status.locked)
            }
            _ => false,
        };
        let cost = if credited {
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
        credited
    }

    /// Pull a registry dispute into this asset. Anyone may call; only a
    /// registry-confirmed dispute of a receipt this contract credited pauses the
    /// asset and requires reconciliation. Liabilities are retained, and there is
    /// no automatic reversal or unpause.
    pub fn report_registry_dispute(&mut self, transaction_hash: String, log_index: u32) -> Promise {
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &transaction_hash, log_index)
            .unwrap_or_else(|_| env::panic_str("Invalid receipt hash"));
        let key = RegistryKey {
            chain_id: self.asset.chain_id,
            transaction_hash: id.transaction_hash,
            log_index,
        };
        ext_registry::ext(self.registry.clone())
            .with_static_gas(REGISTRY_GAS)
            .is_disputed(key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_registry_dispute(transaction_hash, log_index),
            )
    }

    /// Returns true only when this call newly paused the asset.
    #[private]
    pub fn on_registry_dispute(
        &mut self,
        transaction_hash: String,
        log_index: u32,
        #[callback_result] disputed: Result<bool, PromiseError>,
    ) -> bool {
        let Ok(id) =
            receipt::ReceiptId::from_hex(self.asset.chain_id.0, &transaction_hash, log_index)
        else {
            return false;
        };
        if disputed != Ok(true) {
            return false;
        }
        let fresh = !self.suspension.reorg;
        self.reorganize_receipt(&id).is_ok() && fresh
    }

    /// Settlement hand-off. Only the configured arena may call it: the
    /// arena's locked representations are burned and the same backing becomes an
    /// asset-bound entitlement for `beneficiary`. Idempotent per `allocation_id`;
    /// a repeat with different data fails. Returns true only on first execution.
    #[payable]
    pub fn allocate_entitlement(
        &mut self,
        allocation_id: [u8; 32],
        beneficiary: AccountId,
        amount: U128,
    ) -> bool {
        require!(env::predecessor_account_id() == self.arena, "Only arena");
        require!(
            !self.paused && !self.reconciliation_required,
            "Asset paused"
        );
        require!(
            allocation_id != [0; 32] && amount.0 > 0,
            "Invalid allocation"
        );
        let requested = Allocation {
            beneficiary: beneficiary.clone(),
            amount,
        };
        if let Some(existing) = self.allocations.get(&allocation_id) {
            require!(existing == &requested, "Conflicting allocation");
            return false;
        }
        require!(
            self.ledger.minted == self.token.total_supply,
            "Supply mismatch"
        );
        let held = self
            .token
            .accounts
            .get(&self.arena)
            .unwrap_or_else(|| env::panic_str("Arena not registered"));
        require!(held >= amount.0, "Insufficient locked representation");
        let available = self
            .entitlement_balances
            .get(&beneficiary)
            .copied()
            .unwrap_or(0)
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Entitlement overflow"));
        let mut ledger = self.ledger.clone();
        ledger
            .move_liability(
                ledger::Bucket::Minted,
                ledger::Bucket::Entitlements,
                amount.0,
            )
            .unwrap_or_else(|_| env::panic_str("Invalid ledger transition"));
        let storage_before = env::storage_usage();
        let arena = self.arena.clone();
        self.token.internal_withdraw(&arena, amount.0);
        self.ledger = ledger;
        self.allocations.insert(allocation_id, requested);
        self.entitlement_balances.insert(beneficiary, available);
        self.allocations.flush();
        self.entitlement_balances.flush();
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(
                env::storage_usage().saturating_sub(storage_before),
            ))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
        FtBurn {
            owner_id: &arena,
            amount,
            memo: Some("settlement entitlement"),
        }
        .emit();
        true
    }

    pub fn entitlement_of(&self, account: AccountId) -> U128 {
        U128(
            self.entitlement_balances
                .get(&account)
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_allocation(&self, allocation_id: [u8; 32]) -> Option<Allocation> {
        self.allocations.get(&allocation_id).cloned()
    }

    /// Payout hand-off, callable only by the payout account fixed at
    /// initialization. Reserves part of `beneficiary`'s entitlement for one
    /// original-token payout. The payout contract must have authenticated that
    /// the beneficiary asked for it. Returns false for an identical repeat.
    pub fn reserve_payout(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        amount: U128,
        destination: [u8; 20],
    ) -> ReservedPayout {
        self.assert_payout_authority();
        let created = self
            .reserve_entitlement(beneficiary.clone(), request_id, amount.0, destination)
            .unwrap_or_else(|error| env::panic_str(&format!("Reservation rejected: {error:?}")));
        let source_amount = self
            .reservations
            .get(&(beneficiary, request_id))
            .map(|item| item.source_amount)
            .unwrap_or_else(|| env::panic_str("Reservation missing"));
        ReservedPayout {
            created,
            source_amount: U128(source_amount),
        }
    }

    /// Consume a payout reservation after the payout authority has verified a
    /// matching finalized debit. Exactly-once; a repeat returns false.
    pub fn confirm_payout(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        evidence: FinalizedDebitInput,
    ) -> bool {
        self.assert_payout_authority();
        self.confirm_payout_reservation(beneficiary, request_id, evidence.into())
            .unwrap_or_else(|error| env::panic_str(&format!("Confirmation rejected: {error:?}")))
    }

    /// Return a payout reservation to the entitlement after the payout
    /// authority has proven no executable spend remains. A repeat returns false.
    pub fn release_payout(&mut self, beneficiary: AccountId, request_id: [u8; 32]) -> bool {
        self.assert_payout_authority();
        self.release_payout_reservation(beneficiary, request_id)
            .unwrap_or_else(|error| env::panic_str(&format!("Release rejected: {error:?}")))
    }

    /// Lifecycle of a payout reservation: reserved, broadcast, confirmed or released.
    pub fn payout_reservation_status(
        &self,
        beneficiary: AccountId,
        request_id: [u8; 32],
    ) -> Option<String> {
        use reservation::ReservationStatus;
        let item = self.reservations.get(&(beneficiary, request_id))?;
        if !matches!(
            item.kind,
            reservation::ReservationKind::Payout | reservation::ReservationKind::Refund
        ) {
            return None;
        }
        Some(
            match item.status {
                ReservationStatus::Reserved => "reserved",
                ReservationStatus::Broadcast { .. } => "broadcast",
                ReservationStatus::Confirmed { .. } => "confirmed",
                ReservationStatus::Released => "released",
            }
            .to_string(),
        )
    }

    /// The owner can halt affected transfers; this does not alter liabilities.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        require!(
            paused || !self.reconciliation_required,
            "Reconciliation required"
        );
        self.paused = paused;
    }

    /// Convert the caller's attributed finalized custody into representation
    /// units. The beneficiary must already be registered for FT storage.
    #[payable]
    pub fn claim_representation(&mut self, beneficiary: AccountId, amount: U128) {
        near_sdk::assert_one_yocto();
        require!(
            !self.paused && !self.reconciliation_required,
            "Asset paused"
        );
        require!(amount.0 > 0, "Amount must be positive");
        let caller = env::predecessor_account_id();
        let held = self
            .unallocated_by_account
            .get(&caller)
            .copied()
            .unwrap_or(0);
        let remaining = held
            .checked_sub(amount.0)
            .unwrap_or_else(|| env::panic_str("Insufficient attributed custody"));
        let beneficiary_balance = self
            .token
            .accounts
            .get(&beneficiary)
            .unwrap_or_else(|| env::panic_str("Beneficiary not registered"));
        require!(
            beneficiary_balance.checked_add(amount.0).is_some(),
            "Balance overflow"
        );
        require!(
            self.token.total_supply.checked_add(amount.0).is_some(),
            "Supply overflow"
        );
        require!(
            self.ledger.minted == self.token.total_supply,
            "Supply mismatch"
        );
        let mut ledger = self.ledger.clone();
        ledger
            .move_liability(
                ledger::Bucket::Unallocated,
                ledger::Bucket::Minted,
                amount.0,
            )
            .unwrap_or_else(|_| env::panic_str("Invalid ledger transition"));
        self.token.internal_deposit(&beneficiary, amount.0);
        self.unallocated_by_account.insert(caller, remaining);
        self.ledger = ledger;
        FtMint {
            owner_id: &beneficiary,
            amount,
            memo: Some("backed custody claim"),
        }
        .emit();
    }

    /// Owner-only. Sets the account allowed to attest the custody balance.
    /// `None` removes the operator, so no attestation is accepted.
    #[payable]
    pub fn set_operator(&mut self, operator: Option<AccountId>) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        suspension::emit(
            "operator_changed",
            near_sdk::serde_json::json!({
                "old": self.operator,
                "new": operator,
                "by": self.owner,
            }),
        );
        self.operator = operator;
    }

    /// Owner-only, exactly one yocto, every change emits an event. The policy
    /// decides how a reorg or deficit suspension can be lifted.
    #[payable]
    pub fn set_resume_policy(&mut self, policy: ResumePolicy) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        suspension::emit(
            "resume_policy_changed",
            near_sdk::serde_json::json!({
                "old": self.resume_policy,
                "new": policy,
                "by": self.owner,
            }),
        );
        self.resume_policy = policy;
    }

    /// Operator attestation of the custody balance (source atomic units) at a
    /// finalized source block. A balance below the ledger liabilities
    /// (B = M + E + P + D + U, plus attributed residue) suspends the asset.
    /// A covering attestation lifts a reorg or deficit suspension only under
    /// the `Automatic` policy. Source blocks must strictly increase. Returns
    /// whether the balance covers the liabilities. Liabilities are never changed.
    #[payable]
    pub fn attest_custody_balance(
        &mut self,
        source_block_number: U64,
        source_block_hash: [u8; 32],
        finalized_head_number: U64,
        finalized_head_hash: [u8; 32],
        balance: U128,
        evidence_hash: [u8; 32],
    ) -> bool {
        near_sdk::assert_one_yocto();
        require!(
            self.operator.as_ref() == Some(&env::predecessor_account_id()),
            "Only operator"
        );
        require!(
            source_block_hash != [0; 32]
                && finalized_head_hash != [0; 32]
                && evidence_hash != [0; 32]
                && source_block_number.0 <= finalized_head_number.0
                && (source_block_number.0 != finalized_head_number.0
                    || source_block_hash == finalized_head_hash),
            "Invalid attestation"
        );
        if let Some(last) = &self.attestation {
            if last.source_block_number.0 == source_block_number.0 {
                require!(
                    last.source_block_hash == source_block_hash
                        && last.balance == balance
                        && last.finalized_head_number == finalized_head_number
                        && last.finalized_head_hash == finalized_head_hash
                        && last.evidence_hash == evidence_hash,
                    "Conflicting attestation"
                );
                return last.covered;
            }
            require!(
                source_block_number.0 > last.source_block_number.0,
                "Stale attestation"
            );
        }
        let sequence = self
            .attestation_sequence
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Sequence overflow"));
        let required = self.required_source_units();
        let covered = self.ledger.is_balanced() && required.is_some_and(|need| balance.0 >= need);
        self.attestation_sequence = sequence;
        self.attestation = Some(CustodyAttestation {
            sequence: U64(sequence),
            source_block_number,
            source_block_hash,
            finalized_head_number,
            finalized_head_hash,
            balance,
            evidence_hash,
            required: U128(required.unwrap_or(u128::MAX)),
            covered,
        });
        suspension::emit(
            "custody_attested",
            near_sdk::serde_json::json!({
                "sequence": sequence.to_string(),
                "source_block_number": source_block_number,
                "balance": balance,
                "required": required.map(|need| need.to_string()),
                "covered": covered,
            }),
        );
        if !covered {
            if !self.suspension.deficit {
                self.suspension.deficit = true;
                suspension::emit(
                    "asset_suspended",
                    near_sdk::serde_json::json!({ "reason": "deficit" }),
                );
            }
            self.suspension.since_attestation = sequence;
            self.sync_suspension();
        } else if self.resume_policy == ResumePolicy::Automatic
            && self.suspension.evidence_liftable()
        {
            self.lift_evidence_reasons("automatic");
        }
        covered
    }

    /// Owner-only resume under `OwnerWithEvidence`: lifts a reorg or deficit
    /// suspension once an attestation made after the suspension shows the
    /// custody balance still covers every liability. Unresolved reconciliation
    /// of a reservation is not lifted here. Returns true when nothing remains
    /// suspended.
    #[payable]
    pub fn resume(&mut self) -> bool {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        require!(
            self.resume_policy == ResumePolicy::OwnerWithEvidence,
            "Resume policy does not allow owner resume"
        );
        require!(self.suspension.evidence_liftable(), "Nothing to resume");
        require!(
            self.attestation_covers_now(),
            "Covering attestation required"
        );
        self.lift_evidence_reasons("owner");
        !self.reconciliation_required
    }

    /// Payout-authority only. Marks a reservation whose spend cannot be
    /// determined (lost callback, conflicting evidence) as unresolved, which
    /// suspends the asset until the reservation is confirmed or released.
    /// Attach exactly one yocto. Returns false if it was already unresolved.
    #[payable]
    pub fn report_unresolved_reconciliation(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
    ) -> bool {
        near_sdk::assert_one_yocto();
        self.assert_payout_authority();
        self.mark_unresolved(holder, request_id)
            .unwrap_or_else(|error| env::panic_str(&format!("Report rejected: {error:?}")))
    }

    /// Payout-authority only. Reserves part of a late deposit for refund to its
    /// beneficiary on the source chain. Same identity, confirmation and release
    /// path as `reserve_payout`; `confirm_payout` consumes it and `release_payout`
    /// returns it to the late balance. Attach exactly one yocto.
    #[payable]
    pub fn reserve_late_refund(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        amount: U128,
        destination: [u8; 20],
    ) -> ReservedPayout {
        near_sdk::assert_one_yocto();
        self.assert_payout_authority();
        let created = self
            .reserve_late(beneficiary.clone(), request_id, amount.0, destination)
            .unwrap_or_else(|error| env::panic_str(&format!("Refund rejected: {error:?}")));
        let source_amount = self
            .reservations
            .get(&(beneficiary, request_id))
            .map(|item| item.source_amount)
            .unwrap_or_else(|| env::panic_str("Reservation missing"));
        ReservedPayout {
            created,
            source_amount: U128(source_amount),
        }
    }

    pub fn late_balance_of(&self, account: AccountId) -> U128 {
        U128(self.late_by_account.get(&account).copied().unwrap_or(0))
    }

    /// Late units refundable to one bound refund address of `account`.
    pub fn late_balance_of_refund(&self, account: AccountId, refund_address: [u8; 20]) -> U128 {
        U128(
            self.late_by_refund
                .get(&(account, refund_address))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_late_deposit(
        &self,
        transaction_hash: String,
        log_index: u32,
    ) -> Option<LateDeposit> {
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &transaction_hash, log_index)
            .ok()?;
        self.late_receipts.get(&id).cloned()
    }

    pub fn get_suspension(&self) -> SuspensionView {
        SuspensionView {
            suspended: self.reconciliation_required,
            reorg: self.suspension.reorg,
            deficit: self.suspension.deficit,
            unresolved: U64(self.suspension.unresolved),
            since_attestation: U64(self.suspension.since_attestation),
            resume_policy: self.resume_policy,
            operator: self.operator.clone(),
            last_attestation: self.attestation.clone(),
        }
    }

    pub fn unallocated_balance_of(&self, account: AccountId) -> U128 {
        U128(
            self.unallocated_by_account
                .get(&account)
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn source_residue_of(&self, account: AccountId) -> U128 {
        U128(self.residual_by_account.get(&account).copied().unwrap_or(0))
    }

    pub fn get_asset(&self) -> Asset {
        self.asset.clone()
    }
    pub fn get_ledger(&self) -> LedgerView {
        LedgerView {
            custody: U128(self.ledger.custody),
            minted: U128(self.ledger.minted),
            entitlements: U128(self.ledger.entitlements),
            payouts: U128(self.ledger.payouts),
            disposal: U128(self.ledger.disposal),
            unallocated: U128(self.ledger.unallocated),
            accounting_balanced: self.ledger.is_balanced()
                && self.ledger.minted == self.token.total_supply,
            paused: self.transfers_halted(),
            reconciliation_required: self.reconciliation_required,
            source_residue: U128(self.residual_total),
            late_refundable: U128(self.late_total),
        }
    }

    /// Returns None when a liability bucket cannot be represented exactly in
    /// source atomic units. Residual source units belong to unallocated custody.
    pub fn get_custody_ledger(&self) -> Option<CustodyLedgerView> {
        let convert = |amount| {
            normalization::to_source_exact(
                amount,
                self.asset.source_decimals,
                self.asset.representation_decimals,
            )
            .ok()
        };
        let custody = convert(self.ledger.custody)?.checked_add(self.residual_total)?;
        let minted = convert(self.ledger.minted)?;
        let entitlements = convert(self.ledger.entitlements)?;
        let payouts = convert(self.ledger.payouts)?;
        let disposal = convert(self.ledger.disposal)?;
        let unallocated = convert(self.ledger.unallocated)?.checked_add(self.residual_total)?;
        let total = minted
            .checked_add(entitlements)?
            .checked_add(payouts)?
            .checked_add(disposal)?
            .checked_add(unallocated)?;
        Some(CustodyLedgerView {
            custody: U128(custody),
            minted: U128(minted),
            entitlements: U128(entitlements),
            payouts: U128(payouts),
            disposal: U128(disposal),
            unallocated: U128(unallocated),
            accounting_balanced: total == custody && self.ledger.minted == self.token.total_supply,
            reconciliation_required: self.reconciliation_required,
        })
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Rust-only adapter boundary. These methods are not exported as contract
/// entry points and do not by themselves authenticate a verifier or prove
/// finality. Future adapters must establish both before calling them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiptProcessingError {
    WrongChain,
    InvalidReceipt,
    ConflictingReceipt,
    MissingReceipt,
    InvalidTransition,
    Paused,
    Overflow,
}

impl Backing {
    fn claim_is_creditable(
        &self,
        transaction_hash: &str,
        log_index: u32,
        claim: &RegistryClaim,
    ) -> bool {
        receipt::ReceiptId::from_hex(self.asset.chain_id.0, transaction_hash, log_index).is_ok()
            && registry_claim::matches_asset(
                claim,
                &self.asset,
                &env::current_account_id(),
                self.mapping_version,
            )
    }

    /// `late` is true when the claim's battle was already locked: the deposit
    /// is then recorded as unattributed and refundable only.
    fn apply_registry_claim(
        &mut self,
        transaction_hash: &str,
        log_index: u32,
        claim: &RegistryClaim,
        late: bool,
    ) -> bool {
        if !self.claim_is_creditable(transaction_hash, log_index, claim) {
            return false;
        }
        let Ok(id) =
            receipt::ReceiptId::from_hex(self.asset.chain_id.0, transaction_hash, log_index)
        else {
            return false;
        };
        let candidate = receipt::Receipt {
            id: id.clone(),
            beneficiary: claim.beneficiary.clone(),
            refund_address: claim.refund_address,
            actual_source_amount: claim.actual_received.0,
            source_block_hash: claim.block_hash,
            status: receipt::ReceiptStatus::Provisional,
        };
        let late = late.then_some(claim.battle_id.0);
        self.observe_receipt(candidate).is_ok() && self.finalize_receipt_as(&id, late) == Ok(true)
    }

    pub fn observe_receipt(
        &mut self,
        candidate: receipt::Receipt,
    ) -> Result<bool, ReceiptProcessingError> {
        use receipt::ReceiptStatus;
        if self.paused || self.reconciliation_required {
            return Err(ReceiptProcessingError::Paused);
        }
        if candidate.id.chain_id != self.asset.chain_id.0 {
            return Err(ReceiptProcessingError::WrongChain);
        }
        if candidate.status != ReceiptStatus::Provisional
            || candidate.actual_source_amount == 0
            || candidate.id.transaction_hash == [0; 32]
            || candidate.source_block_hash == [0; 32]
        {
            return Err(ReceiptProcessingError::InvalidReceipt);
        }
        if let Some(existing) = self.receipts.get(&candidate.id) {
            return if existing.id == candidate.id
                && existing.beneficiary == candidate.beneficiary
                && existing.refund_address == candidate.refund_address
                && existing.actual_source_amount == candidate.actual_source_amount
                && existing.source_block_hash == candidate.source_block_hash
            {
                Ok(false)
            } else {
                Err(ReceiptProcessingError::ConflictingReceipt)
            };
        }
        self.receipts.insert(candidate.id.clone(), candidate);
        Ok(true)
    }

    /// Credit verified finalized actual-received units once. Source residue is
    /// attributed separately and is never rounded into representation units.
    pub fn finalize_receipt(
        &mut self,
        id: &receipt::ReceiptId,
    ) -> Result<bool, ReceiptProcessingError> {
        self.finalize_receipt_as(id, None)
    }

    /// `late` carries the battle id of a deposit that arrived after lock. Such
    /// units go to the refund-only late balance, never to claimable custody.
    fn finalize_receipt_as(
        &mut self,
        id: &receipt::ReceiptId,
        late: Option<u64>,
    ) -> Result<bool, ReceiptProcessingError> {
        if self.paused || self.reconciliation_required {
            return Err(ReceiptProcessingError::Paused);
        }
        let mut item = self
            .receipts
            .get(id)
            .cloned()
            .ok_or(ReceiptProcessingError::MissingReceipt)?;
        let fresh = item
            .finalize()
            .map_err(|_| ReceiptProcessingError::InvalidTransition)?;
        if !fresh {
            return Ok(false);
        }
        let normalized = normalization::normalize(
            item.actual_source_amount,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .map_err(|_| ReceiptProcessingError::Overflow)?;
        let account = item.beneficiary.clone();
        let tracked = if late.is_some() {
            &self.late_by_account
        } else {
            &self.unallocated_by_account
        };
        let unallocated = tracked
            .get(&account)
            .copied()
            .unwrap_or(0)
            .checked_add(normalized.representation_units)
            .ok_or(ReceiptProcessingError::Overflow)?;
        let late_total = self
            .late_total
            .checked_add(if late.is_some() {
                normalized.representation_units
            } else {
                0
            })
            .ok_or(ReceiptProcessingError::Overflow)?;
        let residue = self
            .residual_by_account
            .get(&account)
            .copied()
            .unwrap_or(0)
            .checked_add(normalized.source_residue)
            .ok_or(ReceiptProcessingError::Overflow)?;
        let residue_total = self
            .residual_total
            .checked_add(normalized.source_residue)
            .ok_or(ReceiptProcessingError::Overflow)?;
        let mut ledger = self.ledger.clone();
        if normalized.representation_units > 0 {
            ledger
                .add_receipt(normalized.representation_units)
                .map_err(|_| ReceiptProcessingError::Overflow)?;
        }
        if normalized.representation_units > 0 {
            if late.is_some() {
                let by_refund = self
                    .late_by_refund
                    .get(&(account.clone(), item.refund_address))
                    .copied()
                    .unwrap_or(0)
                    .checked_add(normalized.representation_units)
                    .ok_or(ReceiptProcessingError::Overflow)?;
                self.late_by_refund
                    .insert((account.clone(), item.refund_address), by_refund);
                self.late_by_account.insert(account.clone(), unallocated);
            } else {
                self.unallocated_by_account
                    .insert(account.clone(), unallocated);
            }
        }
        if let Some(battle_id) = late {
            self.late_total = late_total;
            self.late_receipts.insert(
                id.clone(),
                LateDeposit {
                    battle_id: U64(battle_id),
                    beneficiary: account.clone(),
                    refund_address: item.refund_address,
                    units: U128(normalized.representation_units),
                    source_residue: U128(normalized.source_residue),
                },
            );
            suspension::emit(
                "late_deposit_recorded",
                near_sdk::serde_json::json!({
                    "battle_id": battle_id.to_string(),
                    "beneficiary": account,
                    "refund_address": format!("0x{}", hex_lower(&item.refund_address)),
                    "units": normalized.representation_units.to_string(),
                }),
            );
        }
        if normalized.source_residue > 0 {
            self.residual_by_account.insert(account, residue);
        }
        self.residual_total = residue_total;
        self.ledger = ledger;
        self.receipts.insert(id.clone(), item);
        Ok(true)
    }

    /// Internal reservation primitive. The caller must authenticate the holder
    /// for redemption or an explicitly designed DAO for disposal. There is no
    /// public entry point until those authorization and payout interfaces exist.
    pub fn reserve_representation(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        amount: u128,
        kind: reservation::ReservationKind,
        destination: [u8; 20],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{Reservation, ReservationError, ReservationKind, ReservationStatus};
        if self.paused || self.reconciliation_required {
            return Err(ReservationError::Paused);
        }
        if amount == 0 {
            return Err(ReservationError::ZeroAmount);
        }
        if destination == [0; 20] {
            return Err(ReservationError::InvalidDestination);
        }
        let source_amount = normalization::to_source_exact(
            amount,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .map_err(|_| ReservationError::UnrepresentableAmount)?;
        let key = (holder.clone(), request_id);
        if let Some(existing) = self.reservations.get(&key) {
            return if existing.amount == amount
                && existing.kind == kind
                && existing.destination == destination
            {
                Ok(false)
            } else {
                Err(ReservationError::ConflictingRequest)
            };
        }
        let balance = self
            .token
            .accounts
            .get(&holder)
            .ok_or(ReservationError::UnknownHolder)?;
        if balance < amount {
            return Err(ReservationError::InsufficientBalance);
        }
        if self.token.total_supply != self.ledger.minted {
            return Err(ReservationError::InvalidLedger);
        }
        let target = match kind {
            ReservationKind::Redemption => ledger::Bucket::Payouts,
            ReservationKind::Disposal => ledger::Bucket::Disposal,
            ReservationKind::Payout | ReservationKind::Refund => {
                return Err(ReservationError::WrongKind)
            }
        };
        let mut next = self.ledger.clone();
        next.move_liability(ledger::Bucket::Minted, target, amount)
            .map_err(|_| ReservationError::InvalidLedger)?;
        self.token.internal_withdraw(&holder, amount);
        FtBurn {
            owner_id: &holder,
            amount: U128(amount),
            memo: Some("backing reservation"),
        }
        .emit();
        self.ledger = next;
        self.reservations.insert(
            key,
            Reservation {
                request_id,
                holder,
                amount,
                source_amount,
                destination,
                kind,
                status: ReservationStatus::Reserved,
                unresolved: false,
            },
        );
        Ok(true)
    }

    /// Internal-only. Reserve part of a beneficiary's settlement entitlement for
    /// one original-token payout, removing it from the available entitlement
    /// before any signature is requested. A caller must authenticate the
    /// beneficiary (or a bounded delegate) and bind the destination; a
    /// reservation is never released by timeout or a missing response.
    pub fn reserve_entitlement(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        amount: u128,
        destination: [u8; 20],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{Reservation, ReservationError, ReservationKind, ReservationStatus};
        if self.paused || self.reconciliation_required {
            return Err(ReservationError::Paused);
        }
        if amount == 0 {
            return Err(ReservationError::ZeroAmount);
        }
        if destination == [0; 20] || request_id == [0; 32] {
            return Err(ReservationError::InvalidDestination);
        }
        let source_amount = normalization::to_source_exact(
            amount,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .map_err(|_| ReservationError::UnrepresentableAmount)?;
        let key = (beneficiary.clone(), request_id);
        if let Some(existing) = self.reservations.get(&key) {
            return if existing.amount == amount
                && existing.kind == ReservationKind::Payout
                && existing.destination == destination
            {
                Ok(false)
            } else {
                Err(ReservationError::ConflictingRequest)
            };
        }
        let available = self
            .entitlement_balances
            .get(&beneficiary)
            .copied()
            .ok_or(ReservationError::UnknownHolder)?;
        let remaining = available
            .checked_sub(amount)
            .ok_or(ReservationError::InsufficientBalance)?;
        let mut next = self.ledger.clone();
        next.move_liability(
            ledger::Bucket::Entitlements,
            ledger::Bucket::Payouts,
            amount,
        )
        .map_err(|_| ReservationError::InvalidLedger)?;
        self.entitlement_balances
            .insert(beneficiary.clone(), remaining);
        self.ledger = next;
        self.reservations.insert(
            key,
            Reservation {
                request_id,
                holder: beneficiary,
                amount,
                source_amount,
                destination,
                kind: ReservationKind::Payout,
                status: ReservationStatus::Reserved,
                unresolved: false,
            },
        );
        Ok(true)
    }

    /// Internal-only evidence recording. A broadcast is not proof of execution;
    /// there is deliberately no timeout-based release or automatic restore.
    pub fn record_reservation_broadcast(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        transaction_hash: [u8; 32],
    ) -> Result<bool, reservation::ReservationError> {
        let key = (holder, request_id);
        let mut reservation = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(reservation::ReservationError::MissingReservation)?;
        let changed = reservation.record_broadcast(transaction_hash)?;
        if changed {
            self.reservations.insert(key, reservation);
        }
        Ok(changed)
    }

    fn assert_payout_authority(&self) {
        require!(
            env::predecessor_account_id() == self.payout,
            "Only payout authority"
        );
    }

    /// Confirm a payout or late-refund reservation. The payout authority has
    /// already verified that the evidence names one of its signed attempts, so a
    /// replacement transaction may differ from the hash recorded earlier; every
    /// other check is the redemption confirmation's.
    pub fn confirm_payout_reservation(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        evidence: reservation::FinalizedDebit,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::ReservationKind;
        self.confirm_debit_evidence(
            (beneficiary, request_id),
            evidence,
            &[ReservationKind::Payout, ReservationKind::Refund],
            true,
        )
    }

    /// Return a payout or late-refund reservation to its source balance (the
    /// entitlement, or the late balance). The caller must have proven that no
    /// executable source-chain spend remains. Allowed while the asset is
    /// suspended: it moves a liability between buckets and creates no spend.
    pub fn release_payout_reservation(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::ReservationKind;
        self.release_reservation_core(
            (beneficiary, request_id),
            &[ReservationKind::Payout, ReservationKind::Refund],
        )
    }

    /// Internal-only. Restores a redemption or disposal reservation as
    /// representation units after definitive no-spend proof. No authority is
    /// defined for it yet (DAO is OPEN), so it is not an entry point.
    pub fn release_unspent_reservation(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::ReservationKind;
        self.release_reservation_core(
            (holder, request_id),
            &[ReservationKind::Redemption, ReservationKind::Disposal],
        )
    }

    /// Apply an authenticated finalized redemption or payout debit exactly once.
    /// This internal method validates binding but cannot itself prove finality.
    /// It works while the asset is suspended: a real debit must be recorded.
    pub fn confirm_redemption(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        evidence: reservation::FinalizedDebit,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::ReservationKind;
        self.confirm_debit_evidence(
            (holder, request_id),
            evidence,
            &[
                ReservationKind::Redemption,
                ReservationKind::Payout,
                ReservationKind::Refund,
            ],
            false,
        )
    }

    /// Internal-only. Consume a DAO disposal reservation on matching finalized
    /// evidence. No DAO authority is defined, so this is not an entry point.
    pub fn confirm_disposal(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        evidence: reservation::FinalizedDebit,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::ReservationKind;
        self.confirm_debit_evidence(
            (holder, request_id),
            evidence,
            &[ReservationKind::Disposal],
            false,
        )
    }

    /// Single consumption path. All checks happen before any write, so a
    /// rejected confirmation leaves no trace. `vouched` means the payout
    /// authority already tied the evidence to one of its attempts, so the
    /// transaction hash need not equal the one recorded at broadcast.
    fn confirm_debit_evidence(
        &mut self,
        key: (AccountId, [u8; 32]),
        evidence: reservation::FinalizedDebit,
        kinds: &[reservation::ReservationKind],
        vouched: bool,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationKind, ReservationStatus};
        let mut evidence = evidence;
        evidence.token_address = evidence.token_address.to_ascii_lowercase();
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        if !kinds.contains(&item.kind) {
            return Err(ReservationError::WrongKind);
        }
        if matches!(item.status, ReservationStatus::Released) {
            return Err(ReservationError::AlreadyReleased);
        }
        if evidence.chain_id != self.asset.chain_id.0
            || !evidence
                .token_address
                .eq_ignore_ascii_case(&self.asset.token_address)
            || evidence.custody_domain != self.asset.custody_domain
            || evidence.destination != item.destination
            || evidence.source_amount != item.source_amount
            || evidence.recipient_received != item.source_amount
            || evidence.transaction_hash == [0; 32]
            || evidence.block_hash == [0; 32]
        {
            return Err(ReservationError::EvidenceMismatch);
        }
        match &item.status {
            ReservationStatus::Confirmed { evidence: previous } => {
                return if previous == &evidence {
                    Ok(false)
                } else {
                    Err(ReservationError::EvidenceMismatch)
                }
            }
            ReservationStatus::Broadcast { transaction_hash }
                if vouched || *transaction_hash == evidence.transaction_hash => {}
            ReservationStatus::Reserved if vouched => {}
            _ => return Err(ReservationError::EvidenceMismatch),
        }
        let debit_id = receipt::ReceiptId {
            chain_id: evidence.chain_id,
            transaction_hash: evidence.transaction_hash,
            log_index: evidence.log_index,
        };
        if self.confirmed_debits.get(&debit_id).is_some() {
            return Err(ReservationError::DebitAlreadyConsumed);
        }
        let bucket = if item.kind == ReservationKind::Disposal {
            ledger::Bucket::Disposal
        } else {
            ledger::Bucket::Payouts
        };
        let mut ledger = self.ledger.clone();
        ledger
            .confirm_debit(bucket, item.amount)
            .map_err(|_| ReservationError::InvalidLedger)?;
        item.status = ReservationStatus::Confirmed { evidence };
        self.clear_unresolved(&mut item);
        self.confirmed_debits.insert(debit_id, key.clone());
        self.reservations.insert(key, item);
        self.ledger = ledger;
        Ok(true)
    }

    fn release_reservation_core(
        &mut self,
        key: (AccountId, [u8; 32]),
        kinds: &[reservation::ReservationKind],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationKind, ReservationStatus};
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        if !kinds.contains(&item.kind) {
            return Err(ReservationError::WrongKind);
        }
        match item.status {
            ReservationStatus::Released => return Ok(false),
            ReservationStatus::Confirmed { .. } => return Err(ReservationError::AlreadyConfirmed),
            ReservationStatus::Reserved | ReservationStatus::Broadcast { .. } => {}
        }
        let holder = key.0.clone();
        let from = if item.kind == ReservationKind::Disposal {
            ledger::Bucket::Disposal
        } else {
            ledger::Bucket::Payouts
        };
        let to = match item.kind {
            ReservationKind::Payout => ledger::Bucket::Entitlements,
            ReservationKind::Refund => ledger::Bucket::Unallocated,
            ReservationKind::Redemption | ReservationKind::Disposal => ledger::Bucket::Minted,
        };
        let mut next = self.ledger.clone();
        next.move_liability(from, to, item.amount)
            .map_err(|_| ReservationError::InvalidLedger)?;
        match item.kind {
            ReservationKind::Payout => {
                let balance = self
                    .entitlement_balances
                    .get(&holder)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(item.amount)
                    .ok_or(ReservationError::InvalidLedger)?;
                self.entitlement_balances.insert(holder, balance);
            }
            ReservationKind::Refund => {
                let balance = self
                    .late_by_account
                    .get(&holder)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(item.amount)
                    .ok_or(ReservationError::InvalidLedger)?;
                let total = self
                    .late_total
                    .checked_add(item.amount)
                    .ok_or(ReservationError::InvalidLedger)?;
                let by_refund = self
                    .late_by_refund
                    .get(&(holder.clone(), item.destination))
                    .copied()
                    .unwrap_or(0)
                    .checked_add(item.amount)
                    .ok_or(ReservationError::InvalidLedger)?;
                self.late_by_refund
                    .insert((holder.clone(), item.destination), by_refund);
                self.late_by_account.insert(holder, balance);
                self.late_total = total;
            }
            ReservationKind::Redemption | ReservationKind::Disposal => {
                let balance = self
                    .token
                    .accounts
                    .get(&holder)
                    .ok_or(ReservationError::UnknownHolder)?;
                if balance.checked_add(item.amount).is_none()
                    || self.token.total_supply.checked_add(item.amount).is_none()
                    || self.token.total_supply != self.ledger.minted
                {
                    return Err(ReservationError::InvalidLedger);
                }
                self.token.internal_deposit(&holder, item.amount);
                FtMint {
                    owner_id: &holder,
                    amount: U128(item.amount),
                    memo: Some("backing restoration"),
                }
                .emit();
            }
        }
        item.status = ReservationStatus::Released;
        self.clear_unresolved(&mut item);
        self.ledger = next;
        self.reservations.insert(key, item);
        Ok(true)
    }

    fn mark_unresolved(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationStatus};
        let key = (holder.clone(), request_id);
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        match item.status {
            ReservationStatus::Released => return Err(ReservationError::AlreadyReleased),
            ReservationStatus::Confirmed { .. } => return Err(ReservationError::AlreadyConfirmed),
            ReservationStatus::Reserved | ReservationStatus::Broadcast { .. } => {}
        }
        if item.unresolved {
            return Ok(false);
        }
        let count = self
            .suspension
            .unresolved
            .checked_add(1)
            .ok_or(ReservationError::InvalidLedger)?;
        item.unresolved = true;
        self.suspension.unresolved = count;
        self.suspension.since_attestation = self.attestation_sequence;
        self.sync_suspension();
        self.reservations.insert(key, item);
        suspension::emit(
            "reconciliation_unresolved",
            near_sdk::serde_json::json!({
                "holder": holder,
                "request_id": request_id,
            }),
        );
        Ok(true)
    }

    fn clear_unresolved(&mut self, item: &mut reservation::Reservation) {
        if item.unresolved {
            item.unresolved = false;
            self.suspension.unresolved = self.suspension.unresolved.saturating_sub(1);
            self.sync_suspension();
        }
    }

    /// Reserve part of a late deposit for refund. U moves to P before any
    /// signature is requested; the reservation identity is the payout's.
    pub fn reserve_late(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        amount: u128,
        destination: [u8; 20],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{Reservation, ReservationError, ReservationKind, ReservationStatus};
        if self.paused || self.reconciliation_required {
            return Err(ReservationError::Paused);
        }
        if amount == 0 {
            return Err(ReservationError::ZeroAmount);
        }
        if destination == [0; 20] || request_id == [0; 32] {
            return Err(ReservationError::InvalidDestination);
        }
        let source_amount = normalization::to_source_exact(
            amount,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .map_err(|_| ReservationError::UnrepresentableAmount)?;
        let key = (beneficiary.clone(), request_id);
        if let Some(existing) = self.reservations.get(&key) {
            return if existing.amount == amount
                && existing.kind == ReservationKind::Refund
                && existing.destination == destination
            {
                Ok(false)
            } else {
                Err(ReservationError::ConflictingRequest)
            };
        }
        let available = self
            .late_by_account
            .get(&beneficiary)
            .copied()
            .ok_or(ReservationError::UnknownHolder)?;
        let remaining = available
            .checked_sub(amount)
            .ok_or(ReservationError::InsufficientBalance)?;
        // The destination must be an address the depositor bound at deposit time.
        let bound = self
            .late_by_refund
            .get(&(beneficiary.clone(), destination))
            .copied()
            .ok_or(ReservationError::UnboundRefundAddress)?;
        let bound_remaining = bound
            .checked_sub(amount)
            .ok_or(ReservationError::InsufficientBalance)?;
        let total = self
            .late_total
            .checked_sub(amount)
            .ok_or(ReservationError::InvalidLedger)?;
        let mut next = self.ledger.clone();
        next.move_liability(ledger::Bucket::Unallocated, ledger::Bucket::Payouts, amount)
            .map_err(|_| ReservationError::InvalidLedger)?;
        self.late_by_account.insert(beneficiary.clone(), remaining);
        self.late_by_refund
            .insert((beneficiary.clone(), destination), bound_remaining);
        self.late_total = total;
        self.ledger = next;
        self.reservations.insert(
            key,
            Reservation {
                request_id,
                holder: beneficiary,
                amount,
                source_amount,
                destination,
                kind: ReservationKind::Refund,
                status: ReservationStatus::Reserved,
                unresolved: false,
            },
        );
        Ok(true)
    }

    fn transfers_halted(&self) -> bool {
        self.paused || self.suspension.reorg
    }

    fn sync_suspension(&mut self) {
        self.reconciliation_required = self.suspension.any();
    }

    /// Liabilities in source atomic units, rounded up so a deficit is never
    /// hidden by rounding. None on overflow.
    fn required_source_units(&self) -> Option<u128> {
        let ledger = &self.ledger;
        let total = ledger
            .minted
            .checked_add(ledger.entitlements)?
            .checked_add(ledger.payouts)?
            .checked_add(ledger.disposal)?
            .checked_add(ledger.unallocated)?;
        normalization::to_source_ceil(
            total,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .ok()?
        .checked_add(self.residual_total)
    }

    fn attestation_covers_now(&self) -> bool {
        match &self.attestation {
            Some(last) => {
                last.sequence.0 > self.suspension.since_attestation
                    && self.ledger.is_balanced()
                    && self
                        .required_source_units()
                        .is_some_and(|need| last.balance.0 >= need)
            }
            None => false,
        }
    }

    fn lift_evidence_reasons(&mut self, by: &str) {
        let reorg = self.suspension.reorg;
        let deficit = self.suspension.deficit;
        self.suspension.reorg = false;
        self.suspension.deficit = false;
        self.sync_suspension();
        suspension::emit(
            "asset_resumed",
            near_sdk::serde_json::json!({
                "by": by,
                "reorg": reorg,
                "deficit": deficit,
                "still_suspended": self.reconciliation_required,
            }),
        );
    }

    /// Reorganization freezes the asset; neither supply nor backing is silently
    /// rolled back. It lifts only through the resume policy and a covering
    /// attestation made afterwards.
    pub fn reorganize_receipt(
        &mut self,
        id: &receipt::ReceiptId,
    ) -> Result<(), ReceiptProcessingError> {
        let mut item = self
            .receipts
            .get(id)
            .cloned()
            .ok_or(ReceiptProcessingError::MissingReceipt)?;
        item.mark_reorganized();
        self.receipts.insert(id.clone(), item);
        if !self.suspension.reorg {
            self.suspension.reorg = true;
            self.suspension.since_attestation = self.attestation_sequence;
            suspension::emit(
                "asset_suspended",
                near_sdk::serde_json::json!({ "reason": "reorg" }),
            );
        }
        self.sync_suspension();
        Ok(())
    }
}

#[near]
impl FungibleTokenCore for Backing {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(!self.transfers_halted(), "Asset paused");
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
        require!(!self.transfers_halted(), "Asset paused");
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
impl FungibleTokenResolver for Backing {
    /// Resolve pending transfers even if the asset was paused in the meantime.
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Backing {
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
        // An account with zero current balance may still have an outgoing
        // transfer awaiting resolution. Unregistering it could burn a refund
        // in the standard resolver without updating attributed backing.
        let _ = force;
        env::panic_str("Storage unregister unavailable pending transfer tracking")
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Backing {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

// Fixture build only; these methods require a self-call and do not verify any
// source-chain evidence. They must never be enabled for deployments.
#[cfg(feature = "sandbox-fixtures")]
#[near]
impl Backing {
    #[private]
    pub fn fixture_observe(
        &mut self,
        hash: String,
        log_index: u32,
        beneficiary: AccountId,
        amount: U128,
    ) {
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &hash, log_index)
            .unwrap_or_else(|_| env::panic_str("Invalid fixture hash"));
        let item = receipt::Receipt {
            id,
            beneficiary,
            refund_address: [0xbe; 20], // fixture value, not live evidence
            actual_source_amount: amount.0,
            source_block_hash: [7; 32],
            status: receipt::ReceiptStatus::Provisional,
        };
        self.observe_receipt(item)
            .unwrap_or_else(|_| env::panic_str("Fixture observation rejected"));
    }
    #[private]
    pub fn fixture_finalize(&mut self, hash: String, log_index: u32) {
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &hash, log_index)
            .unwrap_or_else(|_| env::panic_str("Invalid fixture hash"));
        self.finalize_receipt(&id)
            .unwrap_or_else(|_| env::panic_str("Fixture finalization rejected"));
    }
    #[private]
    pub fn fixture_reorganize(&mut self, hash: String, log_index: u32) {
        let id = receipt::ReceiptId::from_hex(self.asset.chain_id.0, &hash, log_index)
            .unwrap_or_else(|_| env::panic_str("Invalid fixture hash"));
        self.reorganize_receipt(&id)
            .unwrap_or_else(|_| env::panic_str("Fixture reorg rejected"));
    }
    #[private]
    pub fn fixture_reserve(
        &mut self,
        holder: AccountId,
        request: u8,
        amount: U128,
        disposal: bool,
    ) {
        let kind = if disposal {
            reservation::ReservationKind::Disposal
        } else {
            reservation::ReservationKind::Redemption
        };
        self.reserve_representation(holder, [request; 32], amount.0, kind, [9; 20])
            .unwrap_or_else(|_| env::panic_str("Fixture reservation rejected"));
    }
    #[private]
    pub fn fixture_broadcast(&mut self, holder: AccountId, request: u8, transaction: u8) {
        self.record_reservation_broadcast(holder, [request; 32], [transaction; 32])
            .unwrap_or_else(|_| env::panic_str("Fixture broadcast rejected"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(value: &str) -> AccountId {
        value.parse().expect("valid account")
    }
    fn asset() -> Asset {
        Asset {
            chain_id: U64(46630),
            token_address: "0x0000000000000000000000000000000000000001".into(),
            custody_domain: "fixture".into(),
            source_decimals: 18,
            representation_decimals: 18,
        }
    }
    fn context(account_id: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account(account_id))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }
    fn contract() -> Backing {
        context("owner.testnet", 0);
        Backing::new(
            account("owner.testnet"),
            asset(),
            "Test asset".into(),
            "TEST".into(),
            account("registry.testnet"),
            U64(1),
            account("arena.testnet"),
            account("payout.testnet"),
        )
    }
    fn observed(amount: u128, index: u32) -> receipt::Receipt {
        receipt::Receipt {
            id: receipt::ReceiptId {
                chain_id: 46630,
                transaction_hash: [42; 32],
                log_index: index,
            },
            beneficiary: account("alice.testnet"),
            refund_address: [0xbe; 20],
            actual_source_amount: amount,
            source_block_hash: [7; 32],
            status: receipt::ReceiptStatus::Provisional,
        }
    }
    #[test]
    fn receipt_requires_matching_chain_and_nonzero_identifiers() {
        let mut contract = contract();
        let mut item = observed(98, 1);
        item.id.chain_id = 1;
        assert_eq!(
            contract.observe_receipt(item),
            Err(ReceiptProcessingError::WrongChain)
        );
        let mut item = observed(98, 1);
        item.id.transaction_hash = [0; 32];
        assert_eq!(
            contract.observe_receipt(item),
            Err(ReceiptProcessingError::InvalidReceipt)
        );
        let mut item = observed(98, 1);
        item.source_block_hash = [0; 32];
        assert_eq!(
            contract.observe_receipt(item),
            Err(ReceiptProcessingError::InvalidReceipt)
        );
        assert_eq!(contract.get_ledger().custody, U128(0));
    }

    #[test]
    fn receipt_finalization_is_idempotent_and_preserves_source_residue() {
        let mut configured = asset();
        configured.source_decimals = 4;
        configured.representation_decimals = 2;
        context("owner.testnet", 0);
        let mut contract = Backing::new(
            account("owner.testnet"),
            configured,
            "Test".into(),
            "TEST".into(),
            account("registry.testnet"),
            U64(1),
            account("arena.testnet"),
            account("payout.testnet"),
        );
        let item = observed(9_876, 1);
        assert_eq!(contract.observe_receipt(item.clone()), Ok(true));
        assert_eq!(contract.observe_receipt(item.clone()), Ok(false));
        let mut conflicting = item.clone();
        conflicting.actual_source_amount += 1;
        assert_eq!(
            contract.observe_receipt(conflicting),
            Err(ReceiptProcessingError::ConflictingReceipt)
        );
        assert_eq!(contract.finalize_receipt(&item.id), Ok(true));
        assert_eq!(contract.finalize_receipt(&item.id), Ok(false));
        let ledger = contract.get_ledger();
        assert_eq!(ledger.custody, U128(98));
        assert_eq!(ledger.unallocated, U128(98));
        assert_eq!(ledger.source_residue, U128(76));
        assert_eq!(
            contract
                .unallocated_by_account
                .get(&account("alice.testnet")),
            Some(&98)
        );
        assert_eq!(
            contract.residual_by_account.get(&account("alice.testnet")),
            Some(&76)
        );
        assert!(ledger.accounting_balanced);
        let source = contract
            .get_custody_ledger()
            .expect("source units are exact");
        assert_eq!(source.custody, U128(9_876));
        assert_eq!(source.unallocated, U128(9_876));
        assert!(source.accounting_balanced);
    }

    #[test]
    fn canonical_view_refuses_fractional_source_liability_buckets() {
        let mut configured = asset();
        configured.source_decimals = 2;
        configured.representation_decimals = 3;
        context("owner.testnet", 0);
        let mut contract = Backing::new(
            account("owner.testnet"),
            configured,
            "Test".into(),
            "TEST".into(),
            account("registry.testnet"),
            U64(1),
            account("arena.testnet"),
            account("payout.testnet"),
        );
        contract.ledger.custody = 10;
        contract.ledger.minted = 1;
        contract.ledger.unallocated = 9;
        assert!(contract.get_custody_ledger().is_none());
    }
    #[test]
    fn mint_consumes_only_attributed_actual_received_units() {
        let mut contract = contract();
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        contract
            .token
            .internal_register_account(&account("alice.testnet"));
        context("alice.testnet", 1);
        contract.claim_representation(account("alice.testnet"), U128(98));
        assert_eq!(contract.ft_balance_of(account("alice.testnet")), U128(98));
        assert_eq!(
            contract.unallocated_balance_of(account("alice.testnet")),
            U128(0)
        );
        assert_eq!(contract.get_ledger().custody, U128(98));
        assert_eq!(contract.get_ledger().minted, U128(98));
        assert!(contract.get_ledger().accounting_balanced);
        assert_eq!(contract.finalize_receipt(&item.id), Ok(false));
        assert_eq!(contract.ft_total_supply(), U128(98));
    }
    #[test]
    #[should_panic(expected = "Insufficient attributed custody")]
    fn promised_or_nominal_amount_cannot_exceed_actual_receipt() {
        let mut contract = contract();
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        contract
            .token
            .internal_register_account(&account("alice.testnet"));
        context("alice.testnet", 1);
        contract.claim_representation(account("alice.testnet"), U128(100));
    }

    #[test]
    fn competing_reservations_cannot_spend_the_same_backing() {
        use reservation::{ReservationError, ReservationKind};
        let mut contract = contract();
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        let alice = account("alice.testnet");
        contract.token.internal_register_account(&alice);
        context("alice.testnet", 1);
        contract.claim_representation(alice.clone(), U128(98));
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [1; 32],
                60,
                ReservationKind::Redemption,
                [9; 20],
            ),
            Ok(true)
        );
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [1; 32],
                60,
                ReservationKind::Redemption,
                [9; 20],
            ),
            Ok(false)
        );
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [1; 32],
                60,
                ReservationKind::Redemption,
                [8; 20]
            ),
            Err(ReservationError::ConflictingRequest)
        );
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [1; 32],
                60,
                ReservationKind::Disposal,
                [9; 20]
            ),
            Err(ReservationError::ConflictingRequest)
        );
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [2; 32],
                60,
                ReservationKind::Disposal,
                [9; 20]
            ),
            Err(ReservationError::InsufficientBalance)
        );
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [2; 32],
                38,
                ReservationKind::Disposal,
                [9; 20]
            ),
            Ok(true)
        );
        assert_eq!(
            contract.record_reservation_broadcast(alice.clone(), [1; 32], [7; 32]),
            Ok(true)
        );
        assert_eq!(
            contract.record_reservation_broadcast(alice, [1; 32], [7; 32]),
            Ok(false)
        );
        let state = contract.get_ledger();
        assert_eq!(
            (state.custody, state.minted, state.payouts, state.disposal),
            (U128(98), U128(0), U128(60), U128(38))
        );
        assert!(state.accounting_balanced);
    }

    #[test]
    fn redemption_confirmation_requires_matching_final_evidence_and_is_replay_safe() {
        use reservation::{FinalizedDebit, ReservationError, ReservationKind};
        let mut contract = contract();
        let receipt = observed(98, 1);
        contract.observe_receipt(receipt.clone()).expect("observe");
        contract.finalize_receipt(&receipt.id).expect("finalize");
        let alice = account("alice.testnet");
        contract.token.internal_register_account(&alice);
        context("alice.testnet", 1);
        contract.claim_representation(alice.clone(), U128(98));
        contract
            .reserve_representation(
                alice.clone(),
                [1; 32],
                49,
                ReservationKind::Redemption,
                [9; 20],
            )
            .expect("reserve");
        contract
            .reserve_representation(
                alice.clone(),
                [2; 32],
                49,
                ReservationKind::Redemption,
                [9; 20],
            )
            .expect("reserve");
        contract
            .record_reservation_broadcast(alice.clone(), [1; 32], [7; 32])
            .expect("broadcast");
        contract
            .record_reservation_broadcast(alice.clone(), [2; 32], [7; 32])
            .expect("broadcast");
        let evidence = FinalizedDebit {
            chain_id: 46630,
            token_address: asset().token_address,
            custody_domain: "fixture".into(),
            destination: [9; 20],
            source_amount: 49,
            recipient_received: 49,
            transaction_hash: [7; 32],
            log_index: 4,
            block_hash: [8; 32],
        };
        let mut wrong = evidence.clone();
        wrong.destination = [8; 20];
        assert_eq!(
            contract.confirm_redemption(alice.clone(), [1; 32], wrong),
            Err(ReservationError::EvidenceMismatch)
        );
        let mut wrong = evidence.clone();
        wrong.recipient_received = 48;
        assert_eq!(
            contract.confirm_redemption(alice.clone(), [1; 32], wrong),
            Err(ReservationError::EvidenceMismatch)
        );
        assert_eq!(contract.get_ledger().payouts, U128(98));
        assert_eq!(
            contract.confirm_redemption(alice.clone(), [1; 32], evidence.clone()),
            Ok(true)
        );
        assert_eq!(
            contract.record_reservation_broadcast(alice.clone(), [1; 32], [7; 32]),
            Ok(false)
        );
        assert_eq!(
            contract.record_reservation_broadcast(alice.clone(), [1; 32], [8; 32]),
            Err(ReservationError::ConflictingBroadcast)
        );
        let mut uppercase = evidence.clone();
        uppercase.token_address = uppercase.token_address.to_ascii_uppercase();
        assert_eq!(
            contract.confirm_redemption(alice.clone(), [1; 32], uppercase),
            Ok(false)
        );
        assert_eq!(
            contract.confirm_redemption(alice, [2; 32], evidence),
            Err(ReservationError::DebitAlreadyConsumed)
        );
        let state = contract.get_ledger();
        assert_eq!((state.custody, state.payouts), (U128(49), U128(49)));
        assert!(state.accounting_balanced);
    }

    #[test]
    fn reservation_rejects_representation_dust_that_cannot_be_paid() {
        use reservation::{ReservationError, ReservationKind};
        let mut configured = asset();
        configured.source_decimals = 2;
        configured.representation_decimals = 4;
        context("owner.testnet", 0);
        let mut contract = Backing::new(
            account("owner.testnet"),
            configured,
            "Test".into(),
            "TEST".into(),
            account("registry.testnet"),
            U64(1),
            account("arena.testnet"),
            account("payout.testnet"),
        );
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        let alice = account("alice.testnet");
        contract.token.internal_register_account(&alice);
        context("alice.testnet", 1);
        contract.claim_representation(alice.clone(), U128(9_800));
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [1; 32],
                99,
                ReservationKind::Redemption,
                [9; 20],
            ),
            Err(ReservationError::UnrepresentableAmount)
        );
        assert_eq!(contract.ft_balance_of(alice.clone()), U128(9_800));
        assert_eq!(
            contract.reserve_representation(
                alice,
                [1; 32],
                100,
                ReservationKind::Redemption,
                [9; 20]
            ),
            Ok(true)
        );
        assert!(contract.get_ledger().accounting_balanced);
    }

    #[test]
    fn reorganized_provisional_receipt_cannot_mint_and_pauses_reconciliation() {
        let mut contract = contract();
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.reorganize_receipt(&item.id).expect("reorg");
        assert_eq!(
            contract.finalize_receipt(&item.id),
            Err(ReceiptProcessingError::Paused)
        );
        assert!(contract.get_ledger().reconciliation_required);
        assert_eq!(contract.get_ledger().custody, U128(0));
    }
    #[test]
    #[should_panic(expected = "Reconciliation required")]
    fn owner_cannot_unpause_a_disputed_finalized_receipt() {
        let mut contract = contract();
        let item = observed(98, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        contract.reorganize_receipt(&item.id).expect("reorg");
        assert_eq!(contract.get_ledger().custody, U128(98));
        assert_eq!(contract.get_ledger().unallocated, U128(98));
        context("owner.testnet", 1);
        contract.set_paused(false);
    }

    #[test]
    fn new_contract_has_no_unverified_supply() {
        let contract = contract();
        assert_eq!(contract.ft_total_supply(), U128(0));
        assert_eq!(contract.get_ledger().custody, U128(0));
        assert!(contract.get_ledger().accounting_balanced);
        assert_eq!(contract.get_asset(), asset());
    }
    #[test]
    #[should_panic(expected = "Only owner")]
    fn unrelated_account_cannot_change_pause_state() {
        let mut contract = contract();
        context("attacker.testnet", 1);
        contract.set_paused(true);
    }
    #[test]
    #[should_panic(expected = "Asset paused")]
    fn paused_asset_rejects_new_transfers() {
        let mut contract = contract();
        context("owner.testnet", 1);
        contract.set_paused(true);
        contract.ft_transfer(account("alice.testnet"), U128(1), None);
    }
    #[test]
    #[should_panic(expected = "Storage unregister unavailable")]
    fn unregister_cannot_burn_pending_transfer_refunds() {
        let mut contract = contract();
        context("alice.testnet", 1);
        contract.storage_unregister(Some(false));
    }

    fn registry_claim(amount: u128) -> RegistryClaim {
        RegistryClaim {
            representation: account("alice.near"),
            token_address: asset().token_address,
            custody_domain: "fixture".into(),
            mapping_version: U64(1),
            beneficiary: account("bob.testnet"),
            refund_address: [0xbe; 20],
            battle_id: U64(1),
            actual_received: U128(amount),
            block_number: U64(3),
            block_hash: [2; 32],
            finalized_head_number: U64(4),
            finalized_head_hash: [3; 32],
            evidence_hash: [4; 32],
        }
    }
    fn claim_callback(
        contract: &mut Backing,
        claim: Result<Option<RegistryClaim>, PromiseError>,
    ) -> bool {
        claim_callback_in(contract, claim, Some(false))
    }
    /// Drives both claim stages; `locked` is the arena's answer (`None` means
    /// the arena did not know the battle).
    fn claim_callback_in(
        contract: &mut Backing,
        claim: Result<Option<RegistryClaim>, PromiseError>,
        locked: Option<bool>,
    ) -> bool {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("alice.near"))
            .predecessor_account_id(account("alice.near"))
            .attached_deposit(CLAIM_STORAGE_DEPOSIT)
            .build());
        let staged = contract.on_claim_receipt(
            account("caller.testnet"),
            format!("0x{}", "ab".repeat(32)),
            1,
            claim.clone(),
        );
        match staged {
            PromiseOrValue::Value(value) => value,
            PromiseOrValue::Promise(_) => {
                let Ok(Some(claim)) = claim else {
                    return false;
                };
                contract.on_claim_lock_status(
                    account("caller.testnet"),
                    format!("0x{}", "ab".repeat(32)),
                    1,
                    claim,
                    Ok(locked.map(|locked| BattleLockStatus { locked })),
                )
            }
        }
    }

    #[test]
    fn registry_claim_credits_actual_received_once() {
        let mut contract = contract();
        assert!(claim_callback(&mut contract, Ok(Some(registry_claim(98)))));
        assert!(!claim_callback(&mut contract, Ok(Some(registry_claim(98)))));
        assert_eq!(contract.get_ledger().unallocated, U128(98));
        assert_eq!(
            contract.unallocated_balance_of(account("bob.testnet")),
            U128(98)
        );
        assert_eq!(contract.ft_total_supply(), U128(0));
        assert!(contract.get_ledger().accounting_balanced);
    }

    #[test]
    fn unavailable_disputed_or_mismatched_claims_credit_nothing() {
        let mut contract = contract();
        assert!(!claim_callback(&mut contract, Ok(None)));
        assert!(!claim_callback(&mut contract, Err(PromiseError::Failed)));
        let mut wrong = registry_claim(98);
        wrong.custody_domain = "other".into();
        assert!(!claim_callback(&mut contract, Ok(Some(wrong))));
        let mut wrong = registry_claim(98);
        wrong.mapping_version = U64(2);
        assert!(!claim_callback(&mut contract, Ok(Some(wrong))));
        let mut wrong = registry_claim(98);
        wrong.representation = account("other.testnet");
        assert!(!claim_callback(&mut contract, Ok(Some(wrong))));
        assert_eq!(contract.get_ledger().custody, U128(0));
    }

    #[test]
    fn paused_asset_does_not_credit_registry_claims() {
        let mut contract = contract();
        contract.paused = true;
        assert!(!claim_callback(&mut contract, Ok(Some(registry_claim(98)))));
        assert_eq!(contract.get_ledger().custody, U128(0));
    }

    #[test]
    fn registry_dispute_of_a_credited_receipt_pauses_and_requires_reconciliation() {
        let mut contract = contract();
        assert!(claim_callback(&mut contract, Ok(Some(registry_claim(98)))));
        let hash = format!("0x{}", "ab".repeat(32));
        let report = |contract: &mut Backing, hash: &str, disputed| {
            testing_env!(VMContextBuilder::new()
                .current_account_id(account("alice.near"))
                .predecessor_account_id(account("alice.near"))
                .build());
            contract.on_registry_dispute(hash.to_string(), 1, disputed)
        };
        assert!(!report(&mut contract, &hash, Ok(false)));
        assert!(!report(&mut contract, &hash, Err(PromiseError::Failed)));
        assert!(!contract.paused);
        let unknown = format!("0x{}", "cd".repeat(32));
        assert!(!report(&mut contract, &unknown, Ok(true)));
        assert!(!contract.paused);
        assert!(report(&mut contract, &hash, Ok(true)));
        assert!(
            contract.suspension.reorg
                && contract.transfers_halted()
                && contract.reconciliation_required
        );
        assert_eq!(contract.get_ledger().unallocated, U128(98));
        assert!(!report(&mut contract, &hash, Ok(true)));
    }

    fn funded_arena(contract: &mut Backing, amount: u128) {
        let item = observed(amount, 9);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        let arena = account("arena.testnet");
        contract.token.internal_register_account(&arena);
        context("arena.testnet", 1);
        // Attributed to alice.testnet; she mints to the arena as the locked vault.
        context("alice.testnet", 1);
        contract.claim_representation(arena, U128(amount));
    }

    #[test]
    fn only_arena_converts_locked_representation_into_conserved_entitlement() {
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        context("arena.testnet", 10_u128.pow(23));
        let id = [5; 32];
        let bob = account("bob.testnet");
        assert!(contract.allocate_entitlement(id, bob.clone(), U128(60)));
        assert!(!contract.allocate_entitlement(id, bob.clone(), U128(60)));
        let ledger = contract.get_ledger();
        assert_eq!(
            (ledger.minted, ledger.entitlements, ledger.custody),
            (U128(40), U128(60), U128(100))
        );
        assert!(ledger.accounting_balanced);
        assert_eq!(contract.entitlement_of(bob.clone()), U128(60));
        assert_eq!(contract.ft_total_supply(), U128(40));
        assert!(contract.allocate_entitlement([6; 32], bob, U128(40)));
        assert_eq!(contract.get_ledger().minted, U128(0));
    }

    #[test]
    #[should_panic(expected = "Only arena")]
    fn non_arena_cannot_allocate_entitlements() {
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        context("bob.testnet", 10_u128.pow(23));
        contract.allocate_entitlement([5; 32], account("bob.testnet"), U128(60));
    }

    #[test]
    #[should_panic(expected = "Conflicting allocation")]
    fn allocation_id_cannot_be_reused_with_different_data() {
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        context("arena.testnet", 10_u128.pow(23));
        contract.allocate_entitlement([5; 32], account("bob.testnet"), U128(60));
        contract.allocate_entitlement([5; 32], account("bob.testnet"), U128(61));
    }

    #[test]
    #[should_panic(expected = "Insufficient locked representation")]
    fn allocation_cannot_exceed_locked_representation() {
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        context("arena.testnet", 10_u128.pow(23));
        contract.allocate_entitlement([5; 32], account("bob.testnet"), U128(101));
    }

    fn debit(amount: u128, tx: u8) -> reservation::FinalizedDebit {
        reservation::FinalizedDebit {
            chain_id: 46630,
            token_address: asset().token_address,
            custody_domain: "fixture".into(),
            destination: [9; 20],
            source_amount: amount,
            recipient_received: amount,
            transaction_hash: [tx; 32],
            log_index: 0,
            block_hash: [8; 32],
        }
    }

    #[test]
    fn entitlement_payouts_reserve_exclusively_and_complete_partially() {
        use reservation::ReservationError;
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        context("arena.testnet", 10_u128.pow(23));
        let bob = account("bob.testnet");
        contract.allocate_entitlement([5; 32], bob.clone(), U128(100));
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [1; 32], 60, [9; 20]),
            Ok(true)
        );
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [1; 32], 60, [9; 20]),
            Ok(false)
        );
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [1; 32], 60, [8; 20]),
            Err(ReservationError::ConflictingRequest)
        );
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [2; 32], 41, [9; 20]),
            Err(ReservationError::InsufficientBalance)
        );
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [2; 32], 40, [9; 20]),
            Ok(true)
        );
        assert_eq!(contract.entitlement_of(bob.clone()), U128(0));
        let ledger = contract.get_ledger();
        assert_eq!((ledger.entitlements, ledger.payouts), (U128(0), U128(100)));
        // Confirming one payout leaves the other reserved and the ledger balanced.
        assert_eq!(
            contract.record_reservation_broadcast(bob.clone(), [1; 32], [7; 32]),
            Ok(true)
        );
        assert_eq!(
            contract.confirm_redemption(bob.clone(), [1; 32], debit(60, 7)),
            Ok(true)
        );
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.payouts), (U128(40), U128(40)));
        assert!(ledger.accounting_balanced);
        let canonical = contract.get_custody_ledger().expect("exact source units");
        assert_eq!(
            (canonical.custody, canonical.payouts, canonical.unallocated),
            (U128(40), U128(40), U128(0))
        );
        assert!(canonical.accounting_balanced && !canonical.reconciliation_required);
        // A debit that was never broadcast for the second payout cannot confirm it.
        assert_eq!(
            contract.confirm_redemption(bob, [2; 32], debit(40, 6)),
            Err(ReservationError::EvidenceMismatch)
        );
    }

    fn entitled(amount: u128) -> (Backing, AccountId) {
        let mut contract = contract();
        funded_arena(&mut contract, amount);
        context("arena.testnet", 10_u128.pow(23));
        let bob = account("bob.testnet");
        contract.allocate_entitlement([5; 32], bob.clone(), U128(amount));
        (contract, bob)
    }

    #[test]
    fn only_the_payout_authority_can_reserve_confirm_or_release() {
        let (mut contract, bob) = entitled(100);
        context("payout.testnet", 0);
        let first = contract.reserve_payout(bob.clone(), [1; 32], U128(60), [9; 20]);
        assert_eq!((first.created, first.source_amount), (true, U128(60)));
        let repeat = contract.reserve_payout(bob.clone(), [1; 32], U128(60), [9; 20]);
        assert_eq!((repeat.created, repeat.source_amount), (false, U128(60)));
        assert_eq!(
            contract.payout_reservation_status(bob.clone(), [1; 32]),
            Some("reserved".into())
        );
        for caller in ["bob.testnet", "owner.testnet", "arena.testnet"] {
            context(caller, 0);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                contract.release_payout(bob.clone(), [1; 32])
            }));
            assert!(outcome.is_err(), "{caller} must not release");
        }
        assert_eq!(contract.get_ledger().payouts, U128(60));
    }

    #[test]
    fn release_returns_the_entitlement_once_and_never_after_confirmation() {
        let (mut contract, bob) = entitled(100);
        context("payout.testnet", 0);
        assert!(
            contract
                .reserve_payout(bob.clone(), [1; 32], U128(60), [9; 20])
                .created
        );
        assert!(contract.release_payout(bob.clone(), [1; 32]));
        assert!(!contract.release_payout(bob.clone(), [1; 32]));
        assert_eq!(contract.entitlement_of(bob.clone()), U128(100));
        let ledger = contract.get_ledger();
        assert_eq!((ledger.entitlements, ledger.payouts), (U128(100), U128(0)));
        assert!(ledger.accounting_balanced);
        assert_eq!(
            contract.payout_reservation_status(bob.clone(), [1; 32]),
            Some("released".into())
        );
        // A released reservation cannot be confirmed or broadcast later.
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [1; 32], debit(60, 7)),
            Err(reservation::ReservationError::AlreadyReleased)
        );
        assert_eq!(
            contract.release_payout_reservation(account("nobody.testnet"), [1; 32]),
            Err(reservation::ReservationError::MissingReservation)
        );
        // A confirmed payout cannot be released.
        assert!(
            contract
                .reserve_payout(bob.clone(), [2; 32], U128(40), [9; 20])
                .created
        );
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [2; 32], debit(40, 7)),
            Ok(true)
        );
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [2; 32], debit(40, 7)),
            Ok(false)
        );
        assert_eq!(
            contract.release_payout_reservation(bob.clone(), [2; 32]),
            Err(reservation::ReservationError::AlreadyConfirmed)
        );
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.payouts), (U128(60), U128(0)));
        assert_eq!(ledger.entitlements, U128(60));
        assert!(ledger.accounting_balanced);
    }

    #[test]
    fn payout_confirmation_accepts_a_replacement_hash_but_not_a_changed_debit() {
        let (mut contract, bob) = entitled(100);
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [1; 32], 60, [9; 20]),
            Ok(true)
        );
        assert_eq!(
            contract.record_reservation_broadcast(bob.clone(), [1; 32], [6; 32]),
            Ok(true)
        );
        // The payout authority vouched for a replacement attempt with another hash.
        let mut wrong = debit(60, 7);
        wrong.recipient_received = 59;
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [1; 32], wrong),
            Err(reservation::ReservationError::EvidenceMismatch)
        );
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [1; 32], debit(60, 7)),
            Ok(true)
        );
        // The same debit cannot pay a second reservation.
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [3; 32], 40, [9; 20]),
            Ok(true)
        );
        assert_eq!(
            contract.confirm_payout_reservation(bob, [3; 32], debit(40, 7)),
            Err(reservation::ReservationError::DebitAlreadyConsumed)
        );
    }

    #[test]
    fn payout_redemption_and_entitlement_use_separate_backing() {
        use reservation::{ReservationError, ReservationKind};
        let mut contract = contract();
        funded_arena(&mut contract, 100);
        // Alice also holds minted units that are not part of any entitlement.
        let item = observed(30, 11);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        let alice = account("alice.testnet");
        contract.token.internal_register_account(&alice);
        context("alice.testnet", 1);
        contract.claim_representation(alice.clone(), U128(30));
        context("arena.testnet", 10_u128.pow(23));
        let bob = account("bob.testnet");
        contract.allocate_entitlement([5; 32], bob.clone(), U128(100));
        assert_eq!(
            contract.reserve_representation(
                alice.clone(),
                [3; 32],
                30,
                ReservationKind::Redemption,
                [9; 20]
            ),
            Ok(true)
        );
        assert_eq!(
            contract.reserve_entitlement(alice, [4; 32], 1, [9; 20]),
            Err(ReservationError::UnknownHolder)
        );
        assert_eq!(
            contract.reserve_entitlement(bob, [4; 32], 100, [9; 20]),
            Ok(true)
        );
        let ledger = contract.get_ledger();
        assert_eq!(
            (ledger.minted, ledger.entitlements, ledger.payouts),
            (U128(0), U128(0), U128(130))
        );
        assert!(ledger.accounting_balanced);
    }

    // ---- late deposits ------------------------------------------------------

    fn late_contract() -> Backing {
        let mut contract = contract();
        assert!(claim_callback_in(
            &mut contract,
            Ok(Some(registry_claim(98))),
            Some(true)
        ));
        contract
    }

    #[test]
    fn deposit_after_lock_is_recorded_as_late_and_never_claimable() {
        let contract = late_contract();
        let bob = account("bob.testnet");
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.unallocated), (U128(98), U128(98)));
        assert_eq!(ledger.late_refundable, U128(98));
        assert!(ledger.accounting_balanced);
        assert_eq!(contract.late_balance_of(bob.clone()), U128(98));
        // Not claimable as representation: the ordinary attributed balance is empty.
        assert_eq!(contract.unallocated_balance_of(bob), U128(0));
        let recorded = contract
            .get_late_deposit(format!("0x{}", "ab".repeat(32)), 1)
            .expect("late deposit recorded");
        assert_eq!(recorded.battle_id, U64(1));
        assert_eq!(recorded.beneficiary, account("bob.testnet"));
        assert_eq!(recorded.units, U128(98));
    }

    #[test]
    #[should_panic(expected = "Insufficient attributed custody")]
    fn late_balance_cannot_be_minted() {
        let mut contract = late_contract();
        let bob = account("bob.testnet");
        contract.token.internal_register_account(&bob);
        context("bob.testnet", 1);
        contract.claim_representation(bob, U128(98));
    }

    #[test]
    fn unknown_or_unavailable_battle_fails_closed() {
        let mut contract = contract();
        assert!(!claim_callback_in(
            &mut contract,
            Ok(Some(registry_claim(98))),
            None
        ));
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("alice.near"))
            .predecessor_account_id(account("alice.near"))
            .attached_deposit(CLAIM_STORAGE_DEPOSIT)
            .build());
        assert!(!contract.on_claim_lock_status(
            account("caller.testnet"),
            format!("0x{}", "ab".repeat(32)),
            1,
            registry_claim(98),
            Err(PromiseError::Failed)
        ));
        assert_eq!(contract.get_ledger().custody, U128(0));
        assert_eq!(contract.get_ledger().late_refundable, U128(0));
        // The receipt stays claimable once the arena answers.
        assert!(claim_callback_in(
            &mut contract,
            Ok(Some(registry_claim(98))),
            Some(false)
        ));
    }

    #[test]
    fn late_deposit_is_credited_once() {
        let mut contract = late_contract();
        assert!(!claim_callback_in(
            &mut contract,
            Ok(Some(registry_claim(98))),
            Some(true)
        ));
        // A replay that now sees an open battle cannot convert it to claimable custody.
        assert!(!claim_callback_in(
            &mut contract,
            Ok(Some(registry_claim(98))),
            Some(false)
        ));
        assert_eq!(contract.get_ledger().late_refundable, U128(98));
        assert_eq!(
            contract.unallocated_balance_of(account("bob.testnet")),
            U128(0)
        );
    }

    #[test]
    fn late_refund_uses_the_payout_identity_and_conserves_backing() {
        use reservation::ReservationError;
        let mut contract = late_contract();
        let bob = account("bob.testnet");
        context("payout.testnet", 1);
        let first = contract.reserve_late_refund(bob.clone(), [1; 32], U128(60), [0xbe; 20]);
        assert_eq!((first.created, first.source_amount), (true, U128(60)));
        let repeat = contract.reserve_late_refund(bob.clone(), [1; 32], U128(60), [0xbe; 20]);
        assert!(!repeat.created);
        assert_eq!(
            contract.reserve_late(bob.clone(), [1; 32], 60, [8; 20]),
            Err(ReservationError::ConflictingRequest)
        );
        assert_eq!(
            contract.reserve_late(bob.clone(), [2; 32], 39, [0xbe; 20]),
            Err(ReservationError::InsufficientBalance)
        );
        assert_eq!(
            contract.payout_reservation_status(bob.clone(), [1; 32]),
            Some("reserved".into())
        );
        let ledger = contract.get_ledger();
        assert_eq!(
            (ledger.unallocated, ledger.payouts, ledger.late_refundable),
            (U128(38), U128(60), U128(38))
        );
        assert!(ledger.accounting_balanced);
        // Release returns it to the late balance, not to entitlements.
        assert!(contract.release_payout(bob.clone(), [1; 32]));
        assert_eq!(contract.late_balance_of(bob.clone()), U128(98));
        assert_eq!(contract.entitlement_of(bob.clone()), U128(0));
        assert_eq!(contract.get_ledger().payouts, U128(0));
        // Reserve again and confirm with matching evidence.
        contract.reserve_late_refund(bob.clone(), [3; 32], U128(98), [0xbe; 20]);
        let confirmed = contract.confirm_payout(
            bob.clone(),
            [3; 32],
            FinalizedDebitInput {
                chain_id: U64(46630),
                token_address: asset().token_address,
                custody_domain: "fixture".into(),
                destination: [0xbe; 20],
                source_amount: U128(98),
                recipient_received: U128(98),
                transaction_hash: [7; 32],
                log_index: 0,
                block_hash: [8; 32],
            },
        );
        assert!(confirmed);
        let ledger = contract.get_ledger();
        assert_eq!(
            (ledger.custody, ledger.payouts, ledger.late_refundable),
            (U128(0), U128(0), U128(0))
        );
        assert!(ledger.accounting_balanced);
    }

    #[test]
    #[should_panic(expected = "Only payout authority")]
    fn only_the_payout_authority_reserves_late_refunds() {
        let mut contract = late_contract();
        context("bob.testnet", 1);
        contract.reserve_late_refund(account("bob.testnet"), [1; 32], U128(1), [0xbe; 20]);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn late_refund_reservation_requires_one_yocto() {
        let mut contract = late_contract();
        context("payout.testnet", 0);
        contract.reserve_late_refund(account("bob.testnet"), [1; 32], U128(1), [0xbe; 20]);
    }

    #[test]
    fn late_refund_only_goes_to_the_address_bound_at_deposit() {
        use reservation::ReservationError;
        let mut contract = late_contract();
        let bob = account("bob.testnet");
        context("payout.testnet", 1);
        assert_eq!(
            contract.late_balance_of_refund(bob.clone(), [0xbe; 20]),
            U128(98)
        );
        assert_eq!(
            contract
                .get_late_deposit(format!("0x{}", "ab".repeat(32)), 1)
                .map(|d| d.refund_address),
            Some([0xbe; 20])
        );
        // Neither a different address nor an unrelated account can receive the units.
        assert_eq!(
            contract.reserve_late(bob.clone(), [1; 32], 10, [9; 20]),
            Err(ReservationError::UnboundRefundAddress)
        );
        assert_eq!(
            contract.reserve_late(account("mallory.testnet"), [2; 32], 10, [0xbe; 20]),
            Err(ReservationError::UnknownHolder)
        );
        assert_eq!(contract.get_ledger().payouts, U128(0));
        // A reservation and its release keep the per-address balance in step.
        contract.reserve_late_refund(bob.clone(), [3; 32], U128(98), [0xbe; 20]);
        assert_eq!(
            contract.late_balance_of_refund(bob.clone(), [0xbe; 20]),
            U128(0)
        );
        assert!(contract.release_payout(bob.clone(), [3; 32]));
        assert_eq!(contract.late_balance_of_refund(bob, [0xbe; 20]), U128(98));
    }

    #[test]
    fn late_deposits_with_different_bound_addresses_stay_separate() {
        use reservation::ReservationError;
        let mut contract = late_contract();
        let bob = account("bob.testnet");
        let mut second = registry_claim(50);
        second.refund_address = [0xca; 20];
        // Second receipt (different log index) bound to another address.
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("alice.near"))
            .predecessor_account_id(account("alice.near"))
            .attached_deposit(CLAIM_STORAGE_DEPOSIT)
            .build());
        assert!(contract.apply_registry_claim(&format!("0x{}", "cd".repeat(32)), 0, &second, true));
        context("payout.testnet", 1);
        assert_eq!(contract.late_balance_of(bob.clone()), U128(148));
        assert_eq!(
            contract.reserve_late(bob.clone(), [1; 32], 98, [0xca; 20]),
            Err(ReservationError::InsufficientBalance)
        );
        assert_eq!(
            contract.reserve_late(bob, [2; 32], 50, [0xca; 20]),
            Ok(true)
        );
    }

    #[test]
    fn a_claim_without_a_refund_address_credits_nothing() {
        let mut contract = contract();
        let mut claim = registry_claim(98);
        claim.refund_address = [0; 20];
        assert!(!claim_callback_in(
            &mut contract,
            Ok(Some(claim)),
            Some(true)
        ));
        assert_eq!(contract.get_ledger().custody, U128(0));
    }

    // ---- deficit suspension and resume policy -------------------------------

    fn set_operator(contract: &mut Backing) {
        context("owner.testnet", 1);
        contract.set_operator(Some(account("operator.testnet")));
    }

    fn attest(contract: &mut Backing, block: u64, balance: u128) -> bool {
        context("operator.testnet", 1);
        contract.attest_custody_balance(
            U64(block),
            [block as u8; 32],
            U64(block + 1),
            [200; 32],
            U128(balance),
            [5; 32],
        )
    }

    fn minted_contract(amount: u128) -> Backing {
        let mut contract = contract();
        let item = observed(amount, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        let alice = account("alice.testnet");
        contract.token.internal_register_account(&alice);
        context("alice.testnet", 1);
        contract.claim_representation(alice, U128(amount));
        set_operator(&mut contract);
        contract
    }

    #[test]
    fn attestation_below_liabilities_suspends_but_keeps_liabilities() {
        let mut contract = minted_contract(100);
        assert!(attest(&mut contract, 10, 100));
        assert!(!contract.get_ledger().reconciliation_required);
        assert!(!attest(&mut contract, 11, 99));
        let view = contract.get_suspension();
        assert!(view.suspended && view.deficit && !view.reorg);
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.minted), (U128(100), U128(100)));
        assert!(ledger.accounting_balanced);
        // Minting and new reservations are blocked.
        assert_eq!(
            contract.reserve_representation(
                account("alice.testnet"),
                [1; 32],
                10,
                reservation::ReservationKind::Redemption,
                [9; 20]
            ),
            Err(reservation::ReservationError::Paused)
        );
        assert_eq!(
            contract.reserve_entitlement(account("bob.testnet"), [1; 32], 1, [9; 20]),
            Err(reservation::ReservationError::Paused)
        );
        let mut late = contract;
        assert!(!claim_callback_in(
            &mut late,
            Ok(Some(registry_claim(5))),
            Some(false)
        ));
    }

    #[test]
    fn residue_is_part_of_the_required_balance() {
        let mut configured = asset();
        configured.source_decimals = 4;
        configured.representation_decimals = 2;
        context("owner.testnet", 0);
        let mut contract = Backing::new(
            account("owner.testnet"),
            configured,
            "Test".into(),
            "TEST".into(),
            account("registry.testnet"),
            U64(1),
            account("arena.testnet"),
            account("payout.testnet"),
        );
        let item = observed(9_876, 1);
        contract.observe_receipt(item.clone()).expect("observe");
        contract.finalize_receipt(&item.id).expect("finalize");
        set_operator(&mut contract);
        assert!(!attest(&mut contract, 10, 9_875));
        assert!(attest(&mut contract, 11, 9_876));
    }

    #[test]
    fn attestations_are_operator_only_ordered_and_idempotent() {
        let mut contract = minted_contract(100);
        assert!(attest(&mut contract, 10, 100));
        assert!(attest(&mut contract, 10, 100));
        let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            attest(&mut contract, 9, 100)
        }));
        assert!(stale.is_err());
        let conflicting = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            attest(&mut contract, 10, 5)
        }));
        assert!(conflicting.is_err());
        let outsider = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            context("attacker.testnet", 1);
            contract.attest_custody_balance(U64(11), [1; 32], U64(12), [2; 32], U128(0), [3; 32])
        }));
        assert!(outsider.is_err());
        assert!(!contract.get_ledger().reconciliation_required);
    }

    #[test]
    fn owner_with_evidence_needs_a_later_covering_attestation() {
        let mut contract = minted_contract(100);
        assert!(!attest(&mut contract, 10, 50));
        // Without a later covering attestation the owner cannot resume.
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        // A covering attestation alone does not lift under this policy.
        assert!(attest(&mut contract, 11, 100));
        assert!(contract.get_suspension().suspended);
        context("attacker.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        context("owner.testnet", 0);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        context("owner.testnet", 1);
        assert!(contract.resume());
        assert!(!contract.get_suspension().suspended);
        assert_eq!(contract.get_ledger().minted, U128(100));
    }

    #[test]
    fn resume_fails_when_liabilities_outgrow_the_attested_balance() {
        let mut contract = minted_contract(100);
        assert!(!attest(&mut contract, 10, 50));
        assert!(attest(&mut contract, 11, 100));
        // A liability added after the attestation (a reorg-held credit) is not covered.
        contract.ledger.custody += 1;
        contract.ledger.unallocated += 1;
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
    }

    #[test]
    fn reorg_suspension_needs_an_attestation_made_after_it() {
        let mut contract = minted_contract(100);
        assert!(attest(&mut contract, 10, 100));
        let id = receipt::ReceiptId {
            chain_id: 46630,
            transaction_hash: [42; 32],
            log_index: 1,
        };
        contract.reorganize_receipt(&id).expect("reorg");
        assert!(contract.get_suspension().reorg);
        // The earlier covering attestation cannot justify resuming.
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        assert!(attest(&mut contract, 11, 100));
        context("owner.testnet", 1);
        assert!(contract.resume());
        assert!(!contract.get_ledger().reconciliation_required);
    }

    #[test]
    fn automatic_policy_lifts_on_a_later_covering_attestation() {
        let mut contract = minted_contract(100);
        context("owner.testnet", 1);
        contract.set_resume_policy(ResumePolicy::Automatic);
        assert!(!attest(&mut contract, 10, 1));
        assert!(contract.get_suspension().suspended);
        // A still-short attestation does not lift.
        assert!(!attest(&mut contract, 11, 99));
        assert!(contract.get_suspension().suspended);
        assert!(attest(&mut contract, 12, 100));
        assert!(!contract.get_suspension().suspended);
        // The owner entry point is not the Automatic path.
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
    }

    #[test]
    fn disabled_policy_never_resumes() {
        let mut contract = minted_contract(100);
        context("owner.testnet", 1);
        contract.set_resume_policy(ResumePolicy::Disabled);
        assert!(!attest(&mut contract, 10, 1));
        assert!(attest(&mut contract, 11, 100));
        assert!(contract.get_suspension().suspended);
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        // The owner can still change the policy afterwards.
        contract.set_resume_policy(ResumePolicy::OwnerWithEvidence);
        assert!(attest(&mut contract, 12, 100));
        context("owner.testnet", 1);
        assert!(contract.resume());
    }

    #[test]
    fn resume_policy_defaults_safe_and_changes_are_owner_only_one_yocto_and_logged() {
        let mut contract = contract();
        assert_eq!(
            contract.get_suspension().resume_policy,
            ResumePolicy::OwnerWithEvidence
        );
        context("owner.testnet", 1);
        contract.set_resume_policy(ResumePolicy::Automatic);
        assert_eq!(
            contract.get_suspension().resume_policy,
            ResumePolicy::Automatic
        );
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|line| line.contains("resume_policy_changed")
                && line.contains("owner_with_evidence")
                && line.contains("automatic")));
        context("attacker.testnet", 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.set_resume_policy(ResumePolicy::Disabled)
        }))
        .is_err());
        context("owner.testnet", 0);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.set_resume_policy(ResumePolicy::Disabled)
        }))
        .is_err());
        context("owner.testnet", 2);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.set_resume_policy(ResumePolicy::Disabled)
        }))
        .is_err());
        assert_eq!(
            contract.get_suspension().resume_policy,
            ResumePolicy::Automatic
        );
    }

    // ---- reconciliation ------------------------------------------------------

    #[test]
    fn unresolved_reservation_suspends_until_confirmed_and_confirm_works_while_suspended() {
        let (mut contract, bob) = entitled(100);
        context("payout.testnet", 0);
        contract.reserve_payout(bob.clone(), [1; 32], U128(60), [9; 20]);
        context("payout.testnet", 1);
        assert!(contract.report_unresolved_reconciliation(bob.clone(), [1; 32]));
        assert!(!contract.report_unresolved_reconciliation(bob.clone(), [1; 32]));
        let view = contract.get_suspension();
        assert!(view.suspended && view.unresolved == U64(1) && !view.deficit && !view.reorg);
        // New reservations and mint are blocked; liabilities are intact.
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [2; 32], 1, [9; 20]),
            Err(reservation::ReservationError::Paused)
        );
        assert_eq!(contract.get_ledger().payouts, U128(60));
        // The owner cannot resume past an unresolved reservation.
        context("owner.testnet", 1);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.resume())).is_err()
        );
        // Matching finalized evidence still reconciles and clears the flag.
        context("payout.testnet", 0);
        assert!(contract.confirm_payout(
            bob.clone(),
            [1; 32],
            FinalizedDebitInput {
                chain_id: U64(46630),
                token_address: asset().token_address,
                custody_domain: "fixture".into(),
                destination: [9; 20],
                source_amount: U128(60),
                recipient_received: U128(60),
                transaction_hash: [7; 32],
                log_index: 0,
                block_hash: [8; 32],
            },
        ));
        assert!(!contract.get_suspension().suspended);
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.payouts), (U128(40), U128(0)));
        assert!(ledger.accounting_balanced);
    }

    #[test]
    fn release_after_no_spend_proof_clears_unresolved_and_works_while_suspended() {
        let (mut contract, bob) = entitled(100);
        context("payout.testnet", 0);
        contract.reserve_payout(bob.clone(), [1; 32], U128(60), [9; 20]);
        context("payout.testnet", 1);
        contract.report_unresolved_reconciliation(bob.clone(), [1; 32]);
        context("payout.testnet", 0);
        assert!(contract.release_payout(bob.clone(), [1; 32]));
        assert!(!contract.get_suspension().suspended);
        assert_eq!(contract.entitlement_of(bob), U128(100));
        // Terminal reservations cannot be reported unresolved.
        context("payout.testnet", 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.report_unresolved_reconciliation(account("bob.testnet"), [1; 32])
        }))
        .is_err());
    }

    #[test]
    fn rejected_confirmation_leaves_no_trace() {
        let (mut contract, bob) = entitled(100);
        assert_eq!(
            contract.reserve_entitlement(bob.clone(), [1; 32], 60, [9; 20]),
            Ok(true)
        );
        let mut wrong = debit(60, 7);
        wrong.source_amount = 59;
        assert_eq!(
            contract.confirm_payout_reservation(bob.clone(), [1; 32], wrong),
            Err(reservation::ReservationError::EvidenceMismatch)
        );
        assert_eq!(
            contract.payout_reservation_status(bob, [1; 32]),
            Some("reserved".into())
        );
    }

    #[test]
    fn disposal_confirms_against_the_disposal_bucket_and_release_restores_supply() {
        use reservation::{ReservationError, ReservationKind};
        let mut contract = minted_contract(100);
        let alice = account("alice.testnet");
        contract
            .reserve_representation(
                alice.clone(),
                [1; 32],
                40,
                ReservationKind::Disposal,
                [9; 20],
            )
            .expect("disposal");
        contract
            .reserve_representation(
                alice.clone(),
                [2; 32],
                30,
                ReservationKind::Redemption,
                [9; 20],
            )
            .expect("redemption");
        // A redemption confirmation cannot consume a disposal and vice versa.
        assert_eq!(
            contract.confirm_redemption(alice.clone(), [1; 32], debit(40, 7)),
            Err(ReservationError::WrongKind)
        );
        assert_eq!(
            contract.confirm_disposal(alice.clone(), [2; 32], debit(30, 7)),
            Err(ReservationError::WrongKind)
        );
        // Not broadcast yet: evidence for an unbroadcast spend is rejected.
        assert_eq!(
            contract.confirm_disposal(alice.clone(), [1; 32], debit(40, 7)),
            Err(ReservationError::EvidenceMismatch)
        );
        contract
            .record_reservation_broadcast(alice.clone(), [1; 32], [7; 32])
            .expect("broadcast");
        assert_eq!(
            contract.confirm_disposal(alice.clone(), [1; 32], debit(40, 7)),
            Ok(true)
        );
        let ledger = contract.get_ledger();
        assert_eq!(
            (ledger.custody, ledger.disposal, ledger.payouts),
            (U128(60), U128(0), U128(30))
        );
        // Definitive no-spend proof restores the redemption as supply, once.
        assert_eq!(
            contract.release_unspent_reservation(alice.clone(), [2; 32]),
            Ok(true)
        );
        assert_eq!(
            contract.release_unspent_reservation(alice.clone(), [2; 32]),
            Ok(false)
        );
        assert_eq!(contract.ft_balance_of(alice.clone()), U128(60));
        assert_eq!(contract.ft_total_supply(), U128(60));
        assert_eq!(
            contract.release_unspent_reservation(alice, [1; 32]),
            Err(ReservationError::AlreadyConfirmed)
        );
        assert!(contract.get_ledger().accounting_balanced);
    }

    #[test]
    fn confirmation_is_allowed_while_the_asset_is_suspended() {
        use reservation::ReservationKind;
        let mut contract = minted_contract(100);
        let alice = account("alice.testnet");
        contract
            .reserve_representation(
                alice.clone(),
                [1; 32],
                40,
                ReservationKind::Redemption,
                [9; 20],
            )
            .expect("reserve");
        contract
            .record_reservation_broadcast(alice.clone(), [1; 32], [7; 32])
            .expect("broadcast");
        // The debit happened on the source chain, so the balance fell short.
        assert!(!attest(&mut contract, 10, 60));
        assert!(contract.get_suspension().deficit);
        assert_eq!(
            contract.confirm_redemption(alice, [1; 32], debit(40, 7)),
            Ok(true)
        );
        let ledger = contract.get_ledger();
        assert_eq!((ledger.custody, ledger.payouts), (U128(60), U128(0)));
        // A later attestation at the reduced liability level covers.
        assert!(attest(&mut contract, 11, 60));
        context("owner.testnet", 1);
        assert!(contract.resume());
    }
}
