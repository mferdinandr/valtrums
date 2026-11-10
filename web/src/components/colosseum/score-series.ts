import { fixtureScores, roundAt, type PreviewRuntime } from "./choreography";
import type { ChartSeries } from "@/components/battle-chart/model";

/** Deterministic visual observations for the exhibition only. No market data. */
export function previewScoreSeries(state: PreviewRuntime): ChartSeries[] {
  const round = roundAt(state);
  const record = round.history.find((r) => r.round === round.round);
  const targets = fixtureScores(
    record?.candidates ?? round.candidates,
    round.round,
    state,
  );
  // Missing close evidence is a real gap in this fixture, not an invented zero.
  const end = round.stage === "pending" ? 29 : round.elapsed;
  const samples = Array.from({ length: Math.floor(end) + 1 }, (_, i) => i);
  if (end % 1) samples.push(end);
  if (round.stage === "pending") samples.push(30);
  return state.roster.map((c, index) => {
    const target = targets.find((s) => s.participant === index);
    return {
      id: String(index),
      name: c.name,
      color: c.color,
      inactive: round.eliminated.includes(index),
      points: target
        ? samples.map((x) => {
            if (round.stage === "pending" && x === 30)
              return { x, value: null };
            const t = x / 30,
              final = (Number(target.n) / Number(target.d)) * 100;
            let value = final;
            if (t < 1) {
              if (state.mode === "volume")
                value =
                  final *
                  (t + 0.07 * Math.cos(index) * Math.sin(2 * Math.PI * t));
              else if (state.mode === "drawdown")
                value = final * t ** (0.6 + index * 0.65);
              else
                value =
                  final * t +
                  5 *
                    Math.sin(Math.PI * t) *
                    Math.sin((t * 2.6 + index * 0.38) * Math.PI);
            }
            return { x, value };
          })
        : [],
    };
  });
}
