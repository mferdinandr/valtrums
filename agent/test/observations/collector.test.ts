// FIXTURE-ONLY: recorded samples into a temp-directory journal. No provider, contract or network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObservationCollector, RecordedSampleSource, liveSourceUnavailable, normalizeIdentity, type CollectRound, type RawSample, type SampleSource } from "../../src/observations/collector.js";
import { ObservationJournal, loadObservationState } from "../../src/observations/journal.js";
import { provisionalProjection } from "../../src/observations/query.js";
import type { Mode } from "../../src/observations/schema.js";
import { NS, POLICY, START_MS, END_MS, START_NS, END_NS } from "./fixtures.js";

const A = { chainId: "46630", token: `0x${"AA".repeat(20)}` };
const REF = { chainId: "4663", token: `0x${"BB".repeat(20)}` };
const round = (over: Partial<CollectRound> = {}): CollectRound => ({
  namespace: { ...NS }, battleId: "1", roundId: "1", mode: "PriceGain", policyHash: POLICY, mappingVersion: "3",
  candidates: [{ community: 0, asset: A, reference: REF }, { community: 1, asset: { chainId: "46630", token: `0x${"CC".repeat(20)}` }, reference: null }],
  startNs: START_NS, endNs: END_NS, boundaryToleranceMs: 1000, ...over,
});
const sample = (community: number, at: bigint | null, price: string, id: string): RawSample => ({ community, price, priceScale: 8, observedAtMs: at === null ? null : at.toString(), evidenceHash: id, pool: "pool-1", quote: "USD" });
const modes = new Set(["PriceGain"] as const);

let dir: string;
let journal: ObservationJournal;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "obs-collector-")); journal = await ObservationJournal.open(dir); });
afterEach(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });

const collector = (source: SampleSource, qualified: ReadonlySet<Mode> = modes) => new ObservationCollector(journal, source, { now: () => 5_000_000, qualifiedModes: qualified });

describe("observation collector", () => {
  it("persists samples with identity from the frozen round, labeled with the source's own kind", async () => {
    const c = collector(new RecordedSampleSource("recorded-dex", "recorded", [sample(0, START_MS, "100", "e0"), sample(1, START_MS, "200", "e1")]));
    expect(await c.collect(round())).toMatchObject({ created: 2, duplicates: 0, rejected: [], degraded: false });
    const [first, second] = journal.state.observations.map((o) => o.observation);
    expect(first).toMatchObject({ asset: { chainId: "46630", token: `0x${"aa".repeat(20)}` }, reference: { chainId: "4663", token: `0x${"bb".repeat(20)}` }, source: { kind: "recorded", name: "recorded-dex" }, acquiredAtMs: "5000000" });
    expect(second?.reference).toBeNull(); // no mainnet mapping is invented for a community without one
  });

  it("is restart-safe: the same source records are duplicates, never a second baseline or double count", async () => {
    const source = new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "100", "e0")]);
    await collector(source).collect(round());
    await journal.close();
    journal = await ObservationJournal.open(dir);
    const again = await collector(source).collect(round());
    expect(again).toMatchObject({ created: 0, duplicates: 1 });
    expect(journal.state.observations).toHaveLength(1);
  });

  it("never takes identity from the source and refuses unknown communities and out-of-window samples", async () => {
    const forged = { ...sample(0, START_MS, "100", "e0"), asset: { chainId: "1", token: "0xdead" } } as RawSample;
    const c = collector(new RecordedSampleSource("s", "fixture", [forged, sample(7, START_MS, "100", "e7"), sample(0, END_MS + 60_000n, "100", "late")]));
    const report = await c.collect(round());
    expect(report.created).toBe(1);
    expect(journal.state.observations[0]?.observation.asset.token).toBe(`0x${"aa".repeat(20)}`);
    expect(report.rejected.map((r) => r.reason)).toEqual(["community is not a candidate of this round", "sample is outside the recorded window"]);
  });

  it("keeps a missing provider time null and rejects missing or zero prices instead of recording zero", async () => {
    const c = collector(new RecordedSampleSource("s", "fixture", [sample(0, null, "100", "e0"), sample(1, START_MS, "0", "e1"), { ...sample(1, START_MS, "5", "e2"), price: "" }]));
    const report = await c.collect(round());
    expect(report.created).toBe(1);
    expect(journal.state.observations[0]?.observation).toMatchObject({ observedAtMs: null, acquiredAtMs: "5000000" });
    expect(report.rejected).toHaveLength(2);
  });

  it("treats a source outage as a gap, reports it and writes nothing", async () => {
    const down: SampleSource = { name: "d", kind: "live", sample: async () => { throw new Error("HTTP 503"); } };
    const report = await collector(down).collect(round());
    expect(report.created).toBe(0);
    expect(report.rejected[0]?.reason).toMatch(/source unavailable/);
    expect(journal.state.head.seq).toBe(0);
  });

  it("collects nothing for an unqualified mode or a mode it cannot evidence", async () => {
    const source = new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "100", "e0")]);
    expect((await collector(source, new Set()).collect(round())).rejected[0]?.reason).toMatch(/not qualified/);
    expect((await collector(source, new Set(["VolumeRatio"] as const)).collect(round({ mode: "VolumeRatio" }))).rejected[0]?.reason).toMatch(/exact supply or interval-trade/);
    expect(journal.state.head.seq).toBe(0);
  });

  it("refuses a frozen round whose identity is not a 20-byte address instead of guessing", async () => {
    const bad = round({ candidates: [{ community: 0, asset: { chainId: "1", token: "SOL111" }, reference: null }] });
    const report = await collector(new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "100", "e0")])).collect(bad);
    expect(report.created).toBe(0);
    expect(report.rejected[0]?.reason).toMatch(/only 20-byte hex/);
    expect(() => normalizeIdentity({ chainId: "x", token: `0x${"aa".repeat(20)}` })).toThrow(/decimal/);
  });

  it("reports a journal at capacity as degraded and drops nothing silently", async () => {
    await journal.close();
    journal = await ObservationJournal.open(dir, { maxRecords: 1 });
    const c = collector(new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "100", "e0"), sample(1, START_MS, "200", "e1")]));
    const report = await c.collect(round());
    expect(report).toMatchObject({ created: 1, degraded: true });
    expect(report.rejected[0]?.reason).toMatch(/capacity/);
  });

  it("flags conflicting evidence for the same source slot as degraded and keeps the first", async () => {
    await collector(new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "100", "same")])).collect(round());
    const report = await collector(new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "999", "same")])).collect(round());
    expect(report).toMatchObject({ created: 0, degraded: true });
    expect(journal.state.observations).toHaveLength(1);
  });

  it("end to end: a persisted round projects an exact provisional score that survives a restart", async () => {
    const c = collector(new RecordedSampleSource("s", "fixture", [sample(0, START_MS, "300", "a"), sample(0, END_MS, "330", "b"), sample(1, START_MS, "200", "c"), sample(1, END_MS, "190", "d")]));
    await c.collect(round());
    await journal.close();
    const { state } = await loadObservationState(dir);
    const frozen = { namespace: { ...NS }, battleId: "1", roundId: "1", mode: "PriceGain" as const, policyHash: POLICY, candidates: [0, 1], startNs: START_NS, endNs: END_NS, boundaryToleranceMs: 1000, maxGapMs: 40_000 };
    const p = provisionalProjection(state, frozen, modes);
    expect(p).toMatchObject({ status: "provisional", provisionalLeaders: [0] });
    expect(p.scores[0]).toEqual({ community: 0, negative: false, numerator: "30", denominator: "300" });
    journal = await ObservationJournal.open(dir);
  });

  it("keeps the live source disabled with a specific reason", () => {
    expect(() => liveSourceUnavailable()).toThrow(/no provider qualification record \(#147\)/);
  });
});
