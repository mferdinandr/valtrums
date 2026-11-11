#!/usr/bin/env node
// Open arena testnet rollout, one chain action per invocation (runbook:
// docs/openspec/changes/arena-testnet-integrations/open-arena-rollout-runbook.md).
//
// Every write command is a DRY RUN by default: it prints the signer, receiver, method, arguments, gas and
// deposit and sends nothing. Add --send to broadcast, and only after the owner approved that exact action.
// Keys are read from the repository's git-ignored .env (TESTNET_<ROLE>_ACCOUNT_ID / _PRIVATE_KEY) and are
// never printed, logged or passed on a command line.
//
//   node scripts/testnet-wiring/open-arena.mjs policy-hash <terms.json> <Mode>          (offline)
//   node scripts/testnet-wiring/open-arena.mjs status                                   (views only)
//   node scripts/testnet-wiring/open-arena.mjs deploy-arena <arena.wasm> [--send]       (OWNER)
//   node scripts/testnet-wiring/open-arena.mjs propose-joinable <SYMBOL> [--send]       (COUNCIL1, 1 NEAR bond)
//   node scripts/testnet-wiring/open-arena.mjs vote <PROPOSAL_ID> <COUNCIL2|COUNCIL3> [--send]
//   node scripts/testnet-wiring/open-arena.mjs untrust <SYMBOL> [--send]                (OWNER)
//   node scripts/testnet-wiring/open-arena.mjs create-oracle [--send]                  (testnet helper; writes TESTNET_ORACLE_* to .env)
//   node scripts/testnet-wiring/open-arena.mjs set-oracle [--send]                     (OWNER, permanent)
//   node scripts/testnet-wiring/open-arena.mjs set-policy <terms.json> <Mode> [--send] (OWNER)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_PATH = path.join(ROOT, ".env");
const { Near, generateKey } = await import(pathToFileURL(path.join(ROOT, "agent/node_modules/near-kit/dist/index.js")).href);

const NETWORK = "testnet";
const ARENA = "arena.valtrum-owner-b694.testnet";
const DAO = "valtrum-protocol.sputnikv2.testnet";
const ORACLE_ID = "valtrum-oracle-b694.testnet";
const CUSTODY_DOMAIN = "0xb994dcab6ad9a042e7bbec3ba104ec5e6b797798";
const MODES = ["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"];

/** Asset identities recorded in docs/evidence/2026-11-09-near-testnet-wiring.json (backings and reference registry). */
const TOKENS = {
  CASHCAT: { token: "0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6", reference: "0x020bfc650a365f8bb26819deaabf3e21291018b4" },
  WALLET: { token: "0x78e7621559bc0e3cc10f8bb61dc2a371afe66e27", reference: "0x0339f5459fc690ac85f1782e15782a151b4a9e1b" },
  GOOD: { token: "0xaed11a367b102f2da3ac2dfcf1de9cc97a47a850", reference: "0x5f62c57e5c537887117eef828b7e3ad41c009feb" },
  AI: { token: "0x973c4e0601c03a4899b8c9643b299aaaece4ba0a", reference: "0x0d4a117dccce7ba3d0a475ec9068c20c35310fd8" },
  VLAD: { token: "0xd879e8483d63265abe2549a347017e59a04a15bc", reference: "0xfdbb27e971e72e38c41b1c772fb409c94dd92789" },
  DEGEN: { token: "0x209aa417c2aa45a13304acc51c4c393d0ac5ba84", reference: "0x0830a9dd26a04e959657ab6788d45f5725590c32" },
};
/** D35: the joinable allowlist. AI is excluded. */
const JOINABLE = ["CASHCAT", "WALLET", "GOOD", "VLAD", "DEGEN"];
const representationOf = (symbol) => `backing-${symbol.toLowerCase()}.valtrum-owner-b694.testnet`;

function assetOf(symbol) {
  const t = TOKENS[symbol];
  if (!t) throw new Error(`unknown token ${symbol}; one of ${Object.keys(TOKENS).join(", ")}`);
  return {
    chain_id: "46630",
    token_address: t.token,
    representation: representationOf(symbol),
    custody_domain: CUSTODY_DOMAIN,
    reference_chain_id: "4663",
    reference_address: t.reference,
  };
}

function readEnv() {
  const env = {};
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function signer(role) {
  const env = readEnv();
  const accountId = env[`TESTNET_${role}_ACCOUNT_ID`];
  const privateKey = env[`TESTNET_${role}_PRIVATE_KEY`];
  if (!accountId || !privateKey) throw new Error(`missing TESTNET_${role}_ACCOUNT_ID or TESTNET_${role}_PRIVATE_KEY in .env`);
  return { accountId, near: new Near({ network: NETWORK, privateKey, defaultSignerId: accountId }) };
}

const reader = () => new Near({ network: NETWORK });
const send = process.argv.includes("--send");
const args = process.argv.slice(2).filter((a) => a !== "--send");

/** The arena's terms digest (contracts/arena/src/rounds.rs `ObservationTerms::digest`). */
export function policyHash(terms, mode) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  const pools = [...terms.eligible_pools].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  let text = `valtrum/observation-policy/v1;mode=${mode};`;
  const field = (v) => { text += `${Buffer.byteLength(v)}:${v};`; };
  field(terms.source);
  field(terms.quote_currency);
  field(terms.finality);
  for (const p of pools) field(p);
  field(`${terms.price_decimals}/${terms.supply_decimals}/${terms.volume_decimals}/${terms.boundary_tolerance_ns}/${terms.max_gap_ns}`);
  return crypto.createHash("sha256").update(text).digest("hex");
}

function plan(action) {
  console.log(JSON.stringify({ dryRun: !send, ...action }, null, 2));
  if (!send) console.log("Dry run: nothing was sent. Re-run with --send after the owner approves this exact action.");
}

async function call(role, receiver, method, callArgs, gas, deposit, label) {
  const { accountId, near } = signer(role);
  plan({ action: label, signer: accountId, receiver, method, args: callArgs, gas, deposit });
  if (!send) return null;
  const outcome = await near.call(receiver, method, callArgs, { gas, attachedDeposit: deposit, signerId: accountId, waitUntil: "FINAL" });
  console.log(JSON.stringify({ sent: true, result: outcome ?? null }));
  return outcome;
}

const commands = {
  "policy-hash": async ([file, mode]) => {
    const terms = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(policyHash(terms, mode));
  },

  status: async () => {
    const near = reader();
    const out = {};
    out.joinable = await near.view(ARENA, "get_lifecycle_joinable_assets", { from_index: "0", limit: "50" }).catch((e) => `unavailable: ${e.message}`);
    out.trusted = {};
    for (const s of Object.keys(TOKENS)) {
      out.trusted[s] = await near.view(ARENA, "is_lifecycle_representation_trusted", { representation: representationOf(s) }).catch((e) => `unavailable: ${e.message}`);
    }
    out.lastProposalId = await near.view(DAO, "get_last_proposal_id", {}).catch((e) => `unavailable: ${e.message}`);
    console.log(JSON.stringify(out, null, 2));
  },

  "deploy-arena": async ([wasmPath]) => {
    if (!wasmPath) throw new Error("usage: deploy-arena <arena.wasm>");
    const code = fs.readFileSync(wasmPath);
    const sha = crypto.createHash("sha256").update(code).digest("hex");
    const { accountId, near } = signer("OWNER");
    plan({ action: "redeploy arena code in place (no init, state kept)", signer: accountId, receiver: ARENA, wasm: wasmPath, bytes: code.length, sha256: sha });
    if (!send) return;
    const outcome = await near.transaction(accountId).deployContract(ARENA, new Uint8Array(code)).send({ waitUntil: "FINAL" });
    console.log(JSON.stringify({ sent: true, tx: outcome?.transaction?.hash ?? null, status: outcome?.status ?? null }));
  },

  "propose-joinable": async ([symbol]) => {
    if (!JOINABLE.includes(symbol)) throw new Error(`only ${JOINABLE.join(", ")} are joinable (D35)`);
    const asset = assetOf(symbol);
    const inner = Buffer.from(JSON.stringify({ asset })).toString("base64");
    const proposal = {
      proposal: {
        description: `Open arena allowlist (D35): make ${symbol} joinable`,
        kind: { FunctionCall: { receiver_id: ARENA, actions: [{ method_name: "set_lifecycle_joinable_asset", args: inner, deposit: "1", gas: "100000000000000" }] } },
      },
    };
    console.log(JSON.stringify({ decodedInnerArgs: { asset } }, null, 2));
    await call("COUNCIL1", DAO, "add_proposal", proposal, "100 Tgas", "1 NEAR", `DAO proposal: set_lifecycle_joinable_asset ${symbol}`);
  },

  vote: async ([id, role]) => {
    if (!/^[0-9]+$/.test(id ?? "") || !["COUNCIL2", "COUNCIL3"].includes(role)) throw new Error("usage: vote <PROPOSAL_ID> <COUNCIL2|COUNCIL3>");
    await call(role, DAO, "act_proposal", { id: Number(id), action: "VoteApprove" }, "300 Tgas", "0 NEAR", `VoteApprove proposal ${id}`);
  },

  untrust: async ([symbol]) => {
    if (!TOKENS[symbol]) throw new Error(`unknown token ${symbol}`);
    await call("OWNER", ARENA, "set_lifecycle_representation_trusted", { representation: representationOf(symbol), trusted: false }, "30 Tgas", "1 yocto", `remove ${symbol} from the trusted representations`);
  },

  "create-oracle": async () => {
    const env = readEnv();
    if (env.TESTNET_ORACLE_ACCOUNT_ID) throw new Error("TESTNET_ORACLE_ACCOUNT_ID is already in .env; not creating another");
    plan({ action: "create the oracle account through the testnet helper (faucet) and store its key in .env", account: ORACLE_ID, helper: "https://helper.nearprotocol.com/account" });
    if (!send) return;
    const key = generateKey();
    const res = await fetch("https://helper.nearprotocol.com/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: ORACLE_ID, newAccountPublicKey: key.publicKey.toString() }),
    });
    if (!res.ok) throw new Error(`helper refused: HTTP ${res.status}`);
    const current = fs.readFileSync(ENV_PATH, "utf8");
    fs.appendFileSync(ENV_PATH, `${current.endsWith("\n") ? "" : "\n"}TESTNET_ORACLE_ACCOUNT_ID=${ORACLE_ID}\nTESTNET_ORACLE_PRIVATE_KEY=${key.secretKey}\n`);
    fs.chmodSync(ENV_PATH, 0o600);
    console.log(JSON.stringify({ sent: true, account: ORACLE_ID, publicKey: key.publicKey.toString(), envUpdated: true }));
  },

  "set-oracle": async () => {
    await call("OWNER", ARENA, "set_lifecycle_oracle", { oracle: ORACLE_ID }, "30 Tgas", "1 yocto", "fix the lifecycle oracle (PERMANENT, can never change)");
  },

  "set-policy": async ([file, mode]) => {
    const terms = JSON.parse(fs.readFileSync(file, "utf8"));
    const hash = policyHash(terms, mode);
    const version = String(terms.policy_version ?? 1);
    await call("OWNER", ARENA, "set_lifecycle_observation_policy", { policy: { version, policy_hash: hash } }, "30 Tgas", "1 yocto", `observation policy for future locks (mode ${mode})`);
  },
};

const [command, ...rest] = args;
if (!commands[command]) {
  console.error(`unknown command ${command ?? ""}; one of ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
await commands[command](rest);
