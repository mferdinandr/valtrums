import { describe, expect, it } from "vitest";
import { chartSegments, displayStandings, type ChartSeries } from "./model";
import { snapshotSeries } from "./snapshots";
import { previewScoreSeries } from "@/components/colosseum/score-series";
import {
  makeRuntime,
  roundAt,
  MODES,
  type ScoreMode,
} from "@/components/colosseum/choreography";
import { createMockArenaApi } from "@/lib/arena/mock";

describe("battle chart evidence boundaries", () => {
  it("breaks a line at missing evidence rather than joining across the gap", () => {
    expect(
      chartSegments([
        { x: 0, value: 0 },
        { x: 1, value: 1 },
        { x: 2, value: null },
        { x: 3, value: 2 },
        { x: 4, value: NaN },
      ]),
    ).toEqual([
      [
        { x: 0, value: 0 },
        { x: 1, value: 1 },
      ],
      [{ x: 3, value: 2 }],
    ]);
  });
  it("compares negative provisional scores, lower drawdown and exact display ties", () => {
    const series: ChartSeries[] = [-5, -3, -3].map((value, i) => ({
      id: String(i),
      name: String(i),
      color: "red",
      points: [{ x: 0, value }],
    }));
    expect(displayStandings(series, false).leaders.map((l) => l.id)).toEqual([
      "1",
      "2",
    ]);
    expect(displayStandings(series, true).leaders.map((l) => l.id)).toEqual([
      "0",
    ]);
    series[0]!.points.push({ x: 1, value: null });
    expect(displayStandings(series, true).leaders.map((l) => l.id)).toEqual([
      "1",
      "2",
    ]);
  });
  it("does not invent current samples when only initial prices exist", async () => {
    const api = createMockArenaApi({ now: () => 1_800_000_000_000 });
    const battle = (await api.getBattle(3))!;
    const metas = (await Promise.all([
      api.getTokenMeta(battle.token_a),
      api.getTokenMeta(battle.token_b),
    ])) as Awaited<ReturnType<typeof api.getTokenMeta>>[];
    const initial = snapshotSeries(
      { ...battle, final_price_a: null, final_price_b: null },
      [metas[0]!, metas[1]!],
      null,
    );
    expect(
      initial.every((s) => s.points.length === 1 && s.points[0]!.x === 0),
    ).toBe(true);
    const unrecorded = snapshotSeries(
      { ...battle, initial_price_a: null, initial_price_b: null },
      [metas[0]!, metas[1]!],
      null,
    );
    expect(unrecorded.every((s) => s.points.length === 0)).toBe(true);
  });
  it("shows only start/end snapshots and prioritizes recorded final prices", async () => {
    const api = createMockArenaApi({ now: () => 1_800_000_000_000 });
    const battle = (await api.getBattle(5))!;
    const a = await api.getTokenMeta(battle.token_a),
      b = await api.getTokenMeta(battle.token_b);
    const final = snapshotSeries(battle, [a, b], null);
    expect(
      final.every(
        (s) =>
          s.points.length === 2 && s.points.map((p) => p.x).join() === "0,1",
      ),
    ).toBe(true);
    expect(snapshotSeries(battle, [a, b], { a: 1n, b: 1n })).toEqual(final);
  });
  it("matches verified fixture endpoints for every mode without altering resolution", () => {
    for (const mode of Object.keys(MODES) as ScoreMode[]) {
      const state = {
        ...makeRuntime(),
        mode,
        scenario: "clean" as const,
        time: 32,
        phase: "battle" as const,
      };
      const before = roundAt(state),
        series = previewScoreSeries(state);
      for (const score of before.scores)
        expect(series[score.participant]!.points.at(-1)!.value).toBe(
          (Number(score.n) / Number(score.d)) * 100,
        );
      state.chartLeader = 4;
      expect(roundAt(state)).toEqual(before);
    }
  });
  it("keeps volume cumulative and drawdown nondecreasing", () => {
    for (const mode of ["volume", "drawdown"] as const) {
      const series = previewScoreSeries({ ...makeRuntime(), mode, time: 30 });
      for (const s of series) {
        expect(s.points[0]!.value).toBe(0);
        for (let i = 1; i < s.points.length; i++)
          expect(s.points[i]!.value!).toBeGreaterThanOrEqual(
            s.points[i - 1]!.value!,
          );
      }
    }
  });
  it("resets overtime baselines and leaves missing close evidence as a gap", () => {
    const state = { ...makeRuntime(), time: 35 };
    const series = previewScoreSeries(state);
    expect(roundAt(state).round).toBe(2);
    expect(
      series
        .filter((s) => !s.inactive)
        .every((s) => s.points.length === 1 && s.points[0]!.value === 0),
    ).toBe(true);
    expect(
      series.filter((s) => s.inactive).every((s) => s.points.length === 0),
    ).toBe(true);
    const missing = previewScoreSeries({
      ...makeRuntime(),
      scenario: "missing",
      time: 30,
    });
    expect(missing.every((s) => s.points.at(-1)!.value === null)).toBe(true);
    expect(
      roundAt({ ...makeRuntime(), scenario: "missing", time: 30 }).winner,
    ).toBeNull();
  });
});
