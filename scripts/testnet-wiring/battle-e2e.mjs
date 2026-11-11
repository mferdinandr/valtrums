#!/usr/bin/env node
// Helpers for an end-to-end battle drill on NEAR testnet (docs/player-agents.md, docs/testnet-e2e-runbook.md).
// Writes are a DRY RUN unless --send is given. Keys come from the git-ignored .env (TESTNET_<ROLE>_ACCOUNT_ID /
// _PRIVATE_KEY) and are never printed, logged or passed on a command line.
//
//   node scripts/testnet-wiring/battle-e2e.mjs view <contract> <method> '<argsJson>'
//   node scripts/testnet-wiring/battle-e2e.mjs call <ROLE> <contract> <method> '<argsJson>' <gasTgas> <depositYocto> [--send]
//   node scripts/testnet-wiring/battle-e2e.mjs create <ROLE> <SYMBOL> <wholeTokens> <startInMinutes> [--send]
//   node scripts/testnet-wiring/battle-e2e.mjs battle <id>
//
// `create` is the creator's `ft_transfer_call` of a joinable token with a `lifecycle_create` message (PriceGain).
// Use NEAR_RPC_URL (for example https://test.rpc.fastnear.com): the public default answers HTTP 429.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Near } = await import(pathToFileURL(path.join(ROOT, "agent/node_modules/near-kit/dist/index.js")).href);
const NETWORK = "testnet";
const ARENA = "arena.valtrum-owner-b694.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const send = process.argv.includes("--send");
const argv = process.argv.slice(2).filter((a) => a !== "--send");

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
const reader = () => new Near({ network: NETWORK, rpcUrl: RPC });
const show = (o) => console.log(JSON.stringify(o, null, 2));
const representationOf = (symbol) => `backing-${symbol.toLowerCase()}.valtrum-owner-b694.testnet`;

async function write(role, receiver, method, args, gas, deposit, label) {
  const env = readEnv();
  const accountId = env[`TESTNET_${role}_ACCOUNT_ID`];
  const privateKey = env[`TESTNET_${role}_PRIVATE_KEY`];
  if (!accountId || !privateKey) throw new Error(`missing TESTNET_${role}_ACCOUNT_ID / _PRIVATE_KEY in .env`);
  show({ dryRun: !send, action: label, signer: accountId, receiver, method, args, gas: `${gas} Tgas`, deposit: `${deposit} yocto` });
  if (!send) return console.log("Dry run: nothing was sent.");
  const near = new Near({ network: NETWORK, rpcUrl: RPC, privateKey, defaultSignerId: accountId });
  const out = await near.call(receiver, method, args, { gas: `${gas} Tgas`, attachedDeposit: `${deposit} yocto`, signerId: accountId, waitUntil: "FINAL" });
  const status = out?.status ?? out?.final_execution_status ?? null;
  const failure = out?.status && typeof out.status === "object" ? out.status.Failure : null;
  show({ sent: true, hash: out?.transaction?.hash ?? null, failure: failure ?? null, status: typeof status === "string" ? status : undefined });
}

const commands = {
  async view([contract, method, argsJson]) {
    show(await reader().view(contract, method, JSON.parse(argsJson ?? "{}")));
  },
  async call([role, contract, method, argsJson, gas, deposit]) {
    if (!role || !contract || !method) throw new Error("usage: call <ROLE> <contract> <method> '<argsJson>' <gasTgas> <depositYocto>");
    await write(role, contract, method, JSON.parse(argsJson ?? "{}"), gas ?? "30", deposit ?? "0", `${method} on ${contract}`);
  },
  async create([role, symbol, whole, minutes]) {
    if (!role || !symbol || !whole || !minutes) throw new Error("usage: create <ROLE> <SYMBOL> <wholeTokens> <startInMinutes>");
    if (!/^[1-9][0-9]{0,8}$/.test(whole) || !/^[1-9][0-9]{0,3}$/.test(minutes)) throw new Error("amount and minutes must be positive whole numbers");
    const startAtMs = String(Date.now() + Number(minutes) * 60_000);
    const amount = (BigInt(whole) * 10n ** 18n).toString();
    const msg = JSON.stringify({ action: "lifecycle_create", mode: "PriceGain", start_at_ms: startAtMs });
    await write(role, representationOf(symbol), "ft_transfer_call", { receiver_id: ARENA, amount, msg }, "100", "1", `create a PriceGain battle starting at ${new Date(Number(startAtMs)).toISOString()}`);
  },
  async battle([id]) {
    const near = reader();
    const battle = await near.view(ARENA, "get_lifecycle_battle", { battle_id: Number(id) });
    const round = await near.view(ARENA, "get_lifecycle_round", { battle_id: Number(id) }).catch(() => null);
    show({
      id: Number(id),
      start: battle?.start_at_ms ? new Date(Number(battle.start_at_ms)).toISOString() : null,
      locked: battle?.locked, cancelled: battle?.cancelled ?? false,
      communities: (battle?.communities ?? []).map((c, i) => ({ i, token: c.representation.split(".")[0], vault: c.vault, audit: !!c.audit_evidence_hash, backing: !!c.backing_evidence_hash })),
      round: round ? { id: round.round_id, winner: round.winner, start: round.start_ns, end: round.end_ns } : null,
    });
  },
};

const [command, ...rest] = argv;
if (!commands[command]) {
  console.error("commands: view | call | create | battle");
  process.exit(1);
}
await commands[command](rest);
