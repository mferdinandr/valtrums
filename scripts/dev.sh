#!/usr/bin/env bash
# One command for local development: `pnpm dev` at the repository root.
#
# Starts the web app (port 3000), the agent read service (127.0.0.1:8790) and the local RPC relay for the Robinhood
# mainnet host (127.0.0.1:18546, used by the live price preview and the audit). Ctrl+C stops all of them.
#
#   DEV_RELAY=0            do not start the relay (your network reaches the Robinhood RPC directly)
#   DEV_RELAY_TESTNET=1    also start the Robinhood testnet relay on 127.0.0.1:18545 (custody verification)
#
# A relay is skipped when its port is already in use. Needs python3. The relay listens on 127.0.0.1 only and holds no key.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() {
  trap - EXIT INT TERM
  # Everything started here shares this script's process group, so one signal stops the relay, pnpm, web and agent.
  kill 0 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start_relay() {
  local port=$1 host=${2:-}
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev] relay on :$port is already running, leaving it as is"
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[dev] python3 not found, skipping the relay on :$port"
    return
  fi
  python3 scripts/rpc-relay.py "$port" ${host:+"$host"} &
  echo "[dev] relay started on 127.0.0.1:$port ${host:-(Robinhood testnet)}"
}

if [ "${DEV_RELAY:-1}" != "0" ]; then
  start_relay 18546 rpc.mainnet.chain.robinhood.com
fi
if [ "${DEV_RELAY_TESTNET:-0}" = "1" ]; then
  start_relay 18545
fi

pnpm -r --parallel --if-present dev
