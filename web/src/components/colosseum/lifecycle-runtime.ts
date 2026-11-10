import type {
  LifecycleCommunity,
  LifecycleDetail,
} from "@/lib/arena-read/lifecycle";
import { communityName } from "@/lib/arena-read/lifecycle-presentation";
import { battleRoster } from "./battle-runtime";
import {
  CONTENDERS,
  makeRuntime,
  type Contender,
  type PreviewRuntime,
  type ScoreMode,
} from "./choreography";

const crewColors = ["#327f7d", "#ad5273", "#7c6299", "#8b6b27", "#437f9a"];

/** Only an exact on-chain source/reference pair can select researched cosmetic artwork. */
export function lifecycleRoster(
  communities: readonly LifecycleCommunity[],
): Contender[] {
  return communities.map((c, index) => {
    const known = CONTENDERS.find(
      (entry) =>
        (c.reference_chain_id === String(entry.referenceChainId) &&
          c.reference_address?.toLowerCase() ===
            entry.referenceAddress.toLowerCase()) ||
        (c.chain_id === String(entry.referenceChainId) &&
          c.token_address.toLowerCase() ===
            entry.referenceAddress.toLowerCase()),
    );
    const number = String(index + 1).padStart(2, "0");
    if (known) return { ...known, number };
    return {
      ...battleRoster([
        { id: c.representation, symbol: communityName(index), decimals: 0 },
      ])[0]!,
      number,
      color: crewColors[index % crewColors.length]!,
    };
  });
}

const modes: Record<string, ScoreMode> = {
  PriceGain: "gain",
  MarketCapGrowth: "cap",
  VolumeRatio: "volume",
  LowestDrawdown: "drawdown",
};

/** Scene state has no legacy DTO and no fixture resolver, score or synthetic round history. */
export function lifecycleRuntime(
  detail: LifecycleDetail,
  roster: Contender[],
  nowMs: number,
): PreviewRuntime {
  const state = makeRuntime(roster);
  const round = detail.round;
  const validIndex = (i: number) =>
    Number.isInteger(i) && i >= 0 && i < roster.length;
  const winner =
    round?.winner != null && validIndex(round.winner) ? round.winner : null;
  const candidates = round
    ? round.candidates.filter(validIndex)
    : roster.map((_, i) => i);
  const start = round?.start_ns
    ? Number(BigInt(round.start_ns) / 1_000_000n)
    : null;
  const end = round?.end_ns ? Number(BigInt(round.end_ns) / 1_000_000n) : null;
  const live =
    detail.battle.locked &&
    start !== null &&
    end !== null &&
    end > start &&
    nowMs >= start &&
    nowMs < end;
  const stage =
    winner !== null
      ? "result"
      : live
        ? "fighting"
        : detail.battle.locked
          ? "pending"
          : "resolving";
  state.mode = modes[detail.battle.mode] ?? "gain";
  state.phase = winner !== null ? "result" : live ? "battle" : "ready";
  // Animation-only numeric round label; the exact round ID remains in the DOM/read model.
  const roundNumber =
    round && BigInt(round.round_id) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(round.round_id)
      : 0;
  state.externalRound = {
    round: roundNumber,
    stage,
    elapsed:
      start === null || end === null
        ? 0
        : Math.max(0, Math.min(nowMs, end) - start) / 1000,
    remaining: end === null || nowMs <= 0 ? 0 : Math.max(0, end - nowMs) / 1000,
    candidates: winner === null ? candidates : [winner],
    eliminated: round
      ? roster
          .map((_, i) => i)
          .filter((i) =>
            winner === null ? !candidates.includes(i) : i !== winner,
          )
      : [],
    winner,
    scores: [],
    history: [],
  };
  return state;
}
