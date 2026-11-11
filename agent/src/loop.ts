import { type Logger, errorMessage, silentLogger } from "./logger.js";

export interface LoopOptions {
  /** Called every tick; `watchdogDue` is true when the (slower) watchdog interval elapsed. */
  pass: (watchdogDue: boolean) => Promise<unknown>;
  intervalMs: number;
  watchdogIntervalMs: number;
  signal: AbortSignal;
  log?: Logger;
  now?: () => number;
  /** Resolves after `ms` or as soon as the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** An absolute time (ms) the next pass should not be later than, for example a battle start; null for none. */
  nextWakeAt?: () => number | null;
}

/** Wake slightly after the target so the agent's clock has certainly passed it. */
const WAKE_CUSHION_MS = 50;
/** A wake time that passed less than this long ago still triggers a prompt pass. */
const WAKE_GRACE_MS = 10_000;
const MIN_WAKE_SLEEP_MS = 200;

export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Run passes until the signal aborts. The current pass always finishes first,
 * so a shutdown never interrupts a transaction half way. A failing pass is
 * logged and retried on the next tick. The watchdog runs on the first pass
 * (which also rebuilds missing baselines after a restart) and then hourly.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  const log = opts.log ?? silentLogger;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  let lastWatchdog: number | undefined;
  while (!opts.signal.aborted) {
    const t = now();
    const due = lastWatchdog === undefined || t - lastWatchdog >= opts.watchdogIntervalMs;
    try {
      await opts.pass(due);
      if (due) lastWatchdog = t;
    } catch (err) {
      log.error("pass failed", { error: errorMessage(err) });
    }
    const wake = opts.nextWakeAt?.() ?? null;
    const untilWake = wake === null ? Number.POSITIVE_INFINITY : wake - now() + WAKE_CUSHION_MS;
    // Never sleep past the interval. A wake time reached within the last 10 s (a pass yielded to it) runs the next
    // pass almost at once, with a short floor so it can never spin; an older, stale one is ignored.
    const pause = untilWake > -WAKE_GRACE_MS ? Math.min(opts.intervalMs, Math.max(untilWake, MIN_WAKE_SLEEP_MS)) : opts.intervalMs;
    await sleep(pause, opts.signal);
  }
  log.info("loop stopped");
}
