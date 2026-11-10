# Valtrum — Project Guide

A permissionless token-community arena coordinated on NEAR, with original-token custody and rewards on Robinhood Chain (testnets). Two or more communities compete in 30-second rounds; the final winners receive each losing token.

## Stack

| Layer | Tech |
| --- | --- |
| Smart contracts | Rust, near-sdk 5.x, cargo-near, near-workspaces (tests) |
| Cross-chain | NEAR Chain Signatures (MPC) for Robinhood Chain transactions |
| Agent | TypeScript, NEAR AI Cloud (TEE) |
| Frontend | Next.js 16 (App Router), Tailwind, shadcn/ui, pnpm |

## Structure

```
contracts/   Rust workspace: arena/, router/, ref-adapter/, war/, furnace/, mocks, integration tests
docs/        Product spec, rules, architecture and docs/openspec (spec-driven changes)
agent/       Auditor, settlement, watchdog, intent parser
web/         Frontend + AI prompt terminal
```

## Core mechanics (target, see docs/product-spec.md)

- A creator (user or protocol) picks 2+ communities and one scoring mode: Price % Gain, Market Cap % Growth, Volume-to-Market Cap Ratio or Lowest % Drawdown. No bond. The creator must hold a real positive deposit before the snapshot locks.
- Rounds last 30 seconds, point observations, no TWAP. Tied leaders repeat with reset inputs, no overtime cap. Deposits stay closed and all original vaults stay locked until a final winner exists.
- Each losing vault: 99.9% to winning participants proportionally, 0.05% creator, 0.05% protocol (protocol-created battles pay the full 0.1% to protocol). Rewards are the original losing tokens on Robinhood.
- Winning principal goes to DAO escrow (burn or return); DAO mechanics are OPEN. NEP-141 representations are 1:1 backed by actual received assets with exclusive reservations.
- Approval needs a GoPlus check (critical risk rejects, unknown data stays Pending) plus an independent LP check above USD 10,000.
- Infrastructure workers never hold authority over player funds. Player agents act only within user-delegated budgets.
- Current code (docs/current-state.md) is still the earlier two-side arena (bond, TWAP, swap settlement, credit); treat it as the base to change, not as the rules.

## Commands

```bash
# contracts
cd contracts && cargo test
cargo near build non-reproducible-wasm

# agent / web
pnpm install
pnpm -C agent test
pnpm -C web dev
pnpm -C web build

# local CI (same checks as .github/workflows/ci.yml; run before opening a PR)
scripts/pre-commit.sh            # only the stages for your changed files
scripts/pre-commit.sh --all      # contracts, sandbox, node, docker
scripts/pre-commit.sh --install  # git pre-push hook: runs it before every push (skip once: git push --no-verify)
```

## Conventions

- Commits and PR titles: `feat|fix|chore|style: short English sentence` (imperative, lowercase, no trailing period). `docs`, `test`, `refactor` allowed when they fit.
- One feature = one branch (`feat/…`, `fix/…`, `chore/…`, `style/…`, `docs/…`) = one PR to `main`. Each PR has several small logical commits, never one large commit.
- Use `docs/…` for documentation-only branches (specs, OpenSpec artifacts, the findings log); the PR title then starts with `docs:`.
- Never push to `main`. Open a PR from the feature branch, then wait for the owner's review. Merge only after the owner approves, using a merge commit or rebase (not squash). Approval applies to that PR only.
- Before every `git push`, run `scripts/pre-commit.sh` (it is the local CI; the GitHub Actions CI workflow is disabled). Fix failures instead of pushing; never use `git push --no-verify` or `SKIP_LOCAL_CI=1` unless the owner says so. The optional pre-push hook (`scripts/pre-commit.sh --install`) runs it automatically.
- Run tests before opening a PR. Rust: no `unwrap()` in contract code paths, checked math only. TypeScript: strict mode.
- No secrets in the repo; use `.env` files (git-ignored).

## Asking the owner

When something needs the owner's answer or is uncertain, do not guess silently and do not ask in plain text. Use the `AskUserQuestion` multiple-choice tool:

- Use it for design decisions that affect funds, security or token economics, ambiguous product requirements, technology choices (DEX, bridge, price source) and scope changes.
- Offer 2-4 clear, mutually exclusive options, each with its impact or trade-off.
- Put the recommended option first, label it `(Recommended)`, and give the reason in its description.
- Make each question self-contained: name the function, PR or feature it is about.
- Do not ask about things that have a conventional default or can be verified from the code or spec; pick the default and mention it in the summary.
- Batch open questions into one call (at most 4 questions).
- Do not use it to request merge approval (see the PR workflow above).
- Subagents must not decide such matters on their own: they record the ambiguity under "Deviations / assumptions" in the PR, and the main session asks the owner.

## NEAR skills (required)

For any NEAR work, invoke the matching skill via the Skill tool before writing code or commands, instead of relying on memory: `near-smart-contracts` (Rust contracts), `near-contract-audit` (before any contract PR), `near-kit` / `near-api-js` (TypeScript clients), `near-ai-cloud` (TEE agents), `near-dapp` (wallet/UI), `near-intents` (cross-chain swaps), `near-cli-rs` (deploy/CLI).

## Specs and tracking

- OpenSpec lives in `docs/openspec/`; run it from `docs/` (`cd docs && npx @fission-ai/openspec validate --all --strict --no-interactive`). Slash commands are in `.claude/commands/opsx`.
- Product source of truth: `docs/product-spec.md`. Work order and status: `docs/implementation-roadmap.md` and `docs/implementation-tracker.md`. Current code snapshot: `docs/current-state.md`.
- Open decisions (DAO, tax/admin policy) are not decided silently; ask the owner.

<!-- claude-reflect: learned rules (saved from the band; edit freely) -->
## Learned rules
- After finishing each GitHub issue in this repo, open a PR to main, and assign issues to naufalfzml before starting work on them.
- Write commit messages, code comments, and UI text for this project in English.
<!-- end claude-reflect -->
