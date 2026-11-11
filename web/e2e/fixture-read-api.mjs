// FIXTURE-ONLY read service for browser tests. It runs the REAL application read code from agent/dist over
// in-memory fixtures and a temporary observation journal. Nothing here was observed on a live network.
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionedLifecycleReadSource } from "../../agent/dist/mcp/application-adapter.js";
import { ApplicationReads } from "../../agent/dist/mcp/application.js";
import { startReadServer } from "../../agent/dist/mcp/http.js";
import { FixtureStateSource } from "../../agent/dist/mcp/account-state.js";
import { FixtureArenaReadSource } from "../../agent/dist/mcp/read-source.js";
import { ReadSessions } from "../../agent/dist/mcp/session.js";
import { ObservationJournal, loadObservationState } from "../../agent/dist/observations/journal.js";
import { staticReferenceRegistry } from "../../agent/dist/reference-registry.js";

const PORT = Number(process.env.FIXTURE_READ_PORT ?? 18790);
const ARENA = "arena.testnet";
const POLICY = "e2e-policy-hash";
const NS = { deploymentId: "arena-fixture-v1", network: "near-testnet", arenaContract: ARENA, protocol: "lifecycle-v2" };
const NOW = Date.now();
const START_MS = NOW - 120_000;
const END_MS = START_MS + 30_000;
const addr = (n) => `0x${String(n).repeat(40)}`;
const FUTURE = String(NOW + 3_600_000);

const community = (i, over = {}) => ({
  chain_id: "46630", token_address: addr(i), representation: `c${i}.rep.testnet`, custody_domain: "custody-e2e",
  reference_chain_id: i === 1 ? "4663" : null, reference_address: i === 1 ? addr("b") : null, vault: i === 1 ? "18446744073709551615" : "1000",
  audit_policy_hash: "audit-policy", audit_evidence_hash: `audit-${i}`, audit_expires_at_ms: FUTURE, backing_evidence_hash: `backing-${i}`, ...over,
});
const battle = (over = {}) => ({
  creator: "creator.testnet", protocol: "protocol.testnet", protocol_created: false, fee_bps: 10, creator_share_bps: 5000, mode: "PriceGain", locked: true,
  observation_policy_version: "1", observation_policy_hash: POLICY, principal_community: null, principal_amount: null,
  communities: [community(1), community(2), community(3)], ...over,
});
const battles = new Map([
  // 1: still open, community 2 has no audit approval (a visible blocker)
  [1, battle({ locked: false, observation_policy_hash: null, communities: [community(1), community(2, { audit_evidence_hash: null, audit_expires_at_ms: null }), community(3)] })],
  // 2: locked, window recorded and already ended, no winner: "awaiting resolution"
  [2, battle()],
  // 3: decided
  [3, battle({ mode: "LowestDrawdown", principal_community: 1, principal_amount: "500" })],
  // Open arena (D34 to D36). 4: gathering before its start, one funded and one pending community
  [4, battle({ locked: false, observation_policy_hash: null, start_at_ms: String(NOW + 3_600_000), cancelled: false, communities: [community(1, { vault: "1000" }), community(2, { vault: "0" })] })],
  // 5: start passed with one funded community: anyone can cancel
  [5, battle({ locked: false, observation_policy_hash: null, start_at_ms: String(NOW - 60_000), cancelled: false, communities: [community(1, { vault: "1000" })] })],
  // 6: cancelled: depositors claim refunds
  [6, battle({ locked: false, observation_policy_hash: null, start_at_ms: String(NOW - 120_000), cancelled: true, communities: [community(1, { vault: "1000" })] })],
  // 7: just created, no community has joined yet
  [7, battle({ locked: false, observation_policy_hash: null, start_at_ms: String(NOW + 3_600_000), cancelled: false, communities: [] })],
]);
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
const rounds = new Map([
  [2, { round_id: "1", candidates: [0, 1, 2], start_ns: ns(START_MS), end_ns: ns(END_MS), winner: null }],
  [3, { round_id: "2", candidates: [0, 1], start_ns: ns(START_MS), end_ns: ns(END_MS), winner: 1 }],
]);

const readiness = (id) => ({
  schema_version: "lifecycle-application-v1", block_height: "100", observed_at_ms: String(NOW), activated: true, paused: false, legacy_battle_count: "0",
  activation_blocked_by_legacy: false, protocol: "protocol.testnet", oracle: "oracle.testnet", audit_policy_hash: "audit-policy", observation_policy: null,
  battle_found: true,
  backings: battles.get(id).communities.map((c, community) => ({ community, representation: c.representation, trusted: true, asset_matches: true, evidence_hash: c.backing_evidence_hash, expires_at_ms: FUTURE, fresh: true })),
});
const view = async (_contract, method, args) => {
  const id = Number(args.battle_id);
  if (method === "get_lifecycle_battle_count_v1") return String(battles.size);
  if (method === "get_lifecycle_battle_v1") return battles.get(id) ?? null;
  if (method === "get_lifecycle_round") return rounds.get(id) ?? null;
  if (method === "get_lifecycle_readiness_v1") return readiness(id);
  if (method === "get_lifecycle_round_history_v1") return null;
  throw new Error(`unknown view ${method}`);
};

const dir = await mkdtemp(join(tmpdir(), "e2e-observations-"));
const journal = await ObservationJournal.open(dir);
const sample = (community, atMs, price) => journal.append({
  schema: "market-observation-v1", namespace: NS, battleId: "2", roundId: "1", community, mode: "PriceGain", policyHash: POLICY, mappingVersion: "1",
  asset: { chainId: "46630", token: addr(community + 1) }, reference: null, source: { name: "e2e-fixture", kind: "fixture", pool: null, quote: "USD" },
  inputs: { kind: "price", price: String(price), priceScale: 8 }, evidenceHash: `e2e-${community}-${atMs}`, observedAtMs: String(atMs), acquiredAtMs: String(NOW),
});
await sample(0, START_MS, 30000000); await sample(0, END_MS, 33000000);
await sample(1, START_MS, 20000000); await sample(1, END_MS, 19000000);
await sample(2, START_MS, 10000000); // no closing sample: a visible gap

const cap = (reason) => ({ enabled: true, reasons: [reason] });
const manifest = [{
  deploymentId: NS.deploymentId, network: NS.network, arenaContract: ARENA, protocol: NS.protocol, adapter: "fixture",
  companions: { payout: "payout.testnet", registry: ARENA, backing: [] }, abi: { version: "lifecycle-application-v1", evidence: "browser test fixture", codeHash: null },
  capabilities: { battles: cap("fixture"), detail: cap("fixture"), assets: cap("fixture"), audits: cap("fixture"), observations: cap("fixture"), custody: cap("fixture") },
}];
const source = new FixtureArenaReadSource("near-testnet", { battles, rounds });
// Real mock-token addresses from the deploy evidence, so the curated display labels resolve in the browser tests.
const MOCKS = JSON.parse(readFileSync(new URL("../../docs/evidence/2026-11-09-evm-testnet-deploy.json", import.meta.url), "utf8")).mockTokens;
const mock = (symbol) => MOCKS.find((t) => t.symbol === symbol);
const registry = staticReferenceRegistry([
  { chainId: "46630", token: addr(1), referenceChainId: "4663", referenceToken: addr("b") },
  { chainId: "46630", token: addr(2), referenceChainId: "4663", referenceToken: addr("c") },
  { chainId: "46630", token: addr(3), referenceChainId: "4663", referenceToken: addr("d") },
  { chainId: "46630", token: mock("mCASHCAT").address.toLowerCase(), referenceChainId: "4663", referenceToken: mock("mCASHCAT").referenceMainnetToken.toLowerCase() },
  { chainId: "46630", token: mock("mWALLET").address.toLowerCase(), referenceChainId: "4663", referenceToken: mock("mWALLET").referenceMainnetToken.toLowerCase() },
]);
const application = new ApplicationReads(manifest, new Map([[NS.deploymentId, {
  source, versioned: new VersionedLifecycleReadSource(ARENA, view), registry,
  observations: { namespace: NS, load: async () => (await loadObservationState(dir)).state, qualifiedModes: new Set(["PriceGain"]), coveragePolicy: { boundaryToleranceMs: 1000, maxGapMs: 40000 } },
}]]));
const sessions = new ReadSessions({ secret: new Uint8Array(32).fill(7), recipient: "valtrum-read.e2e", verify: async () => false });
// FIXTURE state: backing c1 reports a ledger needing reconciliation, so the page shows a visible recovery alert.
const state = new FixtureStateSource("near-testnet", { ledgers: new Map([["c1.rep.testnet", { accounting_balanced: false, reconciliation_required: true }]]) });
startReadServer(PORT, "127.0.0.1", { arena: source, state, sessions, now: Date.now, application });
console.log(`fixture read API listening on 127.0.0.1:${PORT}`);
