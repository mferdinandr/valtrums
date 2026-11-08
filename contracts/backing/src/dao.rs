//! Release of escrowed winning principal after the DAO vote (decision D22).
//!
//! Only the arena may release escrow, and only into two places:
//! - `release_escrow_return`: an asset-bound entitlement for one winner, paid
//!   later through the normal payout path to that winner's own destination;
//! - `release_escrow_burn`: a disposal reservation bound to the frozen DAO sink
//!   address. The payout contract executes it like any payout; it is confirmed
//!   only by a finalized source-chain debit to the sink, and it can never be
//!   released back into circulation (a failed attempt is retried instead).
//!
//! Every release has a deterministic id from the arena, is recorded at most
//! once, and the sum of releases can never exceed the escrowed amount. Burning
//! the NEAR representations (which already happened when the principal entered
//! escrow) is not evidence that the source token was disposed of.
use crate::reservation::{Reservation, ReservationKind, ReservationStatus};
use crate::{ledger, normalization, Backing, BackingExt, ReservedPayout};
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

/// One release of escrowed principal; `beneficiary` is None for the burn.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowRelease {
    pub escrow_id: [u8; 32],
    pub beneficiary: Option<AccountId>,
    pub amount: U128,
}

/// Running totals per escrow, in representation units.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EscrowProgress {
    pub returned: u128,
    pub burn_reserved: u128,
    pub burn_confirmed: u128,
}

/// Disposition of one escrow. `burn_pending` is reserved for the sink but not
/// yet confirmed by a finalized debit; only `burn_confirmed` is a source burn.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowDispositionView {
    pub battle_id: U64,
    pub community: u32,
    pub escrowed: U128,
    pub returned: U128,
    pub burn_pending: U128,
    pub burn_confirmed: U128,
    pub still_escrowed: U128,
    pub sink: Option<String>,
}

fn hex20(bytes: &[u8; 20]) -> String {
    let mut out = String::from("0x");
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

impl Backing {
    /// Validates a release request and returns the escrow progress to update,
    /// or None for an identical repeat.
    fn check_release(
        &self,
        escrow_id: &[u8; 32],
        release_id: &[u8; 32],
        requested: &EscrowRelease,
    ) -> Option<EscrowProgress> {
        require!(env::predecessor_account_id() == self.arena, "Only arena");
        require!(
            !self.paused && !self.reconciliation_required,
            "Asset paused"
        );
        require!(
            *release_id != [0; 32] && requested.amount.0 > 0,
            "Invalid release"
        );
        if let Some(existing) = self.escrow_releases.get(release_id) {
            require!(existing == requested, "Conflicting release");
            return None;
        }
        let escrow = self
            .principal_escrows
            .get(escrow_id)
            .unwrap_or_else(|| env::panic_str("Unknown escrow"));
        let progress = self
            .escrow_progress
            .get(escrow_id)
            .copied()
            .unwrap_or_default();
        let after = progress
            .returned
            .checked_add(progress.burn_reserved)
            .and_then(|released| released.checked_add(requested.amount.0))
            .unwrap_or_else(|| env::panic_str("Release overflow"));
        require!(after <= escrow.amount.0, "Release exceeds escrow");
        Some(progress)
    }

    fn charge_release_storage(&self, before: u64) {
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(env::storage_usage().saturating_sub(before)))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, "Insufficient storage deposit");
        if attached > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - cost))
                .detach();
        }
    }

    /// True for a disposal reservation created by `release_escrow_burn`.
    pub(crate) fn is_dao_burn(&self, holder: &AccountId, request_id: &[u8; 32]) -> bool {
        *holder == self.arena
            && self
                .escrow_releases
                .get(request_id)
                .is_some_and(|release| release.beneficiary.is_none())
    }

    /// Counts a confirmed DAO burn towards its escrow, once per confirmation.
    pub(crate) fn record_burn_confirmed(&mut self, request_id: &[u8; 32]) {
        let Some(release) = self.escrow_releases.get(request_id).cloned() else {
            return;
        };
        let mut progress = self
            .escrow_progress
            .get(&release.escrow_id)
            .copied()
            .unwrap_or_default();
        progress.burn_confirmed = progress
            .burn_confirmed
            .checked_add(release.amount.0)
            .unwrap_or_else(|| env::panic_str("Burn overflow"));
        self.escrow_progress.insert(release.escrow_id, progress);
    }
}

#[near]
impl Backing {
    /// Owner only, exactly one yocto, once. The Robinhood address that receives
    /// DAO burns of this token (an irrecoverable sink such as 0x...dEaD, checked
    /// by the owner to accept transfers). It can never be changed, so no one can
    /// redirect a burn after a vote. Burns cannot be released until it is set.
    #[payable]
    pub fn set_dao_sink(&mut self, sink: [u8; 20]) {
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        near_sdk::assert_one_yocto();
        require!(sink != [0; 20], "Invalid sink");
        require!(self.dao_sink.is_none(), "DAO sink is already set");
        self.dao_sink = Some(sink);
    }

    pub fn get_dao_sink(&self) -> Option<String> {
        self.dao_sink.as_ref().map(hex20)
    }

    /// Arena only. Turns part of an escrow into an entitlement of `beneficiary`
    /// (a winner's return portion). Idempotent per `release_id`; a repeat with
    /// different data fails; the escrow can never be over-released.
    #[payable]
    pub fn release_escrow_return(
        &mut self,
        escrow_id: [u8; 32],
        release_id: [u8; 32],
        beneficiary: AccountId,
        amount: U128,
    ) -> bool {
        let requested = EscrowRelease {
            escrow_id,
            beneficiary: Some(beneficiary.clone()),
            amount,
        };
        let Some(mut progress) = self.check_release(&escrow_id, &release_id, &requested) else {
            return false;
        };
        let mut next = self.ledger.clone();
        next.move_liability(
            ledger::Bucket::Escrow,
            ledger::Bucket::Entitlements,
            amount.0,
        )
        .unwrap_or_else(|_| env::panic_str("Invalid ledger transition"));
        let balance = self
            .entitlement_balances
            .get(&beneficiary)
            .copied()
            .unwrap_or(0)
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Entitlement overflow"));
        progress.returned = progress
            .returned
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Release overflow"));
        let before = env::storage_usage();
        self.ledger = next;
        self.entitlement_balances.insert(beneficiary, balance);
        self.escrow_releases.insert(release_id, requested);
        self.escrow_progress.insert(escrow_id, progress);
        self.entitlement_balances.flush();
        self.escrow_releases.flush();
        self.escrow_progress.flush();
        self.charge_release_storage(before);
        true
    }

    /// Arena only. Reserves the burn portion of an escrow for one transfer to
    /// the DAO sink. The reservation is held by the arena account under
    /// `release_id`, is executed by the payout contract (`reserve_dao_burn`),
    /// and is consumed only by a finalized debit to the sink. It is never
    /// released back. Idempotent per `release_id`.
    #[payable]
    pub fn release_escrow_burn(
        &mut self,
        escrow_id: [u8; 32],
        release_id: [u8; 32],
        amount: U128,
    ) -> bool {
        let requested = EscrowRelease {
            escrow_id,
            beneficiary: None,
            amount,
        };
        let Some(mut progress) = self.check_release(&escrow_id, &release_id, &requested) else {
            return false;
        };
        let sink = self
            .dao_sink
            .unwrap_or_else(|| env::panic_str("DAO sink not set"));
        let source_amount = normalization::to_source_exact(
            amount.0,
            self.asset.source_decimals,
            self.asset.representation_decimals,
        )
        .unwrap_or_else(|_| env::panic_str("Unrepresentable burn amount"));
        let key = (self.arena.clone(), release_id);
        require!(
            self.reservations.get(&key).is_none(),
            "Reservation id already used"
        );
        let mut next = self.ledger.clone();
        next.move_liability(ledger::Bucket::Escrow, ledger::Bucket::Disposal, amount.0)
            .unwrap_or_else(|_| env::panic_str("Invalid ledger transition"));
        progress.burn_reserved = progress
            .burn_reserved
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("Release overflow"));
        let before = env::storage_usage();
        self.ledger = next;
        self.reservations.insert(
            key,
            Reservation {
                request_id: release_id,
                holder: self.arena.clone(),
                amount: amount.0,
                source_amount,
                destination: sink,
                kind: ReservationKind::Disposal,
                status: ReservationStatus::Reserved,
                unresolved: false,
            },
        );
        self.escrow_releases.insert(release_id, requested);
        self.escrow_progress.insert(escrow_id, progress);
        self.reservations.flush();
        self.escrow_releases.flush();
        self.escrow_progress.flush();
        self.charge_release_storage(before);
        true
    }

    /// Payout authority only. Hands an existing DAO burn reservation to the
    /// payout contract for signing. Nothing is reserved here: the destination
    /// must equal the frozen sink and the amount comes from the reservation.
    pub fn reserve_dao_burn(
        &mut self,
        holder: AccountId,
        request_id: [u8; 32],
        destination: [u8; 20],
    ) -> ReservedPayout {
        self.assert_payout_authority();
        require!(self.is_dao_burn(&holder, &request_id), "Not a DAO burn");
        let item = self
            .reservations
            .get(&(holder, request_id))
            .unwrap_or_else(|| env::panic_str("Reservation missing"));
        require!(item.kind == ReservationKind::Disposal, "Not a DAO burn");
        require!(
            item.destination == destination,
            "Destination is not the sink"
        );
        require!(
            !matches!(item.status, ReservationStatus::Released),
            "Reservation released"
        );
        ReservedPayout {
            created: matches!(item.status, ReservationStatus::Reserved),
            source_amount: U128(item.source_amount),
        }
    }

    /// Disposition of one escrow, or None when it is unknown.
    pub fn get_escrow_disposition(&self, escrow_id: [u8; 32]) -> Option<EscrowDispositionView> {
        let escrow = self.principal_escrows.get(&escrow_id)?;
        let progress = self
            .escrow_progress
            .get(&escrow_id)
            .copied()
            .unwrap_or_default();
        let released = progress.returned.saturating_add(progress.burn_reserved);
        Some(EscrowDispositionView {
            battle_id: escrow.battle_id,
            community: escrow.community,
            escrowed: escrow.amount,
            returned: U128(progress.returned),
            burn_pending: U128(
                progress
                    .burn_reserved
                    .saturating_sub(progress.burn_confirmed),
            ),
            burn_confirmed: U128(progress.burn_confirmed),
            still_escrowed: U128(escrow.amount.0.saturating_sub(released)),
            sink: self.dao_sink.as_ref().map(hex20),
        })
    }

    pub fn get_escrow_release(&self, release_id: [u8; 32]) -> Option<EscrowRelease> {
        self.escrow_releases.get(&release_id).cloned()
    }
}
