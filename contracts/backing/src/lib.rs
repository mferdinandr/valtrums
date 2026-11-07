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

use ledger::Ledger;
use registry_claim::{RegistryClaim, RegistryKey};

/// Upper bound on storage a first claim can add (receipt plus two account maps).
const CLAIM_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
const REGISTRY_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait SharedRegistry {
    fn get_active_claim(&self, key: RegistryKey) -> Option<RegistryClaim>;
    fn is_disputed(&self, key: RegistryKey) -> bool;
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
                    .with_static_gas(CALLBACK_GAS)
                    .with_attached_deposit(env::attached_deposit())
                    .on_claim_receipt(env::predecessor_account_id(), transaction_hash, log_index),
            )
    }

    /// Returns true only when this call credited new custody. Every other
    /// outcome (unavailable, disputed, mismatched, replayed, paused) credits
    /// nothing and refunds the full deposit to the caller.
    #[private]
    #[payable]
    pub fn on_claim_receipt(
        &mut self,
        caller: AccountId,
        transaction_hash: String,
        log_index: u32,
        #[callback_result] claim: Result<Option<RegistryClaim>, PromiseError>,
    ) -> bool {
        let attached = env::attached_deposit().as_yoctonear();
        let before = env::storage_usage();
        let credited = match (claim, self.paused || self.reconciliation_required) {
            (Ok(Some(claim)), false) => {
                self.apply_registry_claim(&transaction_hash, log_index, &claim)
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
        let fresh = !self.reconciliation_required;
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
        if item.kind != reservation::ReservationKind::Payout {
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
            paused: self.paused,
            reconciliation_required: self.reconciliation_required,
            source_residue: U128(self.residual_total),
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
    fn apply_registry_claim(
        &mut self,
        transaction_hash: &str,
        log_index: u32,
        claim: &RegistryClaim,
    ) -> bool {
        let Ok(id) =
            receipt::ReceiptId::from_hex(self.asset.chain_id.0, transaction_hash, log_index)
        else {
            return false;
        };
        if !registry_claim::matches_asset(
            claim,
            &self.asset,
            &env::current_account_id(),
            self.mapping_version,
        ) {
            return false;
        }
        let candidate = receipt::Receipt {
            id: id.clone(),
            beneficiary: claim.beneficiary.clone(),
            actual_source_amount: claim.actual_received.0,
            source_block_hash: claim.block_hash,
            status: receipt::ReceiptStatus::Provisional,
        };
        self.observe_receipt(candidate).is_ok() && self.finalize_receipt(&id) == Ok(true)
    }

    pub fn observe_receipt(
        &mut self,
        candidate: receipt::Receipt,
    ) -> Result<bool, ReceiptProcessingError> {
        use receipt::ReceiptStatus;
        if self.paused {
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
        if self.paused {
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
        let unallocated = self
            .unallocated_by_account
            .get(&account)
            .copied()
            .unwrap_or(0)
            .checked_add(normalized.representation_units)
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
            self.unallocated_by_account
                .insert(account.clone(), unallocated);
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
            ReservationKind::Payout => return Err(ReservationError::WrongKind),
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

    /// Confirm a payout reservation. The payout authority has already verified
    /// that the evidence names one of its signed attempts, so a replacement
    /// transaction may differ from the hash recorded earlier; every other check
    /// is the redemption confirmation's.
    pub fn confirm_payout_reservation(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
        evidence: reservation::FinalizedDebit,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationKind, ReservationStatus};
        let key = (beneficiary.clone(), request_id);
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        if item.kind != ReservationKind::Payout {
            return Err(ReservationError::WrongKind);
        }
        match item.status {
            ReservationStatus::Released => return Err(ReservationError::AlreadyReleased),
            ReservationStatus::Reserved | ReservationStatus::Broadcast { .. } => {
                if evidence.transaction_hash == [0; 32] {
                    return Err(ReservationError::InvalidTransaction);
                }
                item.status = ReservationStatus::Broadcast {
                    transaction_hash: evidence.transaction_hash,
                };
                self.reservations.insert(key, item);
            }
            ReservationStatus::Confirmed { .. } => {}
        }
        self.confirm_redemption(beneficiary, request_id, evidence)
    }

    /// Return a payout reservation to the beneficiary's entitlement. The caller
    /// must have proven that no executable source-chain spend remains.
    pub fn release_payout_reservation(
        &mut self,
        beneficiary: AccountId,
        request_id: [u8; 32],
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationKind, ReservationStatus};
        if self.paused || self.reconciliation_required {
            return Err(ReservationError::Paused);
        }
        let key = (beneficiary.clone(), request_id);
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        if item.kind != ReservationKind::Payout {
            return Err(ReservationError::WrongKind);
        }
        match item.status {
            ReservationStatus::Released => return Ok(false),
            ReservationStatus::Confirmed { .. } => return Err(ReservationError::AlreadyConfirmed),
            ReservationStatus::Reserved | ReservationStatus::Broadcast { .. } => {}
        }
        let balance = self
            .entitlement_balances
            .get(&beneficiary)
            .copied()
            .unwrap_or(0)
            .checked_add(item.amount)
            .ok_or(ReservationError::InvalidLedger)?;
        let mut next = self.ledger.clone();
        next.move_liability(
            ledger::Bucket::Payouts,
            ledger::Bucket::Entitlements,
            item.amount,
        )
        .map_err(|_| ReservationError::InvalidLedger)?;
        item.status = ReservationStatus::Released;
        self.ledger = next;
        self.entitlement_balances.insert(beneficiary, balance);
        self.reservations.insert(key, item);
        Ok(true)
    }

    /// Apply an authenticated finalized redemption debit exactly once. This
    /// internal method validates binding but cannot itself prove finality;
    /// there is no exported callback until the verifier is implemented.
    pub fn confirm_redemption(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        evidence: reservation::FinalizedDebit,
    ) -> Result<bool, reservation::ReservationError> {
        use reservation::{ReservationError, ReservationKind, ReservationStatus};
        let mut evidence = evidence;
        evidence.token_address = evidence.token_address.to_ascii_lowercase();
        if self.paused || self.reconciliation_required {
            return Err(ReservationError::Paused);
        }
        let key = (holder, request_id);
        let mut item = self
            .reservations
            .get(&key)
            .cloned()
            .ok_or(ReservationError::MissingReservation)?;
        if !matches!(
            item.kind,
            ReservationKind::Redemption | ReservationKind::Payout
        ) {
            return Err(ReservationError::WrongKind);
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
                if *transaction_hash == evidence.transaction_hash => {}
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
        let mut ledger = self.ledger.clone();
        ledger
            .confirm_debit(ledger::Bucket::Payouts, item.amount)
            .map_err(|_| ReservationError::InvalidLedger)?;
        item.status = ReservationStatus::Confirmed { evidence };
        self.confirmed_debits.insert(debit_id, key.clone());
        self.reservations.insert(key, item);
        self.ledger = ledger;
        Ok(true)
    }

    /// Reorganization freezes the asset; neither supply nor backing is silently
    /// rolled back. No unpause is possible until reconciliation is implemented.
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
        self.paused = true;
        self.reconciliation_required = true;
        Ok(())
    }
}

#[near]
impl FungibleTokenCore for Backing {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(!self.paused, "Asset paused");
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
        require!(!self.paused, "Asset paused");
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
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("alice.near"))
            .predecessor_account_id(account("alice.near"))
            .attached_deposit(CLAIM_STORAGE_DEPOSIT)
            .build());
        contract.on_claim_receipt(
            account("caller.testnet"),
            format!("0x{}", "ab".repeat(32)),
            1,
            claim,
        )
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
        assert!(contract.paused && contract.reconciliation_required);
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
}
