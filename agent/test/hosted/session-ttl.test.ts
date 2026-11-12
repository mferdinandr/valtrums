import { describe, expect, it } from "vitest";
import { sessionTtlMs } from "../../src/hosted/main.js";

describe("hosted sign-in length", () => {
  it("defaults to 24 hours and reads whole hours from the environment", () => {
    expect(sessionTtlMs({})).toBe(24 * 3_600_000);
    expect(sessionTtlMs({ HOSTED_AGENT_SESSION_HOURS: "6" })).toBe(6 * 3_600_000);
  });
  it("refuses a value that is not 1 to 168 whole hours", () => {
    for (const bad of ["0", "169", "1.5", "abc", "-2"]) expect(() => sessionTtlMs({ HOSTED_AGENT_SESSION_HOURS: bad })).toThrow();
  });
});
