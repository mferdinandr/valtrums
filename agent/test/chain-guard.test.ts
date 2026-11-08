import { describe, expect, it } from "vitest";
import { ChainMismatchError, assertRpcChain } from "../src/chain-guard.js";

const serving = (value: unknown) => ({ chainId: async () => value as bigint });

describe("RPC chain guard", () => {
  it("accepts a matching chain id", async () => {
    await expect(assertRpcChain(serving(46630n), 46630n, "test")).resolves.toBeUndefined();
  });

  it("refuses a different chain id with both ids in the message", async () => {
    const err = await assertRpcChain(serving(1n), 46630n, "test").catch((e) => e);
    expect(err).toBeInstanceOf(ChainMismatchError);
    expect(err.message).toContain("serves chain 1, expected 46630");
  });

  it("fails closed on a missing, malformed or unreadable chain id", async () => {
    for (const bad of [undefined, null, "46630", 46630, 0n, -1n]) {
      await expect(assertRpcChain(serving(bad), 46630n, "test")).rejects.toThrow("missing or malformed");
    }
    const failing = { chainId: async () => { throw new Error("https://rpc.example/?key=secret"); } };
    const err = await assertRpcChain(failing, 46630n, "test").catch((e) => e);
    expect(err.message).toContain("could not read the RPC chain id");
    expect(err.message).not.toContain("secret");
  });
});
