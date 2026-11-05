#!/usr/bin/env bash
# Launches VALT on NEAR testnet and then locks the contract account by deleting
# every access key on it. After this script nobody can redeploy the code or change
# the rules: they are whatever `new` received below.
#
#   scripts/launch-valt-testnet.sh <suffix>
#
# Every rule can be overridden with an environment variable (see the defaults
# below). Amounts are in whole VALT; the script adds the 18 decimals.
#
# Needs: the `near` CLI (near-cli-rs), node, cargo with the wasm32-unknown-unknown
# target, and network access. Keys are stored by the CLI under ~/.near-credentials.
set -euo pipefail

SUFFIX="${1:?usage: launch-valt-testnet.sh <suffix>   (e.g. 8875bb)}"
OWNER="valtrum-${SUFFIX}.testnet"
VALT="valtrum-valt-${SUFFIX}.testnet"

# Rules, fixed forever at launch.
DAY_SECS="${VALT_DAY_SECS:-86400}"
MUSTER_TARGET="${VALT_MUSTER_TARGET:-5}"
MINT_PER_MUSTER="${VALT_MINT_PER_MUSTER:-10}"
BURN_BPS="${VALT_BURN_BPS:-500}"
MIN_BALANCE="${VALT_MIN_BALANCE:-100}"
WAR_CHEST="${VALT_WAR_CHEST:-1000000}"
MAX_SUPPLY="${VALT_MAX_SUPPLY:-21000000}"
# Launch allocations: "account=whole VALT" pairs separated by commas.
ALLOCATIONS="${VALT_ALLOCATIONS:-${OWNER}=100000}"

WASM="$(cd "$(dirname "$0")/.." && pwd)/contracts/target/wasm32-unknown-unknown/release/valtrum_valt.wasm"
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)
KEYFILE="$HOME/.near-credentials/testnet/${VALT}.json"

say() { printf '\n== %s\n' "$*"; }
exists() { near account view-account-summary "$1" "${NET[@]}" now >/dev/null 2>&1; }

say "Building the contract"
(cd "$(dirname "$0")/../contracts" && cargo build --release --target wasm32-unknown-unknown -p valtrum-valt)

if exists "$VALT"; then
  echo "$VALT already exists. A launch is final: use a new suffix." >&2
  exit 1
fi

say "Account"
near account create-account sponsor-by-faucet-service "$VALT" autogenerate-new-keypair \
  save-to-legacy-keychain "${NET[@]}" create >/dev/null
echo "created $VALT"

CONFIG=$(DAY_SECS="$DAY_SECS" MUSTER_TARGET="$MUSTER_TARGET" MINT_PER_MUSTER="$MINT_PER_MUSTER" \
  BURN_BPS="$BURN_BPS" MIN_BALANCE="$MIN_BALANCE" WAR_CHEST="$WAR_CHEST" MAX_SUPPLY="$MAX_SUPPLY" \
  ALLOCATIONS="$ALLOCATIONS" node -e '
const e = process.env;
const coin = (whole) => (BigInt(whole) * 10n ** 18n).toString();
const allocations = e.ALLOCATIONS.split(",").filter(Boolean).map((pair) => {
  const [account_id, amount] = pair.split("=");
  return { account_id, amount: coin(amount) };
});
console.log(JSON.stringify({ config: {
  name: "Valtrum War Drum", symbol: "VALT", decimals: 18, icon: null,
  war_chest: coin(e.WAR_CHEST), allocations,
  day_length_secs: e.DAY_SECS, muster_target: Number(e.MUSTER_TARGET),
  mint_per_muster: coin(e.MINT_PER_MUSTER), burn_bps: Number(e.BURN_BPS),
  min_balance: coin(e.MIN_BALANCE), max_supply: coin(e.MAX_SUPPLY),
}}));')

say "Deploy and initialise (one transaction)"
near contract deploy "$VALT" use-file "$WASM" with-init-call new json-args "$CONFIG" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}" >/dev/null
echo "deployed and initialised $VALT"

say "Lock: delete the contract's only key"
PUBLIC_KEY=$(node -e 'console.log(require(process.argv[1]).public_key)' "$KEYFILE")
near account delete-keys "$VALT" public-keys "$PUBLIC_KEY" "${NET[@]}" "${SIGN[@]}" >/dev/null
echo "deleted $PUBLIC_KEY"

say "Check"
near account list-keys "$VALT" "${NET[@]}" now
near contract call-function as-read-only "$VALT" get_params json-args '{}' "${NET[@]}" now

cat <<EOF

VALT is live at $VALT with no access key: the code and the rules can no longer change.
Holders register with storage_deposit, then call muster once a day.
EOF
