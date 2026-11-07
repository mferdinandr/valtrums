//! Reservation-bound payout identity, constrained signing and reconciliation.
//!
//! Pure state machine for one original-token payout. It decides which
//! transitions are allowed; it does not call the signer, a source-chain RPC or
//! a backing contract, and it does not authenticate who supplies evidence. A
//! contract adapter must do all of those before calling it. Evidence here is a
//! trusted-operator attestation of finalized source-chain state, not a proof.
use near_sdk::{env, near, AccountId};

pub mod contract;
pub mod evm;

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

    /// The exact transaction a signature may authorize: an ERC-20 `transfer` of
    /// `amount` to `destination` on `token`, zero value, at the bound nonce.
    /// Only the fee and the gas limit are chosen outside the reservation; the
    /// priority fee equals the fee cap, so a higher cap is a strict replacement.
    pub fn transfer_tx(&self, max_fee_per_gas: u128, gas_limit: u64) -> evm::EvmTx {
        evm::EvmTx {
            chain_id: self.chain_id,
            nonce: self.nonce,
            max_priority_fee_per_gas: max_fee_per_gas,
            max_fee_per_gas,
            gas_limit,
            to: self.token,
            value: 0,
            data: evm::erc20_transfer(&self.destination, self.amount),
        }
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

/// Signature of one attempt, kept so the signed transaction can be rebuilt
/// from the reservation instead of being stored whole.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

impl From<evm::EcdsaSignature> for StoredSignature {
    fn from(value: evm::EcdsaSignature) -> Self {
        Self {
            r: value.r,
            s: value.s,
            y_parity: value.y_parity,
        }
    }
}

impl From<StoredSignature> for evm::EcdsaSignature {
    fn from(value: StoredSignature) -> Self {
        Self {
            r: value.r,
            s: value.s,
            y_parity: value.y_parity,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptState {
    /// The signer was asked; no signature has been recorded (`tx_hash` is zero).
    Requested,
    /// The signer answered; nothing is known to be on the network.
    Signed,
    Broadcast,
    /// Seen on the network but not finalized.
    Pending,
    /// Finalized with failure: the nonce is consumed and no token moved.
    Reverted,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    /// Zero while the state is `Requested`.
    pub tx_hash: Hash,
    pub max_fee_per_gas: u128,
    pub state: AttemptState,
    pub signature: Option<StoredSignature>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    SignerNoResponse,
    BroadcastUnconfirmed,
    EvidenceUnavailable,
}

/// Internal status. `Status::state` gives the stable public classification.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Reserved and authorized; nothing has been requested from the signer.
    Authorized,
    /// A signature was requested and the signer callback has not run yet.
    SigningRequested,
    /// The signer answered and at least one signed attempt exists.
    Signed,
    Broadcast,
    /// A transaction was seen on the network and awaits finality.
    PendingFinality,
    /// Every attempt finalized with failure. Awaits a nonce-slot release proof.
    Reverted,
    /// Unresolved: stays reserved and may not be restored or duplicated.
    ReconciliationRequired(Reason),
    Confirmed {
        evidence_hash: Hash,
    },
    /// Definitively no spend remains; the reservation may be released.
    Restored,
}

/// The stable, public payout classification (see `implementation-notes.md`).
/// Variants are only ever added, never renamed or reordered.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutState {
    Authorized,
    SigningRequested,
    Signed,
    Broadcast,
    PendingFinality,
    Reverted,
    ReconciliationRequired,
    Confirmed,
    Restored,
}

impl PayoutState {
    pub fn label(self) -> &'static str {
        match self {
            PayoutState::Authorized => "authorized",
            PayoutState::SigningRequested => "signing_requested",
            PayoutState::Signed => "signed",
            PayoutState::Broadcast => "broadcast",
            PayoutState::PendingFinality => "pending_finality",
            PayoutState::Reverted => "reverted",
            PayoutState::ReconciliationRequired => "reconciliation_required",
            PayoutState::Confirmed => "confirmed",
            PayoutState::Restored => "restored",
        }
    }

    /// Confirmed and restored never change again.
    pub fn is_terminal(self) -> bool {
        matches!(self, PayoutState::Confirmed | PayoutState::Restored)
    }
}

impl Status {
    pub fn state(&self) -> PayoutState {
        match self {
            Status::Authorized => PayoutState::Authorized,
            Status::SigningRequested => PayoutState::SigningRequested,
            Status::Signed => PayoutState::Signed,
            Status::Broadcast => PayoutState::Broadcast,
            Status::PendingFinality => PayoutState::PendingFinality,
            Status::Reverted => PayoutState::Reverted,
            Status::ReconciliationRequired(_) => PayoutState::ReconciliationRequired,
            Status::Confirmed { .. } => PayoutState::Confirmed,
            Status::Restored => PayoutState::Restored,
        }
    }
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
    /// A signer request is already in flight for this payout.
    InFlight,
    TooManyAttempts,
    /// Not enough proof to release; the reservation stays.
    NotProven,
    /// The proof shows a successful spend; confirm it instead.
    MustConfirm,
}

/// At most this many signing attempts are kept per payout.
pub const MAX_ATTEMPTS: usize = 8;

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

    /// Our attempt with a recorded hash (never the zero hash of a request).
    fn signed_attempt_mut(&mut self, tx_hash: &Hash) -> Result<&mut Attempt, PayoutError> {
        if tx_hash == &[0; 32] {
            return Err(PayoutError::UnknownAttempt);
        }
        self.attempts
            .iter_mut()
            .find(|a| &a.tx_hash == tx_hash && a.state != AttemptState::Requested)
            .ok_or(PayoutError::UnknownAttempt)
    }

    fn has_attempt(&self, tx_hash: &Hash) -> bool {
        tx_hash != &[0; 32] && self.attempts.iter().any(|a| &a.tx_hash == tx_hash)
    }

    /// Record that the signer is about to be asked for a transaction with this
    /// fee cap. After this, an unanswered request cannot be treated as "nothing
    /// was signed". The fee must be strictly higher than every earlier attempt,
    /// at most `MAX_ATTEMPTS` are kept, and while a request is unanswered no
    /// other can start unless the payout is explicitly on hold.
    pub fn request_signature(&mut self, max_fee_per_gas: u128) -> Result<(), PayoutError> {
        self.open()?;
        if matches!(self.status, Status::Reverted) {
            return Err(PayoutError::WrongState);
        }
        let unanswered = self
            .attempts
            .iter()
            .any(|a| a.state == AttemptState::Requested);
        if unanswered && !matches!(self.status, Status::ReconciliationRequired(_)) {
            return Err(PayoutError::InFlight);
        }
        if self.attempts.len() >= MAX_ATTEMPTS {
            return Err(PayoutError::TooManyAttempts);
        }
        if max_fee_per_gas == 0
            || self
                .attempts
                .iter()
                .any(|a| a.max_fee_per_gas >= max_fee_per_gas)
        {
            return Err(PayoutError::InvalidReplacement);
        }
        self.attempts.push(Attempt {
            tx_hash: [0; 32],
            max_fee_per_gas,
            state: AttemptState::Requested,
            signature: None,
        });
        self.status = Status::SigningRequested;
        Ok(())
    }

    /// Store the signature the signer returned for the request with this fee.
    /// It is recorded even when a later request already exists: a signature that
    /// reached the chain's history must never be unknown to the payout. A repeat
    /// of a known transaction hash changes nothing.
    pub fn signature_received(
        &mut self,
        max_fee_per_gas: u128,
        tx_hash: Hash,
        signature: StoredSignature,
    ) -> Result<bool, PayoutError> {
        self.open()?;
        if tx_hash == [0; 32] {
            return Err(PayoutError::Tamper);
        }
        let index = self
            .attempts
            .iter()
            .position(|a| {
                a.state == AttemptState::Requested && a.max_fee_per_gas == max_fee_per_gas
            })
            .ok_or(PayoutError::UnknownAttempt)?;
        if self.has_attempt(&tx_hash) {
            self.attempts.remove(index);
            return Ok(false);
        }
        let attempt = &mut self.attempts[index];
        attempt.tx_hash = tx_hash;
        attempt.state = AttemptState::Signed;
        attempt.signature = Some(signature);
        let still_unanswered = self
            .attempts
            .iter()
            .any(|a| a.state == AttemptState::Requested);
        if !still_unanswered
            && matches!(
                self.status,
                Status::SigningRequested | Status::ReconciliationRequired(Reason::SignerNoResponse)
            )
        {
            self.status = Status::Signed;
        }
        Ok(true)
    }

    /// The signer call failed: it produced no signature. The payout is held,
    /// not released, and a new request may follow.
    pub fn signature_failed(&mut self, max_fee_per_gas: u128) -> Result<(), PayoutError> {
        self.open()?;
        let index = self
            .attempts
            .iter()
            .position(|a| {
                a.state == AttemptState::Requested && a.max_fee_per_gas == max_fee_per_gas
            })
            .ok_or(PayoutError::UnknownAttempt)?;
        self.attempts.remove(index);
        if matches!(self.status, Status::SigningRequested) {
            self.status = Status::ReconciliationRequired(Reason::SignerNoResponse);
        }
        Ok(())
    }

    pub fn record_broadcast(&mut self, tx_hash: Hash) -> Result<bool, PayoutError> {
        self.open()?;
        let attempt = self.signed_attempt_mut(&tx_hash)?;
        match attempt.state {
            AttemptState::Broadcast | AttemptState::Pending => return Ok(false),
            AttemptState::Reverted => return Err(PayoutError::WrongState),
            _ => {}
        }
        attempt.state = AttemptState::Broadcast;
        self.status = Status::Broadcast;
        Ok(true)
    }

    /// A broadcast attempt was seen on the network but is not final.
    pub fn record_pending(&mut self, tx_hash: Hash) -> Result<bool, PayoutError> {
        self.open()?;
        let attempt = self.signed_attempt_mut(&tx_hash)?;
        match attempt.state {
            AttemptState::Pending => return Ok(false),
            AttemptState::Broadcast => {}
            _ => return Err(PayoutError::WrongState),
        }
        attempt.state = AttemptState::Pending;
        self.status = Status::PendingFinality;
        Ok(true)
    }

    /// Timeouts and lost responses hold the reservation; they never release it.
    pub fn require_reconciliation(&mut self, reason: Reason) -> Result<(), PayoutError> {
        self.open()?;
        if matches!(self.status, Status::Authorized | Status::Reverted) {
            return Err(PayoutError::WrongState);
        }
        self.status = Status::ReconciliationRequired(reason);
        Ok(())
    }

    /// Mark an attempt as finalized-with-failure from attested evidence. When
    /// no attempt can still execute, the payout becomes `Reverted`.
    pub fn record_revert(&mut self, tx_hash: Hash) -> Result<(), PayoutError> {
        self.open()?;
        self.signed_attempt_mut(&tx_hash)?.state = AttemptState::Reverted;
        if self
            .attempts
            .iter()
            .all(|a| a.state == AttemptState::Reverted)
        {
            self.status = Status::Reverted;
        }
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
            || evidence.tx_hash == [0; 32]
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
            .find(|attempt| {
                attempt.tx_hash == evidence.tx_hash && attempt.state != AttemptState::Requested
            })
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
                if !self.has_attempt(hash) {
                    return Err(PayoutError::NotProven);
                }
            }
            SlotOutcome::ForeignTx(hash) => {
                if hash == &[0; 32] || self.has_attempt(hash) {
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
    fn sig() -> StoredSignature {
        StoredSignature {
            r: [1; 32],
            s: [2; 32],
            y_parity: 0,
        }
    }
    fn signed(tx: u8, fee: u128) -> Payout {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("authorize");
        payout.request_signature(fee).expect("request");
        payout
            .signature_received(fee, [tx; 32], sig())
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
    }

    #[test]
    fn the_transaction_is_rebuilt_from_the_authorization_alone() {
        let a = auth("a.testnet", 1);
        let tx = a.transfer_tx(10, 100_000);
        assert_eq!(tx.to, a.token);
        assert_eq!(tx.chain_id, a.chain_id);
        assert_eq!(tx.nonce, a.nonce);
        assert_eq!(tx.value, 0);
        assert_eq!(tx.data, evm::erc20_transfer(&a.destination, a.amount));
        assert_eq!(tx.max_priority_fee_per_gas, tx.max_fee_per_gas);
        // Any changed recipient, amount, nonce or token changes the signing hash.
        let base = tx.signing_hash();
        let edits: [fn(&mut Authorization); 4] = [
            |a| a.destination = [4; 20],
            |a| a.amount = 99,
            |a| a.nonce = 6,
            |a| a.token = [4; 20],
        ];
        for edit in edits {
            let mut changed = auth("a.testnet", 1);
            edit(&mut changed);
            assert_ne!(changed.transfer_tx(10, 100_000).signing_hash(), base);
        }
    }

    #[test]
    fn a_signature_alone_never_confirms_and_signing_needs_a_prior_request() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        assert_eq!(
            payout.signature_received(10, [1; 32], sig()),
            Err(PayoutError::UnknownAttempt)
        );
        assert_eq!(payout.status.state(), PayoutState::Authorized);
        assert_eq!(payout.request_signature(10), Ok(()));
        // One request at a time while the signer has not answered.
        assert_eq!(payout.request_signature(11), Err(PayoutError::InFlight));
        assert_eq!(payout.status.state(), PayoutState::SigningRequested);
        assert_eq!(payout.signature_received(10, [1; 32], sig()), Ok(true));
        assert_eq!(
            payout.signature_received(10, [1; 32], sig()),
            Err(PayoutError::UnknownAttempt)
        );
        assert_eq!(payout.status.state(), PayoutState::Signed);
        assert_eq!(payout.record_broadcast([1; 32]), Ok(true));
        assert_eq!(payout.record_broadcast([1; 32]), Ok(false));
        assert_eq!(payout.status.state(), PayoutState::Broadcast);
        assert_eq!(payout.record_pending([1; 32]), Ok(true));
        assert_eq!(payout.record_pending([1; 32]), Ok(false));
        assert_eq!(payout.status.state(), PayoutState::PendingFinality);
        assert!(!payout.status.state().is_terminal());
    }

    #[test]
    fn pending_needs_a_broadcast_and_zero_hashes_never_match_a_request() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature(10).expect("request");
        assert_eq!(
            payout.record_broadcast([0; 32]),
            Err(PayoutError::UnknownAttempt)
        );
        assert_eq!(
            payout.record_revert([0; 32]),
            Err(PayoutError::UnknownAttempt)
        );
        let mut zero = evidence(0);
        zero.tx_hash = [0; 32];
        assert_eq!(payout.confirm(&zero), Err(PayoutError::EvidenceMismatch));
        payout.signature_received(10, [1; 32], sig()).expect("sign");
        assert_eq!(payout.record_pending([1; 32]), Err(PayoutError::WrongState));
        assert_eq!(
            payout.record_pending([2; 32]),
            Err(PayoutError::UnknownAttempt)
        );
    }

    #[test]
    fn a_failed_signer_call_holds_the_payout_and_allows_a_retry() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature(10).expect("request");
        payout.signature_failed(10).expect("failed");
        assert_eq!(
            payout.status,
            Status::ReconciliationRequired(Reason::SignerNoResponse)
        );
        assert!(payout.attempts.is_empty());
        // The failed request left nothing a replacement must outbid, but the
        // reservation is held: cancelling needs proof.
        assert_eq!(payout.restore(None), Err(PayoutError::NotProven));
        assert_eq!(payout.request_signature(10), Ok(()));
        assert_eq!(payout.signature_received(10, [1; 32], sig()), Ok(true));
        assert_eq!(payout.status.state(), PayoutState::Signed);
    }

    #[test]
    fn replacements_need_a_strictly_higher_fee_and_at_most_eight_attempts() {
        let mut payout = signed(1, 10);
        assert_eq!(
            payout.request_signature(10),
            Err(PayoutError::InvalidReplacement)
        );
        assert_eq!(
            payout.request_signature(9),
            Err(PayoutError::InvalidReplacement)
        );
        assert_eq!(
            payout.request_signature(0),
            Err(PayoutError::InvalidReplacement)
        );
        for n in 2u8..=8 {
            payout
                .request_signature(u128::from(n) * 10)
                .expect("replace");
            payout
                .signature_received(u128::from(n) * 10, [n; 32], sig())
                .expect("sign");
        }
        assert_eq!(payout.attempts.len(), MAX_ATTEMPTS);
        assert_eq!(
            payout.request_signature(1_000),
            Err(PayoutError::TooManyAttempts)
        );
        // History is kept; any attempt may be the one that executes.
        assert_eq!(payout.confirm(&evidence(1)), Ok(true));
    }

    #[test]
    fn a_late_signature_is_recorded_even_after_a_higher_request() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature(10).expect("request");
        payout
            .require_reconciliation(Reason::SignerNoResponse)
            .expect("hold");
        // A replacement may start while the first callback is lost.
        payout.request_signature(20).expect("replacement");
        payout
            .signature_received(20, [2; 32], sig())
            .expect("second");
        assert_eq!(payout.status.state(), PayoutState::SigningRequested);
        // The older answer arrives late: it must still become known.
        assert_eq!(payout.signature_received(10, [1; 32], sig()), Ok(true));
        assert_eq!(payout.status.state(), PayoutState::Signed);
        assert_eq!(payout.attempts.len(), 2);
        assert_eq!(payout.confirm(&evidence(1)), Ok(true));
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
            assert_eq!(payout.status.state(), PayoutState::Broadcast);
        }
        assert_eq!(payout.confirm(&evidence(1)), Ok(true));
        assert_eq!(payout.confirm(&evidence(1)), Ok(false));
        let mut conflicting = evidence(1);
        conflicting.evidence_hash = [6; 32];
        assert_eq!(
            payout.confirm(&conflicting),
            Err(PayoutError::EvidenceMismatch)
        );
        assert_eq!(payout.request_signature(99), Err(PayoutError::Closed));
        assert_eq!(payout.record_pending([1; 32]), Err(PayoutError::Closed));
        assert_eq!(payout.restore(None), Err(PayoutError::Closed));
        assert!(payout.status.state().is_terminal());
    }

    #[test]
    fn reverts_move_to_reverted_only_when_no_attempt_can_still_execute() {
        let mut payout = signed(1, 10);
        payout.request_signature(20).expect("replace");
        payout.signature_received(20, [2; 32], sig()).expect("sign");
        payout.record_broadcast([1; 32]).expect("broadcast");
        payout.record_revert([1; 32]).expect("revert one");
        assert_eq!(payout.status.state(), PayoutState::Broadcast);
        payout.record_revert([2; 32]).expect("revert two");
        assert_eq!(payout.status.state(), PayoutState::Reverted);
        // A reverted payout accepts no new spend and cannot be re-held.
        assert_eq!(payout.request_signature(30), Err(PayoutError::WrongState));
        assert_eq!(
            payout.require_reconciliation(Reason::EvidenceUnavailable),
            Err(PayoutError::WrongState)
        );
        assert_eq!(
            payout.record_broadcast([1; 32]),
            Err(PayoutError::WrongState)
        );
        assert_eq!(
            payout.confirm(&evidence(1)),
            Err(PayoutError::EvidenceMismatch)
        );
    }

    #[test]
    fn lost_responses_hold_the_reservation() {
        let mut payout = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        payout.request_signature(10).expect("request");
        payout
            .require_reconciliation(Reason::SignerNoResponse)
            .expect("hold");
        assert_eq!(payout.status.state(), PayoutState::ReconciliationRequired);
        // A lost signer response may hide a signature: cancelling is not allowed.
        assert_eq!(payout.restore(None), Err(PayoutError::NotProven));
        payout
            .signature_received(10, [1; 32], sig())
            .expect("late signature");
        payout.record_broadcast([1; 32]).expect("broadcast");
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
        let mut early = proof(SlotOutcome::OurTxReverted([1; 32]));
        early.finalized_nonce = 5;
        assert_eq!(payout.restore(Some(&early)), Err(PayoutError::NotProven));
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
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::ForeignTx([1; 32])))),
            Err(PayoutError::NotProven)
        );
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::OurTxSucceeded([1; 32])))),
            Err(PayoutError::MustConfirm)
        );
        assert_eq!(payout.status.state(), PayoutState::ReconciliationRequired);
        payout.record_revert([1; 32]).expect("revert");
        assert_eq!(payout.status.state(), PayoutState::Reverted);
        assert_eq!(
            payout.restore(Some(&proof(SlotOutcome::OurTxReverted([1; 32])))),
            Ok(())
        );
        assert_eq!(payout.status.state(), PayoutState::Restored);
        // A foreign transaction consuming the nonce also releases an unexecuted payout.
        let mut replaced = signed(1, 10);
        replaced.record_broadcast([1; 32]).expect("broadcast");
        assert_eq!(
            replaced.restore(Some(&proof(SlotOutcome::ForeignTx([6; 32])))),
            Ok(())
        );
        // A zero hash never stands for a request that has no transaction yet.
        let mut requested = Payout::authorize(auth("a.testnet", 1)).expect("payout");
        requested.request_signature(10).expect("request");
        assert_eq!(
            requested.restore(Some(&proof(SlotOutcome::OurTxReverted([0; 32])))),
            Err(PayoutError::NotProven)
        );
        assert_eq!(
            requested.restore(Some(&proof(SlotOutcome::ForeignTx([0; 32])))),
            Err(PayoutError::NotProven)
        );
    }

    #[test]
    fn every_status_maps_to_one_stable_label() {
        let labels = [
            (PayoutState::Authorized, "authorized"),
            (PayoutState::SigningRequested, "signing_requested"),
            (PayoutState::Signed, "signed"),
            (PayoutState::Broadcast, "broadcast"),
            (PayoutState::PendingFinality, "pending_finality"),
            (PayoutState::Reverted, "reverted"),
            (
                PayoutState::ReconciliationRequired,
                "reconciliation_required",
            ),
            (PayoutState::Confirmed, "confirmed"),
            (PayoutState::Restored, "restored"),
        ];
        for (state, label) in labels {
            assert_eq!(state.label(), label);
        }
    }
}
