import { cn } from "@/lib/utils";

const TONES = {
  green: "bg-neon-green shadow-glow-green",
  pink: "bg-neon-pink shadow-glow-pink",
  cyan: "bg-neon-cyan shadow-glow-cyan",
  amber: "bg-neon-amber",
  red: "bg-neon-red",
} as const;

export interface HpBarProps {
  /** Fill between 0 and 100. */
  percent: number;
  tone?: keyof typeof TONES;
  label?: string;
  right?: string;
  /** Number of pixel segments. */
  segments?: number;
  className?: string;
}

/** Segmented HP-style meter. */
export function HpBar({
  percent,
  tone = "green",
  label,
  right,
  segments = 20,
  className,
}: HpBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * segments);
  return (
    <div className={cn("w-full", className)}>
      {(label || right) && (
        <div className="mb-1 flex justify-between font-pixel text-[9px] uppercase text-mute">
          <span>{label}</span>
          <span className="text-ink">{right}</span>
        </div>
      )}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
        className="flex h-3 gap-[3px] overflow-hidden rounded border border-edge bg-void p-[2px]"
      >
        {Array.from({ length: segments }, (_, i) => (
          <div
            key={i}
            className={cn(
              "h-full flex-1",
              i < filled ? TONES[tone] : "bg-edge/40",
            )}
          />
        ))}
      </div>
    </div>
  );
}
