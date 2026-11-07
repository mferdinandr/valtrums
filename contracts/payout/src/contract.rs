//! Shared payout contract for all backing instances.
//!
//! Roles are fixed at initialization and separate:
//! - the **holder** (an entitlement owner) is the only one who can request a
//!   payout, and only from their own entitlement;
//! - the **relayer** drives signing and broadcast of exactly the transaction
//!   the payout authorizes, and can neither choose parameters nor confirm;
//! - the **operator** attests finalized source-chain facts (confirmation,
//!   reverts, nonce-slot proofs), and can neither request payouts nor sign.
//!
//! The owner only registers backing contracts and cannot change one afterwards.
//!
//! Signer (MPC) calls and transaction building are not performed here; the
//! relayer obtains the authorized payload from `begin_signing` and reports the
//! resulting signature. Operator evidence is a trusted attestation, not proof.
use crate::{
    Authorization, Hash, NoSpendProof, PaymentEvidence, Payout, PayoutId, Reason, SlotOutcome,
    Status,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

const REQUEST_DEPOSIT: NearToken = NearToken::from_millinear(30);
/// Kept by the contract to pay for later signing attempts (at most `MAX_ATTEMPTS`).
const ATTEMPT_RESERVE: NearToken = NearToken::from_millinear(10);
const MAX_ATTEMPTS: usize = 8;
const BACKING_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Backings,
    Payouts,
}

/// Immutable source-chain binding of one registered backing contract.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackingConfigInput {
    pub chain_id: U64,
    pub token: [u8; 20],
    pub custody_domain: String,
    /// Custody account that signs and pays on the source chain.
    pub sender: [u8; 20],
    /// MPC derivation path of that custody account.
    pub path: String,
    /// Next unused source-chain nonce of `sender`.
    pub first_nonce: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
struct BackingConfig {
    chain_id: u64,
    token: [u8; 20],
    custody_domain: String,
    sender: [u8; 20],
    path: String,
    next_nonce: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentEvidenceInput {
    pub chain_id: U64,
    pub token: [u8; 20],
    pub sender: [u8; 20],
    pub recipient: [u8; 20],
    pub amount: U128,
    pub tx_hash: Hash,
    pub log_index: u32,
    pub block_hash: Hash,
    pub block_number: U64,
    pub finalized_head_number: U64,
    pub finalized_head_hash: Hash,
    pub evidence_hash: Hash,
}

impl From<&PaymentEvidenceInput> for PaymentEvidence {
    fn from(value: &PaymentEvidenceInput) -> Self {
        Self {
            chain_id: value.chain_id.0,
            token: value.token,
            sender: value.sender,
            recipient: value.recipient,
            amount: value.amount.0,
            tx_hash: value.tx_hash,
            log_index: value.log_index,
            block_hash: value.block_hash,
            finalized_head_number: value.finalized_head_number.0,
            finalized_head_hash: value.finalized_head_hash,
            block_number: value.block_number.0,
            evidence_hash: value.evidence_hash,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlotOutcomeInput {
    OurTxReverted(Hash),
    ForeignTx(Hash),
    OurTxSucceeded(Hash),
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoSpendProofInput {
    pub chain_id: U64,
    pub sender: [u8; 20],
    pub finalized_nonce: U64,
    pub outcome: SlotOutcomeInput,
    pub finalized_head_number: U64,
    pub finalized_head_hash: Hash,
}

impl From<&NoSpendProofInput> for NoSpendProof {
    fn from(value: &NoSpendProofInput) -> Self {
        Self {
            chain_id: value.chain_id.0,
            sender: value.sender,
            finalized_nonce: value.finalized_nonce.0,
            outcome: match &value.outcome {
                SlotOutcomeInput::OurTxReverted(hash) => SlotOutcome::OurTxReverted(*hash),
                SlotOutcomeInput::ForeignTx(hash) => SlotOutcome::ForeignTx(*hash),
                SlotOutcomeInput::OurTxSucceeded(hash) => SlotOutcome::OurTxSucceeded(*hash),
            },
            finalized_head_number: value.finalized_head_number.0,
            finalized_head_hash: value.finalized_head_hash,
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReasonInput {
    SignerNoResponse,
    BroadcastUnconfirmed,
    EvidenceUnavailable,
}

/// The only transaction parameters the relayer may sign.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigningPayload {
    pub backing: AccountId,
    pub holder: AccountId,
    pub chain_id: U64,
    pub token: [u8; 20],
    pub sender: [u8; 20],
    pub destination: [u8; 20],
    pub amount: U128,
    pub path: String,
    pub nonce: U64,
    pub binding_hash: Hash,
}

/// Mirrors the backing contract's JSON shapes (kept local to avoid linking
/// another contract crate).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservedPayout {
    pub created: bool,
    pub source_amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedDebitArgs {
    pub chain_id: U64,
    pub token_address: String,
    pub custody_domain: String,
    pub destination: [u8; 20],
    pub source_amount: U128,
    pub recipient_received: U128,
    pub transaction_hash: Hash,
    pub log_index: u32,
    pub block_hash: Hash,
}

#[ext_contract(ext_backing)]
#[allow(dead_code)]
trait BackingPayouts {
    fn reserve_payout(
        &mut self,
        beneficiary: AccountId,
        request_id: Hash,
        amount: U128,
        destination: [u8; 20],
    ) -> ReservedPayout;
    fn confirm_payout(
        &mut self,
        beneficiary: AccountId,
        request_id: Hash,
        evidence: FinalizedDebitArgs,
    ) -> bool;
    fn release_payout(&mut self, beneficiary: AccountId, request_id: Hash) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PayoutContract {
    owner: AccountId,
    operator: AccountId,
    relayer: AccountId,
    backings: LookupMap<AccountId, BackingConfig>,
    payouts: LookupMap<PayoutId, Payout>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn label(status: &Status) -> &'static str {
    match status {
        Status::Authorized => "authorized",
        Status::SigningRequested => "signing_requested",
        Status::Signed => "signed",
        Status::Broadcast => "broadcast",
        Status::ReconciliationRequired(_) => "reconciliation_required",
        Status::Confirmed { .. } => "confirmed",
        Status::Restored => "restored",
    }
}

#[near]
impl PayoutContract {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, relayer: AccountId) -> Self {
        require!(
            owner != operator && owner != relayer && operator != relayer,
            "Roles must be distinct accounts"
        );
        Self {
            owner,
            operator,
            relayer,
            backings: LookupMap::new(StorageKey::Backings),
            payouts: LookupMap::new(StorageKey::Payouts),
        }
    }

    /// Owner-only, once per backing; a registered binding can never change.
    #[payable]
    pub fn register_backing(&mut self, backing: AccountId, config: BackingConfigInput) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Only owner");
        require!(
            self.backings.get(&backing).is_none(),
            "Backing already registered"
        );
        require!(
            config.chain_id.0 > 0
                && config.token != [0; 20]
                && config.sender != [0; 20]
                && !config.custody_domain.trim().is_empty()
                && !config.path.trim().is_empty(),
            "Invalid backing configuration"
        );
        self.backings.insert(
            backing,
            BackingConfig {
                chain_id: config.chain_id.0,
                token: config.token,
                custody_domain: config.custody_domain,
                sender: config.sender,
                path: config.path,
                next_nonce: config.first_nonce.0,
            },
        );
    }

    /// The holder asks to be paid `amount` of their entitlement on the source
    /// chain. The backing contract reserves it first; only then is a payout
    /// recorded, so no signature can precede an exclusive reservation.
    /// Repeating an identical request after a failure is safe.
    #[payable]
    pub fn request_payout(
        &mut self,
        backing: AccountId,
        request_id: Hash,
        amount: U128,
        destination: [u8; 20],
    ) -> Promise {
        require!(
            self.backings.get(&backing).is_some(),
            "Backing not registered"
        );
        require!(
            env::attached_deposit() >= REQUEST_DEPOSIT,
            "Insufficient storage deposit"
        );
        require!(
            amount.0 > 0 && destination != [0; 20] && request_id != [0; 32],
            "Invalid payout request"
        );
        let holder = env::predecessor_account_id();
        ext_backing::ext(backing.clone())
            .with_static_gas(BACKING_GAS)
            .reserve_payout(holder.clone(), request_id, amount, destination)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_attached_deposit(env::attached_deposit())
                    .on_payout_reserved(holder, backing, request_id, destination),
            )
    }

    /// True when a payout record exists for the request afterwards. Anything
    /// else (rejected reservation, storage shortfall) refunds the deposit.
    #[private]
    #[payable]
    pub fn on_payout_reserved(
        &mut self,
        holder: AccountId,
        backing: AccountId,
        request_id: Hash,
        destination: [u8; 20],
        #[callback_result] reserved: Result<ReservedPayout, PromiseError>,
    ) -> bool {
        let attached = env::attached_deposit();
        let refund = |amount: NearToken| {
            if !amount.is_zero() {
                Promise::new(holder.clone()).transfer(amount).detach();
            }
        };
        let Ok(reserved) = reserved else {
            refund(attached);
            return false;
        };
        let id = PayoutId::derive(&backing, &holder, &request_id);
        let nonce = match self.payouts.get(&id) {
            Some(existing) => existing.authorization.nonce,
            None => {
                self.backings
                    .get(&backing)
                    .unwrap_or_else(|| env::panic_str("Backing not registered"))
                    .next_nonce
            }
        };
        let config = self
            .backings
            .get(&backing)
            .unwrap_or_else(|| env::panic_str("Backing not registered"))
            .clone();
        let authorization = Authorization {
            backing: backing.clone(),
            holder: holder.clone(),
            request_id,
            chain_id: config.chain_id,
            token: config.token,
            sender: config.sender,
            destination,
            amount: reserved.source_amount.0,
            path: config.path,
            nonce,
        };
        if let Some(existing) = self.payouts.get(&id) {
            existing
                .matches(&authorization)
                .unwrap_or_else(|_| env::panic_str("Conflicting payout"));
            refund(attached);
            return true;
        }
        let payout = Payout::authorize(authorization)
            .unwrap_or_else(|_| env::panic_str("Invalid payout authorization"));
        let before = env::storage_usage();
        self.payouts.insert(id, payout);
        self.payouts.flush();
        let bumped = self
            .backings
            .get_mut(&backing)
            .unwrap_or_else(|| env::panic_str("Backing not registered"));
        bumped.next_nonce = bumped
            .next_nonce
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Nonce overflow"));
        self.backings.flush();
        let cost = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(env::storage_usage().saturating_sub(before)))
            .and_then(|cost| cost.checked_add(ATTEMPT_RESERVE.as_yoctonear()))
            .unwrap_or_else(|| env::panic_str("Storage cost overflow"));
        require!(
            attached.as_yoctonear() >= cost,
            "Insufficient storage deposit"
        );
        refund(NearToken::from_yoctonear(attached.as_yoctonear() - cost));
        true
    }

    /// Relayer only. Marks that a signature is about to be requested and
    /// returns the exact parameters the signer is allowed to authorize.
    #[payable]
    pub fn begin_signing(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> SigningPayload {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.relayer,
            "Only relayer"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        payout
            .request_signature()
            .unwrap_or_else(|error| env::panic_str(&format!("Signing rejected: {error:?}")));
        let view = Self::payload_of(&payout);
        self.payouts.insert(id, payout);
        view
    }

    /// Relayer only. The signed transaction must carry this payout's binding.
    #[payable]
    pub fn record_signature(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        tx_hash: Hash,
        binding_hash: Hash,
        max_fee_per_gas: U128,
    ) -> bool {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.relayer,
            "Only relayer"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        require!(
            payout.attempts.len() < MAX_ATTEMPTS
                || payout.attempts.iter().any(|a| a.tx_hash == tx_hash),
            "Too many signing attempts"
        );
        let fresh = payout
            .record_signature(tx_hash, binding_hash, max_fee_per_gas.0)
            .unwrap_or_else(|error| env::panic_str(&format!("Signature rejected: {error:?}")));
        self.payouts.insert(id, payout);
        fresh
    }

    #[payable]
    pub fn record_broadcast(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        tx_hash: Hash,
    ) -> bool {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.relayer,
            "Only relayer"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        let fresh = payout
            .record_broadcast(tx_hash)
            .unwrap_or_else(|error| env::panic_str(&format!("Broadcast rejected: {error:?}")));
        self.payouts.insert(id, payout);
        fresh
    }

    /// Relayer or operator. Holds the reservation; it can never release it.
    #[payable]
    pub fn require_reconciliation(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        reason: ReasonInput,
    ) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            caller == self.relayer || caller == self.operator,
            "Only relayer or operator"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        payout
            .require_reconciliation(match reason {
                ReasonInput::SignerNoResponse => Reason::SignerNoResponse,
                ReasonInput::BroadcastUnconfirmed => Reason::BroadcastUnconfirmed,
                ReasonInput::EvidenceUnavailable => Reason::EvidenceUnavailable,
            })
            .unwrap_or_else(|error| env::panic_str(&format!("Hold rejected: {error:?}")));
        self.payouts.insert(id, payout);
    }

    /// Operator only. Marks an attempt as finalized with failure.
    #[payable]
    pub fn record_revert(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        tx_hash: Hash,
    ) {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.operator,
            "Only operator"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        payout
            .record_revert(tx_hash)
            .unwrap_or_else(|error| env::panic_str(&format!("Revert rejected: {error:?}")));
        self.payouts.insert(id, payout);
    }

    /// Operator only. Validates the attested transfer against the payout, has
    /// the backing consume its reservation, and only then marks it confirmed.
    #[payable]
    pub fn confirm_payout(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        evidence: PaymentEvidenceInput,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.operator,
            "Only operator"
        );
        let (_, payout) = self.load(&backing, &holder, &request_id);
        let attested = PaymentEvidence::from(&evidence);
        payout
            .clone()
            .confirm(&attested)
            .unwrap_or_else(|error| env::panic_str(&format!("Evidence rejected: {error:?}")));
        let config = self.config(&backing);
        let debit = FinalizedDebitArgs {
            chain_id: evidence.chain_id,
            token_address: format!("0x{}", hex(&config.token)),
            custody_domain: config.custody_domain,
            destination: evidence.recipient,
            source_amount: evidence.amount,
            recipient_received: evidence.amount,
            transaction_hash: evidence.tx_hash,
            log_index: evidence.log_index,
            block_hash: evidence.block_hash,
        };
        ext_backing::ext(backing.clone())
            .with_static_gas(BACKING_GAS)
            .confirm_payout(holder.clone(), request_id, debit)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout_confirmed(backing, holder, request_id, evidence),
            )
    }

    #[private]
    pub fn on_payout_confirmed(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        evidence: PaymentEvidenceInput,
        #[callback_result] consumed: Result<bool, PromiseError>,
    ) -> bool {
        if consumed.is_err() {
            return false;
        }
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        let fresh = payout
            .confirm(&PaymentEvidence::from(&evidence))
            .unwrap_or_else(|_| env::panic_str("Payout diverged from backing"));
        self.payouts.insert(id, payout);
        fresh
    }

    /// Operator only. Without a proof, only an unsigned payout can be
    /// cancelled; otherwise an attested finalized nonce slot must prove that no
    /// executable spend remains. The backing releases first, then this records.
    #[payable]
    pub fn restore_payout(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        proof: Option<NoSpendProofInput>,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.operator,
            "Only operator"
        );
        let (_, payout) = self.load(&backing, &holder, &request_id);
        let attested = proof.as_ref().map(NoSpendProof::from);
        payout
            .clone()
            .restore(attested.as_ref())
            .unwrap_or_else(|error| env::panic_str(&format!("Release rejected: {error:?}")));
        ext_backing::ext(backing.clone())
            .with_static_gas(BACKING_GAS)
            .release_payout(holder.clone(), request_id)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_payout_released(backing, holder, request_id, proof),
            )
    }

    #[private]
    pub fn on_payout_released(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        proof: Option<NoSpendProofInput>,
        #[callback_result] released: Result<bool, PromiseError>,
    ) -> bool {
        if released.is_err() {
            return false;
        }
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        let attested = proof.as_ref().map(NoSpendProof::from);
        payout
            .restore(attested.as_ref())
            .unwrap_or_else(|_| env::panic_str("Payout diverged from backing"));
        self.payouts.insert(id, payout);
        true
    }

    pub fn get_payout_status(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> Option<String> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        self.payouts
            .get(&id)
            .map(|payout| label(&payout.status).to_string())
    }

    pub fn get_signing_payload(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> Option<SigningPayload> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        self.payouts.get(&id).map(Self::payload_of)
    }

    pub fn get_next_nonce(&self, backing: AccountId) -> Option<U64> {
        self.backings
            .get(&backing)
            .map(|config| U64(config.next_nonce))
    }
}

impl PayoutContract {
    fn config(&self, backing: &AccountId) -> BackingConfig {
        self.backings
            .get(backing)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Backing not registered"))
    }

    fn load(
        &self,
        backing: &AccountId,
        holder: &AccountId,
        request_id: &Hash,
    ) -> (PayoutId, Payout) {
        let id = PayoutId::derive(backing, holder, request_id);
        let payout = self
            .payouts
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown payout"));
        (id, payout)
    }

    fn payload_of(payout: &Payout) -> SigningPayload {
        let a = &payout.authorization;
        SigningPayload {
            backing: a.backing.clone(),
            holder: a.holder.clone(),
            chain_id: U64(a.chain_id),
            token: a.token,
            sender: a.sender,
            destination: a.destination,
            amount: U128(a.amount),
            path: a.path.clone(),
            nonce: U64(a.nonce),
            binding_hash: payout.binding_hash,
        }
    }
}
