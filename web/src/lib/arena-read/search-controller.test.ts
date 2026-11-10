import { describe, expect, it } from "vitest";
import { createSearchController, type SearchInput } from "./search-controller";

/** Manual timers and deferred responses so ordering is fully controlled. */
function harness(debounceMs = 300) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const calls: Array<{ input: SearchInput; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void }> = [];
  const results: string[] = [];
  const errors: string[] = [];
  const c = createSearchController<string>({
    debounceMs,
    fetcher: (input, signal) => new Promise((resolve, reject) => calls.push({ input, signal, resolve, reject })),
    onResult: (r) => results.push(r),
    onError: (e) => errors.push(e),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
  });
  const flushTimers = () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); });
  return { c, timers, calls, results, errors, flushTimers };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("backend search controller", () => {
  it("debounces text typing into one request with the final text", () => {
    const h = harness();
    h.c.update({ q: "" });
    expect(h.calls).toHaveLength(1); // first load runs at once
    h.c.update({ q: "p" });
    h.c.update({ q: "pe" });
    h.c.update({ q: "pepe " });
    expect(h.calls).toHaveLength(1);
    expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(h.timers.at(-1)!.ms).toBe(300);
    h.flushTimers();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.input).toEqual({ q: "pepe" });
  });

  it("sends filter changes immediately and skips unchanged input", () => {
    const h = harness();
    h.c.update({ q: "", mode: "PriceGain" });
    h.c.update({ q: "", mode: "LowestDrawdown" });
    expect(h.calls.map((x) => x.input.mode)).toEqual(["PriceGain", "LowestDrawdown"]);
    h.c.update({ q: " ", mode: "LowestDrawdown" });
    expect(h.calls).toHaveLength(2);
  });

  it("aborts the in-flight request and drops a stale response that arrives late", async () => {
    const h = harness();
    h.c.update({ q: "", status: "open" });
    h.c.update({ q: "", status: "locked" });
    expect(h.calls[0]!.signal.aborted).toBe(true);
    h.calls[1]!.resolve("locked-page");
    h.calls[0]!.resolve("open-page"); // late, superseded
    await tick();
    expect(h.results).toEqual(["locked-page"]);
  });

  it("ignores results and errors after cancel (unmount)", async () => {
    const h = harness();
    h.c.update({ q: "", status: "open" });
    h.c.update({ q: "x" });
    h.c.cancel();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.timers.every((t) => t.cleared)).toBe(true);
    h.calls[0]!.reject(new Error("boom"));
    await tick();
    expect(h.results).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("invalidates an old response immediately while the newer text is still debouncing", async () => {
    const h = harness();
    h.c.update({ q: "" });
    h.c.update({ q: "new" });
    expect(h.calls[0]!.signal.aborted).toBe(true);
    h.calls[0]!.resolve("old response during debounce");
    await tick();
    expect(h.results).toEqual([]);
    h.flushTimers();
    h.calls[1]!.resolve("new result");
    await tick();
    expect(h.results).toEqual(["new result"]);
  });

  it("reports an error of the latest request", async () => {
    const h = harness();
    h.c.update({ q: "", status: "open" });
    h.calls[0]!.reject(new Error("read API unavailable"));
    await tick();
    expect(h.errors).toEqual(["read API unavailable"]);
  });
});
