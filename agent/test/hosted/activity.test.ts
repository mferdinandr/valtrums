import { describe, expect, it } from "vitest";
import { ActivityLog } from "../../src/hosted/activity.js";

describe("hosted agent activity log", () => {
  it("keeps shown events newest first and drops unknown fields and events", () => {
    const log = new ActivityLog(() => 1);
    log.note({ event: "played", agent: "a1", battleId: 3, amount: "5", decidedBy: "near-ai", secret: "x" });
    log.note({ event: "dry_run", agent: "a1" });
    log.note({ event: "sent", agent: "a1", step: "deposit", txHash: "h" });
    const out = log.recent("a1");
    expect(out.map((e) => e.event)).toEqual(["sent", "played"]);
    expect(out[1]).not.toHaveProperty("secret");
    expect(log.recent("other")).toEqual([]);
  });
  it("collapses a repeated identical line and caps the length", () => {
    const log = new ActivityLog();
    for (let i = 0; i < 5; i++) log.note({ event: "skipped", agent: "a", reason: "no open battle" });
    expect(log.recent("a")).toHaveLength(1);
    for (let i = 0; i < 80; i++) log.note({ event: "sent", agent: "a", battleId: i });
    expect(log.recent("a")).toHaveLength(50);
  });
});
