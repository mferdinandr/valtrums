//! Protocol-controlled reference-token registry.
//!
//! GoPlus covers Robinhood mainnet (`4663`) only, so a testnet mock token is
//! audited and scored through the mainnet token it represents. This registry is
//! the single source of those mappings for the audit agent, the scoring oracle
//! and battle creation. Only the protocol account (`lifecycle_protocol`, a SputnikDAO council in
//! the target deployment) changes it, with exactly one yocto; the arena owner and creators
//! cannot add entries, and a reference pair a creator declares on a community
//! is accepted only when it equals the registered entry for that token.
//!
//! An entry attests nothing about the mock contract's behaviour: it only says
//! which mainnet token stands in for it. Every change bumps `version`, so a
//! reader can tell whether two reads saw the same registry.
use crate::{events, Arena, ArenaExt};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require};

/// The only chain reference tokens may live on (Robinhood mainnet, covered by GoPlus).
pub const REFERENCE_CHAIN_ID: u64 = 4663;
/// Upper bound on registered entries, keeping uniqueness checks and listing bounded.
pub const MAX_REFERENCE_ENTRIES: u32 = 256;
/// Most entries `get_reference_registry` returns in one call.
const MAX_REFERENCE_PAGE: u32 = 50;

/// A stored mapping; addresses are 20-byte lowercase hex with a `0x` prefix.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceEntry {
    pub chain_id: u64,
    pub token_address: String,
    pub reference_chain_id: u64,
    pub reference_address: String,
    /// Registry version at which this entry was added.
    pub added_in_version: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceEntryView {
    pub chain_id: U64,
    pub token_address: String,
    pub reference_chain_id: U64,
    pub reference_address: String,
    /// SHA-256 (hex) of the canonical entry; changes with any field.
    pub entry_hash: String,
    pub added_in_version: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceRegistryPage {
    /// Increases on every change; compare it across pages to detect a concurrent update.
    pub version: U64,
    pub total: u32,
    pub entries: Vec<ReferenceEntryView>,
}

/// Why a community's reference pair is refused at battle creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceCheck {
    /// The token is not registered and declares no reference: audited directly.
    Direct,
    /// The declared pair equals the registered entry.
    Registered,
    /// A reference pair is declared but the token has no registry entry.
    Unregistered,
    /// The token is registered but the declared pair is missing or different.
    Conflict,
}

/// Lowercase a 20-byte `0x` address, or `None` when it is malformed.
pub fn normalize_address(text: &str) -> Option<String> {
    let hex = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))?;
    if hex.len() == 40 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(format!("0x{}", hex.to_ascii_lowercase()))
    } else {
        None
    }
}

/// Canonical digest: SHA-256 over the JSON array
/// `["<chain_id>","<token>","<reference_chain_id>","<reference>"]` with
/// lowercase addresses. The agent computes the same digest and rejects an
/// entry whose reported hash differs.
pub fn entry_hash(
    chain_id: u64,
    token_address: &str,
    reference_chain_id: u64,
    reference_address: &str,
) -> String {
    let canonical = serde_json::to_string(&[
        chain_id.to_string(),
        token_address.to_ascii_lowercase(),
        reference_chain_id.to_string(),
        reference_address.to_ascii_lowercase(),
    ])
    .unwrap_or_else(|_| env::panic_str("Reference entry encoding failed"));
    env::sha256_array(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl ReferenceEntry {
    pub fn hash(&self) -> String {
        entry_hash(
            self.chain_id,
            &self.token_address,
            self.reference_chain_id,
            &self.reference_address,
        )
    }

    pub fn view(&self) -> ReferenceEntryView {
        ReferenceEntryView {
            chain_id: U64(self.chain_id),
            token_address: self.token_address.clone(),
            reference_chain_id: U64(self.reference_chain_id),
            reference_address: self.reference_address.clone(),
            entry_hash: self.hash(),
            added_in_version: U64(self.added_in_version),
        }
    }
}

/// Compare a declared reference pair (already lowercased) with the registered entry.
pub fn check_reference(
    entry: Option<&ReferenceEntry>,
    declared: Option<(u64, &str)>,
) -> ReferenceCheck {
    match (entry, declared) {
        (None, None) => ReferenceCheck::Direct,
        (None, Some(_)) => ReferenceCheck::Unregistered,
        (Some(e), Some((chain, address)))
            if e.reference_chain_id == chain
                && e.reference_address == address.to_ascii_lowercase() =>
        {
            ReferenceCheck::Registered
        }
        (Some(_), _) => ReferenceCheck::Conflict,
    }
}

impl Arena {
    pub(crate) fn reference_entry(
        &self,
        chain_id: u64,
        token_address: &str,
    ) -> Option<&ReferenceEntry> {
        self.lifecycle_reference_registry
            .get(&(chain_id, token_address.to_ascii_lowercase()))
    }

    /// Panics unless every community's reference pair agrees with the registry.
    pub(crate) fn assert_registered_references(&self, assets: &[crate::lifecycle::AssetIdentity]) {
        for asset in assets {
            let declared = match (asset.reference_chain_id, asset.reference_address.as_deref()) {
                (Some(chain), Some(address)) => Some((chain, address)),
                _ => None,
            };
            match check_reference(
                self.reference_entry(asset.chain_id, &asset.token_address),
                declared,
            ) {
                ReferenceCheck::Direct | ReferenceCheck::Registered => {}
                ReferenceCheck::Unregistered => {
                    env::panic_str("Reference mapping is not in the protocol registry")
                }
                ReferenceCheck::Conflict => {
                    env::panic_str("Reference mapping does not match the protocol registry")
                }
            }
        }
    }

    fn bump_reference_version(&mut self) -> u64 {
        self.lifecycle_reference_registry_version = self
            .lifecycle_reference_registry_version
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Registry version overflow"));
        self.lifecycle_reference_registry_version
    }
}

impl Arena {
    /// The registry changes only through the configured protocol account. With
    /// no protocol configured, nobody can change it (fail closed).
    fn assert_protocol(&self) {
        require!(
            self.lifecycle_protocol.as_ref() == Some(&env::predecessor_account_id()),
            "Only the protocol account can change the reference registry"
        );
    }
}

#[near]
impl Arena {
    /// Protocol account only, exactly one yocto. Registers the mainnet reference token for a
    /// testnet token. A token already registered, a reference already used by
    /// another token, a reference outside chain `4663` or a same-chain mapping is
    /// rejected; to change a mapping, remove it first. Existing battles keep the
    /// pair they committed; the audit re-checks it against the registry.
    #[payable]
    pub fn add_reference_entry(
        &mut self,
        chain_id: U64,
        token_address: String,
        reference_chain_id: U64,
        reference_address: String,
    ) -> ReferenceEntryView {
        self.assert_protocol();
        near_sdk::assert_one_yocto();
        let token = normalize_address(&token_address)
            .unwrap_or_else(|| env::panic_str("Invalid token address"));
        let reference = normalize_address(&reference_address)
            .unwrap_or_else(|| env::panic_str("Invalid reference address"));
        require!(chain_id.0 > 0, "Invalid chain id");
        require!(
            reference_chain_id.0 == REFERENCE_CHAIN_ID,
            "Reference tokens must be on chain 4663"
        );
        require!(
            chain_id.0 != reference_chain_id.0,
            "A token cannot reference its own chain"
        );
        let key = (chain_id.0, token.clone());
        require!(
            !self.lifecycle_reference_registry.contains_key(&key),
            "Token already has a reference entry"
        );
        require!(
            self.lifecycle_reference_registry.len() < MAX_REFERENCE_ENTRIES,
            "Reference registry is full"
        );
        require!(
            !self.lifecycle_reference_registry.values().any(|e| {
                e.reference_chain_id == reference_chain_id.0 && e.reference_address == reference
            }),
            "Reference token is already mapped to another token"
        );
        let version = self.bump_reference_version();
        let entry = ReferenceEntry {
            chain_id: chain_id.0,
            token_address: token,
            reference_chain_id: reference_chain_id.0,
            reference_address: reference,
            added_in_version: version,
        };
        let view = entry.view();
        self.lifecycle_reference_registry.insert(key, entry);
        self.lifecycle_reference_registry.flush();
        events::emit(
            "reference_registry_updated",
            json!({
                "action": "added",
                "chain_id": view.chain_id,
                "token_address": view.token_address,
                "reference_chain_id": view.reference_chain_id,
                "reference_address": view.reference_address,
                "entry_hash": view.entry_hash,
                "registry_version": U64(version),
            }),
        );
        view
    }

    /// Protocol account only, exactly one yocto. Removes a token's entry. Battles that
    /// committed the old pair are not changed, but the audit holds them as
    /// unregistered until the protocol registers a mapping again.
    #[payable]
    pub fn remove_reference_entry(&mut self, chain_id: U64, token_address: String) {
        self.assert_protocol();
        near_sdk::assert_one_yocto();
        let token = normalize_address(&token_address)
            .unwrap_or_else(|| env::panic_str("Invalid token address"));
        let entry = self
            .lifecycle_reference_registry
            .remove(&(chain_id.0, token))
            .unwrap_or_else(|| env::panic_str("Token has no reference entry"));
        self.lifecycle_reference_registry.flush();
        let version = self.bump_reference_version();
        events::emit(
            "reference_registry_updated",
            json!({
                "action": "removed",
                "chain_id": U64(entry.chain_id),
                "token_address": entry.token_address,
                "reference_chain_id": U64(entry.reference_chain_id),
                "reference_address": entry.reference_address,
                "entry_hash": entry.hash(),
                "registry_version": U64(version),
            }),
        );
    }

    /// The registered entry for a token, if any.
    pub fn get_reference_entry(
        &self,
        chain_id: U64,
        token_address: String,
    ) -> Option<ReferenceEntryView> {
        let token = normalize_address(&token_address)?;
        self.reference_entry(chain_id.0, &token)
            .map(ReferenceEntry::view)
    }

    /// One page of the registry in storage order (a removal may reorder it), with the current version.
    pub fn get_reference_registry(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> ReferenceRegistryPage {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_REFERENCE_PAGE).min(MAX_REFERENCE_PAGE) as usize;
        ReferenceRegistryPage {
            version: U64(self.lifecycle_reference_registry_version),
            total: self.lifecycle_reference_registry.len(),
            entries: self
                .lifecycle_reference_registry
                .values()
                .skip(from)
                .take(limit)
                .map(ReferenceEntry::view)
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::{AssetInput, ScoringMode};
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, AccountId, NearToken};

    const MOCK: &str = "0x00000000000000000000000000000000000000AA";
    const MOCK_LOWER: &str = "0x00000000000000000000000000000000000000aa";
    const REF: &str = "0x00000000000000000000000000000000000000bb";
    const REF_2: &str = "0x00000000000000000000000000000000000000cc";

    fn account(name: &str) -> AccountId {
        name.parse().expect("account")
    }

    fn context(caller: &str, deposit: NearToken) {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(account(caller))
            .attached_deposit(deposit);
        testing_env!(ctx.build());
    }

    fn arena() -> Arena {
        context("owner.testnet", NearToken::from_yoctonear(0));
        let mut arena = Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(5_000_000),
            U64(60),
        );
        context("owner.testnet", NearToken::from_yoctonear(1));
        arena.activate_lifecycle();
        arena.set_lifecycle_protocol(account("protocol.testnet"));
        arena
    }

    fn add(arena: &mut Arena, token: &str, reference: &str) -> ReferenceEntryView {
        context("protocol.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(46630), token.into(), U64(4663), reference.into())
    }

    fn asset(index: u8, reference: Option<&str>) -> AssetInput {
        AssetInput {
            chain_id: U64(46630),
            token_address: format!("0x{index:040x}"),
            representation: account(&format!("token{index}.testnet")),
            custody_domain: "vault".into(),
            reference_chain_id: reference.map(|_| U64(4663)),
            reference_address: reference.map(Into::into),
        }
    }

    fn create(arena: &mut Arena, assets: Vec<AssetInput>) -> u64 {
        context("creator.testnet", NearToken::from_near(1));
        arena.create_lifecycle_battle(assets, ScoringMode::PriceGain)
    }

    #[test]
    fn hash_matches_the_agent_encoding_and_changes_with_every_field() {
        // Same canonical JSON the agent hashes (agent/src/audit/reference.ts `entryHash`).
        let base = entry_hash(46630, MOCK, 4663, REF);
        // Shared test vector; agent/test/reference-registry.test.ts asserts the same value.
        assert_eq!(
            base,
            "1a9f51bcd129688ad0cad0dbef76323b7be455592fc583687713d438f82a4366"
        );
        assert_eq!(base, entry_hash(46630, MOCK_LOWER, 4663, REF));
        assert_ne!(base, entry_hash(46631, MOCK, 4663, REF));
        assert_ne!(base, entry_hash(46630, REF_2, 4663, REF));
        assert_ne!(base, entry_hash(46630, MOCK, 4664, REF));
        assert_ne!(base, entry_hash(46630, MOCK, 4663, REF_2));
    }

    #[test]
    fn protocol_registers_an_entry_and_views_report_it_with_its_hash() {
        let mut arena = arena();
        let view = add(&mut arena, MOCK, REF);
        assert_eq!(view.token_address, MOCK_LOWER);
        assert_eq!(view.entry_hash, entry_hash(46630, MOCK, 4663, REF));
        assert_eq!(view.added_in_version, U64(1));
        assert_eq!(
            arena.get_reference_entry(U64(46630), MOCK.into()),
            Some(view.clone())
        );
        let page = arena.get_reference_registry(None, None);
        assert_eq!(page.version, U64(1));
        assert_eq!(page.total, 1);
        assert_eq!(page.entries, vec![view]);
        assert!(
            get_logs()
                .iter()
                .any(|log| log.contains("\"reference_registry_updated\"")
                    && log.contains("\"added\""))
        );
    }

    #[test]
    #[should_panic(expected = "Only the protocol account can change the reference registry")]
    fn creators_cannot_add_entries() {
        let mut arena = arena();
        context("creator.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(46630), MOCK.into(), U64(4663), REF.into());
    }

    #[test]
    #[should_panic(expected = "Only the protocol account can change the reference registry")]
    fn the_arena_owner_cannot_add_entries() {
        let mut arena = arena();
        context("owner.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(46630), MOCK.into(), U64(4663), REF.into());
    }

    #[test]
    #[should_panic(expected = "Only the protocol account can change the reference registry")]
    fn the_arena_owner_cannot_remove_entries() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        context("owner.testnet", NearToken::from_yoctonear(1));
        arena.remove_reference_entry(U64(46630), MOCK.into());
    }

    #[test]
    #[should_panic(expected = "Only the protocol account can change the reference registry")]
    fn an_outsider_cannot_remove_entries() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        context("creator.testnet", NearToken::from_yoctonear(1));
        arena.remove_reference_entry(U64(46630), MOCK.into());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn removing_needs_exactly_one_yocto() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        context("protocol.testnet", NearToken::from_yoctonear(0));
        arena.remove_reference_entry(U64(46630), MOCK.into());
    }

    #[test]
    #[should_panic(expected = "Only the protocol account can change the reference registry")]
    fn nobody_can_change_the_registry_before_a_protocol_is_set() {
        context("owner.testnet", NearToken::from_yoctonear(0));
        let mut arena = Arena::new(
            account("owner.testnet"),
            account("usdc.testnet"),
            account("treasury.testnet"),
            U128(5_000_000),
            U64(60),
        );
        context("owner.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(46630), MOCK.into(), U64(4663), REF.into());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn adding_needs_exactly_one_yocto() {
        let mut arena = arena();
        context("protocol.testnet", NearToken::from_yoctonear(2));
        arena.add_reference_entry(U64(46630), MOCK.into(), U64(4663), REF.into());
    }

    #[test]
    #[should_panic(expected = "Token already has a reference entry")]
    fn duplicate_entry_is_rejected() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        add(&mut arena, MOCK_LOWER, REF);
    }

    #[test]
    #[should_panic(expected = "Token already has a reference entry")]
    fn conflicting_entry_for_a_registered_token_is_rejected() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        add(&mut arena, MOCK, REF_2);
    }

    #[test]
    #[should_panic(expected = "Reference token is already mapped to another token")]
    fn one_reference_cannot_back_two_tokens() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        add(&mut arena, REF_2, REF);
    }

    #[test]
    #[should_panic(expected = "Reference tokens must be on chain 4663")]
    fn reference_outside_chain_4663_is_rejected() {
        let mut arena = arena();
        context("protocol.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(46630), MOCK.into(), U64(1), REF.into());
    }

    #[test]
    #[should_panic(expected = "A token cannot reference its own chain")]
    fn same_chain_mapping_is_rejected() {
        let mut arena = arena();
        context("protocol.testnet", NearToken::from_yoctonear(1));
        arena.add_reference_entry(U64(4663), MOCK.into(), U64(4663), REF.into());
    }

    #[test]
    #[should_panic(expected = "Invalid reference address")]
    fn malformed_address_is_rejected() {
        let mut arena = arena();
        add(&mut arena, MOCK, "0x1234");
    }

    #[test]
    fn removing_bumps_the_version_and_allows_a_new_mapping() {
        let mut arena = arena();
        add(&mut arena, MOCK, REF);
        context("protocol.testnet", NearToken::from_yoctonear(1));
        arena.remove_reference_entry(U64(46630), MOCK.into());
        assert_eq!(arena.get_reference_entry(U64(46630), MOCK.into()), None);
        assert_eq!(arena.get_reference_registry(None, None).version, U64(2));
        let replaced = add(&mut arena, MOCK, REF_2);
        assert_eq!(replaced.added_in_version, U64(3));
        assert_ne!(replaced.entry_hash, entry_hash(46630, MOCK, 4663, REF));
    }

    #[test]
    #[should_panic(expected = "Token has no reference entry")]
    fn removing_an_unknown_entry_fails() {
        let mut arena = arena();
        context("protocol.testnet", NearToken::from_yoctonear(1));
        arena.remove_reference_entry(U64(46630), MOCK.into());
    }

    #[test]
    fn registry_pages_are_bounded() {
        let mut arena = arena();
        for index in 1..=60u8 {
            add(
                &mut arena,
                &format!("0x{index:040x}"),
                &format!("0x{:040x}", u32::from(index) + 1000),
            );
        }
        let first = arena.get_reference_registry(None, Some(500));
        assert_eq!(first.total, 60);
        assert_eq!(first.entries.len(), MAX_REFERENCE_PAGE as usize);
        let rest = arena.get_reference_registry(Some(MAX_REFERENCE_PAGE), None);
        assert_eq!(rest.entries.len(), 10);
        assert_eq!(first.version, U64(60));
    }

    #[test]
    fn battle_accepts_registered_and_direct_assets() {
        let mut arena = arena();
        let mock = format!("0x{:040x}", 1);
        add(&mut arena, &mock, REF);
        let id = create(&mut arena, vec![asset(1, Some(REF)), asset(2, None)]);
        assert_eq!(id, 1);
    }

    #[test]
    #[should_panic(expected = "Reference mapping is not in the protocol registry")]
    fn battle_rejects_a_self_declared_reference() {
        let mut arena = arena();
        create(&mut arena, vec![asset(1, Some(REF)), asset(2, None)]);
    }

    #[test]
    #[should_panic(expected = "Reference mapping does not match the protocol registry")]
    fn battle_rejects_a_reference_that_differs_from_the_registry() {
        let mut arena = arena();
        add(&mut arena, &format!("0x{:040x}", 1), REF);
        create(&mut arena, vec![asset(1, Some(REF_2)), asset(2, None)]);
    }

    #[test]
    #[should_panic(expected = "Reference mapping does not match the protocol registry")]
    fn battle_rejects_a_registered_token_without_its_reference() {
        let mut arena = arena();
        add(&mut arena, &format!("0x{:040x}", 1), REF);
        create(&mut arena, vec![asset(1, None), asset(2, None)]);
    }
}
