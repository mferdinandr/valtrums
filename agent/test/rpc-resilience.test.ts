import { describe, expect, it, vi } from "vitest";
import type { NearTransport } from "../src/near-client.js";
import { isTransientRpcError, withViewRetries } from "../src/rpc-resilience.js";

const noSleep = async () => {};
const fast = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2, sleep: noSleep };

function transport(view: NearTransport["view"], call?: NearTransport["call"]): NearTransport {
  return { view, call: call ?? (async () => undefined) };
}

describe("isTransientRpcError", () => {
  it("recognizes rate limits, gateway errors and network failures", () => {
    for (const message of [
      "HTTP 429: Too Many Requests",
      "Too Many Requests",
      "HTTP 502: Bad Gateway",
      "HTTP 503",
      "HTTP 504 gateway timeout",
      "request failed: ECONNRESET",
      "TypeError: fetch failed",
      "rate limit exceeded",
      "The operation timed out",
    ]) {
      expect(isTransientRpcError(new Error(message)), message).toBe(true);
    }
  });

  it("does not treat contract errors as transient", () => {
    for (const message of [
      "Smart contract panicked: Only a whitelisted agent can call this method",
      "Battle not found",
      "Step already reported",
      "Account valtrum.testnet does not exist",
    ]) {
      expect(isTransientRpcError(new Error(message)), message).toBe(false);
    }
  });

  it("also looks at the cause and at non-error values", () => {
    expect(isTransientRpcError(new Error("request failed", { cause: new Error("HTTP 429") }))).toBe(true);
    expect(isTransientRpcError("HTTP 503 from node")).toBe(true);
    expect(isTransientRpcError(undefined)).toBe(false);
  });
});

describe("withViewRetries", () => {
  it("retries a rate-limited view until it succeeds", async () => {
    const view = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 429: Too Many Requests"))
      .mockRejectedValueOnce(new Error("HTTP 429: Too Many Requests"))
      .mockResolvedValue({ ok: true });
    const wrapped = withViewRetries(transport(view as never), fast);
    await expect(wrapped.view("arena", "get_config", {})).resolves.toEqual({ ok: true });
    expect(view).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const view = vi.fn().mockRejectedValue(new Error("HTTP 429: Too Many Requests"));
    const wrapped = withViewRetries(transport(view as never), fast);
    await expect(wrapped.view("arena", "get_config", {})).rejects.toThrow("429");
    expect(view).toHaveBeenCalledTimes(4);
  });

  it("does not retry a contract error", async () => {
    const view = vi.fn().mockRejectedValue(new Error("Smart contract panicked: Battle not found"));
    const wrapped = withViewRetries(transport(view as never), fast);
    await expect(wrapped.view("arena", "get_battle", {})).rejects.toThrow("Battle not found");
    expect(view).toHaveBeenCalledTimes(1);
  });

  it("never retries a transaction", async () => {
    const call = vi.fn().mockRejectedValue(new Error("HTTP 429: Too Many Requests"));
    const wrapped = withViewRetries(transport(vi.fn() as never, call), fast);
    await expect(wrapped.call("arena", "approve_battle", {}, "30000000000000")).rejects.toThrow("429");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reports each retry", async () => {
    const onRetry = vi.fn();
    const view = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValue(1);
    const wrapped = withViewRetries(transport(view as never), fast, onRetry);
    await wrapped.view("arena", "get_battle_count", {});
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("passes arguments through unchanged", async () => {
    const view = vi.fn().mockResolvedValue("x");
    const wrapped = withViewRetries(transport(view as never), fast);
    await wrapped.view("arena", "get_battle", { battle_id: 7 });
    expect(view).toHaveBeenCalledWith("arena", "get_battle", { battle_id: 7 });
  });
});
