import type { ObservationData, ObservationItem } from "@/lib/arena-read/observations";
import type { ChartPoint, ChartSeries } from "./model";

/**
 * Adapter from backend observation evidence to chart geometry. Floating point appears only here and
 * is presentation: the exact rational scores come from the backend and are shown as strings. A
 * missing baseline, boundary or sample is a `null` point that breaks the line; nothing is
 * interpolated, extended or zero-filled, and no data of another source is substituted.
 */

const COLORS = ["#327f7d", "#ad5273", "#a8802f", "#5b6fb5", "#7c8f3a", "#8a5ca8"];
export const SUPPORTED_DISPLAY_MODES = ["PriceGain", "LowestDrawdown"] as const;

const nsToMs = (ns: string): bigint => BigInt(ns) / 1_000_000n;

function price(item: ObservationItem): { value: bigint; scale: number } | null {
  const i = item.inputs;
  if (i.kind !== "price" || typeof i.price !== "string" || typeof i.priceScale !== "number") return null;
  return { value: BigInt(i.price), scale: i.priceScale };
}

/** A display percentage to 18 decimals; BigInt arithmetic until the final division. (Basis points hid moves below 0.01%.) */
const percent = (numerator: bigint, denominator: bigint): number => Number((numerator * 10n ** 20n) / denominator) / 1e18;

export interface ObservationChartModel {
  series: ChartSeries[];
  duration: number;
  lowerIsBetter: boolean;
  /** The chart can draw this mode from the evidence; otherwise it draws nothing. */
  drawable: boolean;
  /** Plain-language reasons for gaps, shown next to the chart. */
  gapNotes: string[];
}

/** Replaces "community N" (the backend counts from 0) with the token's own name when it is known. */
export function withNames(text: string, names: readonly string[] | undefined): string {
  if (!names) return text;
  return text.replace(/\bcommunity (\d+)\b/gi, (whole, n: string) => names[Number(n)] ?? whole);
}

export function observationSeries(data: ObservationData, names?: readonly string[]): ObservationChartModel {
  const label = (community: number): string => names?.[community] ?? `Community ${community + 1}`;
  // Notes read as a sentence: lower-case fallback when no token name is known.
  const note = (community: number): string => names?.[community] ?? `community ${community + 1}`;
  const mode = data.items[0]?.mode ?? data.projection?.mode;
  const drawable = mode === "PriceGain" || mode === "LowestDrawdown";
  const startMs = data.recorded?.startNs ? nsToMs(data.recorded.startNs) : null;
  const endMs = data.recorded?.endNs ? nsToMs(data.recorded.endNs) : null;
  const duration = startMs !== null && endMs !== null && endMs > startMs ? Number(endMs - startMs) / 1000 : 30;
  const lowerIsBetter = mode === "LowestDrawdown";
  const gapNotes: string[] = [];
  if (!drawable || startMs === null) {
    return { series: [], duration, lowerIsBetter, drawable: false, gapNotes: drawable ? ["round window not recorded yet"] : [] };
  }
  const candidates = data.recorded?.candidates ?? [...new Set(data.items.map((i) => i.community))].sort((a, b) => a - b);
  const series = candidates.map((community, index): ChartSeries => {
    const cov = data.coverage?.communities.find((c) => c.community === community);
    const timed = data.items
      .filter((i) => i.community === community && i.roundId === data.recorded?.roundId && i.mode === mode && i.observedAtMs !== null && price(i) !== null)
      .sort((a, b) => BigInt(a.observedAtMs as string) < BigInt(b.observedAtMs as string) ? -1 : BigInt(a.observedAtMs as string) > BigInt(b.observedAtMs as string) ? 1 : BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
    const points: ChartPoint[] = [];
    // Without a start sample there is no honest baseline: every value stays null.
    const boundary = data.boundaries?.find((b) => b.community === community);
    const first = boundary?.start ? timed.find((i) => i.id === boundary.start!.id) : undefined;
    const base = mode === "PriceGain" && cov?.hasStart && first ? price(first) : null;
    if (mode === "PriceGain" && !base) gapNotes.push(`${note(community)}: start sample unavailable`);
    let peak = 0n;
    for (const [n, item] of timed.entries()) {
      if (first && item.policyHash !== first.policyHash) continue;
      const p = price(item)!;
      // A sample within the boundary tolerance but outside the window is evidence for the score, not a point
      // of this round's timeline: clamping it to the edge drew a false jump at 0s / 30s.
      const rawX = Number(BigInt(item.observedAtMs as string) - startMs) / 1000;
      const inWindow = rawX >= 0 && rawX <= duration;
      const x = Math.min(duration, Math.max(0, rawX));
      let value: number | null = null;
      if (mode === "PriceGain") {
        if (base && base.scale === p.scale && base.value > 0n) value = percent(p.value - base.value, base.value);
      } else {
        if (p.value > peak) peak = p.value;
        value = peak > 0n ? percent(peak - p.value, peak) : null;
      }
      const prev = timed[n - 1];
      if (prev && cov?.gaps.some((g) => BigInt(g.fromMs) >= BigInt(prev.observedAtMs as string) && BigInt(g.toMs) <= BigInt(item.observedAtMs as string))) {
        points.push({ x: (points.at(-1)?.x ?? x) + (x - (points.at(-1)?.x ?? x)) / 2, value: null });
      }
      if (inWindow) points.push({ x, value });
    }
    if (timed.length > 0 && cov && !cov.hasEnd) {
      points.push({ x: duration, value: null });
      gapNotes.push(`${note(community)}: no closing sample yet`);
    }
    if (timed.length === 0) gapNotes.push(`${note(community)}: no samples with a provider time`);
    if (cov && cov.unknownTime > 0) gapNotes.push(`${note(community)}: ${cov.unknownTime} sample(s) without a provider time are not plotted`);
    if (cov && cov.gaps.length > 0) gapNotes.push(`${note(community)}: ${cov.gaps.length} gap(s) in coverage`);
    return { id: String(community), name: label(community), color: COLORS[index % COLORS.length]!, points };
  });
  return { series, duration, lowerIsBetter, drawable, gapNotes };
}

/** Exact fraction text, for example `+10/300`. The backend value is shown untouched. */
export const exactScoreText = (s: { negative: boolean; numerator: string; denominator: string }): string =>
  `${s.negative ? "-" : "+"}${s.numerator}/${s.denominator}`;
