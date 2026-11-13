#!/usr/bin/env node
// Live run launcher for the open arena on NEAR testnet (used for the 2026-11-11 live runs).
//
//   node scripts/testnet-wiring/live-run.mjs                 # agent + oracle + collector
//   node scripts/testnet-wiring/live-run.mjs oracle collector # only some of them
//
// Every process signs only with its own key, read from the repository's git-ignored .env and passed through the
// child process environment; nothing here prints a key. The agent and the oracle SEND TRANSACTIONS (audits, backing
// refresh, lock, rounds): run this only after the owner approved the live run. Build first: `pnpm -C agent build`.
// Needs the reference relay for the collector: `python3 scripts/rpc-relay.py 18546 rpc.mainnet.chain.robinhood.com`.
//
// Environment overrides (optional):
//   LIVE_STATE_DIR   journal and oracle state (default <repo>/.live-state, git-ignored)
//   AGENT_RPC_URL, ORACLE_RPC_URL, COLLECTOR_RPC_URL   NEAR RPC per process; give each its own endpoint, public
//                    testnet RPCs rate-limit one IP quickly (HTTP 429). With FASTNEAR_API_KEY in .env the default is
//                    https://test.rpc.fastnear.com?apiKey=<key> for all three.
//   ORACLE_INTERVAL_SECS (default 8), AGENT_INTERVAL_SECS (default 15)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pipeWorkerLog } from "../worker-log.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");
const STATE = process.env.LIVE_STATE_DIR || path.join(REPO, ".live-state");
if (!check) {
  fs.mkdirSync(path.join(STATE, "journal"), { recursive: true });
  fs.mkdirSync(path.join(STATE, "oracle"), { recursive: true });
}

const parse = (file) => {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
};
const env = parse(path.join(REPO, ".env"));
const local = parse(path.join(REPO, "agent/.env.local"));

const ARENA = "arena.valtrum-owner-b694.testnet";
const POLICY_HASH = "3d54cbd5a4421eb7f1a09ef8cc249c5be7d525e52bd9f805bf17e9c7085d9dee";
const SCOPE = JSON.stringify({ deploymentId: "near-testnet-existing-arena", network: "near-testnet", arenaContract: ARENA, protocol: "lifecycle-v2" });
const terms = JSON.parse(fs.readFileSync(path.join(REPO, "docs/openspec/changes/arena-testnet-integrations/open-arena-observation-terms.draft.json"), "utf8"));
delete terms.policy_version;
const TERMS_PATH = path.join(STATE, "terms.json");
if (!check) fs.writeFileSync(TERMS_PATH, JSON.stringify({ [POLICY_HASH]: terms }, null, 2));

const keyed = env.FASTNEAR_API_KEY ? `https://test.rpc.fastnear.com?apiKey=${env.FASTNEAR_API_KEY}` : null;
const rpc = (name, fallback) => process.env[name] || keyed || fallback;

const base = { PATH: process.env.PATH, HOME: process.env.HOME, NEAR_NETWORK: "testnet", ARENA_CONTRACT_ID: ARENA };
// Observation journal and oracle status: files in LIVE_STATE_DIR (default), or the application database with
// OBSERVATION_JOURNAL_STORE=database (OpenSpec observation-journal-database). The collector, the oracle and the read API
// must use the same one; scripts/dev.mjs passes the same switch to the read API.
const journalDb = (process.env.OBSERVATION_JOURNAL_STORE || local.OBSERVATION_JOURNAL_STORE) === "database";
const journalEnv = journalDb
  ? { OBSERVATION_JOURNAL_STORE: "database", APP_DATABASE_URL: local.APP_DATABASE_URL }
  : { OBSERVATION_JOURNAL_DIR: path.join(STATE, "journal") };
const oracleStateEnv = journalDb ? {} : { ORACLE_STATE_DIR: path.join(STATE, "oracle") };
const procs = [
  {
    name: "agent",
    script: "agent/dist/main.js",
    env: {
      ...base,
      NEAR_RPC_URL: rpc("AGENT_RPC_URL", "https://rpc.testnet.near.org"),
      AGENT_ACCOUNT_ID: env.TESTNET_AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY: env.TESTNET_AGENT_PRIVATE_KEY,
      AGENT_INTERVAL_SECS: process.env.AGENT_INTERVAL_SECS || "5",
      AUDIT_ENABLED: "true", AUDIT_LOCK_ENABLED: "true", AUDIT_EVIDENCE_TTL_SECS: local.AUDIT_EVIDENCE_TTL_SECS ?? "600",
      REFERENCE_RPC_URL: "http://127.0.0.1:18546",
      AUDIT_STABLECOINS: local.AUDIT_STABLECOINS, AUDIT_LP_POOLS: local.AUDIT_LP_POOLS,
      AUDIT_WETH_ADDRESS: local.AUDIT_WETH_ADDRESS, AUDIT_WETH_CHAIN_ID: local.AUDIT_WETH_CHAIN_ID,
      AUDIT_WETH_PRICE_POOL: local.AUDIT_WETH_PRICE_POOL, AUDIT_WETH_PRICE_POOL_MIN_USD: local.AUDIT_WETH_PRICE_POOL_MIN_USD,
      ...(env.GOPLUS_ACCESS_TOKEN ? { GOPLUS_ACCESS_TOKEN: env.GOPLUS_ACCESS_TOKEN } : {}),
      BASELINE_STORE_PATH: path.join(STATE, "baselines.json"),
      // Durable audit history: the full evidence behind each approval hash the arena stores (append-only). Postgres
      // when APP_DATABASE_URL is set below, else this file.
      AUDIT_REPORT_ARCHIVE_ENABLED: "true", AUDIT_REPORT_ARCHIVE_PATH: path.join(STATE, "audit-archive.json"),
      // Baselines, the audit archive and the latest audit decisions go to Postgres when the application database is configured.
      // The oracle and the collector get it only with OBSERVATION_JOURNAL_STORE=database.
      ...(local.APP_DATABASE_URL ? { APP_DATABASE_URL: local.APP_DATABASE_URL } : {}),
    },
  },
  {
    name: "oracle",
    script: "agent/dist/lifecycle-oracle/main.js",
    env: {
      ...base,
      NEAR_RPC_URL: rpc("ORACLE_RPC_URL", "https://test.rpc.fastnear.com"),
      ORACLE_ACCOUNT_ID: env.TESTNET_ORACLE_ACCOUNT_ID, ORACLE_PRIVATE_KEY: env.TESTNET_ORACLE_PRIVATE_KEY,
      ...oracleStateEnv, ...journalEnv,
      ARENA_APPLICATION_OBSERVATION_SCOPE: SCOPE, ORACLE_TERMS_PATH: TERMS_PATH, ORACLE_WRITES_ENABLED: "true",
      ORACLE_ROUNDS_STORAGE_DEPOSIT_YOCTO: "500000000000000000000000", OBSERVATION_QUALIFIED_MODES: "PriceGain", ORACLE_EVIDENCE_KINDS: "live",
      ORACLE_INTERVAL_SECS: process.env.ORACLE_INTERVAL_SECS || "1",
    },
  },
  {
    name: "collector",
    script: "agent/dist/observations/collector-main.js",
    env: {
      ...base,
      NEAR_RPC_URL: rpc("COLLECTOR_RPC_URL", "https://rpc.testnet.fastnear.com"),
      ARENA_APPLICATION_OBSERVATION_SCOPE: SCOPE, ORACLE_TERMS_PATH: TERMS_PATH, ...journalEnv,
      REFERENCE_RPC_URL: "http://127.0.0.1:18546", OBSERVATION_QUALIFIED_MODES: "PriceGain", COLLECTOR_INTERVAL_MS: "1000",
    },
  },
];

const only = process.argv.slice(2).filter((arg) => arg !== "--check");
const selected = procs.filter((p) => !only.length || only.includes(p.name));
let invalid = false;
for (const p of selected) {
  const missing = Object.entries(p.env).filter(([, v]) => v === undefined || v === "").map(([key]) => key);
  if (missing.length) { console.error(`${p.name}: missing ${missing.join(", ")} in .env or agent/.env.local`); invalid = true; }
}
if (invalid) process.exit(1);
if (check) { console.log(`worker configuration ready: ${selected.map((p) => p.name).join(", ")}`); process.exit(0); }
const children = [];
for (const p of procs) {
  if (only.length && !only.includes(p.name)) continue;
  const missing = Object.entries(p.env).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length) { console.error(`${p.name}: missing ${missing.join(", ")} in .env or agent/.env.local`); continue; }
  const log = fs.openSync(path.join(STATE, `${p.name}.log`), "a");
  const child = spawn("node", [path.join(REPO, p.script)], { env: p.env, stdio: ["ignore", "pipe", "pipe"], cwd: path.join(REPO, "agent") });
  const secrets = Object.entries({ ...env, ...local, ...p.env }).filter(([key]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(key)).map(([, value]) => value);
  for (const stream of [child.stdout, child.stderr]) pipeWorkerLog(stream, {
    name: p.name,
    secrets,
    archive: (line) => fs.writeSync(log, line),
    write: (line) => process.stdout.write(line),
  });
  children.push(child);
  console.log(`started ${p.name} pid ${child.pid}, log ${path.join(STATE, `${p.name}.log`)}`);
  child.on("close", (code) => {
    fs.closeSync(log);
    console.error(`[${p.name}] exited with ${code}`);
    if (!stopping) {
      console.error(`[workers] ${p.name} stopped unexpectedly; shutting down workers. Inspect its log before restarting pnpm dev.`);
      process.exitCode = code || 1;
      stop();
    }
  });
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  console.log("[workers] Shutdown requested; waiting for active passes and lock cleanup.");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
