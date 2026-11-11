#!/usr/bin/env node
// Payout live proof on NEAR testnet + Robinhood testnet (issue #148, docs/openspec/changes/arena-testnet-integrations/
// live-custody-proof-plan.md). One step per invocation. Writes are a DRY RUN unless --send is given.
//
//   node scripts/testnet-wiring/payout-proof.mjs request-payout <SYMBOL> <amountWholeTokens> [--send]   (USER1)
//   node scripts/testnet-wiring/payout-proof.mjs status [<requestIdHex>]                                (views only)
//   node scripts/testnet-wiring/payout-proof.mjs role <relayer|operator> [--submit]                     (long-running)
//
// Keys come from the repository's git-ignored .env (TESTNET_<ROLE>_ACCOUNT_ID / _PRIVATE_KEY). They are mapped to
// the PAYOUT_<ROLE>_* variables in memory for the child process only; they are never printed, logged, written
// to a file or passed on a command line.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = path.join(ROOT, ".live-state", "payout-request.json");
const { Near } = await import(pathToFileURL(path.join(ROOT, "agent/node_modules/near-kit/dist/index.js")).href);

const NETWORK = "testnet";
const PAYOUT = "payout.valtrum-owner-b694.testnet";
const EVM_RPC = "https://rpc.testnet.chain.robinhood.com";
const EVM_CHAIN_ID = "46630";
/** `request_payout` storage deposit (30 mNEAR); the unused part is refunded. */
const REQUEST_DEPOSIT = "30000000000000000000000 yocto";
const send = process.argv.includes("--send");
const argv = process.argv.slice(2).filter((a) => a !== "--send" && a !== "--submit");

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const representationOf = (symbol) => `backing-${symbol.toLowerCase()}.valtrum-owner-b694.testnet`;
const bytes = (hex) => (hex.match(/../g) ?? []).map((b) => parseInt(b, 16));
const reader = () => new Near({ network: NETWORK });
const show = (o) => console.log(JSON.stringify(o, null, 2));

const commands = {
  async "request-payout"([symbol, whole]) {
    if (!symbol || !whole) throw new Error("usage: request-payout <SYMBOL> <amountWholeTokens>");
    const env = readEnv();
    const accountId = env.TESTNET_USER1_ACCOUNT_ID;
    const privateKey = env.TESTNET_USER1_PRIVATE_KEY;
    const destination = (env.TESTNET_EVM_DEPLOYER_ADDRESS ?? "").toLowerCase();
    if (!accountId || !privateKey) throw new Error("missing TESTNET_USER1_ACCOUNT_ID / _PRIVATE_KEY in .env");
    if (!/^0x[0-9a-f]{40}$/.test(destination)) throw new Error("missing TESTNET_EVM_DEPLOYER_ADDRESS in .env");
    if (!/^[1-9][0-9]{0,8}$/.test(whole)) throw new Error("amount must be a whole number of tokens");
    const backing = representationOf(symbol);
    const amount = (BigInt(whole) * 10n ** 18n).toString();
    const entitlement = await reader().view(backing, "entitlement_of", { account: accountId });
    if (BigInt(entitlement) < BigInt(amount)) throw new Error(`entitlement ${entitlement} is lower than the amount ${amount}`);
    const requestId = crypto.randomBytes(32).toString("hex");
    const args = { backing, request_id: bytes(requestId), amount, destination: bytes(destination.slice(2)) };
    show({
      dryRun: !send, action: "request_payout", signer: accountId, receiver: PAYOUT, method: "request_payout",
      args: { ...args, request_id: `0x${requestId}`, destination }, gas: "100 Tgas", deposit: REQUEST_DEPOSIT, entitlement,
    });
    if (!send) return console.log("Dry run: nothing was sent.");
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ backing, holder: accountId, requestId, amount, destination }, null, 2));
    const near = new Near({ network: NETWORK, privateKey, defaultSignerId: accountId });
    const outcome = await near.call(PAYOUT, "request_payout", args, { gas: "100 Tgas", attachedDeposit: REQUEST_DEPOSIT, signerId: accountId, waitUntil: "FINAL" });
    show({ sent: true, requestId: `0x${requestId}`, result: outcome ?? null });
  },

  async status([requestIdHex]) {
    const saved = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null;
    const requestId = (requestIdHex ?? saved?.requestId ?? "").replace(/^0x/, "");
    if (!saved || !/^[0-9a-f]{64}$/.test(requestId)) throw new Error("no saved request; run request-payout --send first");
    const near = reader();
    const args = { backing: saved.backing, holder: saved.holder, request_id: bytes(requestId) };
    show({
      saved: { backing: saved.backing, holder: saved.holder, amount: saved.amount, destination: saved.destination },
      status: await near.view(PAYOUT, "get_payout_status", args).catch((e) => `unavailable: ${e.message}`),
      payout: await near.view(PAYOUT, "get_payout", args).catch((e) => `unavailable: ${e.message}`),
      entitlement: await near.view(saved.backing, "entitlement_of", { account: saved.holder }).catch((e) => `unavailable: ${e.message}`),
    });
  },

  async role([name]) {
    if (name !== "relayer" && name !== "operator") throw new Error("usage: role <relayer|operator> [--submit]");
    const env = readEnv();
    const upper = name.toUpperCase();
    const accountId = env[`TESTNET_${upper}_ACCOUNT_ID`];
    const privateKey = env[`TESTNET_${upper}_PRIVATE_KEY`];
    if (!accountId || !privateKey) throw new Error(`missing TESTNET_${upper}_ACCOUNT_ID / _PRIVATE_KEY in .env`);
    const child = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      // The default public NEAR RPC answers HTTP 429 under this load; FastNEAR without a key does not.
      NEAR_NETWORK: NETWORK, NEAR_RPC_URL: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com", PAYOUT_CONTRACT_ID: PAYOUT, PAYOUT_CHAIN_ID: EVM_CHAIN_ID, PAYOUT_EVM_RPC_URL: EVM_RPC,
      PAYOUT_INTERVAL_SECS: "10",
      [`PAYOUT_${upper}_ACCOUNT_ID`]: accountId,
      [`PAYOUT_${upper}_PRIVATE_KEY`]: privateKey,
      ...(name === "relayer" ? { PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI: process.env.PAYOUT_RELAYER_MAX_FEE_PER_GAS_WEI ?? "100000000" /* 0.1 gwei; the registered cap is 1 gwei, observed price 0.01 gwei */ } : {}),
      ...(name === "operator" ? { PAYOUT_OPERATOR_SUBMIT: process.argv.includes("--submit") ? "true" : "false" } : {}),
    };
    console.log(`starting payout ${name} as ${accountId} (submit=${child.PAYOUT_OPERATOR_SUBMIT ?? "n/a"})`);
    const proc = spawn(process.execPath, ["dist/payout-role-main.js", name], { cwd: path.join(ROOT, "agent"), env: child, stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => proc.kill(sig));
    proc.on("exit", (code) => process.exit(code ?? 1));
  },
};

const [command, ...rest] = argv;
if (!commands[command]) {
  console.error("commands: request-payout <SYMBOL> <amountWholeTokens> | status [<requestIdHex>] | role <relayer|operator> [--submit]");
  process.exit(1);
}
await commands[command](rest);
