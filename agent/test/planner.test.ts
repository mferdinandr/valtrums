import { describe, expect, it } from "vitest";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { planFromChain, planWork } from "../src/planner.js";

describe("planWork", () => {
  it("audits Proposed battles regardless of time", () => {
    expect(planWork([makeBattle({ id: 1 })], 0n)).toEqual([{ kind: "audit", battleId: 1 }]);
  });

  it("locks Approved battles only at or after the deposit deadline", () => {
    const b = makeBattle({ id: 2, status: "Approved", deposit_deadline_ns: "1000" });
    expect(planWork([b], 999n)).toEqual([]);
    expect(planWork([b], 1000n)).toEqual([{ kind: "set_initial_prices", battleId: 2 }]);
  });

  it("settles Live battles after end time", () => {
    const b = makeBattle({ id: 3, status: "Live", end_time_ns: "5000" });
    expect(planWork([b], 4999n)).toEqual([]);
    expect(planWork([b], 5000n)).toEqual([{ kind: "settle", battleId: 3 }]);
  });

  it("ignores terminal and in-flight states", () => {
    const statuses = ["Settling", "Settled", "EmergencyHalted", "Voided"] as const;
    const battles = statuses.map((status, i) => makeBattle({ id: i, status }));
    expect(planWork(battles, 10n ** 20n)).toEqual([]);
  });
});

describe("restart safety", () => {
  it("a fresh planner yields the same work, and completed work disappears", async () => {
    const client = new FakeArenaClient([
      makeBattle({ id: 0 }),
      makeBattle({ id: 1, status: "Approved", deposit_deadline_ns: "10" }),
    ]);
    const first = await planFromChain(client, 100n);
    const afterRestart = await planFromChain(client, 100n);
    expect(afterRestart).toEqual(first);
    expect(first).toHaveLength(2);

    await client.approveBattle(0);
    // Battle 0 is now Approved with a later deadline: nothing due for it yet.
    expect(await planFromChain(client, 100n)).toEqual([
      { kind: "set_initial_prices", battleId: 1 },
    ]);
  });
});
