import { describe, expect, it } from "vitest";
import { describePlan, STEP_LABEL } from "./plan";
import { createMockArenaApi } from "./mock";

const T0 = 1_800_000_000_000;

describe("settlement plan display", () => {
  it("renders the one step plan while the sale is pending", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(4))!;
    const view = describePlan(
      await api.getSettlementPlan(4),
      b,
      await api.getTokenMeta(b.token_a),
      await api.getTokenMeta(b.token_b),
    );
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ number: 1, label: "Sell loser vault", done: false });
    expect(view.awaitingDump).toBe(true);
    expect(view.summary).toMatch(/added once/);
  });

  it("renders the four step plan with labels and realized amounts", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = (await api.getBattle(5))!;
    const view = describePlan(
      await api.getSettlementPlan(5),
      b,
      await api.getTokenMeta(b.token_a),
      await api.getTokenMeta(b.token_b),
    );
    expect(view.rows.map((r) => r.label)).toEqual(["Sell loser vault", "Buy winner coin", "Burn", "Protocol fee"]);
    expect(view.rows.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(view.rows[0]!.amount).toContain("WOJAK");
    expect(view.rows[1]!.realized).toContain("PEPE");
    expect(view.rows[2]!.realized).toContain("burned");
    expect(view.awaitingDump).toBe(false);
    expect(view.summary).toBe("4 of 4 steps done.");
  });

  it("orders steps by index and tolerates a partially done plan", () => {
    const meta = { id: "x", symbol: "X", decimals: 6 };
    const view = describePlan(
      [
        { index: 1, kind: "Buy", amount: "5", done: false, realized: null },
        { index: 0, kind: "Dump", amount: "9", done: true, realized: "10" },
        { index: 2, kind: "Burn", amount: "1", done: false, realized: null },
        { index: 3, kind: "Return", amount: "1", done: false, realized: null },
      ],
      { winner: "A" },
      meta,
      meta,
    );
    expect(view.rows.map((r) => r.kind)).toEqual(["Dump", "Buy", "Burn", "Return"]);
    expect(view.doneCount).toBe(1);
    expect(view.summary).toBe("1 of 4 steps done.");
  });

  it("has a label for every step kind", () => {
    expect(Object.keys(STEP_LABEL).sort()).toEqual(["Burn", "Buy", "Dump", "Return"]);
  });
});
