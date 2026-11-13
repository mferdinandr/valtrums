// FIXTURE-ONLY: fake arena state machine + temp-directory journal. No chain, provider or funds.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSubmission } from "../../src/lifecycle-oracle/evidence.js";
import { loadOracleConfig, type OracleConfig, type ObservationTerms } from "../../src/lifecycle-oracle/config.js";
import { LifecycleOracle, OPEN_LEAD_MS } from "../../src/lifecycle-oracle/driver.js";
import { OracleLockedError, OracleStateDir, loadOracleStatus } from "../../src/lifecycle-oracle/status.js";
import { ObservationJournal, loadObservationState } from "../../src/observations/journal.js";
import type { FrozenRound } from "../../src/observations/query.js";
import { NS, POLICY, START_MS, price } from "../observations/fixtures.js";
import { FakeArena } from "./fake-arena.js";

const TERMS: ObservationTerms = { source: "fixture-dex", quote_currency: "USD", eligible_pools: ["pool-1"], finality: "block", price_decimals: 8, supply_decimals: 8, volume_decimals: 8, boundary_tolerance_ns: "1000000000", max_gap_ns: "40000000000" };
let dir: string;
let journal: ObservationJournal;
let nowMs = Number(START_MS);
let arena: FakeArena;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "oracle-")); journal = await ObservationJournal.open(join(dir, "journal")); nowMs = Number(START_MS); arena = new FakeArena(() => nowMs); });
afterEach(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });

const cfg = (over: Partial<OracleConfig> = {}): OracleConfig => ({
  network: "testnet", rpcUrl: "https://rpc.example", arenaContractId: "arena.testnet", accountId: "oracle.testnet", privateKey: "ed25519:fixture",
  writesEnabled: true, intervalSecs: 5, stateDir: join(dir, "state"), journalDir: join(dir, "journal"), scope: { ...NS },
  terms: new Map([[POLICY, TERMS]]), evidenceKinds: new Set(["fixture"] as const), qualifiedModes: new Set(["PriceGain", "LowestDrawdown"] as const),
  roundsStorageDepositYocto: "10000000000000000000000", ...over,
});
const oracle = (c = cfg(), a = arena) => new LifecycleOracle(c, { views: a.views, tx: { call: a.call }, now: () => nowMs, loadEvidence: async () => (await loadObservationState(join(dir, "journal"))).state });
async function sample(community: number, roundId: string, atMs: number, value: string, over: Parameters<typeof price>[3] = {}) {
  await journal.append(price(community, BigInt(atMs), value, { roundId, ...over }));
}
const methods = () => arena.calls.map((c) => c.method);
const winnerOf = (id = "1") => arena.battles.get(id)?.round?.winner;

describe("round lifecycle", () => {
  it("starts rounds, opens, waits for the recorded end, then resolves from persisted evidence", async () => {
    arena.lockedBattle("1");
    const o = oracle();
    // One visit starts the rounds and, once the chain shows them, opens the first window straight away.
    await o.pass();
    expect(methods()).toEqual(["start_lifecycle_rounds", "open_lifecycle_round"]);
    // An explicit unit: near-kit refuses a bare integer amount as ambiguous (found in the 2026-11-11 live run).
    expect(arena.calls[0]).toMatchObject({ args: { battle_id: "1", terms: TERMS }, deposit: "10000000000000000000000 yocto" });
    // The window starts a little ahead of the send time, when the transaction is expected to land.
    expect(arena.calls[1]?.args.start_ns).toBe((BigInt(nowMs + OPEN_LEAD_MS) * 1_000_000n).toString());
    // Inside the window the clock alone does nothing.
    nowMs += 10_000;
    await o.pass();
    expect(methods()).toHaveLength(2);
    expect(o.status().battles["1"]?.phase).toBe("window_open");
    // Collect evidence, pass the recorded end.
    // The window opened OPEN_LEAD_MS after the send time.
    const windowStart = Number(START_MS) + OPEN_LEAD_MS;
    for (const [c, a, b] of [[0, "300", "330"], [1, "300", "310"], [2, "300", "300"]] as const) { await sample(c, "1", windowStart, a); await sample(c, "1", windowStart + 30_000, b); }
    nowMs = windowStart + 30_500;
    await o.pass();
    expect(methods().at(-1)).toBe("submit_lifecycle_observations");
    expect(winnerOf()).toBe(0);
    const submitted = arena.calls.at(-1)!.args.observations as Array<{ community: number; observed_times_ns: string[]; evidence_hash: string }>;
    expect(submitted.map((s) => s.community)).toEqual([0, 1, 2]);
    expect(submitted[0]?.observed_times_ns).toEqual([(BigInt(windowStart) * 1_000_000n).toString(), (BigInt(windowStart + 30_000) * 1_000_000n).toString()]);
    expect(submitted[0]?.evidence_hash).toMatch(/^obs:[0-9a-f]{64}$/);
    // After a recorded winner nothing more is sent, and the status says so.
    const before = arena.calls.length;
    await o.pass(); await o.pass();
    expect(arena.calls).toHaveLength(before);
    expect(o.status().battles["1"]).toMatchObject({ phase: "done" });
  });

  it("with a batch transport, reveals the terms and opens round 1 in one transaction", async () => {
    arena.lockedBattle("1");
    const o = new LifecycleOracle(cfg(), { views: arena.views, tx: { call: arena.call, batch: arena.batch }, now: () => nowMs, loadEvidence: async () => (await loadObservationState(join(dir, "journal"))).state });
    await o.pass();
    expect(arena.batches).toEqual([["start_lifecycle_rounds", "open_lifecycle_round"]]);
    expect(methods()).toEqual(["start_lifecycle_rounds", "open_lifecycle_round"]);
    expect(arena.calls[0]).toMatchObject({ args: { battle_id: "1", terms: TERMS }, deposit: "10000000000000000000000 yocto" });
    expect(arena.calls[1]).toMatchObject({ args: { battle_id: "1", round_id: "1", start_ns: (BigInt(nowMs + OPEN_LEAD_MS) * 1_000_000n).toString() }, deposit: "1 yocto" });
    expect(arena.battles.get("1")?.round?.start).toBe(BigInt(nowMs + OPEN_LEAD_MS) * 1_000_000n);
    expect(o.status().battles["1"]).toMatchObject({ phase: "needs_open", roundId: "1" });
    // The window is open: nothing more is sent.
    nowMs += 10_000;
    await o.pass();
    expect(arena.calls).toHaveLength(2);
    expect(o.status().battles["1"]?.phase).toBe("window_open");
  });

  it("a failed combined send changes nothing on chain and falls back to the separate transactions", async () => {
    arena.lockedBattle("1");
    arena.failBatchOnce = true;
    const o = new LifecycleOracle(cfg(), { views: arena.views, tx: { call: arena.call, batch: arena.batch }, now: () => nowMs, loadEvidence: async () => (await loadObservationState(join(dir, "journal"))).state });
    await o.pass();
    expect(arena.battles.get("1")?.round ?? null).toBeNull();
    expect(o.status().battles["1"]).toMatchObject({ phase: "needs_rounds_started" });
    await o.pass();
    // One batch only; the retry used two separate calls, which opened the window.
    expect(arena.batches).toHaveLength(1);
    expect(methods().slice(2)).toEqual(["start_lifecycle_rounds", "open_lifecycle_round"]);
    expect(arena.battles.get("1")?.round?.start).not.toBeNull();
  });

  it("sends no combined transaction in dry run", async () => {
    arena.lockedBattle("1");
    const o = new LifecycleOracle(cfg({ writesEnabled: false }), { views: arena.views, tx: { call: arena.call, batch: arena.batch }, now: () => nowMs, loadEvidence: async () => (await loadObservationState(join(dir, "journal"))).state });
    await o.pass();
    expect(arena.batches).toEqual([]);
    expect(o.status().battles["1"]?.actions.map((a) => a.executed)).toEqual([false, false]);
  });

  it("never resolves from the clock: missing or gapped evidence holds pending and submits nothing", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    const o = oracle();
    nowMs = Number(START_MS) + 120_000; // past the end, still inside the reopen grace
    await o.pass();
    expect(o.status().battles["1"]).toMatchObject({ phase: "pending_evidence" });
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/no_allowed_evidence/);
    // A missing close for one community still holds every community.
    for (const c of [0, 1, 2]) await sample(c, "1", Number(START_MS), "300");
    for (const c of [0, 1]) await sample(c, "1", Number(START_MS) + 30_000, "310");
    await o.pass();
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/coverage_incomplete: community 2: no closing sample/);
    expect(methods()).toEqual([]);
    expect(winnerOf()).toBeNull();
  });

  it("abandons a window whose evidence never completed once the reopen grace has passed, and never picks a winner", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    for (const c of [0, 1, 2]) await sample(c, "1", Number(START_MS) + 30_000, "310"); // closing samples only: the start was missed
    const o = oracle();
    nowMs = Number(START_MS) + 30_000 + 129_000; // 1 s before the oracle's margin
    await o.pass();
    expect(methods()).toEqual([]);
    nowMs = Number(START_MS) + 30_000 + 131_000;
    await o.pass();
    expect(methods()).toEqual(["reopen_lifecycle_round"]);
    expect(arena.calls[0]).toMatchObject({ args: { battle_id: "1", round_id: "1" }, deposit: "1 yocto" });
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/coverage_incomplete/);
    expect(winnerOf()).toBeNull();
  });

  it("a late submission uses the original interval's evidence, not a new current price", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    for (const [c, a, b] of [[0, "300", "310"], [1, "300", "330"], [2, "300", "300"]] as const) { await sample(c, "1", Number(START_MS), a); await sample(c, "1", Number(START_MS) + 30_000, b); }
    for (const c of [0, 1, 2]) await sample(c, "1", Number(START_MS) + 900_000, "999"); // a later price must be ignored
    nowMs = Number(START_MS) + 900_000;
    await oracle().pass();
    expect(winnerOf()).toBe(1);
  });

  it("opens a fresh window for tied leaders only, and the next round uses only its own evidence", async () => {
    arena.lockedBattle("1");
    const o = oracle();
    await o.pass(); await o.pass();
    const firstStart = Number(START_MS) + OPEN_LEAD_MS;
    for (const [c, a, b] of [[0, "100", "110"], [1, "200", "220"], [2, "300", "300"]] as const) { await sample(c, "1", firstStart, a); await sample(c, "1", firstStart + 30_000, b); }
    nowMs = firstStart + 31_000;
    await o.pass(); // 0 and 1 tie exactly (10/100 = 20/200): overtime
    expect(arena.battles.get("1")?.round).toMatchObject({ id: 2, candidates: [0, 1], start: null, winner: null });
    await o.pass();
    const open = arena.calls.at(-1)!;
    expect(open).toMatchObject({ method: "open_lifecycle_round", args: { round_id: "2" } });
    const start2 = nowMs + OPEN_LEAD_MS;
    for (const [c, a, b] of [[0, "110", "121"], [1, "220", "231"]] as const) { await sample(c, "2", start2, a); await sample(c, "2", start2 + 30_000, b); }
    nowMs = start2 + 31_000;
    await o.pass();
    expect(winnerOf()).toBe(0); // 11/110 beats 11/220
    const submitted = arena.calls.at(-1)!.args.observations as Array<{ community: number }>;
    expect(submitted.map((s) => s.community)).toEqual([0, 1]); // the eliminated community is not resubmitted
  });
});

describe("restart and double execution", () => {
  it("a fresh process does not repeat a write the chain already shows as done", async () => {
    arena.lockedBattle("1");
    await oracle().pass(); await oracle().pass();
    const after = arena.calls.length;
    const restarted = oracle(); // new instance, no memory
    await restarted.pass();
    expect(arena.calls).toHaveLength(after); // rounds started and open: still waiting for the end
    expect(restarted.status().battles["1"]?.phase).toBe("window_open");
  });

  it("a lost submit response is not resubmitted once the chain shows the winner", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    for (const [c, a, b] of [[0, "100", "150"], [1, "100", "110"], [2, "100", "100"]] as const) { await sample(c, "1", Number(START_MS), a); await sample(c, "1", Number(START_MS) + 30_000, b); }
    nowMs = Number(START_MS) + 31_000;
    arena.loseResponseOnce = true;
    const o = oracle();
    await o.pass();
    expect(o.status().battles["1"]?.actions[0]?.outcome).toMatch(/failed or unconfirmed/);
    const sent = arena.calls.length;
    await o.pass();
    expect(arena.calls).toHaveLength(sent);
    expect(winnerOf()).toBe(0);
  });

  it("retries a submit that never landed, and two executions cannot create two winners", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    for (const [c, a, b] of [[0, "100", "150"], [1, "100", "110"], [2, "100", "100"]] as const) { await sample(c, "1", Number(START_MS), a); await sample(c, "1", Number(START_MS) + 30_000, b); }
    nowMs = Number(START_MS) + 31_000;
    arena.failBeforeApplyOnce = true;
    const a = oracle(); const b = oracle();
    await a.pass();
    expect(winnerOf()).toBeNull();
    await b.pass(); await a.pass();
    expect(winnerOf()).toBe(0);
    expect(arena.calls.filter((c) => c.method === "submit_lifecycle_observations").length).toBeLessThanOrEqual(3);
  });
});

describe("identity and write gates", () => {
  it("sends nothing in dry-run mode and says what it would do", async () => {
    arena.lockedBattle("1");
    const o = oracle(cfg({ writesEnabled: false }));
    await o.pass();
    expect(arena.calls).toEqual([]);
    expect(o.status().battles["1"]?.actions[0]).toMatchObject({ action: "start_lifecycle_rounds", executed: false });
    expect(o.status().writesEnabled).toBe(false);
  });

  it("does not spend a storage deposit unless one is configured", async () => {
    arena.lockedBattle("1");
    const o = oracle(cfg({ roundsStorageDepositYocto: null }));
    await o.pass();
    expect(arena.calls).toEqual([]);
    expect(o.status().battles["1"]).toMatchObject({ phase: "needs_rounds_started" });
  });

  it("holds when it is not the arena's oracle, the arena is paused, lifecycle is inactive, or terms are missing", async () => {
    arena.lockedBattle("1");
    arena.oracle = "someone-else.testnet";
    const o = oracle();
    await o.pass();
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/oracle is someone-else\.testnet/);
    arena.oracle = "oracle.testnet"; arena.paused = true;
    await o.pass();
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/paused/);
    arena.paused = false; arena.activated = false;
    await o.pass();
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/not activated/);
    arena.activated = true;
    await oracle(cfg({ terms: new Map() })).pass();
    expect(arena.calls).toEqual([]);
  });

  it("skips unlocked battles and battles whose frozen policy hash is absent", async () => {
    arena.lockedBattle("1", { locked: false });
    arena.lockedBattle("2", { policyHash: null });
    const o = oracle();
    await o.pass();
    expect(arena.calls).toEqual([]);
    expect(o.status().battles["1"]?.phase).toBe("not_locked");
    expect(o.status().battles["2"]?.phase).toBe("blocked");
  });

  it("refuses evidence of a disallowed kind, so scripted samples cannot resolve a live deployment", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    for (const c of [0, 1, 2]) { await sample(c, "1", Number(START_MS), "100"); await sample(c, "1", Number(START_MS) + 30_000, "110"); }
    nowMs = Number(START_MS) + 31_000;
    const o = oracle(cfg({ evidenceKinds: new Set(["live"] as const) }));
    await o.pass();
    expect(arena.calls).toEqual([]);
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/no_allowed_evidence: community 0: no persisted live samples/);
  });
});

describe("evidence builder", () => {
  const frozen = (over: Partial<FrozenRound> = {}): FrozenRound => ({ namespace: { ...NS }, battleId: "1", roundId: "1", mode: "PriceGain", policyHash: POLICY, candidates: [0, 1],
    startNs: (START_MS * 1_000_000n).toString(), endNs: ((START_MS + 30_000n) * 1_000_000n).toString(), boundaryToleranceMs: 1000, maxGapMs: 40_000, ...over });
  const opts = { kinds: new Set(["fixture"] as const), qualified: new Set(["PriceGain", "LowestDrawdown"] as const) };

  it("refuses market-cap and volume modes live and an unqualified mode", async () => {
    const { state } = await (async () => ({ state: journal.state }))();
    expect(buildSubmission(state, frozen({ mode: "MarketCapGrowth" }), TERMS, opts)).toMatchObject({ ok: false, hold: "mode_unsupported" });
    expect(buildSubmission(state, frozen({ mode: "VolumeRatio" }), TERMS, opts)).toMatchObject({ ok: false, hold: "mode_unsupported" });
    expect(buildSubmission(state, frozen(), TERMS, { ...opts, qualified: new Set() })).toMatchObject({ ok: false, hold: "mode_unqualified" });
  });

  it("never rescales a price: a sample at another scale holds", async () => {
    for (const c of [0, 1]) { await journal.append({ ...price(c, START_MS, "100"), inputs: { kind: "price", price: "100", priceScale: 6 } }); }
    expect(buildSubmission(journal.state, frozen(), TERMS, opts)).toMatchObject({ ok: false, hold: "scale_mismatch" });
  });

  it("builds drawdown only from complete coverage with strictly increasing times", async () => {
    const dd = (c: number, t: bigint, v: string) => journal.append(price(c, t, v, { mode: "LowestDrawdown" }));
    for (const c of [0, 1]) for (const [t, v] of [[0n, "100"], [10_000n, "90"], [20_000n, "100"], [30_000n, "100"]] as const) await dd(c, START_MS + t, v);
    const built = buildSubmission(journal.state, frozen({ mode: "LowestDrawdown" }), TERMS, opts);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.observations[0]?.data).toEqual({ Drawdown: { prices: ["100", "90", "100", "100"] } });
    expect(buildSubmission(journal.state, frozen({ mode: "LowestDrawdown", maxGapMs: 5_000 }), TERMS, opts)).toMatchObject({ ok: false, hold: "coverage_incomplete" });
  });

  it("ignores retracted samples", async () => {
    const a = await journal.append(price(0, START_MS, "100"));
    await journal.append(price(0, START_MS + 30_000n, "110"));
    await journal.append(price(1, START_MS, "100")); await journal.append(price(1, START_MS + 30_000n, "110"));
    expect(buildSubmission(journal.state, frozen(), TERMS, opts).ok).toBe(true);
    await journal.retract({ namespace: { ...NS }, observationId: a.id, reason: "reorg", acquiredAtMs: "1" });
    expect(buildSubmission(journal.state, frozen(), TERMS, opts)).toMatchObject({ ok: false, hold: "coverage_incomplete" });
  });
});

describe("status, isolation and recovery", () => {
  it("isolates a failing battle, backs it off, and keeps serving the others", async () => {
    arena.lockedBattle("1"); arena.lockedBattle("2");
    arena.failViewsFor.add("2");
    const o = oracle();
    const first = await o.pass();
    expect(first).toMatchObject({ errors: 1 });
    expect(o.status().battles["1"]?.phase).toBe("needs_open"); // started and opened in the same visit
    expect(o.status().battles["2"]).toMatchObject({ phase: "error", lastError: "view failed" });
    arena.failViewsFor.clear();
    const second = await o.pass(); // battle 2 is still backing off
    expect(second.checked).toBe(1);
    await o.pass();
    expect(o.status().battles["2"]?.phase).not.toBe("error");
  });

  it("reports a missing journal as pending evidence, not as an empty result", async () => {
    arena.lockedBattle("1", { round: { id: 1, candidates: [0, 1, 2], start: BigInt(START_MS) * 1_000_000n, end: (BigInt(START_MS) + 30_000n) * 1_000_000n, winner: null } });
    nowMs = Number(START_MS) + 31_000;
    const o = new LifecycleOracle(cfg(), { views: arena.views, tx: { call: arena.call }, now: () => nowMs, loadEvidence: async () => { throw new Error("ENOENT"); } });
    await o.pass();
    expect(o.status().battles["1"]?.phase).toBe("pending_evidence");
    expect(o.status().battles["1"]?.reasons[0]).toMatch(/observation journal unavailable/);
    expect(arena.calls).toEqual([]);
  });

  it("records an unreadable chain as a pass error and persists status with a single-process lock", async () => {
    const state = await OracleStateDir.open(join(dir, "state"));
    await expect(OracleStateDir.open(join(dir, "state"))).rejects.toBeInstanceOf(OracleLockedError);
    const broken = { ...arena.views, count: async () => { throw new Error("rpc down"); } };
    const o = new LifecycleOracle(cfg(), { views: broken, tx: { call: arena.call }, state, now: () => nowMs, loadEvidence: async () => journal.state });
    expect((await o.pass()).passError).toMatch(/rpc down/);
    const saved = await loadOracleStatus(join(dir, "state"));
    expect(saved).toMatchObject({ schema: "lifecycle-oracle-status-v1", passError: expect.stringMatching(/rpc down/), writesEnabled: true });
    expect(JSON.stringify(saved)).not.toContain("ed25519");
    await state.close();
    await (await OracleStateDir.open(join(dir, "state"))).close();
  });
});

describe("process config", () => {
  const base = { ORACLE_ACCOUNT_ID: "oracle.testnet", ORACLE_PRIVATE_KEY: "ed25519:fixture", ARENA_CONTRACT_ID: "arena.testnet", ORACLE_STATE_DIR: "/s", OBSERVATION_JOURNAL_DIR: "/j",
    ARENA_APPLICATION_OBSERVATION_SCOPE: JSON.stringify(NS) };
  it("defaults to dry run, live-only evidence and no qualified mode", () => {
    const c = loadOracleConfig(base);
    expect(c).toMatchObject({ writesEnabled: false, intervalSecs: 5, roundsStorageDepositYocto: null });
    expect([...c.evidenceKinds]).toEqual(["live"]);
    expect(c.qualifiedModes.size).toBe(0);
  });
  it("refuses another role's credentials, bad settings and sandbox evidence on mainnet, without echoing values", () => {
    for (const extra of [{ AGENT_PRIVATE_KEY: "ed25519:agent-secret" }, { PAYOUT_OPERATOR_PRIVATE_KEY_FILE: "/x" }, { PAYOUT_RELAYER_PRIVATE_KEY: "ed25519:r" }]) {
      let message = "";
      try { loadOracleConfig({ ...base, ...extra }); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/must not be set in the lifecycle oracle process/);
      expect(message).not.toMatch(/secret/);
    }
    expect(() => loadOracleConfig({ ...base, ORACLE_WRITES_ENABLED: "yes" })).toThrow(/true.*false/);
    expect(() => loadOracleConfig({ ...base, ORACLE_INTERVAL_SECS: "30" })).toThrow(/1 to 20/);
    expect(() => loadOracleConfig({ ...base, ORACLE_PRIVATE_KEY: "nope" })).toThrow(/ed25519/);
    expect(() => loadOracleConfig({ ...base, OBSERVATION_QUALIFIED_MODES: "VolumeRatio" })).toThrow(/cannot enable VolumeRatio/);
    expect(() => loadOracleConfig({ ...base, NEAR_NETWORK: "mainnet", ORACLE_EVIDENCE_KINDS: "fixture", ARENA_APPLICATION_OBSERVATION_SCOPE: JSON.stringify({ ...NS, network: "near-mainnet" }) })).toThrow(/mainnet/);
    expect(() => loadOracleConfig({ ...base, ARENA_CONTRACT_ID: "other.testnet" })).toThrow(/another arena/);
  });
  it("loads terms keyed by frozen policy hash and rejects malformed terms", () => {
    const files: Record<string, string> = { "/t.json": JSON.stringify({ [POLICY]: TERMS }), "/bad.json": JSON.stringify({ [POLICY]: { source: "x" } }) };
    const read = (p: string) => files[p] ?? (() => { throw new Error("ENOENT"); })();
    expect(loadOracleConfig({ ...base, ORACLE_TERMS_PATH: "/t.json" }, read).terms.get(POLICY)).toEqual(TERMS);
    expect(() => loadOracleConfig({ ...base, ORACLE_TERMS_PATH: "/bad.json" }, read)).toThrow(/observation terms/);
    expect(() => loadOracleConfig({ ...base, ORACLE_TERMS_PATH: "/missing.json" }, read)).toThrow(/readable JSON/);
  });
});
