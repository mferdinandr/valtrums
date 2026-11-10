# Deployment: existing system and target rollout

## Web and image delivery (disabled)

[CD is disabled](ci-cd.md) at owner request; main CI does not deploy web or publish agent images. The workflow is retained only for future setup. Hosting credentials and project variables require one-time configuration. This delivery does not deploy the target contracts or start an agent process.

## Existing implementation: supported operations

These commands operate the **legacy NEAR arena**, whose rules and recorded accounts are in [current-state.md](current-state.md). This documentation PR did not run them or verify a live deployment.

Requirements: Rust stable with wasm32-unknown-unknown, near-cli-rs, Node >=22 and the pnpm version pinned in package.json. From repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm -F @valtrum/agent test
pnpm -F @valtrum/web test
```

Contract checks, from contracts/:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace --exclude valtrum-integration
cargo test -p valtrum-integration
```

Sandbox tests may download a binary. Existing deployment scripts create accounts, deploy and initialize the legacy arena/router/mock contracts; use a fresh suffix. Reinitialization of an already initialized account fails. They do not deploy the target Robinhood system.

```bash
scripts/deploy-testnet.sh <fresh-suffix>
DEX_MODE=mock scripts/demo-battle-testnet.sh <suffix>
```

The default demo uses Ref exchange pools instead. It requires the Ref adapter already deployed, registered and wired, followed by scripts/setup-ref-pools.sh <suffix>. That script creates new pools on every run. Historical exchange: ref-finance-101.testnet, pools 2899/2900 for suffix 8875bb. Query configuration rather than assuming these remain current.

The exchange adapter, exchange and every receiving account must have token storage registration; exchange internal token registration is also required. Ref settlement dispatch uses 300 Tgas. The demo uses a 40-second TWAP window, 10-second passes and a 120-second battle: these are legacy settings, not the target 30-second/no-TWAP rule. Run only one agent per arena key.

Read the historically recorded arena configuration:

```bash
near contract call-function as-read-only valtrum-arena-8875bb.testnet get_config json-args '{}' network-config testnet now
```

Mock tokens are open-mint and have fixture values. Minting registers its recipient:

```bash
near contract call-function as-transaction valtrum-usdc-8875bb.testnet mint \
  json-args '{"account_id":"you.testnet","amount":"100000000"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as you.testnet network-config testnet sign-with-legacy-keychain send
```

Keys from the legacy script use ~/.near-credentials. Contract storage needs funded NEAR; actual cost depends on deployed code/state. Historical arena storage was about 7.3 NEAR, not a target estimate.

Run the web with deterministic demo data using pnpm -F @valtrum/web dev. To connect to the legacy arena:

```bash
NEXT_PUBLIC_NEAR_NETWORK=testnet \
NEXT_PUBLIC_ARENA_CONTRACT_ID=valtrum-arena-8875bb.testnet \
pnpm -F @valtrum/web dev
```

The agent needs ARENA_CONTRACT_ID, AGENT_ACCOUNT_ID and exactly one private-key source. See [agent README](../agent/README.md) and [container instructions](../deploy/README.md). A TS start script does not automatically load the root .env file; export the values or use Compose's env_file. Public RPC throttling can stall work.

## Target contracts on NEAR testnet (deployed 2026-11-09)

An additional **read ABI staging arena** was deployed on 2026-11-10 at the user's
request for #144: `valtrum-read144-261110.testnet`, owner
`valtrum-owner-b694.testnet`. It is a new faucet-funded deployment; the existing
arena below was not upgraded. Lifecycle is **not activated**, protocol/oracle/policy
are unset, and its USDC configuration is a fixture placeholder. Public transaction,
code hash and finalized view results are in
[the deployment record](evidence/2026-11-10-application-read-deploy.json).

Live testnet deployment from the owner's accounts; details, code hashes and transactions in [testnet-evidence.md](testnet-evidence.md) and [evidence/2026-11-09-near-testnet-deploy.json](evidence/2026-11-09-near-testnet-deploy.json).

| Role | Account |
| --- | --- |
| Owner / deploy key | `valtrum-owner-b694.testnet` |
| DAO (protocol account, backing owner) | `valtrum-protocol.sputnikv2.testnet` |
| Arena (lifecycle activated, protocol = DAO) | `arena.valtrum-owner-b694.testnet` |
| Receipt registry | `registry.valtrum-owner-b694.testnet` |
| Payout (signer `v1.signer-prod.testnet`) | `payout.valtrum-owner-b694.testnet` |
| Player policy (current, redeployed 2026-11-09 after #129) | `policy-v2.valtrum-owner-b694.testnet` |
| Player policy (old layout, superseded, unused) | `policy.valtrum-owner-b694.testnet` |
| Backing (fixture asset, DAO-owned) | `backing1.valtrum-owner-b694.testnet` |
| Backings for the six mock tokens (DAO-owned, wired 2026-11-09) | `backing-cashcat`, `backing-wallet`, `backing-good`, `backing-ai`, `backing-vlad`, `backing-degen` `.valtrum-owner-b694.testnet` |
| Registry verifier | `valtrum-verifier-b694.testnet` |

Measured storage: wasm size times 1e19 yoctoNEAR plus a small overhead (arena 664 KB is 7.0 NEAR, backing 389 KB, payout 304 KB, policy 209 KB, registry 160 KB); the DAO create cost the owner 6.1 NEAR. Deployed through a script that signs in process (keys read from the git-ignored `.env`, never passed as arguments); each account was created, keyed with the owner key, deployed and initialised in one transaction. Build: `cd contracts/<crate> && cargo near build non-reproducible-wasm --no-abi --out-dir <dir>`. Still not deployed: Robinhood custody and mock tokens (separate work), real-token backings, payout backing registration, reference-registry entries.

## Planned target rollout: no ready-to-run deploy command

Target only NEAR testnet and Robinhood Chain testnet. No target custody, representation, four-mode arena, DAO or MCP deployment script exists yet.

1. Verify [integration gates](ecosystem.md): chain 46630, signer identity/key, gas, tokens, GoPlus coverage and observation providers.
2. Resolve custody/receipt/finality policy and audit approval policy. Deploy isolated test custody and backed representations with separate infrastructure/player credentials.
3. Prove actual-received minting, duplicate-receipt rejection, redemption and reservation conservation.
4. Deploy new arena lifecycle, 30-second observation scheduling, exact scoring and unlimited overtime.
5. Implement per-token allocation and constrained Robinhood payout; demonstrate lost-response retry without double payment.
6. Add principal escrow. Keep governance OPEN until explicitly decided; fixture decisions must be labeled.
7. Add bounded player delegation, NEAR AI and MCP/terminal previews; verify revocation and infrastructure-role rejection.
8. Record addresses, code hashes, policy versions, signer paths, finality, receipts and failures for a two/three-community demo.

This rollout must not overwrite the historical deployment or claim an unsupported Intents/testnet route. [Security review](security-review.md) and [roadmap](implementation-roadmap.md) list unfinished checks.

## Robinhood testnet (46630): custody and mock tokens deployed 2026-11-09

Recorded in [testnet-evidence.md](testnet-evidence.md) section 3b and [`evidence/2026-11-09-evm-testnet-deploy.json`](evidence/2026-11-09-evm-testnet-deploy.json). These are **fixtures** on a public testnet (no value), deployed with the owner's testnet deployer address `0xcE806A7Ef30c7e96bC22bbA2665BAFcC78A575c6`. Keys stay in the git-ignored `.env` and a local Foundry keystore; nothing secret is committed.

| Contract | Address |
| --- | --- |
| `TestnetDepositCustody` (old, **RETIRED**: deposit-only, keeps tokens, no withdrawal; never verify or attest its events) | `0xb994DCAb6aD9a042e7bBec3Ba104Ec5e6b797798` |
| `TestnetDepositCustody` (forwarder, holds nothing; holder `0x0b740E3E90491f57699fCCD8276400E65BC70c41`, deployed 2026-11-10, [evidence](evidence/2026-11-10-forwarder-deploy.json)) | `0xEb49d8E71A5B2f5B4fA9Da33C3b1838e249F5C6C` |
| `mCASHCAT` (mock) | `0x5b2BA17e5be1B611c1299809Db89c5Fe21D9D0a6` |
| `mWALLET` (mock) | `0x78e7621559bC0E3CC10F8bB61dc2a371afe66e27` |
| `mGOOD` (mock) | `0xAED11A367b102f2da3ac2dFcF1De9cC97A47a850` |
| `mAI` (mock) | `0x973C4E0601c03a4899b8c9643b299aaaecE4ba0A` |
| `mVLAD` (mock) | `0xD879e8483d63265abe2549A347017E59a04a15BC` |
| `mDEGEN` (mock) | `0x209AA417c2aa45a13304Acc51c4c393d0Ac5Ba84` |

Reproduce the build and compare code hashes (Solidity 0.8.28, optimizer on with 200 runs, EVM `cancun`, default metadata hash `ipfs`):

```bash
cd evm && forge test && forge build
cast code <address> --rpc-url https://rpc.testnet.chain.robinhood.com | xargs cast keccak   # compare with deployedBytecode in out/<File>.sol/<Contract>.json
```

`MockToken` stores its owner as an immutable, so its runtime code embeds the deployer address; patch the immutable reference with the owner before comparing (the evidence file records the matching hash). Deploy with a Foundry keystore (`forge create <file>:<Contract> --broadcast --account <name> --password-file <file> --rpc-url ...`), never with the key on the command line. Explorer source verification is blocked (see the evidence file).

Read-only verification of a deposit (signs and sends nothing):

```bash
pnpm -C agent build
node agent/dist/custody-verify-cli.js --rpc https://rpc.testnet.chain.robinhood.com --tx <hash> --log-index <n> \
  --token <addr> --custody <addr> --mapping-version 3 --battle <id> --wait-seconds 2700 --poll-seconds 20
```

Mapping version `3` is a **fixture value** taken from the verifier tests. D17 changed the event layout, so a real deployment must commit a new version that invalidates receipts of the old layout; the owner has not fixed a value.
