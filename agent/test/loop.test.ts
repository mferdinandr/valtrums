import { describe, expect, it } from "vitest";
import { runLoop } from "../src/loop.js";
import { loadRuntimeConfig } from "../src/runtime-config.js";
import { createJsonLogger } from "../src/logger.js";

describe("runLoop", () => {
  it("runs the watchdog on the first pass then on its own interval, and stops on abort", async () => {
    const stop = new AbortController();
    let t = 0;
    const flags: boolean[] = [];
    await runLoop({
      pass: async (due) => {
        flags.push(due);
        if (flags.length === 5) stop.abort();
      },
      intervalMs: 30,
      watchdogIntervalMs: 90,
      signal: stop.signal,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    // t = 0, 30, 60, 90, 120
    expect(flags).toEqual([true, false, false, true, false]);
  });

  it("survives a failing pass and retries the watchdog next tick", async () => {
    const stop = new AbortController();
    const flags: boolean[] = [];
    await runLoop({
      pass: async (due) => {
        flags.push(due);
        if (flags.length === 1) throw new Error("rpc down");
        stop.abort();
      },
      intervalMs: 1,
      watchdogIntervalMs: 1_000_000,
      signal: stop.signal,
      sleep: async () => {},
    });
    expect(flags).toEqual([true, true]);
  });

  it("does not start a pass when already aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    let runs = 0;
    await runLoop({
      pass: async () => void runs++,
      intervalMs: 1,
      watchdogIntervalMs: 1,
      signal: stop.signal,
    });
    expect(runs).toBe(0);
  });
});

describe("loadRuntimeConfig", () => {
  it("has sane defaults", () => {
    expect(loadRuntimeConfig({})).toEqual({
      intervalSecs: 30,
      watchdogIntervalSecs: 3600,
      baselinePath: "./.agent-state/baselines.json",
      executionMode: "mock",
      slippageBps: 500,
      stepTimeoutSecs: 600,
    });
  });
  it("reads overrides and rejects bad values", () => {
    expect(
      loadRuntimeConfig({ AGENT_INTERVAL_SECS: "10", BASELINE_STORE_PATH: "/tmp/x.json" }),
    ).toMatchObject({ intervalSecs: 10, baselinePath: "/tmp/x.json" });
    expect(() => loadRuntimeConfig({ AGENT_INTERVAL_SECS: "0" })).toThrow();
    expect(() => loadRuntimeConfig({ EXECUTION_MODE: "mpc" })).toThrow(/EXECUTION_MODE/);
  });
});

describe("createJsonLogger", () => {
  it("writes one JSON line and serializes bigint", () => {
    const lines: string[] = [];
    createJsonLogger((l) => lines.push(l)).info("hi", { n: 5n });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info", msg: "hi", n: "5" });
  });
});
