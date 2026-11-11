//! Authenticated backing approval for lifecycle communities.
//!
//! A backing approval is produced only by `refresh_lifecycle_backing`: the arena
//! asks the community's representation contract for its asset identity and
//! ledger state and compares them with the identity committed at creation. The
//! representation must be on the owner's trust list. The answer is data from
//! that contract, not proof of custody: backing owns custody, attestation and
//! suspension. A suspended, unbalanced, unreachable or mismatched backing
//! withdraws any earlier approval (fail closed). Approvals expire after
//! `BACKING_APPROVAL_MS`, and lock re-verifies the expiry.
use crate::lifecycle::{AssetIdentity, BackingApproval, BACKING_APPROVAL_MS};
use crate::{events, Arena, ArenaExt};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

const VIEW_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);

/// Subset of the backing contract's `get_asset` view.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepresentationAsset {
    pub chain_id: U64,
    pub token_address: String,
    pub custody_domain: String,
}

/// Subset of the backing contract's `get_ledger` view.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepresentationLedger {
    pub accounting_balanced: bool,
    pub paused: bool,
    pub reconciliation_required: bool,
}

#[ext_contract(ext_representation)]
#[allow(dead_code)]
trait Representation {
    fn get_asset(&self) -> RepresentationAsset;
    fn get_ledger(&self) -> RepresentationLedger;
}

#[cfg(test)]
mod tests;

/// Decide whether the representation's answers support a backing approval for
/// `committed`. Any failed call, identity difference, suspension or unbalanced
/// ledger returns `None`.
pub fn evaluate_backing(
    committed: &AssetIdentity,
    asset: Result<RepresentationAsset, PromiseError>,
    ledger: Result<RepresentationLedger, PromiseError>,
    now_ms: u64,
    height: u64,
) -> Option<BackingApproval> {
    let (asset, ledger) = (asset.ok()?, ledger.ok()?);
    if asset.chain_id.0 != committed.chain_id
        || !asset
            .token_address
            .eq_ignore_ascii_case(&committed.token_address)
        || asset.custody_domain != committed.custody_domain
        || !ledger.accounting_balanced
        || ledger.paused
        || ledger.reconciliation_required
    {
        return None;
    }
    let text = format!(
        "valtrum/backing-check/v1;representation={};chain={};token={};domain={};height={height}",
        committed.representation,
        committed.chain_id,
        committed.token_address.to_ascii_lowercase(),
        committed.custody_domain,
    );
    let digest: String = env::sha256_array(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(BackingApproval {
        asset: committed.clone(),
        evidence_hash: format!("sha256:{digest}"),
        expires_at_ms: now_ms.checked_add(BACKING_APPROVAL_MS)?,
    })
}

#[near]
impl Arena {
    /// Owner only, exactly one yocto. Adds or removes a representation contract
    /// from the list that may back lifecycle communities. Removing one does not
    /// withdraw approvals it already produced; they lapse at their expiry.
    #[payable]
    pub fn set_lifecycle_representation_trusted(
        &mut self,
        representation: AccountId,
        trusted: bool,
    ) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        if trusted {
            self.lifecycle_trusted_representations
                .insert(representation.clone(), true);
        } else {
            self.lifecycle_trusted_representations
                .remove(&representation);
        }
        self.lifecycle_trusted_representations.flush();
        events::emit(
            "lifecycle_representation_trust_changed",
            json!({ "representation": representation, "trusted": trusted }),
        );
    }

    pub fn is_lifecycle_representation_trusted(&self, representation: AccountId) -> bool {
        self.lifecycle_trusted_representations
            .get(&representation)
            .copied()
            .unwrap_or(false)
    }

    /// Whitelisted agent only, with an attached deposit that pays for storage
    /// (the excess is refunded). Reads the community's representation contract
    /// and records or withdraws its backing approval before lock. The
    /// representation must be trusted by the owner. Fixtures do not prove custody.
    #[payable]
    pub fn refresh_lifecycle_backing(&mut self, battle_id: u64, community: u32) -> Promise {
        self.assert_agent();
        require!(!self.paused, "Arena is paused");
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "Requires attached deposit of at least 1 yoctoNEAR"
        );
        let battle = self
            .lifecycle_battles
            .get(&battle_id)
            .unwrap_or_else(|| env::panic_str("Unknown battle"));
        require!(!battle.is_locked(), "Battle is locked");
        let representation = battle
            .community_asset(community as usize)
            .unwrap_or_else(|| env::panic_str("Unknown community"))
            .representation
            .clone();
        require!(
            self.is_lifecycle_representation_trusted(representation.clone()),
            "Representation is not trusted"
        );
        ext_representation::ext(representation.clone())
            .with_static_gas(VIEW_GAS)
            .get_asset()
            .and(
                ext_representation::ext(representation)
                    .with_static_gas(VIEW_GAS)
                    .get_ledger(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_attached_deposit(env::attached_deposit())
                    .on_lifecycle_backing_checked(
                        battle_id,
                        community,
                        env::predecessor_account_id(),
                    ),
            )
    }

    /// Stores or withdraws the approval from the two views. Never panics on a
    /// bad answer: it withdraws instead, and refunds the caller what storage
    /// did not use. Returns true only when an approval is stored.
    #[private]
    #[payable]
    pub fn on_lifecycle_backing_checked(
        &mut self,
        battle_id: u64,
        community: u32,
        caller: AccountId,
        #[callback_result] asset: Result<RepresentationAsset, PromiseError>,
        #[callback_result] ledger: Result<RepresentationLedger, PromiseError>,
    ) -> bool {
        let attached = env::attached_deposit().as_yoctonear();
        let committed = self
            .lifecycle_battles
            .get(&battle_id)
            .and_then(|battle| battle.community_asset(community as usize).cloned());
        let locked = self
            .lifecycle_battles
            .get(&battle_id)
            .is_none_or(|battle| battle.is_locked());
        let mut charged = 0u128;
        let mut approved = false;
        let mut evidence = None;
        if let (Some(committed), false) = (committed, locked) {
            let approval = evaluate_backing(
                &committed,
                asset,
                ledger,
                env::block_timestamp_ms(),
                env::block_height(),
            );
            let previous = self
                .lifecycle_battles
                .get(&battle_id)
                .and_then(|battle| battle.backing_of(community as usize).cloned());
            let before = env::storage_usage();
            if self
                .lifecycle_set_backing(battle_id, community as usize, approval.clone())
                .is_ok()
            {
                self.lifecycle_battles.flush();
                let cost = env::storage_byte_cost()
                    .as_yoctonear()
                    .saturating_mul(u128::from(env::storage_usage().saturating_sub(before)));
                if cost > attached {
                    // Not paid for: keep the earlier state.
                    let _ = self.lifecycle_set_backing(battle_id, community as usize, previous);
                    self.lifecycle_battles.flush();
                } else {
                    charged = cost;
                    approved = approval.is_some();
                    evidence = approval;
                }
            }
        }
        if attached > charged {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached - charged))
                .detach();
        }
        // D41: a creator escrow becomes the creator's position once both approvals exist.
        if approved {
            self.lifecycle_convert_creator_escrow(battle_id);
        }
        events::emit(
            "backing_updated",
            json!({
                "battle_id": battle_id,
                "community": community,
                "approved": approved,
                "evidence_hash": evidence.as_ref().map(|e| e.evidence_hash.clone()),
                "expires_at_ms": evidence.as_ref().map(|e| e.expires_at_ms.to_string()),
            }),
        );
        approved
    }
}
