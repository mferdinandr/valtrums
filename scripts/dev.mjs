#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { spawn, spawnSync } from "node:child_process";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readEnv = (name) => fs.existsSync(path.join(root, name)) ? parseEnv(fs.readFileSync(path.join(root, name), "utf8")) : {};
const secrets = readEnv(".env");
const local = readEnv("agent/.env.local");
const env = { ...secrets, ...local, ...process.env };
const check = process.argv.includes("--check");
const state = path.resolve(root, env.LIVE_STATE_DIR || ".live-state");
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  process.exitCode = code;
  console.log("[dev] Waiting for workers to finish in-flight work and release their locks…");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
function start(name, command, args, childEnv = {}, cwd = root) {
  console.log(`[dev] ${name}${check ? " (configuration checked; not started)" : " starting"}`);
  if (check) return;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/PRIVATE_KEY|^PAYOUT_(RELAYER|OPERATOR)_/.test(key)));
  const child = spawn(command, args, { cwd, env: { ...inherited, ...childEnv }, detached: true, stdio: "inherit" });
  children.push(child);
  child.on("error", () => { console.error(`[dev] ${name} failed to start`); stop(1); });
  child.on("exit", (code) => { if (!stopping) { console.error(`[dev] ${name} exited (${code})`); stop(code || 1); } });
}
const workers = env.DEV_WORKERS !== "0";
if (workers) {
  if ((env.NEAR_NETWORK && env.NEAR_NETWORK !== "testnet") || (env.ARENA_CONTRACT_ID && env.ARENA_CONTRACT_ID !== "arena.valtrum-owner-b694.testnet")) {
    console.error("[dev] The live worker runner is configured for arena.valtrum-owner-b694.testnet only. Use DEV_WORKERS=0 for another deployment."); process.exit(1);
  }
  const missing = ["TESTNET_AGENT_ACCOUNT_ID", "TESTNET_AGENT_PRIVATE_KEY", "TESTNET_ORACLE_ACCOUNT_ID", "TESTNET_ORACLE_PRIVATE_KEY"]
    .filter((key) => !env[key]);
  if (missing.length) { console.error(`[dev] Missing worker configuration: ${missing.join(", ")}. Use DEV_WORKERS=0 for UI/read API only.`); process.exit(1); }
  const preflight = spawnSync(process.execPath, ["scripts/testnet-wiring/live-run.mjs", "--check"], { cwd: root, stdio: "inherit" });
  if (preflight.status !== 0) process.exit(1);
}
// Hosted testnet agents (openspec hosted-player-agents): started only when HOSTED_AGENT_KEK is set in agent/.env.local.
// Unlike the workers it never blocks a plain `pnpm dev`: no KEK means it is simply off.
const HOSTED_PORT = 8792; // 8790 is the read API, 8791 the intents fixture
const hosted = Boolean(env.HOSTED_AGENT_KEK);
if (hosted) {
  const needed = ["NEAR_AI_API_KEY", "HOSTED_AGENT_MAX_PER_OWNER", "HOSTED_AGENT_MODEL_CALLS_PER_AGENT_HOUR", "HOSTED_AGENT_MODEL_CALLS_GLOBAL_HOUR", "HOSTED_AGENT_MAX_TOKEN_WHOLE"]
    .filter((key) => !env[key]);
  if (needed.length) { console.error(`[dev] Hosted agents need ${needed.join(", ")} in agent/.env.local, or remove HOSTED_AGENT_KEK to turn them off.`); process.exit(1); }
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== "testnet") { console.error("[dev] Hosted agents run on testnet only."); process.exit(1); }
}
const portBusy = (port) => spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "ignore" }).status === 0;
if (!check) {
  for (const port of hosted ? [3000, 8790, HOSTED_PORT] : [3000, 8790]) {
    if (portBusy(port)) { console.error(`[dev] Port ${port} is already in use. Stop the previous dev process before starting the stack.`); process.exit(1); }
  }
  const build = spawnSync("pnpm", ["-C", "agent", "build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(1);
}
for (const [port, host, enabled] of [[18546, "rpc.mainnet.chain.robinhood.com", env.DEV_RELAY !== "0"], [18545, "rpc.testnet.chain.robinhood.com", env.DEV_RELAY_TESTNET === "1"]]) {
  if (!enabled) continue;
  if (portBusy(port)) console.log(`[dev] Using existing relay on :${port}`);
  else start(`RPC relay :${port}`, "python3", ["scripts/rpc-relay.py", String(port), host]);
}
// Share journals with the read API; no signing key enters the web process.
const scope = JSON.stringify({ deploymentId: env.NEXT_PUBLIC_ARENA_READ_DEPLOYMENT || "near-testnet-existing-arena", network: "near-testnet", arenaContract: env.ARENA_CONTRACT_ID || "arena.valtrum-owner-b694.testnet", protocol: "lifecycle-v2" });
// OBSERVATION_JOURNAL_STORE=database (in agent/.env.local or the shell): the workers and the read API read the journal and
// the oracle status from the application database instead of LIVE_STATE_DIR. Every one of them gets the same switch.
const journalFiles = env.OBSERVATION_JOURNAL_STORE === "database"
  ? { OBSERVATION_JOURNAL_STORE: "database" }
  : { OBSERVATION_JOURNAL_DIR: path.join(state, "journal"), ORACLE_STATE_DIR: path.join(state, "oracle") };
const shared = { LIVE_STATE_DIR: state, ...journalFiles, ARENA_APPLICATION_OBSERVATION_SCOPE: scope, OBSERVATION_QUALIFIED_MODES: "PriceGain", OBSERVATION_BOUNDARY_TOLERANCE_MS: "5000", OBSERVATION_MAX_GAP_MS: "15000" };
if (workers) {
  console.log("[dev] Testnet workers enabled: audit, backing refresh, lock and oracle submit transactions.");
  start("agent / oracle / collector", process.execPath, ["scripts/testnet-wiring/live-run.mjs"], shared);
}
start("read API :8790", process.execPath, ["scripts/read-dev.mjs"], workers ? shared : {}, path.join(root, "agent"));
if (hosted) {
  // Reads agent/.env.local itself (it holds the NEAR AI key and the limits). The web app only gets the public URL.
  start(`hosted agents :${HOSTED_PORT} (testnet only)`, process.execPath, ["--env-file-if-exists=.env.local", "dist/hosted/main.js"], {
    NEAR_NETWORK: "testnet",
    ARENA_CONTRACT_ID: env.ARENA_CONTRACT_ID || "arena.valtrum-owner-b694.testnet",
    HOSTED_AGENT_ALLOWED_ORIGIN: env.HOSTED_AGENT_ALLOWED_ORIGIN || "http://localhost:3000",
    PORT: String(HOSTED_PORT),
  }, path.join(root, "agent"));
}
// The Terminal route (/api/terminal/lifecycle) runs on the web server and reads NEAR_AI_API_KEY there (server-side only,
// never NEXT_PUBLIC_). It is taken from agent/.env.local so one key serves the agents and the Terminal in development.
const webEnv = {
  ...(hosted ? { NEXT_PUBLIC_HOSTED_AGENTS_URL: env.NEXT_PUBLIC_HOSTED_AGENTS_URL || `http://localhost:${HOSTED_PORT}` } : {}),
  ...(env.NEAR_AI_API_KEY ? { NEAR_AI_API_KEY: env.NEAR_AI_API_KEY } : {}),
  ...(env.NEAR_AI_MODEL ? { NEAR_AI_MODEL: env.NEAR_AI_MODEL } : {}),
  ...(env.NEAR_AI_BASE_URL ? { NEAR_AI_BASE_URL: env.NEAR_AI_BASE_URL } : {}),
};
start("web :3000", "pnpm", ["-C", "web", "dev"], webEnv);
for (const role of ["RELAYER", "OPERATOR"]) {
  const prefix = `PAYOUT_${role}_`;
  if (!env[`${prefix}ACCOUNT_ID`]) { console.log(`[dev] payout ${role.toLowerCase()} not configured; not started`); continue; }
  // Preserve role separation: never pass the agent key or the other payout role's credentials.
  const payoutEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith(prefix) || ["PAYOUT_CONTRACT_ID", "PAYOUT_CHAIN_ID", "PAYOUT_EVM_RPC_URL", "PAYOUT_INTERVAL_SECS", "NEAR_NETWORK", "NEAR_RPC_URL"].includes(key)));
  start(`payout ${role.toLowerCase()}`, process.execPath, ["dist/payout-role-main.js", role.toLowerCase()], payoutEnv, path.join(root, "agent"));
}
