import type { OpenPhase } from "@/lib/arena-read/open-arena";

/** The steps between "start time reached" and "round one is running". */
const STEPS = ["Get ready", "Locking crews", "Opening round"] as const;
const GET_READY_WINDOW_MS = 10_000;

export interface StartStage {
  /** Index into STEPS that is in progress. */
  step: 0 | 1 | 2;
  /** Only the get-ready step has a countdown. */
  msLeft: number | null;
  title: string;
  hint: string;
}

/**
 * Which loading step the battle is in, or null when no loader should show (deposits still open far from
 * the start, a result recorded, a cancelled battle, or a round already running).
 */
export function startStage(input: {
  status: string;
  open: OpenPhase;
  locked: boolean;
  phaseKind: string;
  roundId: string | null;
}): StartStage | null {
  if (input.status === "decided" || input.status === "cancelled") return null;
  if (input.open.kind === "gathering") {
    return input.open.msLeft <= GET_READY_WINDOW_MS
      ? { step: 0, msLeft: input.open.msLeft, title: "Get ready", hint: "Deposits close when the clock hits zero." }
      : null;
  }
  if (input.open.kind === "awaiting_lock") {
    return { step: 1, msLeft: null, title: "Locking crews", hint: "Freezing the lineup and the price snapshot on-chain." };
  }
  if (input.locked && (input.phaseKind === "not_started" || input.phaseKind === "awaiting_open")) {
    const next = input.roundId && input.phaseKind === "awaiting_open" ? `round ${Number(input.roundId) + 1}` : "round 1";
    return { step: 2, msLeft: null, title: `Opening ${next}`, hint: "The oracle is publishing the round window. The chart goes live next." };
  }
  return null;
}

export function BattleStartLoader({ stage, variant }: { stage: StartStage; variant: "panel" | "sticky" }) {
  const seconds = stage.msLeft === null ? null : Math.max(0, Math.ceil(stage.msLeft / 1000));
  return (
    <div
      className={`start-loader start-loader--${variant}`}
      // The sticky copy repeats the panel; only one of them is announced.
      {...(variant === "panel" ? { role: "status", "aria-live": "polite" as const } : { "aria-hidden": true })}
    >
      <ol className="start-loader-steps" aria-label="Battle start progress">
        {STEPS.map((label, i) => (
          <li key={label} data-state={i < stage.step ? "done" : i === stage.step ? "active" : "todo"}>
            <span className="start-loader-pip" />
            <span>{label}</span>
          </li>
        ))}
      </ol>
      <div className="start-loader-main">
        {seconds !== null ? <span className="start-loader-count">{seconds}</span> : <span className="start-loader-spinner" />}
        <div>
          <strong>{stage.title}</strong>
          {variant === "panel" && <p>{stage.hint}</p>}
        </div>
      </div>
      <div className="start-loader-bar" />
    </div>
  );
}
