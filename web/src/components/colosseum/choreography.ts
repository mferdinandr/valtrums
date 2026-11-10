/** Isolated deterministic exhibition fixtures. No market observations or financial authority. */
import registry from "./characters.json";
export const CHARACTER_ASSET_VERSION = "logo-toys-2";
export const CONTENDERS = registry.characters.map((c, index) => ({
  ...c,
  number: String(index + 1).padStart(2, "0"),
  synthetic: false,
  generic: false,
}));
export type Contender = (typeof CONTENDERS)[number];
export const MODES = {
  gain: "Price % Gain",
  cap: "Market Cap % Growth",
  volume: "Volume / Initial Market Cap",
  drawdown: "Lowest % Drawdown",
} as const;
export type ScoreMode = keyof typeof MODES;
export type Scenario = "overtime" | "clean" | "missing";
export type PreviewPhase = "intro" | "ready" | "battle" | "result";
export type CameraMode = "overview" | "follow";
export interface PreviewRuntime {
  time: number;
  phase: PreviewPhase;
  selected: number;
  camera: CameraMode;
  reduced: boolean;
  paused: boolean;
  roster: readonly Contender[];
  mode: ScoreMode;
  scenario: Scenario;
  evidenceReady: boolean;
  /** Display-only provisional leader, never read by scoring or resolution. */
  chartLeader?: number | null;
  /** Recorded battle state overrides every exhibition outcome. */
  externalRound?: RoundSnapshot;
}
export function makeRuntime(
  roster: readonly Contender[] = CONTENDERS,
): PreviewRuntime {
  return {
    time: 0,
    phase: "intro",
    selected: 0,
    camera: "overview",
    reduced: false,
    paused: false,
    roster,
    mode: "gain",
    scenario: "overtime",
    evidenceReady: false,
  };
}
export function rosterFor(count: number): Contender[] {
  const roster = CONTENDERS.slice(0, Math.min(count, CONTENDERS.length));
  if (count === 6)
    roster.push({
      ...CONTENDERS[0]!,
      name: "TEST UNIT",
      asset: "cashcat",
      demoTokenId: "",
      referenceAddress: "",
      title: "Generic chassis",
      type: "Layout test only",
      description:
        "Synthetic sixth participant to test layout. Not a token, listing or approval.",
      researchNote: "Synthetic fixture only.",
      color: "#c6d2de",
      number: "06",
      synthetic: true,
    });
  return roster;
}
export const ROUND_SECONDS = 30;
export const RESOLUTION_SECONDS = 2;
export const INTERMISSION_SECONDS = 3;
export const ROUND_CYCLE =
  ROUND_SECONDS + RESOLUTION_SECONDS + INTERMISSION_SECONDS;
export const BEAT = 2.4;
export const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const smooth = (n: number) => {
  const p = clamp(n);
  return p * p * (3 - 2 * p);
};
export interface Score {
  participant: number;
  n: bigint;
  d: bigint;
}
export function resolveScores(
  scores: readonly Score[],
  mode: ScoreMode,
): number[] {
  if (
    !scores.length ||
    scores.some(
      (s) =>
        s.d <= 0n || ((mode === "volume" || mode === "drawdown") && s.n < 0n),
    )
  )
    throw new Error("Invalid score evidence");
  let best = scores[0]!;
  for (const score of scores) {
    const diff = score.n * best.d - best.n * score.d;
    if (mode === "drawdown" ? diff < 0n : diff > 0n) best = score;
  }
  return scores
    .filter((s) => s.n * best.d === best.n * s.d)
    .map((s) => s.participant);
}
export function formatScore(score: Score, mode: ScoreMode) {
  const hundredths = (score.n * 10000n) / score.d;
  return `${hundredths > 0n && mode !== "drawdown" && mode !== "volume" ? "+" : ""}${(Number(hundredths) / 100).toFixed(2)}%`;
}
export interface RoundRecord {
  round: number;
  candidates: number[];
  leaders: number[];
  scores: Score[];
}
export interface RoundSnapshot {
  round: number;
  stage: "fighting" | "resolving" | "overtime" | "pending" | "result";
  elapsed: number;
  remaining: number;
  candidates: number[];
  eliminated: number[];
  winner: number | null;
  scores: Score[];
  history: RoundRecord[];
}
export function fixtureScores(
  candidates: number[],
  round: number,
  state: PreviewRuntime,
): Score[] {
  const winner = state.roster.length > 2 ? 2 : 0;
  const tied = [0, state.roster.length > 2 ? 2 : 1];
  return candidates.map((participant) => {
    const unique = state.scenario === "clean" || round >= 3;
    const leading = unique
      ? participant === winner
      : tied.includes(participant);
    // Round 2 deliberately ties at negative gain. Every round has fresh scores.
    const bp =
      state.mode === "drawdown"
        ? leading
          ? 300
          : 800 + participant * 100
        : state.mode === "volume"
          ? leading
            ? 1000 + (round >= 3 ? 200 : 0)
            : 100
          : round === 2
            ? leading
              ? -300
              : -700
            : round >= 3
              ? participant === winner
                ? -400
                : -500
              : leading
                ? 1000
                : 200 - participant * 30;
    return { participant, n: BigInt(bp), d: 10000n };
  });
}
export function roundAt(state: PreviewRuntime): RoundSnapshot {
  if (state.externalRound) return state.externalRound;
  const all = state.roster.map((_, i) => i);
  let candidates = [...all],
    start = 0,
    round = 1;
  const history: RoundRecord[] = [];
  // The fixture happens to resolve in round 3. The resolver itself has no overtime cap.
  for (;;) {
    const elapsed = Math.max(0, state.time - start);
    const scores = fixtureScores(candidates, round, state);
    const leaders = resolveScores(scores, state.mode);
    const missing =
      state.scenario === "missing" && !state.evidenceReady && round === 1;
    const base = {
      round,
      elapsed: Math.min(ROUND_SECONDS, elapsed),
      remaining: Math.max(0, ROUND_SECONDS - elapsed),
      history,
      winner: null,
      scores: [] as Score[],
    };
    if (elapsed < ROUND_SECONDS)
      return {
        ...base,
        stage: "fighting",
        candidates,
        eliminated: all.filter((i) => !candidates.includes(i)),
      };
    if (missing)
      return {
        ...base,
        stage: "pending",
        candidates,
        eliminated: all.filter((i) => !candidates.includes(i)),
      };
    if (elapsed < ROUND_SECONDS + RESOLUTION_SECONDS)
      return {
        ...base,
        stage: "resolving",
        candidates,
        eliminated: all.filter((i) => !candidates.includes(i)),
      };
    history.push({ round, candidates: [...candidates], leaders, scores });
    if (leaders.length === 1)
      return {
        ...base,
        history,
        stage: "result",
        candidates: leaders,
        eliminated: all.filter((i) => !leaders.includes(i)),
        winner: leaders[0]!,
        scores,
      };
    if (elapsed < ROUND_CYCLE)
      return {
        ...base,
        history,
        stage: "overtime",
        candidates: leaders,
        eliminated: all.filter((i) => !leaders.includes(i)),
        scores,
      };
    candidates = leaders;
    start += ROUND_CYCLE;
    round++;
  }
}
export function homeAt(
  index: number,
  count: number,
  radius = count > 3 ? 5.1 : 4.3,
): [number, number] {
  const angle = (index / Math.max(2, count)) * Math.PI * 2 - Math.PI / 2;
  return [Math.sin(angle) * radius, Math.cos(angle) * radius];
}
export function arenaScale(count: number) {
  return count > 3 ? 1.15 : 1;
}
/** A personal arena station, never another participant. */
export function challengeAt(owner: number, count: number) {
  const [x, z] = homeAt(owner, count, count > 3 ? 2.65 : 2.15);
  return { owner, x, z };
}
export function beatAt(state: PreviewRuntime) {
  const round = roundAt(state);
  const actionTime = state.externalRound ? state.time : round.elapsed;
  const index = Math.floor(actionTime / BEAT),
    local = actionTime % BEAT;
  const attacker = round.candidates[index % round.candidates.length] ?? 0;
  return {
    index,
    local,
    attacker,
    target: challengeAt(attacker, state.roster.length),
    impact: clamp(1 - Math.abs(local - 1.15) / 0.38),
    fighting: state.phase === "battle" && round.stage === "fighting",
    round,
  };
}
export function fighterPose(index: number, state: PreviewRuntime) {
  const beat = beatAt(state),
    eliminated = beat.round.eliminated.includes(index);
  const [hx, hz] = homeAt(
    index,
    state.roster.length,
    eliminated ? 6.8 * arenaScale(state.roster.length) : undefined,
  );
  const { x: tx, z: tz } = challengeAt(index, state.roster.length);
  const distance = Math.max(0.001, Math.hypot(tx - hx, tz - hz));
  const attacking = beat.fighting && !state.reduced && beat.attacker === index;
  const ranged = ["oak", "rebate"].includes(state.roster[index]?.asset ?? "");
  const travel =
    attacking && !ranged
      ? smooth((beat.local - 0.55) / 0.5) *
        (1 - smooth((beat.local - 1.55) / 0.75))
      : 0;
  const reach = Math.max(0, distance - 1.5),
    x = hx + ((tx - hx) / distance) * reach * travel,
    z = hz + ((tz - hz) / distance) * reach * travel;
  return {
    x,
    z,
    yaw: Math.atan2(attacking ? tx - x : -hx, attacking ? tz - z : -hz),
    travel,
    hit: 0,
    windup: attacking
      ? Math.sin(clamp((beat.local - 0.15) / 0.7) * Math.PI)
      : 0,
    strike: attacking
      ? Math.sin(clamp((beat.local - 0.85) / 0.65) * Math.PI)
      : 0,
    victory: state.phase === "result" && beat.round.winner === index,
    defeated: state.phase === "result" && beat.round.winner !== index,
    eliminated,
    ranged,
  };
}
export function exhibitionCaption(state: PreviewRuntime) {
  const beat = beatAt(state),
    r = beat.round;
  if (r.stage === "pending")
    return "Missing demo evidence. No winner or elimination can be assigned.";
  if (r.stage === "resolving")
    return `Round ${r.round} complete · verifying fixture evidence`;
  if (r.stage === "overtime")
    return `Tied leaders advance · round ${r.round + 1} starts with fresh baselines`;
  if (r.stage === "result")
    return `${state.roster[r.winner!]?.name} wins the scripted exhibition`;
  if (beat.local < 0.6)
    return `${state.roster[beat.attacker]?.name} winds up at its own reactor station`;
  if (beat.local < 1.25)
    return `${state.roster[beat.attacker]?.name} powers its own arena target`;
  return "Boing! Arena actions are cosmetic; mode scores decide the round.";
}
