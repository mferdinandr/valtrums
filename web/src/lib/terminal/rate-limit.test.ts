import { describe, expect, it } from "vitest";
import { handleLifecycleParse } from "./lifecycle-parse-route";
import { DEFAULT_TERMINAL_LIMITS, TerminalGuard, clientKeyOf, terminalLimitsFromEnv, type TerminalLimits } from "./rate-limit";

const limits = (over: Partial<TerminalLimits> = {}): TerminalLimits => ({ ...DEFAULT_TERMINAL_LIMITS, ...over });
const HOUR = 3_600_000;

describe("limits from the environment", () => {
  it("uses safe defaults and keeps them when a value is invalid", () => {
    expect(terminalLimitsFromEnv({})).toEqual(DEFAULT_TERMINAL_LIMITS);
    const bad = terminalLimitsFromEnv({ TERMINAL_AI_PER_CLIENT_HOUR: "0", TERMINAL_AI_GLOBAL_HOUR: "-5", TERMINAL_AI_GLOBAL_DAY: "abc", TERMINAL_AI_CONCURRENT: "1.5", TERMINAL_REQUESTS_PER_CLIENT_MINUTE: "" });
    expect(bad).toEqual(DEFAULT_TERMINAL_LIMITS); // an invalid value never turns a limit off
  });
  it("reads the operator's values and the kill switch", () => {
    const l = terminalLimitsFromEnv({ TERMINAL_AI_PER_CLIENT_HOUR: "3", TERMINAL_AI_GLOBAL_HOUR: "50", TERMINAL_AI_GLOBAL_DAY: "100", TERMINAL_AI_ENABLED: "false" });
    expect(l).toMatchObject({ aiPerClientHour: 3, aiGlobalHour: 50, aiGlobalDay: 100, aiEnabled: false });
  });
});

describe("the guard", () => {
  it("limits one client per hour without touching others, and frees it after the hour", () => {
    let now = 1_000;
    const g = new TerminalGuard(limits({ aiPerClientHour: 2 }), () => now);
    const take = (c: string) => { const d = g.tryAi(c); if (d.allowed) d.release(); return d.allowed; };
    expect([take("a"), take("a"), take("a")]).toEqual([true, true, false]);
    expect(take("b")).toBe(true);
    now += HOUR + 1;
    expect(take("a")).toBe(true);
  });

  it("caps the total per hour and per day whoever asks", () => {
    let now = 1_000;
    const g = new TerminalGuard(limits({ aiPerClientHour: 100, aiGlobalHour: 3, aiGlobalDay: 5 }), () => now);
    const take = (c: string) => { const d = g.tryAi(c); if (d.allowed) d.release(); return d; };
    expect(["a", "b", "c"].map((c) => take(c).allowed)).toEqual([true, true, true]);
    const blocked = take("d");
    expect(blocked).toMatchObject({ allowed: false, reason: expect.stringContaining("hourly") });
    now += HOUR + 1;
    expect(take("e").allowed).toBe(true);
    expect(take("f").allowed).toBe(true);
    expect(take("g")).toMatchObject({ allowed: false, reason: expect.stringContaining("daily") }); // 5 in the last 24 hours
  });

  it("limits concurrent model calls and frees the slot once, on release", () => {
    const g = new TerminalGuard(limits({ aiConcurrent: 2, aiPerClientHour: 100 }));
    const a = g.tryAi("a");
    const b = g.tryAi("b");
    expect(g.tryAi("c")).toMatchObject({ allowed: false, reason: "NEAR AI is busy" });
    if (a.allowed) { a.release(); a.release(); } // a second release must not free a second slot
    expect(g.tryAi("c").allowed).toBe(true);
    expect(g.tryAi("d").allowed).toBe(false);
    if (b.allowed) b.release();
  });

  it("the kill switch refuses every model call", () => {
    expect(new TerminalGuard(limits({ aiEnabled: false })).tryAi("a")).toMatchObject({ allowed: false, reason: expect.stringContaining("switched off") });
  });

  it("refuses a flood of requests of any kind per minute, per client", () => {
    let now = 1_000;
    const g = new TerminalGuard(limits({ requestsPerClientMinute: 3 }), () => now);
    expect([1, 2, 3, 4].map(() => g.allowRequest("a"))).toEqual([true, true, true, false]);
    expect(g.allowRequest("b")).toBe(true);
    now += 61_000;
    expect(g.allowRequest("a")).toBe(true);
  });

  it("does not remember more clients than it can hold", () => {
    const g = new TerminalGuard(limits({ aiPerClientHour: 1_000_000, aiGlobalHour: 1_000_000, aiGlobalDay: 1_000_000, aiConcurrent: 1_000_000 }));
    for (let i = 0; i < 10_100; i++) { const d = g.tryAi(`client-${i}`); if (d.allowed) d.release(); }
    // Still working, and a long-forgotten client is simply counted afresh.
    expect(g.tryAi("client-0").allowed).toBe(true);
  });
});

describe("the client of a request", () => {
  const h = (m: Record<string, string>) => ({ get: (n: string) => m[n.toLowerCase()] ?? null });
  it("takes the first forwarded hop, then x-real-ip, else one shared bucket", () => {
    expect(clientKeyOf(h({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientKeyOf(h({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientKeyOf(h({}))).toBe("local");
    expect(clientKeyOf(h({ "x-forwarded-for": "x".repeat(200) })).length).toBe(64);
  });
});

/** A fake NEAR AI that counts the calls it receives. */
function countingModel(content: string, status = 200) {
  const calls = { n: 0 };
  const fetchImpl = (async () => {
    calls.n += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const post = (prompt: string) => new Request("http://x/api/terminal/lifecycle", { method: "POST", body: JSON.stringify({ prompt }) });
const DEPOSIT = JSON.stringify({ kind: "deposit", battleId: 7, communityNumber: 2, amountTokens: "5" });
const env = { NEAR_AI_API_KEY: "k" };

describe("the route spends only what the limits allow", () => {
  it("calls the model for the first requests, then the rules answer for free with the reason", async () => {
    const { fetchImpl, calls } = countingModel(DEPOSIT);
    const guard = new TerminalGuard(limits({ aiPerClientHour: 2 }));
    const run = () => handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env, fetchImpl, guard, client: "a" });
    expect((await run()).body).toMatchObject({ ok: true, parser: "near-ai" });
    expect((await run()).body).toMatchObject({ ok: true, parser: "near-ai" });
    const third = await run();
    expect(third.body).toMatchObject({ ok: true, parser: "rules", note: expect.stringContaining("2 NEAR AI requests this hour") });
    expect(calls.n).toBe(2); // the third prompt cost nothing
    // another client is not affected
    expect((await handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env, fetchImpl, guard, client: "b" })).body).toMatchObject({ parser: "near-ai" });
    expect(calls.n).toBe(3);
  });

  it("makes no model call at all when the kill switch is on or the total budget is used up", async () => {
    const { fetchImpl, calls } = countingModel(DEPOSIT);
    const off = await handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env, fetchImpl, guard: new TerminalGuard(limits({ aiEnabled: false })), client: "a" });
    expect(off.body).toMatchObject({ ok: true, parser: "rules", note: expect.stringContaining("switched off") });
    const spent = new TerminalGuard(limits({ aiGlobalDay: 1 }));
    await handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env, fetchImpl, guard: spent, client: "a" });
    const after = await handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env, fetchImpl, guard: spent, client: "z" });
    expect(after.body).toMatchObject({ parser: "rules", note: expect.stringContaining("daily") });
    expect(calls.n).toBe(1);
  });

  it("refuses a flood with 429 before any work", async () => {
    const { fetchImpl, calls } = countingModel(DEPOSIT);
    const guard = new TerminalGuard(limits({ requestsPerClientMinute: 2 }));
    const r = [1, 2, 3].map(() => handleLifecycleParse(post("hi"), { env, fetchImpl, guard, client: "a" }));
    const replies = await Promise.all(r);
    expect(replies.map((x) => x.status)).toEqual([200, 200, 429]);
    expect(calls.n).toBeLessThanOrEqual(2);
  });

  it("frees the concurrency slot even when the model fails", async () => {
    const { fetchImpl } = countingModel("", 503);
    const guard = new TerminalGuard(limits({ aiConcurrent: 1, aiPerClientHour: 100 }));
    const first = await handleLifecycleParse(post("register battle 7 community 2"), { env, fetchImpl, guard, client: "a" });
    expect(first.body).toMatchObject({ ok: true, parser: "rules", note: expect.stringContaining("could not answer") });
    expect(guard.tryAi("b").allowed).toBe(true); // the slot was released
  });

  it("without a key it never calls a model", async () => {
    const { fetchImpl, calls } = countingModel(DEPOSIT);
    const r = await handleLifecycleParse(post("deposit 5 ke battle 7 komunitas 2"), { env: {}, fetchImpl, guard: new TerminalGuard(limits()), client: "a" });
    expect(r.body).toMatchObject({ parser: "rules", note: expect.stringContaining("not configured") });
    expect(calls.n).toBe(0);
  });
});
