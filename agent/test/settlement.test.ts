import { describe, expect, it } from "vitest";
import { type StepExecutor, MockStepExecutor } from "../src/executor.js";
import { FakeArenaClient, makeBattle } from "../src/fake-client.js";
import { driveSettlement, settleEnded } from "../src/settlement.js";
import { type PriceSample, TwapFetcher } from "../src/twap.js";

const E18 = 10n ** 18n;
const MIN = 60_000;
const NOW_MS = 100 * MIN;
const NOW_NS = BigInt(NOW_MS) * 1_000_000n;

const flat = (price: bigint): PriceSample[] =>
  Array.from({ length: 31 }, (_, i) => ({ tsMs: NOW_MS - (30 - i) * MIN, price }));

function fetcher(ok = true): TwapFetcher {
  return new TwapFetcher(
    {
      samples: async (t) => {
        if (!ok) throw new Error("api down");
        return flat(t === "aaa.testnet" ? 2n * E18 : E18);
      },
    },
    { now: () => NOW_MS, backoff: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} } },
  );
}

const live = (over = {}) =>
  makeBattle({ id: 1, status: "Live", end_time_ns: (NOW_NS - 1n).toString(), ...over });

describe("settleEnded", () => {
  it("submits final TWAP prices once end_time has passed", async () => {
    const client = new FakeArenaClient([live()]);
    expect(await settleEnded(client, fetcher(), 1, NOW_NS)).toBe("settled");
    expect(client.calls).toEqual([
      { method: "settle_battle", battleId: 1, priceA: 2n * E18, priceB: E18 },
    ]);
  });

  it("does nothing before end_time", async () => {
    const client = new FakeArenaClient([live({ end_time_ns: (NOW_NS + 1n).toString() })]);
    expect(await settleEnded(client, fetcher(), 1, NOW_NS)).toBe("skipped");
    expect(client.calls).toEqual([]);
  });

  it("a duplicate pass makes no extra calls", async () => {
    const client = new FakeArenaClient([live()]);
    await settleEnded(client, fetcher(), 1, NOW_NS);
    expect(await settleEnded(client, fetcher(), 1, NOW_NS)).toBe("skipped");
    expect(client.calls).toHaveLength(1);
  });

  it("writes no price when the price API fails", async () => {
    const client = new FakeArenaClient([live()]);
    await expect(settleEnded(client, fetcher(false), 1, NOW_NS)).rejects.toThrow();
    expect(client.calls).toEqual([]);
    expect(client.status(1)).toBe("Live");
  });

  it("tolerates a rejection when the battle already moved on", async () => {
    const client = new FakeArenaClient([live()]);
    const racing = Object.create(client) as FakeArenaClient;
    racing.settleBattle = async (id, a, b) => {
      await client.settleBattle(id, a, b);
      throw new Error("wrong status");
    };
    expect(await settleEnded(racing, fetcher(), 1, NOW_NS)).toBe("skipped");
  });
});

describe("driveSettlement", () => {
  async function settling(): Promise<FakeArenaClient> {
    const client = new FakeArenaClient([live()]);
    await settleEnded(client, fetcher(), 1, NOW_NS);
    client.calls.length = 0;
    return client;
  }

  it("reports every step and the battle becomes Settled", async () => {
    const client = await settling();
    const res = await driveSettlement(client, new MockStepExecutor(), 1);
    expect(res.reported).toEqual([0, 1, 2]);
    expect(client.calls.map((c) => c.method === "report_execution" && c.realized)).toEqual([
      100n,
      90n,
      4n,
    ]);
    expect(client.status(1)).toBe("Settled");
  });

  it("drives only the steps that are not done", async () => {
    const client = await settling();
    client.putPlan(1, [
      { index: 0, kind: "Dump", amount: "100", done: true, dispatched: false, realized: "100" },
      { index: 1, kind: "Buy", amount: "90", done: false, dispatched: false, realized: null },
      { index: 2, kind: "Burn", amount: "4", done: false, dispatched: false, realized: null },
    ]);
    const executed: number[] = [];
    const ex: StepExecutor = {
      execute: async (s) => {
        executed.push(s.index);
        return BigInt(s.amount);
      },
    };
    await driveSettlement(client, ex, 1);
    expect(executed).toEqual([1, 2]);
  });

  it("a duplicate pass makes no extra calls", async () => {
    const client = await settling();
    await driveSettlement(client, new MockStepExecutor(), 1);
    const before = client.calls.length;
    const res = await driveSettlement(client, new MockStepExecutor(), 1);
    expect(res.reported).toEqual([]);
    expect(client.calls).toHaveLength(before);
  });

  it("treats an already-done rejection as success", async () => {
    const client = await settling();
    const racing = Object.create(client) as FakeArenaClient;
    let first = true;
    racing.reportExecution = async (id, idx, r) => {
      await client.reportExecution(id, idx, r);
      if (first) {
        first = false;
        throw new Error("already reported");
      }
    };
    const res = await driveSettlement(racing, new MockStepExecutor(), 1);
    expect(res.reported).toEqual([1, 2]);
    expect(res.skipped).toBe(1);
  });

  it("rethrows a rejection that is not an already-done case, and stops", async () => {
    const client = await settling();
    const failing = Object.create(client) as FakeArenaClient;
    failing.reportExecution = async () => {
      throw new Error("rpc down");
    };
    await expect(driveSettlement(failing, new MockStepExecutor(), 1)).rejects.toThrow("rpc down");
  });

  it("an executor failure reports nothing for that step and later steps", async () => {
    const client = await settling();
    const ex: StepExecutor = {
      execute: async (s) => {
        if (s.index === 1) throw new Error("broadcast failed");
        return BigInt(s.amount);
      },
    };
    await expect(driveSettlement(client, ex, 1)).rejects.toThrow("broadcast failed");
    expect(client.calls).toHaveLength(1);
    // restart: only the open steps are driven
    const res = await driveSettlement(client, new MockStepExecutor(), 1);
    expect(res.reported).toEqual([1, 2]);
  });

  it("ignores battles that are not Settling", async () => {
    const client = new FakeArenaClient([live()]);
    const res = await driveSettlement(client, new MockStepExecutor(), 1);
    expect(res.reported).toEqual([]);
  });
});
