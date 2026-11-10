#!/usr/bin/env bash
# Local replacement for .github/workflows/ci.yml. Runs the same checks on your machine.
#
#   scripts/pre-commit.sh                 checks for the files you changed (staged files, else vs origin/main)
#   scripts/pre-commit.sh --all           everything CI runs: contracts, sandbox, node, docker
#   scripts/pre-commit.sh --only node     one stage: contracts | sandbox | node | docker | docs
#   scripts/pre-commit.sh --dry-run       print what would run, run nothing
#   scripts/pre-commit.sh --keep-going    do not stop at the first failing stage
#   scripts/pre-commit.sh --install       link this script as .git/hooks/pre-commit (asks before replacing a hook)
#
# Stages (same commands as CI):
#   contracts  cargo fmt --check, cargo clippy --all-targets -D warnings, cargo test (excluding valtrum-integration)
#   sandbox    fetch the pinned SputnikDAO wasm (network), then cargo test -p valtrum-integration   [slow]
#   node       pnpm install --frozen-lockfile, typecheck, agent tests, web tests, build
#   docker     build agent/Dockerfile and smoke-test /healthz offline with a throwaway key          [slow, needs docker]
#   docs       openspec validate --all --strict (docs-only changes are ignored by CI; kept here because the repo requires it)
#
# By default only the stages whose files changed run, and sandbox and docker are left out (use --all).
# A change that touches only *.md files outside docs/ runs nothing, like CI's paths-ignore.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

ALL=0 DRY=0 KEEP=0 INSTALL=0 ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    --keep-going) KEEP=1 ;;
    --install) INSTALL=1 ;;
    --only)
      shift
      ONLY="${1:-}"
      case "$ONLY" in contracts | sandbox | node | docker | docs) ;; *) echo "--only needs one of: contracts sandbox node docker docs" >&2; exit 2 ;; esac
      ;;
    -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'; else BOLD="" RED="" GREEN="" DIM="" RESET=""; fi

if [ "$INSTALL" = 1 ]; then
  hook="$(git rev-parse --git-path hooks/pre-commit)"
  if [ -e "$hook" ] && [ ! -L "$hook" ]; then
    echo "$hook already exists and is not a link. Move it away first, nothing was changed." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$hook")"
  ln -sf "$ROOT/scripts/pre-commit.sh" "$hook"
  echo "installed: $hook -> scripts/pre-commit.sh (skip once with: git commit --no-verify)"
  exit 0
fi

# ---- which stages ---------------------------------------------------------------------------
changed_files() {
  if [ -n "$(git diff --cached --name-only)" ]; then
    git diff --cached --name-only
  elif git rev-parse --verify -q origin/main >/dev/null; then
    { git diff --name-only origin/main...HEAD; git diff --name-only; git ls-files --others --exclude-standard; } | sort -u
  else
    git ls-files
  fi
}

declare -a STAGES=()
if [ -n "$ONLY" ]; then
  STAGES=("$ONLY")
elif [ "$ALL" = 1 ]; then
  STAGES=(contracts sandbox node docker)
else
  FILES="$(changed_files)"
  has() { printf '%s\n' "$FILES" | grep -Eq "$1"; }
  # CI ignores **/*.md and docs/** ; everything else triggers it.
  CODE="$(printf '%s\n' "$FILES" | grep -Ev '(^docs/|\.md$)' || true)"
  if [ -n "$CODE" ]; then
    printf '%s\n' "$CODE" | grep -Eq '^(contracts/|scripts/)' && STAGES+=(contracts)
    printf '%s\n' "$CODE" | grep -Eq '^(agent/|web/|evm/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)' && STAGES+=(node)
  fi
  has '^docs/' && STAGES+=(docs)
fi

if [ "${#STAGES[@]}" -eq 0 ]; then
  echo "${DIM}nothing to check (no code or docs changes that CI or the repo rules would run)${RESET}"
  exit 0
fi

# ---- stage commands -------------------------------------------------------------------------
stage_contracts() {
  cd "$ROOT/contracts"
  run cargo fmt --check
  run cargo clippy --all-targets -- -D warnings
  run cargo test --workspace --exclude valtrum-integration
}
stage_sandbox() {
  cd "$ROOT/contracts"
  run python3 ../scripts/fetch-sputnikdao-wasm.py
  run cargo test -p valtrum-integration
}
stage_node() {
  cd "$ROOT"
  run pnpm install --frozen-lockfile
  run pnpm typecheck
  run pnpm -F @valtrum/agent test
  run pnpm -F @valtrum/web test
  run pnpm build
}
stage_docker() {
  cd "$ROOT"
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    echo "${RED}docker is not available; start Docker Desktop or run: scripts/pre-commit.sh --only node${RESET}" >&2
    return 1
  fi
  run docker build -f agent/Dockerfile -t valtrum-agent:local .
  # Throwaway ed25519 key (base58 of seed+public key), never persisted or logged.
  local key name="valtrum-agent-smoke-$$"
  key="$(node -e '
    const c = require("crypto");
    const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
    const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
    const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const bytes = Buffer.concat([seed, pub]);
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + bytes.toString("hex"));
    let out = "";
    while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
    console.log("ed25519:" + out);
  ')"
  if [ "$DRY" = 1 ]; then echo "${DIM}+ docker run --read-only --network none ... (offline /healthz smoke test)${RESET}"; return 0; fi
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' RETURN
  docker run -d --name "$name" --read-only --network none \
    -e ARENA_CONTRACT_ID=arena.testnet -e AGENT_ACCOUNT_ID=agent.testnet \
    -e AGENT_PRIVATE_KEY="$key" -e HEALTH_PORT=8080 valtrum-agent:local >/dev/null
  for _ in $(seq 1 15); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
      echo "healthz ok"
      return 0
    fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  return 1
}
stage_docs() {
  cd "$ROOT/docs"
  run npx @fission-ai/openspec validate --all --strict --no-interactive
}

# `exit` (not `return`): stages run inside `if`, where `set -e` is ignored, so a failing command must end the stage itself.
run() {
  echo "${DIM}+ $*${RESET}"
  [ "$DRY" = 1 ] && return 0
  "$@" || exit 1
}

# ---- run ------------------------------------------------------------------------------------
FAILED=()
START_ALL=$SECONDS
echo "${BOLD}local CI: ${STAGES[*]}${RESET}$([ "$DRY" = 1 ] && echo ' (dry run)')"
for stage in "${STAGES[@]}"; do
  echo
  echo "${BOLD}== $stage ==${RESET}"
  begin=$SECONDS
  if ( "stage_$stage" ); then
    echo "${GREEN}ok${RESET} $stage ($((SECONDS - begin))s)"
  else
    echo "${RED}FAILED${RESET} $stage ($((SECONDS - begin))s)"
    FAILED+=("$stage")
    [ "$KEEP" = 1 ] || break
  fi
done

echo
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "${RED}${BOLD}failed: ${FAILED[*]}${RESET} ($((SECONDS - START_ALL))s)"
  exit 1
fi
echo "${GREEN}${BOLD}all checks passed${RESET} ($((SECONDS - START_ALL))s)"
