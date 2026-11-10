//! Bounded player grants and atomic budget reservations.
//!
//! Pure policy core for one user's delegated spending authority. It decides
//! whether a canonical action is authorized by a stored grant and accounts for
//! reserved and consumed token budget. It performs no signing, token transfer,
//! MPC call or custody access: a successful reservation is an authorization and
//! a budget hold, never a token transfer, proof of funds or confirmed payment.
//! The eventual executor must reconstruct and enforce the exact bound action and
//! consume its authorization exactly once; this core only models that boundary.
//!
//! Infrastructure trust (auditor, scheduler, relayer, operator, owner) never
//! grants player-spending authority here; only a user can create or revoke their
//! own grant, and only its delegate (or the user) can reserve against it.
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

pub mod contract;

pub type Hash = [u8; 32];

/// True only when the fixture execution adapter is compiled in. A deployed build
/// has it false, so no fabricated confirmation/unlock path exists.
pub const FIXTURES_ENABLED: bool = cfg!(feature = "sandbox-fixtures");

/// Bounds on grant scope collections and strings, so storage and validation work stay bounded.
pub const MAX_LIST: usize = 32;
pub const MAX_STRING: usize = 128;
pub const MAX_DOMAIN: usize = 256;

fn length_prefixed(out: &mut Vec<u8>, part: &[u8]) {
    out.extend_from_slice(&(part.len() as u32).to_be_bytes());
    out.extend_from_slice(part);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    /// Grant scope, caps, asset or bounds are invalid.
    InvalidGrant,
    /// A collection or string exceeds its bound.
    TooLarge,
    /// An empty, unbounded scope list is not allowed.
    EmptyScope,
    UserMismatch,
    DelegateMismatch,
    /// The action's grant version is not the current one.
    VersionMismatch,
    Expired,
    Revoked,
    AssetMismatch,
    TargetNotAllowed,
    MethodNotAllowed,
    DestinationNotAllowed,
    CommunityNotAllowed,
    ZeroAmount,
    PerActionCapExceeded,
    GasOutOfBounds,
    /// consumed + reserved + amount would exceed the authorized limit.
    CumulativeCapExceeded,
    Overflow,
    /// A new version must strictly increase and cannot widen past retained obligations.
    NonIncreasingVersion,
    /// The same request identity was reused with a different bound action.
    Conflict,
    /// The delegate must be an account other than the grant's user.
    DelegateIsUser,
    /// The reservation passed its expiry and can no longer be admitted for execution.
    ReservationExpired,
    /// The reservation has not reached its expiry yet.
    NotExpired,
    /// The transition is not allowed from the current reservation state.
    WrongState,
    /// A terminal outcome conflicts with the one already recorded.
    ConflictingOutcome,
    /// Receipt evidence does not match the bound obligation, asset or finality rules.
    ReceiptMismatch,
    /// The obligation carries no battle id, so no registry receipt can be bound to it.
    NotBoundToBattle,
}

/// Source-asset identity. An asset is never identified by ticker alone: it binds
/// the chain, the exact token address, its NEAR representation, custody domain
/// and mapping version. Budgets are per grant, and each grant binds one asset.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetKey {
    pub chain_id: u64,
    /// Lowercased `0x`-prefixed 20-byte EVM address.
    pub token: String,
    pub representation: AccountId,
    pub custody_domain: String,
    pub mapping_version: u64,
}

fn valid_evm_address(s: &str) -> bool {
    s.strip_prefix("0x").is_some_and(|hex| {
        hex.len() == 40
            && hex.bytes().all(|b| b.is_ascii_hexdigit())
            && hex.bytes().any(|b| b != b'0')
    })
}

impl AssetKey {
    /// Lowercase the token and validate every field. Rejects a ticker or malformed address.
    pub fn canonicalize(mut self) -> Result<Self, PolicyError> {
        if self.chain_id == 0 || !valid_evm_address(&self.token) {
            return Err(PolicyError::InvalidGrant);
        }
        self.token = self.token.to_ascii_lowercase();
        if self.custody_domain.trim().is_empty() || self.custody_domain.len() > MAX_DOMAIN {
            return Err(PolicyError::InvalidGrant);
        }
        Ok(self)
    }
}

/// Optional battle/community scope. When set on a grant, an action must fall within it.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BattleScope {
    pub battle_id: u64,
    /// `None` means any community in that battle.
    pub community: Option<u32>,
}

/// A user-owned grant: the complete bound authority a delegate may exercise.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub user: AccountId,
    pub delegate: AccountId,
    /// User-chosen 32-byte grant id, scoped to `user`.
    pub local_id: Hash,
    pub version: u64,
    pub asset: AssetKey,
    pub contracts: Vec<AccountId>,
    pub methods: Vec<String>,
    pub destinations: Vec<String>,
    pub battle: Option<BattleScope>,
    /// Maximum per single action (atomic units).
    pub per_action_cap: u128,
    /// Cumulative authorized limit across all actions of this grant.
    pub cumulative_cap: u128,
    /// Declared per-action gas bound (abstract units, not measured foreign gas).
    pub gas_cap: u64,
    /// Nanoseconds since the epoch; `now >= expiry_ns` rejects new authorization.
    pub expiry_ns: u64,
}

/// Grant identity, scoped to the user and their chosen local id (version excluded).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct GrantId(pub Hash);

impl GrantId {
    pub fn derive(user: &AccountId, local_id: &Hash) -> Self {
        let mut data = b"valtrum/player-grant/v1".to_vec();
        length_prefixed(&mut data, user.as_str().as_bytes());
        length_prefixed(&mut data, local_id);
        GrantId(env::sha256_array(&data))
    }
}

fn bounded_strings(items: &[String]) -> Result<(), PolicyError> {
    if items.is_empty() {
        return Err(PolicyError::EmptyScope);
    }
    if items.len() > MAX_LIST {
        return Err(PolicyError::TooLarge);
    }
    for s in items {
        if s.is_empty() || s.len() > MAX_STRING {
            return Err(PolicyError::TooLarge);
        }
    }
    Ok(())
}

impl Grant {
    pub fn id(&self) -> GrantId {
        GrantId::derive(&self.user, &self.local_id)
    }

    /// Validate scope, caps and bounds. Canonicalizes the asset. Fails closed on any violation.
    pub fn validate(mut self) -> Result<Self, PolicyError> {
        self.asset = self.asset.canonicalize()?;
        if self.delegate == self.user {
            return Err(PolicyError::DelegateIsUser);
        }
        if self.contracts.is_empty() || self.contracts.len() > MAX_LIST {
            return Err(if self.contracts.is_empty() {
                PolicyError::EmptyScope
            } else {
                PolicyError::TooLarge
            });
        }
        bounded_strings(&self.methods)?;
        bounded_strings(&self.destinations)?;
        if self.version == 0 {
            return Err(PolicyError::InvalidGrant);
        }
        if self.per_action_cap == 0
            || self.cumulative_cap == 0
            || self.per_action_cap > self.cumulative_cap
        {
            return Err(PolicyError::InvalidGrant);
        }
        if self.gas_cap == 0 {
            return Err(PolicyError::InvalidGrant);
        }
        Ok(self)
    }

    /// Whether `action` is authorized by this grant at time `now_ns` (revocation is checked
    /// separately by the stored state). Every security-relevant field must match the grant.
    pub fn authorizes(&self, action: &CanonicalAction, now_ns: u64) -> Result<(), PolicyError> {
        if self.user != action.user {
            return Err(PolicyError::UserMismatch);
        }
        if self.delegate != action.delegate {
            return Err(PolicyError::DelegateMismatch);
        }
        if self.version != action.version {
            return Err(PolicyError::VersionMismatch);
        }
        if now_ns >= self.expiry_ns {
            return Err(PolicyError::Expired);
        }
        if self.asset != action.asset {
            return Err(PolicyError::AssetMismatch);
        }
        if !self.contracts.contains(&action.target) {
            return Err(PolicyError::TargetNotAllowed);
        }
        if !self.methods.iter().any(|m| m == &action.method) {
            return Err(PolicyError::MethodNotAllowed);
        }
        if !self.destinations.iter().any(|d| d == &action.destination) {
            return Err(PolicyError::DestinationNotAllowed);
        }
        if action.amount == 0 {
            return Err(PolicyError::ZeroAmount);
        }
        if action.amount > self.per_action_cap {
            return Err(PolicyError::PerActionCapExceeded);
        }
        if action.gas == 0 || action.gas > self.gas_cap {
            return Err(PolicyError::GasOutOfBounds);
        }
        match (self.battle, action.battle) {
            (None, _) => {}
            (Some(_), None) => return Err(PolicyError::CommunityNotAllowed),
            (Some(scope), Some(a)) => {
                if scope.battle_id != a.battle_id {
                    return Err(PolicyError::CommunityNotAllowed);
                }
                if let Some(c) = scope.community {
                    if Some(c) != a.community {
                        return Err(PolicyError::CommunityNotAllowed);
                    }
                }
            }
        }
        Ok(())
    }
}

/// A versioned, typed canonical action. Its hash binds every security-relevant field so an
/// executor (or this core) can detect any change to a previously reserved request.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalAction {
    pub user: AccountId,
    pub local_id: Hash,
    pub version: u64,
    pub delegate: AccountId,
    pub asset: AssetKey,
    pub target: AccountId,
    pub method: String,
    pub destination: String,
    pub amount: u128,
    pub gas: u64,
    /// Caller-chosen operation identity, scoped to user+grant by `request_key`.
    pub request_id: Hash,
    pub battle: Option<BattleScope>,
}

impl CanonicalAction {
    pub fn grant_id(&self) -> GrantId {
        GrantId::derive(&self.user, &self.local_id)
    }

    /// Idempotency identity, scoped to user and grant local id but NOT version: the same request
    /// reused under a different version keeps this key, so a changed bound action is a conflict.
    pub fn request_key(&self) -> Hash {
        let mut data = b"valtrum/player-request/v1".to_vec();
        length_prefixed(&mut data, self.user.as_str().as_bytes());
        length_prefixed(&mut data, &self.local_id);
        length_prefixed(&mut data, &self.request_id);
        env::sha256_array(&data)
    }

    /// Commitment to every security-relevant field, including the grant version.
    pub fn action_hash(&self) -> Hash {
        let mut data = b"valtrum/player-action/v1".to_vec();
        length_prefixed(&mut data, self.user.as_str().as_bytes());
        length_prefixed(&mut data, &self.local_id);
        length_prefixed(&mut data, &self.version.to_be_bytes());
        length_prefixed(&mut data, self.delegate.as_str().as_bytes());
        length_prefixed(&mut data, &self.asset.chain_id.to_be_bytes());
        length_prefixed(&mut data, self.asset.token.as_bytes());
        length_prefixed(&mut data, self.asset.representation.as_str().as_bytes());
        length_prefixed(&mut data, self.asset.custody_domain.as_bytes());
        length_prefixed(&mut data, &self.asset.mapping_version.to_be_bytes());
        length_prefixed(&mut data, self.target.as_str().as_bytes());
        length_prefixed(&mut data, self.method.as_bytes());
        length_prefixed(&mut data, self.destination.as_bytes());
        length_prefixed(&mut data, &self.amount.to_be_bytes());
        length_prefixed(&mut data, &self.gas.to_be_bytes());
        length_prefixed(&mut data, &self.request_id);
        let battle = match self.battle {
            None => vec![0u8],
            Some(b) => {
                let mut v = vec![1u8];
                v.extend_from_slice(&b.battle_id.to_be_bytes());
                v.extend_from_slice(&b.community.unwrap_or(u32::MAX).to_be_bytes());
                v.push(if b.community.is_some() { 1 } else { 0 });
                v
            }
        };
        length_prefixed(&mut data, &battle);
        env::sha256_array(&data)
    }
}

/// Token budget for one grant (version-independent counters, so a version bump never resets
/// unresolved obligations or evades the cumulative cap). Invariant: `consumed + reserved <= limit`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub authorized_limit: u128,
    pub consumed: u128,
    pub reserved: u128,
}

impl Budget {
    pub fn new(limit: u128) -> Self {
        Budget {
            authorized_limit: limit,
            consumed: 0,
            reserved: 0,
        }
    }

    /// Remaining budget. Saturating defensively; valid transitions keep use within the limit.
    pub fn available(&self) -> u128 {
        self.authorized_limit
            .saturating_sub(self.consumed.saturating_add(self.reserved))
    }

    fn used(&self) -> Result<u128, PolicyError> {
        self.consumed
            .checked_add(self.reserved)
            .ok_or(PolicyError::Overflow)
    }

    fn reserve(&mut self, amount: u128) -> Result<(), PolicyError> {
        let next = self
            .used()?
            .checked_add(amount)
            .ok_or(PolicyError::Overflow)?;
        if next > self.authorized_limit {
            return Err(PolicyError::CumulativeCapExceeded);
        }
        self.reserved = self
            .reserved
            .checked_add(amount)
            .ok_or(PolicyError::Overflow)?;
        Ok(())
    }

    fn consume(&mut self, amount: u128) -> Result<(), PolicyError> {
        self.reserved = self
            .reserved
            .checked_sub(amount)
            .ok_or(PolicyError::Overflow)?;
        self.consumed = self
            .consumed
            .checked_add(amount)
            .ok_or(PolicyError::Overflow)?;
        Ok(())
    }

    fn release(&mut self, amount: u128) -> Result<(), PolicyError> {
        self.reserved = self
            .reserved
            .checked_sub(amount)
            .ok_or(PolicyError::Overflow)?;
        Ok(())
    }

    /// Change a grant version's limit without resetting obligations or breaking the invariant.
    /// Invalid replacements leave the entire budget unchanged.
    pub fn relimit(&mut self, new_limit: u128) -> Result<(), PolicyError> {
        if self.used()? > new_limit {
            return Err(PolicyError::CumulativeCapExceeded);
        }
        self.authorized_limit = new_limit;
        Ok(())
    }
}

/// Lifecycle of one reservation. `Consumed` and `Released` are terminal; `ReconciliationRequired`
/// is not and retains the reservation until explicit evidence resolves it.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationState {
    Reserved,
    Dispatched,
    Consumed,
    Released,
    ReconciliationRequired,
}

impl ReservationState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ReservationState::Consumed | ReservationState::Released
        )
    }
}

/// Explicit outcome supplied by an execution/evidence adapter when reconciling an ambiguous state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    Executed,
    NotExecuted,
}

/// One budget reservation bound to a request identity and the exact action that was authorized.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub request_key: Hash,
    pub action_hash: Hash,
    pub grant: Hash,
    pub version: u64,
    pub amount: u128,
    pub state: ReservationState,
    /// Battle the action was bound to; the registry claim's `battle_id` must equal it.
    pub battle_id: Option<u64>,
    /// Nanoseconds since the epoch; an undispatched reservation can be released from this time.
    pub expires_ns: u64,
}

impl Reservation {
    /// A repeat reserve for the same request is harmless only when the bound action is identical;
    /// any change to the action for the same request identity is a conflict, never an overwrite.
    pub fn matches(&self, action_hash: &Hash) -> Result<(), PolicyError> {
        if &self.action_hash == action_hash {
            Ok(())
        } else {
            Err(PolicyError::Conflict)
        }
    }

    /// Admit the action for execution. Returns false if already dispatched (idempotent). An
    /// expired, never-dispatched reservation is refused, so expiry cannot race a late dispatch.
    pub fn dispatch(&mut self, now_ns: u64) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::Reserved => {
                if now_ns >= self.expires_ns {
                    return Err(PolicyError::ReservationExpired);
                }
                // An obligation no receipt can be bound to would be stuck forever.
                if self.battle_id.is_none() {
                    return Err(PolicyError::NotBoundToBattle);
                }
                self.state = ReservationState::Dispatched;
                Ok(true)
            }
            ReservationState::Dispatched => Ok(false),
            _ => Err(PolicyError::WrongState),
        }
    }

    /// Safe no-execution release, also used for a user or delegate cancel. Only valid before dispatch, or after a reconciliation that proved
    /// no execution. A dispatched obligation can never be released without that proof.
    pub fn release(&mut self, budget: &mut Budget) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::Reserved => {
                budget.release(self.amount)?;
                self.state = ReservationState::Released;
                Ok(true)
            }
            ReservationState::Released => Ok(false),
            ReservationState::Consumed => Err(PolicyError::ConflictingOutcome),
            ReservationState::Dispatched | ReservationState::ReconciliationRequired => {
                Err(PolicyError::WrongState)
            }
        }
    }

    /// Automatic expiry of a reservation that was never dispatched. Dispatched and
    /// reconciliation-required obligations are never released by time alone.
    pub fn expire(&mut self, budget: &mut Budget, now_ns: u64) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::Reserved => {
                if now_ns < self.expires_ns {
                    return Err(PolicyError::NotExpired);
                }
                budget.release(self.amount)?;
                self.state = ReservationState::Released;
                Ok(true)
            }
            ReservationState::Released => Ok(false),
            ReservationState::Consumed => Err(PolicyError::ConflictingOutcome),
            ReservationState::Dispatched | ReservationState::ReconciliationRequired => {
                Err(PolicyError::WrongState)
            }
        }
    }

    /// Record a confirmed execution: consumes the reservation exactly once.
    pub fn consume(&mut self, budget: &mut Budget) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::Reserved
            | ReservationState::Dispatched
            | ReservationState::ReconciliationRequired => {
                budget.consume(self.amount)?;
                self.state = ReservationState::Consumed;
                Ok(true)
            }
            ReservationState::Consumed => Ok(false),
            ReservationState::Released => Err(PolicyError::ConflictingOutcome),
        }
    }

    /// Mark an ambiguous obligation (timeout, missing callback) as needing reconciliation. The
    /// reservation stays held; this alone never restores budget.
    pub fn mark_reconciliation(&mut self) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::Dispatched => {
                self.state = ReservationState::ReconciliationRequired;
                Ok(true)
            }
            ReservationState::ReconciliationRequired => Ok(false),
            _ => Err(PolicyError::WrongState),
        }
    }

    /// Resolve a reconciliation-required reservation with explicit bound evidence.
    pub fn reconcile(
        &mut self,
        budget: &mut Budget,
        resolution: Resolution,
    ) -> Result<bool, PolicyError> {
        match self.state {
            ReservationState::ReconciliationRequired => match resolution {
                Resolution::Executed => self.consume(budget),
                Resolution::NotExecuted => {
                    budget.release(self.amount)?;
                    self.state = ReservationState::Released;
                    Ok(true)
                }
            },
            ReservationState::Consumed if resolution == Resolution::Executed => Ok(false),
            ReservationState::Released if resolution == Resolution::NotExecuted => Ok(false),
            ReservationState::Consumed | ReservationState::Released => {
                Err(PolicyError::ConflictingOutcome)
            }
            _ => Err(PolicyError::WrongState),
        }
    }
}

/// Global source-receipt identity in the shared receipt registry. The chain id comes from the
/// grant's asset, never from the caller.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReceiptRef {
    pub transaction_hash: Hash,
    pub log_index: u32,
}

/// JSON shape of the registry's receipt key.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryKey {
    pub chain_id: U64,
    pub transaction_hash: Hash,
    pub log_index: u32,
}

/// JSON shape of the shared registry's immutable claim (`get_active_claim`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptClaim {
    pub representation: AccountId,
    pub token_address: String,
    pub custody_domain: String,
    pub mapping_version: U64,
    pub beneficiary: AccountId,
    pub refund_address: [u8; 20],
    pub battle_id: U64,
    pub actual_received: U128,
    pub block_number: U64,
    pub block_hash: Hash,
    pub finalized_head_number: U64,
    pub finalized_head_hash: Hash,
    pub evidence_hash: Hash,
}

/// Whether a registry claim is finalized evidence of exactly this obligation: same asset identity
/// as the grant, the grant's user as beneficiary, the reserved battle and the exact reserved
/// amount. The claim carries no request id, so this binds by asset, user, battle and amount and
/// one receipt can settle at most one reservation (enforced by the wrapper). Fails closed.
pub fn receipt_binds(
    grant: &Grant,
    reservation: &Reservation,
    claim: &ReceiptClaim,
) -> Result<(), PolicyError> {
    let battle = reservation.battle_id.ok_or(PolicyError::NotBoundToBattle)?;
    let finalized = claim.refund_address != [0; 20]
        && claim.block_hash != [0; 32]
        && claim.finalized_head_hash != [0; 32]
        && claim.evidence_hash != [0; 32]
        && claim.block_number.0 <= claim.finalized_head_number.0
        && (claim.block_number.0 != claim.finalized_head_number.0
            || claim.block_hash == claim.finalized_head_hash);
    let bound = claim.representation == grant.asset.representation
        && claim.token_address.eq_ignore_ascii_case(&grant.asset.token)
        && claim.custody_domain == grant.asset.custody_domain
        && claim.mapping_version.0 == grant.asset.mapping_version
        && claim.beneficiary == grant.user
        && claim.battle_id.0 == battle
        && claim.actual_received.0 == reservation.amount
        && reservation.amount > 0;
    if finalized && bound {
        Ok(())
    } else {
        Err(PolicyError::ReceiptMismatch)
    }
}

#[cfg(test)]
mod tests;
