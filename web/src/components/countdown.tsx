"use client";

import { formatCountdown, msUntilNs } from "@/lib/amounts";
import { useNow } from "@/hooks/use-now";

/** Live countdown to a nanosecond timestamp. */
export function Countdown({ targetNs, doneLabel = "0s" }: { targetNs: bigint; doneLabel?: string }) {
  const now = useNow(1000);
  if (now === 0) return <span>--</span>;
  const ms = msUntilNs(targetNs, now);
  return <span suppressHydrationWarning>{ms <= 0 ? doneLabel : formatCountdown(ms)}</span>;
}
