#!/usr/bin/env bash
# Plays one complete battle on the testnet deployment made by deploy-testnet.sh:
# proposal, audit, deposits, lock, a price move, settlement, claim and withdrawal.
# The agent runs locally for the duration (on-chain execution, market data from the mock DEX).
#
#   scripts/demo-battle-testnet.sh <suffix>
#
# Needs the `near` CLI, node and pnpm, and the credentials the deploy script stored.
# The agent uses NEAR_RPC_URL (default: a FastNEAR testnet endpoint); the public
# rpc.testnet.near.org rate-limits and can stall a run.
set -euo pipefail

SUFFIX="${1:?usage: demo-battle-testnet.sh <suffix>}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OWNER="valtrum-${SUFFIX}.testnet"
ARENA="valtrum-arena-${SUFFIX}.testnet"
DEX="valtrum-dex-${SUFFIX}.testnet"
USDC="valtrum-usdc-${SUFFIX}.testnet"
PEPE="valtrum-pepe-${SUFFIX}.testnet"
SHIB="valtrum-shib-${SUFFIX}.testnet"
AGENT="agent.${OWNER}"
ALICE="alice.${OWNER}"   # proposes the battle
BOB="bob.${OWNER}"       # side A (PEPE)
CAROL="carol.${OWNER}"   # side B (SHIB)
NET=(network-config testnet)
SIGN=(sign-with-legacy-keychain send)
WORK="$(mktemp -d)"
AGENT_PID=""

cleanup() { [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
exists() { near account view-account-summary "$1" "${NET[@]}" now >/dev/null 2>&1; }

call() { # <signer> <contract> <method> <json> [deposit]
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '300 Tgas' \
    attached-deposit "${5:-0 NEAR}" sign-as "$1" "${NET[@]}" "${SIGN[@]}" >/dev/null
}

view() { # <contract> <method> <json>  -> prints the JSON return value only
  near contract call-function as-read-only "$1" "$2" json-args "$3" "${NET[@]}" now 2>/dev/null |
    python3 -c '
import sys, re
text = sys.stdin.read()
start = text.find("Function execution return value (printed to stdout):")
body = text[start:].split("\n", 1)[1] if start >= 0 else text
end = body.find("Here is your console command")
print(body[: end if end >= 0 else len(body)].strip())'
}

field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

wait_status() { # <battle id> <status> <timeout secs>
  local deadline=$((SECONDS + $3)) current=""
  while [ $SECONDS -lt $deadline ]; do
    current="$(view "$ARENA" get_battle "{\"battle_id\":$1}" | field "['status']")"
    [ "$current" = "$2" ] && { echo "battle $1 is $2"; return 0; }
    sleep 5
  done
  echo "timed out waiting for $2 (last status: $current)" >&2; return 1
}

transfer_call() { # <signer> <token> <receiver> <amount> <msg json>
  local args
  args="$(python3 -c '
import json, sys
print(json.dumps({"receiver_id": sys.argv[1], "amount": sys.argv[2], "msg": sys.argv[3]}))' "$3" "$4" "$5")"
  call "$1" "$2" ft_transfer_call "$args" '1 yoctoNEAR'
}

user() { # <account>
  exists "$1" && { echo "reusing $1"; return; }
  near account create-account fund-myself "$1" '1 NEAR' autogenerate-new-keypair \
    save-to-legacy-keychain sign-as "$OWNER" "${NET[@]}" "${SIGN[@]}" >/dev/null
  echo "created $1"
}

say "Agent"
CRED="$HOME/.near-credentials/testnet/${AGENT}.json"
[ -f "$CRED" ] || { echo "missing $CRED" >&2; exit 1; }
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"], end="")' "$CRED" > "$WORK/agent.key"
chmod 600 "$WORK/agent.key"
(cd "$ROOT_DIR" && pnpm install --frozen-lockfile >/dev/null && pnpm -F @valtrum/agent build >/dev/null)
(cd "$ROOT_DIR" &&
  ARENA_CONTRACT_ID="$ARENA" AGENT_ACCOUNT_ID="$AGENT" AGENT_PRIVATE_KEY_FILE="$WORK/agent.key" \
  NEAR_RPC_URL="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}" NEAR_NETWORK=testnet \
  EXECUTION_MODE=onchain MARKET_DATA=mockdex TWAP_WINDOW_SECS=40 AGENT_INTERVAL_SECS=10 \
  HEALTH_PORT=0 BASELINE_STORE_PATH="$WORK/baselines.json" \
  pnpm -F @valtrum/agent start > "$WORK/agent.log" 2>&1) &
AGENT_PID=$!
sleep 5; echo "agent started (pid $AGENT_PID), log: $WORK/agent.log"

say "Timing: 60 s deposit window"
call "$OWNER" "$ARENA" set_deposit_window_secs '{"secs":"60"}'

say "Players"
for account in "$ALICE" "$BOB" "$CAROL"; do user "$account"; done
mint() { call "$OWNER" "$1" mint "{\"account_id\":\"$2\",\"amount\":\"$3\"}"; }
mint "$USDC" "$ALICE" 5000000                       # the 5 USDC bond
mint "$PEPE" "$BOB" 400000000000000000000           # 400 PEPE
mint "$SHIB" "$CAROL" 160000000000000000000         # 160 SHIB

say "Reset the PEPE price to the deployment rate (1 PEPE = 0.001 USDC)"
call "$OWNER" "$DEX" set_rate "{\"token_in\":\"$PEPE\",\"token_out\":\"$USDC\",\"num\":\"1\",\"den\":\"1000000000000000\"}"

say "Proposal"
BEFORE="$(view "$ARENA" get_battle_count '{}')"
ID=$((BEFORE + 1))
transfer_call "$ALICE" "$USDC" "$ARENA" 5000000 \
  "{\"action\":\"propose\",\"token_a\":\"$PEPE\",\"token_b\":\"$SHIB\",\"duration_secs\":120}"
wait_status "$ID" Proposed 60
echo "waiting for the agent to audit and approve it"
wait_status "$ID" Approved 180

say "Deposits (window closes about 60 s after approval)"
transfer_call "$BOB" "$PEPE" "$ARENA" 400000000000000000000 \
  "{\"action\":\"deposit\",\"battle_id\":$ID,\"side\":\"A\"}"
transfer_call "$CAROL" "$SHIB" "$ARENA" 160000000000000000000 \
  "{\"action\":\"deposit\",\"battle_id\":$ID,\"side\":\"B\"}"
view "$ARENA" get_battle "{\"battle_id\":$ID}" | python3 -c '
import json,sys; b=json.load(sys.stdin); print("vault A:", b["vault_a"], " vault B:", b["vault_b"])'

say "Waiting for the agent to lock the battle with TWAP prices"
wait_status "$ID" Live 240

say "Move the price: PEPE +25% (1 PEPE = 0.00125 USDC)"
call "$OWNER" "$DEX" set_rate "{\"token_in\":\"$PEPE\",\"token_out\":\"$USDC\",\"num\":\"5\",\"den\":\"4000000000000000\"}"

say "Waiting for the battle to end and the agent to settle it"
wait_status "$ID" Settled 420
view "$ARENA" get_battle "{\"battle_id\":$ID}" | python3 -c '
import json,sys; b=json.load(sys.stdin)
print("winner:", b["winner"], " initial:", b["initial_price_a"], b["initial_price_b"], " final:", b["final_price_a"], b["final_price_b"])'
view "$ARENA" get_settlement_plan "{\"battle_id\":$ID}"

say "Claim and withdraw"
call "$BOB" "$ARENA" claim "{\"battle_id\":$ID}"
LIQ="$(view "$ARENA" get_liquid_balance "{\"account_id\":\"$BOB\",\"token_id\":\"$PEPE\"}" | tr -d '"')"
echo "bob's liquid PEPE after the claim: $LIQ (he deposited 400000000000000000000)"
call "$BOB" "$ARENA" withdraw_liquid "{\"token\":\"$PEPE\",\"amount\":\"$LIQ\"}" '1 yoctoNEAR'
echo "bob's PEPE wallet balance: $(view "$PEPE" ft_balance_of "{\"account_id\":\"$BOB\"}")"
echo "bob's credit: $(view "$ARENA" get_account "{\"account_id\":\"$BOB\"}")"
call "$ALICE" "$ARENA" withdraw_liquid "{\"token\":\"$USDC\",\"amount\":\"5000000\"}" '1 yoctoNEAR'
echo "alice (creator) got her bond back: $(view "$USDC" ft_balance_of "{\"account_id\":\"$ALICE\"}")"

say "Where the value went"
echo "burned PEPE:     $(view "$PEPE" ft_balance_of "{\"account_id\":\"burn.${OWNER}\"}")"
echo "arena PEPE left: $(view "$PEPE" ft_balance_of "{\"account_id\":\"$ARENA\"}")"
echo "arena USDC left: $(view "$USDC" ft_balance_of "{\"account_id\":\"$ARENA\"}")"
echo "treasury accrued: $(view "$ARENA" get_config '{}' | field "['treasury_accrued']")"
say "Agent log (last lines)"
tail -n 12 "$WORK/agent.log" | cut -c1-200
