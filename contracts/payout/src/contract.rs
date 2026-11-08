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
//! The contract builds the ERC-20 transfer itself from the reservation and asks
//! the NEAR MPC signer (a fourth, fixed account) to sign it. Only the signer's
//! own callback can attach a signature to a payout; the relayer only chooses a
//! fee cap, never a recipient, amount, token, chain, path or nonce. Operator
//! evidence is a trusted attestation, not proof.
use crate::evm;
use crate::{
    Attempt, AttemptState, Authorization, Hash, NoSpendProof, PaymentEvidence, Payout, PayoutId,
    PayoutState, Reason, SlotOutcome, Status, StoredSignature,
};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

const REQUEST_DEPOSIT: NearToken = NearToken::from_millinear(30);
/// Kept by the contract to pay for later signing attempts (at most `MAX_ATTEMPTS`).
const ATTEMPT_RESERVE: NearToken = NearToken::from_millinear(10);
const BACKING_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
/// Gas for the signer call (the signer's own budget is up to 300 Tgas) and the
/// callback that parses its answer and stores the signature.
const SIGNER_GAS: Gas = Gas::from_tgas(250);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Signer deposit: one yoctoNEAR, paid from the contract's own balance.
const SIGNER_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Largest page `list_open_payouts` scans.
const MAX_PAGE: u64 = 50;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Backings,
    Payouts,
    Index,
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
    /// Gas limit of the ERC-20 transfer transaction.
    pub gas_limit: U64,
    /// Highest `max_fee_per_gas` the relayer may ask the signer to sign.
    pub max_fee_cap: U128,
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
    gas_limit: u64,
    max_fee_cap: u128,
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

/// The only transaction parameters a signature may authorize.
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
    pub gas_limit: U64,
    pub max_fee_cap: U128,
}

/// Where one signing attempt stands (stable view of `AttemptState`).
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptStateView {
    Requested,
    Signed,
    Broadcast,
    Pending,
    Reverted,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptView {
    /// All zero while `state` is `requested`.
    pub tx_hash: Hash,
    pub max_fee_per_gas: U128,
    pub state: AttemptStateView,
}

/// Stable public view of a payout. Variants of `PayoutState` and fields of this
/// struct are only ever added.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutView {
    pub backing: AccountId,
    pub holder: AccountId,
    pub request_id: Hash,
    pub state: PayoutState,
    /// Set only while `state` is `reconciliation_required`.
    pub reason: Option<ReasonInput>,
    /// True for `confirmed` and `restored`.
    pub terminal: bool,
    pub chain_id: U64,
    pub token: [u8; 20],
    pub sender: [u8; 20],
    pub destination: [u8; 20],
    pub amount: U128,
    pub path: String,
    pub nonce: U64,
    pub binding_hash: Hash,
    pub attempts: Vec<AttemptView>,
    /// Set only once `state` is `confirmed`.
    pub evidence_hash: Option<Hash>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayoutPage {
    /// Unresolved payouts found in the scanned range (terminal ones are skipped).
    pub items: Vec<PayoutView>,
    /// Pass this as `from_index` for the next page; equals the count at the end.
    pub next_index: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
struct PayoutKey {
    backing: AccountId,
    holder: AccountId,
    request_id: Hash,
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
    fn reserve_late_refund(
        &mut self,
        beneficiary: AccountId,
        request_id: Hash,
        amount: U128,
        destination: [u8; 20],
    ) -> ReservedPayout;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PayoutContract {
    owner: AccountId,
    operator: AccountId,
    relayer: AccountId,
    /// The NEAR MPC signer; the only account whose answer can sign a payout.
    signer: AccountId,
    backings: LookupMap<AccountId, BackingConfig>,
    payouts: LookupMap<PayoutId, Payout>,
    /// Every payout key in creation order, for paginated reconciliation.
    index: Vector<PayoutKey>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "valtrum_payout", "version": "1.0.0", "event": event, "data": data})
    ));
}

#[near]
impl PayoutContract {
    #[init]
    pub fn new(
        owner: AccountId,
        operator: AccountId,
        relayer: AccountId,
        signer: AccountId,
    ) -> Self {
        let roles = [&owner, &operator, &relayer, &signer];
        require!(
            roles
                .iter()
                .enumerate()
                .all(|(i, a)| roles.iter().skip(i + 1).all(|b| a != b)),
            "Roles and signer must be distinct accounts"
        );
        Self {
            owner,
            operator,
            relayer,
            signer,
            backings: LookupMap::new(StorageKey::Backings),
            payouts: LookupMap::new(StorageKey::Payouts),
            index: Vector::new(StorageKey::Index),
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
                && !config.path.trim().is_empty()
                && config.gas_limit.0 > 0
                && config.max_fee_cap.0 > 0,
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
                gas_limit: config.gas_limit.0,
                max_fee_cap: config.max_fee_cap.0,
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

    /// Starts the return of a late deposit on the source chain. The caller is
    /// either the beneficiary (who attaches the request storage deposit, and
    /// `beneficiary` must equal the caller) or the configured operator (who
    /// attaches exactly one yocto; the payout contract's own reserve pays the
    /// record storage). The operator gains a trigger only: the destination is
    /// never a free choice. Backing reserves the refund only for an EVM address
    /// bound at deposit to that beneficiary's own deposits (D17) and rejects
    /// any other value, and confirmation evidence must name the same recipient.
    /// After the reservation the refund follows the signing, confirmation and
    /// release path of an entitlement payout. Repeating an identical request
    /// after a failure is safe.
    #[payable]
    pub fn request_late_refund(
        &mut self,
        backing: AccountId,
        beneficiary: AccountId,
        request_id: Hash,
        amount: U128,
        refund_address: [u8; 20],
    ) -> Promise {
        require!(
            self.backings.get(&backing).is_some(),
            "Backing not registered"
        );
        let caller = env::predecessor_account_id();
        let sponsored = if caller == self.operator {
            near_sdk::assert_one_yocto();
            true
        } else {
            require!(caller == beneficiary, "Only beneficiary or operator");
            require!(
                env::attached_deposit() >= REQUEST_DEPOSIT,
                "Insufficient storage deposit"
            );
            false
        };
        require!(
            amount.0 > 0 && refund_address != [0; 20] && request_id != [0; 32],
            "Invalid refund request"
        );
        ext_backing::ext(backing.clone())
            .with_static_gas(BACKING_GAS)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .reserve_late_refund(beneficiary.clone(), request_id, amount, refund_address)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_attached_deposit(if sponsored {
                        NearToken::from_yoctonear(0)
                    } else {
                        env::attached_deposit()
                    })
                    .on_late_refund_reserved(
                        beneficiary,
                        backing,
                        request_id,
                        refund_address,
                        caller,
                    ),
            )
    }

    /// Callback of `request_late_refund`. A deposit attached by the beneficiary
    /// is refunded to the caller on failure; the operator path attaches none.
    #[private]
    #[payable]
    pub fn on_late_refund_reserved(
        &mut self,
        holder: AccountId,
        backing: AccountId,
        request_id: Hash,
        destination: [u8; 20],
        payer: AccountId,
        #[callback_result] reserved: Result<ReservedPayout, PromiseError>,
    ) -> bool {
        let sponsored = payer == self.operator;
        self.finish_reservation(
            holder,
            backing,
            request_id,
            destination,
            reserved,
            sponsored,
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
        self.finish_reservation(holder, backing, request_id, destination, reserved, false)
    }

    fn finish_reservation(
        &mut self,
        holder: AccountId,
        backing: AccountId,
        request_id: Hash,
        destination: [u8; 20],
        reserved: Result<ReservedPayout, PromiseError>,
        sponsored: bool,
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
        self.save(id, payout);
        self.payouts.flush();
        self.index.push(PayoutKey {
            backing: backing.clone(),
            holder: holder.clone(),
            request_id,
        });
        self.index.flush();
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
        if sponsored {
            // The payout contract's own balance pays the record storage.
            return true;
        }
        require!(
            attached.as_yoctonear() >= cost,
            "Insufficient storage deposit"
        );
        refund(NearToken::from_yoctonear(attached.as_yoctonear() - cost));
        true
    }

    /// Relayer only. The contract builds the transfer from the reservation,
    /// records the request, and asks the signer to sign it. The relayer chooses
    /// only the fee cap: strictly higher than every earlier attempt, at most the
    /// registered cap, at most `MAX_ATTEMPTS` attempts. A repeat while the signer
    /// has not answered is refused, so one payout never has two requests in
    /// flight unless it was explicitly put on hold. The signer deposit and the
    /// storage of attempts come from the contract's own reserve.
    #[payable]
    pub fn request_signature(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        max_fee_per_gas: U128,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.relayer,
            "Only relayer"
        );
        let config = self.config(&backing);
        require!(
            max_fee_per_gas.0 > 0 && max_fee_per_gas.0 <= config.max_fee_cap,
            "Fee cap outside the registered limit"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        payout
            .request_signature(max_fee_per_gas.0)
            .unwrap_or_else(|error| env::panic_str(&format!("Signing rejected: {error:?}")));
        let tx = payout
            .authorization
            .transfer_tx(max_fee_per_gas.0, config.gas_limit);
        let args = json!({
            "request": {
                "path": payout.authorization.path,
                "payload_v2": { "Ecdsa": evm::hex_encode(&tx.signing_hash()) },
                "domain_id": 0,
            }
        })
        .to_string()
        .into_bytes();
        emit(
            "signature_requested",
            json!({
                "backing": backing, "holder": holder, "request_id": evm::hex_encode(&request_id),
                "payload_hash": evm::hex_encode(&tx.signing_hash()),
                "max_fee_per_gas": max_fee_per_gas.0.to_string(),
                "nonce": payout.authorization.nonce,
            }),
        );
        // State is written before the external call; the callback only adds to it.
        self.save(id, payout);
        Promise::new(self.signer.clone())
            .function_call("sign".to_string(), args, SIGNER_DEPOSIT, SIGNER_GAS)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGN_CALLBACK_GAS)
                    .on_signature(backing, holder, request_id, max_fee_per_gas),
            )
    }

    /// The only way a signature enters a payout. It is private, so only this
    /// contract's own promise (the signer call it created) can reach it, and it
    /// never panics: an unusable answer or a failed call holds the payout for
    /// reconciliation, and a late answer for a closed payout is dropped.
    /// Returns true when a new signed attempt was stored.
    #[private]
    pub fn on_signature(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        max_fee_per_gas: U128,
        #[callback_result] result: Result<Value, PromiseError>,
    ) -> bool {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        let (Some(mut payout), Some(config)) = (
            self.payouts.get(&id).cloned(),
            self.backings.get(&backing).cloned(),
        ) else {
            return false;
        };
        let parsed = result
            .ok()
            .and_then(|response| evm::parse_signature(&response).ok());
        let outcome = match parsed {
            Some(signature) => {
                let tx = payout
                    .authorization
                    .transfer_tx(max_fee_per_gas.0, config.gas_limit);
                let signed = tx.signed(&signature);
                let tx_hash = evm::keccak(&signed);
                let stored = StoredSignature::from(signature);
                payout
                    .signature_received(max_fee_per_gas.0, tx_hash, stored)
                    .map(|fresh| (fresh, Some(tx_hash)))
            }
            None => payout
                .signature_failed(max_fee_per_gas.0)
                .map(|()| (false, None)),
        };
        let Ok((fresh, tx_hash)) = outcome else {
            return false;
        };
        match tx_hash {
            Some(hash) => emit(
                "signature_received",
                json!({
                    "backing": backing, "holder": holder, "request_id": evm::hex_encode(&request_id),
                    "tx_hash": evm::hex_encode(&hash),
                    "max_fee_per_gas": max_fee_per_gas.0.to_string(),
                }),
            ),
            None => emit(
                "signature_failed",
                json!({
                    "backing": backing, "holder": holder, "request_id": evm::hex_encode(&request_id),
                    "max_fee_per_gas": max_fee_per_gas.0.to_string(),
                }),
            ),
        }
        self.save(id, payout);
        fresh
    }

    /// Relayer only. Records that a signed attempt was sent to the network.
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
        self.save(id, payout);
        fresh
    }

    /// Relayer or operator. Records that a broadcast attempt was seen on the
    /// network but is not final. It changes only the reported state; it never
    /// confirms, releases or allows another spend.
    #[payable]
    pub fn record_pending_finality(
        &mut self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        tx_hash: Hash,
    ) -> bool {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(
            caller == self.relayer || caller == self.operator,
            "Only relayer or operator"
        );
        let (id, mut payout) = self.load(&backing, &holder, &request_id);
        let fresh = payout
            .record_pending(tx_hash)
            .unwrap_or_else(|error| env::panic_str(&format!("Pending rejected: {error:?}")));
        self.save(id, payout);
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
        self.save(id, payout);
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
        self.save(id, payout);
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
        self.save(id, payout);
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
        self.save(id, payout);
        true
    }

    /// Short label of the payout state (see `get_payout` for the full view).
    pub fn get_payout_status(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> Option<String> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        self.payouts
            .get(&id)
            .map(|payout| payout.status.state().label().to_string())
    }

    /// The stable payout view; `None` when no payout exists for the request.
    pub fn get_payout(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> Option<PayoutView> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        self.payouts.get(&id).map(Self::view_of)
    }

    /// Unresolved payouts in creation order. Scans at most `limit` (capped at
    /// 50) index positions from `from_index`; confirmed and restored payouts
    /// are skipped. Walk `next_index` until it reaches `get_payout_count`.
    pub fn list_open_payouts(&self, from_index: U64, limit: U64) -> PayoutPage {
        let len = u64::from(self.index.len());
        let start = from_index.0.min(len);
        let end = start.saturating_add(limit.0.min(MAX_PAGE)).min(len);
        let mut items = Vec::new();
        for position in start..end {
            let Some(key) = u32::try_from(position)
                .ok()
                .and_then(|position| self.index.get(position))
            else {
                continue;
            };
            let id = PayoutId::derive(&key.backing, &key.holder, &key.request_id);
            if let Some(payout) = self.payouts.get(&id) {
                if !payout.status.state().is_terminal() {
                    items.push(Self::view_of(payout));
                }
            }
        }
        PayoutPage {
            items,
            next_index: U64(end),
        }
    }

    pub fn get_payout_count(&self) -> U64 {
        U64(u64::from(self.index.len()))
    }

    /// The signed transaction (hex, ready for `eth_sendRawTransaction`) of a
    /// recorded attempt, rebuilt from the reservation and the stored signature.
    pub fn get_signed_transaction(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        tx_hash: Hash,
    ) -> Option<String> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        let payout = self.payouts.get(&id)?;
        let config = self.backings.get(&backing)?;
        let attempt = payout.attempts.iter().find(|a| a.tx_hash == tx_hash)?;
        let signature = attempt.signature?;
        let tx = payout
            .authorization
            .transfer_tx(attempt.max_fee_per_gas, config.gas_limit);
        Some(evm::hex_encode(&tx.signed(&signature.into())))
    }

    pub fn get_signing_payload(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
    ) -> Option<SigningPayload> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        let payout = self.payouts.get(&id)?;
        let config = self.backings.get(&backing)?;
        Some(Self::payload_of(payout, config))
    }

    /// Hex of the 32-byte hash the contract asks the signer to sign for a payout
    /// at this fee cap (what a verifier can recompute from the reservation).
    pub fn get_signing_hash(
        &self,
        backing: AccountId,
        holder: AccountId,
        request_id: Hash,
        max_fee_per_gas: U128,
    ) -> Option<String> {
        let id = PayoutId::derive(&backing, &holder, &request_id);
        let payout = self.payouts.get(&id)?;
        let config = self.backings.get(&backing)?;
        let tx = payout
            .authorization
            .transfer_tx(max_fee_per_gas.0, config.gas_limit);
        Some(evm::hex_encode(&tx.signing_hash()))
    }

    pub fn get_signer(&self) -> AccountId {
        self.signer.clone()
    }

    pub fn get_next_nonce(&self, backing: AccountId) -> Option<U64> {
        self.backings
            .get(&backing)
            .map(|config| U64(config.next_nonce))
    }
}

impl PayoutContract {
    /// Stores a payout and emits `payout_state_changed` when its public state
    /// differs from the stored one (or the payout is new).
    fn save(&mut self, id: PayoutId, payout: Payout) {
        let previous = self.payouts.get(&id).map(|p| p.status.state());
        let current = payout.status.state();
        if previous != Some(current) {
            let a = &payout.authorization;
            emit(
                "payout_state_changed",
                json!({
                    "backing": a.backing, "holder": a.holder,
                    "request_id": evm::hex_encode(&a.request_id),
                    "from": previous.map(PayoutState::label),
                    "to": current.label(),
                    "reason": Self::reason_of(&payout.status),
                }),
            );
        }
        self.payouts.insert(id, payout);
    }

    fn reason_of(status: &Status) -> Option<ReasonInput> {
        match status {
            Status::ReconciliationRequired(Reason::SignerNoResponse) => {
                Some(ReasonInput::SignerNoResponse)
            }
            Status::ReconciliationRequired(Reason::BroadcastUnconfirmed) => {
                Some(ReasonInput::BroadcastUnconfirmed)
            }
            Status::ReconciliationRequired(Reason::EvidenceUnavailable) => {
                Some(ReasonInput::EvidenceUnavailable)
            }
            _ => None,
        }
    }

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

    fn payload_of(payout: &Payout, config: &BackingConfig) -> SigningPayload {
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
            gas_limit: U64(config.gas_limit),
            max_fee_cap: U128(config.max_fee_cap),
        }
    }

    fn view_of(payout: &Payout) -> PayoutView {
        let a = &payout.authorization;
        PayoutView {
            backing: a.backing.clone(),
            holder: a.holder.clone(),
            request_id: a.request_id,
            state: payout.status.state(),
            reason: Self::reason_of(&payout.status),
            terminal: payout.status.state().is_terminal(),
            chain_id: U64(a.chain_id),
            token: a.token,
            sender: a.sender,
            destination: a.destination,
            amount: U128(a.amount),
            path: a.path.clone(),
            nonce: U64(a.nonce),
            binding_hash: payout.binding_hash,
            attempts: payout.attempts.iter().map(Self::attempt_view).collect(),
            evidence_hash: match payout.status {
                Status::Confirmed { evidence_hash } => Some(evidence_hash),
                _ => None,
            },
        }
    }

    fn attempt_view(attempt: &Attempt) -> AttemptView {
        AttemptView {
            tx_hash: attempt.tx_hash,
            max_fee_per_gas: U128(attempt.max_fee_per_gas),
            state: match attempt.state {
                AttemptState::Requested => AttemptStateView::Requested,
                AttemptState::Signed => AttemptStateView::Signed,
                AttemptState::Broadcast => AttemptStateView::Broadcast,
                AttemptState::Pending => AttemptStateView::Pending,
                AttemptState::Reverted => AttemptStateView::Reverted,
            },
        }
    }
}
