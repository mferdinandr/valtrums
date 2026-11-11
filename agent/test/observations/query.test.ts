// FIXTURE-ONLY: in-memory journals over synthetic observations; no provider, contract or network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObservationJournal } from "../../src/observations/journal.js";
import { ObservationQueryError, projectedBoundaries, provisionalProjection, queryObservations, readerOver, roundCoverage } from "../../src/observations/query.js";
import { NS, START_MS, END_MS, frozen, price } from "./fixtures.js";

let dir: string;
let j: ObservationJournal;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "obs-query-")); j = await ObservationJournal.open(dir); });
afterEach(async () => { await j.close(); await rm(dir, { recursive: true, force: true }); });

const qualified = new Set(["PriceGain", "LowestDrawdown"] as const);

async function fill(c: number, points: Array<[bigint, string]>) {
  for (const [t, v] of points) await j.append(price(c, t, v));
}

describe("bounded queries", () => {
  it("pages by cursor within the namespace, round and community, and bounds the limit", async () => {
    await fill(0, [[START_MS, "100"], [START_MS + 10_000n, "110"], [END_MS, "120"]]);
    await j.append(price(0, START_MS, "5", { namespace: { ...NS, deploymentId: "other" } }));
    await j.append(price(1, START_MS, "7", { roundId: "2" }));
    const first = queryObservations(j.state, { namespace: NS, battleId: "1", roundId: "1", community: 0, limit: 2 });
    expect(first.items.map((i) => i.observation.inputs)).toMatchObject([{ price: "100" }, { price: "110" }]);
    expect(first.truncated).toBe(true);
    const next = queryObservations(j.state, { namespace: NS, battleId: "1", roundId: "1", community: 0, limit: 2, afterSeq: Number(first.nextCursor) });
    expect(next.items.map((i) => i.observation.inputs)).toMatchObject([{ price: "120" }]);
    expect(next.nextCursor).toBeNull();
    expect(first.watermark).toEqual(j.state.head);
    expect(() => queryObservations(j.state, { namespace: NS, battleId: "1", limit: 201 })).toThrow(ObservationQueryError);
    expect(() => queryObservations(j.state, { namespace: NS, battleId: "x" })).toThrow(ObservationQueryError);
    expect(() => queryObservations(j.state, { namespace: NS, battleId: "1", community: 16 })).toThrow(ObservationQueryError);
  });

  it("excludes unknown provider times from a time window and keeps acquisition time separate", async () => {
    await j.append(price(0, START_MS, "100"));
    await j.append(price(0, null, "101", { acquiredAtMs: "424242" }));
    const all = queryObservations(j.state, { namespace: NS, battleId: "1" });
    expect(all.items).toHaveLength(2);
    expect(all.items[1]?.observation).toMatchObject({ observedAtMs: null, acquiredAtMs: "424242" });
    const windowed = queryObservations(j.state, { namespace: NS, battleId: "1", observedFromMs: "0", observedToMs: "99999999999" });
    expect(windowed.items).toHaveLength(1);
  });

  it("drops retracted evidence, reports it to a delta poller and bumps the revision", async () => {
    const a = await j.append(price(0, START_MS, "100"));
    await j.append(price(0, START_MS + 1000n, "101"));
    const before = queryObservations(j.state, { namespace: NS, battleId: "1" });
    await j.retract({ namespace: { ...NS }, observationId: a.id, reason: "reorg", acquiredAtMs: "9" });
    const after = queryObservations(j.state, { namespace: NS, battleId: "1", afterSeq: before.watermark.seq });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.retractedSinceCursor).toEqual([a.id]);
    expect(queryObservations(j.state, { namespace: NS, battleId: "1" }).items).toHaveLength(1);
  });
});

describe("coverage", () => {
  it("shows a missing close, gaps and unknown-time samples without filling them", async () => {
    await fill(0, [[START_MS, "100"], [START_MS + 10_000n, "105"]]); // no close sample
    await j.append(price(0, null, "999"));
    await fill(1, [[START_MS, "100"], [END_MS, "110"]]); // boundaries only: a 30s gap
    const cov = roundCoverage(j.state, frozen());
    const c0 = cov.communities[0]!;
    expect(c0).toMatchObject({ samples: 3, unknownTime: 1, hasStart: true, hasEnd: false, complete: false });
    expect(c0.gaps.at(-1)).toEqual({ fromMs: (START_MS + 10_000n).toString(), toMs: END_MS.toString() });
    expect(cov.communities[1]).toMatchObject({ hasStart: true, hasEnd: true, complete: false });
    expect(cov.communities[1]?.gaps).toHaveLength(1);
  });

  it("counts samples of another mode, policy or unlisted community as foreign, not as evidence", async () => {
    await fill(0, [[START_MS, "100"]]);
    await j.append(price(1, START_MS, "100", { policyHash: "other-policy" }));
    await j.append(price(5, START_MS, "100"));
    expect(roundCoverage(j.state, frozen()).foreign).toBe(2);
  });
});

describe("provisional exact scores", () => {
  it("selects the nearest permitted boundary with the same sequence tie-break as the oracle", async () => {
    await j.append(price(0, START_MS - 2_000n, "90"));
    const start = await j.append(price(0, START_MS - 1_000n, "100"));
    await j.append(price(0, START_MS + 1_000n, "101"));
    const end = await j.append(price(0, END_MS + 1_000n, "110"));
    expect(projectedBoundaries(j.state, frozen()).find((b) => b.community === 0)).toEqual({
      community: 0,
      start: { id: start.id, observedAtMs: (START_MS - 1_000n).toString() },
      end: { id: end.id, observedAtMs: (END_MS + 1_000n).toString() },
    });
  });
  it("computes exact signed rationals and separates provisional leaders from results", async () => {
    await fill(0, [[START_MS, "300"], [START_MS + 15_000n, "310"], [END_MS, "310"]]); // +10/300
    await fill(1, [[START_MS, "200"], [START_MS + 15_000n, "190"], [END_MS, "190"]]); // -10/200
    const p = provisionalProjection(j.state, frozen(), qualified);
    expect(p).toMatchObject({ status: "provisional", authoritative: false, provisionalLeaders: [0] });
    expect(p.scores).toEqual([
      { community: 0, negative: false, numerator: "10", denominator: "300" },
      { community: 1, negative: true, numerator: "10", denominator: "200" },
    ]);
  });

  it("does not round exact rationals into a tie", async () => {
    await fill(0, [[START_MS, "30000000"], [END_MS, "30000001"]]);
    await fill(1, [[START_MS, "20000000"], [END_MS, "20000001"]]);
    const p = provisionalProjection(j.state, frozen({ maxGapMs: 40_000 }), qualified);
    expect(p.provisionalLeaders).toEqual([1]); // 1/20000000 > 1/30000000, a rounded label would show both as 0.00%
  });

  it("lists every leader of a true exact tie and never creates an overtime", async () => {
    await fill(0, [[START_MS, "100"], [END_MS, "110"]]);
    await fill(1, [[START_MS, "200"], [END_MS, "220"]]);
    const p = provisionalProjection(j.state, frozen({ maxGapMs: 40_000 }), qualified);
    expect(p.provisionalLeaders).toEqual([0, 1]);
    expect(p.authoritative).toBe(false);
  });

  it("is incomplete, with no scores or leader, when the close sample is missing", async () => {
    await fill(0, [[START_MS, "100"]]);
    await fill(1, [[START_MS, "100"], [END_MS, "120"]]);
    const p = provisionalProjection(j.state, frozen({ maxGapMs: 40_000 }), qualified);
    expect(p.status).toBe("incomplete");
    expect(p.provisionalLeaders).toEqual([]);
    expect(p.scores[0]).toBeNull();
    expect(p.reasons.join(" ")).toMatch(/community 0: missing start or end sample/);
  });

  it("never treats a sample without provider time as a boundary", async () => {
    await j.append(price(0, null, "100"));
    await j.append(price(0, null, "110"));
    await fill(1, [[START_MS, "100"], [END_MS, "110"]]);
    const p = provisionalProjection(j.state, frozen({ maxGapMs: 40_000 }), qualified);
    expect(p.status).toBe("incomplete");
    expect(p.scores[0]).toBeNull();
  });

  it("stays unavailable for an unqualified mode and for market-cap / volume modes", async () => {
    await fill(0, [[START_MS, "100"], [END_MS, "110"]]);
    expect(provisionalProjection(j.state, frozen(), new Set()).status).toBe("unavailable");
    const cap = provisionalProjection(j.state, frozen({ mode: "MarketCapGrowth" }), new Set(["MarketCapGrowth"] as const));
    expect(cap.status).toBe("unavailable");
    expect(cap.reasons.join(" ")).toMatch(/supply or interval-trade/);
    expect(provisionalProjection(j.state, frozen({ mode: "VolumeRatio" }), new Set(["VolumeRatio"] as const)).status).toBe("unavailable");
  });

  it("computes exact maximum drawdown only with complete coverage and ranks the lowest first", async () => {
    const drawdown = (c: number, pts: Array<[bigint, string]>) => Promise.all(pts.map(([t, v]) => j.append(price(c, t, v, { mode: "LowestDrawdown" }))));
    await drawdown(0, [[START_MS, "100"], [START_MS + 10_000n, "80"], [START_MS + 20_000n, "100"], [END_MS, "100"]]); // 20/100
    await drawdown(1, [[START_MS, "100"], [START_MS + 10_000n, "95"], [START_MS + 20_000n, "100"], [END_MS, "100"]]); // 5/100
    const round = frozen({ mode: "LowestDrawdown" });
    const p = provisionalProjection(j.state, round, qualified);
    expect(p).toMatchObject({ status: "provisional", provisionalLeaders: [1] });
    expect(p.scores[0]).toEqual({ community: 0, negative: false, numerator: "20", denominator: "100" });
    // A coverage gap yields no zero-drawdown score.
    const gappy = frozen({ mode: "LowestDrawdown", maxGapMs: 5_000 });
    expect(provisionalProjection(j.state, gappy, qualified).status).toBe("incomplete");
  });

  it("the reader interface reads only persisted, effective evidence", async () => {
    const a = await j.append(price(0, START_MS, "100"));
    const reader = readerOver(() => j.state);
    expect(reader.query({ namespace: NS, battleId: "1" }).items).toHaveLength(1);
    await j.retract({ namespace: { ...NS }, observationId: a.id, reason: "reorg", acquiredAtMs: "1" });
    expect(reader.query({ namespace: NS, battleId: "1" }).items).toHaveLength(0);
    expect(reader.coverage(frozen()).revision).toBe(1);
  });
});
