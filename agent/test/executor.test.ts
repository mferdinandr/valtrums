import { describe, expect, it } from "vitest";
import { ForeignChainStepExecutor, MockStepExecutor } from "../src/executor.js";
import { makeBattle } from "../src/fake-client.js";

const step = { index: 1, kind: "Buy" as const, amount: "90", done: false, realized: null };

describe("MockStepExecutor", () => {
  it("realizes the planned amount by default", async () => {
    expect(await new MockStepExecutor().execute(step, makeBattle({ id: 1 }))).toBe(90n);
  });
  it("accepts a custom realization rule", async () => {
    const ex = new MockStepExecutor((s) => (BigInt(s.amount) * 95n) / 100n);
    expect(await ex.execute(step, makeBattle({ id: 1 }))).toBe(85n);
  });
});

describe("ForeignChainStepExecutor", () => {
  it("fails loudly instead of faking execution", async () => {
    await expect(new ForeignChainStepExecutor().execute(step, makeBattle({ id: 7 }))).rejects.toThrow(
      /not available/,
    );
  });
});
