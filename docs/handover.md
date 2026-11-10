# Handover (2026-11-11)

For the next person working on Valtrum. It lists what is finished, what exists only in code, what is connected end to end, what has never been tried, and one pipeline you must **not touch** while it runs. Read [CLAUDE.md](../CLAUDE.md) (conventions), [current-state.md](current-state.md) (what exists) and [testnet-evidence.md](testnet-evidence.md) (what is proven) first. No secret is written in this file; keys are named only.

Hackathon deadline: development ends **2026-11-14 23:59 UTC**, the repository must be public before then, one submission per project. The organizers' rules say an AI agent never submits, posts, makes the repo public, pushes, signs transactions or spends tokens without the human's explicit confirmation.

## DO NOT TOUCH: the faucet pipeline is waiting

The faucet is not usable yet. It is waiting for the finality of six Robinhood testnet custody deposits, and the same session that started it will run the follow-up steps by itself as soon as they are verified. **Until the faucet page lists tokens (see "How to tell it finished"), do not do any of the following**, because the steps are order dependent and a second actor can double claim, replay a receipt or break the sequence:

- Do not run, restart or kill the verification processes (`custody-verify-cli`, six of them) or the two local RPC relays on ports `18545` (Robinhood testnet) and `18546` (Robinhood mainnet).
- Do not attest receipts, call `claim_receipt` or `claim_representation`, register storage for the operator, register the faucet contract on a backing, transfer stock to `valtrum-faucet.testnet` or call `set_token` / `remove_token` / `set_paused` / `withdraw_*` on it.
- Do not send more custody deposits, and do not cancel, replace or recreate **battle 1**. Every deposit and `claim_receipt` names battle 1, and `claim_receipt` fails closed if it is missing.
- Do not change, rotate or reuse the keys and accounts of the verifier (`valtrum-verifier-b694.testnet`), the faucet operator (`valtrum-operator.testnet`) or the faucet (`valtrum-faucet.testnet`). Their keys are on the owner's machine only (see "Access you need").
- Do not redeploy the arena, backings or registry.

Everything else in this file can be worked on in parallel.

**How to tell it finished.** The faucet contract answers `get_tokens` with six tokens (CASHCAT, WALLET, GOOD, AI, VLAD, DEGEN) each with a `budget_left`, and the `/faucet` page lists all six with a claim button. Check with:
`near contract call-function as-read-only valtrum-faucet.testnet get_tokens json-args '{}' network-config testnet now`
An empty list means it is still waiting.

**What the pipeline does (for reference, do not run by hand):** verify the six deposits as finalized, attest each receipt as the verifier, then as the operator register storage, `claim_receipt`, `claim_representation`, register the faucet on each backing, `ft_transfer` 1,000,000 of each token to the faucet and `set_token` (claim 100, daily budget 100,000). `pnpm -C agent faucet:plan plan --faucet valtrum-faucet.testnet --operator valtrum-operator.testnet --battle 1 --depositor 0xcE806A7Ef30c7e96bC22bbA2665BAFcC78A575c6` prints the full ordered command list; it only prints text. The six deposit transactions and log indexes are in [testnet-evidence.md](testnet-evidence.md) section 8; log index is `0x1` for all but DEGEN, which is `0x12`. If the original session is gone and the faucet is still empty after the deposits are well past finality, ask the owner before restarting anything, because partial progress (an attested or claimed receipt) must be read from the chain first.

## Done and proven on testnet

- Arena, registry, payout, six backings and the current player policy (`policy-v2`) are deployed and wired ([deployment.md](deployment.md)).
- Infrastructure agent `valtrum-agent-b694.testnet` is in the arena whitelist; the faucet contract and its operator account exist.
- Battle 1 exists with six communities (CASHCAT, WALLET, GOOD, AI, VLAD, DEGEN), not locked.
- Six custody deposits were sent on Robinhood testnet (waiting for finality, see above).
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

- **Deposits cannot work yet:** every community needs an audit approval and a backing approval first, and a lock needs fresh approvals for all of them. Battle 1 cannot lock while AI is `pending`. Whether to make a new battle with five tokens is an open decision (it only matters if the arena is to be played; the faucet does not need it).
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
pnpm -C agent build
pnpm -C web dev                      # http://localhost:3000
pnpm -C agent read:serve             # read service on 127.0.0.1:8790, needed for terminal previews
python3 scripts/rpc-relay.py 18546 rpc.mainnet.chain.robinhood.com   # only if your network blocks the Robinhood hosts
python3 scripts/rpc-relay.py 18545                                   # same for Robinhood testnet
```

The relay resolves the real address through Cloudflare DNS over HTTPS, listens on 127.0.0.1 only and holds no key. Point `PRICE_PREVIEW_RPC_URL` (web, server only) and `REFERENCE_RPC_URL` (agent) at a relay or any reachable RPC. A `REFERENCE_RPC_URL` exported in your shell overrides the env files for a dev server, which is why the preview uses its own variable name. The Robinhood hosts also had an expired TLS certificate on 2026-08-19, so a reachable RPC may not be the official host.

## Rules of this repository

- English for commits, code comments and UI text. Commit format `feat|fix|chore|style|docs|test|refactor: short sentence`.
- One feature, one branch, one pull request to `main`; several small commits. The owner has pushed directly to `main` on request; do not do that unless the owner asks.
- Run `scripts/pre-commit.sh` before every push (the GitHub Actions CI is disabled). It runs contracts, node, build and OpenSpec validation for the files you changed; `--all` runs everything.
- NEAR work uses the NEAR skills listed in `CLAUDE.md`; never run code generators on the owner's behalf; a state-changing chain action needs the owner's explicit approval unless the owner has authorized a named scope.
- Open decisions (DAO disposition, tax and admin policy, whether AI joins a battle, payout in the demo, repository license) are the owner's, not yours.

## Suggested next steps for the new person

1. Read this file, then run the local setup above and open the pages.
2. Leave the faucet pipeline alone until `get_tokens` returns six tokens.
3. Meanwhile: add a `LICENSE`, a machine-readable README with the AI-code disclosure, run `near-contract-audit` on `contracts/faucet`, and pick up #149 and #151.
4. After the faucet works: decide with the owner whether to submit audit approvals and run a five-token battle, then try one real deposit and a lock on testnet.
5. Before 2026-11-14: confirm the repository is clean of secrets, then the owner makes it public and submits.
