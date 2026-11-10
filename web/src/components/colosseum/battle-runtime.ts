import type { BattleView, TokenMeta } from "@/lib/arena/types";
import {
  CONTENDERS,
  makeRuntime,
  type Contender,
  type PreviewRuntime,
  type RoundSnapshot,
} from "./choreography";

export function battleRoster(tokens: readonly TokenMeta[]): Contender[] {
  return tokens.map((token, index) => {
    const known = CONTENDERS.find((c) => c.demoTokenId === token.id);
    if (known) return { ...known, number: String(index + 1).padStart(2, "0") };
    return {
      ...CONTENDERS[0]!,
      name: token.symbol,
      asset: "generic",
      generic: true,
      number: String(index + 1).padStart(2, "0"),
      demoTokenId: token.id,
      referenceAddress: "",
      referenceChainId: 0,
      researchNote:
        "No verified contract-bound character reference for this token.",
      title: "Community token",
      type: "Generic 3D token emblem",
      description:
        "No verified character mapping for this token contract. The emblem uses its actual displayed symbol.",
      color: index % 2 ? "#ad5273" : "#327f7d",
      visualReference: {
        status: "unverified",
        reviewedAt: "",
        imageUrl: null,
        listingUrl: null,
      },
    };
  });
}

/** Read-only visual adapter: clock expiry never assigns a winner or starts overtime. */
export function recordedRuntime(
  battle: BattleView,
  roster: Contender[],
  now: number,
): PreviewRuntime {
  const state = makeRuntime(roster),
    start = Number(BigInt(battle.start_time_ns) / 1000000n),
    end = Number(BigInt(battle.end_time_ns) / 1000000n);
  const duration = Math.max(0, (end - start) / 1000);
  const elapsed =
    now > 0 && start > 0
      ? Math.max(0, Math.min(duration, (now - start) / 1000))
      : 0;
  const live =
    battle.status === "Live" &&
    start > 0 &&
    end > start &&
    now >= start &&
    now < end;
  const winner =
    battle.status === "Settled" &&
    !battle.demo_communities &&
    battle.winner !== null
      ? battle.winner === "A"
        ? 0
        : 1
      : null;
  const all = roster.map((_, i) => i);
  const round: RoundSnapshot = {
    round: 1,
    stage:
      winner !== null
        ? "result"
        : live
          ? "fighting"
          : ["Live", "Settling"].includes(battle.status)
            ? "pending"
            : "resolving",
    elapsed,
    remaining: Math.max(0, duration - elapsed),
    candidates: winner === null ? all : [winner],
    eliminated: winner === null ? [] : all.filter((i) => i !== winner),
    winner,
    scores: [],
    history: [],
  };
  state.time = elapsed;
  state.phase = winner !== null ? "result" : live ? "battle" : "ready";
  state.externalRound = round;
  return state;
}
