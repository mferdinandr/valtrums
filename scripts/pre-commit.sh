#!/usr/bin/env bash
# Local replacement for .github/workflows/ci.yml. Runs the same checks on your machine.
#
#   scripts/pre-commit.sh                 checks for the files you changed (staged files, else vs origin/main)
#   scripts/pre-commit.sh --all           everything CI runs: contracts, sandbox, node, docker
#   scripts/pre-commit.sh --only node     one stage: contracts | sandbox | node | docker | docs
#   scripts/pre-commit.sh --dry-run       print what would run, run nothing
#   scripts/pre-commit.sh --keep-going    do not stop at the first failing stage
#   scripts/pre-commit.sh --install       install a git pre-push hook that runs this before every push
#   scripts/pre-commit.sh --uninstall     remove that hook (only if this script installed it)
#
# CPU: checks run at low priority (nice 10) with parallelism capped to about a third of your cores, so the
# machine stays usable. Override with LOCAL_CI_JOBS=<n> (for example LOCAL_CI_JOBS=1 for the gentlest run).
#
# Stages (same commands as CI):
#   contracts  cargo fmt --check, cargo clippy --all-targets -D warnings, cargo test (excluding valtrum-integration)
#   sandbox    fetch the pinned SputnikDAO wasm (network), then cargo test -p valtrum-integration   [slow]
#   node       pnpm install --frozen-lockfile, typecheck, agent tests, web tests, build
#   docker     build agent/Dockerfile and smoke-test /healthz offline with a throwaway key          [slow, needs docker]
#   evm        forge fmt --check and forge test for evm/ (not in CI; runs only when forge is installed)
#   docs       openspec validate --all --strict (docs-only changes are ignored by CI; kept here because the repo requires it)
#
# By default only the stages whose files changed run, and sandbox and docker are left out (use --all).
# A change that touches only *.md files outside docs/ runs nothing, like CI's paths-ignore.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

ALL=0 DRY=0 KEEP=0 INSTALL=0 UNINSTALL=0 PUSH_HOOK=0 ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --all) ALL=1 ;;
    --dry-run) DRY=1 ;;
    --keep-going) KEEP=1 ;;
    --install) INSTALL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --hook) shift; [ "${1:-}" = pre-push ] || { echo "--hook only supports pre-push" >&2; exit 2; }; PUSH_HOOK=1; shift; break ;;
    --only)
      shift
      ONLY="${1:-}"
      case "$ONLY" in contracts | sandbox | node | docker | docs | evm) ;; *) echo "--only needs one of: contracts sandbox node docker docs evm" >&2; exit 2 ;; esac
      ;;
    -h | --help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---- CPU limits -----------------------------------------------------------------------------
CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
DEFAULT_JOBS=$(( CORES / 3 )); [ "$DEFAULT_JOBS" -lt 1 ] && DEFAULT_JOBS=1
JOBS="${LOCAL_CI_JOBS:-$DEFAULT_JOBS}"
case "$JOBS" in '' | *[!0-9]* | 0) echo "LOCAL_CI_JOBS must be a positive integer" >&2; exit 2 ;; esac
export CARGO_BUILD_JOBS="$JOBS"      # rustc / cargo build parallelism
export RUST_TEST_THREADS="$JOBS"     # cargo test threads
export UV_THREADPOOL_SIZE="$JOBS"    # node libuv pool
export LOCAL_CI_JOBS="$JOBS"         # read by web/next.config.ts to cap build workers
export RAYON_NUM_THREADS="$JOBS"     # SWC / Rust-based JS tooling thread pools
export GOMAXPROCS="$JOBS"            # esbuild (used by vitest)
# --v8-pool-size caps V8 background threads (GC, compilation): without it each tsc process burns ~200% CPU.
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096 --v8-pool-size=$(( JOBS > 1 ? JOBS : 1 ))"
NICE=(nice -n 10)

if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'; else BOLD="" RED="" GREEN="" DIM="" RESET=""; fi

HOOK_MARK="# installed by scripts/pre-commit.sh"
hook_path() { git rev-parse --git-path hooks/pre-push; }

if [ "$INSTALL" = 1 ]; then
  hook="$(hook_path)"
  if [ -e "$hook" ] && ! grep -q "$HOOK_MARK" "$hook" 2>/dev/null; then
    echo "$hook already exists and was not installed by this script. Move it away first, nothing was changed." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$hook")"
  # A small wrapper, not a link: it runs the script of whichever checkout or worktree is pushing, and
  # skips quietly when that checkout does not have it yet.
  cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
# installed by scripts/pre-commit.sh
[ -n "${SKIP_LOCAL_CI:-}" ] && { echo "SKIP_LOCAL_CI is set: local CI skipped"; exit 0; }
root="$(git rev-parse --show-toplevel)"
if [ ! -x "$root/scripts/pre-commit.sh" ]; then
  echo "pre-push: no scripts/pre-commit.sh in this checkout, local CI skipped"
  exit 0
fi
exec "$root/scripts/pre-commit.sh" --hook pre-push
HOOK
  chmod +x "$hook"
  echo "installed: $hook (runs before every git push; skip once with: git push --no-verify, or SKIP_LOCAL_CI=1)"
  exit 0
fi

if [ "$UNINSTALL" = 1 ]; then
  hook="$(hook_path)"
  if [ -e "$hook" ] && grep -q "$HOOK_MARK" "$hook" 2>/dev/null; then rm "$hook"; echo "removed: $hook"; else echo "no hook installed by this script"; fi
  exit 0
fi

# ---- which stages ---------------------------------------------------------------------------
changed_files() {
  # Before a push the commits being pushed are what matters, not whatever happens to be staged.
  if [ "$PUSH_HOOK" = 0 ] && [ -n "$(git diff --cached --name-only)" ]; then
    git diff --cached --name-only
  elif git rev-parse --verify -q origin/main >/dev/null; then
    if [ "$PUSH_HOOK" = 1 ]; then git diff --name-only origin/main...HEAD
    else { git diff --name-only origin/main...HEAD; git diff --name-only; git ls-files --others --exclude-standard; } | sort -u; fi
  else
    git ls-files
  fi
}

declare -a STAGES=()
if [ -n "$ONLY" ]; then
  STAGES=("$ONLY")
elif [ "$ALL" = 1 ]; then
  STAGES=(contracts sandbox node docker evm)
else
  FILES="$(changed_files)"
  has() { printf '%s\n' "$FILES" | grep -Eq "$1"; }
  # CI ignores **/*.md and docs/** ; everything else triggers it.
  CODE="$(printf '%s\n' "$FILES" | grep -Ev '(^docs/|\.md$)' || true)"
  if [ -n "$CODE" ]; then
    printf '%s\n' "$CODE" | grep -Eq '^(contracts/|scripts/fetch-sputnikdao-wasm\.py)' && STAGES+=(contracts)
    printf '%s\n' "$CODE" | grep -Eq '^(agent/|web/|evm/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)' && STAGES+=(node)
  fi
  has '^evm/' && STAGES+=(evm)
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
  run pnpm --workspace-concurrency=1 typecheck
  run pnpm -F @valtrum/agent test --maxWorkers="$JOBS"
  run pnpm -F @valtrum/web test --maxWorkers="$JOBS"
  run pnpm --workspace-concurrency=1 build
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
stage_evm() {
  cd "$ROOT/evm"
  if ! command -v forge >/dev/null 2>&1; then echo "forge is not installed; skipping the evm stage"; return 0; fi
  run forge fmt --check
  run forge test
}
stage_docs() {
  cd "$ROOT/docs"
  run npx @fission-ai/openspec validate --all --strict --no-interactive
}

# `exit` (not `return`): stages run inside `if`, where `set -e` is ignored, so a failing command must end the stage itself.
run() {
  echo "${DIM}+ $*${RESET}"
  [ "$DRY" = 1 ] && return 0
  "${NICE[@]}" "$@" || exit 1
}

# ---- run ------------------------------------------------------------------------------------
FAILED=()
START_ALL=$SECONDS
echo "${BOLD}local CI: ${STAGES[*]}${RESET}$([ "$DRY" = 1 ] && echo ' (dry run)') ${DIM}[nice 10, $JOBS of $CORES cores]${RESET}"
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
