import { describe, expect, it } from "vitest";
import { createMockArenaApi, MOCK_ACCOUNT } from "./mock";
import { liquidTokenIds, metaFor, readLiquidBalances, withdrawLiquidChecked, WithdrawNotCompletedError } from "./withdraw";
import type { ArenaApi } from "./types";

const T0 = 1_800_000_000_000;
const USDC = "usdc.tkn.testnet";

describe("liquid balances", () => {
  it("lists USDC first, then unique battle coins", () => {
    const ids = liquidTokenIds(USDC, [
      { token_a: "a.tkn", token_b: "b.tkn" },
      { token_a: "b.tkn", token_b: "c.tkn" },
    ]);
    expect(ids).toEqual([USDC, "a.tkn", "b.tkn", "c.tkn"]);
  });

  it("forces USDC metadata and falls back for unknown coins", () => {
    const fallback = (id: string) => ({ id, symbol: "X", decimals: 9 });
    expect(metaFor(USDC, USDC, {}, fallback)).toEqual({ id: USDC, symbol: "USDC", decimals: 6 });
    expect(metaFor("z.tkn", USDC, {}, fallback).decimals).toBe(9);
  });

  it("reads every token balance", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const b = await readLiquidBalances(api, MOCK_ACCOUNT, [USDC, "pepe.tkn.testnet", "mog.tkn.testnet"]);
    expect(b[USDC]).toBe(12_500_000n);
    expect(b["mog.tkn.testnet"]).toBe(0n);
  });
});

describe("withdraw_liquid", () => {
  it("pays a balance out and reports the remainder", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const left = await withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: USDC, amount: 12_500_000n });
    expect(left).toBe(0n);
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, USDC)).toBe("0");
  });

  it("supports partial withdrawals", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    expect(await withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: USDC, amount: 2_500_000n })).toBe(10_000_000n);
  });

  it("rejects more than the balance and zero amounts", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    await expect(api.withdrawLiquid({ signerId: MOCK_ACCOUNT, token: USDC, amount: 99_000_000n })).rejects.toThrow();
    await expect(api.withdrawLiquid({ signerId: MOCK_ACCOUNT, token: USDC, amount: 0n })).rejects.toThrow();
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, USDC)).toBe("12500000");
  });

  it("restores the balance when the transfer fails", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    api.failNextWithdraw("ft_transfer failed");
    await expect(withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: USDC, amount: 12_500_000n })).rejects.toThrow(
      "ft_transfer failed",
    );
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, USDC)).toBe("12500000");
    // The failure is one-shot: a retry succeeds.
    await withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: USDC, amount: 12_500_000n });
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, USDC)).toBe("0");
  });

  it("detects a transaction that succeeded while the contract restored the balance", async () => {
    const base = createMockArenaApi({ now: () => T0 });
    // A successful transaction whose transfer callback restored the balance leaves it unchanged.
    const api: ArenaApi = { ...base, withdrawLiquid: async () => {} };
    await expect(withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: USDC, amount: 1n })).rejects.toBeInstanceOf(
      WithdrawNotCompletedError,
    );
  });

  it("claim then withdraw leaves the coin balance empty", async () => {
    const api = createMockArenaApi({ now: () => T0 });
    const pepe = "pepe.tkn.testnet";
    const seeded = BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, pepe));
    await api.claim({ signerId: MOCK_ACCOUNT, battleId: 5 });
    const afterClaim = BigInt(await api.getLiquidBalance(MOCK_ACCOUNT, pepe));
    expect(afterClaim).toBeGreaterThan(seeded);
    expect((await api.getPosition(5, MOCK_ACCOUNT))?.claimed).toBe(true);
    await withdrawLiquidChecked(api, { signerId: MOCK_ACCOUNT, token: pepe, amount: afterClaim });
    expect(await api.getLiquidBalance(MOCK_ACCOUNT, pepe)).toBe("0");
  });
});
