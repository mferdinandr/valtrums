#!/usr/bin/env node
// Votes inside the arena's short DAO window as soon as a battle records its winner, then executes the disposition.
// The arena's window is 30 s on testnet, too short to vote by hand.
//
//   node scripts/testnet-wiring/dao-watch.mjs <battleId> <community=ROLE> [<community=ROLE> ...] [--burn]
//   example: node scripts/testnet-wiring/dao-watch.mjs 4 0=USER1 1=USER2
//
// <community=ROLE> names the depositor of each community (TESTNET_<ROLE>_* in .env); the winner's depositor votes
// "return" (or "burn" with --burn). USER1 reserves the escrow and executes after the window. Every call SENDS A
// TRANSACTION: run it only after the owner approved the vote. Keys are never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Near } = await import(pathToFileURL(path.join(REPO, "agent/node_modules/near-kit/dist/index.js")).href);
const env = {};
for (const l of fs.readFileSync(path.join(REPO, ".env"), "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }

const args = process.argv.slice(2);
const BATTLE = args[0];
const burn = args.includes("--burn");
const VOTER = Object.fromEntries(args.slice(1).filter((a) => a.includes("=")).map((a) => a.split("=")));
if (!/^[0-9]+$/.test(BATTLE ?? "") || Object.keys(VOTER).length === 0) {
  console.error("usage: dao-watch.mjs <battleId> <community=ROLE> [...] [--burn]");
  process.exit(2);
}
const A = "arena.valtrum-owner-b694.testnet";
const keyed = env.FASTNEAR_API_KEY ? `https://test.rpc.fastnear.com?apiKey=${env.FASTNEAR_API_KEY}` : null;
const RPCS = keyed ? [keyed] : ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com"];
const as = (role, rpc) => { const id = env[`TESTNET_${role}_ACCOUNT_ID`]; return { id, near: new Near({ network: "testnet", rpcUrl: rpc, privateKey: env[`TESTNET_${role}_PRIVATE_KEY`], defaultSignerId: id }) }; };
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const val = (o) => { const v = o?.status?.SuccessValue; return v === undefined ? null : Buffer.from(v, "base64").toString(); };
let rpcIdx = 0;
const reader = () => new Near({ network: "testnet", rpcUrl: RPCS[rpcIdx++ % RPCS.length] });
async function retry(label, fn) {
  for (let i = 1; i <= 6; i++) {
    try { return await fn(RPCS[(i - 1) % RPCS.length]); }
    catch (e) { const m = String(e?.panic ?? e?.message); log({ label, attempt: i, error: m.slice(0, 160) }); if (!/429|timeout|fetch failed|Server error/i.test(m)) throw e; await sleep(1500 * i); }
  }
  throw new Error(`${label}: gave up`);
}

let winner = null;
let last = "";
while (winner === null) {
  try {
    const r = await reader().view(A, "get_lifecycle_round", { battle_id: BATTLE });
    const s = r ? `${r.round_id}:${r.start_ns ?? "-"}:${r.winner}` : "none";
    if (s !== last) { log({ round: r?.round_id ?? null, candidates: r?.candidates, start_ns: r?.start_ns ?? null, winner: r?.winner ?? null }); last = s; }
    if (r && r.winner !== null && r.winner !== undefined) winner = r.winner;
  } catch { /* rate limit: next tick */ }
  // Slow until a round window is open, then fast enough to vote inside a 30 s window.
  if (winner === null) await sleep(last === "" || last === "none" || last.includes(":-:") ? 15_000 : 1500);
}
const role = VOTER[String(winner)];
if (!role) { log({ winner, error: "no depositor role given for the winning community; not voting" }); process.exit(1); }
log({ winner, voter: env[`TESTNET_${role}_ACCOUNT_ID`], vote: burn ? "burn" : "return" });
const vote = await retry("vote", (rpc) => { const u = as(role, rpc); return u.near.call(A, "vote_lifecycle_disposition", { battle_id: BATTLE, burn }, { gas: "100 Tgas", attachedDeposit: "0.01 NEAR", signerId: u.id }); });
log({ step: "vote", tx: vote?.transaction?.hash });
const esc = await retry("escrow", (rpc) => { const u = as("USER1", rpc); return u.near.call(A, "reserve_lifecycle_escrow", { battle_id: BATTLE }, { gas: "300 Tgas", attachedDeposit: "0.01 NEAR", signerId: u.id, waitUntil: "FINAL" }); });
log({ step: "escrow", result: val(esc), tx: esc?.transaction?.hash });
let d = await retry("disposition", (rpc) => new Near({ network: "testnet", rpcUrl: rpc }).view(A, "get_lifecycle_disposition", { battle_id: BATTLE }));
const waitMs = Number(BigInt(d.closes_at_ns) / 1_000_000n) - Date.now() + 3_000;
if (waitMs > 0) await sleep(waitMs);
d = await retry("disposition", (rpc) => new Near({ network: "testnet", rpcUrl: rpc }).view(A, "get_lifecycle_disposition", { battle_id: BATTLE }));
log({ step: "after_window", status: d.status, burn_weight: d.burn_weight, return_weight: d.return_weight });
const batch = Math.max(1, Math.min(10, Number(d.total_releases ?? 1) - Number(d.released ?? 0) || 1));
const ex = await retry("execute", (rpc) => { const u = as("USER1", rpc); return u.near.call(A, "execute_lifecycle_disposition", { battle_id: BATTLE, max_releases: batch }, { gas: "250 Tgas", attachedDeposit: `${(0.01 * batch).toFixed(2)} NEAR`, signerId: u.id, waitUntil: "FINAL" }); });
log({ step: "execute", result: val(ex), tx: ex?.transaction?.hash });
