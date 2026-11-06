//! The backing contract: one NEP-141 representation per deployed instance,
//! minted only against unique verified finalized Robinhood custody receipts.
//!
//! It owns the liability ledger for its asset and enforces
//! `B = M + E + P + D + U`:
//!
//! - `B` verified actual custody balance (representable units)
//! - `M` live representation supply (NEP-141 total supply)
//! - `E` allocated entitlements (rewards and revenue, not yet submitted)
//! - `P` exclusively reserved pending payouts/redemptions
//! - `D` exclusively reserved pending DAO-directed disposal
//! - `U` verified unallocated (attributed, claimable) custody
//!
//! Unrepresentable source residue stays attributed as residual custody and is
//! never minted. Minting never rounds up.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

pub mod events;
pub mod types;

use events::emit;
use types::{
    AssetIdentity, Disposal, DisposalKind, Evidence, LedgerView, Payout, PayoutKind, PayoutStatus,
    ReceiptId,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Token,
    Receipts,
    Unallocated,
    Residual,
    Entitlements,
    Payouts,
    Disposals,
    AllocatedBattles,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Backing {
    owner: AccountId,
    /// Role that submits verified custody receipts and execution evidence.
    verifier: AccountId,
    /// Role that creates entitlements, reservations and disposals.
    arena: Option<AccountId>,
    paused: bool,
    identity: AssetIdentity,
    /// Verified actual custody balance in representation units (`B`).
    custody: u128,
    /// NEP-141 representation state; its total supply is `M`.
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    /// Unique receipt identities consumed by verification (replay protection).
    receipts: near_sdk::store::LookupSet<ReceiptId>,
    /// Claimable unallocated custody per origin account (`U`).
    unallocated: LookupMap<AccountId, u128>,
    /// Running total of `U`.
    unallocated_total: u128,
    /// Unrepresentable source residue per origin; never mintable.
    residual: LookupMap<AccountId, u128>,
    /// Running total of residue (not part of the ledger identity).
    residual_total: u128,
    /// Allocated entitlements per (battle, beneficiary): `E`.
    entitlements: LookupMap<(u64, AccountId), u128>,
    /// Running total of `E`.
    entitlements_total: u128,
    /// Pending payout reservations: `P`.
    payouts: LookupMap<u64, Payout>,
    /// Running total of pending `P` (reserved + broadcast).
    payouts_pending: u128,
    payout_count: u64,
    /// Pending DAO-directed disposals: `D`.
    disposals: LookupMap<u64, Disposal>,
    /// Running total of pending `D`.
    disposals_pending: u128,
    disposal_count: u64,
    /// Battles whose vault was already converted to entitlements for this asset.
    allocated_battles: near_sdk::store::LookupSet<u64>,
}

#[near]
impl Backing {
    #[init]
    pub fn new(owner: AccountId, verifier: AccountId, identity: AssetIdentity) -> Self {
        require!(identity.decimals <= 24, "Representation decimals too large");
        let symbol = identity.symbol.clone();
        let name = identity.name.clone();
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: format!("Valtrum-backed {name}"),
            symbol,
            icon: None,
            reference: Some(
                json!({
                    "chain_id": identity.chain_id,
                    "token_address": identity.token_address,
                    "custody_domain": identity.custody_domain,
                })
                .to_string(),
            ),
            reference_hash: None,
            decimals: identity.decimals,
        };
        Self {
            owner,
            verifier,
            arena: None,
            paused: false,
            identity,
            custody: 0,
            token: FungibleToken::new(StorageKey::Token),
            metadata,
            receipts: near_sdk::store::LookupSet::new(StorageKey::Receipts),
            unallocated: LookupMap::new(StorageKey::Unallocated),
            unallocated_total: 0,
            residual: LookupMap::new(StorageKey::Residual),
            residual_total: 0,
            entitlements: LookupMap::new(StorageKey::Entitlements),
            entitlements_total: 0,
            payouts: LookupMap::new(StorageKey::Payouts),
            payouts_pending: 0,
            payout_count: 0,
            disposals: LookupMap::new(StorageKey::Disposals),
            disposals_pending: 0,
            disposal_count: 0,
            allocated_battles: near_sdk::store::LookupSet::new(StorageKey::AllocatedBattles),
        }
    }

    // ─── Configuration ───────────────────────────────────────────────────

    pub fn set_verifier(&mut self, verifier: AccountId) {
        self.assert_owner();
        self.verifier = verifier;
    }

    pub fn set_arena(&mut self, arena: Option<AccountId>) {
        self.assert_owner();
        self.arena = arena;
    }

    pub fn pause(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    // ─── Receipts and minting ────────────────────────────────────────────

    /// Verifies a finalized custody receipt and records `received` source units
    /// (what custody actually received, not the nominal input) as unallocated
    /// custody attributed to `origin`. Replays are refused. Exact decimal
    /// normalization never rounds up; residue stays attributed and unmintable.
    pub fn verify_receipt(
        &mut self,
        receipt: ReceiptId,
        received_src: U128,
        src_decimals: u8,
        origin: AccountId,
    ) -> U128 {
        self.assert_verifier();
        self.assert_active();
        require!(
            !self.receipts.contains(&receipt),
            "Receipt already consumed"
        );
        self.receipts.insert(receipt.clone());

        let (representable, residue) =
            normalize(received_src.0, src_decimals, self.identity.decimals);
        let custody = self.ledger_custody();
        self.set_custody(
            custody
                .checked_add(representable)
                .expect("custody overflow"),
        );

        if representable > 0 {
            let key = origin.clone();
            let current = self.unallocated.get(&key).copied().unwrap_or(0);
            self.unallocated
                .insert(key, current.checked_add(representable).expect("U overflow"));
            self.unallocated_total = self
                .unallocated_total
                .checked_add(representable)
                .expect("U overflow");
        }
        if residue > 0 {
            let key = origin.clone();
            let current = self.residual.get(&key).copied().unwrap_or(0);
            self.residual
                .insert(key, current.checked_add(residue).expect("residue overflow"));
            self.residual_total = self
                .residual_total
                .checked_add(residue)
                .expect("residue overflow");
        }

        emit(
            "custody_verified",
            json!({
                "receipt": receipt,
                "received": received_src,
                "representable": representable,
                "residue": residue,
                "origin": origin,
            }),
        );
        self.check_invariant();
        U128(representable)
    }

    /// Converts the caller's attributed unallocated custody into a
    /// representation minted to `beneficiary` (usually the caller itself or a
    /// battle escrow). `U -> M`. The 1 yocto deposit forces a FullAccess
    /// signature and wallet confirmation.
    #[payable]
    pub fn claim_deposit(&mut self, beneficiary: AccountId, amount: U128) {
        require!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "Requires at least 1 yoctoNEAR"
        );
        self.assert_active();
        let q = amount.0;
        require!(q > 0, "Zero amount");
        let caller = env::predecessor_account_id();
        let key = caller.clone();
        let held = self.unallocated.get(&key).copied().unwrap_or(0);
        require!(held >= q, "Insufficient attributed custody");

        if !self.token.accounts.contains_key(&beneficiary) {
            self.token.internal_register_account(&beneficiary);
        }
        self.token.internal_deposit(&beneficiary, q);
        self.unallocated.insert(key, held - q);
        self.unallocated_total = self.unallocated_total.checked_sub(q).expect("U underflow");

        emit(
            "representation_minted",
            json!({ "beneficiary": beneficiary, "amount": q, "origin": caller }),
        );
        self.check_invariant();
    }

    // ─── Allocations and reservations ────────────────────────────────────

    /// Converts a losing battle vault (representations held by the arena) into
    /// per-beneficiary entitlements: `M -> E`. Idempotent per battle: replaying
    /// the allocation for the same battle on this asset is refused.
    pub fn allocate_to_entitlements(
        &mut self,
        battle_id: u64,
        allocations: Vec<(AccountId, U128)>,
    ) {
        self.assert_arena();
        self.assert_active();
        require!(
            !self.allocated_battles.contains(&battle_id),
            "Battle already allocated on this asset"
        );
        require!(!allocations.is_empty(), "Empty allocation");
        let mut total: u128 = 0;
        for (_, q) in allocations.iter() {
            total = total.checked_add(q.0).expect("allocation overflow");
        }

        let arena = self.arena.clone().expect("arena configured");
        self.burn_representations(&arena, total, "allocation");

        for (beneficiary, q) in allocations {
            require!(q.0 > 0, "Zero allocation");
            let key = (battle_id, beneficiary.clone());
            let current = self.entitlements.get(&key).copied().unwrap_or(0);
            self.entitlements
                .insert(key, current.checked_add(q.0).expect("E overflow"));
        }
        self.entitlements_total = self
            .entitlements_total
            .checked_add(total)
            .expect("E overflow");
        self.allocated_battles.insert(battle_id);

        emit(
            "entitlements_allocated",
            json!({ "battle_id": battle_id, "total": total }),
        );
        self.check_invariant();
    }

    /// Reserves `q` of a beneficiary's entitlement for payout: `E -> P`.
    /// Returns the payout record with a stable id and nonce. The same
    /// entitlement cannot be reserved twice.
    pub fn reserve_payout(
        &mut self,
        battle_id: u64,
        beneficiary: AccountId,
        q: U128,
        kind: PayoutKind,
    ) -> Payout {
        self.assert_arena();
        self.assert_active();
        let q = q.0;
        require!(q > 0, "Zero payout");

        let key = (battle_id, beneficiary.clone());
        let entitled = self.entitlements.get(&key).copied().unwrap_or(0);
        require!(entitled >= q, "Insufficient entitlement");

        self.entitlements.insert(key, entitled - q);
        self.entitlements_total = self.entitlements_total.checked_sub(q).expect("E underflow");
        self.payouts_pending = self.payouts_pending.checked_add(q).expect("P overflow");
        let id = self.payout_count;
        self.payout_count = self.payout_count.checked_add(1).expect("payout count");
        let payout = Payout {
            id,
            battle_id,
            beneficiary,
            amount: U128(q),
            kind,
            nonce: id,
            status: PayoutStatus::Reserved,
            tx_hash: None,
            confirmed: None,
        };
        self.payouts.insert(id, payout.clone());

        emit(
            "payout_reserved",
            json!({ "payout_id": id, "battle_id": battle_id, "beneficiary": payout.beneficiary, "amount": q }),
        );
        self.check_invariant();
        payout
    }

    /// Records a broadcast transaction hash for a reserved payout. The payout
    /// remains unconfirmed until final matching execution evidence.
    pub fn mark_broadcast(&mut self, payout_id: u64, tx_hash: String) {
        self.assert_verifier();
        let mut payout = self
            .payouts
            .get(&payout_id)
            .cloned()
            .expect("Unknown payout");
        require!(
            matches!(payout.status, PayoutStatus::Reserved),
            "Payout not reserved"
        );
        payout.status = PayoutStatus::Broadcast;
        payout.tx_hash = Some(tx_hash.clone());
        self.payouts.insert(payout_id, payout);
        emit(
            "payout_broadcast",
            json!({ "payout_id": payout_id, "tx_hash": tx_hash }),
        );
    }

    /// Confirms a payout after matching finalized execution evidence:
    /// `B - q` and `P - q` together. Replay is refused and a confirmed payout
    /// is never re-spent.
    pub fn confirm_payout(&mut self, payout_id: u64, evidence: Evidence) {
        self.assert_verifier();
        self.assert_active();
        let payout = self
            .payouts
            .get(&payout_id)
            .cloned()
            .expect("Unknown payout");
        require!(
            !matches!(payout.status, PayoutStatus::Confirmed),
            "Already confirmed"
        );
        require!(evidence.success, "Evidence does not confirm execution");

        self.set_custody(
            self.ledger_custody()
                .checked_sub(payout.amount.0)
                .expect("B underflow"),
        );
        self.payouts_pending = self
            .payouts_pending
            .checked_sub(payout.amount.0)
            .expect("P underflow");
        let mut payout = payout;
        payout.status = PayoutStatus::Confirmed;
        payout.confirmed = Some(evidence);
        self.payouts.insert(payout_id, payout.clone());

        emit(
            "payout_confirmed",
            json!({ "payout_id": payout_id, "amount": payout.amount.0 }),
        );
        self.check_invariant();
    }

    /// Definitively fails a payout when reconciliation proves no executable
    /// transaction remains; the reservation is restored to the entitlement
    /// exactly once: `P -> E`. Payroll with a confirmed counterpart never
    /// restores.
    pub fn fail_payout(&mut self, payout_id: u64, evidence: Evidence) {
        self.assert_verifier();
        self.assert_active();
        let payout = self
            .payouts
            .get(&payout_id)
            .cloned()
            .expect("Unknown payout");
        require!(
            !matches!(payout.status, PayoutStatus::Confirmed),
            "Confirmed payout"
        );
        require!(
            !evidence.success || !evidence.executed_movement,
            "Movement happened"
        );

        let key = (payout.battle_id, payout.beneficiary.clone());
        let entitled = self.entitlements.get(&key).copied().unwrap_or(0);
        self.entitlements.insert(
            key,
            entitled.checked_add(payout.amount.0).expect("E overflow"),
        );
        self.entitlements_total = self
            .entitlements_total
            .checked_add(payout.amount.0)
            .expect("E overflow");
        self.payouts_pending = self
            .payouts_pending
            .checked_sub(payout.amount.0)
            .expect("P underflow");

        let mut payout = payout;
        payout.status = PayoutStatus::Failed;
        payout.confirmed = Some(evidence);
        let restored = payout.amount.0;
        self.payouts.insert(payout_id, payout);

        emit(
            "payout_failed",
            json!({ "payout_id": payout_id, "restored": restored }),
        );
        self.check_invariant();
    }

    // ─── Redemption of unlocked representations ──────────────────────────

    /// Reserves a redemption of `q` unlocked representations: `M -> P`.
    /// The actual source transfer must be confirmed before backing is
    /// consumed. If it fails without chain movement, `fail_payout` restores
    /// the representation (`P -> M`).
    pub fn reserve_redemption(&mut self, q: U128) -> Payout {
        self.assert_active();
        let q = q.0;
        require!(q > 0, "Zero redemption");
        let caller = env::predecessor_account_id();
        self.burn_representations(&caller, q, "redemption");

        let id = self.payout_count;
        self.payout_count = self.payout_count.checked_add(1).expect("payout count");
        let payout = Payout {
            id,
            battle_id: u64::MAX,
            beneficiary: caller,
            amount: U128(q),
            kind: PayoutKind::Redemption,
            nonce: id,
            status: PayoutStatus::Reserved,
            tx_hash: None,
            confirmed: None,
        };
        self.payouts_pending = self.payouts_pending.checked_add(q).expect("P overflow");
        self.payouts.insert(id, payout.clone());
        emit(
            "redemption_reserved",
            json!({ "payout_id": id, "amount": q }),
        );
        self.check_invariant();
        payout
    }

    // ─── DAO-directed disposal ───────────────────────────────────────────

    /// Reserves escrowed representations for a verified underlying disposal:
    /// `M -> D`. The same backing can then not be returned or redeemed.
    pub fn reserve_disposal(&mut self, battle_id: u64, q: U128, kind: DisposalKind) -> Disposal {
        self.assert_arena();
        self.assert_active();
        let q = q.0;
        require!(q > 0, "Zero disposal");
        let arena = self.arena.clone().expect("arena configured");
        self.burn_representations(&arena, q, "disposal");

        let id = self.disposal_count;
        self.disposal_count = self.disposal_count.checked_add(1).expect("disposal count");
        let disposal = Disposal {
            id,
            battle_id,
            amount: U128(q),
            kind,
            confirmed: None,
        };
        self.disposals_pending = self.disposals_pending.checked_add(q).expect("D overflow");
        self.disposals.insert(id, disposal.clone());
        emit(
            "disposal_reserved",
            json!({ "disposal_id": id, "battle_id": battle_id, "amount": q, "kind": kind }),
        );
        self.check_invariant();
        disposal
    }

    /// Confirms a reserved disposal after verified underlying burn/sink or
    /// return: `B - q` and `D - q`. Representation destruction alone never
    /// confirms disposal.
    pub fn confirm_disposal(&mut self, disposal_id: u64, evidence: Evidence) {
        self.assert_verifier();
        self.assert_active();
        let disposal = self
            .disposals
            .get(&disposal_id)
            .cloned()
            .expect("Unknown disposal");
        require!(disposal.confirmed.is_none(), "Already confirmed");
        require!(evidence.success, "Evidence does not confirm disposal");

        self.set_custody(
            self.ledger_custody()
                .checked_sub(disposal.amount.0)
                .expect("B underflow"),
        );
        self.disposals_pending = self
            .disposals_pending
            .checked_sub(disposal.amount.0)
            .expect("D underflow");
        let mut disposal = disposal;
        disposal.confirmed = Some(evidence);
        self.disposals.insert(disposal_id, disposal.clone());
        emit(
            "disposal_confirmed",
            json!({ "disposal_id": disposal_id, "amount": disposal.amount.0 }),
        );
        self.check_invariant();
    }

    // ─── NEP-141 representation views and transfers ──────────────────────

    pub fn ledger(&self) -> LedgerView {
        let m = self.token.total_supply;
        let e = self.entitlements_total;
        let p = self.payouts_pending;
        let d = self.disposals_pending;
        let u = self.unallocated_total;
        LedgerView {
            custody: U128(self.ledger_custody()),
            supply: U128(m),
            entitlements: U128(e),
            payouts_reserved: U128(p),
            disposals_reserved: U128(d),
            unallocated: U128(u),
            residual: U128(self.residual_total),
            invariant_holds: self.ledger_custody()
                == m.saturating_add(e)
                    .saturating_add(p)
                    .saturating_add(d)
                    .saturating_add(u),
        }
    }

    pub fn unallocated_of(&self, account_id: AccountId) -> U128 {
        U128(self.unallocated.get(&account_id).copied().unwrap_or(0))
    }

    pub fn residual_of(&self, account_id: AccountId) -> U128 {
        U128(self.residual.get(&account_id).copied().unwrap_or(0))
    }

    pub fn entitlement_of(&self, battle_id: u64, account_id: AccountId) -> U128 {
        U128(
            self.entitlements
                .get(&(battle_id, account_id))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn payout(&self, payout_id: u64) -> Option<Payout> {
        self.payouts.get(&payout_id).cloned()
    }

    pub fn disposal(&self, disposal_id: u64) -> Option<Disposal> {
        self.disposals.get(&disposal_id).cloned()
    }

    pub fn asset(&self) -> AssetIdentity {
        self.identity.clone()
    }

    pub fn custody_balance(&self) -> U128 {
        U128(self.ledger_custody())
    }

    // ─── Internals ───────────────────────────────────────────────────────

    fn burn_representations(&mut self, account: &AccountId, q: u128, what: &str) {
        let zero = format!("Zero {what}");
        let short = format!("Insufficient representations for {what}");
        require!(q > 0, &zero);
        let held = self.token.accounts.get(account).unwrap_or(0);
        require!(held >= q, &short);
        self.token.internal_withdraw(account, q);
    }

    fn set_custody(&mut self, value: u128) {
        self.custody = value;
    }

    fn ledger_custody(&self) -> u128 {
        self.custody
    }

    fn check_invariant(&self) {
        let m = self.token.total_supply;
        let e = self.entitlements_total;
        let p = self.payouts_pending;
        let d = self.disposals_pending;
        let u = self.unallocated_total;
        require!(
            self.custody == m + e + p + d + u,
            "Liability ledger invariant broken"
        );
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    fn assert_verifier(&self) {
        require!(
            env::predecessor_account_id() == self.verifier,
            "Verifier only"
        );
    }

    fn assert_arena(&self) {
        let arena = self.arena.clone().expect("Arena not configured");
        require!(env::predecessor_account_id() == arena, "Arena only");
    }

    fn assert_active(&self) {
        require!(!self.paused, "Contract paused");
    }
}

/// Exact decimal normalization between source and representation units.
/// Never rounds up: unrepresentable source residue is returned as residue.
pub fn normalize(src_amount: u128, src_decimals: u8, rep_decimals: u8) -> (u128, u128) {
    if src_decimals == rep_decimals {
        return (src_amount, 0);
    }
    let src: u128 = 10u128.checked_pow(src_decimals as u32).expect("scale");
    let rep: u128 = 10u128.checked_pow(rep_decimals as u32).expect("scale");
    if rep_decimals >= src_decimals {
        let factor = rep / src;
        match src_amount.checked_mul(factor) {
            Some(q) => (q, 0),
            None => env::panic_str("Normalization overflow"),
        }
    } else {
        let factor = src / rep;
        (src_amount / factor, src_amount % factor)
    }
}

#[near]
impl FungibleTokenCore for Backing {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
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
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        U128(self.token.total_supply)
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.token.accounts.get(&account_id).unwrap_or(0))
    }
}

#[near]
impl FungibleTokenResolver for Backing {
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
        self.token.storage_unregister(force)
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

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use near_sdk::NearToken;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn acc(name: &str) -> AccountId {
        format!("{name}.testnet").parse().unwrap()
    }

    fn identity() -> AssetIdentity {
        AssetIdentity {
            chain_id: 46630,
            token_address: "0xrobinhoodtoken".to_string(),
            custody_domain: "custody.rh.testnet".to_string(),
            decimals: 8,
            symbol: "rB".to_string(),
            name: "Robinhood B".to_string(),
        }
    }

    fn receipt(tx: &str) -> ReceiptId {
        ReceiptId {
            chain_id: 46630,
            tx_hash: tx.to_string(),
            log_index: 0,
        }
    }

    fn context(account: &str, deposit: NearToken) -> VMContextBuilder {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(acc(account))
            .current_account_id(acc("backing"))
            .attached_deposit(deposit);
        ctx
    }

    #[test]
    fn normalize_scales_down_and_keeps_residue() {
        let (q, residue) = normalize(123_456_789_000_000_000, 18, 8);
        assert_eq!(q, 12_345_678);
        assert_eq!(residue, 9_000_000_000);
    }

    #[test]
    fn normalize_scales_up_exactly() {
        let (q, residue) = normalize(1_000_000, 6, 8);
        assert_eq!(q, 100_000_000);
        assert_eq!(residue, 0);
    }

    #[test]
    fn verify_and_claim_mint_once_with_replay_protection() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x1"), U128(98_000_000), 6, acc("alice"));
        assert_eq!(contract.custody_balance(), U128(9_800_000_000));

        testing_env!(context("alice", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("alice"), U128(9_800_000_000));
        assert_eq!(contract.ft_balance_of(acc("alice")), U128(9_800_000_000));
        assert_eq!(contract.unallocated_of(acc("alice")), U128(0));

        let view = contract.ledger();
        assert!(view.invariant_holds);
        assert_eq!(view.supply, U128(9_800_000_000));
        assert_eq!(view.unallocated, U128(0));
    }

    #[test]
    fn receipt_replay_is_refused() {
        testing_env!(context("verifier", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.verify_receipt(receipt("0x1"), U128(100), 6, acc("alice"));
        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.verify_receipt(receipt("0x1"), U128(100), 6, acc("alice"))
        }));
        assert!(result.is_err());
        assert_eq!(contract.ledger().custody, U128(10_000));
    }

    #[test]
    fn decimal_residue_never_minted() {
        testing_env!(context("verifier", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.verify_receipt(
            receipt("0x2"),
            U128(123_456_789_000_000_000),
            18,
            acc("bob"),
        );
        assert_eq!(contract.ledger().custody, U128(12_345_678));
        assert_eq!(contract.residual_of(acc("bob")), U128(9_000_000_000));

        testing_env!(context("bob", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("bob"), U128(12_345_678));
        assert_eq!(contract.ft_balance_of(acc("bob")), U128(12_345_678));
        assert!(contract.ledger().invariant_holds);
    }

    #[test]
    fn allocation_converts_vault_to_entitlements_once() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x3"), U128(1_000_000), 6, acc("arena"));

        testing_env!(context("arena", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("arena"), U128(100_000_000));
        contract.allocate_to_entitlements(
            1,
            vec![
                (acc("alice"), U128(59_940_000)),
                (acc("bob"), U128(39_960_000)),
                (acc("creator"), U128(50_000)),
                (acc("protocol"), U128(50_000)),
            ],
        );

        assert_eq!(contract.entitlement_of(1, acc("alice")), U128(59_940_000));
        assert_eq!(contract.ft_balance_of(acc("arena")), U128(0));
        assert_eq!(contract.ft_total_supply(), U128(0));

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.allocate_to_entitlements(1, vec![(acc("alice"), U128(1))])
        }));
        assert!(result.is_err());
        assert!(contract.ledger().invariant_holds);
    }

    #[test]
    fn reserve_and_confirm_payout_consumes_backing_once() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x4"), U128(1_000_000), 6, acc("arena"));
        testing_env!(context("arena", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("arena"), U128(100_000_000));
        contract.allocate_to_entitlements(2, vec![(acc("alice"), U128(100_000_000))]);

        let payout = contract.reserve_payout(2, acc("alice"), U128(60_000_000), PayoutKind::Reward);
        assert_eq!(contract.entitlement_of(2, acc("alice")), U128(40_000_000));

        let double = catch_unwind(AssertUnwindSafe(|| {
            contract.reserve_payout(2, acc("alice"), U128(60_000_000), PayoutKind::Reward)
        }));
        assert!(double.is_err());

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.mark_broadcast(payout.id, "0xabc".to_string());
        contract.confirm_payout(
            payout.id,
            Evidence {
                success: true,
                executed_movement: true,
                chain_id: 46630,
                tx_hash: "0xabc".to_string(),
                finality: "final".to_string(),
            },
        );
        assert_eq!(contract.ledger().custody, U128(40_000_000));
        assert_eq!(contract.ledger().payouts_reserved, U128(0));
        assert!(contract.ledger().invariant_holds);

        let again = catch_unwind(AssertUnwindSafe(|| {
            contract.confirm_payout(
                payout.id,
                Evidence {
                    success: true,
                    executed_movement: true,
                    chain_id: 46630,
                    tx_hash: "0xabc".to_string(),
                    finality: "final".to_string(),
                },
            )
        }));
        assert!(again.is_err());
    }

    #[test]
    fn failed_payout_restores_entitlement_exactly_once() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x5"), U128(1_000_000), 6, acc("arena"));
        testing_env!(context("arena", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("arena"), U128(100_000_000));
        contract.allocate_to_entitlements(3, vec![(acc("alice"), U128(100_000_000))]);
        let payout = contract.reserve_payout(3, acc("alice"), U128(40_000_000), PayoutKind::Reward);

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.fail_payout(
            payout.id,
            Evidence {
                success: false,
                executed_movement: false,
                chain_id: 46630,
                tx_hash: "".to_string(),
                finality: "final".to_string(),
            },
        );
        assert_eq!(contract.entitlement_of(3, acc("alice")), U128(100_000_000));
        assert_eq!(contract.ledger().payouts_reserved, U128(0));
        assert!(contract.ledger().invariant_holds);
    }

    #[test]
    fn redemption_reserves_then_confirms() {
        testing_env!(context("verifier", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.verify_receipt(receipt("0x6"), U128(1_000_000), 6, acc("carol"));
        testing_env!(context("carol", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("carol"), U128(100_000_000));

        let redemption = contract.reserve_redemption(U128(30_000_000));
        assert_eq!(contract.ft_balance_of(acc("carol")), U128(70_000_000));
        assert_eq!(contract.ledger().payouts_reserved, U128(30_000_000));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.confirm_payout(
            redemption.id,
            Evidence {
                success: true,
                executed_movement: true,
                chain_id: 46630,
                tx_hash: "0xdef".to_string(),
                finality: "final".to_string(),
            },
        );
        assert_eq!(contract.ledger().custody, U128(70_000_000));
        assert!(contract.ledger().invariant_holds);
    }

    #[test]
    fn competing_reservation_blocks_double_spend() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x7"), U128(1_000_000), 6, acc("arena"));
        testing_env!(context("arena", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("arena"), U128(100_000_000));
        contract.allocate_to_entitlements(4, vec![(acc("alice"), U128(100_000_000))]);

        contract.reserve_payout(4, acc("alice"), U128(100_000_000), PayoutKind::Reward);
        let second = catch_unwind(AssertUnwindSafe(|| {
            contract.reserve_payout(4, acc("alice"), U128(1), PayoutKind::Reward)
        }));
        assert!(second.is_err());
        let disposal_race = catch_unwind(AssertUnwindSafe(|| {
            contract.reserve_disposal(4, U128(50_000_000), DisposalKind::Burn)
        }));
        assert!(disposal_race.is_err());
    }

    #[test]
    fn disposal_reserve_and_confirm() {
        testing_env!(context("owner", NearToken::from_near(1)).build());
        let mut contract = Backing::new(acc("owner"), acc("verifier"), identity());
        contract.set_arena(Some(acc("arena")));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.verify_receipt(receipt("0x8"), U128(1_000_000), 6, acc("arena"));
        testing_env!(context("arena", NearToken::from_near(1)).build());
        contract.claim_deposit(acc("arena"), U128(100_000_000));

        let disposal = contract.reserve_disposal(5, U128(60_000_000), DisposalKind::Burn);
        assert_eq!(contract.ft_balance_of(acc("arena")), U128(40_000_000));
        assert_eq!(contract.ledger().disposals_reserved, U128(60_000_000));

        testing_env!(context("verifier", NearToken::from_near(1)).build());
        contract.confirm_disposal(
            disposal.id,
            Evidence {
                success: true,
                executed_movement: true,
                chain_id: 46630,
                tx_hash: "0xfee".to_string(),
                finality: "final".to_string(),
            },
        );
        assert_eq!(contract.ledger().custody, U128(40_000_000));
        assert!(contract.ledger().invariant_holds);
    }
}
