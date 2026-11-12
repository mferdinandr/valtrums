mod common;

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

// Integration of the real arena with real backing representations, the real
// receipt registry, the arena audit entry point and the arena scoring path.
// What is real: contract code and their cross-contract calls in the NEAR sandbox.
// What is a FIXTURE: registry claims (a stand-in verifier account attests them),
// custody balances (a stand-in operator attests them), audit evidence hashes and
// observation data (no GoPlus, no mainnet RPC, no market data). None of this
// proves live custody, a live audit or live scoring.

const CHAIN: &str = "46630";
const DOMAIN: &str = "fixture";

fn token(index: usize) -> String {
    format!("0x{:040x}", index + 1)
}

struct World {
    worker: near_workspaces::Worker<near_workspaces::network::Sandbox>,
    registry: Contract,
    arena: Contract,
    reps: Vec<Contract>,
    /// A backing instance for a different asset (token 0x..ff), used for mismatches.
    wrong: Contract,
    owner: Account,
    verifier: Account,
    agent: Account,
    oracle: Account,
    payout: Account,
    operator: Account,
    creator: Account,
    player: Account,
    relayer: Account,
    next_tx: u8,
}

fn yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

async fn ok(call: impl std::future::Future<Output = anyhow::Result<ExecutionFinalResult>>) -> bool {
    match call.await {
        Ok(result) => result.into_result().is_ok(),
        Err(_) => false,
    }
}

async fn world(communities: usize) -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker
        .dev_deploy(&common::wasm("valtrum_receipt_registry"))
        .await?;
    let arena = worker.dev_deploy(&common::wasm("valtrum_arena")).await?;
    let owner = worker.dev_create_account().await?;
    let verifier = worker.dev_create_account().await?;
    let agent = worker.dev_create_account().await?;
    let oracle = worker.dev_create_account().await?;
    let payout = worker.dev_create_account().await?;
    let operator = worker.dev_create_account().await?;
    let creator = worker.dev_create_account().await?;
    let player = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    registry
        .call("new")
        .args_json(json!({"owner": owner.id(), "verifier": verifier.id()}))
        .transact()
        .await?
        .into_result()?;
    arena
        .call("new")
        .args_json(json!({
            "owner": owner.id(), "usdc": "usdc.fixture.near", "treasury": owner.id(),
            "bond": "0", "deposit_window_secs": "60"
        }))
        .transact()
        .await?
        .into_result()?;
    let mut reps = Vec::new();
    for index in 0..communities {
        reps.push(
            deploy_backing(&worker, &owner, &registry, &arena, &payout, &token(index)).await?,
        );
    }
    let wrong = deploy_backing(
        &worker,
        &owner,
        &registry,
        &arena,
        &payout,
        &format!("0x{:040x}", 255),
    )
    .await?;
    let w = World {
        worker,
        registry,
        arena,
        reps,
        wrong,
        owner,
        verifier,
        agent,
        oracle,
        payout,
        operator,
        creator,
        player,
        relayer,
        next_tx: 1,
    };
    // Owner configuration: agent, lifecycle, trust list, oracle, observation policy.
    let owner_call = |method: &'static str, args: Value, deposit: NearToken| {
        w.owner
            .call(w.arena.id(), method)
            .args_json(args)
            .deposit(deposit)
            .max_gas()
            .transact()
    };
    owner_call(
        "add_agent",
        json!({"account_id": w.agent.id()}),
        NearToken::from_yoctonear(0),
    )
    .await?
    .into_result()?;
    owner_call("activate_lifecycle", json!({}), yocto())
        .await?
        .into_result()?;
    owner_call(
        "set_lifecycle_protocol",
        json!({"protocol": w.owner.id()}),
        yocto(),
    )
    .await?
    .into_result()?;
    owner_call(
        "set_lifecycle_oracle",
        json!({"oracle": w.oracle.id()}),
        yocto(),
    )
    .await?
    .into_result()?;
    // The protocol (here the owner) sets the DAO vote window, which battles
    // created afterwards snapshot. 29 seconds is below the 30-second bound.
    assert!(owner_call(
        "set_lifecycle_dao_window",
        json!({"window_secs": "29"}),
        yocto(),
    )
    .await?
    .is_failure());
    owner_call(
        "set_lifecycle_dao_window",
        json!({"window_secs": "30"}),
        yocto(),
    )
    .await?
    .into_result()?;
    owner_call(
        "set_lifecycle_dao_window",
        json!({"window_secs": "60"}),
        yocto(),
    )
    .await?
    .into_result()?;
    owner_call(
        "set_lifecycle_observation_policy",
        json!({"policy": {"version": "1", "policy_hash": terms_digest()}}),
        yocto(),
    )
    .await?
    .into_result()?;
    for rep in w.reps.iter().chain(std::iter::once(&w.wrong)) {
        w.owner
            .call(w.registry.id(), "set_representation")
            .args_json(json!({"representation": rep.id(), "allowed": true}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
        w.owner
            .call(rep.id(), "set_operator")
            .args_json(json!({"operator": w.operator.id()}))
            .deposit(yocto())
            .transact()
            .await?
            .into_result()?;
        // The arena must hold a representation balance to receive deposits.
        w.owner
            .call(rep.id(), "storage_deposit")
            .args_json(json!({"account_id": w.arena.id(), "registration_only": true}))
            .deposit(NearToken::from_millinear(20))
            .transact()
            .await?
            .into_result()?;
    }
    for rep in &w.reps {
        owner_call(
            "set_lifecycle_representation_trusted",
            json!({"representation": rep.id(), "trusted": true}),
            yocto(),
        )
        .await?
        .into_result()?;
    }
    Ok(w)
}

async fn deploy_backing(
    worker: &near_workspaces::Worker<near_workspaces::network::Sandbox>,
    owner: &Account,
    registry: &Contract,
    arena: &Contract,
    payout: &Account,
    token_address: &str,
) -> anyhow::Result<Contract> {
    let backing = worker.dev_deploy(&common::wasm("valtrum_backing")).await?;
    backing
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "asset": {"chain_id": CHAIN, "token_address": token_address, "custody_domain": DOMAIN,
                      "source_decimals": 18, "representation_decimals": 18},
            "name": "Representation fixture", "symbol": "TEST",
            "registry": registry.id(), "mapping_version": "1",
            "arena": arena.id(), "payout": payout.id()
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(backing)
}

// ---- observation terms and their SHA-256 commitment (mirrors the arena) ----

fn terms() -> Value {
    json!({
        "source": "fixture-source", "quote_currency": "USD", "eligible_pools": ["pool"],
        "finality": "finalized", "price_decimals": 6, "supply_decimals": 2, "volume_decimals": 8,
        "boundary_tolerance_ns": "0", "max_gap_ns": "30000000000"
    })
}

fn terms_digest() -> String {
    let field = |value: &str| format!("{}:{value};", value.len());
    let text = format!(
        "valtrum/observation-policy/v1;mode=PriceGain;{}{}{}{}{}",
        field("fixture-source"),
        field("USD"),
        field("finalized"),
        field("pool"),
        field("6/2/8/0/30000000000"),
    );
    sha256(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for i in 0..8 {
            h[i] = h[i].wrapping_add(v[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

// ---- helpers ----

impl World {
    fn asset(&self, index: usize) -> Value {
        json!({"chain_id": CHAIN, "token_address": token(index),
               "representation": self.reps[index].id(), "custody_domain": DOMAIN})
    }

    async fn now_ms(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    async fn create(&self, creator: &Account, assets: Vec<Value>) -> anyhow::Result<Option<u64>> {
        let result = creator
            .call(self.arena.id(), "create_lifecycle_battle")
            .args_json(json!({"mode": "PriceGain", "assets": assets}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result();
        Ok(match result {
            Ok(created) => Some(created.json()?),
            Err(_) => None,
        })
    }

    async fn audit(
        &self,
        id: u64,
        community: usize,
        asset: Value,
        result: &str,
    ) -> anyhow::Result<bool> {
        let expires = self.now_ms().await? + 600_000;
        Ok(ok(async {
            Ok(self
                .agent
                .call(self.arena.id(), "submit_lifecycle_audit")
                .args_json(json!({
                    "battle_id": id, "community": community, "asset": asset, "result": result,
                    "policy_hash": "policy-v1", "evidence_hash": format!("fixture-audit-{community}"),
                    "expires_at_ms": (result == "pass").then(|| expires.to_string()),
                }))
                .deposit(NearToken::from_millinear(20))
                .max_gas()
                .transact()
                .await?)
        })
        .await)
    }

    async fn refresh(&self, caller: &Account, id: u64, community: usize) -> anyhow::Result<bool> {
        Ok(ok(async {
            Ok(caller
                .call(self.arena.id(), "refresh_lifecycle_backing")
                .args_json(json!({"battle_id": id, "community": community}))
                .deposit(NearToken::from_millinear(50))
                .max_gas()
                .transact()
                .await?)
        })
        .await)
    }

    async fn view(&self, id: u64) -> anyhow::Result<Value> {
        Ok(self
            .arena
            .view("get_lifecycle_battle")
            .args_json(json!({"battle_id": id}))
            .await?
            .json()?)
    }

    async fn approve_all(&self, id: u64, count: usize) -> anyhow::Result<()> {
        for index in 0..count {
            assert!(self.audit(id, index, self.asset(index), "pass").await?);
            assert!(self.refresh(&self.agent, id, index).await?);
        }
        Ok(())
    }

    async fn register(&self, who: &Account, id: u64, community: usize) -> anyhow::Result<()> {
        who.call(self.arena.id(), "register_lifecycle_position")
            .args_json(json!({"battle_id": id, "community": community}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// A fixture registry claim for `amount` source units, attributed to `who`.
    async fn attest(
        &mut self,
        rep: &Contract,
        token_address: &str,
        who: &Account,
        battle: u64,
        amount: u128,
    ) -> anyhow::Result<u8> {
        let tx = self.next_tx;
        self.next_tx += 1;
        let key = json!({"chain_id": CHAIN, "transaction_hash": vec![tx; 32], "log_index": 1});
        let claim = json!({
            "representation": rep.id(), "token_address": token_address, "custody_domain": DOMAIN,
            "mapping_version": "1", "beneficiary": who.id(), "refund_address": vec![3u8; 20],
            "battle_id": battle.to_string(),
            "actual_received": amount.to_string(), "block_number": "3", "block_hash": vec![2u8; 32],
            "finalized_head_number": "4", "finalized_head_hash": vec![3u8; 32],
            "evidence_hash": vec![4u8; 32]
        });
        self.verifier
            .call(self.registry.id(), "attest")
            .args_json(json!({"key": key, "claim": claim}))
            .deposit(NearToken::from_near(1))
            .transact()
            .await?
            .into_result()?;
        Ok(tx)
    }

    async fn claim_receipt(&self, rep: &Contract, tx: u8) -> anyhow::Result<bool> {
        Ok(self
            .relayer
            .call(rep.id(), "claim_receipt")
            .args_json(json!({"transaction_hash": format!("0x{}", format!("{tx:02x}").repeat(32)), "log_index": 1}))
            .deposit(NearToken::from_millinear(20))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json::<bool>()?)
    }

    /// Foreign deposit (fixture claim) -> attributed custody -> representation units.
    async fn mint(
        &mut self,
        index: usize,
        who: &Account,
        battle: u64,
        amount: u128,
    ) -> anyhow::Result<()> {
        let rep = self.reps[index].clone();
        let tx = self
            .attest(&rep, &token(index), who, battle, amount)
            .await?;
        assert!(self.claim_receipt(&rep, tx).await?);
        who.call(rep.id(), "storage_deposit")
            .args_json(json!({"account_id": who.id(), "registration_only": true}))
            .deposit(NearToken::from_millinear(20))
            .transact()
            .await?
            .into_result()?;
        who.call(rep.id(), "claim_representation")
            .args_json(json!({"beneficiary": who.id(), "amount": amount.to_string()}))
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn balance(&self, rep: &Contract, who: &Account) -> anyhow::Result<u128> {
        let value: String = rep
            .view("ft_balance_of")
            .args_json(json!({"account_id": who.id()}))
            .await?
            .json()?;
        Ok(value.parse()?)
    }

    async fn deposit(
        &self,
        who: &Account,
        index: usize,
        id: u64,
        amount: u128,
    ) -> anyhow::Result<()> {
        who.call(self.reps[index].id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.arena.id(), "amount": amount.to_string(),
                "msg": json!({"action": "lifecycle_deposit", "battle_id": id, "community": index}).to_string()
            }))
            .deposit(yocto())
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn lock_call(&self, id: u64) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .agent
            .call(self.arena.id(), "lock_lifecycle_battle")
            .args_json(json!({"battle_id": id}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?)
    }

    async fn try_lock(&self, id: u64) -> anyhow::Result<bool> {
        Ok(self.lock_call(id).await?.into_result().is_ok())
    }
}

fn vault(view: &Value, community: usize) -> String {
    view["communities"][community]["vault"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn two_communities_run_through_audit_backing_lock_late_arrivals_and_scoring(
) -> anyhow::Result<()> {
    let mut w = world(2).await?;
    let creator = w.creator.clone();
    let player = w.player.clone();
    let id = w
        .create(&creator, vec![w.asset(0), w.asset(1)])
        .await?
        .expect("created");

    // Missing approvals: nothing can lock and a representation transfer is returned.
    w.register(&creator, id, 0).await?;
    w.register(&creator, id, 1).await?;
    w.register(&player, id, 1).await?;
    w.mint(0, &creator, id, 1_000).await?;
    w.deposit(&creator, 0, id, 1_000).await?;
    assert_eq!(w.balance(&w.reps[0], &creator).await?, 1_000, "returned");
    assert_eq!(vault(&w.view(id).await?, 0), "0");
    assert!(!w.try_lock(id).await?);

    // Real approvals: audit through the agent entry point, backing through the
    // representation's own views.
    w.approve_all(id, 2).await?;
    let view = w.view(id).await?;
    for index in 0..2 {
        let backing = view["communities"][index]["backing_evidence_hash"]
            .as_str()
            .unwrap_or_default();
        assert!(backing.starts_with("sha256:"), "{backing}");
        assert!(view["communities"][index]["audit_evidence_hash"].is_string());
    }
    // Only an agent (not the creator) can refresh backing.
    assert!(!w.refresh(&creator, id, 0).await?);

    // Backed deposits are credited to the attributed participant and community.
    w.deposit(&creator, 0, id, 1_000).await?;
    w.mint(1, &player, id, 600).await?;
    w.deposit(&player, 1, id, 600).await?;
    w.mint(1, &creator, id, 50).await?;
    w.deposit(&creator, 1, id, 50).await?;
    // Representation units minted before lock but held back for a late transfer.
    w.mint(1, &player, id, 70).await?;
    let view = w.view(id).await?;
    assert_eq!(
        (vault(&view, 0).as_str(), vault(&view, 1).as_str()),
        ("1000", "650")
    );
    let position = |who: &Account, community: usize| {
        let arena = w.arena.clone();
        let account = who.id().clone();
        async move {
            let value: Value = arena
                .view("get_lifecycle_position")
                .args_json(json!({"battle_id": id, "community": community, "account": account}))
                .await?
                .json()?;
            anyhow::Ok(value["amount"].as_str().unwrap_or_default().to_string())
        }
    };
    assert_eq!(position(&creator, 0).await?, "1000");
    assert_eq!(position(&creator, 1).await?, "50");
    assert_eq!(position(&player, 1).await?, "600");
    assert_eq!(position(&player, 0).await?, "0");

    // Lock, then repeat: the original snapshot stays.
    assert!(w.try_lock(id).await?);
    let frozen = w.view(id).await?;
    assert_eq!(frozen["locked"], true);
    assert!(w.try_lock(id).await?);
    assert_eq!(w.view(id).await?, frozen);

    // Post-lock audit and backing updates cannot touch the snapshot.
    assert!(!w.audit(id, 0, w.asset(0), "reject").await?);
    assert!(!w.audit(id, 1, w.asset(1), "pass").await?);
    assert!(!w.refresh(&w.agent, id, 0).await?);
    assert_eq!(w.view(id).await?, frozen);

    // A representation transfer after lock is returned and credits nothing.
    let before = w.balance(&w.reps[1], &player).await?;
    w.deposit(&player, 1, id, 70).await?;
    assert_eq!(w.balance(&w.reps[1], &player).await?, before);
    assert_eq!(position(&player, 1).await?, "600");

    // A foreign deposit arriving after lock never enters the vault: backing
    // records it as an unattributed-to-battle late deposit that is refund-only.
    let rep = w.reps[1].clone();
    let late_tx = w.attest(&rep, &token(1), &player, id, 90).await?;
    assert!(w.claim_receipt(&rep, late_tx).await?);
    let ledger: Value = rep.view("get_ledger").await?.json()?;
    assert_eq!(ledger["late_refundable"], "90");
    assert_eq!(w.view(id).await?, frozen);
    let late: Value = rep
        .view("get_late_deposit")
        .args_json(json!({"transaction_hash": format!("0x{}", format!("{late_tx:02x}").repeat(32)), "log_index": 1}))
        .await?
        .json()?;
    assert_eq!(late["beneficiary"], json!(player.id()));
    // Recovery: only the payout authority can start the refund of the late deposit.
    let refund = json!({"beneficiary": player.id(), "request_id": vec![9u8; 32], "amount": "90", "destination": vec![3u8; 20]});
    assert!(
        !ok(async {
            Ok(player
                .call(rep.id(), "reserve_late_refund")
                .args_json(refund.clone())
                .deposit(yocto())
                .transact()
                .await?)
        })
        .await
    );
    let reserved = w
        .payout
        .call(rep.id(), "reserve_late_refund")
        .args_json(refund)
        .deposit(yocto())
        .transact()
        .await?
        .into_result()?
        .json::<Value>()?;
    assert_eq!(reserved["source_amount"], "90");
    assert_eq!(w.view(id).await?, frozen);

    // Scoring: the oracle drives a round and the unique winner holds its principal.
    w.creator
        .call(w.arena.id(), "start_lifecycle_rounds")
        .args_json(json!({"battle_id": id.to_string(), "terms": terms()}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let now_ns = w.worker.view_block().await?.timestamp();
    let start = now_ns - 40_000_000_000;
    let oracle = |method: &'static str, args: Value| {
        w.oracle
            .call(w.arena.id(), method)
            .args_json(args)
            .deposit(yocto())
            .max_gas()
            .transact()
    };
    // Recovery: a first window whose evidence never completed is abandoned after
    // the grace, and the same round reopens with a fresh, later window.
    let missed = now_ns - 290_000_000_000;
    oracle(
        "open_lifecycle_round",
        json!({"battle_id": id.to_string(), "round_id": "1", "start_ns": missed.to_string()}),
    )
    .await?
    .into_result()?;
    let outsider = w
        .creator
        .call(w.arena.id(), "reopen_lifecycle_round")
        .args_json(json!({"battle_id": id.to_string(), "round_id": "1"}))
        .deposit(yocto())
        .transact()
        .await?;
    assert!(outsider.is_failure(), "only the oracle may reopen a round");
    let reopened = oracle(
        "reopen_lifecycle_round",
        json!({"battle_id": id.to_string(), "round_id": "1"}),
    )
    .await?
    .into_result()?;
    assert!(reopened
        .logs()
        .iter()
        .any(|l| l.contains("lifecycle_round_reopened_v1")));
    oracle(
        "open_lifecycle_round",
        json!({"battle_id": id.to_string(), "round_id": "1", "start_ns": start.to_string()}),
    )
    .await?
    .into_result()?;
    // The fresh window is inside its grace, so it cannot be abandoned again yet.
    let early = oracle(
        "reopen_lifecycle_round",
        json!({"battle_id": id.to_string(), "round_id": "1"}),
    )
    .await?;
    assert!(
        early.is_failure(),
        "a window inside its grace cannot be reopened"
    );
    let observation = |community: usize, end: u64| {
        json!({
            "community": community,
            "observed_times_ns": [start.to_string(), (start + 30_000_000_000).to_string()],
            "evidence_hash": "fixture-observation",
            "data": {"Price": {"start": "100", "end": end.to_string()}}
        })
    };
    let outcome = oracle(
        "submit_lifecycle_observations",
        json!({"battle_id": id.to_string(), "round_id": "1",
               "observations": [observation(0, 90), observation(1, 130)]}),
    )
    .await?
    .into_result()?
    .json::<Value>()?;
    assert_eq!(outcome, json!({"Winner": {"community": 1}}));
    let count_v1: String = w
        .arena
        .view("get_lifecycle_battle_count_v1")
        .await?
        .json()?;
    assert_eq!(count_v1, id.to_string());
    let detail_v1: Value = w
        .arena
        .view("get_lifecycle_battle_v1")
        .args_json(json!({"battle_id": id.to_string()}))
        .await?
        .json()?;
    assert_eq!(detail_v1, w.view(id).await?);
    let history: Value = w
        .arena
        .view("get_lifecycle_round_history_v1")
        .args_json(json!({"battle_id": id.to_string(), "from_round": "1", "limit": 20}))
        .await?
        .json()?;
    assert_eq!(history["items"][0]["round_id"], "1");
    assert_eq!(history["items"][0]["complete"], false);
    assert_eq!(history["items"][0]["outcome"], outcome);
    assert!(history["items"][0]["scores"].is_null());
    let readiness: Value = w
        .arena
        .view("get_lifecycle_readiness_v1")
        .args_json(json!({"battle_id": id.to_string()}))
        .await?
        .json()?;
    assert_eq!(readiness["activated"], true);
    assert_eq!(readiness["backings"][0]["asset_matches"], true);
    assert!(readiness["block_height"].is_string());
    let done = w.view(id).await?;
    assert_eq!(done["principal_community"], 1);
    assert_eq!(done["principal_amount"], "650");

    // DAO escrow: anyone moves the winning principal into the winning backing's
    // exclusive escrow bucket. No governance decision exists, so it stays there.
    let winner_rep = w.reps[1].clone();
    let ledger_before: Value = winner_rep.view("get_ledger").await?.json()?;
    let arena_before: Value = winner_rep
        .view("ft_balance_of")
        .args_json(json!({"account_id": w.arena.id()}))
        .await?
        .json()?;
    let escrow = |caller: &Account| {
        caller
            .call(w.arena.id(), "reserve_lifecycle_escrow")
            .args_json(json!({"battle_id": id.to_string()}))
            .deposit(NearToken::from_millinear(10))
            .max_gas()
            .transact()
    };
    assert!(escrow(&player).await?.into_result()?.json::<bool>()?);
    let ledger_after: Value = winner_rep.view("get_ledger").await?.json()?;
    let units = |v: &Value, key: &str| v[key].as_str().unwrap_or("x").parse::<u128>();
    assert_eq!(ledger_after["escrow"], "650");
    assert_eq!(
        units(&ledger_before, "minted")? - units(&ledger_after, "minted")?,
        650
    );
    assert_eq!(ledger_after["custody"], ledger_before["custody"]);
    assert_eq!(ledger_after["accounting_balanced"], true);
    let arena_after: Value = winner_rep
        .view("ft_balance_of")
        .args_json(json!({"account_id": w.arena.id()}))
        .await?
        .json()?;
    assert_eq!(
        arena_before.as_str().unwrap_or("x").parse::<u128>()?
            - arena_after.as_str().unwrap_or("x").parse::<u128>()?,
        650
    );
    let view: Value = w
        .arena
        .view("get_lifecycle_escrow")
        .args_json(json!({"battle_id": id.to_string()}))
        .await?
        .json()?;
    assert_eq!(view["reserved"], true);
    assert_eq!(view["amount"], "650");
    assert_eq!(view["representation"], json!(winner_rep.id()));
    let recorded: Value = winner_rep
        .view("get_principal_escrow")
        .args_json(json!({"escrow_id": hex_bytes(view["escrow_id"].as_str().unwrap_or(""))}))
        .await?
        .json()?;
    assert_eq!(
        recorded,
        json!({"battle_id": id.to_string(), "community": 1, "amount": "650"})
    );
    // A repeat changes nothing, and no one but the arena can escrow directly.
    assert!(escrow(&w.creator).await?.into_result()?.json::<bool>()?);
    let repeat: Value = winner_rep.view("get_ledger").await?.json()?;
    assert_eq!(repeat["escrow"], "650");
    assert_eq!(repeat["minted"], ledger_after["minted"]);
    for caller in [&w.owner, &w.agent, &w.oracle, &player] {
        assert!(
            !ok(async {
                Ok(caller
                    .call(winner_rep.id(), "reserve_principal_escrow")
                    .args_json(
                        json!({"escrow_id": vec![1u8; 32], "battle_id": id.to_string(),
                                      "community": 1, "amount": "1"}),
                    )
                    .deposit(NearToken::from_millinear(10))
                    .transact()
                    .await?)
            })
            .await
        );
    }
    assert_eq!(
        winner_rep.view("get_ledger").await?.json::<Value>()?["escrow"],
        "650"
    );

    // DAO vote (D22): the winning community's participants vote with their
    // position as weight. The player (600) votes burn, the creator (50) return.
    let disposition = || async {
        let value: Value = w
            .arena
            .view("get_lifecycle_disposition")
            .args_json(json!({"battle_id": id.to_string()}))
            .await?
            .json()?;
        anyhow::Ok(value)
    };
    assert_eq!(disposition().await?["status"], "voting");
    let vote = |voter: &Account, burn_percent: u8| {
        voter
            .call(w.arena.id(), "vote_lifecycle_disposition")
            .args_json(json!({"battle_id": id.to_string(), "burn_percent": burn_percent}))
            .deposit(NearToken::from_millinear(10))
            .max_gas()
            .transact()
    };
    // A losing-side-only account, the owner and the oracle hold no winning weight.
    for outsider in [&w.owner, &w.oracle, &w.agent] {
        assert!(!ok(async { Ok(vote(outsider, 100).await?) }).await);
    }
    vote(&player, 100).await?.into_result()?;
    vote(&creator, 0).await?.into_result()?;
    assert!(
        !ok(async { Ok(vote(&player, 0).await?) }).await,
        "votes once"
    );
    let execute = |caller: &Account| {
        caller
            .call(w.arena.id(), "execute_lifecycle_disposition")
            .args_json(json!({"battle_id": id.to_string(), "max_releases": 10}))
            .deposit(NearToken::from_millinear(30))
            .max_gas()
            .transact()
    };
    // Nothing executes while the vote is open.
    assert!(!ok(async { Ok(execute(&w.agent).await?) }).await);
    for _ in 0..20 {
        if disposition().await?["status"] == "decided" {
            break;
        }
        w.worker.fast_forward(20).await?;
    }
    let decided = disposition().await?;
    assert_eq!(decided["status"], "decided");
    // B = 600, R = 50: burn floor(p * 600 / 650), rounded towards return.
    assert_eq!(
        (
            decided["burn_total"].clone(),
            decided["return_total"].clone()
        ),
        (json!("599"), json!("51"))
    );
    // The sink is set once by the backing owner; the burn needs it.
    let sink = vec![0xdeu8; 20];
    w.owner
        .call(winner_rep.id(), "set_dao_sink")
        .args_json(json!({"sink": sink}))
        .deposit(yocto())
        .transact()
        .await?
        .into_result()?;
    // Anyone executes; a repeat after completion changes nothing.
    assert_eq!(execute(&w.agent).await?.into_result()?.json::<u32>()?, 3);
    assert_eq!(execute(&w.creator).await?.into_result()?.json::<u32>()?, 3);
    let releases: Value = w
        .arena
        .view("get_lifecycle_disposition_releases")
        .args_json(json!({"battle_id": id.to_string()}))
        .await?
        .json()?;
    let summary: Vec<(String, Value, String, bool)> = releases
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            (
                r["kind"].as_str().unwrap_or("").to_string(),
                r["beneficiary"].clone(),
                r["amount"].as_str().unwrap_or("").to_string(),
                r["recorded"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            // Participants are indexed at their first credited deposit.
            ("return".into(), json!(player.id()), "47".into(), true),
            ("return".into(), json!(creator.id()), "4".into(), true),
            ("burn".into(), Value::Null, "599".into(), true),
        ]
    );
    let entitlement = |who: &Account| {
        let rep = winner_rep.clone();
        let account = who.id().clone();
        async move {
            let value: Value = rep
                .view("entitlement_of")
                .args_json(json!({"account": account}))
                .await?
                .json()?;
            anyhow::Ok(value)
        }
    };
    assert_eq!(entitlement(&player).await?, "47");
    assert_eq!(entitlement(&creator).await?, "4");
    let escrow_view = |rep: Contract| {
        let escrow_id = hex_bytes(view["escrow_id"].as_str().unwrap_or(""));
        async move {
            let value: Value = rep
                .view("get_escrow_disposition")
                .args_json(json!({"escrow_id": escrow_id}))
                .await?
                .json()?;
            anyhow::Ok(value)
        }
    };
    let pending = escrow_view(winner_rep.clone()).await?;
    assert_eq!(
        (
            pending["returned"].clone(),
            pending["burn_pending"].clone(),
            pending["burn_confirmed"].clone(),
            pending["still_escrowed"].clone()
        ),
        (json!("51"), json!("599"), json!("0"), json!("0"))
    );
    let ledger: Value = winner_rep.view("get_ledger").await?.json()?;
    assert_eq!(
        (ledger["escrow"].clone(), ledger["disposal"].clone()),
        (json!("0"), json!("599"))
    );
    assert_eq!(ledger["accounting_balanced"], true);
    // The burn is confirmed only by a finalized debit to the sink, through the
    // payout authority; a debit to any other address is rejected.
    let burn_id = hex_bytes(releases[2]["id"].as_str().unwrap_or(""));
    let debit = |destination: Vec<u8>| {
        json!({"beneficiary": w.arena.id(), "request_id": burn_id.clone(), "evidence": {
            "chain_id": CHAIN, "token_address": token(1), "custody_domain": DOMAIN,
            "destination": destination, "source_amount": "599", "recipient_received": "599",
            "transaction_hash": vec![0x55u8; 32], "log_index": 0, "block_hash": vec![0x66u8; 32]}})
    };
    let confirm = |args: Value| {
        w.payout
            .call(winner_rep.id(), "confirm_payout")
            .args_json(args)
            .max_gas()
            .transact()
    };
    assert!(!ok(async { Ok(confirm(debit(vec![3u8; 20])).await?) }).await);
    assert!(
        !ok(async {
            Ok(player
                .call(winner_rep.id(), "confirm_payout")
                .args_json(debit(sink.clone()))
                .max_gas()
                .transact()
                .await?)
        })
        .await
    );
    assert!(confirm(debit(sink.clone()))
        .await?
        .into_result()?
        .json::<bool>()?);
    let burned = escrow_view(winner_rep.clone()).await?;
    assert_eq!(
        (
            burned["burn_pending"].clone(),
            burned["burn_confirmed"].clone()
        ),
        (json!("0"), json!("599"))
    );
    let ledger: Value = winner_rep.view("get_ledger").await?.json()?;
    assert_eq!(ledger["disposal"], "0");
    assert_eq!(ledger["accounting_balanced"], true);
    Ok(())
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok())
        .collect()
}

#[tokio::test]
async fn three_communities_and_protocol_created_battles_need_two_funded_vaults_and_a_protocol_position(
) -> anyhow::Result<()> {
    let mut w = world(3).await?;
    // The protocol account is the owner-configured protocol identity.
    let protocol = w.creator.clone();
    w.owner
        .call(w.arena.id(), "set_lifecycle_protocol")
        .args_json(json!({"protocol": protocol.id()}))
        .deposit(yocto())
        .transact()
        .await?
        .into_result()?;
    let player = w.player.clone();
    let id = w
        .create(&protocol, vec![w.asset(0), w.asset(1), w.asset(2)])
        .await?
        .expect("created");
    assert_eq!(w.view(id).await?["protocol_created"], true);
    for index in 0..3 {
        w.register(&protocol, id, index).await?;
        w.register(&player, id, index).await?;
    }
    w.approve_all(id, 3).await?;
    // Third parties fund every vault; the protocol itself holds no position yet.
    for index in 0..3 {
        w.mint(index, &player, id, 100).await?;
        w.deposit(&player, index, id, 100).await?;
    }
    assert!(!w.try_lock(id).await?, "no protocol position");
    // The protocol deposits too, so the protocol has a position.
    w.mint(0, &protocol, id, 10).await?;
    w.deposit(&protocol, 0, id, 10).await?;
    assert!(w.try_lock(id).await?);
    let view = w.view(id).await?;
    assert_eq!(view["communities"].as_array().map(Vec::len), Some(3));
    assert_eq!(view["locked"], true);
    assert_eq!(vault(&view, 0), "110");

    // A second battle: one funded community cannot lock, two can, and the empty
    // third community is excluded instead of blocking the lock.
    let second = w
        .create(&protocol, vec![w.asset(0), w.asset(1), w.asset(2)])
        .await?
        .expect("created");
    w.approve_all(second, 3).await?;
    w.register(&protocol, second, 0).await?;
    w.mint(0, &protocol, second, 10).await?;
    w.deposit(&protocol, 0, second, 10).await?;
    assert!(!w.try_lock(second).await?, "only one community is funded");
    w.register(&player, second, 1).await?;
    w.mint(1, &player, second, 100).await?;
    w.deposit(&player, 1, second, 100).await?;
    assert!(
        w.try_lock(second).await?,
        "two funded communities lock; the empty third is excluded"
    );
    let view = w.view(second).await?;
    assert_eq!(view["communities"].as_array().map(Vec::len), Some(3));
    assert_eq!(vault(&view, 0), "10");
    assert_eq!(vault(&view, 1), "100");
    assert_eq!(vault(&view, 2), "0");
    Ok(())
}

#[tokio::test]
async fn mismatched_untrusted_missing_or_suspended_backing_never_approves() -> anyhow::Result<()> {
    let mut w = world(2).await?;
    let creator = w.creator.clone();
    // Community 1 commits token index 1 but names the representation of another asset.
    let mut mismatched = w.asset(1);
    mismatched["representation"] = json!(w.wrong.id());
    let id = w
        .create(&creator, vec![w.asset(0), mismatched.clone()])
        .await?
        .expect("created");
    assert!(w.audit(id, 0, w.asset(0), "pass").await?);
    assert!(w.audit(id, 1, mismatched.clone(), "pass").await?);
    assert!(w.refresh(&w.agent, id, 0).await?);
    // The wrong representation is not on the owner's trust list: refused outright.
    assert!(!w.refresh(&w.agent, id, 1).await?);
    // Trusting it still cannot approve: its asset differs from the committed one.
    w.owner
        .call(w.arena.id(), "set_lifecycle_representation_trusted")
        .args_json(json!({"representation": w.wrong.id(), "trusted": true}))
        .deposit(yocto())
        .transact()
        .await?
        .into_result()?;
    assert!(
        w.refresh(&w.agent, id, 1).await?,
        "the call itself succeeds"
    );
    let view = w.view(id).await?;
    assert!(view["communities"][0]["backing_evidence_hash"].is_string());
    assert!(view["communities"][1]["backing_evidence_hash"].is_null());
    assert!(!w.try_lock(id).await?);

    // Suspension: a deficit attestation withdraws an earlier approval at refresh.
    let second = w
        .create(&creator, vec![w.asset(0), w.asset(1)])
        .await?
        .expect("created");
    w.register(&creator, second, 0).await?;
    w.register(&creator, second, 1).await?;
    w.approve_all(second, 2).await?;
    for index in 0..2 {
        w.mint(index, &creator, second, 100).await?;
        w.deposit(&creator, index, second, 100).await?;
    }
    let attest = |rep: &Contract, block: u64, balance: &str| {
        w.operator
            .call(rep.id(), "attest_custody_balance")
            .args_json(json!({
                "source_block_number": block.to_string(), "source_block_hash": vec![block as u8; 32],
                "finalized_head_number": (block + 1).to_string(), "finalized_head_hash": vec![200u8; 32],
                "balance": balance, "evidence_hash": vec![5u8; 32]
            }))
            .deposit(yocto())
            .max_gas()
            .transact()
    };
    assert!(!attest(&w.reps[1], 10, "99")
        .await?
        .into_result()?
        .json::<bool>()?);
    assert!(w.refresh(&w.agent, second, 1).await?);
    assert!(w.view(second).await?["communities"][1]["backing_evidence_hash"].is_null());
    assert!(!w.try_lock(second).await?, "suspended backing cannot lock");
    // A covering attestation and the owner's resume allow a fresh approval.
    assert!(attest(&w.reps[1], 11, "100")
        .await?
        .into_result()?
        .json::<bool>()?);
    w.owner
        .call(w.reps[1].id(), "resume")
        .deposit(yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert!(w.refresh(&w.agent, second, 1).await?);
    assert!(w.view(second).await?["communities"][1]["backing_evidence_hash"].is_string());
    assert!(w.try_lock(second).await?);
    Ok(())
}
