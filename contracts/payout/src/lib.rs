//! Reservation-bound payout identity, constrained signing and reconciliation.
//!
//! Pure state machine for one original-token payout. It decides which
//! transitions are allowed; it does not call the signer, a source-chain RPC or
//! a backing contract, and it does not authenticate who supplies evidence. A
//! contract adapter must do all of those before calling it. Evidence here is a
//! trusted-operator attestation of finalized source-chain state, not a proof.
use near_sdk::{env, near, AccountId};

pub mod contract;

pub type Hash = [u8; 32];

/// Globally unambiguous payout identity: it commits to the backing contract,
/// the holder and the backing's local reservation id, so two backings issuing
/// the same local id never share an identity.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct PayoutId(pub Hash);

fn length_prefixed(out: &mut Vec<u8>, part: &[u8]) {
    out.extend_from_slice(&(part.len() as u32).to_be_bytes());
    out.extend_from_slice(part);
}

impl PayoutId {
    /// Identity of the payout for a backing contract, holder and the backing's
    /// local request id. It does not depend on any other payout parameter.
    pub fn derive(backing: &AccountId, holder: &AccountId, request_id: &Hash) -> Self {
        let mut data = b"valtrum/payout/v1".to_vec();
        length_prefixed(&mut data, backing.as_str().as_bytes());
        length_prefixed(&mut data, holder.as_str().as_bytes());
        length_prefixed(&mut data, request_id);
        PayoutId(env::sha256_array(&data))
    }
}

/// Everything a signature may authorize. It is built from an exclusive backing
/// reservation, never from relayer-supplied parameters.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authorization {
    pub backing: AccountId,
    pub holder: AccountId,
    pub request_id: Hash,
    pub chain_id: u64,
    pub token: [u8; 20],
    /// Custody account that signs and pays, derived from `path`.
    pub sender: [u8; 20],
    pub destination: [u8; 20],
    pub amount: u128,
    pub path: String,
    pub nonce: u64,
}

impl Authorization {
    pub fn id(&self) -> PayoutId {
        PayoutId::derive(&self.backing, &self.holder, &self.request_id)
    }

    /// Commitment to every immutable spend parameter. Gas pricing is excluded
    /// so a same-nonce replacement keeps the binding.
    pub fn binding_hash(&self) -> Hash {
        let mut data = b"valtrum/payout-binding/v1".to_vec();
        length_prefixed(&mut data, &self.id().0);
        length_prefixed(&mut data, &self.chain_id.to_be_bytes());
        length_prefixed(&mut data, &self.token);
        length_prefixed(&mut data, &self.sender);
        length_prefixed(&mut data, &self.destination);
        length_prefixed(&mut data, &self.amount.to_be_bytes());
        length_prefixed(&mut data, self.path.as_bytes());
        length_prefixed(&mut data, &self.nonce.to_be_bytes());
        env::sha256_array(&data)
    }

    fn is_valid(&self) -> bool {
        self.request_id != [0; 32]
            && self.chain_id > 0
            && self.token != [0; 20]
            && self.sender != [0; 20]
            && self.destination != [0; 20]
            && self.amount > 0
            && !self.path.trim().is_empty()
            && self.path.len() <= 256
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptState {
    Signed,
    Broadcast,
    /// Finalized with failure: the nonce is consumed and no token moved.
    Reverted,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub tx_hash: Hash,
    pub max_fee_per_gas: u128,
    pub state: AttemptState,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SignerNoResponse,
    BroadcastUnconfirmed,
    EvidenceUnavailable,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Reserved and authorized; nothing has been requested from the signer.
    Authorized,
    /// A signature was requested. It may exist even if the response was lost.
    SigningRequested,
    /// At least one signed attempt exists and none is finalized.
    Signed,
    Broadcast,
    /// Unresolved: stays reserved and may not be restored or duplicated.
    ReconciliationRequired(Reason),
    Confirmed {
        evidence_hash: Hash,
    },
    /// Definitively no spend remains; the reservation may be released.
    Restored,
}

/// Attested facts about the paying transfer on the source chain.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentEvidence {
    pub chain_id: u64,
    pub token: [u8; 20],
    pub sender: [u8; 20],
    pub recipient: [u8; 20],
    pub amount: u128,
    pub tx_hash: Hash,
    pub log_index: u32,
    pub block_hash: Hash,
    pub finalized_head_number: u64,
    pub finalized_head_hash: Hash,
    pub block_number: u64,
    pub evidence_hash: Hash,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlotOutcome {
    /// One of our attempts finalized with failure.
    OurTxReverted(Hash),
    /// A transaction we never produced consumed the nonce.
    ForeignTx(Hash),
    /// One of our attempts executed; this is a spend and must be confirmed.
    OurTxSucceeded(Hash),
}

/// Attested proof about the nonce slot of the custody sender.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoSpendProof {
    pub chain_id: u64,
    pub sender: [u8; 20],
    /// The sender's transaction count at the finalized head.
    pub finalized_nonce: u64,
    pub outcome: SlotOutcome,
    pub finalized_head_number: u64,
    pub finalized_head_hash: Hash,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutError {
    InvalidAuthorization,
    /// A different authorization already exists for this payout identity.
    Conflict,
    /// Signature, broadcast or evidence does not match the bound parameters.
    Tamper,
    UnknownAttempt,
    WrongState,
    Closed,
    EvidenceMismatch,
    /// Replacement must use the same nonce and a strictly higher fee.
    InvalidReplacement,
    /// Not enough proof to release; the reservation stays.
    NotProven,
    /// The proof shows a successful spend; confirm it instead.
    MustConfirm,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub authorization: Authorization,
    pub binding_hash: Hash,
    pub status: Status,
    pub attempts: Vec<Attempt>,
}

impl Payout {
    /// Create or idempotently re-observe the payout for an authorization.
    pub fn authorize(authorization: Authorization) -> Result<Self, PayoutError> {
        if !authorization.is_valid() {
            return Err(PayoutError::InvalidAuthorization);
        }
        let binding_hash = authorization.binding_hash();
        Ok(Self {
            authorization,
            binding_hash,
            status: Status::Authorized,
            attempts: Vec::new(),
        })
    }

    pub fn id(&self) -> PayoutId {
        self.authorization.id()
    }

    /// A repeat authorization with identical parameters is harmless; any
    /// difference for the same identity is a conflict, never an overwrite.
    pub fn matches(&self, authorization: &Authorization) -> Result<(), PayoutError> {
        if authorization == &self.authorization {
            Ok(())
        } else {
            Err(PayoutError::Conflict)
        }
    }

    fn open(&self) -> Result<(), PayoutError> {
        match self.status {
            Status::Confirmed { .. } | Status::Restored => Err(PayoutError::Closed),
            _ => Ok(()),
        }
    }

    /// Mark that the signer is about to be asked. After this, an unanswered
    /// request cannot be treated as "nothing was signed".
    pub fn request_signature(&mut self) -> Result<bool, PayoutError> {
        self.open()?;
        match self.status {
            Status::Authorized => {
                self.status = Status::SigningRequested;
                Ok(true)
            }
            Status::SigningRequested => Ok(false),
            _ => Err(PayoutError::WrongState),
        }
    }

    /// Record a signed transaction. It must carry this payout's binding hash.
    /// A same-hash repeat is idempotent; a different hash is a same-nonce
    /// replacement and needs a strictly higher fee than every earlier attempt.
    pub fn record_signature(
        &mut self,
        tx_hash: Hash,
        binding_hash: Hash,
        max_fee_per_gas: u128,
    ) -> Result<bool, PayoutError> {
        self.open()?;
        if binding_hash != self.binding_hash || tx_hash == [0; 32] {
            return Err(PayoutError::Tamper);
        }
        if matches!(self.status, Status::Authorized) {
            return Err(PayoutError::WrongState);
        }
        if self.attempts.iter().any(|a| a.tx_hash == tx_hash) {
            return Ok(false);
        }
        if self
            .attempts
            .iter()
            .any(|a| a.max_fee_per_gas >= max_fee_per_gas)
        {
            return Err(PayoutError::InvalidReplacement);
        }
        self.attempts.push(Attempt {
            tx_hash,
            max_fee_per_gas,
            state: AttemptState::Signed,
        });
        if matches!(self.status, Status::SigningRequested) {
            self.status = Status::Signed;
        }
        Ok(true)
    }

    pub fn record_broadcast(&mut self, tx_hash: Hash) -> Result<bool, PayoutError> {
        self.open()?;
        let attempt = self
            .attempts
            .iter_mut()
            .find(|a| a.tx_hash == tx_hash)
            .ok_or(PayoutError::UnknownAttempt)?;
        if attempt.state == AttemptState::Broadcast {
            return Ok(false);
        }
        if attempt.state == AttemptState::Reverted {
            return Err(PayoutError::WrongState);
        }
        attempt.state = AttemptState::Broadcast;
        self.status = Status::Broadcast;
        Ok(true)
    }

    /// Timeouts and lost responses hold the reservation; they never release it.
    pub fn require_reconciliation(&mut self, reason: Reason) -> Result<(), PayoutError> {
        self.open()?;
        if matches!(self.status, Status::Authorized) {
            return Err(PayoutError::WrongState);
        }
        self.status = Status::ReconciliationRequired(reason);
        Ok(())
    }

    /// Mark an attempt as finalized-with-failure from attested evidence.
    pub fn record_revert(&mut self, tx_hash: Hash) -> Result<(), PayoutError> {
        self.open()?;
        let attempt = self
            .attempts
            .iter_mut()
            .find(|a| a.tx_hash == tx_hash)
            .ok_or(PayoutError::UnknownAttempt)?;
        attempt.state = AttemptState::Reverted;
        Ok(())
    }

    /// Confirm only when the attested transfer matches every bound parameter
    /// exactly and belongs to one of our attempts. A signature, broadcast,
    /// partial amount or foreign transfer never confirms and changes nothing.
    pub fn confirm(&mut self, evidence: &PaymentEvidence) -> Result<bool, PayoutError> {
        if let Status::Confirmed { evidence_hash } = self.status {
            return if evidence_hash == evidence.evidence_hash {
                Ok(false)
            } else {
                Err(PayoutError::EvidenceMismatch)
            };
        }
        self.open()?;
        let a = &self.authorization;
        if evidence.chain_id != a.chain_id
            || evidence.token != a.token
            || evidence.sender != a.sender
            || evidence.recipient != a.destination
            || evidence.amount != a.amount
            || evidence.block_hash == [0; 32]
            || evidence.evidence_hash == [0; 32]
            || evidence.finalized_head_hash == [0; 32]
            || evidence.block_number > evidence.finalized_head_number
        {
            return Err(PayoutError::EvidenceMismatch);
        }
        let attempt = self
            .attempts
            .iter()
            .find(|attempt| attempt.tx_hash == evidence.tx_hash)
            .ok_or(PayoutError::EvidenceMismatch)?;
        if attempt.state == AttemptState::Reverted {
            return Err(PayoutError::EvidenceMismatch);
        }
        self.status = Status::Confirmed {
            evidence_hash: evidence.evidence_hash,
        };
        Ok(true)
    }

    /// Release the liability only when no executable transaction can remain.
    /// Before anything was requested from the signer the payout may simply be
    /// cancelled; afterwards a finalized nonce slot must prove no spend.
    pub fn restore(&mut self, proof: Option<&NoSpendProof>) -> Result<(), PayoutError> {
        self.open()?;
        let Some(proof) = proof else {
            return if matches!(self.status, Status::Authorized) && self.attempts.is_empty() {
                self.status = Status::Restored;
                Ok(())
            } else {
                Err(PayoutError::NotProven)
            };
        };
        if proof.chain_id != self.authorization.chain_id
            || proof.sender != self.authorization.sender
            || proof.finalized_head_hash == [0; 32]
            || proof.finalized_nonce <= self.authorization.nonce
        {
            return Err(PayoutError::NotProven);
        }
        match &proof.outcome {
            SlotOutcome::OurTxSucceeded(_) => return Err(PayoutError::MustConfirm),
            SlotOutcome::OurTxReverted(hash) => {
                if !self.attempts.iter().any(|a| &a.tx_hash == hash) {
                    return Err(PayoutError::NotProven);
                }
            }
            SlotOutcome::ForeignTx(hash) => {
                if self.attempts.iter().any(|a| &a.tx_hash == hash) {
                    return Err(PayoutError::NotProven);
                }
            }
        }
        self.status = Status::Restored;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }
    fn auth(backing: &str, request: u8) -> Authorization {
        Authorization {
            backing: account(backing),
            holder: account("alice.testnet"),
            request_id: [request; 32],
            chain_id: 46630,
            token: [1; 20],
            sender: [2; 20],
            destination: [3; 20],
            amount: 98,
            path: "custody-1".into(),
            nonce: 5,
        }
    }
    fn evidence(tx: u8) -> PaymentEvidence {
        PaymentEvidence {
            chain_id: 46630,
            token: [1; 20],
            sender: [2; 20],
            recipient: [3; 20],
            amount: 98,
            tx_hash: [tx; 32],
            log_index: 0,
            block_hash: [8; 32],
            finalized_head_number: 12,
            finalized_head_hash: [9; 32],
            block_number: 10,
            evidence_hash: [7; 32],
        }
    }
    fn signed(tx: u8, fee: u128) -> Payout {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("authorize");
        payout.request_signature().expect("request");
        let binding = payout.binding_hash;
        payout
            .record_signature([tx; 32], binding, fee)
            .expect("sign");
        payout
    }

    #[test]
    fn two_backings_with_the_same_local_id_never_collide() {
        let (first, second) = (auth("a.testnet", 1), auth("b.testnet", 1));
        assert_ne!(first.id(), second.id());
        assert_ne!(first.binding_hash(), second.binding_hash());
        // Splitting the same characters between fields cannot forge an identity.
        let mut shifted = auth("a.testnet", 1);
        shifted.backing = account("a.testne");
        shifted.holder = account("talice.testnet");
        assert_ne!(first.id(), shifted.id());
        let mut other_holder = auth("a.testnet", 1);
        other_holder.holder = account("bob.testnet");
        assert_ne!(first.id(), other_holder.id());
    }

    #[test]
    fn invalid_authorizations_and_conflicting_repeats_are_rejected() {
        let mut bad = auth("a.testnet", 1);
        bad.amount = 0;
        assert_eq!(
            Payout::authorize(bad),
            Err(PayoutError::InvalidAuthorization)
        );
        let mut bad = auth("a.testnet", 1);
        bad.destination = [0; 20];
        assert_eq!(
            Payout::authorize(bad),
            Err(PayoutError::InvalidAuthorization)
        );
        let payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        assert_eq!(payout.matches(&auth("a.testnet", 1)), Ok(()));
        let mut changed = auth("a.testnet", 1);
        changed.amount = 99;
        assert_eq!(payout.matches(&changed), Err(PayoutError::Conflict));
    }

    #[test]
    fn changed_recipient_token_amount_chain_path_or_nonce_changes_the_binding() {
        let base = auth("a.testnet", 1).binding_hash();
        let edits: [fn(&mut Authorization); 6] = [
            |a| a.destination = [4; 20],
            |a| a.token = [4; 20],
            |a| a.amount = 99,
            |a| a.chain_id = 1,
            |a| a.path = "other".into(),
            |a| a.nonce = 6,
        ];
        for edit in edits {
            let mut changed = auth("a.testnet", 1);
            edit(&mut changed);
            assert_ne!(changed.binding_hash(), base);
        }
        // A signature whose binding does not match is refused and recorded nowhere.
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature().expect("request");
        let mut tampered = auth("a.testnet", 1);
        tampered.destination = [4; 20];
        assert_eq!(
            payout.record_signature([1; 32], tampered.binding_hash(), 10),
            Err(PayoutError::Tamper)
        );
        assert!(payout.attempts.is_empty());
    }

    #[test]
    fn a_signature_alone_never_confirms_and_signing_needs_a_prior_request() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        let binding = payout.binding_hash;
        assert_eq!(
            payout.record_signature([1; 32], binding, 10),
            Err(PayoutError::WrongState)
        );
        assert_eq!(payout.request_signature(), Ok(true));
        assert_eq!(payout.request_signature(), Ok(false));
        assert_eq!(payout.record_signature([1; 32], binding, 10), Ok(true));
        assert_eq!(payout.record_signature([1; 32], binding, 10), Ok(false));
        assert_eq!(payout.status, Status::Signed);
        assert_eq!(payout.record_broadcast([1; 32]), Ok(true));
        assert_eq!(payout.record_broadcast([1; 32]), Ok(false));
        assert_eq!(payout.status, Status::Broadcast);
        assert!(!matches!(payout.status, Status::Confirmed { .. }));
    }

    #[test]
    fn confirmation_needs_exact_matching_evidence_for_one_of_our_attempts() {
        let mut payout = signed(1, 10);
        payout.record_broadcast([1; 32]).expect("broadcast");
        let edits: [fn(&mut PaymentEvidence); 7] = [
            |e| e.amount = 50,
            |e| e.recipient = [4; 20],
            |e| e.token = [4; 20],
            |e| e.sender = [4; 20],
            |e| e.chain_id = 1,
            |e| e.tx_hash = [9; 32],
            |e| e.block_number = 99,
        ];
        for edit in edits {
            let mut wrong = evidence(1);
            edit(&mut wrong);
            assert_eq!(payout.confirm(&wrong), Err(PayoutError::EvidenceMismatch));
            assert_eq!(payout.status, Status::Broadcast);
        }
        assert_eq!(payout.confirm(&evidence(1)), Ok(true));
        assert_eq!(payout.confirm(&evidence(1)), Ok(false));
        let mut conflicting = evidence(1);
        conflicting.evidence_hash = [6; 32];
        assert_eq!(
            payout.confirm(&conflicting),
            Err(PayoutError::EvidenceMismatch)
        );
        assert_eq!(payout.request_signature(), Err(PayoutError::Closed));
        assert_eq!(payout.restore(None), Err(PayoutError::Closed));
    }

    #[test]
    fn lost_responses_hold_the_reservation_and_replacements_keep_nonce_and_history() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature().expect("request");
        payout
            .require_reconciliation(Reason::SignerNoResponse)
            .expect("hold");
        // A lost signer response may hide a signature: cancelling is not allowed.
        assert_eq!(payout.restore(None), Err(PayoutError::NotProven));
        let binding = payout.binding_hash;
        payout
            .record_signature([1; 32], binding, 10)
            .expect("late signature");
        payout.record_broadcast([1; 32]).expect("broadcast");
        // Same-nonce replacement must pay strictly more; older attempts stay recorded.
        assert_eq!(
            payout.record_signature([2; 32], binding, 10),
            Err(PayoutError::InvalidReplacement)
        );
        assert_eq!(payout.record_signature([2; 32], binding, 11), Ok(true));
        assert_eq!(payout.attempts.len(), 2);
        // Either attempt may be the one that executes.
        assert_eq!(payout.confirm(&evidence(1)), Ok(true));
    }

    #[test]
    fn restoration_requires_a_finalized_nonce_slot_and_never_follows_a_success() {
        let proof = |outcome| NoSpendProof {
            chain_id: 46630,
            sender: [2; 20],
            finalized_nonce: 6,
            outcome,
            finalized_head_number: 12,
            finalized_head_hash: [9; 32],
        };
        // Nothing requested yet: cancellation needs no proof.
        let mut fresh = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        assert_eq!(fresh.restore(None), Ok(()));
        // A timeout alone cannot restore.
        let mut payout = signed(1, 10);
        payout.record_broadcast([1; 32]).expect("broadcast");
        payout
            .require_reconciliation(Reason::BroadcastUnconfirmed)
            .expect("hold");
        assert_eq!(payout.restore(None), Err(PayoutError::NotProven));
        // The slot is not consumed yet.
        let mut early = proof(SlotOutcome::OurTxReverted([1; 32]));
        early.finalized_nonce = 5;
        assert_eq!(payout.restore(Some(&early)), Err(PayoutError::NotProven));
        // Wrong sender or an unknown "our" transaction proves nothing.
        let mut other_sender = proof(SlotOutcome::OurTxReverted([1; 32]));
        other_sender.sender = [4; 20];
        assert_eq!(
            payout.restore(Some(&other_sender)),
            Err(PayoutError::NotProven)
        );
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::OurTxReverted([9; 32])))),
            Err(PayoutError::NotProven)
        );
        // A foreign tx that is actually our attempt is not a foreign slot.
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::ForeignTx([1; 32])))),
            Err(PayoutError::NotProven)
        );
        // A successful spend must be confirmed, not restored.
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::OurTxSucceeded([1; 32])))),
            Err(PayoutError::MustConfirm)
        );
        assert_eq!(
            payout.status,
            Status::ReconciliationRequired(Reason::BroadcastUnconfirmed)
        );
        payout.record_revert([1; 32]).expect("revert");
        assert_eq!(
            payout.record_broadcast([1; 32]),
            Err(PayoutError::WrongState)
        );
        assert_eq!(
            payout.confirm(&evidence(1)),
            Err(PayoutError::EvidenceMismatch)
        );
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::OurTxReverted([1; 32])))),
            Ok(())
        );
        assert_eq!(payout.status, Status::Restored);
        // A foreign transaction consuming the nonce also releases an unexecuted payout.
        let mut replaced = signed(1, 10);
        replaced.record_broadcast([1; 32]).expect("broadcast");
        assert_eq!(
            replaced.restore(Some(&proof(SlotOutcome::ForeignTx([6; 32])))),
            Ok(())
        );
    }
}
