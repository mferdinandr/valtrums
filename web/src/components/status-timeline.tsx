import { cn } from "@/lib/utils";
import { isAborted, STATUS_LABEL, TIMELINE } from "@/lib/arena/status";
import type { BattleStatus } from "@/lib/arena/types";

export function StatusTimeline({ status }: { status: BattleStatus }) {
  const aborted = isAborted(status);
  const currentIdx = aborted ? -1 : TIMELINE.indexOf(status);

  return (
    <ol className="flex flex-wrap items-center gap-y-2" aria-label="Battle status timeline">
      {TIMELINE.map((step, i) => {
        const done = !aborted && i < currentIdx;
        const current = !aborted && i === currentIdx;
        return (
          <li key={step} className="flex items-center" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "border-2 px-2 py-2 font-pixel text-[8px] uppercase",
                current && "border-neon-green bg-neon-green/15 text-neon-green shadow-glow-green",
                done && "border-neon-cyan text-neon-cyan",
                !done && !current && "border-edge text-mute",
              )}
            >
              {STATUS_LABEL[step]}
            </span>
            {i < TIMELINE.length - 1 && <span className={cn("h-[2px] w-4", done ? "bg-neon-cyan" : "bg-edge")} />}
          </li>
        );
      })}
      {aborted && (
        <li className="flex items-center" aria-current="step">
          <span className="h-[2px] w-4 bg-neon-red" />
          <span className="border-2 border-neon-red bg-neon-red/15 px-2 py-2 font-pixel text-[8px] uppercase text-neon-red">
            {STATUS_LABEL[status]}
          </span>
        </li>
      )}
    </ol>
  );
}
