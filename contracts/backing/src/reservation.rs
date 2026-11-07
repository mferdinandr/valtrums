//! Durable reservation identity; confirmation and restoration require a future
//! authenticated source-chain reconciliation integration.
use near_sdk::{near, AccountId};

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationKind {
    Redemption,
    Disposal,
    /// Settlement entitlement paid out in the original token.
    Payout,
    /// Late deposit returned to its beneficiary on the source chain.
    Refund,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReservationStatus {
    Reserved,
    Broadcast {
        transaction_hash: [u8; 32],
    },
    Confirmed {
        evidence: FinalizedDebit,
    },
    /// A payout reservation returned to the entitlement after definitive
    /// no-spend proof. Terminal; only the payout authority can cause it.
    Released,
}

/// A verifier must authenticate this evidence and finality before supplying it.
/// This structure alone is not proof of a source-chain transaction.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedDebit {
    pub chain_id: u64,
    pub token_address: String,
    pub custody_domain: String,
    pub destination: [u8; 20],
    pub source_amount: u128,
    pub recipient_received: u128,
    pub transaction_hash: [u8; 32],
    pub log_index: u32,
    pub block_hash: [u8; 32],
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub request_id: [u8; 32],
    pub holder: AccountId,
    pub amount: u128,
    pub source_amount: u128,
    pub destination: [u8; 20],
    pub kind: ReservationKind,
    pub status: ReservationStatus,
    /// Spend cannot be determined; the asset stays suspended until the
    /// reservation is confirmed or released.
    pub unresolved: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationError {
    Paused,
    ZeroAmount,
    UnknownHolder,
    InsufficientBalance,
    UnrepresentableAmount,
    InvalidDestination,
    ConflictingRequest,
    MissingReservation,
    ConflictingBroadcast,
    InvalidTransaction,
    InvalidLedger,
    EvidenceMismatch,
    DebitAlreadyConsumed,
    WrongKind,
    AlreadyConfirmed,
    AlreadyReleased,
}

impl Reservation {
    /// Duplicate broadcast of the same identity is harmless. A replacement
    /// or lost response needs source-chain reconciliation, not a reset.
    pub fn record_broadcast(
        &mut self,
        transaction_hash: [u8; 32],
    ) -> Result<bool, ReservationError> {
        if transaction_hash == [0; 32] {
            return Err(ReservationError::InvalidTransaction);
        }
        match self.status {
            ReservationStatus::Reserved => {
                self.status = ReservationStatus::Broadcast { transaction_hash };
                Ok(true)
            }
            ReservationStatus::Broadcast {
                transaction_hash: existing,
            } if existing == transaction_hash => Ok(false),
            ReservationStatus::Confirmed { ref evidence }
                if evidence.transaction_hash == transaction_hash =>
            {
                Ok(false)
            }
            ReservationStatus::Released => Err(ReservationError::AlreadyReleased),
            ReservationStatus::Broadcast { .. } | ReservationStatus::Confirmed { .. } => {
                Err(ReservationError::ConflictingBroadcast)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn broadcast_retry_never_releases_or_replaces_the_reservation() {
        let mut reservation = Reservation {
            request_id: [1; 32],
            holder: "alice.testnet".parse().expect("account"),
            amount: 7,
            source_amount: 7,
            destination: [9; 20],
            kind: ReservationKind::Redemption,
            status: ReservationStatus::Reserved,
            unresolved: false,
        };
        assert_eq!(
            reservation.record_broadcast([0; 32]),
            Err(ReservationError::InvalidTransaction)
        );
        assert_eq!(reservation.record_broadcast([2; 32]), Ok(true));
        assert_eq!(reservation.record_broadcast([2; 32]), Ok(false));
        assert_eq!(
            reservation.record_broadcast([3; 32]),
            Err(ReservationError::ConflictingBroadcast)
        );
        assert_eq!(reservation.amount, 7);
        assert_eq!(
            reservation.status,
            ReservationStatus::Broadcast {
                transaction_hash: [2; 32]
            }
        );
    }
}
