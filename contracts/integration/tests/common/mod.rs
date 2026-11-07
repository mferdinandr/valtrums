#![allow(dead_code)]

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Once;

pub const USDC: u128 = 1_000_000; // 6 decimals
pub const COIN: u128 = 1_000_000_000_000_000_000; // 18 decimals
pub const BOND: u128 = 5 * USDC;
/// 1 USDC buys 1000 PEPE: out = in * RATE_NUM / 1
pub const USDC_TO_COIN_NUM: u128 = 1_000_000_000_000_000;

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
                "valtrum-payout",
                "-p",
                "valtrum-receipt-registry",
                "-p",
                "valtrum-router",
                "-p",
                "valtrum-mock-dex",
                "-p",
                "valtrum-mock-ft",
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

/// A full deployment: three tokens, arena, router and mock DEX, all wired together.
pub struct Env {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub agent: Account,
    pub treasury: Account,
    pub burn: Account,
    pub usdc: Contract,
    pub pepe: Contract,
    pub shib: Contract,
    pub arena: Contract,
    pub router: Contract,
    pub dex: Contract,
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

fn yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

impl Env {
    /// `window_secs` is the deposit window; `onchain` turns on settlement execution
    /// through the mock DEX (otherwise the agent reports amounts).
    pub async fn new(window_secs: u64, onchain: bool) -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let mut accounts = Vec::new();
        for name in ["owner", "agent", "treasury", "burn"] {
            accounts.push(
                root.create_subaccount(name)
                    .initial_balance(near(30))
                    .transact()
                    .await?
                    .into_result()?,
            );
        }
        let burn = accounts.pop().expect("burn");
        let treasury = accounts.pop().expect("treasury");
        let agent = accounts.pop().expect("agent");
        let owner = accounts.pop().expect("owner");

        let mut contracts = Vec::new();
        for (name, wasm_name) in [
            ("usdc", "valtrum_mock_ft"),
            ("pepe", "valtrum_mock_ft"),
            ("shib", "valtrum_mock_ft"),
            ("arena", "valtrum_arena"),
            ("router", "valtrum_router"),
            ("dex", "valtrum_mock_dex"),
        ] {
            let account = root
                .create_subaccount(name)
                .initial_balance(near(30))
                .transact()
                .await?
                .into_result()?;
            contracts.push(account.deploy(&wasm(wasm_name)).await?.into_result()?);
        }
        let dex = contracts.pop().expect("dex");
        let router = contracts.pop().expect("router");
        let arena = contracts.pop().expect("arena");
        let shib = contracts.pop().expect("shib");
        let pepe = contracts.pop().expect("pepe");
        let usdc = contracts.pop().expect("usdc");

        for (token, name, symbol, decimals) in [
            (&usdc, "Mock USDC", "USDC", 6),
            (&pepe, "Mock PEPE", "PEPE", 18),
            (&shib, "Mock SHIB", "SHIB", 18),
        ] {
            token
                .call("new")
                .args_json(json!({ "name": name, "symbol": symbol, "decimals": decimals }))
                .transact()
                .await?
                .into_result()?;
        }
        arena
            .call("new")
            .args_json(json!({
                "owner": owner.id(),
                "usdc": usdc.id(),
                "treasury": treasury.id(),
                "bond": BOND.to_string(),
                "deposit_window_secs": window_secs.to_string(),
            }))
            .transact()
            .await?
            .into_result()?;
        router
            .call("new")
            .args_json(json!({
                "owner": owner.id(),
                "arena": arena.id(),
                "dex": dex.id(),
                "usdc": usdc.id(),
            }))
            .transact()
            .await?
            .into_result()?;
        dex.call("new")
            .args_json(json!({ "owner": owner.id() }))
            .transact()
            .await?
            .into_result()?;

        let env = Self {
            worker,
            owner,
            agent,
            treasury,
            burn,
            usdc,
            pepe,
            shib,
            arena,
            router,
            dex,
        };

        // every account that holds tokens must be registered with each token
        for token in [&env.usdc, &env.pepe, &env.shib] {
            for who in [
                env.arena.id(),
                env.router.id(),
                env.dex.id(),
                env.treasury.id(),
                env.burn.id(),
            ] {
                env.register(token, who).await?;
            }
        }

        env.owner
            .call(env.arena.id(), "add_agent")
            .args_json(json!({ "account_id": env.agent.id() }))
            .transact()
            .await?
            .into_result()?;
        env.owner
            .call(env.arena.id(), "set_router")
            .args_json(json!({ "router": env.router.id() }))
            .transact()
            .await?
            .into_result()?;
        if onchain {
            env.owner
                .call(env.arena.id(), "set_execution")
                .args_json(json!({ "dex": env.dex.id(), "burn_account": env.burn.id() }))
                .transact()
                .await?
                .into_result()?;
        }
        Ok(env)
    }

    pub async fn register(&self, token: &Contract, who: &AccountId) -> anyhow::Result<()> {
        self.owner
            .call(token.id(), "storage_deposit")
            .args_json(json!({ "account_id": who, "registration_only": true }))
            .deposit(NearToken::from_millinear(20))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// A funded user account, registered with all three tokens.
    pub async fn user(&self, name: &str) -> anyhow::Result<Account> {
        let account = self
            .worker
            .root_account()?
            .create_subaccount(name)
            .initial_balance(near(10))
            .transact()
            .await?
            .into_result()?;
        for token in [&self.usdc, &self.pepe, &self.shib] {
            self.register(token, account.id()).await?;
        }
        Ok(account)
    }

    pub async fn mint(
        &self,
        token: &Contract,
        who: &AccountId,
        amount: u128,
    ) -> anyhow::Result<()> {
        self.owner
            .call(token.id(), "mint")
            .args_json(json!({ "account_id": who, "amount": amount.to_string() }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    pub async fn balance(&self, token: &Contract, who: &AccountId) -> anyhow::Result<u128> {
        let value: String = token
            .view("ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await?
            .json()?;
        Ok(value.parse()?)
    }

    /// `ft_transfer_call` with the maximum gas, so a multi-hop chain gets everything.
    pub async fn transfer_call(
        &self,
        from: &Account,
        token: &Contract,
        receiver: &AccountId,
        amount: u128,
        msg: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(from
            .call(token.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": receiver,
                "amount": amount.to_string(),
                "msg": msg.to_string(),
            }))
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?)
    }

    /// Calls an arena method as `who` (no attached deposit).
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

    /// Calls an arena method that requires 1 yoctoNEAR.
    pub async fn arena_call_yocto(
        &self,
        who: &Account,
        method: &str,
        args: Value,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(who
            .call(self.arena.id(), method)
            .args_json(args)
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?)
    }

    pub async fn arena_view(&self, method: &str, args: Value) -> anyhow::Result<Value> {
        Ok(self.arena.view(method).args_json(args).await?.json()?)
    }

    pub async fn battle(&self, id: u64) -> anyhow::Result<Value> {
        self.arena_view("get_battle", json!({ "battle_id": id }))
            .await
    }

    pub async fn status(&self, id: u64) -> anyhow::Result<String> {
        Ok(self.battle(id).await?["status"]
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    pub async fn liquid(&self, who: &AccountId, token: &Contract) -> anyhow::Result<u128> {
        let value: String = self
            .arena
            .view("get_liquid_balance")
            .args_json(json!({ "account_id": who, "token_id": token.id() }))
            .await?
            .json()?;
        Ok(value.parse()?)
    }

    /// Advances the sandbox until its block time reaches `timestamp_ns`.
    pub async fn advance_to(&self, timestamp_ns: u64) -> anyhow::Result<()> {
        for _ in 0..200 {
            if self.worker.view_block().await?.timestamp() >= timestamp_ns {
                return Ok(());
            }
            self.worker.fast_forward(100).await?;
        }
        anyhow::bail!("sandbox did not reach {timestamp_ns}")
    }

    /// Proposes a PEPE (A) vs SHIB (B) battle and returns its id.
    pub async fn propose(&self, creator: &Account, duration_secs: u64) -> anyhow::Result<u64> {
        self.mint(&self.usdc, creator.id(), BOND).await?;
        self.transfer_call(
            creator,
            &self.usdc,
            self.arena.id(),
            BOND,
            json!({
                "action": "propose",
                "token_a": self.pepe.id(),
                "token_b": self.shib.id(),
                "duration_secs": duration_secs,
            }),
        )
        .await?
        .into_result()?;
        Ok(self
            .arena_view("get_battle_count", json!({}))
            .await?
            .as_u64()
            .unwrap_or_default())
    }

    /// Gives the DEX `amount` of `token` to pay out.
    pub async fn add_liquidity(&self, token: &Contract, amount: u128) -> anyhow::Result<()> {
        self.mint(token, self.owner.id(), amount).await?;
        self.transfer_call(
            &self.owner,
            token,
            self.dex.id(),
            amount,
            json!({ "action": "add_liquidity" }),
        )
        .await?
        .into_result()?;
        Ok(())
    }

    pub async fn set_rate(
        &self,
        token_in: &Contract,
        token_out: &Contract,
        num: u128,
        den: u128,
    ) -> anyhow::Result<()> {
        self.owner
            .call(self.dex.id(), "set_rate")
            .args_json(json!({
                "token_in": token_in.id(),
                "token_out": token_out.id(),
                "num": num.to_string(),
                "den": den.to_string(),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
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

mod wide {
    #![allow(clippy::all)]
    uint::construct_uint! {
        pub struct U256(4);
    }
}

/// `floor(a * b / c)` without overflow, to mirror the contract's reward math.
pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    use wide::U256;
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}
