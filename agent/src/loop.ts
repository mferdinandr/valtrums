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
}

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
    await sleep(opts.intervalMs, opts.signal);
  }
  log.info("loop stopped");
}
