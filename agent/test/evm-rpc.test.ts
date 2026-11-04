import { describe, expect, it } from "vitest";
import {
  SEL_ALLOWANCE,
  SEL_APPROVE,
  SEL_BALANCE_OF,
  SEL_EXACT_INPUT_SINGLE,
  SEL_QUOTE_EXACT_INPUT_SINGLE,
  SEL_TRANSFER,
  TRANSFER_TOPIC,
  decodeUintWord,
  encodeApprove,
  encodeExactInputSingle,
  encodeTransfer,
  normalizeAddress,
} from "../src/evm-abi.js";
import { FakeEvmRpc } from "../src/fake-evm-rpc.js";
import { FetchEvmRpc, type FetchLike } from "../src/evm-rpc.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

describe("evm abi", () => {
  it("matches well-known selectors and the Transfer topic", () => {
    expect(SEL_TRANSFER).toBe("0xa9059cbb");
    expect(SEL_APPROVE).toBe("0x095ea7b3");
    expect(SEL_BALANCE_OF).toBe("0x70a08231");
    expect(SEL_ALLOWANCE).toBe("0xdd62ed3e");
    expect(SEL_EXACT_INPUT_SINGLE).toBe("0x04e45aaf");
    expect(SEL_QUOTE_EXACT_INPUT_SINGLE).toBe("0xc6a5026a");
    expect(TRANSFER_TOPIC).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("encodes calldata as 32-byte words", () => {
    expect(encodeTransfer(A, 1n)).toBe(
      `0xa9059cbb${"0".repeat(24)}${"1".repeat(40)}${"0".repeat(63)}1`,
    );
    expect(encodeApprove(B, 255n)).toBe(
      `0x095ea7b3${"0".repeat(24)}${"2".repeat(40)}${"0".repeat(62)}ff`,
    );
    const swap = encodeExactInputSingle({ tokenIn: A, tokenOut: B, fee: 3000, recipient: A, amountIn: 10n, minOut: 9n });
    expect(swap.length).toBe(2 + 8 + 7 * 64);
    expect(swap.slice(10 + 64 * 2, 10 + 64 * 3)).toBe(`${"0".repeat(61)}bb8`);
  });

  it("rejects bad addresses and decodes words", () => {
    expect(() => normalizeAddress("0x12")).toThrow();
    expect(normalizeAddress(`0X${"AB".repeat(20)}`)).toBe(`0x${"ab".repeat(20)}`);
    expect(decodeUintWord(`0x${"0".repeat(63)}7${"0".repeat(63)}9`, 1)).toBe(9n);
    expect(() => decodeUintWord("0x01")).toThrow();
  });
});

function rpcWith(results: Record<string, unknown>, calls: string[] = []): FetchRpc {
  const fetchFn: FetchLike = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { method: string; id: number };
    calls.push(req.method);
    const r = results[req.method];
    const body =
      r instanceof Error ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: r.message } } : { jsonrpc: "2.0", id: req.id, result: r };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return new FetchEvmRpc("https://rpc.invalid/secret-api-key", { fetch: fetchFn });
}
type FetchRpc = FetchEvmRpc;

describe("FetchEvmRpc", () => {
  it("parses quantities, fees and receipts", async () => {
    const rpc = rpcWith({
      eth_chainId: "0x14a34",
      eth_getTransactionCount: "0x5",
      eth_feeHistory: { baseFeePerGas: ["0x64", "0x3e8"] },
      eth_maxPriorityFeePerGas: "0xa",
      eth_getTransactionReceipt: {
        transactionHash: "0xab",
        status: "0x0",
        blockNumber: "0x10",
        logs: [{ address: A, topics: [TRANSFER_TOPIC], data: "0x" }],
      },
      eth_getTransactionByHash: null,
    });
    expect(await rpc.chainId()).toBe(84532n);
    expect(await rpc.getTransactionCount(A, "pending")).toBe(5n);
    expect(await rpc.getFees()).toEqual({ maxFeePerGas: 2010n, maxPriorityFeePerGas: 10n });
    const receipt = await rpc.getTransactionReceipt("0xab");
    expect(receipt).toMatchObject({ status: false, blockNumber: 16n });
    expect(await rpc.isTransactionKnown("0xab")).toBe(false);
  });

  it("returns null for an unmined transaction and falls back to gas price", async () => {
    const rpc = rpcWith({
      eth_getTransactionReceipt: null,
      eth_feeHistory: { baseFeePerGas: [] },
      eth_gasPrice: "0x64",
      eth_maxPriorityFeePerGas: new Error("method not found"),
    });
    expect(await rpc.getTransactionReceipt("0xab")).toBeNull();
    expect(await rpc.getFees()).toEqual({ maxFeePerGas: 200n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n });
  });

  it("never leaks the URL in errors", async () => {
    const rpc = rpcWith({ eth_chainId: new Error("boom") });
    await expect(rpc.chainId()).rejects.toThrow("eth_chainId error: boom");
    const failing = new FetchEvmRpc("https://rpc.invalid/secret-api-key", {
      fetch: async () => {
        throw new Error("connect https://rpc.invalid/secret-api-key refused");
      },
    });
    const err = await failing.chainId().catch((e: Error) => e);
    expect((err as Error).message).not.toContain("secret-api-key");
  });

  it("rejects malformed quantities", async () => {
    await expect(rpcWith({ eth_blockNumber: "12" }).blockNumber()).rejects.toThrow("bad block number");
  });
});

describe("FakeEvmRpc", () => {
  it("answers balanceOf and allowance", async () => {
    const f = new FakeEvmRpc();
    f.setToken(A, B, 42n);
    const owner = B.slice(2).padStart(64, "0");
    expect(decodeUintWord(await f.call({ to: A, data: `0x70a08231${owner}` }))).toBe(42n);
  });
});
