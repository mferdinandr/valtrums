#![allow(dead_code)]

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Once;

/// Robinhood Chain testnet id used across the new design.
pub const CHAIN_ID: u64 = 46630;
pub const DECIMALS: u8 = 18;
/// USD 10,000 minimum LP, scaled by 1e6.
pub const LP_MIN_SCALED: u128 = 10_000 * 1_000_000;
pub const ROUND_SECS: u64 = 30;

static BUILD: Once = Once::new();

/// Builds every contract once per test run and returns the wasm bytes for `name`
/// (the crate's library name, for example `valtrum_arena`).
pub fn wasm(name: &str) -> Vec<u8> {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("workspace dir")
        .to_path_buf();
    BUILD.call_once(|| {
        let status = Command::new("cargo")
            .current_dir(&workspace)
            .args([
                "build",
                "--release",
                "--target",
                "wasm32-unknown-unknown",
                "-p",
                "valtrum-arena",
                "-p",
                "valtrum-backing",
                "-p",
                "valtrum-mock-mpc",
            ])
            .status()
            .expect("cargo build");
        assert!(status.success(), "contract build failed");
    });
    let path = workspace
        .join("target/wasm32-unknown-unknown/release")
        .join(format!("{name}.wasm"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// A full deployment: arena + per-asset backing contracts + mock MPC.
pub struct Env {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub protocol: Account,
    pub auditor: Account,
    pub arena: Contract,
    pub mpc: Contract,
    pub backing_a: Contract,
    pub backing_b: Contract,
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

pub fn yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

/// A Robinhood token identity for the sandbox.
pub fn token_identity(symbol: &str, backing: &AccountId) -> Value {
    token_identity_with(&format!("0x{symbol}"), symbol, backing)
}

/// A Robinhood token identity with an explicit full token address.
pub fn token_identity_with(token_address: &str, symbol: &str, backing: &AccountId) -> Value {
    json!({
        "chain_id": CHAIN_ID,
        "token_address": token_address,
        "backing": backing,
        "decimals": DECIMALS,
        "custody_domain": "robinhood-testnet",
        "symbol": symbol,
    })
}

impl Env {
    pub async fn new() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let mut accounts = Vec::new();
        for name in ["owner", "protocol", "auditor"] {
            accounts.push(
                root.create_subaccount(name)
                    .initial_balance(near(30))
                    .transact()
                    .await?
                    .into_result()?,
            );
        }
        let auditor = accounts.pop().expect("auditor");
        let protocol = accounts.pop().expect("protocol");
        let owner = accounts.pop().expect("owner");

        let mut contracts = Vec::new();
        for name in ["arena", "mpc", "backing_a", "backing_b"] {
            let account = root
                .create_subaccount(name)
                .initial_balance(near(30))
                .transact()
                .await?
                .into_result()?;
            let wasm_name = if name == "mpc" {
                "valtrum_mock_mpc"
            } else if name.starts_with("backing") {
                "valtrum_backing"
            } else {
                "valtrum_arena"
            };
            contracts.push(account.deploy(&wasm(wasm_name)).await?.into_result()?);
        }
        let backing_b = contracts.pop().expect("backing_b");
        let backing_a = contracts.pop().expect("backing_a");
        let mpc = contracts.pop().expect("mpc");
        let arena = contracts.pop().expect("arena");

        arena
            .call("new")
            .args_json(json!({ "owner": owner.id(), "protocol": protocol.id() }))
            .transact()
            .await?
            .into_result()?;
        mpc.call("new").args_json(json!({})).transact().await?.into_result()?;
        for (backing, symbol) in [(&backing_a, "a"), (&backing_b, "b")] {
            backing
                .call("new")
                .args_json(json!({
                    "owner": owner.id(),
                    "verifier": auditor.id(),
                    "identity": {
                        "chain_id": CHAIN_ID,
                        "token_address": format!("0x{symbol}"),
                        "decimals": DECIMALS,
                        "custody_domain": "robinhood-testnet",
                        "symbol": symbol,
                        "name": format!("Token {symbol}"),
                    },
                }))
                .transact()
                .await?
                .into_result()?;
        }

        owner
            .call(arena.id(), "add_worker")
            .args_json(json!({ "account_id": auditor.id() }))
            .transact()
            .await?
            .into_result()?;
        owner
            .call(arena.id(), "set_policy")
            .args_json(json!({ "version": 1, "policy_hash": "policy-v1" }))
            .transact()
            .await?
            .into_result()?;
        owner
            .call(arena.id(), "set_foreign")
            .args_json(json!({
                "config": { "mpc_contract": mpc.id(), "chain_id": CHAIN_ID.to_string() },
            }))
            .transact()
            .await?
            .into_result()?;
        owner
            .call(arena.id(), "set_audit_ttl_secs")
            .args_json(json!({ "secs": "604800" }))
            .transact()
            .await?
            .into_result()?;

        for backing in [&backing_a, &backing_b] {
            owner
                .call(backing.id(), "set_arena")
                .args_json(json!({ "arena": arena.id() }))
                .transact()
                .await?
                .into_result()?;
        }

        let env = Self {
            worker,
            owner,
            protocol,
            auditor,
            arena,
            mpc,
            backing_a,
            backing_b,
        };

        // every account that can hold or receive representations must be registered
        for backing in [&env.backing_a, &env.backing_b] {
            for who in [env.arena.id(), env.owner.id()] {
                env.register(backing, who).await?;
            }
        }
        Ok(env)
    }

    pub async fn register(&self, backing: &Contract, who: &AccountId) -> anyhow::Result<()> {
        self.owner
            .call(backing.id(), "storage_deposit")
            .args_json(json!({ "account_id": who, "registration_only": true }))
            .deposit(NearToken::from_millinear(20))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// A funded user account, registered with both backing tokens.
    pub async fn user(&self, name: &str) -> anyhow::Result<Account> {
        let account = self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(near(10))
            .transact()
            .await?
            .into_result()?;
        for backing in [&self.backing_a, &self.backing_b] {
            self.register(backing, account.id()).await?;
        }
        Ok(account)
    }

    pub fn backings(&self) -> [&Contract; 2] {
        [&self.backing_a, &self.backing_b]
    }

    pub async fn balance(&self, backing: &Contract, who: &AccountId) -> anyhow::Result<u128> {
        let value: String = backing
            .view("ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await?
            .json()?;
        Ok(value.parse()?)
    }

    /// The auditor verifies a custody receipt attributed to `origin`, then
    /// `origin` claims the representation: `U -> M`.
    pub async fn grant_representation(
        &self,
        origin: &Account,
        backing: &Contract,
        amount: u128,
        index: u32,
    ) -> anyhow::Result<()> {
        self.auditor
            .call(backing.id(), "verify_receipt")
            .args_json(json!({
                "receipt": {
                    "chain_id": CHAIN_ID,
                    "tx_hash": format!("0x{}-{index}", origin.id().as_str()),
                    "log_index": index,
                },
                "received_src": amount.to_string(),
                "src_decimals": DECIMALS,
                "origin": origin.id(),
            }))
            .transact()
            .await?
            .into_result()?;
        origin
            .call(backing.id(), "claim_deposit")
            .args_json(json!({
                "beneficiary": origin.id(),
                "amount": amount.to_string(),
            }))
            .deposit(yocto())
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Deposits `amount` representations of `backing` into the arena for a
    /// battle community via `ft_transfer_call`.
    pub async fn deposit(
        &self,
        from: &Account,
        backing: &Contract,
        amount: u128,
        battle_id: u64,
        community_index: u16,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(backing.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.arena.id(),
                "amount": amount.to_string(),
                "memo": None::<String>,
                "msg": json!({
                    "battle_id": battle_id,
                    "community_index": community_index,
                })
                .to_string(),
            }))
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?)
    }

    /// Calls an arena method as `who`.
    pub async fn arena_call(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.arena.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    /// Calls a method on `contract` as `who`.
    pub async fn contract_call(
        &self,
        who: &Account,
        contract: &Contract,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(contract.id(), method)
            .args_json(args)
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn arena_view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.arena.view(method).args_json(args).await?.json()?)
    }

    pub async fn battle(&self, id: u64) -> anyhow::Result<Value> {
        self.arena_view("battle", json!({ "battle_id": id })).await
    }

    pub async fn status(&self, id: u64) -> anyhow::Result<String> {
        Ok(self.battle(id).await?["status"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    pub async fn ledger(&self, backing: &Contract) -> anyhow::Result<Value> {
        Ok(backing.view("ledger").args_json(json!({})).await?.json()?)
    }

    pub async fn invariant_holds(&self, backing: &Contract) -> anyhow::Result<bool> {
        Ok(self.ledger(backing).await?["invariant_holds"]
            .as_bool()
            .unwrap_or(false))
    }

    /// Current sandbox block timestamp in nanoseconds.
    pub async fn now(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Advances the sandbox until its block time reaches `timestamp_ns`.
    pub async fn advance_to(&self, timestamp_ns: u64) -> anyhow::Result<()> {
        for _ in 0..300 {
            if self.worker.view_block().await?.timestamp() >= timestamp_ns {
                return Ok(());
            }
            self.worker.fast_forward(100).await?;
        }
        anyhow::bail!("sandbox did not reach {timestamp_ns}")
    }

    // ─── Battle plumbing ────────────────────────────────────────────────

    /// Fresh passing GoPlus evidence bound to `symbol`'s token address.
    pub async fn goplus_pass(&self, symbol: &str) -> anyhow::Result<Value> {
        self.goplus_pass_at(&format!("0x{symbol}")).await
    }

    /// Fresh passing GoPlus evidence bound to an explicit token address.
    pub async fn goplus_pass_at(&self, token_address: &str) -> anyhow::Result<Value> {
        Ok(json!({
            "chain_id": CHAIN_ID,
            "token_address": token_address,
            "provider_version": "v1",
            "policy_version": 1,
            "queried_at_ns": self.now().await?.to_string(),
            "is_honeypot": "False",
            "cannot_sell_all": "False",
            "cannot_buy": "False",
            "buy_tax": 0,
            "sell_tax": 0,
            "transfer_tax": 0,
            "coverage_complete": true,
            "tax_policy_resolved": false,
            "evidence_hash": "h",
        }))
    }

    pub async fn lp_pass(&self) -> anyhow::Result<Value> {
        Ok(json!({
            "usd_value_scaled": "11000000000",
            "source": "lpsource",
            "observed_at_ns": self.now().await?.to_string(),
            "evidence_hash": "h",
        }))
    }

    /// Creates a battle between tokens `a` and `b` as `creator`, then the
    /// auditor submits passing evidence for both communities.
    pub async fn create_and_audit(&self, creator: &Account) -> anyhow::Result<u64> {
        let id = self
            .arena_call(
                creator,
                "create_battle",
                json!({
                    "mode": "PriceGain",
                    "communities": [
                        token_identity("a", self.backing_a.id()),
                        token_identity("b", self.backing_b.id()),
                    ],
                    "protocol_created": false,
                }),
            )
            .await?
            .json::<u64>()?;
        self.submit_audits(id).await?;
        Ok(id)
    }

    /// Like [`create_and_audit`], but with explicit full token addresses
    /// (needed when a payout transaction must be built for the token).
    pub async fn create_and_audit_with(
        &self,
        creator: &Account,
        token_a: &str,
        token_b: &str,
    ) -> anyhow::Result<u64> {
        let id = self
            .arena_call(
                creator,
                "create_battle",
                json!({
                    "mode": "PriceGain",
                    "communities": [
                        token_identity_with(token_a, "a", self.backing_a.id()),
                        token_identity_with(token_b, "b", self.backing_b.id()),
                    ],
                    "protocol_created": false,
                }),
            )
            .await?
            .json::<u64>()?;
        for (index, address) in [(0u16, token_a), (1, token_b)] {
            self.arena_call(
                &self.auditor,
                "submit_audit",
                json!({
                    "battle_id": id,
                    "community_index": index,
                    "goplus": self.goplus_pass_at(address).await?,
                    "lp": self.lp_pass().await?,
                }),
            )
            .await?
            .into_result()?;
        }
        Ok(id)
    }

    pub async fn submit_audits(&self, battle_id: u64) -> anyhow::Result<()> {
        for (index, symbol) in [(0u16, "a"), (1, "b")] {
            self.arena_call(
                &self.auditor,
                "submit_audit",
                json!({
                    "battle_id": battle_id,
                    "community_index": index,
                    "goplus": self.goplus_pass(symbol).await?,
                    "lp": self.lp_pass().await?,
                }),
            )
            .await?
            .into_result()?;
        }
        Ok(())
    }

    pub async fn lock(&self, battle_id: u64) -> anyhow::Result<()> {
        self.arena_call(&self.auditor, "lock", json!({ "battle_id": battle_id }))
            .await?
            .into_result()?;
        Ok(())
    }

    /// Start/end prices for the current round: `end_a` and `end_b` decide the
    /// winner (community 0 wins when `end_a > end_b`).
    pub async fn submit_prices(
        &self,
        battle_id: u64,
        end_a: u128,
        end_b: u128,
    ) -> anyhow::Result<()> {
        let args = json!([
            { "battle_id": battle_id, "community_index": 0, "kind": { "kind": "start_price", "price": "100" } },
            { "battle_id": battle_id, "community_index": 1, "kind": { "kind": "start_price", "price": "100" } },
            { "battle_id": battle_id, "community_index": 0, "kind": { "kind": "end_price", "price": end_a.to_string() } },
            { "battle_id": battle_id, "community_index": 1, "kind": { "kind": "end_price", "price": end_b.to_string() } },
        ]);
        for arg in args.as_array().expect("args") {
            self.arena_call(&self.auditor, "submit_observation", arg.clone())
                .await?
                .into_result()?;
        }
        Ok(())
    }

    /// Submits identical prices for both communities (a guaranteed tie).
    pub async fn submit_tied_prices(&self, battle_id: u64) -> anyhow::Result<()> {
        self.submit_prices(battle_id, 110, 110).await
    }

    /// Waits past the current round end and resolves it.
    pub async fn resolve(&self, battle_id: u64) -> anyhow::Result<()> {
        let round_end_ns = self.battle(battle_id).await?["round_end_ns"]
            .as_str()
            .and_then(|text| text.parse::<u64>().ok())
            .unwrap_or_default();
        self.advance_to(round_end_ns + 1).await?;
        self.arena_call(&self.auditor, "resolve_round", json!({ "battle_id": battle_id }))
            .await?
            .into_result()?;
        Ok(())
    }

    /// A helper used by the mpc tests: fully settles a battle where community 0
    /// wins, and pays `q` of the loser's pool to `beneficiary`.
    pub async fn settle_and_pay(
        &self,
        creator: &Account,
        beneficiary: &Account,
        q: u128,
    ) -> anyhow::Result<(u64, u64, Value)> {
        let id = self.create_and_audit(creator).await?;
        self.deposit(creator, &self.backing_a, 500, id, 0)
            .await?
            .into_result()?;
        self.deposit(&self.auditor, &self.backing_b, 500, id, 1)
            .await?
            .into_result()?;
        self.lock(id).await?;
        self.submit_prices(id, 110, 105).await?;
        self.resolve(id).await?;

        // community 0 wins: community 1's 500 units become the reward pool.
        self.arena_call(&self.auditor, "allocate_loser", json!({ "battle_id": id, "community_index": 1 }))
            .await?
            .into_result()?;

        beneficiary
            .call(self.arena.id(), "register_recipient")
            .args_json(json!({ "address": format!("0x{}", "ab".repeat(20)) }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        self.arena_call(
            beneficiary,
            "request_payout",
            json!({
                "battle_id": id,
                "community_index": 1,
                "beneficiary": beneficiary.id(),
                "q": q.to_string(),
            }),
        )
        .await?
        .into_result()?;
        let payout: Value = self
            .backing_b
            .view("payout")
            .args_json(json!({ "payout_id": 1 }))
            .await?
            .json()?;
        Ok((id, payout["nonce"].as_u64().unwrap_or_default(), payout))
    }
}

/// Parses a `U128` JSON string.
pub fn amount(value: &Value) -> u128 {
    value
        .as_str()
        .unwrap_or("0")
        .parse()
        .unwrap_or_else(|_| panic!("not an amount: {value}"))
}

/// Parses `0x…` into a 20-byte address, or pads a short hex string.
pub fn addr(text: &str) -> Vec<u8> {
    let hex: String = text
        .trim_start_matches("0x")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let mut bytes = hex
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let pair_str = std::str::from_utf8(pair).expect("ascii");
            u8::from_str_radix(pair_str, 16).expect("hex")
        })
        .collect::<Vec<u8>>();
    if bytes.len() < 20 {
        let mut padded = vec![0u8; 20 - bytes.len()];
        padded.extend_from_slice(&bytes);
        bytes = padded;
    }
    bytes
}