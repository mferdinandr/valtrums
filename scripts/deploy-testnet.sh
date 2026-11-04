#!/usr/bin/env bash
# Deploys the full Valtrum stack to NEAR testnet with mock tokens, a mock DEX and
# on-chain settlement execution. Re-running is safe: existing accounts are reused,
# but contracts are redeployed and re-initialised, which only works on fresh accounts.
#
#   scripts/deploy-testnet.sh <suffix>
#
# Needs: the `near` CLI (near-cli-rs), cargo with the wasm32-unknown-unknown target,
# and network access. Keys are stored by the CLI (legacy keychain files under
# ~/.near-credentials). Testnet only: the mock tokens can be minted by anyone.
set -euo pipefail

SUFFIX="${1:?usage: deploy-testnet.sh <suffix>   (e.g. 8875bb)}"
OWNER="valtrum-${SUFFIX}.testnet"
ARENA="valtrum-arena-${SUFFIX}.testnet"
ROUTER="valtrum-router-${SUFFIX}.testnet"
DEX="valtrum-dex-${SUFFIX}.testnet"
USDC="valtrum-usdc-${SUFFIX}.testnet"
PEPE="valtrum-pepe-${SUFFIX}.testnet"
SHIB="valtrum-shib-${SUFFIX}.testnet"
AGENT="agent.${OWNER}"
TREASURY="treasury.${OWNER}"
BURN="burn.${OWNER}"

BOND=5000000                 # 5 USDC
WINDOW_SECS=300              # deposit window after approval
GAS='100 Tgas'
WASM_DIR="$(cd "$(dirname "$0")/.." && pwd)/contracts/target/wasm32-unknown-unknown/release"
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)

say() { printf '\n== %s\n' "$*"; }

exists() { near account view-account-summary "$1" "${NET[@]}" now >/dev/null 2>&1; }

faucet_account() {
  if exists "$1"; then echo "reusing $1"; return; fi
  near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair \
    save-to-legacy-keychain "${NET[@]}" create >/dev/null
  echo "created $1"
}

sub_account() {
  if exists "$1"; then echo "reusing $1"; return; fi
  near account create-account fund-myself "$1" '1 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}" "${SIGN[@]}" >/dev/null
  echo "created $1"
}

# deploy <account> <wasm name> <init json>
deploy() {
  near contract deploy "$1" use-file "$WASM_DIR/$2.wasm" with-init-call new json-args "$3" \
    prepaid-gas "$GAS" attached-deposit '0 NEAR' "${NET[@]}" "${SIGN[@]}" >/dev/null
  echo "deployed $2 to $1"
}

# call <signer> <contract> <method> <json> [deposit]
call() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '300 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$1" "${NET[@]}" "${SIGN[@]}" >/dev/null
}

view() { near contract call-function as-read-only "$1" "$2" json-args "$3" "${NET[@]}" now; }

say "Building contracts"
(cd "$(dirname "$0")/../contracts" && cargo build --release --target wasm32-unknown-unknown \
  -p valtrum-arena -p valtrum-router -p valtrum-mock-dex -p valtrum-mock-ft)

say "Accounts"
for account in "$OWNER" "$ARENA" "$ROUTER" "$DEX" "$USDC" "$PEPE" "$SHIB"; do faucet_account "$account"; done
for account in "$AGENT" "$TREASURY" "$BURN"; do sub_account "$account"; done

say "Contracts"
deploy "$USDC" valtrum_mock_ft '{"name":"Mock USDC","symbol":"USDC","decimals":6}'
deploy "$PEPE" valtrum_mock_ft '{"name":"Mock PEPE","symbol":"PEPE","decimals":18}'
deploy "$SHIB" valtrum_mock_ft '{"name":"Mock SHIB","symbol":"SHIB","decimals":18}'
deploy "$DEX" valtrum_mock_dex "{\"owner\":\"$OWNER\"}"
deploy "$ARENA" valtrum_arena \
  "{\"owner\":\"$OWNER\",\"usdc\":\"$USDC\",\"treasury\":\"$TREASURY\",\"bond\":\"$BOND\",\"deposit_window_secs\":\"$WINDOW_SECS\"}"
deploy "$ROUTER" valtrum_router \
  "{\"owner\":\"$OWNER\",\"arena\":\"$ARENA\",\"dex\":\"$DEX\",\"usdc\":\"$USDC\"}"

say "Token registrations"
for token in "$USDC" "$PEPE" "$SHIB"; do
  for holder in "$ARENA" "$ROUTER" "$DEX" "$TREASURY" "$BURN" "$OWNER" "$AGENT"; do
    call "$OWNER" "$token" storage_deposit "{\"account_id\":\"$holder\",\"registration_only\":true}" '0.02 NEAR'
  done
done
echo "registered"

say "Wiring"
call "$OWNER" "$ARENA" add_agent "{\"account_id\":\"$AGENT\"}"
call "$OWNER" "$ARENA" set_router "{\"router\":\"$ROUTER\"}"
call "$OWNER" "$ARENA" set_execution "{\"dex\":\"$DEX\",\"burn_account\":\"$BURN\"}"

say "DEX rates and liquidity"
# 1 USDC = 1000 PEPE = 4 SHIB (token units: 6 / 18 / 18 decimals)
rate() { call "$OWNER" "$DEX" set_rate "{\"token_in\":\"$1\",\"token_out\":\"$2\",\"num\":\"$3\",\"den\":\"$4\"}"; }
rate "$USDC" "$PEPE" 1000000000000000 1
rate "$PEPE" "$USDC" 1 1000000000000000
rate "$USDC" "$SHIB" 4000000000000 1
rate "$SHIB" "$USDC" 1 4000000000000
fund_dex() { # <token> <amount>
  call "$OWNER" "$1" mint "{\"account_id\":\"$OWNER\",\"amount\":\"$2\"}"
  call "$OWNER" "$1" ft_transfer_call \
    "{\"receiver_id\":\"$DEX\",\"amount\":\"$2\",\"msg\":\"{\\\"action\\\":\\\"add_liquidity\\\"}\"}" '1 yoctoNEAR'
}
fund_dex "$USDC" 100000000000            # 100,000 USDC
fund_dex "$PEPE" 100000000000000000000000000   # 100,000,000 PEPE
fund_dex "$SHIB" 1000000000000000000000000     # 1,000,000 SHIB
echo "funded"

say "Result"
view "$ARENA" get_config '{}'
cat <<SUMMARY

owner:    $OWNER
arena:    $ARENA
router:   $ROUTER
dex:      $DEX
usdc:     $USDC
pepe:     $PEPE
shib:     $SHIB
agent:    $AGENT
treasury: $TREASURY
burn:     $BURN
SUMMARY
