import { cn } from "@/lib/utils";
import { isAborted, STATUS_LABEL, TIMELINE } from "@/lib/arena/status";
import type { BattleStatus } from "@/lib/arena/types";

export function StatusTimeline({ status }: { status: BattleStatus }) {
  const aborted = isAborted(status);
  const currentIdx = aborted ? -1 : TIMELINE.indexOf(status);

  return (
    <ol
      className="flex flex-wrap items-center gap-y-2"
      aria-label="Battle status timeline"
    >
      {TIMELINE.map((step, i) => {
        const done = !aborted && i < currentIdx;
        const current = !aborted && i === currentIdx;
        return (
          <li
            key={step}
            className="flex items-center"
            aria-current={current ? "step" : undefined}
          >
            <span
              className={cn(
                "rounded-lg border px-3 py-2 font-pixel text-[10px] uppercase tracking-wide",
                current &&
                  "border-neon-green/50 bg-neon-green/10 text-neon-green",
                done && "border-neon-cyan text-neon-cyan",
                !done && !current && "border-edge text-mute",
              )}
            >
              {STATUS_LABEL[step]}
            </span>
            {i < TIMELINE.length - 1 && (
              <span
                className={cn("h-[2px] w-4", done ? "bg-neon-cyan" : "bg-edge")}
              />
            )}
          </li>
        );
      })}
      {aborted && (
        <li className="flex items-center" aria-current="step">
          <span className="h-[2px] w-4 bg-neon-red" />
          <span className="rounded-lg border border-neon-red bg-neon-red/15 px-3 py-2 font-pixel text-[10px] uppercase text-neon-red">
            {STATUS_LABEL[status]}
          </span>
        </li>
      )}
    </ol>
  );
}
