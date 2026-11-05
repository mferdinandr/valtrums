#!/usr/bin/env bash
# Creates and seeds testnet exchange pools for the demo coins and routes them in the
# swap adapter. Run after deploy-testnet.sh and after the adapter is deployed.
#
#   scripts/setup-ref-pools.sh <suffix>
#
# Pools are created from a dedicated liquidity account and sized so one demo trade
# moves the price by well under one percent:
#   PEPE: 100,000 USDC / 100,000,000 PEPE   (1 PEPE = 0.001 USDC)
#   SHIB: 100,000 USDC /     400,000 SHIB   (1 SHIB = 0.25 USDC)
# Re-running creates new pools and points the adapter at them.
set -euo pipefail

SUFFIX="${1:?usage: setup-ref-pools.sh <suffix>}"
OWNER="valtrum-${SUFFIX}.testnet"
ADAPTER="valtrum-refdex-${SUFFIX}.testnet"
USDC="valtrum-usdc-${SUFFIX}.testnet"
PEPE="valtrum-pepe-${SUFFIX}.testnet"
SHIB="valtrum-shib-${SUFFIX}.testnet"
LP="lp.${OWNER}"
EXCHANGE="${EXCHANGE_ID:-ref-finance-101.testnet}"
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)

USDC_DEPTH=100000000000                      # 100,000 USDC (6 decimals)
PEPE_DEPTH=100000000000000000000000000       # 100,000,000 PEPE (18 decimals)
SHIB_DEPTH=400000000000000000000000          # 400,000 SHIB (18 decimals)

say() { printf '\n== %s\n' "$*"; }

# call <signer> <contract> <method> <json> [deposit]
call() {
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '200 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$1" "${NET[@]}" "${SIGN[@]}" 2>&1
}

view() { near contract call-function as-read-only "$1" "$2" json-args "$3" "${NET[@]}" now 2>&1 \
  | sed -n '/return value/,/^$/p' | tail -n +2 | tr -d '\n '; }

if ! near account view-account-summary "$LP" "${NET[@]}" now >/dev/null 2>&1; then
  say "Creating the liquidity account"
  near account create-account fund-myself "$LP" '1 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}" "${SIGN[@]}" >/dev/null
fi

say "Registering the liquidity account and the exchange"
call "$LP" "$EXCHANGE" storage_deposit '{}' '0.5 NEAR' >/dev/null
call "$LP" "$EXCHANGE" register_tokens "{\"token_ids\":[\"$USDC\",\"$PEPE\",\"$SHIB\"]}" '1 yoctoNEAR' >/dev/null
for token in "$USDC" "$PEPE" "$SHIB"; do
  call "$LP" "$token" storage_deposit "{\"account_id\":\"$EXCHANGE\"}" '0.01 NEAR' >/dev/null
  call "$LP" "$token" storage_deposit "{\"account_id\":\"$LP\"}" '0.01 NEAR' >/dev/null
done

say "Minting the pool coins"
mint() { call "$LP" "$1" mint "{\"account_id\":\"$LP\",\"amount\":\"$2\"}" >/dev/null; }
mint "$USDC" "$((USDC_DEPTH * 2))"
mint "$PEPE" "$PEPE_DEPTH"
mint "$SHIB" "$SHIB_DEPTH"

deposit() { # <token> <amount>
  call "$LP" "$1" ft_transfer_call \
    "{\"receiver_id\":\"$EXCHANGE\",\"amount\":\"$2\",\"msg\":\"\"}" '1 yoctoNEAR' >/dev/null
}

# make_pool <coin> <coin amount>: prints the new pool id
make_pool() {
  call "$LP" "$EXCHANGE" add_simple_pool "{\"tokens\":[\"$USDC\",\"$1\"],\"fee\":30}" '0.05 NEAR' >/dev/null
  local count
  count="$(view "$EXCHANGE" get_number_of_pools '{}')"
  local pool=$((count - 1))
  deposit "$USDC" "$USDC_DEPTH"
  deposit "$1" "$2"
  call "$LP" "$EXCHANGE" add_liquidity \
    "{\"pool_id\":$pool,\"amounts\":[\"$USDC_DEPTH\",\"$2\"]}" '0.1 NEAR' >/dev/null
  echo "$pool"
}

say "Creating the PEPE pool"
PEPE_POOL="$(make_pool "$PEPE" "$PEPE_DEPTH")"
say "Creating the SHIB pool"
SHIB_POOL="$(make_pool "$SHIB" "$SHIB_DEPTH")"

say "Routing the pairs in the adapter"
call "$OWNER" "$ADAPTER" set_pool "{\"token_a\":\"$USDC\",\"token_b\":\"$PEPE\",\"pool_id\":$PEPE_POOL}" >/dev/null
call "$OWNER" "$ADAPTER" set_pool "{\"token_a\":\"$USDC\",\"token_b\":\"$SHIB\",\"pool_id\":$SHIB_POOL}" >/dev/null

say "Done"
echo "PEPE pool: $PEPE_POOL"
echo "SHIB pool: $SHIB_POOL"
view "$EXCHANGE" get_pool "{\"pool_id\":$PEPE_POOL}"; echo
view "$EXCHANGE" get_pool "{\"pool_id\":$SHIB_POOL}"; echo
