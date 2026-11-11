//! Per-mode observation policies (decision D40).
//!
//! The observation terms digest binds one scoring mode, but the arena kept a single policy for every lock. A battle
//! whose mode differed from that policy's mode could lock and then never start its rounds, keeping its deposits
//! locked. Once the owner sets a policy for any mode, the arena switches to per-mode policies: a battle can only be
//! created for a mode that has a policy, and the lock freezes that mode's policy. Until then the single legacy policy
//! keeps working unchanged. State lives in standalone maps under storage keys appended at the end of `StorageKey`, so
//! the contract state layout does not change.

use crate::lifecycle::{ObservationPolicy, ObservationPolicyInput, ScoringMode};
use crate::{Arena, ArenaExt, StorageKey};
use near_sdk::store::LookupMap;
use near_sdk::{near, require};

fn mode_key(mode: ScoringMode) -> u8 {
    match mode {
        ScoringMode::PriceGain => 0,
        ScoringMode::MarketCapGrowth => 1,
        ScoringMode::VolumeRatio => 2,
        ScoringMode::LowestDrawdown => 3,
    }
}

fn policy_map() -> LookupMap<u8, ObservationPolicy> {
    LookupMap::new(StorageKey::LifecycleModePolicy)
}

fn enabled_map() -> LookupMap<u8, bool> {
    LookupMap::new(StorageKey::LifecycleModePolicyEnabled)
}

impl Arena {
    pub(crate) fn lifecycle_mode_policies_enabled(&self) -> bool {
        enabled_map().get(&0).copied().unwrap_or(false)
    }

    /// The policy a lock of a battle in `mode` freezes: the mode's own policy once per-mode policies are enabled,
    /// otherwise the single legacy policy.
    pub(crate) fn lifecycle_policy_for(&self, mode: ScoringMode) -> Option<ObservationPolicy> {
        if self.lifecycle_mode_policies_enabled() {
            policy_map().get(&mode_key(mode)).cloned()
        } else {
            self.lifecycle_observation_policy.clone()
        }
    }

    /// Refuses a new battle in a mode no observation policy can run (only once per-mode policies are enabled).
    pub(crate) fn lifecycle_assert_mode_offered(&self, mode: ScoringMode) {
        if self.lifecycle_mode_policies_enabled() {
            require!(
                policy_map().contains_key(&mode_key(mode)),
                "No observation policy for this scoring mode"
            );
        }
    }
}

#[near]
impl Arena {
    /// Owner only, exactly one yocto. Sets (or clears with `None`) the observation policy for one scoring mode.
    /// The first call enables per-mode policies for every later creation and lock; existing locked battles keep the
    /// policy they froze.
    #[payable]
    pub fn set_lifecycle_mode_observation_policy(
        &mut self,
        mode: ScoringMode,
        policy: Option<ObservationPolicyInput>,
    ) {
        self.assert_owner();
        near_sdk::assert_one_yocto();
        let mut map = policy_map();
        match policy {
            Some(input) => {
                let policy: ObservationPolicy = input.into();
                require!(policy.is_valid(), "Observation policy is invalid");
                map.insert(mode_key(mode), policy);
            }
            None => {
                map.remove(&mode_key(mode));
            }
        }
        map.flush();
        let mut enabled = enabled_map();
        if !enabled.get(&0).copied().unwrap_or(false) {
            enabled.insert(0, true);
            enabled.flush();
        }
    }

    pub fn get_lifecycle_mode_observation_policy(
        &self,
        mode: ScoringMode,
    ) -> Option<ObservationPolicyInput> {
        policy_map()
            .get(&mode_key(mode))
            .cloned()
            .map(|p| ObservationPolicyInput {
                version: near_sdk::json_types::U64(p.version),
                policy_hash: p.policy_hash,
            })
    }

    pub fn is_lifecycle_mode_policy_enabled(&self) -> bool {
        self.lifecycle_mode_policies_enabled()
    }
}
