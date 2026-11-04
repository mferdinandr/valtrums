import { describe, expect, it } from "vitest";
import { UniswapV3QuoterSource } from "../src/evm-quote.js";
import { FakeEvmRpc } from "../src/fake-evm-rpc.js";

const QUOTER = "0x3333333333333333333333333333333333333333";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function setup() {
  const rpc = new FakeEvmRpc();
  rpc.quoterAddress = QUOTER;
  rpc.setRate(A, B, 2n, 1n);
  return rpc;
}

describe("UniswapV3QuoterSource", () => {
  it("applies the tolerance to the quoted output", async () => {
    const src = new UniswapV3QuoterSource(setup(), QUOTER, 500);
    expect(await src.minOut({ tokenIn: A, tokenOut: B, fee: 3000, amountIn: 1000n })).toBe(1900n);
  });

  it("throws when the quote cannot be read", async () => {
    const rpc = setup();
    rpc.failQuote = true;
    const src = new UniswapV3QuoterSource(rpc, QUOTER, 500);
    await expect(src.minOut({ tokenIn: A, tokenOut: B, fee: 3000, amountIn: 1000n })).rejects.toThrow();
  });

  it("refuses a zero quote and a bad tolerance", async () => {
    const src = new UniswapV3QuoterSource(setup(), QUOTER, 0);
    await expect(src.minOut({ tokenIn: A, tokenOut: B, fee: 3000, amountIn: 0n })).rejects.toThrow("zero");
    expect(() => new UniswapV3QuoterSource(setup(), QUOTER, 10_000)).toThrow();
  });
});
