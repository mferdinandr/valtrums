# Handover (2026-11-11)

> **Note (2026-11-14):** The Robinhood Chain testnet custody, the EVM contracts and payouts to Robinhood are retired. Valtrums now runs on NEAR only; Robinhood Chain mainnet is only read for prices and token audits. Anything below about custody, payouts or Chain Signatures is historical. See [current state](current-state.md).

For the next person working on Valtrum. It lists what is finished, what exists only in code, what is connected end to end, what has never been tried, and one pipeline you must **not touch** while it runs. Read [CLAUDE.md](../CLAUDE.md) (conventions), [current-state.md](current-state.md) (what exists) and [testnet-evidence.md](testnet-evidence.md) (what is proven) first. No secret is written in this file; keys are named only.

Hackathon deadline: development ends **2026-11-14 23:59 UTC**, the repository must be public before then, one submission per project. The organizers' rules say an AI agent never submits, posts, makes the repo public, pushes, signs transactions or spends tokens without the human's explicit confirmation.

## Faucet status: stocked (2026-11-11), nothing is running anymore

The faucet pipeline finished. Six new custody deposits were verified, attested, claimed and minted, and `valtrum-faucet.testnet` holds 1,000,000 of each of the six tokens (100 per claim, 100,000 per day, 24 hour cooldown). `/faucet` shows all six as ready. Details and every transaction are in [testnet-evidence.md](testnet-evidence.md) section 9. No background job or relay needs to keep running for the faucet itself.

Still do not casually change: the faucet owner is `valtrum-operator.testnet` (only it can `set_token`, pause or withdraw), battle 1 must stay (every receipt names it), and the six backings, registry and verifier stay as they are. The first set of six deposits (section 8) was never verified and stays in custody unclaimed; ignore it.

**Lessons for the next run of this path (also in the funding plan):** the Robinhood testnet finalized head moves in steps of thousands of blocks and the verifier only walks `--max-depth` blocks (default 256) below it, so verify promptly with `--poll-seconds 10 --max-depth 12000`; `registry.attest` needs about 0.02 NEAR attached for storage (1 yoctoNEAR panics); the public RPC answers 429 to a batch of 100, and `scripts/rpc-relay.py` caches finalized blocks and prefetches 40 per batch.

## Done and proven on testnet

- Arena, registry, payout, six backings and the current player policy (`policy-v2`) are deployed and wired ([deployment.md](deployment.md)).
- Infrastructure agent `valtrum-agent-b694.testnet` is in the arena whitelist; the faucet contract and its operator account exist.
- Battle 1 exists with six communities (CASHCAT, WALLET, GOOD, AI, VLAD, DEGEN), not locked.
- Six custody deposits were verified, attested, claimed and minted; the faucet is stocked and `/faucet` lists all six tokens (section 9 of the evidence). No user claim was made yet.
- A read-only audit dry run ran through the production audit code: five communities `pass`, AI `pending`.
- The web pages render against live testnet reads and were checked in a browser: `/`, `/arena`, `/arena/<id>`, `/portfolio`, `/terminal`, `/agents`, `/faucet`.

## Done in code, never executed on chain

- Audit approval submission, backing refresh and lock (agent-only methods; nothing was submitted, so no community has an approval).
- Scoring in four modes, 30-second rounds, tie handling, settlement, escrow and DAO entry points, Chain Signatures code, payout relayer and operator (tests use synthetic inputs).
- Lifecycle oracle (dry run by default) and the observation journal; no live price source is enabled and the deployed arena has no confirmed oracle account.
- Player agent program and strategies (dry run by default); no live proposal was ever sent.
- Faucet funding plan generator (prints text only).

## Connected end to end (checked)

- Web faucet page reads the faucet contract over RPC; terminal parses prompts locally (rules) and the page loads; the Agents page reads and writes the player policy contract (its pointer was corrected to `policy-v2`, creating a real grant is untested).
- Live price preview: `/api/reference-price` reads Uniswap v3 pools on Robinhood mainnet and the battle page draws the chart; it is display only and the lines stay flat when a pool has no trades.
- Audit pass reads GoPlus, DexScreener-derived pool data and mainnet pools, and reads the arena registry on testnet.

## Not connected, or never tried

- **Deposits cannot work yet:** every community needs an audit approval and a backing approval first, and a lock needs fresh approvals for all of them. Battle 1 cannot lock while AI is `pending`. Now that the backings exist, audit approvals and refreshes are the next gate. Whether to make a new battle with five tokens is an open decision (it only matters if the arena is to be played; the faucet does not need it).
- **Payout:** the terminal blocks it until spendable custody (#148) is proven; no winner was ever paid, and no round has run.
- **Per-second chart of a locked battle** needs oracle plus collector plus a qualified source; nothing is set up. The deployed arena also lacks the `_v1` read views (display only).
- **Terminal with a model** needs a NEAR AI Cloud key (paid credits) that the owner supplies in `web/.env.local`; without it the rule parser is used.
- **Player agents live**, **NEAR Intents** (only a labeled fixture exists), **Bitte orchestration**, **DAO disposition of winning principal** (open decision), and the **end-to-end demo with failure recovery** (#80). Issues #149 and #151 are open.
- No audit of the faucet contract with the `near-contract-audit` skill has been done; the project rules require it before a contract PR.

## Access you need (not in the repository)

- `.env` at the repository root (git-ignored) holds testnet keys for the owner, council, agent, operator (`-b694`), relayer, users, verifier, intents-user, bitte and the EVM deployer. Ask the owner for it through a private channel; never commit it. Before the repository is made public, check that git history never contained a key.
- The keys of `valtrum-operator.testnet` and `valtrum-faucet.testnet`, and the imported owner key, are in the **owner's macOS keychain** only. They are not in `.env`.
- `agent/.env.local` and `web/.env.local` (git-ignored) hold the local configuration; `.env.example` lists every variable. Both policy pointers must be `policy-v2.valtrum-owner-b694.testnet`.

## Running it locally

```bash
pnpm install
pnpm dev     # web on :3000, agent read service on 127.0.0.1:8790 and the mainnet RPC relay on 127.0.0.1:18546; Ctrl+C stops all
```

`pnpm dev` runs `scripts/dev.sh`. `DEV_RELAY=0 pnpm dev` skips the relay when your network reaches the Robinhood RPC directly, `DEV_RELAY_TESTNET=1 pnpm dev` also starts the testnet relay on `127.0.0.1:18545` (custody verification). A relay whose port is already in use is left alone. `pnpm dev:apps` starts only web and agent.

The relay resolves the real address through Cloudflare DNS over HTTPS, listens on 127.0.0.1 only and holds no key. Point `PRICE_PREVIEW_RPC_URL` (web, server only) and `REFERENCE_RPC_URL` (agent) at a relay or any reachable RPC. A `REFERENCE_RPC_URL` exported in your shell overrides the env files for a dev server, which is why the preview uses its own variable name. The Robinhood hosts also had an expired TLS certificate on 2026-08-19, so a reachable RPC may not be the official host.

## Rules of this repository

- English for commits, code comments and UI text. Commit format `feat|fix|chore|style|docs|test|refactor: short sentence`.
- One feature, one branch, one pull request to `main`; several small commits. The owner has pushed directly to `main` on request; do not do that unless the owner asks.
- Run `scripts/pre-commit.sh` before every push (the GitHub Actions CI is disabled). It runs contracts, node, build and OpenSpec validation for the files you changed; `--all` runs everything.
- NEAR work uses the NEAR skills listed in `CLAUDE.md`; never run code generators on the owner's behalf; a state-changing chain action needs the owner's explicit approval unless the owner has authorized a named scope.
- Open decisions (DAO disposition, tax and admin policy, whether AI joins a battle, payout in the demo, repository license) are the owner's, not yours.

## Suggested next steps for the new person

1. Read this file, then run the local setup above and open the pages.
2. Try a real claim from the faucet page with a wallet that has testnet NEAR (never tried), then check the balance of the claimed token.
3. Meanwhile: add a `LICENSE`, a machine-readable README with the AI-code disclosure, run `near-contract-audit` on `contracts/faucet`, and pick up #149 and #151.
4. After the faucet works: decide with the owner whether to submit audit approvals and run a five-token battle, then try one real deposit and a lock on testnet.
5. Before 2026-11-14: confirm the repository is clean of secrets, then the owner makes it public and submits.
