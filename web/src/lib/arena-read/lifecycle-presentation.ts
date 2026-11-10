import type { ScoringMode } from "./lifecycle";

export const MODE_COPY: Record<
  ScoringMode,
  { name: string; description: string; short: string }
> = {
  PriceGain: {
    name: "Biggest price climb",
    description: "The strongest price gain in this round takes the lead.",
    short: "Price climb",
  },
  MarketCapGrowth: {
    name: "Community growth",
    description:
      "Compete on market-cap growth, using qualified price and supply evidence.",
    short: "Market-cap growth",
  },
  VolumeRatio: {
    name: "Trading energy",
    description:
      "Compare round trading volume against each community’s starting market cap.",
    short: "Trading energy",
  },
  LowestDrawdown: {
    name: "Steadiest crew",
    description: "The smallest peak-to-trough drop wins the round.",
    short: "Lowest drawdown",
  },
};
export const modeName = (mode: string) =>
  MODE_COPY[mode as ScoringMode]?.name ?? mode;
export function shortAccount(value: string) {
  return value.length > 26
    ? `${value.slice(0, 12)}…${value.slice(-10)}`
    : value;
}
export const communityName = (index: number) =>
  `Crew ${String(index + 1).padStart(2, "0")}`;
/** No decimal metadata is guessed. Raw units stay exact, formatted for legibility. */
export function exactUnits(units: string) {
  return /^\d+$/.test(units) ? BigInt(units).toLocaleString("en-US") : units;
}
